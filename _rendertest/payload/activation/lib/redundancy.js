'use strict';
/**
 * lib/redundancy.js — [R9 R3-3/R3-4] 双系统开关 + 仲裁 + 审计记录 + 框架指令通道
 *
 * 职责（架构师 R9 设计 T05）：
 *  - canEnableDual(machineId)：校验服务端授权 license=lifetime（永久）才允许开启双系统；
 *  - setDualEnabled / listEnabled：双系统开关持久化（data/dual-system.json）；
 *  - logAudit / listAudit：审计落库（data/dual-system-audit.jsonl，追加式）；
 *  - 框架指令通道（data/framework-commands.jsonl）：
 *      enqueueCommand(deviceId, action, payload)   —— 下发 to_sea1 / to_sea2 / unblock
 *      pollCommands(deviceId, role)                —— watchdog/bot 轮询（未 ack；按 role 过滤防双执行）
 *      ackCommand(deviceId, results)               —— 回执落库
 *  - 运行时状态（data/dual-runtime.json）：心跳富化（channel / channelState / circuitBroken），
 *    供熔断查看接口与运维后台。
 *
 * 设计要点：
 *  - 全部文件原子写（tmp+rename），进程内缓存 + 每次落盘；
 *  - 零新增 npm 依赖：node:fs / node:path；
 *  - 纯函数可测（DATA_DIR 注入临时目录）。
 */

const fs = require('node:fs');
const path = require('node:path');

let _dataDirOverride = null;

/** 仅测试/特殊场景：指定数据目录（显式覆盖） */
function setDataDir(dir) {
  _dataDirOverride = dir;
}

/** 数据目录：显式覆盖 > 进程 env（懒读，兼容 require 后才设置 DATA_DIR 的场景）> 默认 */
function dataDir() {
  return _dataDirOverride || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

function file(name) {
  return path.join(dataDir(), name);
}

function readJson(name, dflt) {
  try {
    const raw = fs.readFileSync(file(name), 'utf8');
    const o = JSON.parse(raw);
    return Object.assign({}, dflt, o);
  } catch (e) {
    return Object.assign({}, dflt);
  }
}

function readJsonArray(name) {
  try {
    const raw = fs.readFileSync(file(name), 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch (e) { /* skip bad line */ }
    }
    return out;
  } catch (e) {
    return [];
  }
}

function writeJsonAtomic(name, obj) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file(name));
  } catch (e) {
    // best-effort
  }
}

function appendJsonLine(name, obj) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(file(name), JSON.stringify(obj) + '\n');
  } catch (e) {
    // best-effort
  }
}

function nowIso() {
  return new Date().toISOString();
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 是否为永久(lifetime)授权。
 * [ENG-6] 仅显式 expires_at===0 或 '0'（签发永久码 durationDays=0 → 0）或 features 含 lifetime/永久 判永久；
 * expires_at 缺失/null/undefined → 按非永久（term）处理（fail-closed，防 term 码缺字段被放行开双系统）。
 */
function isLifetimeCode(rec) {
  if (!rec) return false;
  const ex = rec.expires_at;
  if (ex === 0 || ex === '0') return true; // 显式永久
  // ex == null（undefined/null/''）：不判永久（ENG-6 fail-closed）
  if (ex == null || ex === '') return false;
  try {
    const feats = JSON.stringify(rec.features || []).toLowerCase();
    if (/(lifetime|permanent|永久)/.test(feats)) return true;
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * 绑定判定：bound_machine_id 与 machineId 是否匹配（与激活/心跳绑定判定同口径的前缀匹配）。
 * 背景（生产实锤）：激活码 bound_machine_id 存的是机器码前缀（如 20 位），
 * 设备心跳上报完整机器码（如 64 位 HMAC-SHA256 派生值，以 bound 为前缀），
 * 因此不能再用精确相等，否则双系统开关会误判「设备未激活」。
 * 规则（稳妥实现，两值都须非空，避免 '' .startsWith('') 误匹配）：
 *  - 精确相等 → 匹配；
 *  - machineId 以 bound_machine_id 为前缀 → 匹配（bound 是 20 位前缀，machineId 是 64 位完整值）；
 *  - bound_machine_id 以 machineId 为前缀 → 匹配（反向，防机器码长度变化/截断）。
 * @param {*} boundMachineId 激活码绑定的机器码（可为空/undefined/null）
 * @param {*} machineId 设备上报机器码（可为空/undefined/null）
 * @returns {boolean}
 */
function isBoundMatch(boundMachineId, machineId) {
  const b = boundMachineId == null ? '' : String(boundMachineId);
  const m = machineId == null ? '' : String(machineId);
  if (!b || !m) return false;
  return b === m || m.startsWith(b) || b.startsWith(m);
}

/**
 * 查询某设备的授权类型（用于双系统开关校验）。
 * 查找逻辑：store.listCodes() 中 status=active 且 bound_machine_id 与 machineId
 * 前缀匹配（isBoundMatch，精确相等或互为前缀）的激活码。
 * 返回 {active, lifetime, code, expires_at}：
 *  - active=false  → 未激活（不能开双系统）
 *  - active=true, lifetime=false → 非永久授权（不能开双系统）
 * @param {string} machineId 设备机器码
 * @param {object} store Store 实例（含 listCodes）
 * @returns {{active:boolean, lifetime:boolean, code:string, expires_at:number}}
 */
function queryLicenseType(machineId, store) {
  const out = { active: false, lifetime: false, code: '', expires_at: 0 };
  if (!machineId || !store || typeof store.listCodes !== 'function') return out;
  const rec = (store.listCodes() || []).find((c) => c && c.status === 'active' && isBoundMatch(c.bound_machine_id, machineId));
  if (!rec) return out;
  out.active = true;
  out.code = rec.code;
  out.expires_at = (rec.expires_at === undefined || rec.expires_at === null) ? null : rec.expires_at; // [ENG-6] 保留原始值，不吞缺字段
  out.lifetime = isLifetimeCode(rec);
  return out;
}

/**
 * 是否允许开启双系统：必须已激活且为永久授权。
 * @returns {{ok:boolean, licenseType:string, reason:string, active:boolean, lifetime:boolean}}
 */
function canEnableDual(machineId, store) {
  const t = queryLicenseType(machineId, store);
  if (!t.active) return { ok: false, licenseType: 'none', reason: '设备未激活，无法开启双系统', ...t };
  if (!t.lifetime) return { ok: false, licenseType: 'term', reason: '仅永久授权可开启双系统（当前为非永久授权）', ...t };
  return { ok: true, licenseType: 'lifetime', reason: '永久授权，允许开启双系统', ...t };
}

/** 读取双系统开启设备列表 */
function listEnabled() {
  const o = readJson('dual-system.json', { enabled: [] });
  return Array.isArray(o.enabled) ? o.enabled : [];
}

function isEnabled(machineId) {
  return listEnabled().some((e) => String(e.machineId) === String(machineId));
}

/**
 * 读取双系统设备对（devicePair）列表。
 * 记录：{primary, secondary, enabled, operator, at, tsSec}
 * 语义：同一物理机上的主/副框架设备（如 sea2 主 + sea1 副）共用同一激活码，
 *       是 code_shared 豁免（BUG-R9-01）的依据：涉及设备都在同一 pair 内 → 不误报。
 * @returns {Array<object>}
 */
function listPairs() {
  const o = readJson('dual-system.json', { enabled: [], pairs: [] });
  return Array.isArray(o.pairs) ? o.pairs : [];
}

/**
 * 查找某设备所属的双系统设备对。
 * @param {string} machineId 设备机器码
 * @returns {object|null} pair 记录（{primary, secondary, enabled, ...}）或 null
 */
function findPair(machineId) {
  const id = String(machineId || '');
  if (!id) return null;
  return listPairs().find((p) => p && (String(p.primary) === id || String(p.secondary) === id)) || null;
}

/**
 * 判断两台设备是否为同一双系统对（同一物理机主/副框架）。
 * @param {string} a 设备 A 机器码
 * @param {string} b 设备 B 机器码
 * @returns {boolean}
 */
function isDualPair(a, b) {
  const p = findPair(a);
  if (!p) return false;
  return String(p.primary) === String(b) || String(p.secondary) === String(b);
}

/**
 * 设置双系统开关（持久化 + 审计）。
 * @param {object} opts {machineId, enabled, store, operator, peerMachineId?}
 *   peerMachineId：同一物理机的另一框架设备机器码（如 sea1 老框架）；开启时登记 devicePair，
 *   供 code_shared 豁免（BUG-R9-01）使用。
 * @returns {{ok:boolean, dualEnabled:boolean, error?:string, licenseType?:string}}
 */
function setDualEnabled(opts) {
  const { machineId, enabled, store } = opts;
  const operator = opts.operator || 'system';
  const peerMachineId = String(opts.peerMachineId || '').trim();
  if (!machineId) return { ok: false, error: 'machineId 必填' };
  if (enabled) {
    const chk = canEnableDual(machineId, store);
    if (!chk.ok) return { ok: false, error: chk.reason, licenseType: chk.licenseType };
  }
  const cur = readJson('dual-system.json', { enabled: [], pairs: [] });
  const list = Array.isArray(cur.enabled) ? cur.enabled : [];
  const pairs = Array.isArray(cur.pairs) ? cur.pairs : [];
  const idx = list.findIndex((e) => String(e.machineId) === String(machineId));
  const now = nowIso();
  const rec = {
    machineId: String(machineId),
    enabled: !!enabled,
    operator,
    at: now,
    tsSec: nowSec(),
  };
  if (enabled) {
    if (idx >= 0) list[idx] = Object.assign({}, list[idx], rec);
    else list.push(rec);
    // [BUG-R9-01] 开启双系统时登记 devicePair（主设备=当前设备，副设备=peer）
    if (peerMachineId && String(peerMachineId) !== String(machineId)) {
      const pIdx = pairs.findIndex((p) => p && (
        String(p.primary) === String(machineId) || String(p.secondary) === String(machineId) ||
        String(p.primary) === String(peerMachineId) || String(p.secondary) === String(peerMachineId)
      ));
      const pairRec = {
        primary: String(machineId),
        secondary: String(peerMachineId),
        enabled: true,
        operator,
        at: now,
        tsSec: nowSec(),
      };
      if (pIdx >= 0) pairs[pIdx] = Object.assign({}, pairs[pIdx], pairRec);
      else pairs.push(pairRec);
    }
  } else {
    if (idx >= 0) list.splice(idx, 1);
    // 关闭时保留 pair 但标记 enabled:false（供审计回溯；豁免判定只看 enabled 的 pair）
    for (const p of pairs) {
      if (p && (String(p.primary) === String(machineId) || String(p.secondary) === String(machineId))) p.enabled = false;
    }
  }
  writeJsonAtomic('dual-system.json', { enabled: list, pairs, updatedAt: now });
  logAudit(Object.assign(
    { action: enabled ? 'dual-enable' : 'dual-disable', machineId, operator, ok: true },
    peerMachineId ? { peerMachineId } : {}
  ));
  return { ok: true, dualEnabled: !!enabled, licenseType: enabled ? 'lifetime' : undefined };
}

/** 审计落库（追加式 JSONL） */
function logAudit(entry) {
  const rec = Object.assign({}, entry || {});
  rec.ts = nowIso();
  rec.tsSec = nowSec();
  rec.id = rec.id || ('dual-' + nowSec() + '-' + Math.random().toString(16).slice(2, 8));
  appendJsonLine('dual-system-audit.jsonl', rec);
  return rec;
}

/** 读取审计（倒序） */
function listAudit(limit) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return readJsonArray('dual-system-audit.jsonl').reverse().slice(0, n);
}

// ================= 框架指令通道（watchdog / bot 轮询） =================
// 记录格式：{id, deviceId, action, payload, role, status:'pending'|'acked'|'failed',
//            createdAt, ackedAt, error, result}

function enqueueCommand(deviceId, action, payload, opts) {
  const role = (opts && opts.role) || 'watchdog';
  if (!deviceId) return { ok: false, error: 'deviceId 必填' };
  const actionOk = ['to_sea1', 'to_sea2', 'unblock'].indexOf(action) >= 0;
  if (!actionOk) return { ok: false, error: '未知指令: ' + action };
  const rec = {
    id: 'fwc-' + nowSec() + '-' + Math.random().toString(16).slice(2, 8),
    deviceId: String(deviceId),
    action,
    payload: payload || {},
    role,
    status: 'pending',
    createdAt: nowIso(),
    tsSec: nowSec(),
  };
  appendJsonLine('framework-commands.jsonl', rec);
  logAudit({ action: 'framework-cmd:' + action, machineId: deviceId, operator: (opts && opts.operator) || 'system', ok: true, cmdId: rec.id });
  return { ok: true, command: rec };
}

/** 轮询未处理指令（pending 且未 ack）；按 role 过滤防 watchdog/bot 双执行 */
function pollCommands(deviceId, role) {
  const items = readJsonArray('framework-commands.jsonl');
  return items.filter((c) => c.status === 'pending' && String(c.deviceId) === String(deviceId) && c.role === (role || 'watchdog'));
}

/** 是否有未 ack 的 unblock 指令（bot 轮询用） */
function hasPendingUnblock(deviceId) {
  return pollCommands(deviceId, 'bot').some((c) => c.action === 'unblock');
}

/**
 * 回执落库：把 results 中每条 {id, ok, error?, result?} 对应记录置为 acked/failed。
 * @returns {{ok:boolean, acked:number, failed:number, unknown:string[]}}
 */
function ackCommand(deviceId, results) {
  const items = readJsonArray('framework-commands.jsonl');
  const map = {};
  const acked = [];
  const failed = [];
  const unknown = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !r.id) continue;
    map[String(r.id)] = r;
  }
  for (const c of items) {
    if (String(c.deviceId) !== String(deviceId)) continue;
    const r = map[c.id];
    if (!r) continue;
    if (r.ok) {
      c.status = 'acked';
      c.ackedAt = nowIso();
      c.result = r.result || null;
      acked.push(c.id);
    } else {
      c.status = 'failed';
      c.ackedAt = nowIso();
      c.error = String(r.error || 'unknown');
      failed.push(c.id);
    }
  }
  // 重写整文件（保留所有记录）
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = file('framework-commands.jsonl') + '.tmp';
    fs.writeFileSync(tmp, items.map((c) => JSON.stringify(c)).join('\n') + '\n');
    fs.renameSync(tmp, file('framework-commands.jsonl'));
  } catch (e) { /* best-effort */ }
  for (const id of Object.keys(map)) {
    if (!items.some((c) => c.id === id)) unknown.push(id);
  }
  return { ok: true, acked: acked.length, failed: failed.length, unknown };
}

// ================= 运行时状态（心跳富化） =================
// 记录：{machineId, channel, channelState, circuitBroken, circuitBrokenSince, ts, tsSec, mainOnline, backupOnline}

function recordRuntime(machineId, meta) {
  const cur = readJson('dual-runtime.json', { devices: {} });
  const devices = cur.devices || {};
  const prev = devices[String(machineId)] || {};
  devices[String(machineId)] = Object.assign({}, prev, meta || {}, {
    machineId: String(machineId),
    ts: nowIso(),
    tsSec: nowSec(),
  });
  writeJsonAtomic('dual-runtime.json', { devices, updatedAt: nowIso() });
  return devices[String(machineId)];
}

function getRuntime(machineId) {
  const cur = readJson('dual-runtime.json', { devices: {} });
  return (cur.devices || {})[String(machineId)] || null;
}

function listRuntime() {
  const cur = readJson('dual-runtime.json', { devices: {} });
  const devices = cur.devices || {};
  return Object.keys(devices).map((k) => devices[k]);
}

/** 熔断状态设备列表（熔断中或最近熔断过） */
function listCircuitBreaks() {
  return listRuntime().filter((d) => d.circuitBroken === true);
}

module.exports = {
  setDataDir,
  isLifetimeCode,
  isBoundMatch,
  queryLicenseType,
  canEnableDual,
  listEnabled,
  isEnabled,
  setDualEnabled,
  logAudit,
  listAudit,
  // [BUG-R9-01] devicePair 双系统设备对（code_shared 豁免依据）
  listPairs,
  findPair,
  isDualPair,
  enqueueCommand,
  pollCommands,
  hasPendingUnblock,
  ackCommand,
  recordRuntime,
  getRuntime,
  listRuntime,
  listCircuitBreaks,
};
