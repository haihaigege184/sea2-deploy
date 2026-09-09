'use strict';
/**
 * lib/ops/auditStore.js — 三类审计中心（OpsAuditStore，sea2 运维引擎 M2）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §3.1 / §7.5
 *
 * 三类审计 JSONL（只增不改不删，append-only）：
 *   data/ops-audit-op.jsonl        —— 操作审计（CRUD / PM2 / 绑定纠正等写操作）
 *   data/ops-audit-cmd.jsonl       —— 指令审计（下发回执：签发/推进/终态）
 *   data/ops-audit-highrisk.jsonl  —— 高危审计（强门禁全链路，含前后状态快照）
 *   data/ops-audit-machine.jsonl   —— 机器身份审计（[T2 P2-12] 唯一性风险事件 + 人工合并决策）
 *
 * 安全约束：
 *  - 所有写操作 best-effort 落盘，失败绝不影响主流程（与 console/audit.js 同策略）；
 *  - 高危审计记录必须含 before/after 前后快照（缺一不可，P5）；
 *  - 只增不改不删：不存在覆盖/删除入口。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

/** kind → 文件名（权威映射，防止任意文件写入） */
const KIND_FILE = {
  op: 'ops-audit-op.jsonl',
  cmd: 'ops-audit-cmd.jsonl',
  highrisk: 'ops-audit-highrisk.jsonl',
  machine: 'ops-audit-machine.jsonl', // [T2 P2-12] 机器身份审计
};

/** 合法 kind 列表 */
const KINDS = ['op', 'cmd', 'highrisk', 'machine'];

let _dataDir = DEFAULT_DATA_DIR;
let _auditDir = null;

/** 测试/特殊场景：重设审计目录 */
function setDataDir(dir) {
  _dataDir = dir || DEFAULT_DATA_DIR;
  _auditDir = null;
}

function auditDir() {
  if (!_auditDir) _auditDir = path.join(_dataDir, 'audit');
  return _auditDir;
}

function _fileFor(kind) {
  const k = KIND_FILE[kind];
  return k ? path.join(auditDir(), k) : null;
}

function _append(kind, rec) {
  try {
    const file = _fileFor(kind);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (e) {
    // best-effort：审计失败绝不影响主流程
  }
}

/** 生成审计记录 id（tsSec-hex） */
function genAuditId(tsSec) {
  const crypto = require('node:crypto');
  return `aud-${tsSec}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 写一条操作审计（CRUD / PM2 / 绑定 等写操作）。
 * @param {object} entry
 * @param {string} [entry.operator] 操作人（QQ / super / system）
 * @param {number|string} [entry.operatorLevel] 操作人等级
 * @param {string} entry.action 动作标识（如 crud-create / pm2-restart / binding-correct）
 * @param {string} [entry.entity] 实体（codes/devices/printers/configs/pm2/...）
 * @param {string} [entry.target] 目标 id / 名称
 * @param {*} [entry.before] 变更前值
 * @param {*} [entry.after] 变更后值
 * @param {string} [entry.detail] 附加说明
 * @param {boolean} [entry.ok]
 */
function logOp(entry) {
  entry = entry || {};
  const tsSec = Math.floor(Date.now() / 1000);
  const rec = {
    auditId: genAuditId(tsSec),
    kind: 'op',
    ts: new Date().toISOString(),
    tsSec,
    operator: entry.operator || 'system',
    operatorLevel: entry.operatorLevel != null ? String(entry.operatorLevel) : '',
    action: entry.action || '',
    entity: entry.entity || '',
    target: entry.target != null ? String(entry.target) : '',
    before: entry.before !== undefined ? entry.before : null,
    after: entry.after !== undefined ? entry.after : null,
    detail: entry.detail != null ? String(entry.detail) : '',
    ok: entry.ok !== false,
  };
  _append('op', rec);
  return rec;
}

/**
 * 写一条指令审计（下发/回执推进/终态）。
 * @param {object} entry
 * @param {string} [entry.operator]
 * @param {string} [entry.commandId] 指令 id
 * @param {string} [entry.action] 指令 action（如 format_device / pm2_restart）
 * @param {string} [entry.target] 目标设备 machineId
 * @param {*} [entry.payload] 指令载荷
 * @param {string} [entry.status] 指令状态（pending/sent/acked/failed/...）
 * @param {*} [entry.result] 客户端回传结果
 * @param {string} [entry.error]
 * @param {boolean} [entry.ok]
 */
function logCmd(entry) {
  entry = entry || {};
  const tsSec = Math.floor(Date.now() / 1000);
  const rec = {
    auditId: genAuditId(tsSec),
    kind: 'cmd',
    ts: new Date().toISOString(),
    tsSec,
    operator: entry.operator || 'system',
    operatorLevel: entry.operatorLevel != null ? String(entry.operatorLevel) : '',
    commandId: entry.commandId != null ? String(entry.commandId) : '',
    action: entry.action || '',
    target: entry.target != null ? String(entry.target) : '',
    payload: entry.payload !== undefined ? entry.payload : null,
    status: entry.status != null ? String(entry.status) : '',
    result: entry.result !== undefined ? entry.result : null,
    error: entry.error != null ? String(entry.error) : '',
    ok: entry.ok !== false,
  };
  _append('cmd', rec);
  return rec;
}

/**
 * 写一条高危审计（强门禁全链路）。
 * 必须含 before/after 前后快照（P5：缺一不可）。
 * @param {object} entry 高危记录字段（recordId/machineId/level/confirmChecked/totpChecked/
 *   whitelistChecked/commandId/status/countdownSec/issuedAt/ackedAt/result/before/after/...）
 */
function logHighrisk(entry) {
  entry = entry || {};
  const tsSec = Math.floor(Date.now() / 1000);
  const rec = {
    auditId: genAuditId(tsSec),
    kind: 'highrisk',
    ts: new Date().toISOString(),
    tsSec,
    operator: entry.operator || 'system',
    operatorLevel: entry.operatorLevel != null ? String(entry.operatorLevel) : '',
    recordId: entry.recordId != null ? String(entry.recordId) : '',
    machineId: entry.machineId != null ? String(entry.machineId) : '',
    code: entry.code != null ? String(entry.code) : '',
    level: entry.level != null ? String(entry.level) : 'data',
    confirmWord: entry.confirmWord != null ? String(entry.confirmWord) : '',
    confirmChecked: entry.confirmChecked === true,
    // [R2/R5] 去 TOTP：totpChecked 固定写 false（签名不变；调用方传值忽略，审计口径统一）
    totpChecked: false,
    totpOperator: entry.totpOperator != null ? String(entry.totpOperator) : '',
    whitelistChecked: entry.whitelistChecked === true,
    commandId: entry.commandId != null ? String(entry.commandId) : '',
    status: entry.status != null ? String(entry.status) : 'created',
    countdownSec: Number(entry.countdownSec) || 0,
    issuedAt: Number(entry.issuedAt) || 0,
    ackedAt: Number(entry.ackedAt) || 0,
    result: entry.result !== undefined ? entry.result : null,
    before: entry.before !== undefined ? entry.before : null,
    after: entry.after !== undefined ? entry.after : null,
    detail: entry.detail != null ? String(entry.detail) : '',
    ok: entry.ok !== false,
  };
  _append('highrisk', rec);
  return rec;
}

/**
 * [T2 P2-12] 写一条机器身份审计（唯一性风险事件 / 人工合并决策）。
 * 事件流：
 *  - action='identity-risk'：心跳检测到同 machineId 的 publicIp/hostname 变化（自动记录）；
 *  - action='merge-confirm' / 'merge-ignore'：L3 人工合并决策（确认同一设备 / 强制改绑）。
 * @param {object} entry
 * @param {string} [entry.operator]
 * @param {number|string} [entry.operatorLevel]
 * @param {string} entry.action 'identity-risk' | 'merge-confirm' | 'merge-ignore'
 * @param {string} entry.machineId 目标机器码
 * @param {string} [entry.field] 变化字段（publicIp/hostname/...；合并决策时可空）
 * @param {string} [entry.from] 变化前值
 * @param {string} [entry.to] 变化后值
 * @param {string} [entry.decision] 'same-device' | 'force-rebind'（合并决策时）
 * @param {string} [entry.detail] 附加说明
 * @param {boolean} [entry.ok]
 */
function logMachine(entry) {
  entry = entry || {};
  const tsSec = Math.floor(Date.now() / 1000);
  const rec = {
    auditId: genAuditId(tsSec),
    kind: 'machine',
    ts: new Date().toISOString(),
    tsSec,
    operator: entry.operator || 'system',
    operatorLevel: entry.operatorLevel != null ? String(entry.operatorLevel) : '',
    action: entry.action || '',
    machineId: entry.machineId != null ? String(entry.machineId) : '',
    field: entry.field != null ? String(entry.field) : '',
    from: entry.from != null ? String(entry.from) : '',
    to: entry.to != null ? String(entry.to) : '',
    decision: entry.decision != null ? String(entry.decision) : '',
    detail: entry.detail != null ? String(entry.detail) : '',
    ok: entry.ok !== false,
  };
  _append('machine', rec);
  return rec;
}

/**
 * 检索审计（分页 / 过滤）。
 * @param {string} kind 'op' | 'cmd' | 'highrisk'
 * @param {object} [filter] { page, pageSize, q, fromTs, toTs, action, target, operator, status, mid }
 * @returns {{items:Array, total:number, page:number, pageSize:number}}
 */
function query(kind, filter) {
  filter = filter || {};
  if (KINDS.indexOf(kind) < 0) return { items: [], total: 0, page: 1, pageSize: 0 };
  const file = _fileFor(kind);
  const rows = [];
  if (file && fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
    }
  }
  let items = rows;
  const q = filter.q != null ? String(filter.q).toLowerCase() : '';
  if (q) {
    items = items.filter((x) =>
      (x.target || '').toLowerCase().includes(q) ||
      (x.operator || '').toLowerCase().includes(q) ||
      (x.action || '').toLowerCase().includes(q) ||
      (x.machineId || '').toLowerCase().includes(q) ||
      (x.commandId || '').toLowerCase().includes(q) ||
      (x.recordId || '').toLowerCase().includes(q));
  }
  if (filter.action) items = items.filter((x) => x.action === filter.action);
  if (filter.target) items = items.filter((x) => x.target === filter.target);
  if (filter.operator) items = items.filter((x) => x.operator === filter.operator);
  if (filter.status) items = items.filter((x) => x.status === filter.status);
  if (filter.mid) items = items.filter((x) => x.machineId === filter.mid || x.target === filter.mid);
  if (filter.fromTs) items = items.filter((x) => (x.tsSec || 0) >= Number(filter.fromTs));
  if (filter.toTs) items = items.filter((x) => (x.tsSec || 0) <= Number(filter.toTs));

  // 倒序：最新在前
  items.sort((a, b) => (b.tsSec || 0) - (a.tsSec || 0));

  const page = Math.max(1, parseInt(filter.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(filter.pageSize, 10) || 50));
  const total = items.length;
  const startIdx = (page - 1) * pageSize;
  const paged = items.slice(startIdx, startIdx + pageSize);
  return { items: paged, total, page, pageSize };
}

/**
 * 导出 CSV（UTF-8 BOM，便于 Excel 直接打开中文）。
 * @param {string} kind 'op' | 'cmd' | 'highrisk'
 * @param {object} [filter] 同 query
 * @returns {string} CSV 文本
 */
function exportCsv(kind, filter) {
  const { items } = query(kind, filter);
  const columns = (() => {
    if (kind === 'op') return ['ts', 'tsSec', 'operator', 'operatorLevel', 'action', 'entity', 'target', 'before', 'after', 'detail', 'ok'];
    if (kind === 'cmd') return ['ts', 'tsSec', 'operator', 'commandId', 'action', 'target', 'status', 'error', 'result', 'ok'];
    if (kind === 'machine') return ['ts', 'tsSec', 'operator', 'operatorLevel', 'action', 'machineId', 'field', 'from', 'to', 'decision', 'detail', 'ok'];
    return ['ts', 'tsSec', 'operator', 'recordId', 'machineId', 'code', 'level', 'confirmChecked', 'totpChecked', 'whitelistChecked', 'commandId', 'status', 'countdownSec', 'issuedAt', 'ackedAt', 'result', 'before', 'after', 'ok'];
  })();

  function csvCell(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') {
      try { v = JSON.stringify(v); } catch (e) { v = String(v); }
    }
    const s = String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const lines = [];
  lines.push(columns.map((c) => csvCell(c)).join(','));
  for (const item of items) {
    lines.push(columns.map((c) => csvCell(item[c])).join(','));
  }
  return '\uFEFF' + lines.join('\n') + '\n';
}

module.exports = {
  KINDS,
  KIND_FILE,
  logOp,
  logCmd,
  logHighrisk,
  logMachine,
  query,
  exportCsv,
  setDataDir,
  auditDir,
};
