'use strict';
/**
 * lib/console/auth.js — 控制台登录与会话管理
 *
 * 鉴权模型：
 *  - 超管令牌（ADMIN_TOKEN，走 x-admin-token 头）：恒为 L3 / scope 'super'，绕过等级。
 *  - QQ 登录（走 N4 快照校验）：L2/L3 → admin 会话；L0/L1 → viewer 会话（仅可读）；
 *    未知 / 无记录 → 拒绝(401)。
 *  - 登录成功后返回服务端内存会话令牌（默认 8h 过期），后续请求带 x-console-token。
 *
 * 优雅降级：若 N4 快照不存在（bot 桥接未部署），permissionBridge.getLevel 返回 0，
 * 则 QQ 登录一律拒绝，后台仅 ADMIN_TOKEN 超管可用；部署桥接后自动具备 QQ 登录能力。
 */

const crypto = require('node:crypto');
const permissionBridge = require('./permissionBridge');

const SESSION_TTL_MS = (parseInt(process.env.CONSOLE_SESSION_TTL || '28800', 10) || 28800) * 1000;

/** token -> { qq, level, scope, createdAt, expiresAt } */
const sessions = new Map();

function _genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function _purgeExpired() {
  const now = Date.now();
  for (const [t, s] of sessions) {
    if (s.expiresAt <= now) sessions.delete(t);
  }
}

/**
 * 签发一个会话。
 * @param {string} qq
 * @param {number} level
 * @param {string} scope 'super' | 'admin' | 'viewer'
 */
function issueSession(qq, level, scope) {
  const token = _genToken();
  const now = Date.now();
  const session = {
    qq: String(qq),
    level: Number(level) || 0,
    scope,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  return { token, session };
}

/**
 * 登录：body { token } 或 { qq }（兼容 { mode, token, qq }）。
 *  - token 命中 cfg.adminToken → 超管(super)
 *  - qq 走 N4 快照校验：L2+ → admin 会话；L0-L1 → viewer 会话；未知 → 拒绝
 * @returns {{ok:boolean, token?:string, level?:number, scope?:string, role?:string, error?:string, status?:number}}
 */
function login(body, cfg) {
  body = body || {};
  const token = body.token != null ? String(body.token) : '';
  const qq = body.qq != null ? String(body.qq) : '';

  // 1) 超管令牌
  if (token && cfg && token === cfg.adminToken) {
    const { token: t } = issueSession('super', 3, 'super');
    return { ok: true, token: t, level: 3, scope: 'super', role: '超级管理员' };
  }

  // 2) QQ 登录（基于 N4 快照）
  if (qq) {
    const level = permissionBridge.getLevel(qq);
    if (level <= 0) {
      return { ok: false, error: '该 QQ 无后台访问权限（N4 中未授权或桥接未就绪）', status: 401 };
    }
    if (level >= 2) {
      const { token: t } = issueSession(qq, level, 'admin');
      return { ok: true, token: t, level, scope: 'admin', role: '管理员' };
    }
    // L0-L1 → 只读 viewer
    const { token: t } = issueSession(qq, level, 'viewer');
    return { ok: true, token: t, level, scope: 'viewer', role: '访客' };
  }

  return { ok: false, error: '需要 token 或 qq', status: 400 };
}

/**
 * 鉴权中间件。
 *  - 先查 x-console-token（登录会话）
 *  - 再查 x-admin-token === cfg.adminToken（恒 super / L3）
 * @param {object} req
 * @param {object} cfg
 * @param {number} [minLevel=0]
 * @returns {{ok:boolean, level?:number, scope?:string, qq?:string, super?:boolean, error?:string, status?:number}}
 */
function verifyAuth(req, cfg, minLevel = 0) {
  _purgeExpired();
  const min = Number(minLevel) || 0;

  // 会话 token
  const consoleToken = req.headers['x-console-token'];
  if (consoleToken && sessions.has(consoleToken)) {
    const s = sessions.get(consoleToken);
    if (s.expiresAt > Date.now()) {
      if (s.level >= min) {
        return { ok: true, level: s.level, scope: s.scope, qq: s.qq, super: s.scope === 'super' };
      }
      return { ok: false, error: `需要 L${min} 及以上权限`, status: 403 };
    }
    sessions.delete(consoleToken);
  }

  // 超管令牌（恒 L3）
  const adminToken = req.headers['x-admin-token'];
  if (adminToken && cfg && adminToken === cfg.adminToken) {
    return { ok: true, level: 3, scope: 'super', qq: 'super', super: true };
  }

  // [T2 P2-10] 局域网免登录（LAN_BYPASS）
  // 安全前提：
  //   1) 仅当来源 IP 命中内网段（127.0.0.0/8、10.0.0.0/8、192.168.0.0/16、172.16.0.0/12、::1）才放行；
  //   2) LAN_BYPASS 开关默认开，但可显式置 0/false 关闭（公网来源即使误配也绝不放行，仍需 token）；
  //   3) 仅在【无任何有效 token】时生效（本函数走到这里说明会话/超管令牌均未通过）。
  // 放行语义 = 签发一次 L3 超管会话：qq 标记为 'lan'，scope 'super'，lan:true 供前端显示角标。
  const lanEnabled = (cfg && cfg.lanBypass !== undefined)
    ? !!cfg.lanBypass
    : (process.env.LAN_BYPASS !== '0' && process.env.LAN_BYPASS !== 'false');
  if (lanEnabled && isLanAddress(req.socket && req.socket.remoteAddress)) {
    return { ok: true, level: 3, scope: 'super', qq: 'lan', super: true, lan: true };
  }

  return { ok: false, error: '未登录或会话无效', status: 401 };
}

/**
 * 归一化来源 IP：剥离 IPv4-mapped IPv6（::ffff:1.2.3.4 → 1.2.3.4）与方括号（[::1] → ::1）。
 * @param {*} raw req.socket.remoteAddress 原始值
 * @returns {string} 归一化后的 IP；无法解析时返回 ''
 */
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  return ip;
}

/**
 * 判定来源 IP 是否属于内网段（LAN_BYPASS 放行白名单）。
 * @param {*} raw req.socket.remoteAddress 原始值
 * @returns {boolean}
 */
function isLanAddress(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  // IPv6 loopback（::1）与 IPv4 loopback（127.x）
  if (ip === '::1') return true;
  if (ip === '127.0.0.1' || ip === 'localhost') return true;
  // 仅处理 IPv4 字面量；IPv6 公网/内网一律不在此放行（保守）
  if (!ip.includes('.')) return false;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true;                  // 127.0.0.0/8
  if (a === 10) return true;                   // 10.0.0.0/8
  if (a === 192 && b === 168) return true;     // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  return false;
}

module.exports = { login, verifyAuth, issueSession, SESSION_TTL_MS, sessions, isLanAddress, normalizeIp };
