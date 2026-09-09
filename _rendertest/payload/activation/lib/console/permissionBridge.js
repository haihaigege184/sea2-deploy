'use strict';
/**
 * lib/console/permissionBridge.js — server 侧 N4 客户端（纯 fs）
 *
 * 本模块只做两件事（绝不引入 sqlite3）：
 *  1. 读：读取 bot 导出的快照 permission_snapshot.json，判定 QQ 等级 / 列出管理员 / 读审计。
 *  2. 写：向 permission_inbox.jsonl 追加一行命令（异步落库，由 bot 侧桥接处理）。
 *
 * 路径（可在 activation-server 进程用环境变量覆盖，便于本地联调）：
 *  N4_SNAPSHOT_PATH / N4_INBOX_PATH
 */

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT_PATH = process.env.N4_SNAPSHOT_PATH
  || (process.platform === 'win32'
    ? path.join('F:/ai/开发1/sea1/data/permission_snapshot.json')
    : '/root/sea1/data/permission_snapshot.json');
const INBOX_PATH = process.env.N4_INBOX_PATH
  || (process.platform === 'win32'
    ? path.join('F:/ai/开发1/sea1/data/permission_inbox.jsonl')
    : '/root/sea1/data/permission_inbox.jsonl');

/**
 * 读取 bot 导出的快照（容错：文件缺失 / 解析失败 → 返回空结构）。
 * @returns {{users:Array, fallback:object, audit:Array, meta:object, available:boolean, error?:string}}
 */
function readSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      return { users: [], fallback: {}, audit: [], meta: {}, available: false };
    }
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    return {
      users: Array.isArray(data.users) ? data.users : [],
      fallback: data.fallback || {},
      audit: Array.isArray(data.audit) ? data.audit : [],
      meta: data.meta || {},
      available: true,
    };
  } catch (e) {
    return { users: [], fallback: {}, audit: [], meta: {}, available: false, error: String(e && e.message || e) };
  }
}

/**
 * 查询某个 QQ 的有效等级（结合快照中的显式用户 + config 兜底）。
 * @param {string|number} qq
 * @returns {number} 0-3
 */
function getLevel(qq) {
  const snap = readSnapshot();
  const q = String(qq);
  for (const u of snap.users) {
    if (String(u.uin) === q) return Number(u.level) || 0;
  }
  const fb = snap.fallback || {};
  if (fb.superAdmin && String(fb.superAdmin) === q) return 2;
  if (fb.developer && String(fb.developer) === q) return 3;
  return 0;
}

/**
 * 读取最近 N 条权限审计（倒序）。
 * @param {number} [limit=50]
 */
function listAudits(limit = 50) {
  const snap = readSnapshot();
  const arr = Array.isArray(snap.audit) ? snap.audit : [];
  arr.reverse();
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return arr.slice(0, n);
}

/**
 * 追加一条命令到信箱（异步落库，由 bot 侧桥接处理）。
 * @param {{op:'set'|'remove', target:string, level?:number, operator?:string}} cmd
 * @returns {{enqueued:boolean, error?:string}}
 */
function enqueue(cmd) {
  const rec = {
    op: cmd.op === 'remove' ? 'remove' : 'set',
    target: String(cmd.target),
    level: cmd.level != null ? Number(cmd.level) : 0,
    operator: String(cmd.operator || 'console'),
    ts: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true });
    fs.appendFileSync(INBOX_PATH, JSON.stringify(rec) + '\n');
    return { enqueued: true };
  } catch (e) {
    return { enqueued: false, error: String(e && e.message || e) };
  }
}

module.exports = { readSnapshot, getLevel, listAudits, enqueue, SNAPSHOT_PATH, INBOX_PATH };
