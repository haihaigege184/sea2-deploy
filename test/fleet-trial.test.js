'use strict';
/**
 * fleet 全新环境回归测试
 *
 * 覆盖两个只在"真·全新环境"才暴露的中央侧地雷：
 *
 * ① server.js:302-306 —— 无 code 的心跳必须带 trial:true，否则 400 trial-required，
 *    设备永远不进运维中心集群页（静默消失）。
 * ② orders.js:157 _resolveMachineId(qq) —— 领码按客户号反查历史机器并"签发即预绑"。
 *    若所有机器共用同一个客户号（旧实现硬编码 '1000000001'），第二台起必然拿到
 *    "已绑别机"的码 → /api/activate 409「已绑定其他设备」→ 长期 machine-mismatch。
 *    修复：客户号按机器唯一 + 撞车时自动 /api/admin/ops/binding 换绑重试 + 兜底回落试用。
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

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

/**
 * 启动 mock 中央服务端（判定规则与 payload/activation 一致）
 *  - grant：按 qq 记录该客户的"历史机器"（模拟 _resolveMachineId），重复客户 → 新码预绑到历史机器
 *  - activate：码已绑别机 → 409 已绑定其他设备
 *  - ops/binding：换绑（需正确 token）
 */
function startMock() {
  const beats = [];
  const grantedQqs = [];
  const custFirstMachine = new Map();   // qq -> 首个使用该客户号的机器
  const codeBound = new Map();          // code -> 预绑机器（'' 表示未预绑）
  const st = { trialRegistered: 0, grants: 0, activates: 0, rebinds: 0 };
  let seq = 0;

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
        st.grants++;
        const qq = String(body.qq);
        grantedQqs.push(qq);
        // —— 模拟 orders.js:157 _resolveMachineId：同客户号 → 复用历史机器并预绑 ——
        const code = 'SEA1-TEST-' + String(++seq).padStart(4, '0') + '-ABCD';
        const pre = custFirstMachine.get(qq) || '';
        codeBound.set(code, pre);
        if (!custFirstMachine.has(qq)) custFirstMachine.set(qq, 'pending');
        return send(200, { ok: true, code });
      }
      if (p === '/api/admin/ops/binding') {
        if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return send(401, { ok: false, error: 'unauthorized' });
        st.rebinds++;
        codeBound.set(String(body.code), String(body.machineId));
        return send(200, { ok: true, code: body.code, before: 'other', after: body.machineId });
      }
      if (p === '/api/trial/status') { st.trialRegistered++; return send(200, { ok: true, remaining_ms: 14 * 86400000 }); }
      if (p === '/api/activate') {
        st.activates++;
        const bound = codeBound.get(String(body.code)) || '';
        if (bound && bound !== String(body.machine_id)) {
          return send(409, { ok: false, error: '激活码已绑定其他设备' });
        }
        codeBound.set(String(body.code), String(body.machine_id));
        return send(200, { ok: true, license: { code: body.code, machine_id: body.machine_id } });
      }
      if (p === '/api/heartbeat') {
        beats.push(body);
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
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, beats, grantedQqs, st }));
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

/** 指定机器指纹后跑一次 client-agent，等到出现首条 heartbeat 日志或超时 */
function runAgent(file, env, machineIdHex) {
  const dir = path.dirname(path.dirname(file));
  const x86Dir = path.join(path.dirname(file), 'etc-sea1-x86');
  fs.mkdirSync(x86Dir, { recursive: true });
  fs.writeFileSync(path.join(x86Dir, 'machine-id'), machineIdHex);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); resolve(buf); }, 12000);
    child.stdout.on('data', (c) => {
      buf += c.toString();
      if (/首次心跳/.test(buf)) { clearTimeout(timer); setTimeout(() => child.kill(), 300); resolve(buf); }
    });
    child.stderr.on('data', (c) => { buf += c.toString(); });
    child.on('exit', () => { clearTimeout(timer); resolve(buf); });
  });
}

const mid = (n) => n.toString(16).padStart(2, '0').repeat(32);

(async () => {
  console.log('fleet 全新环境回归测试\n');

  // ---------- C. 反证：不带 trial 的空 code 心跳会被中央拒 ----------
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
    ok('C 反证：code 为空且无 trial:true → 400 trial-required（旧实现必踩）',
      r.status === 400 && /trial-required/.test(r.body), `实际 ${r.status} ${r.body}`);
    m.srv.close();
  }

  // ---------- A. 全新环境 + 无 ADMIN_TOKEN → 设备维度试用 ----------
  {
    const m = await startMock();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-a-'));
    const sb = makeSandboxCopy(tmp);
    const log = await runAgent(sb.file, { SEA1_ACTIVATION_URL: `http://127.0.0.1:${m.port}`, SEA1_ADMIN_TOKEN: '' }, mid(1));
    console.log('  ---- agent 输出 ----\n' + log.split('\n').map((l) => '    ' + l).join('\n'));
    const b = m.beats[0] || {};
    ok('A1 无 token 时不尝试领码（不污染中央发码）', m.st.grants === 0, `grants=${m.st.grants}`);
    ok('A2 已注册设备维度试用', m.st.trialRegistered >= 1);
    ok('A3 心跳带 trial:true（不再 400）', b.trial === true, JSON.stringify(b));
    ok('A4 心跳未带空 code', !('code' in b) || b.code === undefined || b.code === null);
    ok('A5 服务端返回 trial-active', /reason=trial-active/.test(log));
    ok('A6 无 trial-required 400', !/trial-required/.test(log));
    m.srv.close();
  }

  // ---------- B. 有 ADMIN_TOKEN → 领码/激活/正式心跳 ----------
  {
    const m = await startMock();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-b-'));
    const sb = makeSandboxCopy(tmp);
    const log = await runAgent(sb.file, { SEA1_ACTIVATION_URL: `http://127.0.0.1:${m.port}`, SEA1_ADMIN_TOKEN: ADMIN_TOKEN }, mid(2));
    console.log('  ---- agent 输出 ----\n' + log.split('\n').map((l) => '    ' + l).join('\n'));
    const b = m.beats[0] || {};
    ok('B1 已领码', m.st.grants === 1 && /code=SEA1-TEST-0001-ABCD/.test(log));
    ok('B2 已激活（activate 200）', m.st.activates === 1 && /activate status=200/.test(log));
    ok('B3 正式心跳带 code', b.code === 'SEA1-TEST-0001-ABCD', JSON.stringify(b.code));
    ok('B4 formal 心跳 reason=ok', /reason=ok/.test(log));
    ok('B5 code 已持久化（重跑不重复发码）',
      fs.existsSync(path.join(sb.codePath, 'client-code')) &&
      fs.readFileSync(path.join(sb.codePath, 'client-code'), 'utf8').trim() === 'SEA1-TEST-0001-ABCD');
    ok('B6 默认客户号按机器唯一（x86-<mid 前16位>）',
      m.grantedQqs.length === 1 && /^x86-[0-9a-f]{16}$/.test(m.grantedQqs[0]), m.grantedQqs.join(','));
    m.srv.close();
  }

  // ---------- D. 两台不同机器，各自默认客户号 → 互不撞车（② 的主修复） ----------
  {
    const m = await startMock();
    const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-d1-'));
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-d2-'));
    const sb1 = makeSandboxCopy(tmp1);
    const sb2 = makeSandboxCopy(tmp2);
    const env = { SEA1_ACTIVATION_URL: `http://127.0.0.1:${m.port}`, SEA1_ADMIN_TOKEN: ADMIN_TOKEN };
    const log1 = await runAgent(sb1.file, env, mid(3));
    const log2 = await runAgent(sb2.file, env, mid(4));
    ok('D1 两台机器领到不同的客户号', new Set(m.grantedQqs).size === 2, m.grantedQqs.join(','));
    ok('D2 第一台激活成功', /activate status=200/.test(log1), log1.slice(-200));
    ok('D3 第二台激活成功（不再 409 已绑定其他设备）', /activate status=200/.test(log2), log2.slice(-200));
    ok('D4 全程无换绑（说明根本没撞车）', m.st.rebinds === 0, `rebinds=${m.st.rebinds}`);
    m.srv.close();
  }

  // ---------- E. 兜底：强制共用客户号撞车 → 自动换绑后仍要成功 ----------
  {
    const m = await startMock();
    const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-e1-'));
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sea2-fleet-e2-'));
    const sb1 = makeSandboxCopy(tmp1);
    const sb2 = makeSandboxCopy(tmp2);
    const env = { SEA1_ACTIVATION_URL: `http://127.0.0.1:${m.port}`, SEA1_ADMIN_TOKEN: ADMIN_TOKEN, SEA2_FLEET_CUSTOMER: '1000000001' };
    const log1 = await runAgent(sb1.file, env, mid(5));
    const log2 = await runAgent(sb2.file, env, mid(6));
    console.log('  ---- 第二台输出（撞车+换绑）----\n' + log2.split('\n').map((l) => '    ' + l).join('\n'));
    ok('E1 第一台正常激活', /activate status=200/.test(log1));
    ok('E2 第二台确实撞上"已绑定其他设备"', /已绑定其他设备/.test(log2), log2.slice(-300));
    ok('E3 自动走运维换绑', m.st.rebinds === 1, `rebinds=${m.st.rebinds}`);
    ok('E4 换绑后激活成功', /换绑后激活成功/.test(log2) || /activate status=200/.test(log2));
    ok('E5 最终心跳 valid=true（不再 machine-mismatch）', /valid=true reason=ok/.test(log2), log2.slice(-300));
    m.srv.close();
  }

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
