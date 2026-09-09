'use strict';
/**
 * trialNotify.js — 新用户试用期「柔软提醒」文案与主动私聊调度
 *
 * 职责（与 vip_core 解耦）：
 *   - reminderText(type, {剩余天数, 到期日期})：按 type 生成四版礼貌文案（PRD 四版）；
 *   - runReminderTick({server, monitorToken, sendPrivateMsg})：拉取待发提醒 → 生成文案
 *     → 经 QQ 适配器主动私聊 → 标记已发。
 * 仅依赖 Node 内置 + vip_core；core 与 sendPrivateMsg 均可在测试中 mock。
 */

const core = require('./vip_core');

/**
 * 生成柔软提醒文案（PRD 四版，按 type 映射）。
 * @param {'near7'|'near3'|'expired'|string} type
 * @param {{剩余天数?:number|string, 到期日期?:string}} [vars]
 * @returns {string[]} 多行文案（调用方用 \n 连接）
 */
function reminderText(type, vars = {}) {
  const 剩余天数 = (vars && vars.剩余天数 != null) ? vars.剩余天数 : '';
  const 到期日期 = (vars && vars.到期日期 != null) ? vars.到期日期 : '';
  switch (type) {
    case 'near7':
      return [
        `您好，您的 SEAI 试用期将于 ${剩余天数} 天后结束。`,
        '这段时间感谢您的使用与陪伴🌿',
        '如果您觉得体验不错，随时发送「激活」即可获取专属开通方式，安全、透明、无套路。',
      ];
    case 'near3':
      return [
        '悄悄提醒您：您的 SEAI 试用即将到期（还剩 ' + 剩余天数 + ' 天）。',
        '我们不想打扰您，只是希望您知道——随时发送「激活」即可获取安全、透明的开通指引。',
      ];
    case 'expired':
      return [
        '您好，您的 SEAI 试用期已经结束啦。感谢您此前的尝试与信任🌿',
        '您随时可以发送「激活」开启正式会员，享受全功能与优先支持。',
        '我们尊重您的节奏，不催促、不打扰。',
      ];
    default:
      return ['您的 SEAI 试用有新的状态更新，发送「激活」可了解开通方式。'];
  }
}

/**
 * 计算文案变量（剩余天数 / 到期日期）。
 * @param {{trialExpiresAt?:number, remaining_ms?:number}} info
 * @returns {{剩余天数:number, 到期日期:string}}
 */
function buildReminderVars(info = {}) {
  const expiresAt = info.trialExpiresAt
    || (info.remaining_ms != null ? Date.now() + info.remaining_ms : 0);
  const remaining_ms = info.remaining_ms != null
    ? info.remaining_ms
    : Math.max(0, expiresAt - Date.now());
  const 剩余天数 = Math.ceil((remaining_ms || 0) / 86400000);
  const 到期日期 = expiresAt ? new Date(expiresAt).toLocaleDateString() : '';
  return { 剩余天数, 到期日期 };
}

/**
 * 执行一轮提醒巡检（被插件定时器每 5 分钟调用；实际发送频率由服务端扫描与去重控制）。
 * @param {object} params
 * @param {string} params.server        激活服务器地址
 * @param {string} params.monitorToken  监控 token（x-monitor-token）
 * @param {Function} params.sendPrivateMsg 主动私聊：(uin, text) => Promise|void
 * @returns {Promise<{processed:number, ok:number, failed:number, skipped:number}>}
 */
async function runReminderTick(params) {
  const { server, monitorToken, sendPrivateMsg } = params || {};
  const result = { processed: 0, ok: 0, failed: 0, skipped: 0 };
  if (typeof sendPrivateMsg !== 'function') return result;

  let pending = [];
  try {
    const r = await core.pullPendingReminders(server, monitorToken);
    pending = (r && r.body && Array.isArray(r.body.items)) ? r.body.items : [];
  } catch (e) {
    console.warn('[trialNotify] 拉取待发提醒失败（已忽略）:', (e && e.message) || e);
    return result;
  }

  for (const item of pending) {
    result.processed++;
    try {
      // 查询该用户最新状态以填充文案变量（失败则用兜底变量）
      let info = { trialExpiresAt: 0, remaining_ms: 0 };
      try {
        const st = await core.trialStatusByUin(server, item.uin);
        if (st && st.body && st.body.ok) {
          // [R6 R1] 已转正式（converted）→ 跳过：不发送、不 mark（防发 + 防重复 mark）
          if (st.body.converted) {
            result.skipped++;
            continue;
          }
          info = st.body;
        }
      } catch (_) { /* 忽略查询失败 */ }
      const vars = buildReminderVars(info);
      const text = reminderText(item.type, vars).join('\n');
      await sendPrivateMsg(String(item.uin), text);
      await core.markReminded(server, { uin: item.uin, type: item.type }, monitorToken);
      result.ok++;
    } catch (e) {
      result.failed++;
      console.warn(`[trialNotify] 发送提醒失败 uin=${item.uin} type=${item.type}（已忽略）:`, (e && e.message) || e);
    }
  }
  return result;
}

module.exports = { reminderText, buildReminderVars, runReminderTick };
