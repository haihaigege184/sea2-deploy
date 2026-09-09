'use strict';
/**
 * codes.js — 激活码记录模型与校验
 */
const crypto = require('./crypto');

/** 默认功能包（商业版） */
const DEFAULT_FEATURES = ['print', 'a3', 'batch', 'web'];

/**
 * 创建一条激活码记录
 * @param {object} o
 * @param {string} [o.customer]
 * @param {string[]} [o.features]
 * @param {number} [o.expires_at] unix 秒；0 表示永不过期
 * @param {number} [o.max_groups]
 * @param {string} [o.code] 不传则随机生成
 */
function makeCodeRecord(o = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    code: o.code || crypto.generateActivationCode(),
    customer: o.customer || '',
    features: Array.isArray(o.features) ? o.features : DEFAULT_FEATURES,
    issued_at: now,
    expires_at: o.expires_at || 0, // 0 = 永久
    max_groups: o.max_groups || 10,
    status: 'unused',     // unused | active | revoked
    bound_machine_id: null,
    created_at: now,
  };
}

/** 校验激活码格式 */
function isValidCodeFormat(code) {
  return /^SEA1-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code);
}

/**
 * [T1-P1-4] 归一化 expires_at 为「秒」。
 *
 * 历史遗留：/api/order/issue 与 console/orders.js 的签发路径曾以毫秒写入
 * （Date.now() + days*86400000），而 crud / makeCodeRecord 以秒写入。
 * 秒值与毫秒值量级差异明显（秒 < 1e12，毫秒 ~1.7e12），以此识别并换算，
 * 保证 codes.isCodeExpired / anomaly.ruleExpiredOnline / devices 状态判定统一按秒比较。
 * @param {number} v 原始 expires_at（0 = 永久）
 * @returns {number} 秒值（0 或 >1e12 的毫秒值 → 换算后的秒）
 */
function normalizeExpiresAt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

/** 激活码是否过期（按记录自身有效期，非已下发 license） */
function isCodeExpired(rec, now = Math.floor(Date.now() / 1000)) {
  const exp = normalizeExpiresAt(rec && rec.expires_at);
  return exp > 0 && now > exp;
}

module.exports = { makeCodeRecord, isValidCodeFormat, isCodeExpired, normalizeExpiresAt, DEFAULT_FEATURES };
