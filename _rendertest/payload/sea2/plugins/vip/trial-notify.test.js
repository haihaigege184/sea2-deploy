'use strict';
/**
 * trial-notify.test.js — plugins/vip/trialNotify.js 单测（core 与 sendPrivateMsg 均 mock）
 * 覆盖：reminderText 三版文案、runReminderTick 拉取→私聊→标记已发、失败不影响其余。
 * 运行：node --test trial-notify.test.js （在 plugins/vip/ 目录）
 */
const test = require('node:test');
const assert = require('node:assert');

const core = require('./vip_core');
const { reminderText, buildReminderVars, runReminderTick } = require('./trialNotify');

// ---- mock core 接口（trialNotify 与测试 require 同一 vip_core 模块实例，patch 生效）----
const calls = { mark: 0, status: 0 };
function installMock(items) {
  calls.mark = 0; calls.status = 0;
  core.pullPendingReminders = async () => ({ ok: true, body: { ok: true, items } });
  core.markReminded = async () => { calls.mark++; return { ok: true }; };
  core.trialStatusByUin = async () => {
    calls.status++;
    return { ok: true, body: { ok: true, exists: true, trialExpiresAt: Date.now() + 2 * 86400000, remaining_ms: 2 * 86400000 } };
  };
}

test('reminderText：near7 含剩余天数与 CTA', () => {
  const lines = reminderText('near7', { 剩余天数: 7, 到期日期: '2025-08-07' });
  assert.ok(lines.join('\n').includes('7 天'), 'near7 文案应包含剩余天数');
  assert.ok(lines.join('\n').includes('激活'), '应包含 CTA「激活」');
});

test('reminderText：expired 温和收尾不施压', () => {
  const lines = reminderText('expired', { 剩余天数: 0, 到期日期: '2025-08-01' });
  assert.ok(lines.length >= 1);
  assert.ok(lines.join('\n').includes('激活'));
});

test('reminderText：未知 type 走兜底', () => {
  const lines = reminderText('unknown', {});
  assert.ok(Array.isArray(lines) && lines.length >= 1);
});

test('buildReminderVars：剩余天数与到期日期', () => {
  const expiresAt = Date.now() + 3 * 86400000;
  const v = buildReminderVars({ trialExpiresAt: expiresAt });
  assert.strictEqual(v.剩余天数, 3);
  assert.strictEqual(typeof v.到期日期, 'string');
});

test('runReminderTick：逐条私聊并标记已发', async () => {
  installMock([
    { uin: '2001', type: 'near7' },
    { uin: '2002', type: 'near3' },
  ]);
  const sent = [];
  const r = await runReminderTick({
    server: 'http://127.0.0.1:1', monitorToken: 'tok',
    sendPrivateMsg: async (uin, text) => { sent.push({ uin, text }); },
  });
  assert.strictEqual(r.processed, 2);
  assert.strictEqual(r.ok, 2);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(calls.mark, 2, '每条都应调用 markReminded');
  assert.ok(sent[0].text.includes('激活'), '私聊文案含 CTA「激活」');
});

test('runReminderTick：单条发送失败不影响其余', async () => {
  installMock([
    { uin: '2003', type: 'near7' },
    { uin: '2004', type: 'expired' },
  ]);
  const sent = [];
  const r = await runReminderTick({
    server: 'http://127.0.0.1:1', monitorToken: 'tok',
    sendPrivateMsg: async (uin, text) => {
      sent.push(uin);
      if (uin === '2003') throw new Error('send fail');
      return true;
    },
  });
  assert.strictEqual(r.processed, 2);
  assert.strictEqual(r.ok, 1);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(calls.mark, 1, '失败的条目不应 markReminded');
});

test('runReminderTick：无待发时静默返回', async () => {
  installMock([]);
  const r = await runReminderTick({
    server: 'http://127.0.0.1:1', monitorToken: 'tok',
    sendPrivateMsg: async () => { throw new Error('should not be called'); },
  });
  assert.strictEqual(r.processed, 0);
  assert.strictEqual(r.ok, 0);
});

test('runReminderTick：缺 sendPrivateMsg 直接返回 0', async () => {
  installMock([{ uin: '2005', type: 'near7' }]);
  const r = await runReminderTick({ server: 'http://127.0.0.1:1', monitorToken: 'tok' });
  assert.strictEqual(r.processed, 0);
});
