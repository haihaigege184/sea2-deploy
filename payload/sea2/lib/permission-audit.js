'use strict';
/**
 * lib/permission-audit.js — 权限审计查询辅助（只读）
 *
 * 供面板 /api/permissions 与运维脚本使用；全部为只读 SELECT，不写任何数据。
 * 兼容 sqlite3 Database 回调风格（run/get/all）。
 */

/** Promise 封装：db.all */
function _all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db || typeof db.all !== 'function') return reject(new Error('db 未就绪'));
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/** Promise 封装：db.get */
function _get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db || typeof db.get !== 'function') return reject(new Error('db 未就绪'));
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

/**
 * 查询审计日志（按时间倒序）。
 * @param {Object} db SQLite 实例
 * @param {{limit?:number, operator?:string, action?:string}} [opts]
 *   - limit: 返回条数（默认 50，上限 200）
 *   - operator: 按操作人 uin 过滤（可选）
 *   - action: 按动作 set|remove|migrate 过滤（可选）
 * @returns {Promise<Array>}
 */
async function listAudit(db, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const clauses = [];
  const params = [];
  if (opts.operator) {
    clauses.push('operator = ?');
    params.push(String(opts.operator));
  }
  if (opts.action) {
    clauses.push('action = ?');
    params.push(String(opts.action));
  }
  const where = clauses.length ? ('WHERE ' + clauses.join(' AND ')) : '';
  params.push(limit);
  return _all(
    db,
    `SELECT id, operator, action, target, from_level, to_level, detail, created_at
     FROM permission_audit ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    params
  );
}

/**
 * 按操作人查询审计（便捷封装）。
 * @param {Object} db SQLite 实例
 * @param {string} operator 操作人 uin
 * @param {number} [limit=20]
 * @returns {Promise<Array>}
 */
async function queryByOperator(db, operator, limit = 20) {
  return listAudit(db, { operator, limit });
}

/**
 * 按动作查询审计（便捷封装）。
 * @param {Object} db SQLite 实例
 * @param {string} action set | remove | migrate
 * @param {number} [limit=20]
 * @returns {Promise<Array>}
 */
async function queryByAction(db, action, limit = 20) {
  return listAudit(db, { action, limit });
}

/**
 * 审计统计（面板展示用）。
 * @param {Object} db SQLite 实例
 * @returns {Promise<{total:number, byAction:Object}>}
 */
async function auditStats(db) {
  const totalRow = await _get(db, 'SELECT COUNT(*) AS cnt FROM permission_audit', []);
  const byActionRows = await _all(
    db,
    'SELECT action, COUNT(*) AS cnt FROM permission_audit GROUP BY action',
    []
  );
  const byAction = {};
  for (const r of byActionRows) byAction[r.action] = r.cnt;
  return { total: (totalRow && totalRow.cnt) || 0, byAction };
}

module.exports = {
  listAudit,
  queryByOperator,
  queryByAction,
  auditStats,
};
