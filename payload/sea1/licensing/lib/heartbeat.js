'use strict';
/**
 * heartbeat.js — 向激活服务器发送心跳
 */
const crypto = require('node:crypto');

async function sendHeartbeat(serverUrl, payload, timeoutMs = 8000) {
  const url = serverUrl.replace(/\/+$/, '') + '/api/heartbeat';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: crypto.randomBytes(8).toString('hex'), ...payload }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: true, valid: !!j.valid, reason: j.reason || 'ok', server_time: j.server_time, license: j.license };
  } catch {
    return { ok: false, valid: false, reason: 'network' };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { sendHeartbeat };
