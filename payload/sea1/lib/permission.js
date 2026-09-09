'use strict';
/**
 * lib/permission.js — sea1 用户权限层级管理系统 · 核心服务
 *
 * 职责：作为「用户账号操作权限」的唯一事实源（与 licensing/ LicenseGate 完全无关），
 * 提供等级读写、防提权校验、存量迁移、审计落库与内存缓存。
 *
 * 等级语义（全插件共享约定）：
 *   0 普通用户 / 1 管理员 / 2 超级管理员 / 3 开发者
 *
 * 兜底策略：
 *   effectiveLevel(uin) = max(dbLevel, fallbackLevel(uin))
 *   fallbackLevel(uin)：uin===config.developer → 3；uin===config.superAdmin → 2；否则 0
 *   即 config.superAdmin/developer 永久作为「兜底地板」，权限库异常/被清不会锁死。
 *
 * 热路径 vs 冷路径：
 *   - getLevelSync / hasLevelSync / getAdminQQsSync：同步缓存 API（每条消息用）
 *   - getLevel / hasLevel / getAdminQQs / setLevel / listUsers：异步 db API（管理命令用）
 *   - getLevel 对已缓存用户直接返回缓存（零 db 开销），未缓存用户查库后写缓存。
 *
 * 依赖：仅使用外部传入的 db 实例（sea.js 的 sqlite3 Database），不直接 require sqlite3。
 * 所有 uin 一律 String() 归一。
 */

// 等级名称（唯一事实源，供插件/面板/审计共用）
const LEVEL_NAMES = {
  0: '普通用户',
  1: '管理员',
  2: '超级管理员',
  3: '开发者',
};

// 等级名称别名（命令解析用；键一律小写）
// 注意：「普通用户」类别名必须映射到 0，否则管理员想降级为普通用户会反被提权成 L1。
const LEVEL_ALIASES = {
  '普通': 0,
  '普通用户': 0,
  'user': 0,
  'u': 0,
  '管理员': 1,
  'admin': 1,
  '超级管理员': 2,
  '超级': 2,
  '超管': 2,
  'super': 2,
  'superadmin': 2,
  '开发者': 3,
  '开发': 3,
  'developer': 3,
  'dev': 3,
};

/**
 * 将命令入参解析为等级数字。
 * 支持 0-3 数字、等级名称（中英文别名）。
 * @param {string|number} input
 * @returns {number|null} 0-3 的整数；无法解析返回 null
 */
function resolveLevelName(input) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return (n >= 0 && n <= 3) ? n : null;
  }
  if (Object.prototype.hasOwnProperty.call(LEVEL_ALIASES, s)) {
    return LEVEL_ALIASES[s];
  }
  return null;
}

/** 建表 DDL（幂等；库文件沿用 ./database/db.sqlite；不动既有 users 表） */
const DDL = [
  `CREATE TABLE IF NOT EXISTS user_permissions (
     uin        TEXT PRIMARY KEY,
     level      INTEGER NOT NULL DEFAULT 0,
     role       TEXT    NOT NULL DEFAULT '普通用户',
     updated_by TEXT    NOT NULL DEFAULT 'system',
     updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
     remark     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_permissions_level ON user_permissions(level)`,
  `CREATE TABLE IF NOT EXISTS permission_audit (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     operator   TEXT NOT NULL,
     action     TEXT NOT NULL,
     target     TEXT,
     from_level INTEGER,
     to_level   INTEGER,
     detail     TEXT,
     created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_permission_audit_created ON permission_audit(created_at)`,
  `CREATE TABLE IF NOT EXISTS permission_meta (
     key   TEXT PRIMARY KEY,
     value TEXT
   )`,
];

class PermissionService {
  /**
   * @param {Object} [config] 全量配置（config.json 内容；含 superAdmin/developer）
   * @param {Object} [db] SQLite 数据库实例（sqlite3 Database 回调风格：run/get/all）
   */
  constructor(config = {}, db = null) {
    this.config = config || {};
    this.db = db || null;
    /** 内存缓存：uin → 有效等级（effective = max(db, fallback)） */
    this.cache = new Map();
    /** 内存缓存：有效等级 >= 1 的管理员 uin 集合（L1+） */
    this.adminCache = new Set();
    this.initialized = false;
  }

  // ------------------------------------------------------------------
  // 私有：db Promise 封装（兼容 sqlite3 回调风格 run/get/all）
  // ------------------------------------------------------------------

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db || typeof this.db.run !== 'function') {
        return reject(new Error('权限服务 db 未就绪'));
      }
      this.db.run(sql, params, function onRun(err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db || typeof this.db.get !== 'function') {
        return reject(new Error('权限服务 db 未就绪'));
      }
      this.db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });
  }

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.db || typeof this.db.all !== 'function') {
        return reject(new Error('权限服务 db 未就绪'));
      }
      this.db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });
  }

  // ------------------------------------------------------------------
  // 初始化与迁移
  // ------------------------------------------------------------------

  /**
   * 初始化：建 3 张表 + 索引，然后执行一次性存量迁移（幂等）。
   * @returns {Promise<{skipped:boolean, migrated:number, entries:Array}>} 迁移报告
   */
  async init() {
    for (const sql of DDL) {
      await this._run(sql);
    }
    this.initialized = true;
    const report = await this.migrateLegacy();
    await this._refreshCacheFromDb();
    return report;
  }

  /**
   * 一次性存量迁移（幂等，permission_meta.legacy_migrated 防重跑）。
   * 规则：
   *   - config.superAdmin → 2（超级管理员）
   *   - config.developer → 3（开发者）
   *   - env VIP_ADMIN_QQ（逗号分隔）→ 1（管理员）
   *   - 同号取最高级；写入用 MAX 只升不降；每账号写一条审计(action='migrate')。
   * @returns {Promise<{skipped:boolean, migrated:number, entries:Array}>}
   */
  async migrateLegacy() {
    try {
      const meta = await this._get("SELECT value FROM permission_meta WHERE key = 'legacy_migrated'", []);
      if (meta && meta.value === '1') {
        return { skipped: true, migrated: 0, entries: [] };
      }
    } catch (e) {
      // 元表查询失败不阻断迁移（建表阶段已保证表存在）
    }

    const sources = [];
    if (this.config.superAdmin) {
      sources.push({ uin: String(this.config.superAdmin), level: 2, source: 'config.superAdmin' });
    }
    if (this.config.developer) {
      sources.push({ uin: String(this.config.developer), level: 3, source: 'config.developer' });
    }
    const envList = String(process.env.VIP_ADMIN_QQ || '')
      .split(',').map((s) => String(s).trim()).filter(Boolean);
    for (const q of envList) {
      sources.push({ uin: q, level: 1, source: 'env.VIP_ADMIN_QQ' });
    }

    // 同号去重，取最高级（当前 __ADMIN_QQ__ 同时为 superAdmin+developer → L3）
    const byUin = new Map();
    for (const src of sources) {
      const prev = byUin.get(src.uin);
      if (!prev || prev.level < src.level) byUin.set(src.uin, src);
    }

    const entries = [];
    for (const [uin, src] of byUin) {
      let from = 0;
      try {
        const existing = await this._get('SELECT level FROM user_permissions WHERE uin = ?', [uin]);
        if (existing && existing.level != null) from = Number(existing.level) || 0;
      } catch (e) { /* 查不到按 0 处理 */ }
      // 只升不降：已有等级不低于迁移等级则跳过（防覆盖人工设置）
      if (from >= src.level) continue;
      const to = Math.max(from, src.level);
      await this._upsert(uin, to, 'system:migrate', 'migrate:' + src.source);
      await this._logAudit('system:migrate', 'migrate', uin, from, to, src.source);
      entries.push({ uin, from, to, source: src.source });
    }

    await this._run(
      "INSERT INTO permission_meta(key, value) VALUES('legacy_migrated','1') " +
      "ON CONFLICT(key) DO UPDATE SET value = '1'",
      []
    );
    return { skipped: false, migrated: entries.length, entries };
  }

  // ------------------------------------------------------------------
  // 等级查询（热路径同步 + 冷路径异步）
  // ------------------------------------------------------------------

  /**
   * 异步查等级（冷/热两用）：已缓存用户直接返回缓存（零 db 开销），
   * 未缓存用户查库并写缓存。有效等级 = max(dbLevel, config 兜底)。
   * @param {string|number} uin
   * @returns {Promise<number>}
   */
  async getLevel(uin) {
    const key = String(uin);
    if (this.cache.has(key)) return this.cache.get(key);

    let dbLevel = 0;
    try {
      const row = await this._get('SELECT level FROM user_permissions WHERE uin = ?', [key]);
      if (row && row.level != null) dbLevel = Number(row.level) || 0;
    } catch (e) {
      dbLevel = 0; // 权限库异常回落 config 兜底，绝不影响消息分发
    }
    const effective = Math.max(dbLevel, this.fallbackLevel(key));
    this.cache.set(key, effective);
    if (effective >= 1) this.adminCache.add(key);
    else this.adminCache.delete(key);
    return effective;
  }

  /**
   * 同步查等级（热路径）：缓存命中取缓存，未命中取 config 兜底。永不抛异常。
   * @param {string|number} uin
   * @returns {number}
   */
  getLevelSync(uin) {
    const key = String(uin);
    if (this.cache.has(key)) return this.cache.get(key);
    return this.fallbackLevel(key);
  }

  /**
   * 异步判断是否达到指定等级。
   * @param {string|number} uin
   * @param {number} level
   * @returns {Promise<boolean>}
   */
  async hasLevel(uin, level) {
    return (await this.getLevel(uin)) >= Number(level);
  }

  /**
   * 同步判断是否达到指定等级（热路径）。
   * @param {string|number} uin
   * @param {number} level
   * @returns {boolean}
   */
  hasLevelSync(uin, level) {
    return this.getLevelSync(uin) >= Number(level);
  }

  /**
   * config 兜底等级：developer → 3；superAdmin → 2；否则 0。
   * @param {string|number} uin
   * @returns {number}
   */
  fallbackLevel(uin) {
    const key = String(uin);
    if (this.config.developer && key === String(this.config.developer)) return 3;
    if (this.config.superAdmin && key === String(this.config.superAdmin)) return 2;
    return 0;
  }

  // ------------------------------------------------------------------
  // 写操作（设置 / 移除，共用防提权校验）
  // ------------------------------------------------------------------

  /**
   * 设置用户等级（写库 + 更新缓存 + 审计）。防提权规则见 _applyLevel。
   * @param {string|number} operator 操作人 uin
   * @param {string|number} target 目标 uin
   * @param {number} level 0-3
   * @param {string} [remark] 备注
   * @returns {Promise<{ok:boolean, error?:string, message?:string, level?:number, levelName?:string, effective?:number, warning?:string}>}
   */
  async setLevel(operator, target, level, remark) {
    return this._applyLevel(operator, target, level, remark, 'set');
  }

  /**
   * 移除用户权限（等价设为 0，删除显式行；走同一套防提权校验）。
   * @param {string|number} operator 操作人 uin
   * @param {string|number} target 目标 uin
   * @returns {Promise<{ok:boolean, error?:string, message?:string, level?:number, levelName?:string, effective?:number, already?:boolean, warning?:string}>}
   */
  async removeLevel(operator, target) {
    return this._applyLevel(operator, target, 0, 'remove', 'remove');
  }

  /**
   * 防提权校验（setLevel/removeLevel 共用）：
   *   1. operatorLevel >= 2                       （设置/移除仅 L2+）
   *   2. 0 <= newLevel <= 3
   *   3. newLevel <= operatorLevel                （不能把别人设得比自己高）
   *   4. targetCurrentLevel <= operatorLevel      （不能修改等级高于自己的人）
   *   5. newLevel >= fallbackLevel(target)        （不能低于 config 兜底，防锁死）
   *   6. 自己把自己降到 0（且无兜底）时允许，但返回风险提示
   * @private
   */
  async _applyLevel(operator, target, level, remark, action) {
    const op = String(operator == null ? '' : operator);
    const tg = String(target == null ? '' : target);
    const lv = Math.trunc(Number(level));

    if (!Number.isFinite(lv) || lv < 0 || lv > 3) {
      return { ok: false, error: 'E_INVALID_LEVEL', message: '等级必须为 0-3 的整数' };
    }
    if (!tg || tg === '0' || tg === 'undefined' || tg === 'null') {
      return { ok: false, error: 'E_INVALID_TARGET', message: '目标 QQ 无效' };
    }

    const operatorLevel = await this.getLevel(op);
    if (operatorLevel < 2) {
      return { ok: false, error: 'E_LEVEL_REQUIRED', message: '需要 2（超级管理员）及以上等级' };
    }
    if (lv > operatorLevel) {
      return { ok: false, error: 'E_SELF_EXCEED', message: '不能把目标设置为高于自己的等级' };
    }

    const targetCurrent = await this.getLevel(tg);
    if (targetCurrent > operatorLevel) {
      return { ok: false, error: 'E_TARGET_HIGHER', message: '不能修改等级高于自己的账号' };
    }

    const floor = this.fallbackLevel(tg);
    if (lv < floor) {
      return { ok: false, error: 'E_BELOW_FALLBACK', message: '不能低于该账号的 config 兜底等级（防锁死）' };
    }

    if (targetCurrent === 0 && lv === 0) {
      // 已是普通用户（无显式行），移除幂等成功
      return { ok: true, level: 0, levelName: LEVEL_NAMES[0], effective: Math.max(0, floor), action, already: true };
    }

    if (lv === 0) {
      // 移除 = 删除显式行，恢复为纯 config 兜底
      await this._run('DELETE FROM user_permissions WHERE uin = ?', [tg]);
    } else {
      await this._upsert(tg, lv, op, remark || (action + ' by ' + op));
    }

    const effective = Math.max(lv, floor);
    this.cache.set(tg, effective);
    if (effective >= 1) this.adminCache.add(tg);
    else this.adminCache.delete(tg);

    await this._logAudit(op, action, tg, targetCurrent, lv, remark || null);

    const result = {
      ok: true,
      level: lv,
      levelName: LEVEL_NAMES[lv] || LEVEL_NAMES[0],
      effective,
      action,
    };
    if (op === tg && lv === 0 && floor === 0) {
      result.warning = '⚠️ 你将自己降为普通用户：若系统中无其他 L2+ 管理员，将无法再通过 #权限 恢复，请谨慎操作（config 兜底账号除外）。';
    }
    return result;
  }

  /** 私有：UPSERT 写入（level 只升不降由调用方保证；此处按给定 level 覆盖元数据） */
  async _upsert(uin, level, updatedBy, remark) {
    const role = LEVEL_NAMES[level] || LEVEL_NAMES[0];
    const now = Math.floor(Date.now() / 1000);
    await this._run(
      `INSERT INTO user_permissions(uin, level, role, updated_by, updated_at, remark)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(uin) DO UPDATE SET
         level = excluded.level,
         role = excluded.role,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at,
         remark = excluded.remark`,
      [uin, level, role, updatedBy, now, remark != null ? String(remark) : null]
    );
  }

  // ------------------------------------------------------------------
  // 管理查询（列表 / 管理员集合）
  // ------------------------------------------------------------------

  /**
   * 异步获取达到指定等级的用户 uin 列表（含 config 兜底账号）。
   * @param {number} [minLevel=1]
   * @returns {Promise<string[]>}
   */
  async getAdminQQs(minLevel = 1) {
    const m = Number(minLevel) || 1;
    const set = new Set();
    try {
      const rows = await this._all('SELECT uin FROM user_permissions WHERE level >= ?', [m]);
      for (const r of rows) {
        const uin = String(r.uin);
        set.add(uin);
        const eff = Math.max(Number(r.level) || 0, this.fallbackLevel(uin));
        this.cache.set(uin, eff);
        if (eff >= 1) this.adminCache.add(uin);
      }
    } catch (e) { /* 查询失败仅返回兜底 */ }
    for (const f of [this.config.superAdmin, this.config.developer]) {
      if (f && this.fallbackLevel(String(f)) >= m) set.add(String(f));
    }
    return Array.from(set);
  }

  /**
   * 同步获取达到指定等级的用户 uin 列表（缓存热路径，vip 每消息用）。
   * @param {number} [minLevel=1]
   * @returns {string[]}
   */
  getAdminQQsSync(minLevel = 1) {
    const m = Number(minLevel) || 1;
    const set = new Set(this.adminCache);
    for (const f of [this.config.superAdmin, this.config.developer]) {
      if (f && this.fallbackLevel(String(f)) >= m) set.add(String(f));
    }
    return Array.from(set).filter((uin) => this.getLevelSync(uin) >= m);
  }

  /**
   * 列出达到指定等级的用户（含 config 兜底账号，标注 fallback）。
   * @param {number} [minLevel=0]
   * @param {number} [limit=100]
   * @returns {Promise<Array<{uin:string, level:number, levelName:string, role:string, updated_by:string, updated_at:number, remark:string|null, fallback:boolean}>>}
   */
  async listUsers(minLevel = 0, limit = 100) {
    const m = Number(minLevel) || 0;
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    let rows = [];
    try {
      rows = await this._all(
        'SELECT uin, level, role, updated_by, updated_at, remark FROM user_permissions WHERE level >= ? ORDER BY level DESC, uin ASC LIMIT ?',
        [m, lim]
      );
    } catch (e) {
      rows = [];
    }

    const out = rows.map((r) => ({
      uin: String(r.uin),
      level: Number(r.level) || 0,
      levelName: LEVEL_NAMES[Number(r.level) || 0] || LEVEL_NAMES[0],
      role: r.role || LEVEL_NAMES[Number(r.level) || 0] || LEVEL_NAMES[0],
      updated_by: r.updated_by || 'system',
      updated_at: r.updated_at || 0,
      remark: r.remark || null,
      fallback: false,
    }));

    // 合并 config 兜底账号（未在库中显式设置也展示，保证列表完整）
    const seen = new Set(out.map((r) => r.uin));
    for (const f of [this.config.superAdmin, this.config.developer]) {
      if (!f) continue;
      const uin = String(f);
      if (seen.has(uin)) continue;
      const fb = this.fallbackLevel(uin);
      if (fb >= m) {
        out.push({
          uin,
          level: fb,
          levelName: LEVEL_NAMES[fb] || LEVEL_NAMES[0],
          role: '系统兜底',
          updated_by: 'system:fallback',
          updated_at: 0,
          remark: 'config 兜底（未在权限库显式设置）',
          fallback: true,
        });
        seen.add(uin);
      }
    }

    out.sort((a, b) => (b.level - a.level) || (a.uin < b.uin ? -1 : 1));
    return out;
  }

  // ------------------------------------------------------------------
  // 审计
  // ------------------------------------------------------------------

  /**
   * 写审计日志（best-effort，失败不影响主流程）。
   * @param {string} operator 操作人 uin
   * @param {string} action set | remove | migrate
   * @param {string|null} target 目标 uin
   * @param {number|null} fromLevel
   * @param {number|null} toLevel
   * @param {string|null} detail
   */
  async _logAudit(operator, action, target, fromLevel, toLevel, detail) {
    try {
      await this._run(
        'INSERT INTO permission_audit(operator, action, target, from_level, to_level, detail, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
        [
          String(operator),
          String(action),
          target != null ? String(target) : null,
          fromLevel != null ? Number(fromLevel) : null,
          toLevel != null ? Number(toLevel) : null,
          detail != null ? String(detail) : null,
          Math.floor(Date.now() / 1000),
        ]
      );
    } catch (e) {
      // 审计失败绝不影响主流程
    }
  }

  // ------------------------------------------------------------------
  // 缓存维护
  // ------------------------------------------------------------------

  /** 从 db + config 全量重建内存缓存（迁移后 / 冷启动时调用）。 */
  async _refreshCacheFromDb() {
    try {
      const rows = await this._all('SELECT uin, level FROM user_permissions', []);
      this.cache.clear();
      this.adminCache.clear();
      for (const r of rows) {
        const uin = String(r.uin);
        const lv = Number(r.level) || 0;
        const eff = Math.max(lv, this.fallbackLevel(uin));
        this.cache.set(uin, eff);
        if (eff >= 1) this.adminCache.add(uin);
      }
      for (const f of [this.config.superAdmin, this.config.developer]) {
        if (!f) continue;
        const uin = String(f);
        const eff = Math.max(this.cache.get(uin) || 0, this.fallbackLevel(uin));
        this.cache.set(uin, eff);
        if (eff >= 1) this.adminCache.add(uin);
      }
    } catch (e) {
      // 缓存刷新失败不影响已有缓存
    }
  }

  /**
   * 显式刷新某 uin 的缓存（外部改库后调用；一般无需手动调用）。
   * @param {string|number} uin
   */
  async refresh(uin) {
    const key = String(uin);
    this.cache.delete(key);
    this.adminCache.delete(key);
    await this.getLevel(key);
  }
}

module.exports = {
  PermissionService,
  LEVEL_NAMES,
  LEVEL_ALIASES,
  resolveLevelName,
};
