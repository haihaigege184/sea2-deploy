'use strict';
/**
 * heartbeat.js — 向激活服务器发送心跳（[FLEET] 富化扩展 + [sea2] 心跳 v2）
 *
 * 相对旧版的变化（向后兼容，旧服务端忽略新增字段）：
 *  - 新增 buildHeartbeatPayload()：富化上报字段
 *      version / cpu_usage / mem_usage / boot_time / platform / arch /
 *      hostname / client_ts / printers[]，以及 ack_id（已执行指令回执）。
 *  - [sea2] 心跳 v2（system_design_sea2_ops_v1.0.md §3.2）：
 *      heartbeatProto=2 / commandsProto=2 协议版本声明；
 *      pm2_processes[]（PM2 进程快照）、cups{}（CUPS 服务状态 + 打印机）、
 *      login_info{}（登录中间页状态）。T03 接入真实采集，T01 默认空值兜底。
 *  - [sea2] 试用心跳（system_design_sea2_ops_v1.0.md §9.4.3）：
 *      buildHeartbeatPayload 支持 code 为空串（试用设备无 license）；
 *      payload 新增 trial（布尔）、trial_info（{active, expired, remaining_ms, end}）。
 *      向后兼容：旧服务端忽略新字段，旧客户端不发新字段，双向兼容（§9 铁律 5）。
 *  - sendHeartbeat() 返回体中新增 commands[]（服务端下发的待执行指令），
 *    交由调用方（LicenseGate）通过 command-handler 执行并回执 ack_id。
 *
 * 约束：零三方依赖；采集失败时字段降级（null/[]），绝不阻断心跳。
 */

const crypto = require('node:crypto');
const { getSysInfo } = require('./sysinfo');
const { getPrinters } = require('./printer-provider');

/** 单次心跳最多携带的回执条数（与服务端 ACK_RESULTS_MAX 对齐，多余的下次再报） */
const ACK_RESULTS_MAX = 20;
/** 单次心跳最多携带的 pm2 进程条数 */
const PM2_PROCESSES_MAX = 100;

/** 归一化 PM2 进程（sea2 心跳 v2，pm2_processes[]） */
function normalizePm2Process(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '');
  if (!name) return null;
  return {
    pm_id: Number.isFinite(p.pm_id) ? p.pm_id : 0,
    name,
    status: String(p.status || 'unknown'),
    restarts: Number.isFinite(p.restarts) ? p.restarts : 0,
    uptime: Number.isFinite(p.uptime) ? p.uptime : 0,
    cpu: Number.isFinite(p.cpu) ? p.cpu : 0,
    mem: Number.isFinite(p.mem) ? p.mem : 0,
  };
}

/** 归一化 CUPS 服务状态（sea2 心跳 v2，cups{}） */
function normalizeCups(cups) {
  if (!cups || typeof cups !== 'object') return { running: false, printers: [] };
  const printers = Array.isArray(cups.printers)
    ? cups.printers.filter((p) => p && p.name).map((p) => ({
      name: String(p.name),
      uri: String(p.uri || ''),
      model: String(p.model || ''),
      driver: String(p.driver || ''),
      state: String(p.state || 'idle'),
      queueCount: Number.isFinite(p.queueCount) ? p.queueCount : 0,
      default: p.default === true,
      enabled: p.enabled !== false,
    }))
    : [];
  return { running: cups.running === true, printers };
}

/** 归一化登录中间页状态（sea2 心跳 v2，login_info{}） */
function normalizeLoginInfo(li) {
  if (!li || typeof li !== 'object') return { qq: '', nickname: '', avatar: '', remembered: false, loggedIn: false };
  return {
    qq: String(li.qq || ''),
    nickname: String(li.nickname || ''),
    avatar: String(li.avatar || ''),
    remembered: li.remembered === true,
    loggedIn: li.loggedIn === true,
  };
}

/**
 * 组装富化心跳上报体。
 * @param {object} params
 * @param {string} params.machineId 机器码
 * @param {string} [params.code]      授权码（可为空串：试用设备无 license，§9.4.3）
 * @param {boolean} [params.trial]    是否试用设备（T03 §9.4.3；true 时携带 trial_info）
 * @param {object} [params.trialInfo] 本地试用状态（_trialStatus() 子集；仅试用期传）
 * @param {string[]} [params.ackIds] 已执行待回执的指令 id 列表（旧通道，兼容用）
 * @param {Array<{id:string, ok:boolean, error?:string, result?:*}>} [params.ackResults]
 *        指令执行结果（新通道，含成败与结果体）
 * @param {object} [params.extra]   额外上下文
 * @param {object} [params.extra.printPlugin] 注入的 PrintPlugin（打印机枚举兜底）
 * @param {string} [params.extra.publicIp]    自报公网 IP（可选，服务端也会从 socket 取）
 * @param {string} [params.extra.region]      自报地域（可选）
 * @param {boolean} [params.extra.online]     是否在线（默认 true）
 * @param {Array} [params.pm2Processes]       PM2 进程快照（sea2 心跳 v2，T03 采集；缺省 []）
 * @param {object} [params.cups]              CUPS 服务状态（sea2 心跳 v2，T03 采集；缺省空）
 * @param {object} [params.loginInfo]         登录中间页状态（sea2 心跳 v2，T03 采集；缺省空）
 * @returns {Promise<object>} 心跳上报体
 */
async function buildHeartbeatPayload(params) {
  const machineId = params.machineId;
  const code = params.code;      // 可为 ''（试用设备），也可为 undefined/缺省（旧调用方）
  const extra = params.extra || {};

  const sysinfo = await getSysInfo();

  let printers = [];
  try {
    printers = await getPrinters({ printPlugin: extra.printPlugin });
  } catch (e) {
    printers = [];
  }

  const payload = {
    machine_id: machineId,
    code,
    nonce: crypto.randomBytes(8).toString('hex'),
    // —— sea2 心跳 v2：协议版本声明（旧服务端忽略；缺省视为 v1 兼容）——
    heartbeatProto: 2,
    commandsProto: 2,
    version: sysinfo.version,
    cpu_usage: sysinfo.cpu_usage,
    mem_usage: sysinfo.mem_usage,
    boot_time: sysinfo.boot_time,
    platform: sysinfo.platform,
    arch: sysinfo.arch,
    hostname: sysinfo.hostname,
    client_ts: Math.floor(Date.now() / 1000),
    printers,
    // —— sea2 心跳 v2：能力上报（T03 接入真实采集；T01 默认空值兜底，绝不伪造）——
    pm2_processes: (Array.isArray(params.pm2Processes) ? params.pm2Processes : [])
      .map(normalizePm2Process).filter(Boolean).slice(0, PM2_PROCESSES_MAX),
    cups: normalizeCups(params.cups),
    login_info: normalizeLoginInfo(params.loginInfo),
    // —— sea2 试用心跳（T03 §9.4.3）：trial 恒为布尔；trial_info 仅试用期携带 ——
    // 旧服务端忽略新字段（向后兼容）；trial=false 的正式心跳不带 trial_info，
    // 避免把「未配置试用」误报成「试用已过期」。
    trial: params.trial === true,
  };

  // 试用设备：附上本地试用状态（协议 §9.4.6：{active, expired, remaining_ms, end}）
  if (params.trial === true && params.trialInfo && typeof params.trialInfo === 'object') {
    const ti = params.trialInfo;
    payload.trial_info = {
      active: ti.active === true,
      expired: ti.expired === true,
      remaining_ms: Number.isFinite(ti.remaining_ms) ? ti.remaining_ms : 0,
      end: Number.isFinite(ti.end) ? ti.end : 0,
    };
  }

  // 回执双通道：
  //   ack_results 是权威结果（含 unsupported/failed 与结果体），新服务端优先消费；
  //   ack_id 只表达「执行过」，保留它是为了让**旧版服务端**仍能收到回执（向后兼容）。
  // 注意 ack_id 只放成功项：旧服务端收到 ack_id 会一律标记 acked，
  // 把失败项也塞进去会让旧服务端误报成功——这正是本次要消灭的「虚假成功」。
  if (Array.isArray(params.ackResults) && params.ackResults.length) {
    payload.ack_results = params.ackResults.slice(0, ACK_RESULTS_MAX);
    const okIds = payload.ack_results.filter((r) => r && r.ok).map((r) => r.id);
    if (okIds.length) payload.ack_id = okIds;
  } else if (Array.isArray(params.ackIds) && params.ackIds.length) {
    payload.ack_id = params.ackIds;
  }
  if (extra.publicIp) payload.public_ip = extra.publicIp;
  if (extra.region) payload.region = extra.region;
  if (typeof extra.online === 'boolean') payload.online = extra.online;

  return payload;
}

/**
 * 发送心跳。
 * @param {string} serverUrl 激活服务地址（自动补齐 /api/heartbeat）
 * @param {object} payload   上报体（通常由 buildHeartbeatPayload 生成）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=8000] 超时
 * @returns {Promise<{ok:boolean, valid:boolean, reason:string, server_time:?number, license:?, commands:Array}>}
 */
async function sendHeartbeat(serverUrl, payload, opts = {}) {
  const url = serverUrl.replace(/\/+$/, '') + '/api/heartbeat';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return {
      ok: r.ok,
      valid: !!j.valid,
      reason: j.reason || 'ok',
      server_time: j.server_time,
      license: j.license,
      commands: Array.isArray(j.commands) ? j.commands : [],
    };
  } catch (e) {
    return { ok: false, valid: false, reason: 'network', commands: [] };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { sendHeartbeat, buildHeartbeatPayload, ACK_RESULTS_MAX };
