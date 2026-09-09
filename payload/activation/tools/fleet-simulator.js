'use strict';
/**
 * tools/fleet-simulator.js — FLEET 外网客户端流量模拟器（开发/联调用，不进生产包）
 *
 * 生成 N 个模拟客户端，向激活服务器持续发送「富化心跳」（含 version / cpu_usage /
 * mem_usage / boot_time / region / printers 等扩展字段），并执行服务端下发的远程指令
 * （通过下次心跳携带 ack_id 回执）。用于本地联调、soak 测试、以及演示异常检测规则。
 *
 * 用法（CLI）：
 *   node tools/fleet-simulator.js --url http://127.0.0.1:3457 --count 20 --seconds 30
 *        --code REAL_CODE --shared --rapid --mismatch --bind-machine M1 --region cn-east
 *   参数：
 *     --url        激活服务地址（默认 http://127.0.0.1:3457）
 *     --count      模拟客户端数量（默认 20）
 *     --seconds    运行时长秒（默认 30）
 *     --interval   心跳间隔毫秒（默认 5000；--rapid 时强制 200）
 *     --code       统一激活码（多客户端共用以演示 code_shared 异常）
 *     --shared     所有客户端共用同一 --code（触发 code_shared）
 *     --rapid      高频心跳（200ms，触发 freq_anomaly）
 *     --mismatch   发送与 --bind-machine 不一致的机器码（触发 machine_mismatch；需配合真实绑码）
 *     --bind-machine 绑定机器码（与 --mismatch 配合）
 *     --region     统一地域
 *
 * 也可作为模块 require：const { runSimulator, makeClient, buildPayload } = require('./tools/fleet-simulator');
 */

const crypto = require('node:crypto');

function randHex(n) { return crypto.randomBytes(n).toString('hex'); }
function machineId(i) { return 'SIM-MID-' + String(i).padStart(4, '0') + '-' + randHex(3); }

/**
 * 构造一个模拟客户端描述。
 */
function makeClient(i, opts) {
  opts = opts || {};
  const mid = (opts.mismatch && opts.bindMachine)
    ? opts.bindMachine + '-WRONG'
    : machineId(i);
  return {
    machineId: mid,
    code: opts.code || ('SIM-CODE-' + randHex(4)),
    version: opts.version || ('1.0.' + (i % 5)),
    region: opts.region || (['cn-east', 'cn-north', 'cn-south'][i % 3]),
    printers: [
      { name: 'SimPrinter-' + (i % 3), status: (i % 4 === 0 ? 'disabled' : 'idle'), paperLevel: 80 },
      { name: 'SimPrinter-B', status: 'idle', paperLevel: 40 },
    ],
  };
}

/**
 * 构造一次富化心跳上报体（与服务端约定字段一致）。
 */
function buildPayload(client, seq) {
  seq = seq || 0;
  return {
    machine_id: client.machineId,
    code: client.code,
    nonce: randHex(8),
    version: client.version,
    cpu_usage: 10 + Math.floor(Math.random() * 60),
    mem_usage: 20 + Math.floor(Math.random() * 70),
    boot_time: Math.floor(Date.now() / 1000) - 3600,
    client_ts: Math.floor(Date.now() / 1000),
    region: client.region,
    online: true,
    printers: client.printers,
  };
}

/**
 * 发送单次心跳（原生 fetch，零依赖）。
 */
async function sendHeartbeat(baseUrl, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(baseUrl.replace(/\/+$/, '') + '/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return j;
  } catch (e) {
    return { error: e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 运行模拟器。
 * @param {object} opts { url, count, seconds, intervalMs, code, shared, rapid, mismatch, bindMachine, region }
 * @returns {Promise<{sent:number, errors:number, commands:number, acks:number}>}
 */
async function runSimulator(opts) {
  opts = opts || {};
  const baseUrl = opts.url || 'http://127.0.0.1:3457';
  const count = Math.max(1, parseInt(opts.count, 10) || 20);
  const seconds = Math.max(1, parseInt(opts.seconds, 10) || 30);
  const intervalMs = opts.rapid ? 200 : (parseInt(opts.intervalMs, 10) || 5000);
  const code = opts.code;

  const clients = [];
  for (let i = 0; i < count; i++) {
    clients.push(makeClient(i, {
      code: (opts.shared && code) ? code : (code || undefined),
      mismatch: opts.mismatch,
      bindMachine: opts.bindMachine,
      region: opts.region,
    }));
  }
  // 共享码：强制所有客户端使用同一 code（演示 code_shared）
  if (opts.shared && code) clients.forEach((c) => { c.code = code; });

  const stats = { sent: 0, errors: 0, commands: 0, acks: 0 };
  const ackIds = new Set();
  const deadline = Date.now() + seconds * 1000;

  console.log('[sim] 启动：' + count + ' 客户端 → ' + baseUrl +
    '，间隔 ' + intervalMs + 'ms，时长 ' + seconds + 's' +
    (opts.shared && code ? '，共享码 ' + code : '') +
    (opts.rapid ? '，[rapid]' : '') + (opts.mismatch ? '，[mismatch]' : ''));

  let iter = 0;
  while (Date.now() < deadline) {
    iter++;
    await Promise.all(clients.map(async (c) => {
      const payload = buildPayload(c, iter);
      if (ackIds.size) payload.ack_id = Array.from(ackIds).slice(0, 50);
      const res = await sendHeartbeat(baseUrl, payload);
      stats.sent++;
      if (res.error) { stats.errors++; return; }
      if (Array.isArray(res.commands)) {
        for (const cmd of res.commands) {
          stats.commands++;
          ackIds.add(cmd.id); // 模拟客户端已执行 → 回执
        }
      }
    }));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  stats.acks = ackIds.size;
  console.log('[sim] 完成：' + JSON.stringify(stats));
  return stats;
}

module.exports = { runSimulator, makeClient, buildPayload, sendHeartbeat };

// CLI 入口
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (k, def) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : def; };
  const has = (k) => argv.includes(k);
  runSimulator({
    url: get('--url', 'http://127.0.0.1:3457'),
    count: parseInt(get('--count', '20'), 10),
    seconds: parseInt(get('--seconds', '30'), 10),
    intervalMs: parseInt(get('--interval', '5000'), 10),
    code: get('--code', undefined),
    shared: has('--shared'),
    rapid: has('--rapid'),
    mismatch: has('--mismatch'),
    bindMachine: get('--bind-machine', undefined),
    region: get('--region', undefined),
  }).catch((e) => { console.error('[sim] 异常', e); process.exit(1); });
}
