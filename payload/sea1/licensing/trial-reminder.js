'use strict';
/**
 * licensing/trial-reminder.js — 试用到期主动提醒（纯逻辑，可单测）
 *
 * 设计要点（安全网）：
 *  - 仅当门禁状态为 TRIAL_EXPIRED（试用真正到期且未付费）才推送，
 *    ACTIVE(已付费)/TRIAL_ACTIVE(试用中)/DEMO_NO_LICENSE(未开试用)/OPENSOURCE 一律不触发。
 *  - 只发一次：用状态文件持久化 remindedAt，重启/重跑均幂等。
 *  - 不依赖 trial.json 的重算，直接用 gate.getStatus().status 判断，避免已付费用户被误提醒。
 *  - send 失败不影响状态机/主流程（异常被调用方或本模块吞掉）。
 *
 * 依赖：require('node:fs')、require('node:path')（均为 Node 内置，零外部依赖）。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 默认状态文件路径：尽量贴近 license 文件所在目录 */
function defaultStatePath(cfg) {
  const base = (cfg && (cfg.licensePath || cfg.machineIdPath))
    ? path.dirname(cfg.licensePath || cfg.machineIdPath)
    : '/root/sea1';
  return path.join(base, 'trial_reminder.json');
}

/** 默认提醒文案 */
function defaultReminderText(info) {
  const lines = [];
  lines.push('⏰【SEA1 试用已结束通知】');
  lines.push('感谢您体验 SEA1 机器人！您的免费试用已结束，部分高级功能已进入只读模式。');
  lines.push('');
  lines.push('想继续无限制使用？两步即可解锁：');
  lines.push('1️⃣ 发送「开通会员」，按提示选择套餐并扫码付款');
  lines.push('2️⃣ 付款后发送「已支付 <订单号>」，系统自动激活、即时解锁');
  lines.push('');
  lines.push('发送「我的会员」可随时查看当前状态。');
  return lines.join('\n');
}

/**
 * 尝试发送试用到期提醒（幂等，仅发一次）。
 * @param {object} opts
 * @param {object}  opts.gate           LicenseGate API（需有 getStatus()）
 * @param {function} opts.send          async (targetId, text, sendOpts) => void
 * @param {string[]} [opts.notifyGroups] 目标群号列表（用户可见）
 * @param {string}  [opts.superAdmin]   管理员QQ（知会用）
 * @param {string}  [opts.statePath]    状态持久化文件
 * @param {object}  [opts.cfg]          用于推导默认 statePath
 * @param {function} [opts.reminderText] (info)=>string 自定义文案
 * @returns {Promise<{sent:boolean, reason:string, at?:number, ok?:boolean}>}
 */
async function maybeSendTrialReminder(opts) {
  const { gate, send, notifyGroups = [], superAdmin = '' } = opts || {};
  if (!gate || typeof gate.getStatus !== 'function') return { sent: false, reason: 'no-gate' };
  if (typeof send !== 'function') return { sent: false, reason: 'no-send' };

  // 1) 只有门禁明确处于 TRIAL_EXPIRED 才提醒（已付费/试用中/未开试用全部跳过）
  const full = gate.getStatus();
  if (!full) return { sent: false, reason: 'no-status' };
  if (full.status !== 'TRIAL_EXPIRED') {
    return { sent: false, reason: 'not-trial-expired:' + full.status };
  }

  // 2) 已提醒过则跳过（幂等）
  const statePath = opts.statePath || defaultStatePath(opts.cfg || {});
  let state = { remindedAt: 0 };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { /* 无记录 */ }
  if (state.remindedAt) {
    return { sent: false, reason: 'already-reminded', at: state.remindedAt };
  }

  // 3) 构造文案
  const text = (typeof opts.reminderText === 'function')
    ? opts.reminderText(full)
    : defaultReminderText(full);

  // 4) 推送目标：群（用户可见）+ 管理员（知会）
  const targets = [];
  for (const g of notifyGroups) if (g) targets.push({ id: String(g), group: true });
  if (superAdmin) targets.push({ id: String(superAdmin), group: false });

  if (targets.length === 0) {
    return { sent: false, reason: 'no-targets' };
  }

  // 5) 推送；至少一条成功才算「已提醒」，否则下一轮重试（避免适配器未连好时误标记）
  let anyOk = false;
  for (const t of targets) {
    try {
      await send(t.id, text, t.group ? { groupId: t.id } : {});
      anyOk = true;
    } catch (e) {
      // 单目标失败：继续其余目标
    }
  }

  if (!anyOk) {
    return { sent: false, ok: false, reason: 'all-send-failed' };
  }

  // 6) 落盘状态（至少一条成功才标记，避免反复打扰）
  const now = Date.now();
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ remindedAt: now, status: full.status, sent: true }));
  } catch (e) { /* 状态落盘失败不致命 */ }

  return { sent: true, ok: true, at: now };
}

module.exports = { maybeSendTrialReminder, defaultReminderText, defaultStatePath };
