'use strict';
/**
 * sea2 fleet-client —— SEA2 双系统客户端代理（运维中心集群成员）
 *
 * 职责（三件）：
 *   1. 激活：领码 → /api/activate；无码则走设备维度试用（/api/trial/status + trial:true）
 *   2. 心跳：30s 一次，v2 协议携带 platform/arch/hostname/pm2_processes/cups/login_info
 *   3. 指令：解析心跳响应里的 resp.commands → 本地执行 → 下次心跳带 ack_results 回传
 *
 * [2026-09-10 集群统一管理改造]
 *   · 旧实现只发心跳、不消费指令 → 运维中心点任何"远程指令"都石沉大海（指令停在 sent 直到超时）。
 *     现接入 command-handler.js（契约对齐服务端 lib/fleetCommands.js 的 19 条 action）。
 *   · 版本硬编码 'sea1-x86-client-1.0.0' → 集群页"系统版本"永远显示老 sea1。
 *     现从 /root/sea2/VERSION 自动识别为 'sea2-dual-<版本>'，并上报 platform='sea2-dual'。
 *
 * [2026-09-09 全新环境修复（保留）]
 *   1) 无 code 时必须显式 trial:true，否则中央 400 trial-required → 设备不入集群页。
 *   2) 领码客户号必须每机唯一（x86-<machine_id 前16位>），否则第二台必 409「已绑定其他设备」；
 *      撞车时自动走 /api/admin/ops/binding 换绑，仍失败则清码回落试用。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const handler = require('./command-handler');

const SERVER = process.env.SEA1_ACTIVATION_URL || 'http://127.0.0.1:3457';
const SEA2_DIR = process.env.SEA2_DIR || '/root/sea2';
const ADMIN_TOKEN_FILE = '/etc/sea1-x86/admin-token';

function loadAdminToken() {
  const envTok = (process.env.SEA1_ADMIN_TOKEN || '').trim();
  if (envTok) return envTok;
  // 免重装补给：运维把令牌写进文件即可（chmod 600），无需把明文塞进 pm2 env / 命令行
  try {
    if (fs.existsSync(ADMIN_TOKEN_FILE)) return fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
  } catch (e) { /* 读取失败按无令牌处理 */ }
  return '';
}
const ADMIN_TOKEN = loadAdminToken();

// 专用机器码文件：/etc/sea1-x86/machine-id（内容为激活绑定的 64 位机器码，直接使用；
// 兼容旧版 UUID 内容 → HMAC 派生）。回退读取 /etc/sea1/machine-id（**只读**，
// 那是 sea1 bot 自身的授权机器码，改写会导致 bot 授权失配）。
const MACHINE_ID_PATH_X86 = '/etc/sea1-x86/machine-id';
const MACHINE_ID_PATH = '/etc/sea1/machine-id';
const CODE_PATH = '/etc/sea1-x86/client-code';

// ---------------------------------------------------------------------------
// 版本自动识别：不再硬编码（否则集群页"系统版本"永远停留在老 sea1）
// ---------------------------------------------------------------------------
function detectVersion() {
  const files = [path.join(SEA2_DIR, 'VERSION'), path.join(SEA2_DIR, 'version.txt')];
  for (const f of files) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) return 'sea2-dual-' + v;
    } catch (e) { /* 继续尝试下一个来源 */ }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SEA2_DIR, 'package.json'), 'utf8'));
    // 仅当包名/版本已表明是 sea2 时才采用，避免沿用旧 sea1 的 1.0.0
    if (pkg && pkg.name === 'sea2-dual' && pkg.version) return 'sea2-dual-' + pkg.version;
  } catch (e) { /* ignore */ }
  return 'sea2-dual';
}
const VERSION = detectVersion();
// 系统标识：集群页"系统"列据此显示为 SEA2 双系统（旧客户端上报的 os.platform() 无从区分代际）
const PLATFORM = 'sea2-dual';
const REGION = process.env.SEA2_FLEET_REGION || 'cn-east';

// 与 bot(licensing/lib/machineId.js) 完全一致：HMAC_SHA256(persistent, SECRET_SEED)
const SECRET_SEED = 'sea1-machine-seed-v1-replace-in-obfuscated-build';
const BOOT_TIME = Date.now();
// 无 code 时重尝试领码的节流间隔（领取会在中央生成新码，禁止高频刷）
const REGRANT_INTERVAL_MS = 30 * 60 * 1000;
// 心跳周期（服务端指令超时按 2×该值计，故不宜过大）
const HEARTBEAT_MS = 30000;

function getMachineId() {
  // ① 专用文件优先：内容为 64 位 hex → 直接返回；UUID → HMAC 派生
  try {
    if (fs.existsSync(MACHINE_ID_PATH_X86)) {
      const v = fs.readFileSync(MACHINE_ID_PATH_X86, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
      if (v) return crypto.createHmac('sha256', SECRET_SEED).update(v, 'utf8').digest('hex');
    }
  } catch (e) { /* 读取失败回落 */ }
  // ② 回退：bot 持久化 UUID（只读，绝不写 /etc/sea1/machine-id）→ HMAC 派生
  let persistent = '';
  try { if (fs.existsSync(MACHINE_ID_PATH)) persistent = fs.readFileSync(MACHINE_ID_PATH, 'utf8').trim(); } catch (e) { persistent = ''; }
  if (!persistent) {
    persistent = crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(MACHINE_ID_PATH_X86), { recursive: true });
      fs.writeFileSync(MACHINE_ID_PATH_X86, persistent, { mode: 0o600 });
    } catch (e) { /* 写失败忽略 */ }
  }
  return crypto.createHmac('sha256', SECRET_SEED).update(persistent, 'utf8').digest('hex');
}
function getCode() {
  if (fs.existsSync(CODE_PATH)) return fs.readFileSync(CODE_PATH, 'utf8').trim();
  return null;
}
function saveCode(code) {
  try {
    fs.mkdirSync(path.dirname(CODE_PATH), { recursive: true });
    fs.writeFileSync(CODE_PATH, code, { mode: 0o600 });
  } catch (e) { console.log('[sea2-fleet] 保存 code 失败', e.message); }
}
function dropCode() {
  try { fs.unlinkSync(CODE_PATH); } catch (e) { /* 不存在或无权，忽略 */ }
}
function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + p);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, timeout: 25000,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('timeout', () => { r.destroy(); reject(new Error('request timeout')); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/**
 * 领码所用客户号：必须"每机唯一"。
 * 中央 orders.js 会按 qq 反查历史机器并对新码预绑（_resolveMachineId），若多台机器共用
 * 一个客户号，第二台起必然拿到"已绑别机"的码 → /api/activate 409。故默认 x86-<machine_id 前16位>。
 * 需要把机器挂到某个真实客户名下时，用 SEA2_FLEET_CUSTOMER 显式指定（后果自负：同号多机会互斥）。
 */
function customerOf(mid) {
  const override = (process.env.SEA2_FLEET_CUSTOMER || '').trim();
  return override || ('x86-' + String(mid).slice(0, 16));
}
async function grantCode(mid) {
  if (!ADMIN_TOKEN) return null; // 无运维令牌：不尝试，直接走试用
  try {
    const r = await req('POST', '/api/admin/console/grant', { qq: customerOf(mid), plan: 'quarter' }, { 'x-admin-token': ADMIN_TOKEN });
    const j = JSON.parse(r.body || '{}');
    return j.code || (j.data && j.data.code) || null;
  } catch (e) {
    console.log('[sea2-fleet] grant err', e.message);
    return null;
  }
}
// 换绑：把已签发但绑定在别机的码改绑到本机（需 L3 运维令牌）
async function rebind(code, mid) {
  try {
    const r = await req('POST', '/api/admin/ops/binding', { code, machineId: mid }, { 'x-admin-token': ADMIN_TOKEN });
    const j = JSON.parse(r.body || '{}');
    if (r.status === 200 && j.ok === true) return true;
    console.log('[sea2-fleet] 换绑失败 status=%s body=%s', r.status, (r.body || '').slice(0, 200));
    return false;
  } catch (e) {
    console.log('[sea2-fleet] 换绑异常', e.message);
    return false;
  }
}
// 设备维度试用注册（查询即授予，中央公开端点）
async function registerTrial(mid) {
  try {
    const r = await req('POST', '/api/trial/status', { machine_id: mid });
    const j = JSON.parse(r.body || '{}');
    return j.ok === true;
  } catch (e) {
    console.log('[sea2-fleet] trial 注册失败', e.message);
    return false;
  }
}
async function activate(mid, code) {
  return req('POST', '/api/activate', { machine_id: mid, code });
}
function activateOk(resp) {
  if (!resp || resp.status !== 200) return false;
  try { return JSON.parse(resp.body || '{}').ok === true; } catch (e) { return false; }
}
function looksBoundElsewhere(resp) {
  if (!resp) return false;
  if (resp.status === 409) return true;
  return /已绑定其他设备/.test(resp.body || '');
}

// ---------------------------------------------------------------------------
// 心跳载荷（v2：与中央 fleetStore.recordHeartbeat 的字段契约一一对应）
// ---------------------------------------------------------------------------
async function collectEnrich() {
  const [pm2, cups, login] = await Promise.all([
    handler.collectPm2().catch(() => []),
    handler.collectCups().catch(() => ({ running: false, printers: [] })),
    handler.collectLoginInfo().catch(() => ({ qq: '', nickname: '', avatar: '', remembered: false, loggedIn: false })),
  ]);
  return { pm2, cups, login };
}

function buildPayload(mid, code, enrich, acks) {
  const e = enrich || { pm2: [], cups: { running: false, printers: [] }, login: {} };
  const base = {
    machine_id: mid,
    nonce: crypto.randomBytes(8).toString('hex'),
    online: true,
    // —— 身份/版本（自动识别 SEA2 双系统，不再写死 sea1-x86-client）——
    version: VERSION,
    platform: PLATFORM,
    arch: os.arch(),
    hostname: os.hostname(),
    region: REGION,
    public_ip: '',
    cpu_usage: handler.cpuUsagePercent(),
    mem_usage: handler.memUsagePercent(),
    boot_time: BOOT_TIME,
    client_ts: Date.now(),
    // 打印机清单取自真实 CUPS（旧实现是硬编码假数据）
    printers: (e.cups && Array.isArray(e.cups.printers) ? e.cups.printers : [])
      .map((p) => ({ name: p.name, status: p.enabled === false ? 'disabled' : p.state }))
      .slice(0, 32),
    // —— sea2 心跳 v2（samples §3.2，服务端按 snake_case 解析）——
    heartbeat_proto: 2,
    commands_proto: 2,
    pm2_processes: e.pm2 || [],
    cups: e.cups || { running: false, printers: [] },
    login_info: e.login || {},
  };
  // 待回执的指令结果（服务端优先处理 ack_results）
  if (Array.isArray(acks) && acks.length) base.ack_results = acks.slice(0, 20);
  // 无 code → 试用心跳（中央要求 body.trial === true，否则 400 trial-required）
  return code ? Object.assign(base, { code }) : Object.assign(base, { trial: true });
}

// ---------------------------------------------------------------------------
// 指令执行 + 回执
// ---------------------------------------------------------------------------
async function handleCommands(mid, code, enrich, cmds) {
  const defers = [];
  const acks = [];
  for (const c of cmds.slice(0, 20)) {
    if (!c || !c.id || !c.action) continue;
    const t0 = Date.now();
    let res;
    try {
      res = await handler.execute(c.action, Object.assign({}, c.payload || {}, { __commandId: c.id }));
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    acks.push({
      id: String(c.id),
      ok: !!res.ok,
      error: res.ok ? undefined : String(res.error || 'failed').slice(0, 2000),
      result: res.result === undefined ? undefined : res.result,
    });
    if (typeof res._defer === 'function') defers.push(res._defer);
    console.log('[sea2-fleet] 指令 %s → %s (%dms)', c.action,
      res.ok ? 'ok' : ('fail: ' + String(res.error || '').slice(0, 80)), Date.now() - t0);
  }

  if (acks.length) {
    // 先落盘：即便本进程随后被重启（restart_client），回执也不会丢
    const q = handler.loadPendingAcks().concat(acks);
    handler.savePendingAcks(q);
    // 立即补发一次心跳（带 ack），不等下一个 30s 周期 —— 降低服务端指令超时概率
    try {
      const r2 = await req('POST', '/api/heartbeat', buildPayload(mid, code, enrich, q));
      if (r2.status === 200) handler.savePendingAcks([]);
      else console.log('[sea2-fleet] ack 补发未成功 status=%s（下次心跳重试）', r2.status);
    } catch (e) {
      console.log('[sea2-fleet] ack 补发失败 %s（下次心跳重试）', e.message);
    }
  }

  // 延迟动作（可能重启本进程）放最后：回执已送达才执行
  for (const d of defers) {
    try { await d(); } catch (e) { console.log('[sea2-fleet] defer 执行失败', e.message); }
  }
}

/** 一次完整心跳：采集 → 上报（带待回执）→ 处理下发指令 */
async function beat(mid, code) {
  const enrich = await collectEnrich();
  const acks = handler.loadPendingAcks();
  const r = await req('POST', '/api/heartbeat', buildPayload(mid, code, enrich, acks));
  let j = {};
  try { j = JSON.parse(r.body || '{}'); } catch (e) { /* 非 JSON 响应 */ }
  if (r.status === 200 && acks.length) handler.savePendingAcks([]);
  if (Array.isArray(j.commands) && j.commands.length) {
    console.log('[sea2-fleet] 收到 %d 条远程指令', j.commands.length);
    await handleCommands(mid, code, enrich, j.commands);
  }
  return { r, j };
}

/** 领码 → 激活；撞上"已绑别机"时自动换绑重试一次；彻底失败则清码回落试用 */
async function ensureCode(mid) {
  let code = getCode();
  if (!code) {
    code = await grantCode(mid);
    if (code) saveCode(code);
  }
  if (!code) return null;

  let a = await activate(mid, code).catch((e) => ({ status: 0, body: e.message }));
  if (!activateOk(a) && looksBoundElsewhere(a)) {
    console.log('[sea2-fleet] code=%s 已绑定其他设备 → 尝试运维换绑到本机', code);
    if (ADMIN_TOKEN && (await rebind(code, mid))) {
      a = await activate(mid, code).catch((e) => ({ status: 0, body: e.message }));
      if (activateOk(a)) console.log('[sea2-fleet] 换绑后激活成功');
    }
  }
  if (!activateOk(a)) {
    console.log('[sea2-fleet] 激活失败 status=%s body=%s → 清除该码并以设备试用运行',
      a && a.status, ((a && a.body) || '').slice(0, 200));
    dropCode();
    return null;
  }
  console.log('[sea2-fleet] activate status=%s', a.status);
  return code;
}

(async () => {
  const mid = getMachineId();
  let code = await ensureCode(mid);
  if (code) {
    console.log('[sea2-fleet] machine_id=%s code=%s customer=%s', mid, code, customerOf(mid));
  } else {
    const ok = await registerTrial(mid);
    console.log('[sea2-fleet] 无可用授权码（全新环境/未提供 SEA1_ADMIN_TOKEN）→ 设备维度试用注册%s；machine_id=%s',
      ok ? '成功' : '失败', mid);
  }
  console.log('[sea2-fleet] 版本=%s 系统=%s 架构=%s 主机=%s 指令集=%d 条',
    VERSION, PLATFORM, os.arch(), os.hostname(), handler.ACTIONS.length);

  const first = await beat(mid, code).catch((e) => { console.log('[sea2-fleet] 首次心跳异常 %s', e.message); return null; });
  if (first) {
    console.log('[sea2-fleet] 首次心跳 status=%s valid=%s reason=%s',
      first.r.status, first.j.valid, first.j.reason);
  }

  let lastGrantTry = Date.now();
  setInterval(async () => {
    try {
      // 试用态下节流重尝试领码（运维中心补发令牌后无需重启即可升正式）
      if (!code && ADMIN_TOKEN && Date.now() - lastGrantTry > REGRANT_INTERVAL_MS) {
        lastGrantTry = Date.now();
        const c2 = await ensureCode(mid);
        if (c2) { code = c2; console.log('[sea2-fleet] 已升级为正式授权 code=%s', code); }
      }
      const { r, j } = await beat(mid, code);
      console.log('[sea2-fleet] heartbeat valid=%s reason=%s status=%s', j.valid, j.reason, r.status);
    } catch (e) {
      console.log('[sea2-fleet] heartbeat err', e.message);
    }
  }, HEARTBEAT_MS);
})();
