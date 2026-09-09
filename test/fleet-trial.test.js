'use strict';
/**
 * fleet 全新环境回归测试
 *
 * 背景（2026-09-09 实机收尾抓到）：
 *   全新环境 /etc/sea1-x86/client-code 不存在，若未提供 SEA1_ADMIN_TOKEN，
 *   旧 client-agent 会发 code=null 的"正式"心跳；中央 server.js:304
 *   `isTrialHeartbeat && body.trial !== true` → 400 trial-required → 该设备
 *   永远不出现在运维中心集群页（静默消失）。
 *
 * 本测试用一个"镜像中央判定规则"的 mock 服务端驱动真实 client-agent 二进制逻辑：
 *   A. 无 token 全新环境 → 必须走设备试用（trial:true），服务端不再 400，reason=trial-active
 *   B. 有 token          → 领码 + 激活 + 正式心跳 reason=ok（既有能力不被破坏）
 *   C. 反证             → 不带 trial 的空 code 心跳确实被中央 400 拒绝（证明 bug 真实存在）
 *
 * 运行：node test/fleet-trial.test.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'payload', 'sea2', 'client-agent', 'client-agent.js');
const ADMIN_TOKEN = 'test-admin-token-abc';
const VALID_CODE = 'SEA1-TEST-0001-ABCD';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

/** 启动 mock 中央服务端；heartbeats 收集每次心跳 body */
function startMock() {
  const beats = [];
  let trialRegistered = 0, grants = 0, activates = 0;
  const srv = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(d || '{}'); } catch (e) { /* noop */ }
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const p = req.url.split('?')[0];

      if (p === '/api/admin/console/grant') {
        if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return send(401, { ok: false, error: 'unauthorized' });
        grants++;
        return send(200, { ok: true, code: VALID_CODE });
      }
      if (p === '/api/trial/status') { trialRegistered++; return send(200, { ok: true, remaining_ms: 14 * 86400000 }); }
      if (p === '/api/activate') { activates++; return send(200, { ok: true, license: { code: body.code, machine_id: body.machine_id } }); }
      if (p === '/api/heartbeat') {
        beats.push(body);
        // —— 与 payload/activation/server.js:302-306 完全一致的判定 ——
        if (!body.machine_id) return send(400, { ok: false, error: 'machine_id 必填' });
        const isTrial = !body.code;
        if (isTrial && body.trial !== true) return send(400, { ok: false, error: 'trial-required' });
        if (isTrial) return send(200, { valid: false, reason: 'trial-active', isTrial: true });
        return send(200, { valid: true, reason: 'ok' });
      }
      return send(404, { ok: false, error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, beats,
      stats: () => ({ trialRegistered, grants, activates }) }));
  });
}

/** 把 client-agent 的绝对路径改写到临时目录，避免污染宿主 /etc */
function makeSandboxCopy(tmpRoot) {
  const src = fs.readFileSync(SRC, 'utf8');
  const x86 = path.join(tmpRoot, 'etc-sea1-x86').replace(/\\/g, '/');
  const legacy = path.join(tmpRoot, 'etc-sea1').replace(/\\/g, '/');
  const codePath = path.join(tmpRoot, 'client-code-store').replace(/\\/g, '/');
  let out = src
    .replace(`const MACHINE_ID_PATH_X86 = '/etc/sea1-x86/machine-id';`, `const MACHINE_ID_PATH_X86 = '${x86}/machine-id';`)
    .replace(`const MACHINE_ID_PATH = '/etc/sea1/machine-id';`, `const MACHINE_ID_PATH = '${legacy}/machine-id';`)
    .replace(`const CODE_PATH = '/etc/sea1-x86/client-code';`, `const CODE_PATH = '${codePath}/client-code';`);
  if (out === src) throw new Error('路径常量改写失败（常量已改名？请同步本测试）');
  const f = path.join(tmpRoot, 'client-agent.sandbox.js');
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.writeFileSync(f, out);
  return { file: f, x86, codePath };
}

/** 跑一次 client-agent，等到出现首条 heartbeat 日志或超时 */
function runAgent(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); resolve(buf); }, 12000);
    child.stdout.on('data', (c) => {
      buf += c.toString();
      if (/heartbeat valid=/.test(buf)) { clearTimeout(timer); setTimeout(() => child.kill(), 300); resolve(buf); }
    });
    child.stderr.on('data', (c) => { buf += c.toString(); });
    child.on('exit', () => { clearTimeout(timer); resolve(buf); });
  });
}

(async () => {
  console.log('fleet 全新环境回归测试\n');

  // ---------- C. 反证：不带 trial 的空 code 心跳会被中央拒（bug 真实存在） ----------
  {
    const m = await startMock();
    const r = await new Promise((resolve) => {
      const data = JSON.stringify({ machine_id: 'a'.repeat(64), nonce: 'x', online: true });
      const rq = http.request({ host: '127.0.0.1', port: m.port, path: '/api/heartbeat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      rq.end(data);
    });
    ok('C 反证：code 为空且无 trial:true → 中央返回 400 trial-required（旧实现必踩）',
      r.status === 400 && /trial-required/.test(r.body), `实际 ${r.status} ${r.body}`);
    m.srv.close();
  }

  // ---------- A. 全新环境 + 无 ADMIN_TOKEN → 设备维度试用 ----------
  {
    const m = await startMock();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-a-'));
    const sb = makeSandboxCopy(tmp);
    const log = await runAgent(sb.file, {
      SEA1_ACTIVATION_URL: `http://127.0.0.1:${m.port}`,
      SEA1_ADMIN_TOKEN: '',
    });
    console.log('  ---- agent 输出 ----\n' + log.split('\n').map((l) => '    ' + l).join('\n'));
    const b = m.beats[0] || {};
    ok('A1 无 token 时不尝试领码（不污染中央发码）', m.stats().grants === 0, `grants=${m.stats().grants}`);
    ok('A2 已注册设备维度试用', m.stats().trialRegistered >= 1, `trialRegistered=${m.stats().trialRegistered}`);
    ok('A3 心跳带 trial:true（不再 400）', b.trial === true, JSON.stringify(b));
    ok('A4 心跳未带空 code', !('code' in b) || b.code === undefined || b.code === null, JSON.stringify(b.code));
    ok('A5 服务端返回 trial-active', /reason=trial-active/.test(log), log.slice(-300));
    ok('A6 无 trial-required 400', !/trial-required/.test(log));
    m.srv.close();
  }

  // ---------- B. 有 ADMIN_TOKEN → 领码/激活/正式心跳（既有能力不回归） ----------
  {
    const m = await startMock();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-b-'));
    const sb = makeSandboxCopy(tmp);
    const log = await runAgent(sb.file, {
      SEA1_ACTIVATION_URL: `http://127.0.0.1:${m.port}`,
      SEA1_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    console.log('  ---- agent 输出 ----\n' + log.split('\n').map((l) => '    ' + l).join('\n'));
    const b = m.beats[0] || {};
    ok('B1 已领码', m.stats().grants === 1 && /code=SEA1-TEST-0001-ABCD/.test(log));
    ok('B2 已激活（activate 200）', m.stats().activates === 1 && /activate status=200/.test(log));
    ok('B3 正式心跳带 code', b.code === VALID_CODE, JSON.stringify(b.code));
    ok('B4 formal 心跳 reason=ok', /reason=ok/.test(log), log.slice(-300));
    ok('B5 code 已持久化（重跑不重复发码）',
      fs.existsSync(path.join(sb.codePath, 'client-code')) &&
      fs.readFileSync(path.join(sb.codePath, 'client-code'), 'utf8').trim() === VALID_CODE);
    m.srv.close();
  }

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
