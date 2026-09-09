'use strict';
/**
 * sea2 fleet-client —— 让真实的 sea1 bot（镜像到 /root/sea2）在控制台集群 Tab 中
 * 以"真实 X86 客户端"身份出现。复用 bot 的真实机器码 /etc/sea1/machine-id。
 * 仅负责 activate + 周期 heartbeat（与 bot 自身的 license 心跳互补，不冲突）。
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const SERVER = process.env.SEA1_ACTIVATION_URL || 'http://127.0.0.1:3457';
const ADMIN_TOKEN = process.env.SEA1_ADMIN_TOKEN || '';
// [2026-08-08 FIX] 专用机器码文件：/etc/sea1-x86/machine-id（内容为激活绑定的 64 位机器码，直接使用；
// 兼容旧版 UUID 内容 → HMAC 派生）。回退读取 /etc/sea1/machine-id（bot 持久化 UUID → HMAC 派生）。
// 绝不写入 /etc/sea1/machine-id：那是 sea1 bot 自身的授权机器码，改写会导致 bot 授权失配。
const MACHINE_ID_PATH_X86 = '/etc/sea1-x86/machine-id';
const MACHINE_ID_PATH = '/etc/sea1/machine-id';
const CODE_PATH = '/etc/sea1-x86/client-code';
const VERSION = 'sea1-x86-client-1.0.0';
const REGION = 'cn-east';
const PRINTERS = [{ name: 'X86-Sea1-Client', status: 'online' }];
// 与 bot(licensing/lib/machineId.js) 完全一致：HMAC_SHA256(persistent, SECRET_SEED)
const SECRET_SEED = 'sea1-machine-seed-v1-replace-in-obfuscated-build';

function getMachineId() {
  // ① 专用文件优先：内容为 64 位 hex → 直接返回；UUID → HMAC 派生
  try {
    if (fs.existsSync(MACHINE_ID_PATH_X86)) {
      const v = fs.readFileSync(MACHINE_ID_PATH_X86, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
      if (v) return crypto.createHmac('sha256', SECRET_SEED).update(v, 'utf8').digest('hex');
    }
  } catch (e) { /* 读取失败回落 */ }
  // ② 回退：bot 持久化 UUID（只读，绝不写 /etc/sea1/machine-id）→ HMAC 派生
  let persistent = '';
  try { if (fs.existsSync(MACHINE_ID_PATH)) persistent = fs.readFileSync(MACHINE_ID_PATH, 'utf8').trim(); } catch (e) { persistent = ''; }
  if (!persistent) {
    persistent = crypto.randomUUID();
    try {
      fs.mkdirSync(require('path').dirname(MACHINE_ID_PATH_X86), { recursive: true });
      fs.writeFileSync(MACHINE_ID_PATH_X86, persistent, { mode: 0o600 });
    } catch (e) { /* 写失败忽略 */ }
  }
  return crypto.createHmac('sha256', SECRET_SEED).update(persistent, 'utf8').digest('hex');
}
function getCode() {
  if (fs.existsSync(CODE_PATH)) return fs.readFileSync(CODE_PATH, 'utf8').trim();
  return null;
}
function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function grantCode() {
  try {
    const r = await req('POST', '/api/admin/console/grant', { qq: '1000000001', plan: 'quarter' }, { 'x-admin-token': ADMIN_TOKEN });
    const j = JSON.parse(r.body || '{}');
    return j.code || (j.data && j.data.code) || null;
  } catch (e) {
    console.log('[sea2-fleet] grant err', e.message);
    return null;
  }
}
async function activate(mid, code) {
  return req('POST', '/api/activate', { machine_id: mid, code });
}
async function heartbeat(mid, code) {
  const payload = {
    machine_id: mid,
    code,
    nonce: crypto.randomBytes(8).toString('hex'),
    online: true,
    version: VERSION,
    region: REGION,
    public_ip: '',
    cpu_usage: 0,
    mem_usage: 0,
    boot_time: Date.now(),
    client_ts: Date.now(),
    printers: PRINTERS,
  };
  return req('POST', '/api/heartbeat', payload);
}
(async () => {
  const mid = getMachineId();
  let code = getCode();
  if (!code) {
    code = await grantCode();
    if (code) fs.writeFileSync(CODE_PATH, code);
  }
  if (code) {
    try {
      const a = await activate(mid, code);
      console.log('[sea2-fleet] activate status=%s', a.status);
    } catch (e) {
      console.log('[sea2-fleet] activate err', e.message);
    }
  }
  console.log('[sea2-fleet] machine_id=%s code=%s', mid, code);
  await heartbeat(mid, code).catch(() => {});
  setInterval(async () => {
    try {
      const r = await heartbeat(mid, code);
      const j = JSON.parse(r.body || '{}');
      console.log('[sea2-fleet] heartbeat valid=%s reason=%s', j.valid, j.reason);
    } catch (e) {
      console.log('[sea2-fleet] heartbeat err', e.message);
    }
  }, 30000);
})();
