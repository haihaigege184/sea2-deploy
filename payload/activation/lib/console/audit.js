'use strict';
/**
 * lib/console/audit.js — 控制台操作审计（best-effort 落盘，不影响主流程）
 *
 * 审计写入 data/console-audit.jsonl（每行一个 JSON）。
 * 读取返回最近 N 条（倒序：最新在前）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const AUDIT_FILE = process.env.CONSOLE_AUDIT_PATH
  || path.join(DATA_DIR, 'console-audit.jsonl');

function _ensureDir() {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
  } catch (e) { /* ignore */ }
}

/**
 * 记录一条审计。
 * @param {{operator?:string, operatorLevel?:number|string, action:string, target?:string, detail?:string, ok?:boolean}} entry
 */
function logAction(entry) {
  try {
    _ensureDir();
    const rec = {
      ts: new Date().toISOString(),
      tsSec: Math.floor(Date.now() / 1000),
      operator: entry.operator || 'system',
      operatorLevel: entry.operatorLevel != null ? String(entry.operatorLevel) : '',
      action: entry.action || '',
      target: entry.target != null ? String(entry.target) : '',
      detail: entry.detail != null ? String(entry.detail) : '',
      ok: entry.ok !== false,
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    // best-effort：审计失败绝不影响主流程
  }
}

/**
 * 读取最近 N 条审计（倒序：最新在前）。
 * @param {number} [limit=50]
 * @returns {Array<{ts:string, tsSec:number, operator:string, operatorLevel:string, action:string, target:string, detail:string, ok:boolean}>}
 */
function list(limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    const rows = lines.map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    rows.reverse();
    return rows.slice(0, n);
  } catch (e) {
    return [];
  }
}

module.exports = { logAction, list, AUDIT_FILE };
