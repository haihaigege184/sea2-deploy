'use strict';
/**
 * server.js — sea1 激活服务器（最小可用版）
 *
 * 设计要点（见 ACTIVATION_SYSTEM_DESIGN.md）：
 * - 独立端口(默认 3457)，独立数据目录，不碰老 activation-server(3456)
 * - 私钥仅存于服务端；客户端只持有公钥（/api/admin/publickey 导出）
 * - 激活码首次绑定时记录 machine_id，二次激活若机器不一致则拒绝（防码共享）
 * - 心跳校验：吊销/过期 → valid:false；客户端据此进入降级模式
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('./lib/crypto');
const { Store } = require('./lib/store');
const license = require('./lib/license');
const codes = require('./lib/codes');
const trials = require('./lib/trials');
const trial = require('./lib/trial');
const configManager = require('./lib/configManager');
const orders = require('./lib/orders');
const { PaymentMonitor } = require('./lib/payments');
const wechat = require('./lib/wechatWebhook');
const webhookLog = require('./lib/webhookLog');
// [T1-P1-7] bot 回调（发码 / 激活成功群通知）
const botNotifier = require('./lib/botNotifier');
// [SEA1] 商业化运维控制台：聚合路由 + 鉴权分发（独立支持 QQ 会话 + 超管令牌）
const consoleApi = require('./lib/consoleApi');
// [FLEET] 外网客户端集群管理（独立存储 + 阈值热读 + 异常引擎）
const fleetStore = require('./lib/fleetStore');
const fleetConfig = require('./lib/fleetConfig');
const anomaly = require('./lib/anomaly');
// [FLEET] 授权原因 → 授权态语义映射表（reason 单一事实来源，服务端/前端共用）
const fleetReason = require('./lib/fleetReason');
// [SEA2] 强门禁引擎（心跳 ack 回执 → format_device 高危记录自动推进，T05）
const opsHighrisk = require('./lib/ops/highrisk');
// [R4] 一键部署：公开部署配置下发（x-deploy-token 校验）
const deployConfig = require('./lib/deployConfig');
// [R6 R4] 容器管理（FastOSDocker）反代：预登录/会话缓存/401 重登/前缀剥离/console 鉴权/降级页/ws 隧道
const dockerMgrProxy = require('./lib/dockerMgrProxy');
// [R9 R3-3/R3-4/R3-5] 双系统开关 + 仲裁 + 审计 + 框架指令通道 + 运行时状态
const redundancy = require('./lib/redundancy');

// [FLEET] 单次心跳最多处理的回执条数（与 fleet.buildMeta().limits.ackResultsPerHeartbeat 保持一致）
// 上限用于防止畸形/恶意客户端一次性投递超大回执数组拖垮心跳链路。
const ACK_RESULTS_MAX = 20;

// [SEA1] 兜底加载本地 config.env（P0：支付宝凭证不依赖 pm2 env 注入）
// 仅填充缺失的环境变量；若进程已由 pm2 注入则不覆盖。
// 支持多行双引号值（如 PEM 私钥含真实换行）。
(function loadLocalEnvFile() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const envPath = path.join(__dirname, 'config.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/gm;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const key = mm[1];
      const val = mm[2];
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) { /* 忽略本地 env 读取错误 */ }
})();

// 默认套餐表（激活流程简化：新定价 月5/季12/年48/永久128；可被环境变量 PLANS_JSON 覆盖）
const DEFAULT_PLANS = {
  month: { id: 'month', name: '月度会员', price: 5, durationDays: 30, features: ['*'] },
  quarter: { id: 'quarter', name: '季度会员', price: 12, durationDays: 90, features: ['*'] },
  year: { id: 'year', name: '年度会员', price: 48, durationDays: 365, features: ['*'] },
  lifetime: { id: 'lifetime', name: '永久授权', price: 128, durationDays: 0, features: ['*'] },
};

function loadConfig() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  let plans = DEFAULT_PLANS;
  if (process.env.PLANS_JSON) {
    try { plans = JSON.parse(process.env.PLANS_JSON); } catch (e) { /* 用默认 */ }
  }
  return {
    port: parseInt(process.env.PORT || '3457', 10),
    host: process.env.HOST || '0.0.0.0',
    adminToken: process.env.ADMIN_TOKEN || 'changeme-admin-token',
    // [T2 P2-10] 局域网免登录开关（默认开；显式 '0'/'false' 可关闭，关闭后内网也必须 token）
    lanBypass: process.env.LAN_BYPASS !== '0' && process.env.LAN_BYPASS !== 'false',
    dataDir,
    keyFile: path.join(dataDir, 'keys.json'),
    graceDays: parseInt(process.env.GRACE_DAYS || '7', 10),
    trialDays: parseInt(process.env.TRIAL_DAYS || '14', 10),
    // 新用户试用期（按 uin / QQ）：可配置 + 到期柔软提醒
    trialMonths: parseInt(process.env.TRIAL_MONTHS || '3', 10),
    trialDisabled: process.env.TRIAL_DISABLED === '1',
    trialNearDays: (process.env.TRIAL_NEAR_DAYS || '7,3').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n)),
    trialMaxReminders: parseInt(process.env.TRIAL_MAX_REMINDERS || '3', 10),
    // [R6 R4] 容器管理（FastOSDocker 反代）：地址/账号/密码，来自 configManager SCHEMA 热更回写 config.env
    dockerMgrUrl: process.env.DOCKER_MGR_URL || 'http://127.0.0.1:8081',
    dockerMgrUser: process.env.DOCKER_MGR_USER || 'root',
    dockerMgrPass: process.env.DOCKER_MGR_PASS || 'root',
    plans,
    paymentMode: process.env.PAYMENT_MODE || 'manual',
    alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY || '',
    wechatApiKey: process.env.WECHAT_API_KEY || '',
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    // bot 内部回调地址（loopback）：webhook 匹配到付款后 POST {order_id} 触发 bot 发 license。
    // 未配置（默认空）→ 不回调，bot 通过既有「已支付 <订单号>」指令完成发码（详见 lib/botNotifier.js）。
    botNotifyUrl: process.env.BOT_NOTIFY_URL || '',
    // 与 bot 端点共享的令牌（必须等于 bot 进程 env BOT_NOTIFY_TOKEN）；随回调以 x-bot-notify-token 头 / ?token= 发送。
    botNotifyToken: process.env.BOT_NOTIFY_TOKEN || '',
    paymentQr: process.env.PAYMENT_QR_JSON || '{}', // {alipay:"https://...", wechat:"https://..."}
    // 公网 HTTPS 基址：用于拼接支付宝 notify_url（cloudflared 隧道或自有域名）
    // 优先环境变量，否则读隧道守护脚本写入的域名文件
    publicBaseUrl: (() => {
      const fromEnv = process.env.PUBLIC_BASE_URL || '';
      if (/^https?:\/\//.test(fromEnv)) return fromEnv.replace(/\/$/, '');
      try {
        const f = path.join(__dirname, 'tunnel_domain.txt');
        if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim().replace(/\/$/, '');
      } catch (e) { /* ignore */ }
      return '';
    })(),
    // 支付宝当面付（动态下单自动发码，全自动）
    alipayAppId: process.env.ALIPAY_APP_ID || '',
    alipayPrivateKey: process.env.ALIPAY_PRIVATE_KEY || '',
    alipayGateway: process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
  };
}

/** 确保 RSA 密钥存在（首次运行生成并持久化） */
function ensureKeys(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (fs.existsSync(cfg.keyFile)) {
    return JSON.parse(fs.readFileSync(cfg.keyFile, 'utf8'));
  }
  const pair = crypto.generateKeyPair();
  const rec = { privateKey: pair.privateKey, publicKey: pair.publicKey, generated_at: Date.now() };
  fs.writeFileSync(cfg.keyFile, JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function serveFile(res, file, opts = {}) {
  try {
    const data = fs.readFileSync(file);
    const ext = path.extname(file);
    // MIME 映射表：避免 .css 等被回退成 application/octet-stream 导致浏览器拒绝解析。
    // 保持 HTML/JS/图片既有映射不变，并补齐常见静态资源/字体类型，避免后续再踩同样的坑。
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.eot': 'application/vnd.ms-fontobject',
    };
    const ct = opts.contentType || MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  } catch (e) {
    send(res, 404, { ok: false, error: 'not found' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** 读取原始请求体（字符串），供需要原文的场景（如 HMAC 验签）使用。 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * 校验特权接口 token（x-monitor-token），与 /api/admin/order/confirm 同款 fail-closed 策略：
 * 未配置 MONITOR_TOKEN → 401（接口停用）；值不匹配 → 401。
 * @returns {{ok:boolean, error?:string}}
 */
function verifyMonitorToken(req, url) {
  const monitorToken = process.env.MONITOR_TOKEN || '';
  if (!monitorToken) {
    return { ok: false, error: '未配置 MONITOR_TOKEN，该接口已停用（请在服务端设置强 MONITOR_TOKEN 后重启）' };
  }
  const provided = (req.headers['x-monitor-token'] || '') || (url.searchParams.get('monitor_token') || '');
  if (provided !== monitorToken) {
    return { ok: false, error: '需要有效的监控 token' };
  }
  return { ok: true };
}

/**
 * [R9] 设备侧运维接口 token 校验（/api/ops/*）：
 * 优先 OPS_TOKEN（独立密钥）；未配置则回落 ADMIN_TOKEN（同一部署机管理口径）。
 * [O-3] OPS_TOKEN 与 ADMIN_TOKEN 均未配置 → fail-closed（拒绝），与 verifyMonitorToken 一致，
 * 不再放行；调用方收到 401「未配置令牌」而非静默通过，防止默认配置下运维接口裸奔。
 * @param {object} req
 * @param {URL} url
 * @param {object} cfg
 * @returns {{ok:boolean, error?:string}}
 */
function verifyOpsToken(req, url, cfg) {
  const opsToken = process.env.OPS_TOKEN || '';
  const adminTokenEnv = process.env.ADMIN_TOKEN || '';
  const provided = (req.headers['x-ops-token'] || '') || (url.searchParams.get('ops_token') || '');
  // [O-3] 双空 → fail-closed：未配置令牌时拒绝（与 verifyMonitorToken 同策略）
  if (!opsToken && !adminTokenEnv) {
    return { ok: false, error: '未配置 OPS_TOKEN/ADMIN_TOKEN，该接口已停用（请在服务端配置令牌后重启）' };
  }
  const expected = opsToken || adminTokenEnv;
  return provided === expected ? { ok: true } : { ok: false, error: '需要有效的 ops token' };
}

function makeApp(cfg, keys, store) {
  // 模式自动决策：支付宝密钥齐全 → webhook（全自动，支付宝回调自动验签）；
  // 否则 manual（个人码半自动，用户发"已支付" + 后台/本人确认）
  const autoMode = cfg.alipayAppId && cfg.alipayPrivateKey && cfg.alipayPublicKey;
  const monitor = new PaymentMonitor({
    mode: autoMode ? 'webhook' : (cfg.paymentMode || 'manual'),
    alipayPublicKey: cfg.alipayPublicKey,
    wechatApiKey: cfg.wechatApiKey,
    webhookSecret: cfg.webhookSecret,
  });
  let paymentQr = {};
  try { paymentQr = JSON.parse(cfg.paymentQr); } catch (e) { paymentQr = {}; }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isAdmin = req.headers['x-admin-token'] === cfg.adminToken;

    try {
      // ---- 公开：激活 ----
      if (req.method === 'POST' && url.pathname === '/api/activate') {
        const body = await readBody(req);
        const { machine_id, code } = body || {};
        if (!machine_id || !code) return send(res, 400, { ok: false, error: 'machine_id 与 code 必填' });
        if (!codes.isValidCodeFormat(code)) return send(res, 400, { ok: false, error: '激活码格式错误' });
        const rec = store.getCode(code);
        if (!rec) return send(res, 404, { ok: false, error: '激活码不存在' });
        if (rec.status === 'revoked') return send(res, 403, { ok: false, error: '激活码已被吊销' });
        if (codes.isCodeExpired(rec)) return send(res, 403, { ok: false, error: '激活码已过期' });
        if (rec.status === 'active' && rec.bound_machine_id && rec.bound_machine_id !== machine_id) {
          return send(res, 409, { ok: false, error: '激活码已绑定其他设备' });
        }
        const lic = license.buildLicense(keys.privateKey, {
          machine_id,
          code,
          customer: rec.customer,
          features: rec.features,
          expires_at: rec.expires_at || 0,
          max_groups: rec.max_groups,
        });
        // 注意：hmac 不混入 license 对象，否则会改变规范化原文导致验签失败
        store.saveLicense({ code, license: lic, hmac: license.licenseHmac('sea1-lic', lic) });
        store.updateCode(code, { status: 'active', bound_machine_id: machine_id });
        // [R6 R1] 激活成功 → 幂等清除该机器/客户的试用记录（机器+用户双维度；原子幂等）
        try { trial.clearTrials(store, { machineId: machine_id, uin: rec.customer }); } catch (e) { /* best-effort */ }
        return send(res, 200, { ok: true, license: lic });
      }

      // ---- 公开：心跳（[FLEET] 扩展：富化字段 + 指令 pull + ack 回执）----
      if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
        const body = await readBody(req);
        let { machine_id, code, nonce } = body || {};
        // —— sea2 商用运维：试用心跳（设计 §9.4.4）——
        // ① 放宽：不再强制 code 必填（试用设备 code=''）；但 code 为空时必须是 trial:true，
        //    否则 400 trial-required（fail-closed，防止无授权设备混入正式心跳通道）。
        if (!machine_id) return send(res, 400, { ok: false, error: 'machine_id 必填' });
        const isTrialHeartbeat = !code;
        if (isTrialHeartbeat && body.trial !== true) {
          return send(res, 400, { ok: false, error: 'trial-required' });
        }
        const rec = code ? store.getCode(code) : null;
        const licRec = code ? store.getLicense(code) : null;
        let lic = licRec ? licRec.license : null;

        const fs2 = fleetStore.getInstance(cfg.dataDir);
        // T05：强门禁引擎（与心跳同一 fleetStore 实例，format_device 回执自动推进高危记录）
        const hrEngine = new opsHighrisk.OpsHighrisk({ store, fsInst: fs2 });

        // ---- ① 指令回执：新通道 ack_results 优先，旧通道 ack_id 兜底 ----
        // 顺序至关重要：ack_results 是权威结果（含 unsupported/failed），
        // 必须先处理；ack_id 只表达「执行过」，若先处理会把 unsupported 错翻成 acked。
        // markResult 的终态保护是第二道防线。
        // 心跳是生命线：整段用 try/catch 包住，回执解析异常绝不影响 200 返回。
        try {
          if (Array.isArray(body.ack_results)) {
            const results = body.ack_results.slice(0, ACK_RESULTS_MAX);
            for (const r of results) {
              if (!r || !r.id) continue;
              fs2.markResult(String(r.id), {
                ok: !!r.ok,
                error: r.ok ? '' : String(r.error || 'unknown'),
                result: r.result,   // markResult 内部做 64KB 截断 + 保留策略
              });
              // T05：format_device 回执 → 高危记录自动推进（best-effort，绝不阻断心跳）
              // ack_results 不带 recordId，按 commandId 反查 fleetStore.highrisk[]（其含 commandId）。
              try {
                const midRec = fs2.getClient(machine_id);
                const cmd = midRec ? (midRec.commands || []).find((c) => c.id === String(r.id)) : null;
                if (cmd && cmd.action === 'format_device') {
                  const hr = (fs2.listAllHighrisk({}) || []).find((x) => x.commandId === String(r.id));
                  if (hr && ['done', 'failed', 'rejected'].indexOf(hr.status) < 0) {
                    hrEngine.advance(hr.recordId, {
                      status: cmd.status === 'acked' ? 'done' : 'failed',
                      ackedAt: cmd.ackedAt || Math.floor(Date.now() / 1000),
                      result: cmd.result,
                      operator: hr.totpOperator || 'system',
                    });
                  }
                }
              } catch (e2) {
                // best-effort：高危推进失败只影响状态展示，不影响指令回执与心跳
              }
            }
          }
          if (body.ack_id) {
            const ackIds = Array.isArray(body.ack_id) ? body.ack_id : [body.ack_id];
            for (const aid of ackIds.slice(0, ACK_RESULTS_MAX)) fs2.markAcked(aid);
          }
        } catch (e) {
          // best-effort：回执丢失可由下次心跳重传，不能拖垮心跳
        }

        // ---- ② 授权判定树（修 F5：成功时 reason 明确置 'ok'）----
        // 拆分 rec/lic 缺失为两个可行动的 reason，替代此前笼统的 'no-record'：
        //   code-not-found     授权码本身不在服务端（多为客户端连错服务器）
        //   license-not-issued 授权码在但 license 记录缺失（需重新签发）
        let valid = false;
        let reason = 'unknown';
        // —— sea2 商用运维：试用心跳分支（设计 §9.4.4）——
        // 试用不进入授权七态：licenseState 恒为 unknown（由 fleetReason.toLicenseState 派生），
        // 用独立 isTrial 布尔表达；trialInfo 供前端展示剩余时间。
        // 正式心跳（isTrialHeartbeat=false）逻辑完全不动（铁律）。
        let trialInfoSnapshot = null;   // 写入快照的 camelCase trialInfo（客户端上报优先，服务端计算兜底）
        let trialResp = null;           // 试用心跳响应附加字段（active 才带 licenseState/trialInfo）
        // [SEA2] 已签发防覆盖：试用心跳命中「active 且绑定本机」的授权码时置非空，
        // 供 recordHeartbeat 的 isTrial 判定（isTrialHeartbeat && !activeRec）使用。
        // [R6 R1] 该分支即「心跳 trial 路径排除机器维度已授权」：已授权机器绝不进入
        // trial-active/trial-expired 分支（含过期授权 → reason=expired，会员过期不恢复试用）。
        let activeRec = null;
        if (isTrialHeartbeat) {
          // —— sea2 商用运维：已签发防覆盖（客户端 license.json 缺失但仍发试用心跳）——
          // 场景：设备已激活（store.codes 存在 status=active 且 bound_machine_id=本机）但客户端
          // license.json 丢失，持续发 code='' + trial:true 试用心跳；若按 trialStatus 判定会把
          // 快照刷成 trial-active，集群页永远显示「试用中」。此处检测到已签发绑定 → 转正式判定，
          // 试用心跳不得覆盖正式授权态（快照 isTrial:false / reason:ok / licenseState:valid）。
          activeRec = store.listCodes().find((c) => c && c.status === 'active' && c.bound_machine_id === machine_id);
          if (activeRec) {
            code = activeRec.code;
            const licRec2 = store.getLicense(activeRec.code);
            lic = licRec2 ? licRec2.license : null;
            if (lic) {
              const v = license.verifyLicenseObject(keys.publicKey, lic);
              if (v.ok) {
                valid = true;
                reason = 'ok';
              } else {
                // 不吞校验失败：坏签名/过期如实上报（licenseState 由 fleetReason 派生），绝不退回 trial-active
                reason = v.reason;
              }
            } else {
              reason = 'license-not-issued';
            }
          } else {
            const t = trials.trialStatus(store, machine_id, cfg.trialDays);
            reason = t.expired ? 'trial-expired' : 'trial-active';
            trialInfoSnapshot = (body.trial_info && typeof body.trial_info === 'object')
              ? Object.assign({}, body.trial_info)
              : { active: !t.expired, expired: t.expired, remaining_ms: t.remaining_ms, end: Math.floor(t.end / 1000) };
            trialResp = { valid: false, reason, isTrial: true };
            if (!t.expired) {
              trialResp.licenseState = 'unknown';
              trialResp.trialInfo = { active: true, expired: false, remaining_ms: t.remaining_ms, end: Math.floor(t.end / 1000) };
            }
          }
        } else if (fs2.isBlacklisted(machine_id)) {
          reason = 'blacklisted';
        } else if (!rec) {
          reason = 'code-not-found';
        } else if (!lic) {
          reason = 'license-not-issued';
        } else if (rec.status === 'revoked') {
          reason = 'revoked';
        } else if (codes.isCodeExpired(rec)) {
          reason = 'expired';
        } else if (rec.bound_machine_id && rec.bound_machine_id !== machine_id) {
          reason = 'machine-mismatch';
        } else {
          const v = license.verifyLicenseObject(keys.publicKey, lic);
          if (!v.ok) {
            reason = v.reason;
          } else {
            valid = true;
            reason = 'ok';   // ← 修 F5：此前只置 valid，reason 停留在初值
          }
        }
        const licenseState = fleetReason.toLicenseState(reason);

        // ---- ③ 记录富化字段 + 打印机（内存写，debounce 落盘）----
        const publicIp = body.public_ip || (req.socket && req.socket.remoteAddress) || '';
        fs2.recordHeartbeat(machine_id, {
          code,
          qq: body.qq,
          online: body.online !== false,
          version: body.version,
          publicIp,
          region: body.region,
          cpuUsage: typeof body.cpu_usage === 'number' ? body.cpu_usage : undefined,
          memUsage: typeof body.mem_usage === 'number' ? body.mem_usage : undefined,
          bootTime: body.boot_time,
          clientTs: body.client_ts,
          valid,
          reason,
          licenseState,          // 修 F4：与 reason/valid 一同冻结进快照
          nonce,
          license: valid ? lic : null,
          printers: Array.isArray(body.printers) ? body.printers : [],
          // P1-2：客户端早已上报却被服务端丢弃的三个字段
          platform: body.platform,
          arch: body.arch,
          hostname: body.hostname,
          // —— sea2 心跳 v2（body snake_case → 快照 camelCase，设计 §3.2）——
          heartbeatProto: body.heartbeatProto !== undefined ? body.heartbeatProto : body.heartbeat_proto,
          commandsProto: body.commandsProto !== undefined ? body.commandsProto : body.commands_proto,
          pm2Processes: body.pm2_processes,
          cups: body.cups,
          loginInfo: body.login_info,
          // —— sea2 商用运维：试用心跳（设计 §9.4.4；snake_case trial/trial_info → camelCase isTrial/trialInfo）——
          // 正式心跳传 undefined，fleetStore 保持快照默认（isTrial:false / trialInfo:null），既有语义零影响。
          isTrial: isTrialHeartbeat && !activeRec,
          trialInfo: isTrialHeartbeat ? trialInfoSnapshot : undefined,
        });

        // [R9 R3-1/R3-2] 心跳富化：记录双通道/熔断运行时状态（best-effort，供熔断查看/运维后台/审计对拍）
        try {
          redundancy.recordRuntime(machine_id, {
            channel: body.channel || '',
            channelState: body.channel_state || body.channelState || '',
            circuitBroken: body.circuit_broken === true || body.circuitBroken === true,
            mainOnline: body.main_online === true || body.mainOnline === true,
            backupOnline: body.backup_online === true || body.backupOnline === true,
            dualEnabled: body.dual_enabled === true || body.dualEnabled === true,
          });
        } catch (e) { /* best-effort：运行时记录失败不影响心跳主流程 */ }

        const resp = { ok: true, valid, reason, server_time: Math.floor(Date.now() / 1000) };
        // 试用心跳响应附加试用语义（正式心跳契约零变化）
        if (trialResp) {
          resp.isTrial = trialResp.isTrial;
          if (trialResp.licenseState) resp.licenseState = trialResp.licenseState;
          if (trialResp.trialInfo) resp.trialInfo = trialResp.trialInfo;
        }
        if (valid && lic) resp.license = lic;
        // [FLEET] 下发待执行指令（pull）：取该机 pending 指令并标 sent
        const pending = fs2.getPendingCommands(machine_id);
        if (pending.length) {
          resp.commands = pending.map((c) => ({ id: c.id, action: c.action, payload: c.payload || {}, issued_at: c.issued_at }));
        }
        return send(res, 200, resp);
      }

      // ---- 公开：商城信息（套餐 + 收款码）----
      if (req.method === 'GET' && url.pathname === '/api/shop/info') {
        return send(res, 200, {
          ok: true,
          trial_days: cfg.trialDays,
          plans: Object.values(cfg.plans),
          payment_qr: paymentQr,
          payment_mode: cfg.paymentMode,
          publicKey: keys.publicKey, // 公开安全：客户端验签/配置同步用
          server_time: Math.floor(Date.now() / 1000),
        });
      }

      // ---- 公开：试用状态（按 machine_id）----
      if (req.method === 'POST' && url.pathname === '/api/trial/status') {
        const body = await readBody(req);
        const { machine_id } = body || {};
        if (!machine_id) return send(res, 400, { ok: false, error: 'machine_id 必填' });
        const st = trials.trialStatus(store, machine_id, cfg.trialDays);
        return send(res, 200, { ok: true, ...st });
      }

      // ---- 新用户试用期（按 uin / QQ）：授予（特权接口，x-monitor-token）----
      if (req.method === 'POST' && url.pathname === '/api/trial/grant') {
        const mt = verifyMonitorToken(req, url);
        if (!mt.ok) return send(res, 401, { ok: false, error: mt.error });
        const body = await readBody(req);
        const { uin, months } = body || {};
        if (!uin) return send(res, 400, { ok: false, error: 'uin 必填' });
        const r = trial.grantTrial(store, cfg, { uin, months });
        if (!r.ok && r.disabled) return send(res, 200, { ok: false, disabled: true });
        if (!r.ok) return send(res, 400, { ok: false, error: r.error || 'grant 失败' });
        return send(res, 200, {
          ok: true, already: !!r.already, uin: r.uin,
          trialStartAt: r.trialStartAt, trialExpiresAt: r.trialExpiresAt, status: r.status,
        });
      }

      // ---- 公开：试用配置 ----
      if (req.method === 'GET' && url.pathname === '/api/trial/config') {
        const c = trial.getTrialConfig(store, cfg);
        return send(res, 200, {
          ok: true, months: c.months, disabled: c.disabled, nearDays: c.nearDays, maxReminders: c.maxReminders,
        });
      }

      // ---- 公开：单用户试用状态（仅该 uin）----
      if (req.method === 'GET' && url.pathname === '/api/trial/user/status') {
        const uin = url.searchParams.get('uin');
        if (!uin) return send(res, 400, { ok: false, error: 'uin 必填' });
        return send(res, 200, trial.trialStatusByUin(store, uin));
      }

      // ---- 待发提醒队列（特权接口，x-monitor-token）----
      if (req.method === 'GET' && url.pathname === '/api/trial/pending-reminders') {
        const mt = verifyMonitorToken(req, url);
        if (!mt.ok) return send(res, 401, { ok: false, error: mt.error });
        const items = trial.listPendingReminders(store).map((r) => ({ uin: r.uin, type: r.type, due_at: r.due_at }));
        return send(res, 200, { ok: true, items });
      }

      // ---- 标记提醒已发（特权接口，x-monitor-token）----
      if (req.method === 'POST' && url.pathname === '/api/trial/mark-reminded') {
        const mt = verifyMonitorToken(req, url);
        if (!mt.ok) return send(res, 401, { ok: false, error: mt.error });
        const body = await readBody(req);
        const { uin, type } = body || {};
        if (!uin || !type) return send(res, 400, { ok: false, error: 'uin 与 type 必填' });
        const r = trial.markReminded(store, uin, type);
        return send(res, 200, r);
      }

      // ---- 标记首印提醒已发（落盘 expired_print_at，去重；x-monitor-token）----
      // 由 bot 端「首印提醒」逻辑在到期用户首次打印完成后调用，保证仅提醒一次（见 lib/trial.js）。
      if (req.method === 'POST' && url.pathname === '/api/trial/mark-expired-print') {
        const mt = verifyMonitorToken(req, url);
        if (!mt.ok) return send(res, 401, { ok: false, error: mt.error });
        const body = await readBody(req);
        const { uin } = body || {};
        if (!uin) return send(res, 400, { ok: false, error: 'uin 必填' });
        const r = trial.markExpiredPrintReminded(store, uin);
        return send(res, 200, r);
      }

      // ---- 公开：建单（机器人指令触发）----
      if (req.method === 'POST' && url.pathname === '/api/order/create') {
        const body = await readBody(req);
        const { qq, machine_id, plan, channel } = body || {};
        if (!qq || !machine_id) return send(res, 400, { ok: false, error: 'qq 与 machine_id 必填' });
        const p = cfg.plans[plan];
        if (!p) return send(res, 400, { ok: false, error: '未知套餐: ' + plan });
        const order = orders.createOrder(store, {
          qq, machine_id, plan: p.id, channel: channel || 'alipay',
          amount: p.price,
        });
        const notifyUrl = cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/api/pay/notify` : '';

        // 全自动（支付宝当面付）：若密钥齐备，动态生成订单专属收款二维码
        let dynamicQr = null;
        if (order.channel === 'alipay' && cfg.alipayAppId && cfg.alipayPrivateKey && cfg.alipayPublicKey) {
          try {
            const Alipay = require('./lib/alipay');
            const qr = Alipay.precreate({
              appId: cfg.alipayAppId,
              privateKey: cfg.alipayPrivateKey,
              gateway: cfg.alipayGateway,
              outTradeNo: order.order_id,
              totalAmount: order.amount,
              subject: `SEA1 ${p.name}`,
              notifyUrl,
            });
            if (qr && qr.qrPngBase64) dynamicQr = qr.qrPngBase64; // 二维码图片 base64(data URL)
          } catch (e) {
            dynamicQr = null; // 动态下单失败则降级静态码
          }
        }

        return send(res, 200, {
          ok: true,
          order_id: order.order_id,
          confirm_code: order.confirm_code,
          amount: order.amount,
          plan: p,
          channel: order.channel,
          expire_at: order.expire_at,
          status: order.status,
          payment_qr: paymentQr[order.channel] || paymentQr.alipay || null,
          dynamic_qr_png: dynamicQr, // 支付宝当面付动态码图片（优先于 payment_qr）
          notify_url: notifyUrl,
          auto_mode: !!dynamicQr,
        });
      }

      // ---- 公开：人工申报支付（个人码场景，仅下单者本人）----
      if (req.method === 'POST' && url.pathname === '/api/order/confirm') {
        const body = await readBody(req);
        const { order_id, qq } = body || {};
        if (!order_id || !qq) return send(res, 400, { ok: false, error: 'order_id 与 qq 必填' });
        const r = monitor.confirmManual(store, order_id, qq);
        if (!r.ok) return send(res, r.already ? 200 : 400, { ok: r.ok, error: r.error, already: r.already });
        // 安全加固：confirmManual 现在只把订单推进到 await_verify（待核验），
        // 绝不返回 paid。前端/bot 应等待订单状态真正变为 paid 后再调 /api/order/issue。
        if (r.status === 'await_verify') {
          return send(res, 200, {
            ok: true,
            order_id,
            status: 'await_verify',
            message: '已收到付款申报，系统核验到账后自动开通（或由商户核实）。请稍候，无需重复发送。',
          });
        }
        // 幂等：订单早已是 paid/issued
        return send(res, 200, { ok: true, order_id, status: r.status || 'paid', already: true });
      }

      // ---- 商户/监控器核验接口（独立鉴权，强制专用 MONITOR_TOKEN）----
      // 作用：把 await_verify 订单推进到 paid（真实到账确认后）。
      // 安全加固（2025-07-30）：强制要求专用 MONITOR_TOKEN（x-monitor-token 头），
      // 【绝不】退回默认 admin 口令。若服务端未配置 MONITOR_TOKEN，则直接拒绝服务（始终 401），
      // 避免部署漏设强 token 时攻击者用已知默认口令把 await_verify 推进 paid、变相复活白嫖漏洞。
      if (req.method === 'POST' && url.pathname === '/api/admin/order/confirm') {
        const monitorToken = process.env.MONITOR_TOKEN || '';
        if (!monitorToken) {
          // fail-closed：未配置专用 token 时该接口停用，不再裸奔放行
          return send(res, 401, {
            ok: false,
            error: '未配置 MONITOR_TOKEN，商户/监控器核验接口已停用；请在服务端设置强 MONITOR_TOKEN 后重启',
          });
        }
        const providedMonitor = req.headers['x-monitor-token'] || url.searchParams.get('monitor_token') || '';
        if (providedMonitor !== monitorToken) {
          return send(res, 401, { ok: false, error: '需要有效的监控 token' });
        }
        const body = await readBody(req);
        const o = store.getOrder(body.order_id);
        if (!o) return send(res, 404, { ok: false, error: '订单不存在' });
        // 仅允许从 await_verify / pending 推进到 paid；终态保持不变（幂等）
        if (o.status === 'await_verify' || o.status === 'pending') {
          orders.markPaid(store, body.order_id, { channel: o.channel, trade_no: body.trade_no || '' });
          console.log(`[activation-server] 订单 ${body.order_id} 已由监控器/商户核验到账 → paid`);
          return send(res, 200, { ok: true, order_id: body.order_id, status: 'paid' });
        }
        if (o.status === 'paid' || o.status === 'issued') {
          return send(res, 200, { ok: true, order_id: body.order_id, status: o.status, already: true });
        }
        return send(res, 400, { ok: false, error: '订单状态不可推进: ' + o.status });
      }

      // ---- 公开：商户 webhook 异步通知 ----
      if (req.method === 'POST' && url.pathname === '/api/pay/notify') {
        const body = await readBody(req);
        const channel = url.searchParams.get('channel') || (body && body.channel) || 'alipay';
        const r = await monitor.handleWebhook(store, channel, body || {});
        if (!r.ok) return send(res, 400, { ok: false, error: r.error });
        // 支付宝要求返回纯文本 success，微信要求 SUCCESS；统一返回 success
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('success');
        return;
      }

      // ---- SmsForwarder 微信收款通知 webhook（fail-closed 验签）----
      // 路径：POST /api/v1/webhook/wechat?secret=<WEBHOOK_SECRET>
      // 兼容：secret 也可经 x-monitor-token 头传递。
      // 可选纵深防御：若带 X-Signature 头，则强制校验 HMAC-SHA256(rawBody, webhookSecret)。
      if (req.method === 'POST' && url.pathname === '/api/v1/webhook/wechat') {
        const providedSecret = url.searchParams.get('secret') || (req.headers['x-monitor-token'] || '') || '';
        // fail-closed：密钥缺失 / 未配置 / 不符 → 401，绝不进入后续逻辑
        if (!wechat.verifyWebhookSecret(cfg, providedSecret)) {
          return send(res, 401, { ok: false, error: 'invalid webhook secret' });
        }
        const rawBody = await readRawBody(req);
        const sig = req.headers['x-signature'] || '';
        if (sig && !wechat.verifySignature(cfg.webhookSecret, rawBody, sig)) {
          return send(res, 401, { ok: false, error: 'invalid webhook signature' });
        }
        let payload = {};
        try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch (e) { payload = {}; }
        const r = wechat.handleWechatWebhook({ cfg, store, payload, rawBody, headers: req.headers });
        return send(res, r.status, r.body);
      }

      // ---- 公开：订单状态 ----
      if (req.method === 'GET' && url.pathname === '/api/order/status') {
        const orderId = url.searchParams.get('order_id');
        const o = store.getOrder(orderId);
        if (!o) return send(res, 404, { ok: false, error: '订单不存在' });
        return send(res, 200, {
          ok: true,
          order_id: o.order_id, status: o.status, amount: o.amount,
          plan: o.plan, channel: o.channel, created_at: o.created_at,
          expire_at: o.expire_at, code: o.code, paid_at: o.paid_at,
        });
      }

      // ---- 公开：支付后发码并绑定机器（生成 license 交给客户端）----
      if (req.method === 'POST' && url.pathname === '/api/order/issue') {
        const body = await readBody(req);
        const { order_id } = body || {};
        const o = store.getOrder(order_id);
        if (!o) return send(res, 404, { ok: false, error: '订单不存在' });
        if (o.status !== 'paid') return send(res, 400, { ok: false, error: '订单尚未支付: ' + o.status });
        const p = cfg.plans[o.plan];
        // [T1-P1-4] expires_at 统一为「秒」：此前毫秒与 crud/makeCodeRecord 的秒值混用，
        // 导致 codes.isCodeExpired 按秒比较时毫秒值永不过期（存量毫秒值由 normalizeExpiresAt 换算）。
        const expires_at = p && p.durationDays > 0 ? Math.floor(Date.now() / 1000) + p.durationDays * 86400 : 0;
        const rec = codes.makeCodeRecord({
          customer: o.qq,
          features: (p && p.features) || ['*'],
          expires_at,
          max_groups: 0,
        });
        store.createCode(rec);
        const lic = license.buildLicense(keys.privateKey, {
          machine_id: o.machine_id,
          code: rec.code,
          customer: rec.customer,
          features: rec.features,
          expires_at: rec.expires_at || 0,
          max_groups: rec.max_groups,
        });
        store.saveLicense({ code: rec.code, license: lic, hmac: license.licenseHmac('sea1-lic', lic) });
        store.updateCode(rec.code, { status: 'active', bound_machine_id: o.machine_id });
        orders.attachCode(store, order_id, rec.code);
        // [R6 R1] 签发成功 → 幂等清除该机器/客户的试用记录（双调用点之二；原子幂等）
        try { trial.clearTrials(store, { machineId: o.machine_id, uin: o.qq }); } catch (e) { /* best-effort */ }

        // [T1-P1-8] 签发即刷新 fleet 快照（试用→激活即时转换，集群页无需等心跳）
        // best-effort：快照刷新失败绝不影响签发结果。
        try {
          fleetStore.getInstance(cfg.dataDir).setLicenseState(o.machine_id, {
            code: rec.code,
            qq: o.qq,
            license: lic,
            reason: 'ok',
            valid: true,
            licenseState: 'valid',
            isTrial: false,
            trialInfo: null,
            licenseCheckedAt: Math.floor(Date.now() / 1000),
          });
        } catch (e) { /* ignore */ }

        // [T1-P1-7] 激活成功 → 回调 bot 推送「开通成功」群通知（best-effort；未配置 BOT_NOTIFY_URL 为 no-op）
        let activatedNotify = null;
        try {
          activatedNotify = botNotifier.notifyActivated(cfg, order_id, { qq: o.qq, plan: o.plan });
        } catch (e) {
          activatedNotify = { notified: false, error: String((e && e.message) || e) };
        }

        return send(res, 200, {
          ok: true, order_id, code: rec.code, license: lic,
          notify: {
            event: 'activated',
            order_id,
            notified: !!(activatedNotify && activatedNotify.notified),
          },
        });
      }

      // ---- [R4] 公开：一键部署配置下发（部署脚本 fetch-deploy-config.sh 消费）----
      // x-deploy-token = env SEA2_DEPLOY_TOKEN；未设置 → 503（fail-closed）
      if (req.method === 'GET' && url.pathname === '/api/deploy/config') {
        const expected = String(process.env.SEA2_DEPLOY_TOKEN || '').trim();
        if (!expected) return send(res, 503, { ok: false, error: '部署令牌未配置（SEA2_DEPLOY_TOKEN）' });
        const provided = String(req.headers['x-deploy-token'] || '');
        const aBuf = Buffer.from(String(provided));
        const bBuf = Buffer.from(expected);
        const valid = aBuf.length === bBuf.length && require('node:crypto').timingSafeEqual(aBuf, bBuf);
        if (!valid) return send(res, 401, { ok: false, error: '部署令牌无效' });
        const c = deployConfig.load();
        return send(res, 200, {
          ok: true,
          masterAddress: String(c.masterAddress || ''),
          tunnels: (c.tunnels || []).filter((t) => t.enabled === true),
          updatedAt: String(c.updatedAt || ''),
        });
      }

      // ---- [R6 R4] 容器管理（FastOSDocker）反代路由 ----
      // 置于 console 静态与 admin 闸门之前：/docker-mgr/* 前缀剥离转发、根 /ws 终端隧道、
      // 根 POST /login 兜底（app.js baseURL 重写失败时 SPA 登录仍可达）。鉴权在 dockerMgrProxy 内完成。
      if (
        url.pathname === '/docker-mgr' ||
        url.pathname.startsWith('/docker-mgr/') ||
        (req.method === 'POST' && url.pathname === '/login') ||
        (url.pathname === '/ws' && req.headers.upgrade && /websocket/i.test(String(req.headers.upgrade)))
      ) {
        return dockerMgrProxy.handle(req, res, url, cfg);
      }

      // ---- [R9 R3-3/R3-4] 设备侧运维接口（/api/ops/*，x-ops-token 鉴权）----
      // 供本机 qr-server（双系统开关/切换框架）、sea2-watchdog（框架指令轮询）、sea.js bot（unblock 轮询）调用。
      // 所有端点统一要求 OPS_TOKEN（未配置回落 ADMIN_TOKEN），防任意设备互操作。
      if (url.pathname.startsWith('/api/ops/')) {
        const ot = verifyOpsToken(req, url, cfg);
        if (!ot.ok) return send(res, 401, { ok: false, error: ot.error });

        // 双系统状态查询
        if (req.method === 'GET' && url.pathname === '/api/ops/dual-system/status') {
          const deviceId = url.searchParams.get('deviceId') || url.searchParams.get('device_id') || '';
          if (!deviceId) return send(res, 400, { ok: false, error: 'deviceId 必填' });
          const chk = redundancy.canEnableDual(deviceId, store);
          const enabled = redundancy.isEnabled(deviceId);
          const runtime = redundancy.getRuntime(deviceId);
          return send(res, 200, {
            ok: true, deviceId,
            canEnable: chk.ok, licenseType: chk.licenseType, reason: chk.reason,
            dualEnabled: enabled, runtime,
          });
        }
        // 双系统开关
        if (req.method === 'POST' && (url.pathname === '/api/ops/dual-system/enable' || url.pathname === '/api/ops/dual-system/disable')) {
          const body = await readBody(req);
          const deviceId = (body && body.deviceId) || url.searchParams.get('deviceId') || '';
          if (!deviceId) return send(res, 400, { ok: false, error: 'deviceId 必填' });
          const enabled = url.pathname.indexOf('/enable') >= 0;
          // [BUG-R9-01] 可携带 peerMachineId（同一物理机另一框架设备）登记 devicePair
          const peerMachineId = (body && (body.peerMachineId || body.peer_machine_id)) || url.searchParams.get('peerMachineId') || '';
          const r = redundancy.setDualEnabled({ machineId: deviceId, enabled, store, operator: 'device', peerMachineId });
          if (!r.ok) return send(res, 403, { ok: false, error: r.error, licenseType: r.licenseType });
          return send(res, 200, { ok: true, deviceId, dualEnabled: r.dualEnabled });
        }
        // 框架指令轮询（watchdog/bot）
        if (req.method === 'GET' && url.pathname === '/api/ops/framework-cmd') {
          const deviceId = url.searchParams.get('deviceId') || url.searchParams.get('device_id') || '';
          const role = url.searchParams.get('role') || 'watchdog';
          if (!deviceId) return send(res, 400, { ok: false, error: 'deviceId 必填' });
          const cmds = redundancy.pollCommands(deviceId, role);
          return send(res, 200, { ok: true, deviceId, role, commands: cmds });
        }
        // 框架指令请求（qr-server 切换框架按钮用）
        if (req.method === 'POST' && url.pathname === '/api/ops/framework-cmd/request') {
          const body = await readBody(req);
          const deviceId = (body && body.deviceId) || '';
          const action = (body && body.action) || '';
          if (!deviceId) return send(res, 400, { ok: false, error: 'deviceId 必填' });
          // to_sea1/to_sea2 由 watchdog 执行（进程控制）；unblock 由 bot 执行
          const role = action === 'unblock' ? 'bot' : 'watchdog';
          const r = redundancy.enqueueCommand(deviceId, action, (body && body.payload) || {}, { role, operator: 'device' });
          if (!r.ok) return send(res, 400, { ok: false, error: r.error });
          return send(res, 200, { ok: true, command: r.command });
        }
        // 框架指令回执
        if (req.method === 'POST' && url.pathname === '/api/ops/framework-cmd/ack') {
          const body = await readBody(req);
          const deviceId = (body && body.deviceId) || '';
          if (!deviceId) return send(res, 400, { ok: false, error: 'deviceId 必填' });
          const r = redundancy.ackCommand(deviceId, body && body.results);
          return send(res, 200, r);
        }
        // 熔断状态查询
        if (req.method === 'GET' && url.pathname === '/api/ops/circuit-break') {
          const deviceId = url.searchParams.get('deviceId') || url.searchParams.get('device_id') || '';
          if (!deviceId) return send(res, 400, { ok: false, error: 'deviceId 必填' });
          const runtime = redundancy.getRuntime(deviceId);
          return send(res, 200, {
            ok: true, deviceId,
            circuitBroken: !!(runtime && runtime.circuitBroken),
            runtime,
            pendingUnblock: redundancy.hasPendingUnblock(deviceId),
          });
        }
        // 熔断解除（下发 unblock 指令给 bot）
        const cbDel = url.pathname.match(/^\/api\/ops\/circuit-break\/([^/]+)$/);
        if (req.method === 'DELETE' && cbDel) {
          const deviceId = decodeURIComponent(cbDel[1]);
          const r = redundancy.enqueueCommand(deviceId, 'unblock', {}, { role: 'bot', operator: 'device' });
          if (!r.ok) return send(res, 400, { ok: false, error: r.error });
          return send(res, 200, { ok: true, deviceId, command: r.command });
        }
        return send(res, 404, { ok: false, error: '未知运维接口' });
      }

      // ---- 控制台（独立鉴权：支持 ADMIN_TOKEN 超管与 N4 QQ 会话；须在 admin-token 闸门前拦截）----
      // 路径：/api/admin/console/*（控制台自有）、/api/admin/devices*、/api/admin/printers*
      // [sea2] /api/admin/ops/* 运维引擎（CRUD/PM2/强门禁/审计/CUPS meta/绑定纠正，T02 实现）
      // [R4] /api/admin/deploy/* 一键部署（穿透地址 CRUD + git 推送）
      // 这些端点由 consoleApi 自行鉴权，因此必须在该 admin 块之前处理，否则 QQ 会话会被 isAdmin 网关挡掉。
      if (
        url.pathname.startsWith('/api/admin/console/') ||
        url.pathname.startsWith('/api/admin/devices') ||
        url.pathname.startsWith('/api/admin/printers') ||
        url.pathname.startsWith('/api/admin/ops') || // [sea2] 运维引擎前缀转发（鉴权沿用 consoleApi）
        url.pathname.startsWith('/api/admin/fleet') || // [FLEET] 集群管理端点（consoleApi 内自行鉴权）
        url.pathname.startsWith('/api/admin/deploy') || // [R4] 一键部署端点（consoleApi 内自行鉴权）
        // [T2 P2-11] 订单审计写操作（POST/DELETE）转 consoleApi；
        // GET /api/admin/orders（管理员列表）仍保留在下方 admin 块，避免行为变更。
        (url.pathname.startsWith('/api/admin/orders') && req.method !== 'GET')
      ) {
        return consoleApi.handle(req, res, url, cfg, store, keys);
      }

      // ---- 管理：需 admin token ----
      if (url.pathname.startsWith('/api/admin/')) {
        if (!isAdmin) return send(res, 401, { ok: false, error: '需要 admin token' });

        // 新用户试用期配置热更新（admin token）
        if (req.method === 'POST' && url.pathname === '/api/admin/trial/config') {
          const body = await readBody(req);
          const r = trial.updateTrialConfig(store, cfg, body || {});
          if (!r.ok) return send(res, 400, { ok: false, error: r.error });
          // 可选回写 config.env（失败不影响 Store）
          try {
            trial.rewriteConfigEnv(path.join(__dirname, 'config.env'), {
              months: r.config.months, disabled: r.config.disabled,
            });
          } catch (e) { /* 忽略回写失败 */ }
          return send(res, 200, { ok: true, config: r.config });
        }

        // 配置中心：读取全部配置项（admin token）
        if (req.method === 'GET' && url.pathname === '/api/admin/config') {
          const r = configManager.readConfig(cfg, store);
          return send(res, 200, { ok: true, ...r });
        }

        // 配置中心：写入配置项（admin token）
        if (req.method === 'POST' && url.pathname === '/api/admin/config') {
          const body = await readBody(req);
          let r;
          try {
            r = configManager.writeConfig({
              cfg, store, patch: body || {}, envPath: path.join(__dirname, 'config.env'),
            });
          } catch (e) {
            return send(res, 400, { ok: false, error: e.message });
          }
          if (!r.ok) return send(res, 400, { ok: false, error: r.error });
          return send(res, 200, { ok: true, restartRequired: r.restartRequired, changed: r.changed });
        }

        if (req.method === 'POST' && url.pathname === '/api/admin/code') {
          const body = await readBody(req);
          const rec = codes.makeCodeRecord(body);
          store.createCode(rec);
          return send(res, 200, { ok: true, code: rec.code, record: rec });
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/revoke') {
          const body = await readBody(req);
          const rec = store.getCode(body.code);
          if (!rec) return send(res, 404, { ok: false, error: '激活码不存在' });
          store.updateCode(body.code, { status: 'revoked' });
          return send(res, 200, { ok: true, code: body.code, status: 'revoked' });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/codes') {
          return send(res, 200, { ok: true, codes: store.listCodes() });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/licenses') {
          return send(res, 200, { ok: true, licenses: store.listLicenses() });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/publickey') {
          return send(res, 200, { ok: true, publicKey: keys.publicKey });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/export') {
          // 给客户端用的部署物料：公钥 + 服务器地址
          return send(res, 200, { ok: true, publicKey: keys.publicKey, server: `${cfg.host}:${cfg.port}` });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/orders') {
          return send(res, 200, { ok: true, orders: store.listOrders().reverse() });
        }
        // 收件日志查询（管理员专属，与 /api/admin/orders 同级鉴权）：
        // 返回【全部】收到的 webhook 推送（含未匹配），用于排查「接口通不通 / 匹配对没对上」。
        if (req.method === 'GET' && url.pathname === '/api/admin/webhook-logs') {
          let limit = parseInt(url.searchParams.get('limit') || '', 10);
          if (!Number.isFinite(limit) || limit < 1) limit = 5; // 非数字 → 5
          if (limit > 50) limit = 50; // 上限 50
          return send(res, 200, { ok: true, logs: webhookLog.listWebhookLogs(limit) });
        }

        // ---- [R9 R3-3] 双系统开关（运维后台：开启设备列表 / 远程开关 / 熔断查看解除 / 审计）----
        // 双系统开关列表 + 运行时状态 + 审计
        if (req.method === 'GET' && url.pathname === '/api/admin/dual-system') {
          const enabled = redundancy.listEnabled();
          const runtime = redundancy.listRuntime();
          const audit = redundancy.listAudit(20);
          return send(res, 200, { ok: true, enabled, runtime, audit });
        }
        // 远程开关（enable/disable）
        if (req.method === 'POST' && url.pathname === '/api/admin/dual-system') {
          const body = await readBody(req);
          const { deviceId, enabled } = body || {};
          if (!deviceId) return send(res, 400, { ok: false, error: 'deviceId 必填' });
          // [BUG-R9-01] 可携带 peerMachineId（同一物理机另一框架设备）登记 devicePair
          const peerMachineId = (body && (body.peerMachineId || body.peer_machine_id)) || '';
          const r = redundancy.setDualEnabled({ machineId: deviceId, enabled: !!enabled, store, operator: 'admin', peerMachineId });
          if (!r.ok) return send(res, 403, { ok: false, error: r.error, licenseType: r.licenseType });
          return send(res, 200, { ok: true, deviceId, dualEnabled: r.dualEnabled });
        }
        // 熔断状态列表（运维后台查看）
        if (req.method === 'GET' && url.pathname === '/api/admin/dual-system/circuit-break') {
          const breaks = redundancy.listCircuitBreaks();
          const runtime = redundancy.listRuntime();
          return send(res, 200, { ok: true, circuitBreaks: breaks, runtime });
        }
        // 熔断解除（下发 unblock 指令）
        const cbUnblock = url.pathname.match(/^\/api\/admin\/dual-system\/circuit-break\/([^/]+)\/unblock$/);
        if (req.method === 'POST' && cbUnblock) {
          const deviceId = decodeURIComponent(cbUnblock[1]);
          const r = redundancy.enqueueCommand(deviceId, 'unblock', {}, { role: 'bot', operator: 'admin' });
          if (!r.ok) return send(res, 400, { ok: false, error: r.error });
          return send(res, 200, { ok: true, deviceId, command: r.command });
        }
        // 审计查询
        if (req.method === 'GET' && url.pathname === '/api/admin/dual-system/audit') {
          let limit = parseInt(url.searchParams.get('limit') || '', 10);
          if (!Number.isFinite(limit) || limit < 1) limit = 50;
          if (limit > 500) limit = 500;
          return send(res, 200, { ok: true, audit: redundancy.listAudit(limit) });
        }
        return send(res, 404, { ok: false, error: '未知管理接口' });
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, service: 'sea1-activation-server' });
      }

      // ---- 收款码静态图片（公开访问，供用户扫码付款）----
      if (req.method === 'GET' && (url.pathname === '/qr/alipay.jpg' || url.pathname === '/qr/wechat.jpg')) {
        const name = path.basename(url.pathname);
        return serveFile(res, path.join(__dirname, 'public', 'qr', name));
      }

      // ---- 控制台静态页（独立新页，旧 /admin 保留兼容）----
      if (req.method === 'GET' && url.pathname === '/console') {
        return serveFile(res, path.join(__dirname, 'public', 'console.html'));
      }
      // T04 前端多文件拆分：console.css 与所有 console.*.js 模块（i18n/api/admin/pm/cups/highrisk/audit）均需静态服务
      if (req.method === 'GET' && url.pathname.startsWith('/console.') &&
          (/\.css$/.test(url.pathname) || /\.js$/.test(url.pathname))) {
        const base = path.basename(url.pathname);
        return serveFile(res, path.join(__dirname, 'public', base));
      }
      // [R5] 配置中心分组排序纯函数（config-order.js，UMD 双端；文件名不含 console. 前缀故单独路由）
      if (req.method === 'GET' && url.pathname === '/config-order.js') {
        return serveFile(res, path.join(__dirname, 'public', 'config-order.js'));
      }

      // ---- 帮助中心 /docs/* 静态路由（[DOCS] HELP_CENTER_SYSTEM_DESIGN.md §3.4）----
      // 安全规则：decode 含 \0 拒；path.resolve 后必须 startsWith(docsRoot+sep) 否则 403（防 ../ 越权）；
      // 扩展名白名单 .md .json .png .jpg .jpeg .svg .gif .webp .css .js .mermaid .txt 否则 403；
      // 不目录列表、realpath 复核仍在 docsRoot 内。不做 /api/docs/search（索引全量进内存前端检索）。
      if (req.method === 'GET' && url.pathname.startsWith('/docs/')) {
        const docsRoot = path.join(__dirname, 'docs');
        let rel = '';
        try {
          rel = decodeURIComponent(url.pathname.slice('/docs/'.length));
        } catch (e) {
          return send(res, 400, { ok: false, error: 'bad request' });
        }
        if (rel.indexOf('\0') >= 0) return send(res, 400, { ok: false, error: 'bad request' });
        const target = path.resolve(docsRoot, rel);
        if (target !== docsRoot && !target.startsWith(docsRoot + path.sep)) {
          return send(res, 403, { ok: false, error: 'forbidden' });
        }
        const ext = path.extname(target).toLowerCase();
        const DOC_ALLOWED = ['.md', '.json', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.css', '.js', '.mermaid', '.txt'];
        if (!DOC_ALLOWED.includes(ext)) return send(res, 403, { ok: false, error: 'forbidden extension' });
        // 目录列表拒绝
        let st = null;
        try {
          st = fs.statSync(target);
        } catch (e) {
          return send(res, 404, { ok: false, error: 'not found' });
        }
        if (st.isDirectory()) return send(res, 403, { ok: false, error: 'forbidden directory' });
        // realpath 复核：确保未通过符号链接逃逸 docsRoot
        try {
          const real = fs.realpathSync(target);
          if (real !== docsRoot && !real.startsWith(docsRoot + path.sep)) {
            return send(res, 403, { ok: false, error: 'forbidden' });
          }
        } catch (e) {
          return send(res, 404, { ok: false, error: 'not found' });
        }
        const DOC_MIME = { '.md': 'text/markdown; charset=utf-8', '.mermaid': 'text/plain; charset=utf-8' };
        return serveFile(res, target, { contentType: DOC_MIME[ext] || undefined });
      }

      // ---- 旧管理后台静态页 302 重定向到合并控制台（D1：平滑过渡）----
      // /admin → 许可证 Tab；/admin/config → 配置 Tab（前端据 hash 选中对应 Tab）
      if (req.method === 'GET' && url.pathname === '/admin') {
        res.writeHead(302, { Location: '/console#license' });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/admin/config') {
        res.writeHead(302, { Location: '/console#config' });
        return res.end();
      }
      return send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return send(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  };
}

function start(port) {
  const cfg = loadConfig();
  // 收件日志落盘目录（与 orders.json 同目录）
  webhookLog.setDataDir(cfg.dataDir);
  const keys = ensureKeys(cfg);
  const store = new Store(cfg.dataDir);
  const app = makeApp(cfg, keys, store);

  // 预热控制台状态缓存：启动即构建一次，使部署后首个请求也命中热缓存，不再冷跑 pm2 jlist（~1234ms）
  try { require('./lib/console/runtime').getStatus({ cfg, store, keys }); } catch (e) { /* 预热失败不影响启动 */ }

  // 安全告警（启动即强制提示，部署务必替换弱口令/补齐专用 token）
  if (cfg.adminToken === 'changeme-admin-token') {
    console.warn('[activation-server][安全告警] ADMIN_TOKEN 仍为默认弱口令 "changeme-admin-token"！'
      + '请在生产启动环境中设置强 ADMIN_TOKEN，否则管理接口存在被冒用风险。');
  }
  if (!process.env.MONITOR_TOKEN) {
    console.warn('[activation-server][安全告警] 未配置 MONITOR_TOKEN：'
      + '/api/admin/order/confirm 已停用（始终返回 401），await_verify 订单将无法自动核验到账。'
      + '请设置强 MONITOR_TOKEN（与监控器一致）后重启服务。');
  }

  const server = http.createServer(app);
  // [R6 R4] WebSocket 升级路由：/docker-mgr/* 与根 /ws 转发容器管理终端（FastOSDocker 用 ws）
  // 注意：node http.Server 存在 'upgrade' 监听时，升级请求不会走 request 处理器（app），
  // 必须在此显式路由，否则 ws 握手无法正确完成。
  server.on('upgrade', (req, socket, head) => {
    let url = null;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch (e) { url = null; }
    if (url && (url.pathname === '/ws' || url.pathname.startsWith('/docker-mgr/'))) {
      dockerMgrProxy.handleUpgrade(req, socket, head, url, cfg);
    } else {
      try { socket.destroy(); } catch (e) { /* ignore */ }
    }
  });
  // 周期性清理超时未付订单
  const sweepTimer = setInterval(() => {
    try { orders.sweepExpired(store); } catch (e) { /* ignore */ }
  }, 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();

  // 初始化试用配置基线（首次落盘默认配置，保证后续热更新有基线）
  try { trial.getTrialConfig(store, cfg); } catch (e) { /* ignore */ }

  // 新用户试用期巡检：每 15 分钟扫描 active 试用，产出临期/到期提醒队列
  const trialTimer = setInterval(() => {
    try { trial.scanPendingReminders(store, cfg); } catch (e) { /* ignore */ }
  }, 15 * 60 * 1000);
  if (trialTimer.unref) trialTimer.unref();

  // [FLEET] 集群管理定时器：落盘 / 异常扫描 / 指令超时扫描（全部热读阈值，无需重启）
  const fsInstance = fleetStore.getInstance(cfg.dataDir);
  fsInstance.setFlushMs(fleetConfig.get('fleetFlushMs'));
  const fleetFlushTimer = setInterval(() => {
    try { fsInstance.flush(); } catch (e) { /* ignore */ }
  }, Math.max(1000, fleetConfig.get('fleetFlushMs')));
  if (fleetFlushTimer.unref) fleetFlushTimer.unref();

  const fleetScanTimer = setInterval(() => {
    try { anomaly.scan(store, fsInstance, cfg); } catch (e) { /* ignore */ }
  }, Math.max(5000, fleetConfig.get('fleetScanInterval') * 1000));
  if (fleetScanTimer.unref) fleetScanTimer.unref();

  const fleetTimeoutTimer = setInterval(() => {
    try { fsInstance.timeoutScan(Math.floor(Date.now() / 1000)); } catch (e) { /* ignore */ }
  }, Math.max(5000, fleetConfig.get('fleetHeartbeatInterval') * 1000));
  if (fleetTimeoutTimer.unref) fleetTimeoutTimer.unref();

  return new Promise((resolve) => {
    const bindPort = (port === undefined) ? cfg.port : port; // 0 = 系统随机端口
    server.listen(bindPort, cfg.host, () => {
      console.log(`[activation-server] listening on ${cfg.host}:${bindPort}`);
      console.log(`[activation-server] data dir: ${cfg.dataDir}`);
      console.log(`[activation-server] trial days: ${cfg.trialDays}, payment mode: ${cfg.paymentMode}`);
      console.log(`[activation-server] public key export: GET /api/admin/publickey (admin token required)`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
}

module.exports = { start, loadConfig, ensureKeys, makeApp, verifyOpsToken, verifyMonitorToken };
