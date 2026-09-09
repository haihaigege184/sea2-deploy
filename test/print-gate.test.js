'use strict';
/* 打印门禁端到端验证：模拟激活服务端 + 直接驱动 PrintPlugin._checkPrintPerm */
const http = require('http');
const path = require('path');
const PrintPlugin = require(path.join(__dirname, 'payload/sea2/plugins/print/index.js'));

function makeServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function makePlugin(serverPort) {
  const p = Object.create(PrintPlugin.prototype);
  p._licenseCfg = {};
  p._printPermCache = new Map();
  p._graceNotifyAt = new Map();
  p._notifyLog = [];
  p.sendGroupMessage = async (gid, text) => { p._notifyLog.push({ gid, text }); };
  // 指向模拟服务端
  p._actServer = () => 'http://127.0.0.1:' + serverPort;
  return p;
}

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra: extra || '' });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (extra ? ' | ' + extra : ''));
}

(async () => {
  // 模拟激活服务端：/api/trial/user/status + /api/trial/config + /api/trial/grant
  const state = { mode: 'active' }; // active | expired | none | down
  let grantCalls = 0;
  const server = await makeServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (state.mode === 'down') { req.destroy(); return; }
      if (req.url.startsWith('/api/trial/user/status')) {
        const uin = new URL('http://x' + req.url).searchParams.get('uin');
        if (state.mode === 'none') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, exists: false, uin }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true, exists: true, uin,
          status: state.mode,
          remaining_ms: state.mode === 'active' ? 5 * 86400000 : 0,
          trialExpiresAt: state.mode === 'active' ? Date.now() + 5 * 86400000 : null,
        }));
      }
      if (req.url.startsWith('/api/trial/config')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, months: 3 }));
      }
      if (req.url.startsWith('/api/trial/grant')) {
        grantCalls++;
        const j = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, uin: j.uin, months: j.months }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  const port = server.address().port;

  // 场景 1：超管直接放行（不打服务端）
  {
    const p = makePlugin(port);
    const r = await p._checkPrintPerm({ userId: '1', groupId: 'g1', isSuper: true, isDev: false });
    check('超管放行', r.allow === true);
  }

  // 场景 2：试用中 → 放行且写缓存
  {
    state.mode = 'active';
    const p = makePlugin(port);
    const r = await p._checkPrintPerm({ userId: '222', groupId: 'g1', isSuper: false, isDev: false });
    const cached = p._printPermCache.get('222');
    check('试用中放行+缓存10min', r.allow === true && cached && cached.expireAt > Date.now());
    // 二次调用应直接命中缓存（服务端此刻挂掉也放行）
    state.mode = 'down';
    const r2 = await p._checkPrintPerm({ userId: '222', groupId: 'g1', isSuper: false, isDev: false });
    check('缓存期内服务端挂掉仍放行', r2.allow === true);
    state.mode = 'active';
  }

  // 场景 3：已到期 → 拒绝 + 引导文案
  {
    state.mode = 'expired';
    const p = makePlugin(port);
    const r = await p._checkPrintPerm({ userId: '333', groupId: 'g1', isSuper: false, isDev: false });
    check('到期拒绝', r.allow === false && Array.isArray(r.lines) && r.lines.some((l) => l.includes('开通会员')), JSON.stringify(r.lines || []).slice(0, 60));
  }

  // 场景 4：首触无记录 → 服务端授予试用 → 放行
  {
    state.mode = 'none';
    const p = makePlugin(port);
    const before = grantCalls;
    const r = await p._checkPrintPerm({ userId: '444', groupId: 'g1', isSuper: false, isDev: false });
    check('首触授予试用后放行', r.allow === true && grantCalls === before + 1, 'grantCalls=' + grantCalls);
  }

  // 场景 5：服务端不可达 → 豁免放行 + 群内通知（节流）
  {
    state.mode = 'down';
    const p = makePlugin(port);
    const r = await p._checkPrintPerm({ userId: '555', groupId: 'g9', isSuper: false, isDev: false });
    check('不可达豁免放行', r.allow === true);
    check('群内豁免通知已发', p._notifyLog.length === 1 && p._notifyLog[0].gid === 'g9', JSON.stringify(p._notifyLog));
    // 节流：10 分钟内第二次不再发
    await p._checkPrintPerm({ userId: '666', groupId: 'g9', isSuper: false, isDev: false });
    check('豁免通知10分钟节流', p._notifyLog.length === 1);
    // 不同群不受节流影响
    await p._checkPrintPerm({ userId: '777', groupId: 'g10', isSuper: false, isDev: false });
    check('不同群通知不受节流影响', p._notifyLog.length === 2);
  }

  server.close();
  const fails = results.filter((x) => !x.pass);
  console.log('\n==== 结果: ' + (results.length - fails.length) + '/' + results.length + ' PASS ====');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
