'use strict';
/**
 * trial.js — 新用户试用期（按 uin / QQ）数据层 + 巡检编排
 *
 * 与 legacy lib/trials.js（按 machine_id，/api/trial/status）完全解耦、互不干扰：
 *   - 本模块面向「用户维度」的试用期管理（首触自动授予、临期/到期柔软提醒、已激活停发）；
 *   - legacy trials.js 原样保留，仅服务于客户端机器维度的试用倒计时。
 *
 * 设计要点：
 *   - 纯函数 + 依赖注入 store，便于单测（零外部依赖，仅 Node 内置 fs）；
 *   - 所有对 store 的写入都经 store 既有访问器（原子写 tmp→rename）；
 *   - 配置以 store.trialConfig 单例为事实来源，支持热更新；缺失时以启动 cfg 为默认。
 */

const fs = require('node:fs');

// ---- 常量 ----
const DAY_MS = 86400000;

/**
 * 由启动配置推导默认试用配置（仅用于首次落盘基线，不覆盖已存 store.trialConfig）。
 * @param {object} cfg 来自 loadConfig() 的配置（含 trialMonths / trialDisabled / trialNearDays / trialMaxReminders）
 * @returns {{months:number, disabled:boolean, nearDays:number[], maxReminders:number}}
 */
function defaultTrialConfig(cfg) {
  return {
    months: (cfg && cfg.trialMonths != null) ? cfg.trialMonths : 3,
    disabled: !!(cfg && cfg.trialDisabled),
    nearDays: (cfg && Array.isArray(cfg.trialNearDays) && cfg.trialNearDays.length) ? cfg.trialNearDays : [7, 3],
    maxReminders: (cfg && cfg.trialMaxReminders != null) ? cfg.trialMaxReminders : 3,
  };
}

/**
 * 读取当前生效的试用配置（store.trialConfig 单例优先；缺失则以默认配置落盘一次）。
 * @param {object} store
 * @param {object} cfg
 * @returns {{months:number, disabled:boolean, nearDays:number[], maxReminders:number}}
 */
function getTrialConfig(store, cfg) {
  const stored = store.getTrialConfig && store.getTrialConfig();
  if (stored && typeof stored === 'object' && stored.months != null) {
    return {
      months: stored.months,
      disabled: !!stored.disabled,
      nearDays: (Array.isArray(stored.nearDays) && stored.nearDays.length) ? stored.nearDays : [7, 3],
      maxReminders: stored.maxReminders != null ? stored.maxReminders : 3,
    };
  }
  const fallback = defaultTrialConfig(cfg);
  // 仅在确实缺失时落盘一次，避免每次请求都 flush
  if (!stored && store.saveTrialConfig) store.saveTrialConfig(fallback);
  return fallback;
}

/**
 * 热更新试用配置（管理员接口 / #试用 指令）。
 * @param {object} store
 * @param {object} cfg
 * @param {{months?:number, disabled?:boolean}} patch
 * @returns {{ok:boolean, error?:string, config?:object}}
 */
function updateTrialConfig(store, cfg, patch = {}) {
  const cur = getTrialConfig(store, cfg); // 确保基线存在
  const next = Object.assign({}, cur);
  if (patch.months != null) {
    const m = parseInt(patch.months, 10);
    if (!Number.isFinite(m) || m <= 0) {
      return { ok: false, error: 'months 必须为正整数' };
    }
    next.months = m;
  }
  if (patch.disabled != null) next.disabled = !!patch.disabled;
  if (store.saveTrialConfig) store.saveTrialConfig(next);
  return { ok: true, config: next };
}

/**
 * 查询某 uin 是否已成为付费/已激活用户（存在 paid/issued 订单即视为 converted）。
 * 订单字段 qq 即本功能的 uin（QQ 号）。
 * @param {object} store
 * @param {string|number} uin
 * @returns {Array<object>}
 */
function findOrdersByQq(store, uin) {
  const q = String(uin);
  return store.listOrders().filter(
    (o) => String(o.qq) === q && (o.status === 'paid' || o.status === 'issued'),
  );
}

/** 该 uin 是否已激活（命中成功订单） */
function isConverted(store, uin) {
  return findOrdersByQq(store, uin).length > 0;
}

/**
 * [R6 R1] 是否存在有效正式授权（激活码维度，机器/客户双轨匹配）。
 * 有效 license = expires_at===0（永久）或 >now（未过期），且匹配 bound machine_id 或 customer。
 * 用于会员判定统一口径：clearTrials / trialStatusByUin(converted) / grantTrial(曾购拒绝) /
 * scanPendingReminders(跳过会员) / trials.js(机器维度排除) 全部复用本函数。
 *
 * @param {object} store
 * @param {{machineId?:string|number, uin?:string|number}} [opts]
 * @returns {boolean}
 */
function hasActiveLicense(store, opts) {
  opts = opts || {};
  const machineId = opts.machineId != null ? String(opts.machineId) : '';
  const uin = opts.uin != null ? String(opts.uin) : '';
  if (!machineId && !uin) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return store.listCodes().some((c) => {
    if (!c || c.status !== 'active') return false;
    const exp = c.expires_at;
    // 永久（0）或未过期才有效
    if (exp != null && Number(exp) !== 0 && Number(exp) <= nowSec) return false;
    if (machineId && c.bound_machine_id != null && String(c.bound_machine_id) === machineId) return true;
    if (uin && c.customer != null && String(c.customer) === uin) return true;
    return false;
  });
}

/**
 * [R6 R1] 签发成功（激活码激活 / 订单发码）后幂等清除试用记录（机器 + 用户双维度）。
 * 原子幂等：任一维度缺失时返回 false，不抛错、不重复 flush（由 store 访问器保证）。
 *
 * @param {object} store
 * @param {{machineId?:string|number, uin?:string|number}} [opts]
 * @returns {{ok:boolean, removedMachine:boolean, removedUser:boolean}}
 */
function clearTrials(store, opts) {
  opts = opts || {};
  const removedMachine = !!(opts.machineId != null && store.removeTrial && store.removeTrial(opts.machineId));
  const removedUser = !!(opts.uin != null && store.removeTrialUser && store.removeTrialUser(opts.uin));
  return { ok: true, removedMachine, removedUser };
}

/**
 * 授予新用户试用期（幂等；disabled 时不授予）。
 * @param {object} store
 * @param {object} cfg
 * @param {{uin:string|number, months?:number}} opts
 * @returns {{ok:boolean, disabled?:boolean, already?:boolean, uin:string, trialStartAt?:number, trialExpiresAt?:number, status?:string, error?:string}}
 */
function grantTrial(store, cfg, opts = {}) {
  const u = String(opts.uin);
  if (!u) return { ok: false, error: 'uin 必填', uin: u };
  const config = getTrialConfig(store, cfg);
  if (config.disabled) return { ok: false, disabled: true, uin: u };

  // [R6 R1] 曾购拒绝：已存在有效正式授权（激活码维度，含永久/未过期、机器/客户匹配）→ 不再授予试用
  if (hasActiveLicense(store, { uin: u })) {
    return { ok: false, error: '已激活用户无需试用', converted: true, uin: u };
  }

  const existing = store.getTrialUser(u);
  if (existing) {
    return {
      ok: true, already: true, uin: u,
      trialStartAt: existing.trialStartAt,
      trialExpiresAt: existing.trialExpiresAt,
      status: existing.status,
    };
  }

  const months = (opts.months != null)
    ? (Number.isFinite(parseInt(opts.months, 10)) ? parseInt(opts.months, 10) : config.months)
    : config.months;
  const monthsFinal = months > 0 ? months : config.months;
  const now = Date.now();
  const record = {
    uin: u,
    trialStartAt: now,
    // 按月近似 30 天（与 PRD 试用期语义一致；临期阈值以天为单位）
    trialExpiresAt: now + monthsFinal * 30 * DAY_MS,
    status: 'active',
    grantedBy: opts.months != null ? 'admin' : 'auto',
    created_at: now,
    remindedFlags: { near7: 0, near3: 0, expired: 0 },
    // 首印提醒去重标记：0=未提醒；>0=已提醒（存首次提醒时间戳）。详见激活流程简化设计 §3.3。
    expired_print_at: 0,
    remindCount: 0,
  };
  store.saveTrialUser(record);
  return {
    ok: true, already: false, uin: u,
    trialStartAt: record.trialStartAt,
    trialExpiresAt: record.trialExpiresAt,
    status: record.status,
  };
}

/**
 * 查询某 uin 的试用状态（公开接口用）。
 * @param {object} store
 * @param {string|number} uin
 */
function trialStatusByUin(store, uin) {
  const u = String(uin);
  // [R6 R1] 会员（已转正式：存在有效激活码授权，含永久/未过期、customer 匹配）→ 固定形状 converted
  if (hasActiveLicense(store, { uin: u })) {
    return {
      ok: true, uin: u, exists: false, status: null, converted: true,
      trialStartAt: 0, trialExpiresAt: 0, remaining_ms: 0, remindCount: 0,
      expired_print_at: 0,
      message: '已转正式/无试用',
    };
  }
  const rec = store.getTrialUser(u);
  if (!rec) {
    return {
      ok: true, uin: u, exists: false, status: null,
      trialStartAt: 0, trialExpiresAt: 0, remaining_ms: 0, remindCount: 0,
    };
  }
  const now = Date.now();
  return {
    ok: true, uin: u, exists: true,
    status: rec.status,
    trialStartAt: rec.trialStartAt,
    trialExpiresAt: rec.trialExpiresAt,
    remaining_ms: Math.max(0, rec.trialExpiresAt - now),
    remindCount: rec.remindCount || 0,
    // 首印提醒去重标记（0=未提醒，>0=已提醒时间戳），供 bot 端首印提醒逻辑判定是否需发提醒
    expired_print_at: rec.expired_print_at || 0,
  };
}

/** 列出未确认的待发提醒（ack=false） */
function listPendingReminders(store) {
  const all = (store.getPendingReminders && store.getPendingReminders()) || [];
  return all.filter((r) => !r.ack);
}

/** 是否已存在某 uin+type 的未确认待发提醒（防重复入队） */
function hasPending(store, uin, type) {
  return listPendingReminders(store).some((r) => r.uin === String(uin) && r.type === type);
}

function pushPending(store, uin, type, now, out) {
  const rec = { uin: String(uin), type, due_at: now, created_at: now, ack: false };
  if (store.addPendingReminder) store.addPendingReminder(rec);
  if (out) out.push(rec);
  return rec;
}

/**
 * 标记某提醒已发：置 remindedFlags[type]=now、remindCount++，并移除该 uin+type 的待发项。
 * @param {object} store
 * @param {string|number} uin
 * @param {string} type 'near7'|'near3'|'expired'
 */
function markReminded(store, uin, type) {
  const u = String(uin);
  const rec = store.getTrialUser(u);
  if (rec) {
    rec.remindedFlags = rec.remindedFlags || { near7: 0, near3: 0, expired: 0 };
    rec.remindedFlags[type] = Date.now();
    rec.remindCount = (rec.remindCount || 0) + 1;
    if (store.saveTrialUser) store.saveTrialUser(rec);
  }
  if (store.removePendingReminder) {
    store.removePendingReminder((r) => r.uin === u && r.type === type && !r.ack);
  }
  return { ok: true };
}

/**
 * 标记「首印提醒」已发：置 expired_print_at = now（落盘，跨重启持久化）。
 * 用于 bot 端「首印提醒」去重（到期用户首次打印完成后仅提醒一次）。
 * 记录不存在时静默返回 ok（expired_print_at=0），不报错。
 *
 * @param {object} store
 * @param {string|number} uin
 * @returns {{ok:boolean, expired_print_at:number}}
 */
function markExpiredPrintReminded(store, uin) {
  const u = String(uin);
  const rec = store.getTrialUser(u);
  if (rec) {
    rec.expired_print_at = Date.now();
    if (store.saveTrialUser) store.saveTrialUser(rec);
    return { ok: true, expired_print_at: rec.expired_print_at };
  }
  return { ok: true, expired_print_at: 0 };
}

/**
 * 巡检：遍历 active 试用用户，按剩余时间产出待发提醒队列，并处理到期 / 已激活停发。
 * 由服务端 start() 内的 setInterval 周期性调用（默认 15 分钟）。
 *
 * @param {object} store
 * @param {object} cfg
 * @returns {Array<{uin:string, type:string, due_at:number, created_at:number}>} 本次新入队的提醒
 */
function scanPendingReminders(store, cfg) {
  const config = getTrialConfig(store, cfg);
  const now = Date.now();
  // nearDays 降序：最大值作为「临期大阈值(near7)」，最小值作为「临期小阈值(near3)」
  const sorted = [...config.nearDays].sort((a, b) => b - a);
  const bigDay = sorted[0] || 7;
  const smallDay = sorted[sorted.length - 1] || 3;
  const pushed = [];

  for (const u of store.listTrialUsers()) {
    if (!u || u.status !== 'active') continue;
    u.remindedFlags = u.remindedFlags || { near7: 0, near3: 0, expired: 0 };

    // [R6 R1] 已授权会员（激活码维度）→ 标记 converted 并清空待发（跳过提醒；与「已激活停发」同口径）
    if (hasActiveLicense(store, { uin: u.uin })) {
      u.status = 'converted';
      if (store.saveTrialUser) store.saveTrialUser(u);
      if (store.clearPendingRemindersForUin) store.clearPendingRemindersForUin(u.uin);
      continue;
    }

    // 已激活（命中成功订单）→ 标记 converted 并清空该 uin 的全部待发（激活即停发）
    if (isConverted(store, u.uin)) {
      u.status = 'converted';
      if (store.saveTrialUser) store.saveTrialUser(u);
      if (store.clearPendingRemindersForUin) store.clearPendingRemindersForUin(u.uin);
      continue;
    }

    const remaining = u.trialExpiresAt - now;

    // 到期
    if (remaining <= 0) {
      if (u.remindedFlags.expired === 0) {
        u.status = 'expired';
        if (store.saveTrialUser) store.saveTrialUser(u);
        if (!hasPending(store, u.uin, 'expired')) pushPending(store, u.uin, 'expired', now, pushed);
      }
      continue;
    }

    // 临期（近 smallDay 天）：小阈值窗口
    if (remaining <= smallDay * DAY_MS) {
      if (u.remindedFlags.near3 === 0 && u.remindCount < config.maxReminders && !hasPending(store, u.uin, 'near3')) {
        pushPending(store, u.uin, 'near3', now, pushed);
      }
    }
    // 临期（近 bigDay 天）：大阈值窗口
    if (remaining <= bigDay * DAY_MS) {
      if (u.remindedFlags.near7 === 0 && u.remindCount < config.maxReminders && !hasPending(store, u.uin, 'near7')) {
        pushPending(store, u.uin, 'near7', now, pushed);
      }
    }
  }
  return pushed;
}

/**
 * 可选：回写 config.env（KEY="value" 双引号格式）。失败不影响 Store（调用方已 try/catch）。
 *
 * 安全约束（P0）：
 *  1) 文件缺失时直接跳过、绝不新建 —— 避免误生成只含 Trial 键的残缺 config.env 而清空既有密钥。
 *  2) 逐行原地改写，仅替换被 patch 的键（TRIAL_MONTHS / TRIAL_DISABLED），
 *     其余行（注释、空行、以及可能多行换行的 PEM 凭证）一律原样保留，杜绝整文件重建导致的静默丢弃。
 *
 * @param {string} envPath 绝对路径
 * @param {{months?:number, disabled?:boolean}} patch
 */
function rewriteConfigEnv(envPath, patch) {
  if (!fs.existsSync(envPath)) return { ok: false, skipped: true, reason: 'missing' };
  const text = fs.readFileSync(envPath, 'utf8');
  const lines = text.split(/\r?\n/);
  // 裁剪 split 产生的尾部空串（代表原结尾换行、非内容行），避免每次改写都额外追加空行导致文件永久膨胀
  if (lines.length && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  const patchKeys = {};
  if (patch.months != null) patchKeys.TRIAL_MONTHS = String(patch.months);
  if (patch.disabled != null) patchKeys.TRIAL_DISABLED = patch.disabled ? '1' : '';
  const kvRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/;
  const touched = {};
  const out = lines.map((line) => {
    const mm = line.match(kvRe);
    if (mm && Object.prototype.hasOwnProperty.call(patchKeys, mm[1])) {
      touched[mm[1]] = true;
      return `${mm[1]}="${patchKeys[mm[1]]}"`;
    }
    return line; // 非目标键：原样保留（含注释/空行/多行 PEM）
  });
  // 文件中不存在的被 patch 键，追加到末尾
  for (const k of Object.keys(patchKeys)) {
    if (!touched[k]) out.push(`${k}="${patchKeys[k]}"`);
  }
  fs.writeFileSync(envPath, out.join('\n') + '\n');
  return { ok: true };
}

module.exports = {
  DAY_MS,
  defaultTrialConfig,
  getTrialConfig,
  updateTrialConfig,
  findOrdersByQq,
  isConverted,
  // [R6 R1] 会员判定统一口径 + 签发成功清除试用
  hasActiveLicense,
  clearTrials,
  grantTrial,
  trialStatusByUin,
  listPendingReminders,
  hasPending,
  pushPending,
  markReminded,
  markExpiredPrintReminded,
  scanPendingReminders,
  rewriteConfigEnv,
};
