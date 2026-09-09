'use strict';
/**
 * trials.js — 试用周期跟踪（按 machine_id）
 *
 * 商业模型：
 *   - 新安装的 sea1 进入试用，trialDays 天内全功能可用。
 *   - 试用期内：LicenseGate 视为 ACTIVE（全放行）。
 *   - 试用到期且仍未激活：降级为只读，并触发机器人付费提醒。
 *   - 一旦激活（拿到有效 license），试用状态即无意义，由 LicenseGate 主导。
 *
 * 试用起点持久化在激活服务器（与机器码绑定），保证重装/重置后仍从首次安装计时。
 *
 * [R6 R1] 机器维度排除：已授权机器（存在有效激活码绑定本机）不再创建/返回试用——
 *   ensureTrial 返回 null（不落盘）；trialStatus 返回 authorized 标记形状（不创建）。
 */

/**
 * 该机器是否已授权（存在 status=active 且 bound_machine_id=本机的有效激活码；
 * expires_at 永久(0) 或未过期）。与 lib/trial.js hasActiveLicense 机器维度同口径。
 * @param {object} store
 * @param {string} machineId
 * @returns {boolean}
 */
function isAuthorizedMachine(store, machineId) {
  if (!machineId) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return store.listCodes().some((c) => {
    if (!c || c.status !== 'active') return false;
    if (c.bound_machine_id == null || String(c.bound_machine_id) !== String(machineId)) return false;
    const exp = c.expires_at;
    return exp == null || Number(exp) === 0 || Number(exp) > nowSec;
  });
}

function ensureTrial(store, machineId, trialDays) {
  // [R6 R1] 已授权机器 → 不创建试用（返回 null；调用方须容忍 null）
  if (isAuthorizedMachine(store, machineId)) return null;
  let t = store.getTrial(machineId);
  if (!t) {
    t = {
      machine_id: machineId,
      start: Date.now(),
      days: trialDays,
      reminded_at: 0,
    };
    store.saveTrial(t);
  } else if (typeof t.days !== 'number') {
    t.days = trialDays;
    store.saveTrial(t);
  }
  return t;
}

function trialStatus(store, machineId, trialDays) {
  // [R6 R1] 已授权机器 → 返回 authorized 标记形状（不创建、不返回试用倒计时）
  if (isAuthorizedMachine(store, machineId)) {
    return {
      machine_id: machineId,
      authorized: true,
      exists: false,
      start: 0,
      days: 0,
      end: 0,
      expired: false,
      remaining_ms: 0,
      reminded_at: 0,
    };
  }
  const t = store.getTrial(machineId) || ensureTrial(store, machineId, trialDays);
  if (!t) {
    // ensureTrial 返回 null（已授权）理论不会到达；防御性兜底
    return {
      machine_id: machineId,
      authorized: true,
      exists: false,
      start: 0,
      days: 0,
      end: 0,
      expired: false,
      remaining_ms: 0,
      reminded_at: 0,
    };
  }
  const end = t.start + t.days * 86400000;
  const now = Date.now();
  const expired = now >= end;
  return {
    machine_id: machineId,
    start: t.start,
    days: t.days,
    end,
    expired,
    remaining_ms: Math.max(0, end - now),
    reminded_at: t.reminded_at || 0,
  };
}

function markReminded(store, machineId) {
  const t = store.getTrial(machineId);
  if (t) {
    t.reminded_at = Date.now();
    store.saveTrial(t);
  }
}

/**
 * 判断现在是否应当触发提醒（到期且距上次提醒超过 cooldownMs）。
 */
function shouldRemind(store, machineId, trialDays, cooldownMs) {
  const st = trialStatus(store, machineId, trialDays);
  if (!st.expired) return false;
  if (st.reminded_at && Date.now() - st.reminded_at < (cooldownMs || 0)) return false;
  return true;
}

module.exports = { ensureTrial, trialStatus, markReminded, shouldRemind, isAuthorizedMachine };
