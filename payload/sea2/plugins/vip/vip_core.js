'use strict';
/**
 * vip_core.js — 会员/付费/激活 纯逻辑层（与 sea1 插件契约无关）
 *
 * 职责：与激活服务器通信（商城/建单/确认/发码/订单状态/试用状态）+ 生成文案。
 * 不负责收/发消息、不负责落盘 license —— 这些由 plugins/vip/index.js 适配层完成。
 *
 * 商业闭环：
 *   用户发「开通会员」→ 建单(返回订单号+收款码+金额) → 扫码付款
 *   → 发「已支付 <订单号>」→ 确认 → 发码(license 绑定本机机器码) → 返回 license 对象
 *   → 适配层写盘 + 即时重载门禁 → 全功能解锁。
 */
// 激活请求统一走 lib/activation-url（全局 fetch，http/https 兼容，换域名不重装）
const { requestActivation } = require('../../lib/activation-url');

// =====================================================================
// P1 等级化改造雏形（P0 保持契约不变，仅作说明与常量预留）
// ---------------------------------------------------------------------
// 现状（P0）：vip_core 通过 opts.adminQQs.includes(qq) 判定管理员；该白名单由
// plugins/vip/index.js 注入，已含「权限库 L1+ 管理员（global.sea1.permission）
// + config.superAdmin/developer 兜底 + env VIP_ADMIN_QQ 兼容期」。
// 也就是说：权限库新增的 L1+ 管理员无需改 vip_core 即可管理 vip 指令。
//
// P1 建议（本次不启用）：将 adminQQs.includes(qq) 收敛为等级校验
//   const perm = global.sea1 && global.sea1.permission;
//   const isAdmin = perm ? perm.hasLevelSync(qq, VIP_ADMIN_MIN_LEVEL) : adminQQs.includes(String(qq));
// 并逐步弃用 env VIP_ADMIN_QQ（进 config / 权限库）。
// =====================================================================
/** P1：vip 管理指令最低等级（本次仅声明，不改变运行时逻辑） */
const VIP_ADMIN_MIN_LEVEL = 1;

function req(server, method, p, body, headers = {}) {
  const fullUrl = new URL(p, server).href;
  return requestActivation(method, fullUrl, body, { headers });
}

function shopInfo(server) { return req(server, 'GET', '/api/shop/info'); }
function trialStatus(server, machineId) { return req(server, 'POST', '/api/trial/status', { machine_id: machineId }); }
function createOrder(server, { qq, machineId, plan, channel }) {
  return req(server, 'POST', '/api/order/create', { qq, machine_id: machineId, plan, channel });
}
function confirmOrder(server, { orderId, qq }) {
  return req(server, 'POST', '/api/order/confirm', { order_id: orderId, qq });
}
function issueOrder(server, orderId) {
  return req(server, 'POST', '/api/order/issue', { order_id: orderId });
}
function orderStatus(server, orderId) {
  return req(server, 'GET', `/api/order/status?order_id=${encodeURIComponent(orderId)}`);
}

// ---- 新用户试用期（按 uin / QQ）：授予 / 配置 / 待发提醒 / 状态 ----
function grantTrial(server, { uin, months }, monitorToken) {
  return req(server, 'POST', '/api/trial/grant', { uin, months }, { 'x-monitor-token': monitorToken || '' });
}
function getTrialConfig(server) {
  return req(server, 'GET', '/api/trial/config');
}
function pullPendingReminders(server, monitorToken) {
  return req(server, 'GET', '/api/trial/pending-reminders', null, { 'x-monitor-token': monitorToken || '' });
}
function markReminded(server, { uin, type }, monitorToken) {
  return req(server, 'POST', '/api/trial/mark-reminded', { uin, type }, { 'x-monitor-token': monitorToken || '' });
}
function trialStatusByUin(server, uin) {
  return req(server, 'GET', `/api/trial/user/status?uin=${encodeURIComponent(uin)}`);
}

// ---- 开通会员菜单状态机（激活流程简化）----
// 会话存于进程内 Map（key = qq），短生命周期（≤5 分钟超时自动复位），重启即清空，
// 用户重发「开通会员」即可重选，无数据丢失风险。详见 system_design_activation_simplify.md §1.2/§3.2。
const menuSessions = new Map();
const MENU_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟超时
const DEFAULT_CHANNEL = 'wechat'; // 菜单仅默认微信收款；支付宝走旧手动路径

// 菜单数字选项 → 套餐 id（与 /api/shop/info 套餐 id 对齐）
const MENU_PLAN_MAP = { '1': 'month', '2': 'quarter', '3': 'year', '4': 'lifetime' };
const MENU_PLAN_LABEL = { month: '月卡', quarter: '季卡', year: '年卡', lifetime: '永久会员' };

/**
 * 解析 试用 系列管理员指令，不匹配返回 null。
 *   试用 3            → {action:'set_months', months:3}
 *   试用 永久         → {action:'set_disabled', disabled:true}
 *   试用状态          → {action:'status', targetUin:null}（查自己）
 *   试用状态 @12345   → {action:'status', targetUin:'12345'}（管理员查他人）
 * @param {string} text
 * @returns {null|{action:string, months?:number, disabled?:boolean, targetUin?:string|null}}
 */
function parseTrialAdminCommand(text) {
  const t = (text || '').trim();
  const m = t.match(/^试用\s*([\s\S]*)$/);
  if (!m) return null;
  const arg = m[1].trim();
  if (!arg) return { action: 'unknown' };
  if (/^(永久|终身|lifetime|关闭|停用)$/i.test(arg)) {
    return { action: 'set_disabled', disabled: true };
  }
  const mm = arg.match(/^(\d+)\s*(?:个\s*月|个月|月)?$/);
  if (mm) return { action: 'set_months', months: parseInt(mm[1], 10) };
  if (/^状态$/i.test(arg)) return { action: 'status', targetUin: null };
  const su = arg.match(/^状态\s+@?(\d+)$/i);
  if (su) return { action: 'status', targetUin: su[1] };
  return { action: 'unknown' };
}

/**
 * 处理 试用 系列指令，返回 { lines, handled }（与 handleCommand 同契约）。
 * @param {string} server
 * @param {{qq:string, text:string}} ctx
 * @param {{adminQQs?:string[], monitorToken?:string, adminToken?:string}} [opts]
 */
async function handleTrialAdminCommand(server, ctx, opts = {}) {
  const parsed = parseTrialAdminCommand(ctx.text);
  if (!parsed) return { lines: [], handled: false };
  const adminQQs = (opts.adminQQs || []).map(String);
  const monitorToken = opts.monitorToken || '';

  // 状态查询：私聊查自己（targetUin=null）；@他人 需管理员权限
  if (parsed.action === 'status') {
    const targetUin = parsed.targetUin != null ? parsed.targetUin : String(ctx.qq);
    if (parsed.targetUin != null && !adminQQs.includes(String(ctx.qq))) {
      return { lines: ['⛔ 无权限：仅管理员可查询他人试用状态。'], handled: true };
    }
    let r = null;
    try {
      r = await trialStatusByUin(server, targetUin);
    } catch (e) {
      return { lines: ['⚠️ 查询失败：网络错误，请稍后重试。'], handled: true };
    }
    if (!r || !r.body || !r.body.ok) {
      return { lines: ['⚠️ 查询失败：' + ((r && r.body && r.body.error) || '未知错误')], handled: true };
    }
    const b = r.body;
    if (!b.exists) return { lines: [`用户 ${targetUin} 暂无试用记录。`], handled: true };
    const days = Math.ceil((b.remaining_ms || 0) / 86400000);
    const statusText = b.status === 'active' ? '试用中'
      : b.status === 'expired' ? '已到期'
      : b.status === 'converted' ? '已激活'
      : String(b.status || '未知');
    return {
      lines: [
        `👤 用户 ${targetUin} 试用状态：${statusText}`,
        `到期时间：${new Date(b.trialExpiresAt).toLocaleString()}`,
        `剩余：${days} 天`,
        `已提醒次数：${b.remindCount || 0}`,
      ],
      handled: true,
    };
  }

  // 以下操作（设置月数 / 关闭试用）需管理员权限
  if (!adminQQs.includes(String(ctx.qq))) {
    return { lines: ['⛔ 无权限：仅管理员可设置试用期。'], handled: true };
  }

  if (parsed.action === 'set_months') {
    let r = null;
    try {
      r = await req(server, 'POST', '/api/admin/trial/config', { months: parsed.months }, { 'x-admin-token': opts.adminToken || '' });
    } catch (e) {
      return { lines: ['⚠️ 设置失败：网络错误，请稍后重试。'], handled: true };
    }
    if (!r || !r.body || !r.body.ok) {
      return { lines: ['⚠️ 设置失败：' + ((r && r.body && r.body.error) || '未知错误')], handled: true };
    }
    return { lines: [`已设置新用户试用期为 ${parsed.months} 个月`], handled: true };
  }

  if (parsed.action === 'set_disabled') {
    let r = null;
    try {
      r = await req(server, 'POST', '/api/admin/trial/config', { disabled: true }, { 'x-admin-token': opts.adminToken || '' });
    } catch (e) {
      return { lines: ['⚠️ 设置失败：网络错误，请稍后重试。'], handled: true };
    }
    if (!r || !r.body || !r.body.ok) {
      return { lines: ['⚠️ 设置失败：' + ((r && r.body && r.body.error) || '未知错误')], handled: true };
    }
    return { lines: ['已关闭新用户试用期'], handled: true };
  }

  return { lines: ['⚠️ 未知的 试用 指令，可用：试用 3 / 试用 永久 / 试用状态 / 试用状态 @uin'], handled: true };
}

/**
 * 解析 付款记录 / 收款记录 指令，不匹配返回 null。
 * 可选跟一个数字指定条数（默认 10，上限 50）。
 *   付款记录        → { limit: 10 }
 *   收款记录        → { limit: 10 }
 *   付款记录 3      → { limit: 3 }
 *
 * @param {string} text
 * @returns {null|{limit:number}}
 */
function parsePaymentRecordsCommand(text) {
  const t = (text || '').trim();
  const m = t.match(/^(付款记录|收款记录)\s*(\d{1,2})?$/);
  if (!m) return null;
  const limit = m[2] ? Math.min(parseInt(m[2], 10), 50) : 10;
  return { limit };
}

/**
 * 解析 推送查询 指令，不匹配返回 null。
 * 可选跟一个数字指定条数（默认 5，上限 50）。
 *   推送查询        → { limit: 5 }
 *   推送查询 5      → { limit: 5 }
 *   推送查询 20     → { limit: 20 }
 *
 * @param {string} text
 * @returns {null|{limit:number}}
 */
function parsePushLogCommand(text) {
  const t = (text || '').trim();
  const m = t.match(/^推送查询\s*(\d{1,2})?$/);
  if (!m) return null;
  const limit = m[1] ? Math.min(parseInt(m[1], 10), 50) : 5;
  return { limit };
}

/**
 * 处理 推送查询 指令，返回 { lines, handled }（与 handleCommand 同契约）。
 * 仅管理员白名单内的 QQ 可调用；通过 GET /api/admin/webhook-logs（带 x-admin-token）
 * 拉取服务端收件日志（含未匹配推送），展示「流程通到哪了」。
 *
 * @param {string} server       激活服务器地址
 * @param {{qq:string, text:string, limit:number}} ctx  limit 由解析结果注入
 * @param {{adminQQs?:string[], adminToken?:string}} [opts]
 */
async function handlePushLogCommand(server, ctx, opts = {}) {
  const adminQQs = (opts.adminQQs || []).map(String);
  if (!adminQQs.includes(String(ctx.qq))) {
    return { lines: ['⛔ 无权限：仅管理员可查看推送记录。'], handled: true };
  }
  const limit = ctx.limit || 5;
  let r = null;
  try {
    r = await req(server, 'GET', '/api/admin/webhook-logs?limit=' + limit, null, { 'x-admin-token': opts.adminToken || '' });
  } catch (e) {
    return { lines: ['⚠️ 查询推送记录失败：' + ((e && e.message) ? e.message : '网络错误') + '。'], handled: true };
  }
  if (!r || !r.body || !r.body.ok) {
    return { lines: ['⚠️ 查询推送记录失败：' + ((r && r.body && r.body.error) || '未授权或接口异常') + '。'], handled: true };
  }
  const logs = Array.isArray(r.body.logs) ? r.body.logs : [];
  if (logs.length === 0) {
    return { lines: ['📭 暂无任何收到的推送通知（接口可能未通，或尚未有收款推送）。'], handled: true };
  }
  const total = logs.length;
  const lines = [];
  lines.push(`📨 最近 ${limit} 条收到的推送通知（共 ${total} 条）`);
  logs.forEach((e) => {
    const time = (e.ts ? new Date(e.ts).toLocaleString('zh-CN') : '-');
    const mark = e.matched ? '✅' : '❌';
    const reason = e.reason || (e.matched ? 'matched' : 'unknown');
    let text = e.content;
    if (!text || !String(text).trim()) {
      // content 为空 → 退化显示 raw 的 JSON 摘要（截断到 200 字）
      try { text = JSON.stringify(e.raw).slice(0, 200); } catch (_) { text = '(无原文)'; }
    }
    lines.push(`[${time}] 匹配:${mark}(${reason}) 原文: ${text}`);
  });
  return { lines, handled: true };
}

/**
 * 处理 付款记录 / 收款记录 指令，返回 { lines, handled }（与 handleCommand 同契约）。
 * 仅管理员白名单内的 QQ 可调用；通过 GET /api/admin/orders（带 x-admin-token）
 * 拉取订单，过滤出已支付(paid)/已发码(issued) 的订单作为「收款记录」展示。
 *
 * @param {string} server
 * @param {{qq:string, text:string, limit:number}} ctx  limit 由解析结果注入
 * @param {{adminQQs?:string[], adminToken?:string}} [opts]
 */
async function handlePaymentRecordsCommand(server, ctx, opts = {}) {
  const adminQQs = (opts.adminQQs || []).map(String);
  if (!adminQQs.includes(String(ctx.qq))) {
    return { lines: ['⛔ 无权限：仅管理员可查看收款记录。'], handled: true };
  }
  let r = null;
  try {
    r = await req(server, 'GET', '/api/admin/orders', null, { 'x-admin-token': opts.adminToken || '' });
  } catch (e) {
    return { lines: ['⚠️ 查询失败：网络错误，请稍后重试。'], handled: true };
  }
  if (!r || !r.body || !r.body.ok) {
    return { lines: ['⚠️ 查询失败：' + ((r && r.body && r.body.error) || '未授权或接口异常')], handled: true };
  }
  const orders = (r.body.orders || []).filter((o) => o.status === 'paid' || o.status === 'issued');
  if (orders.length === 0) {
    return { lines: ['📭 暂无可显示的收款记录（无已支付/已发码订单）。'], handled: true };
  }
  const picked = orders.slice(0, ctx.limit);
  const chLabel = (o) => {
    const c = o.paid_channel || o.channel || '';
    if (/smsforwarder_wechat|wechat/i.test(c)) return '微信(推送)';
    if (/alipay/i.test(c)) return '支付宝';
    return c || '未知';
  };
  const stLabel = (s) => (s === 'issued' ? '已发码' : '已支付待发码');
  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-');
  const lines = [];
  lines.push(`📊 最近 ${picked.length} 条收款记录（仅已支付/已发码，共 ${orders.length} 条）`);
  picked.forEach((o, i) => {
    lines.push(
      `${i + 1}. ${o.order_id} | ¥${o.amount} | ${chLabel(o)} | QQ:${o.qq} | ${stLabel(o)} | ${fmtTime(o.paid_at)}`
    );
  });
  lines.push('（微信推送=由 SmsForwarder 自动识别到账；支付宝=手动确认）');
  return { lines, handled: true };
}

/**
 * 调用商户/监控器核验接口（手动确认闸门）：把 await_verify 订单推进到 paid。
 * 必须带专用 x-monitor-token 头（与激活服务端 MONITOR_TOKEN 一致）；
 * 复用现有 req 客户端（与 confirmOrder/issueOrder 一致），不引入新依赖。
 *
 * @param {string} server       激活服务器地址
 * @param {string} orderId      订单号
 * @param {string} monitorToken 专用监控 token（x-monitor-token 头）
 * @returns {Promise<{status:number, body:any}>}
 */
function confirmOrderByMonitor(server, orderId, monitorToken) {
  return req(server, 'POST', '/api/admin/order/confirm', { order_id: orderId }, {
    'x-monitor-token': monitorToken || '',
  });
}

/**
 * 解析管理员确认订单命令，提取订单号；不匹配返回 null。
 * 命令形态：①「确认订单 SEA1-xxxxxxxx-XXXXXX」②「confirm SEA1-xxxxxxxx-XXXXXX」
 *         ③「确认订单 seaYYYYMMDDhhmmss」④「confirm seaYYYYMMDDhhmmss」
 * 订单号正则与监控器/服务端一致：兼顾旧 SEA1- 系列与新 sea+14 位秒级时间戳系列。
 *
 * @param {string} text 原始用户输入
 * @returns {string|null} 归一化订单号（SEA1-→全大写；sea…→全小写）或 null
 */
function parseAdminConfirm(text) {
  const t = (text || '').trim();
  const m = t.match(/(确认订单|confirm)\s+(SEA1-[A-Za-z0-9-]+|sea\d{14}(?:-\d{1,2})?)/i);
  if (!m) return null;
  const raw = m[2];
  if (/^sea\d{14}/i.test(raw)) return raw.toLowerCase();
  return raw.toUpperCase();
}

/**
 * 订单号归一化：新单号 `sea` + 14 位秒级时间戳（全小写），旧单号 `SEA1-` 系列（全大写）。
 * 手动「已支付 <单号>」路径会把用户输入原样传入，需按格式归一，避免大小写错位导致查单失败。
 *
 * @param {string} id 原始订单号
 * @returns {string} 归一化后的订单号（sea…→小写；SEA1-…→大写；其余原样返回）
 */
function normalizeOrderId(id) {
  if (!id) return id;
  if (/^sea\d{14}/i.test(id)) return id.toLowerCase();
  if (/^SEA1-/i.test(id)) return id.toUpperCase();
  return id;
}

/**
 * 管理员手动确认订单（手动确认闸门入口）。
 * 仅管理员白名单内的 QQ 可调用；校验通过后调 /api/admin/order/confirm（带 x-monitor-token）
 * 把 await_verify 推进 paid。订单 paid 后由 cmdPaid 的 pollUntilPaid 自动检测并签发 license，
 * 本函数【不】重复实现发码逻辑（闭环已在 cmdPaid 侧成立）。
 *
 * @param {string} server       激活服务器地址
 * @param {string} qq           发令者 QQ（用于权限校验）
 * @param {string} orderId      订单号
 * @param {{adminQQs?:string[], monitorToken?:string}} [opts] 管理员白名单与监控 token（由适配层注入）
 * @returns {Promise<{lines:string[], handled:boolean}>}
 */
async function cmdAdminConfirmOrder(server, qq, orderId, opts = {}) {
  const adminQQs = (opts.adminQQs || []).map(String);
  if (!adminQQs.includes(String(qq))) {
    // 非管理员：明确拒绝，绝不静默放行
    return { lines: ['⛔ 无权限：仅管理员可执行确认收款操作。'], handled: true };
  }
  if (!orderId) {
    return { lines: ['⚠️ 未识别到订单号，格式应为：确认订单 SEA1-xxxxxxxx-XXXXXX'], handled: true };
  }
  const monitorToken = opts.monitorToken || '';
  let r = null;
  try {
    r = await confirmOrderByMonitor(server, orderId, monitorToken);
  } catch (e) {
    return { lines: ['⚠️ 确认请求失败：' + (e && e.message ? e.message : '网络错误') + '，请稍后重试。'], handled: true };
  }
  if (!r || typeof r.status !== 'number') {
    return { lines: ['⚠️ 确认请求无响应，请稍后重试。'], handled: true };
  }
  if (r.status === 200 && r.body && r.body.ok) {
    return { lines: [`✅ 订单 ${orderId} 已确认收款，系统将自动发码。`], handled: true };
  }
  if (r.status === 404) {
    return { lines: [`⚠️ 订单不存在：${orderId}，请核对订单号。`], handled: true };
  }
  if (r.status === 401) {
    return { lines: ['⛔ 无权限：监控 token 校验失败（服务端未配置或 token 不匹配）。'], handled: true };
  }
  const errMsg = (r.body && r.body.error) ? r.body.error : ('HTTP ' + r.status);
  return { lines: ['⚠️ 确认失败：' + errMsg + '。'], handled: true };
}

/**
 * 指令主分发。返回 { lines: string[], license?: object, handled: boolean }
 * 新增：管理员「确认订单」命令（手动确认闸门）优先于用户指令分发。
 *
 * @param {string} server     激活服务器地址
 * @param {string} machineId  本机机器码
 * @param {string} qq         发令者 QQ
 * @param {string} text       原始输入
 * @param {{adminQQs?:string[], monitorToken?:string}} [opts] 管理员白名单与监控 token（适配层注入，缺省为空=无管理员）
 */
async function handleCommand(server, machineId, qq, text, opts = {}) {
  const t = (text || '').trim();
  if (!t) return { lines: [], handled: false };

  // 新用户试用期管理指令（试用 3 / 试用 永久 / 试用状态）：独立于付费指令链
  const trialCmd = parseTrialAdminCommand(t);
  if (trialCmd) {
    return await handleTrialAdminCommand(server, { qq, text: t }, opts);
  }

  // 收款记录查询（管理员专属）：付款记录 / 收款记录（默认 10 条，上限 50）
  const payRecCmd = parsePaymentRecordsCommand(t);
  if (payRecCmd) {
    return await handlePaymentRecordsCommand(server, { qq, text: t, limit: payRecCmd.limit }, opts);
  }

  // 推送记录查询（管理员专属）：推送查询（默认 5 条，上限 50）
  // 展示服务端收到的【全部】微信收款推送（含未匹配），便于排查 webhook 是否打通 / 匹配对没对上。
  const pushCmd = parsePushLogCommand(t);
  if (pushCmd) {
    return await handlePushLogCommand(server, { qq, text: t, limit: pushCmd.limit }, opts);
  }

  // 管理员手动确认订单（手动确认闸门）：确认订单 SEA1-xxx / confirm SEA1-xxx
  // 置于用户指令之前，避免被「已支付/开通」规则误吞；非管理员由 cmdAdminConfirmOrder 拒绝。
  const adminOrderId = parseAdminConfirm(t);
  if (adminOrderId) {
    return await cmdAdminConfirmOrder(server, qq, adminOrderId, opts);
  }

  // 菜单进行中：若本 QQ 存在未超时会话，优先交给 cmdMenuSelect 处理选时长/取消/其他
  if (menuSessions.has(qq)) {
    const sess = menuSessions.get(qq);
    if (Date.now() - sess.createdAt > MENU_TIMEOUT_MS) {
      // 超时复位：用户仍在发菜单相关输入则提示重新进入；否则 fallthrough 到常规分发
      menuSessions.delete(qq);
      if (/^(\d{1,2}|取消|退出|quit|cancel)$/i.test(t)) {
        return { lines: ['⏱ 开通菜单已超时，请重新发送「开通会员」选择会员时长。'], handled: true };
      }
    } else {
      return await cmdMenuSelect(server, qq, t, machineId, opts);
    }
  }

  // 已支付 <订单号>（手动兜底路径，保留）
  const m = t.match(/(已支付|已付款|付款了|paid|到账)\s*([A-Za-z0-9\-]+)/i);
  if (m) {
    return await cmdPaid(server, qq, normalizeOrderId(m[2]));
  }

  // 我的会员 / 状态
  if (/(我的会员|会员状态|我的vip|会员信息|status)/i.test(t) && !/(开通|购买|激活)/i.test(t)) {
    return await cmdStatus(server, machineId, qq, opts.localLicense);
  }

  // 开通会员菜单触发（排除付款类词，避免「付款了」等误触发菜单）
  if (/(开通|会员|购买|激活|vip|buy|pay|付费|充值|续费)/i.test(t) && !/(已支付|已付款|付款了|到账|已付)/i.test(t)) {
    return await cmdOpenMenu(server, qq, machineId, opts);
  }

  return { lines: [], handled: false };
}

/**
 * 开通会员菜单：展示时长选项（含价格），并建立本 QQ 的选时长会话。
 * 文案严格采用产品定稿（system_design_activation_simplify.md §3.4 / 团队定稿文案）。
 * [R4] 头部附加状态行（永久 → 试用 → 菜单；缺失不展示、分行清晰）。
 * [R5] 分流：本机已是正式会员（localLicense.status==='ACTIVE'）→ 只显授权状态、不弹套餐菜单、
 *       也不建立选时长会话（避免老会员误下单）；未开通 → 走套餐菜单（保留 R4 头部状态行）。
 * @param {string} server     激活服务器地址
 * @param {string} qq         发令者 QQ（会话 key）
 * @param {string} machineId  本机机器码（建单时使用）
 * @param {{machineId?:string, localLicense?:object}} [opts]
 */
async function cmdOpenMenu(server, qq, machineId, opts = {}) {
  // 先确认商城可达（套餐/价格以服务端为准），不可达则友好提示
  let shop = null;
  try { shop = await shopInfo(server); } catch (e) { shop = null; }
  if (!shop || !shop.body || !shop.body.ok) {
    return { lines: ['⚠️ 商城暂不可用，请稍后重试。'], handled: true };
  }

  // [R4] 头部状态行：永久/试用有则展示，缺失不展示（复用 buildStatusLines）
  const status = await buildStatusLines(server, machineId || (opts && opts.machineId) || '', qq, opts.localLicense);

  // [R5] 已开通会员（正式授权）→ 只显授权状态，不弹套餐菜单、不建 menuSessions
  if (status.isActiveMember) {
    const lines = status.lines.length ? status.lines : ['✅ 已开通会员（正式授权）'];
    return { lines, handled: true };
  }

  const menuLines = [
    '【开通会员】',
    '请选择要开通的会员时长：',
    '1. 月卡 5元',
    '2. 季卡 12元',
    '3. 年卡 48元',
    '4. 永久会员 128元',
    '',
    '回复对应数字即可下单（如需退出请回复「取消」）。',
  ];
  const lines = status.lines.length ? status.lines.concat([''], menuLines) : menuLines;

  // 建立选时长会话（超时由 MENU_TIMEOUT_MS 控制；machineId 供后续建单使用）
  menuSessions.set(qq, {
    step: 'await_plan',
    createdAt: Date.now(),
    channel: DEFAULT_CHANNEL,
    machineId: machineId || (opts && opts.machineId) || '',
  });
  return { lines, handled: true };
}

/**
 * 处理菜单选时长阶段的输入。
 *   - 1/2/3/4（或 "2." 形式）→ 映射套餐 → 建单（默认微信）→ 回执含订单号 + 金额 + 收款码 + 备注提示
 *   - 取消 / 退出 → 清会话并提示
 *   - 其他 → 提示"请回复 1-4 选择时长"并重发菜单（不建单）
 * @param {string} server
 * @param {string} qq
 * @param {string} text      原始输入
 * @param {string} machineId 本机机器码
 * @param {{machineId?:string}} [opts]
 */
async function cmdMenuSelect(server, qq, text, machineId, opts = {}) {
  const t = (text || '').trim();

  // 取消 / 退出
  if (/(取消|退出|quit|cancel)/i.test(t)) {
    menuSessions.delete(qq);
    return { lines: ['已取消开通，可随时发送「开通会员」重新选择。'], handled: true };
  }

  // 解析选择（支持 "2" 或 "2." 形式；剔除标点/空格/句号）
  const choice = t.replace(/[.\s。、]/g, '').toLowerCase();
  const plan = MENU_PLAN_MAP[choice];
  if (!plan) {
    // 其他输入：提示重发菜单（不建单、不误建）
    return {
      lines: [
        '请回复 1-4 之间的数字选择时长：',
        '1. 月卡 5元  2. 季卡 12元  3. 年卡 48元  4. 永久会员 128元',
      ],
      handled: true,
    };
  }

  // 建单（默认微信；金额=基准价，纯备注匹配）
  const o = await createOrder(server, {
    qq,
    machineId: machineId || (opts && opts.machineId) || '',
    plan,
    channel: DEFAULT_CHANNEL,
  });
  // 无论成功失败都清会话（避免重复触发）
  menuSessions.delete(qq);
  if (!o || !o.body || !o.body.ok) {
    return { lines: ['⚠️ 下单失败：' + ((o && o.body && o.body.error) || '未知错误') + '。请稍后重试或联系客服。'], handled: true };
  }
  const b = o.body;
  const label = MENU_PLAN_LABEL[plan] || (b.plan && b.plan.name) || plan;
  const lines = [
    `✅ 订单已创建（${label} ${b.amount}元）`,
    `订单号：${b.order_id}`,
    `金额：${b.amount} 元`,
    `收款方式：微信`,
    `请使用微信付款，并在付款备注中粘贴订单号：`,
    `${b.order_id}`,
    `（长按复制订单号）`,
    ``,
    `付款成功后系统将自动核验并发放会员，无需其他操作。`,
  ];
  // 构造本地图片 URL，供适配层下载后以图片消息发送（避免外网无法访问 IP 链接）
  const qrImageUrl = `${server}/qr/${DEFAULT_CHANNEL}.jpg`;
  return { lines, handled: true, qr_image_url: qrImageUrl };
}

async function cmdPaid(server, qq, orderId) {
  const c = await confirmOrder(server, { orderId, qq });
  if (!c.body.ok) {
    return { lines: ['⚠️ 确认失败：' + (c.body.error || '订单不存在/已过期/非本人订单') + '。请核对订单号，或联系客服。'], handled: true };
  }

  // 安全加固（2025-07-30）：confirmManual 现在只把订单推进到 await_verify（待核验），
  // 不代表真付款。因此这里【不再】盲目连发 issueOrder，而是轮询订单状态，
  // 等到监控器/商户核验到账、状态真正变为 paid 后再发 license。
  if (c.body.status === 'await_verify') {
    return await pollUntilPaid(server, orderId);
  }

  // 幂等/历史路径：订单早已是 paid/issued
  if (c.body.status === 'issued') {
    return { lines: ['✅ 该订单已激活，许可证已下发。如本机未生效，请联系客服刷新。'], handled: true };
  }
  const iss = await issueOrder(server, orderId);
  if (!iss.body.ok) {
    return { lines: ['✅ 已收到付款，但发码失败：' + (iss.body.error || '') + '。请联系客服手动补发。'], handled: true };
  }
  return buildSuccess(iss.body.license);
}

/**
 * 轮询订单状态，直至变为 paid/issued（核验到账）后发 license。
 * 这是「申报」与「真正发码」解耦后的收尾环节：监控器把 await_verify→paid 后，
 * 本函数即可检测到并自动完成发码，无需用户重复发送「已支付」。
 *
 * @param {string} server   激活服务器地址
 * @param {string} orderId  订单号
 * @param {{timeoutMs?:number, intervalMs?:number}} [opts]
 */
async function pollUntilPaid(server, orderId, opts = {}) {
  const timeoutMs = opts.timeoutMs || 180000; // 最多等 3 分钟（监控器每 60s 一轮，通常 1-2 分钟内到账）
  const intervalMs = opts.intervalMs || 8000; // 每 8 秒查询一次
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let st = null;
    try { st = await orderStatus(server, orderId); } catch (e) { /* 网络抖动，下一轮重试 */ }
    const status = st && st.body && st.body.status;
    if (status === 'paid' || status === 'issued') {
      // 核验到账 → 发 license（绑定本机机器码）
      const iss = await issueOrder(server, orderId);
      if (!iss.body.ok) {
        return { lines: ['✅ 已核验到账，但发码失败：' + (iss.body.error || '') + '。请联系客服手动补发。'], handled: true };
      }
      return buildSuccess(iss.body.license);
    }
    if (status === 'expired') {
      return { lines: ['⏰ 订单核验超时已过期，请重新发送「已支付 ' + orderId + '」或联系客服。'], handled: true };
    }
    await sleep(intervalMs);
  }
  // 超时仍未核验：告知申报已提交、系统仍在核验，无需重复发送（用户可稍后重发触发再次轮询）
  return {
    handled: true,
    lines: [
      '📨 已收到您的付款申报，系统正在核验到账（通常 1-2 分钟内）。',
      '核验通过后将会自动开通并下发许可证，请稍候，无需重复发送。',
      '如长时间未开通，请确认付款时已在备注填写订单号「' + orderId + '」，或联系客服。',
    ],
  };
}

/** 构造激活成功文案（含 license 对象，供适配层落盘） */
function buildSuccess(licenseObj) {
  return {
    handled: true,
    license: licenseObj,
    lines: [
      '🎉 激活成功！',
      `许可证已绑定本机（机器码尾号 ${String(licenseObj.machine_id).slice(-8)}）。`,
      '全功能已即时解锁，无需重启。',
    ],
  };
}

/** 简单延时（轮询用） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * [R4] 构建会员状态行（永久 → 试用）。
 *
 * 仅返回「实际存在的状态」：
 *  - 正式授权（localLicense.status === 'ACTIVE'）→ 已开通会员 + 到期时间（永久=「永久」）；
 *  - 用户维度试用存在 → 试用状态 + 剩余天数 + 到期时间；
 *  - 两者均缺失 → lines 为空（调用方据此决定是否展示状态区）。
 * 返回 { lines, isActiveMember, trialState }，供 cmdOpenMenu（头部状态行）与
 * cmdStatus（完整状态回复）复用；cmdStatus 的「暂无试用记录 / 状态查询暂不可用 /
 * 非会员引导」提示由调用方按 trialState 追加，保证既有行为不变。
 *
 * @param {string} server     激活服务器地址
 * @param {string} machineId  本机机器码
 * @param {string} qq         发令者 QQ（试用按 uin 查询）
 * @param {object} [localLicense] 本机正式授权（LicenseGate.getStatus() 结果）
 * @returns {Promise<{lines:string[], isActiveMember:boolean, trialState:string}>}
 */
async function buildStatusLines(server, machineId, qq, localLicense) {
  const lines = [];
  let isActiveMember = false;
  let trialState = 'unknown'; // 'exists' | 'none' | 'error' | 'unknown'

  // 1) 优先显示实际会员（本机正式授权，来自 LicenseGate.getStatus()）
  if (localLicense && localLicense.status === 'ACTIVE') {
    isActiveMember = true;
    lines.push('✅ 已开通会员（正式授权）');
    const exp = localLicense.expires_at;
    const expText = exp ? new Date(exp).toLocaleString('zh-CN', { hour12: false }) : '永久';
    lines.push('到期时间：' + expText);
  }

  // 2) 再显示用户维度试用（按 QQ / uin，服务端 /api/trial/user/status）
  // [R6 R1] 正式会员短路：已开通（isActiveMember=true）不再查询/展示试用，trialState 固定 'none'
  // （服务端 trialStatusByUin 对已转正式也会返回 converted 形状，双保险，契约 {lines,isActiveMember,trialState} 不变）。
  if (isActiveMember) {
    trialState = 'none';
  } else {
    try {
      const r = await trialStatusByUin(server, qq);
      if (r && r.body && r.body.ok && r.body.exists) {
        trialState = 'exists';
        const b = r.body;
        const statusText = b.status === 'active' ? '试用中'
          : b.status === 'expired' ? '已到期'
          : b.status === 'converted' ? '已激活'
          : String(b.status || '未知');
        lines.push(`ℹ️ 试用状态：${statusText}`);
        const days = Math.ceil((b.remaining_ms || 0) / 86400000);
        lines.push(`剩余 ${days} 天`);
        const expAt = b.trialExpiresAt ? new Date(b.trialExpiresAt).toLocaleString('zh-CN', { hour12: false }) : '永久';
        lines.push('到期时间：' + expAt);
      } else if (r && r.body && r.body.ok && !r.body.exists) {
        trialState = 'none';
      } else {
        trialState = 'error';
      }
    } catch (e) {
      trialState = 'error';
    }
  }

  return { lines, isActiveMember, trialState };
}

async function cmdStatus(server, machineId, qq, localLicense) {
  // [R4] 复用 buildStatusLines（永久 → 试用）；行为与既有 cmdStatus 完全一致：
  // 无试用记录提示 / 状态查询异常提示 / 非正式会员引导，均按 trialState 补齐。
  // [R6 R1] 正式会员短路：已开通会员只显授权状态，不再追加「暂无试用记录/查询不可用」提示
  //         （trialState='none' 对会员无意义；非会员行为与 R5 完全一致）。
  const { lines, isActiveMember, trialState } = await buildStatusLines(server, machineId, qq, localLicense);

  if (!isActiveMember && trialState === 'none') {
    lines.push('ℹ️ 您暂无试用记录（新用户首触将自动授予）。');
  } else if (!isActiveMember && trialState === 'error') {
    lines.push('⚠️ 状态查询暂不可用。');
  }

  // 3) 结尾兜底：非正式会员引导开通
  if (!isActiveMember) {
    lines.push('发送「开通会员」可付费解锁长期使用。');
  }

  return { lines, handled: true };
}

/** 试用到期提醒文案（onFeatureDenied / 主动提醒用；产品定稿） */
function reminderText() {
  return [
    '⏰ 您的试用已结束，部分功能已进入只读模式。',
    '继续使用的两种方式：',
    '① 发送「开通会员」→ 选择套餐 → 扫码付款 → 自动开通',
    '② 联系客服获取激活码',
  ];
}

/**
 * 首印提醒判定（激活流程简化 P0-5）。
 * 调用激活服务端 trialStatusByUin：若用户试用期已到期（status==='expired' 或剩余时间已耗尽）
 * 且本账号「到期后首印提醒」标记未置位（expired_print_at===0），返回需发送的提醒文案。
 *
 * @param {string} server 激活服务器地址
 * @param {string|number} uin 用户 QQ（试用记录 key）
 * @returns {Promise<{reminded:boolean, lines?:string[], error?:string}>}
 */
async function maybeTrialExpiredRemind(server, uin) {
  let st = null;
  try {
    st = await trialStatusByUin(server, uin);
  } catch (e) {
    return { reminded: false, error: 'network' };
  }
  if (!st || !st.body || !st.body.ok) return { reminded: false };
  const b = st.body;
  // 已到期：服务端状态为 expired，或剩余时间已耗尽（scanPendingReminders 未运行时也生效）
  const isExpired = b.status === 'expired' || (b.trialExpiresAt && b.remaining_ms <= 0);
  if (isExpired && b.expired_print_at === 0) {
    return {
      reminded: true,
      lines: [
        '📄 打印已完成。',
        '温馨提示：您的体验期已结束。为不影响下次使用，请及时开通会员版本。',
        '指令：开通会员（回复即可选择会员时长）',
      ],
    };
  }
  return { reminded: false };
}

/**
 * 标记首印提醒已发（去重）：调激活服务端 /api/trial/mark-expired-print（monitor token 鉴权）。
 * @param {string} server
 * @param {string|number} uin
 * @param {string} [monitorToken]
 * @returns {Promise<{status:number, body:any}>}
 */
function markExpiredPrintReminded(server, uin, monitorToken) {
  return req(server, 'POST', '/api/trial/mark-expired-print', { uin }, {
    'x-monitor-token': monitorToken || '',
  });
}

module.exports = {
  req, shopInfo, trialStatus, createOrder, confirmOrder, issueOrder, orderStatus,
  confirmOrderByMonitor, parseAdminConfirm, cmdAdminConfirmOrder,
  handleCommand, reminderText, pollUntilPaid,
  // P1 等级化雏形常量（见文件头说明；P0 不参与运行时逻辑）
  VIP_ADMIN_MIN_LEVEL,
  // 开通会员菜单状态机
  cmdOpenMenu, cmdMenuSelect, menuSessions, MENU_TIMEOUT_MS, DEFAULT_CHANNEL,
  // [R4] 会员状态行构建（cmdOpenMenu 头部 / cmdStatus 复用）
  buildStatusLines, cmdStatus,
  // 首印提醒（P0-5）
  maybeTrialExpiredRemind, markExpiredPrintReminded,
  // 新用户试用期
  grantTrial, getTrialConfig, pullPendingReminders, markReminded, trialStatusByUin,
  parseTrialAdminCommand, handleTrialAdminCommand,
  // 收款记录查询（管理员专属）
  parsePaymentRecordsCommand, handlePaymentRecordsCommand,
  // 推送记录查询（管理员专属）：推送查询
  parsePushLogCommand, handlePushLogCommand,
};
