'use strict';
/**
 * plugins/vip/index.js — sea1 会员插件（适配层，继承 BasePlugin）
 *
 * 真实插件契约（已对线上 core/plugin-manager.js + base-plugin.js 侦察确认）：
 *   - module.exports 必须是 class，构造 (name, config)，继承 ../base-plugin
 *   - 生命周期 onEnable(db)；消息接口 onMessage(context) 返回 true 表示拦截
 *   - context: { msg, userId, groupId, userPermission, reply(text), raw }
 *   - 门禁按 plugin.feature||plugin.name 调 global.sea1.license.middleware(feature)
 *     拒绝时调 plugin.onFeatureDenied(context, reason)
 *
 * 本插件只做「收消息 → 调 vip_core → 回消息 / 落盘 license / 即时重载门禁」。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BasePlugin = require('../base-plugin');
const core = require('./vip_core');
// 激活地址解析 + scheme 无关请求（http/https 兼容，换域名不重装）
const { resolveActivationUrl } = require('../../lib/activation-url');
// 自动发码回调端点（localhost-only）：webhook markPaid → bot 自动发 license，无需用户发消息
const botNotifyServer = require('./botNotifyServer');

// ⚠️ 必须与客户端 lib/machineId.js 的 SECRET_SEED 保持一致（商业构建时在混淆阶段保护）
const SECRET_SEED = 'sea1-machine-seed-v1-replace-in-obfuscated-build';

const PLUGIN_NAME = 'vip';
const FEATURE = 'vip';

/** 读取 sea1 配置（本插件位于 plugins/vip/index.js，config.json 在 ../../config.json） */
function loadConfig() {
  const cfgPath = path.join(__dirname, '..', '..', 'config.json');
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).license || {}; }
  catch (e) { return {}; }
}

/** 派生机器码：HMAC(SECRET_SEED, persistentUUID)，与 LicenseGate 完全一致 */
function deriveMachineId(machineIdPath) {
  let persistent = '';
  try { persistent = fs.readFileSync(machineIdPath, 'utf8').trim(); } catch (e) { /* 无文件 */ }
  if (!persistent) {
    // 与 gate 行为一致：无则生成并持久化
    persistent = crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
      fs.writeFileSync(machineIdPath, persistent, { mode: 0o600 });
    } catch (e) { /* ignore */ }
  }
  return crypto.createHmac('sha256', SECRET_SEED).update(persistent, 'utf8').digest('hex');
}

/** 下载图片并返回 base64 编码（用于 NapCat base64:// 图片消息；scheme 无关，http/https 均兼容） */
async function downloadImageBase64(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) { throw new Error('HTTP ' + res.status); }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('base64');
  } finally {
    clearTimeout(t);
  }
}

class VipPlugin extends BasePlugin {
  constructor(name, config) {
    super(name, config);
    this.name = PLUGIN_NAME;
    this.feature = FEATURE;
    this.priority = 90;          // 较低优先级：让 print 等核心插件先处理，vip 仅管自己的指令
    this.permissionLevel = 0;
    this._cfg = loadConfig();
    this._shopCache = null;
    this._shopCacheAt = 0;
    // 首触授予试用：本会话已处理过的 uin 去重集合（避免每消息都打服务端）
    this._grantedUins = new Set();
    // 试用期柔性提醒定时器（onEnable 内挂载）
    this._trialReminderTimer = null;
  }

  async onEnable() {
    console.log(`[VIP] 会员插件加载中... actServer=${this._actServer()}`);
    try {
      const shop = await core.shopInfo(this._actServer());
      if (shop.body && shop.body.ok) {
        this._shopCache = shop.body;
        this._shopCacheAt = Date.now();
        console.log(`[VIP] 商城信息已缓存：${shop.body.plans.length} 个套餐，试用 ${shop.body.trial_days} 天`);
      }
    } catch (e) {
      console.log(`[VIP] 商城信息预取失败（运行时再试）：${e.message}`);
    }

    // 启动 localhost-only 自动发码回调端点（webhook → markPaid → 无需用户发消息自动发 license）
    try {
      const botNotifyToken = process.env.BOT_NOTIFY_TOKEN || (this._cfg && this._cfg.botNotifyToken) || '';
      if (botNotifyToken) {
        const port = process.env.BOT_NOTIFY_PORT ? parseInt(process.env.BOT_NOTIFY_PORT, 10) : undefined;
        const srv = await botNotifyServer.startBotNotifyServer({
          actServer: this._actServer(),
          token: botNotifyToken,
          port,
          // 发码成功 → 落盘 license + 即时重载门禁（与 onMessage 闭环一致）
          onIssue: (lic) => {
            try {
              const applied = this.applyLicense(lic);
              if (applied && applied.error) {
                console.error('[VIP] 自动发码被拒绝落盘：' + applied.error + '（license machine_id 与本机不符，未写盘）。');
              }
            } catch (e) { console.warn('[VIP] 自动发码落盘失败:', e.message); }
          },
        });
        if (srv) this._botNotifyServer = srv;
      }
    } catch (e) {
      console.warn('[VIP] 自动发码端点启动失败（已忽略）:', e.message);
    }

    // 新用户试用期：柔性到期提醒主动私聊（每 5 分钟巡检一轮；发送频率由服务端扫描/去重控制）
    try {
      const trialNotify = require('./trialNotify');
      const tick = () => {
        trialNotify.runReminderTick({
          server: this._actServer(),
          monitorToken: this._monitorToken(),
          sendPrivateMsg: (uin, text) => this.sendPrivateMsg(uin, text),
        }).catch((e) => console.warn('[VIP] 试用提醒巡检异常（已忽略）:', (e && e.message) || e));
      };
      const timer = setInterval(tick, 5 * 60 * 1000);
      if (timer.unref) timer.unref();
      this._trialReminderTimer = timer;
      console.log('[VIP] 试用期柔性提醒定时巡检已挂载（每 5 分钟）。');
    } catch (e) {
      console.warn('[VIP] 试用提醒定时器挂载失败（已忽略）:', e.message);
    }
  }

  _actServer() {
    // 运行时取值优先级：env SEA1_ACTIVATION_URL > config.json.license.activationServer > 兜底
    return resolveActivationUrl(this._cfg);
  }
  _machineIdPath() {
    return (this._cfg && this._cfg.machineIdPath) || '/etc/sea1/machine-id';
  }
  _licensePath() {
    return (this._cfg && this._cfg.licensePath) || '/root/sea1/license.json';
  }
  _publicKeyPath() {
    return (this._cfg && this._cfg.publicKeyPath) || '/root/sea1/licensing/public.key';
  }

  /**
   * 管理员白名单（手动确认闸门权限校验）。
   * 优先级：env VIP_ADMIN_QQ（逗号分隔，可多管理员，兼容期保留）> config.superAdmin/developer（兜底）>
   * 权限库 L1+ 管理员（global.sea1.permission，唯一事实源收敛）。
   * 权限库不可用时不影响原有白名单（防御式降级）。
   * @returns {string[]} 管理员 QQ 列表（字符串、已去重）
   */
  _adminQQs() {
    const list = [];
    const envList = (process.env.VIP_ADMIN_QQ || '')
      .split(',').map((s) => String(s).trim()).filter(Boolean);
    for (const q of envList) list.push(q);
    if (this.config && this.config.superAdmin) list.push(String(this.config.superAdmin));
    if (this.config && this.config.developer) list.push(String(this.config.developer));
    try {
      const perm = global.sea1 && global.sea1.permission;
      if (perm && typeof perm.getAdminQQsSync === 'function') {
        list.push(...perm.getAdminQQsSync(1)); // 新：权限库 L1+ 管理员
      }
    } catch (e) {
      // 权限库不可用不影响原有白名单
    }
    return Array.from(new Set(list.map(String)));
  }

  /**
   * 监控 token（与激活服务端 MONITOR_TOKEN 一致；env 优先，其次 config.license.monitorToken）。
   * 调 /api/admin/order/confirm 必须带此 token，否则服务端 401。
   * @returns {string}
   */
  _monitorToken() {
    return process.env.MONITOR_TOKEN || (this._cfg && this._cfg.monitorToken) || '';
  }

  /** 管理 token（与激活服务端 ADMIN_TOKEN 一致；env 优先，其次 config.license.adminToken）。 */
  _adminToken() {
    return process.env.ADMIN_TOKEN || (this._cfg && this._cfg.adminToken) || '';
  }

  /**
   * 主动私聊发送（走 QQ 适配器 send(uin, text)；不带 groupId 即私聊）。
   * @param {string} uin
   * @param {string} text
   * @returns {Promise<boolean>} 是否发送成功
   */
  sendPrivateMsg(uin, text) {
    const adapter = global.sea1 && global.sea1.adapter;
    if (!adapter || typeof adapter.send !== 'function') {
      console.warn('[VIP] 主动私聊失败：QQ 适配器未就绪（global.sea1.adapter 不存在）');
      return Promise.resolve(false);
    }
    return adapter.send(String(uin), text)
      .then(() => true)
      .catch((e) => {
        console.warn('[VIP] 主动私聊发送失败 uin=' + uin + '（已忽略）:', (e && e.message) || e);
        return false;
      });
  }

  /**
   * 首触自动授予新用户试用期（后台尽力执行，绝不阻塞消息处理、不拦截非指令消息）。
   * 逻辑：uin 未在本会话去重集合 且 服务端无试用/激活记录 → 调 grantTrial。
   * @param {string} userId
   */
  async _maybeGrantTrial(userId) {
    try {
      if (!userId || userId === '0') return;
      if (this._grantedUins.has(userId)) return; // 本会话已处理过，跳过
      // 先查服务端是否已有记录（已授予或已激活），避免重复授予
      const st = await core.trialStatusByUin(this._actServer(), userId);
      if (st && st.body && st.body.ok && st.body.exists) {
        this._grantedUins.add(userId); // 已有记录，无需再授予
        return;
      }
      // 取当前默认试用期（全局配置，管理员可改），首触授予
      let months = 3;
      try {
        const cfg = await core.getTrialConfig(this._actServer());
        if (cfg && cfg.body && cfg.body.ok && cfg.body.months) months = cfg.body.months;
      } catch (_) { /* 用默认 3 个月 */ }
      const r = await core.grantTrial(this._actServer(), { uin: userId, months }, this._monitorToken());
      this._grantedUins.add(userId); // 无论成功/已存在都去重，避免重复调用
      if (r && r.body && r.body.ok) {
        console.log(`[VIP] 已为新用户 ${userId} 授予 ${months} 个月试用期`);
      }
    } catch (e) {
      this._grantedUins.add(userId); // 失败也标记，避免每消息重试刷服务端
      console.warn('[VIP] 首触授予试用失败（已忽略）:', (e && e.message) || e);
    }
  }

  /**
   * 本机 license 落盘 + 更新 config + 即时重载在线门禁。
   * 写盘前强制校验机器码：若 license.machine_id 存在且与本机 deriveMachineId() 不一致，
   * 拒绝落盘（返回 { error: 'machine_mismatch', path: null }），绝不污染本机 license 文件，
   * 否则 LicenseGate.init() 会进入 MACHINE_MISMATCH 降级（全功能被拒 + 双回复）。
   * 无 machine_id 字段（历史 license）保持兼容，走原逻辑。
   * @param {object} licenseObj 服务端下发的 license 对象
   * @returns {string} 正常路径返回 license 文件路径；机器码不匹配时返回 { error, path: null }
   */
  applyLicense(licenseObj) {
    // 写盘前机器码校验（脏 license 拦截点，见真机取证：e2e-machine-002 污染 /root/sea1/license.json）
    if (licenseObj && licenseObj.machine_id != null) {
      const local = deriveMachineId(this._machineIdPath());
      if (licenseObj.machine_id !== local) {
        console.error('[VIP] 拒绝写盘 license：机器码不匹配（license=' + licenseObj.machine_id + ' vs 本机=' + local + '）');
        return { error: 'machine_mismatch', path: null };
      }
    }
    const licPath = this._licensePath();
    fs.mkdirSync(path.dirname(licPath), { recursive: true });
    fs.writeFileSync(licPath, JSON.stringify(licenseObj, null, 2), { mode: 0o600 });

    // 把完整 license 配置写回 config.json（enabled=true + 路径 + 公钥 + 激活服务器）
    const cfgPath = path.join(__dirname, '..', '..', 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
    let publicKey = '';
    try { publicKey = fs.readFileSync(this._publicKeyPath(), 'utf8').trim(); } catch (e) {}
    cfg.license = Object.assign({}, cfg.license, {
      enabled: true,
      licensePath: licPath,
      machineIdPath: this._machineIdPath(),
      publicKeyPath: this._publicKeyPath(),
      publicKey: publicKey || (cfg.license && cfg.license.publicKey) || '',
      activationServer: this._actServer(),
      trialDays: (cfg.license && cfg.license.trialDays) || 14,
    });
    try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch (e) {}

    // 即时重载在线门禁（无需重启即可生效）
    try {
      const { LicenseGate } = require('../../licensing');
      const gate = new LicenseGate(cfg.license);
      global.sea1.license = gate.init();
      console.log(`[VIP] 在线门禁已即时重载：${global.sea1.license.status}`);
    } catch (e) {
      console.log(`[VIP] 门禁即时重载失败（重启后生效）：${e.message}`);
    }
    return licPath;
  }

  async onMessage(context) {
    try {
      const text = (context.msg || '').toString().trim();
      if (!text) return false;
      const userId = String(context.userId || '0');
      const machineId = deriveMachineId(this._machineIdPath());

      // 新用户首触：后台尽力授予试用期（不打断消息处理；已有记录则跳过）
      this._maybeGrantTrial(userId);

      // 注入管理员白名单、监控 token、管理 token（手动确认闸门 + 试用管理所需）；非管理员命令会被 vip_core 拒绝。
      const res = await core.handleCommand(this._actServer(), machineId, userId, text, {
        adminQQs: this._adminQQs(),
        monitorToken: this._monitorToken(),
        adminToken: this._adminToken(),
        // 注入本机正式授权状态（来自 LicenseGate），供 cmdStatus 优先展示实际会员。
        // 注意：适配层 onMessage 未剥离命令前的 '#'，正则已自行去掉。
        localLicense: (global.sea1 && global.sea1.license) ? global.sea1.license.getStatus() : null,
      });
      if (!res.handled) return false;

      if (res.license) {
        let applied = null;
        try { applied = this.applyLicense(res.license); } catch (e) { console.log('[VIP] 落盘失败:' + e.message); }
        // 机器码不匹配：不落盘、不提示激活成功，明确告知用户（避免"假成功"）
        if (applied && applied.error) {
          console.error('[VIP] 许可证被拒绝落盘：' + applied.error + '，不提示激活成功。');
          await context.reply('⚠️ 激活失败：该许可证与本机不匹配（机器码不符），未写入激活。请联系客服重新发放本机专用许可证。');
          return true;
        }
      }
      if (res.lines && res.lines.length) {
        await context.reply(res.lines.join('\n'));
      }
      // 如果有收款码图片，下载后以图片消息发送（避免外网无法访问 IP 链接）
      if (res.qr_image_url) {
        try {
          const imgBase64 = await downloadImageBase64(res.qr_image_url);
          await context.reply(imgBase64, { type: 'image' });
          console.log('[VIP] 收款码图片已发送');
        } catch (e) {
          console.log('[VIP] 收款码图片发送失败: ' + e.message);
          await context.reply('⚠️ 收款码图片发送失败，请联系客服获取收款码。');
        }
      }
      return true; // 已消费本指令
    } catch (e) {
      console.warn('[VIP] onMessage 异常:', e.message);
      return false;
    }
  }

  /** 门禁拒绝 vip 功能时（理论上 vip 已加入只读白名单，此路径主要兜底） */
  async onFeatureDenied(context, reason) {
    try {
      await context.reply(core.reminderText().join('\n'));
    } catch (e) {}
  }
}

module.exports = VipPlugin;
