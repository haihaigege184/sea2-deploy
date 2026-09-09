'use strict';
/**
 * lib/dockerMgrProxy.js — 容器管理（FastOSDocker）零依赖反向代理（[R6 R4]）
 *
 * 职责（增量系统设计 R4，侦察结论见文件尾部）：
 *  - 预登录：POST {DOCKER_MGR_URL}/login {username,password} → {Code,Data:token}，会话缓存内存；
 *  - 前缀剥离：/docker-mgr/xxx → {DOCKER_MGR_URL}/xxx（含 /docker-mgr 根 → 上游 /）；
 *  - 401 重登：上游返回 401（非登录请求）→ 强制重登一次并重放（防会话过期）；
 *  - console 鉴权：复用 lib/console/auth verifyAuth（x-console-token / x-admin-token / LAN_BYPASS），
 *    兼容 iframe 无法带自定义头的场景：query ?token= 首请求透传 + Set-Cookie(sea1_console_token)
 *    供后续相对路径资产请求免鉴权（cookie 值即 console 会话/超管令牌，HttpOnly+SameSite=Lax）；
 *  - 降级页：上游不可用 / 预登录失败 → 200 text/html 渲染降级提示页（iframe 内不白屏）；
 *  - 可选 ws 升级隧道：侦察确认 FastOSDocker 终端用 `new WebSocket(ws://host/ws?container=&shell=)`，
 *    故代理根 /ws 与 /docker-mgr/ws（Upgrade: websocket 双向流转发）；
 *  - FastOSDocker 资源路径为相对路径（Vue SPA /pc/），无需 HTML 路径重写；
 *    但 app.js 启动会 `localStorage.setItem("baseURL", location.origin)`，axios 会把
 *    API 请求打到根路径 → 代理对 app.js 做定向重写：baseURL 追加 "/docker-mgr" 前缀，
 *    使登录/容器/镜像等 API 全部走 /docker-mgr/* 前缀（重写失败则安全降级为上游不可用提示）。
 *
 * 零新增 npm 依赖：仅 node:http / node:url。
 */

const http = require('node:http');
const auth = require('./console/auth');
// [R9 R1] 容器管理 HTML 自动登录注入（token 白名单校验 + 注入脚本构造）
const htmlInject = require('./htmlInject');

const MAX_BODY = 8 * 1024 * 1024;   // 转发请求体上限 8MB
const TIMEOUT_MS = 30000;           // 上游请求超时
const COOKIE_NAME = 'sea1_console_token';

// 进程内会话缓存（token 由预登录或用户经代理登录获得）
const SESSION = { token: '', at: 0 };

// FastOSDocker app.js 中 baseURL 写点的重写标记（找不到则跳过，安全降级）
const BASEURL_MARKER = 'localStorage.setItem("baseURL",Te)';
const BASEURL_REWRITE = 'localStorage.setItem("baseURL",Te+"/docker-mgr")';

/** 从 cfg（configManager SCHEMA 热更回写 config.env → loadConfig）读取上游配置 */
function cfgFrom(cfg) {
  return {
    url: (cfg && cfg.dockerMgrUrl) || process.env.DOCKER_MGR_URL || 'http://127.0.0.1:8081',
    user: (cfg && cfg.dockerMgrUser) || process.env.DOCKER_MGR_USER || 'root',
    pass: (cfg && cfg.dockerMgrPass) || process.env.DOCKER_MGR_PASS || 'root',
  };
}

/** 构造上游 URL（前缀剥离后 pathname + 保留 query） */
function upstreamUrl(cfgObj, pathname, search) {
  const base = new URL(cfgObj.url);
  base.pathname = pathname || '/';
  base.search = search || '';
  return base;
}

/** 读取原始请求体（Buffer；超限截断销毁，返回空 Buffer 防内存放大） */
function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); resolve(Buffer.alloc(0)); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 降级页（200 text/html，iframe 内可见、不白屏） */
function degradeHtml(title, lines) {
  const ls = (lines || []).map((l) => '<p>' + String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>').join('');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<title>' + String(title || '容器管理暂不可用') + '</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1420;color:#cdd6e4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
    '.box{max-width:460px;padding:28px;text-align:center}.box h2{color:#fff;margin:0 0 12px;font-size:18px}' +
    '.box p{color:#8b95a7;font-size:13px;line-height:1.7;margin:6px 0}</style></head><body>' +
    '<div class="box"><h2>⚙️ ' + String(title || '容器管理暂不可用') + '</h2>' + ls + '</div></body></html>';
}

/** 从 Cookie 头解析指定 cookie 值 */
function parseCookie(cookieHeader, name) {
  const parts = String(cookieHeader || '').split(';');
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    if (p.slice(0, eq).trim() === name) return decodeURIComponent(p.slice(eq + 1).trim());
  }
  return '';
}

/**
 * [R6 R4] console 鉴权（同 consoleApi 口径：x-console-token / x-admin-token / LAN_BYPASS），
 * 另兼容 iframe 场景：query ?token=（首请求）与 sea1_console_token cookie（资产请求）。
 * @returns {{ok:boolean, token?:string, status?:number, error?:string, cookie?:string}}
 */
function resolveAuth(req, cfg, url) {
  const qTok = url.searchParams.get('token') ? String(url.searchParams.get('token')) : '';
  const cookieTok = parseCookie(req.headers.cookie, COOKIE_NAME);

  // 1) 既有 header 直接鉴权（含 LAN_BYPASS 同口径）
  const a1 = auth.verifyAuth(req, cfg, 0);
  if (a1.ok) return { ok: true, token: headerCredential(req), cookie: headerCredential(req) };

  // 2) query token：命中 console 会话或超管令牌
  if (qTok && isCredentialValid(cfg, qTok)) return { ok: true, token: qTok, cookie: qTok };

  // 3) cookie：命中 console 会话（未过期）或超管令牌
  if (cookieTok && isCredentialValid(cfg, cookieTok)) return { ok: true, token: cookieTok, cookie: cookieTok };

  // 4) query token 兜底：注入 header 再走 verifyAuth（覆盖会话/超管/LAN 判定）
  if (qTok) {
    const fakeReq = { headers: Object.assign({}, req.headers, { 'x-console-token': qTok }), socket: req.socket };
    const a2 = auth.verifyAuth(fakeReq, cfg, 0);
    if (a2.ok) return { ok: true, token: qTok, cookie: qTok };
    const fakeReq2 = { headers: Object.assign({}, req.headers, { 'x-admin-token': qTok }), socket: req.socket };
    const a3 = auth.verifyAuth(fakeReq2, cfg, 0);
    if (a3.ok) return { ok: true, token: qTok, cookie: qTok };
  }

  return { ok: false, status: a1.status || 401, error: a1.error || '未登录' };
}

/** 凭证是否有效：console 会话（未过期）或等于超管令牌 */
function isCredentialValid(cfg, tok) {
  if (!tok) return false;
  if (auth.sessions.has(tok)) {
    const s = auth.sessions.get(tok);
    if (s.expiresAt > Date.now()) return true;
    auth.sessions.delete(tok);
    return false;
  }
  if (cfg && cfg.adminToken && tok === cfg.adminToken) return true;
  return false;
}

/** 从 header 提取当前凭证（用于 Set-Cookie；无则空） */
function headerCredential(req) {
  if (req.headers['x-console-token']) return String(req.headers['x-console-token']);
  if (req.headers['x-admin-token']) return String(req.headers['x-admin-token']);
  return '';
}

/** 上游原始 HTTP 请求（buffer 全量响应，供 401 重放/降级判断） */
function httpReq(urlObj, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const r = http.request(urlObj, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers || {},
        body: Buffer.concat(chunks),
      }));
      res.on('error', (e) => resolve({ error: e }));
    });
    r.on('error', (e) => resolve({ error: e }));
    r.setTimeout(opts.timeout || TIMEOUT_MS, () => { r.destroy(new Error('timeout')); });
    if (opts.body && opts.body.length) r.write(opts.body);
    r.end();
  });
}

/**
 * 预登录（幂等缓存；force=true 强制重登）。
 * FastOSDocker 登录机制（实测确认 2026-08-05）：POST /login
 *   Content-Type: application/x-www-form-urlencoded
 *   body: username=xxx&password=xxx（表单格式，非 JSON！JSON 会返回「登陆信息不能为空」）
 *   → {Code:200, Msg, Data:<JWT token>}，后续请求 Authorization: Bearer <token>。
 * @returns {{ok:boolean, token?:string, error?:string}}
 */
async function doLogin(cfgObj, force) {
  if (!force && SESSION.token) return { ok: true, token: SESSION.token };
  const urlObj = upstreamUrl(cfgObj, '/login', '');
  // 表单编码（与浏览器登录请求完全一致）
  const body = Buffer.from(
    'username=' + encodeURIComponent(String(cfgObj.user || '')) +
    '&password=' + encodeURIComponent(String(cfgObj.pass || ''))
  );
  const r = await httpReq(urlObj, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(body.length),
      'Accept': 'application/json',
    },
    body,
    timeout: 10000,
  });
  if (r.error) return { ok: false, error: 'login request failed: ' + (r.error && r.error.message || r.error) };
  let data = {};
  try { data = JSON.parse(r.body.toString('utf8') || '{}'); } catch (e) { data = {}; }
  // FastOSDocker: { Code:200, Msg, Data: token }；兼容小写 data/token
  const codeOk = data.Code === undefined || data.Code === null || Number(data.Code) === 200;
  if (r.status >= 200 && r.status < 300 && codeOk) {
    const token = data.Data || data.data || data.token || data.access_token || '';
    if (token) {
      SESSION.token = String(token);
      SESSION.at = Date.now();
      return { ok: true, token: SESSION.token };
    }
  }
  return { ok: false, status: r.status, error: data.Msg || data.msg || ('预登录失败（HTTP ' + r.status + '）') };
}

/** 转发头：去掉 hop-by-hop 与 Host，附加上游 Host 与可选 Bearer token */
function buildHeaders(reqHeaders, upstream, attachToken) {
  const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
  const out = {};
  for (const k of Object.keys(reqHeaders)) {
    if (hop.indexOf(k.toLowerCase()) >= 0) continue;
    if (k.toLowerCase() === 'host') continue;
    out[k] = reqHeaders[k];
  }
  out.host = upstream.host;
  if (attachToken && SESSION.token && !out.authorization) out.authorization = 'Bearer ' + SESSION.token;
  return out;
}

/** 是否 WebSocket 升级请求 */
function isWsRequest(req) {
  return !!(req.headers.upgrade && /websocket/i.test(String(req.headers.upgrade)));
}

/** WebSocket 升级隧道（双向流转发；仅支持单 socket，失败即断开） */
function proxyWs(req, res, upstream, cfgObj) {
  // ws 升级必须保留 connection/upgrade 头（buildHeaders 会剥离 hop-by-hop，这里不走它）
  const headers = {};
  for (const k of Object.keys(req.headers)) {
    if (k.toLowerCase() === 'host') continue;
    headers[k] = req.headers[k];
  }
  headers.host = upstream.host;
  if (SESSION.token && !headers.authorization) headers.authorization = 'Bearer ' + SESSION.token;
  const r = http.request(upstream, { method: req.method || 'GET', headers });
  r.on('upgrade', (upRes, upSocket, upHead) => {
    if (upSocket) {
      res.writeHead(101, upRes.headers);
      if (upHead && upHead.length) upSocket.unshift(upHead);
      // 上游 → 客户端：upSocket 可读 → res 可写
      upSocket.pipe(res);
      // 客户端 → 上游：req 可读 → upSocket 可写（res 是 ServerResponse 仅可写，不能 pipe 出去）
      req.pipe(upSocket);
      upSocket.on('error', () => { try { res.end(); } catch (e) { /* ignore */ } });
      res.on('error', () => { try { upSocket.destroy(); } catch (e) { /* ignore */ } });
      req.on('error', () => { try { upSocket.destroy(); } catch (e) { /* ignore */ } });
    } else {
      try { res.end(); } catch (e) { /* ignore */ }
    }
  });
  r.on('error', (e) => {
    try { res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(degradeHtml('容器管理 WebSocket 不可用', ['无法连接上游 ws 服务：' + (e && e.message || e)])); } catch (e2) { /* ignore */ }
  });
  // 握手请求无 body；客户端帧数据在 101 后经 req.pipe(upSocket) 流转
  r.end();
}

/**
 * [R6 R4] WebSocket 升级入口（server.js http.Server 'upgrade' 事件转发）。
 * 与 handle() 不同，这里直接操作底层 socket（node 只在存在 upgrade 监听时正确升级）。
 * @param {object} req  IncomingMessage
 * @param {object} socket 底层 TCP socket
 * @param {Buffer} head 升级前已读到的数据
 * @param {URL} url
 * @param {object} cfg
 */
function handleUpgrade(req, socket, head, url, cfg) {
  const a = resolveAuth(req, cfg, url);
  if (!a.ok) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n\r\n' + JSON.stringify({ ok: false, error: a.error || '未登录' }));
    } catch (e) { /* ignore */ }
    try { socket.destroy(); } catch (e) { /* ignore */ }
    return;
  }
  const cfgObj = cfgFrom(cfg);
  let targetPath = url.pathname;
  if (targetPath === '/docker-mgr' || targetPath.startsWith('/docker-mgr/')) {
    targetPath = targetPath.replace(/^\/docker-mgr\/?/, '') || '/';
  }
  const upstream = upstreamUrl(cfgObj, targetPath, url.search);
  const headers = {};
  for (const k of Object.keys(req.headers)) {
    if (k.toLowerCase() === 'host') continue;
    headers[k] = req.headers[k];
  }
  headers.host = upstream.host;
  if (SESSION.token && !headers.authorization) headers.authorization = 'Bearer ' + SESSION.token;
  const r = http.request(upstream, { method: req.method || 'GET', headers });
  r.on('upgrade', (upRes, upSocket, upHead) => {
    if (!upSocket) { try { socket.destroy(); } catch (e) { /* ignore */ } return; }
    // 转发 101 与升级头
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    const hop = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade'];
    for (const k of Object.keys(upRes.headers)) {
      if (hop.indexOf(k.toLowerCase()) >= 0) continue;
      lines.push(k + ': ' + String(upRes.headers[k]));
    }
    lines.push('Connection: Upgrade');
    lines.push('Upgrade: websocket');
    lines.push('\r\n');
    try { socket.write(lines.join('\r\n')); } catch (e) { try { upSocket.destroy(); } catch (e2) { /* ignore */ } return; }
    // 客户端握手后立即发送的帧（head）→ 上游；上游立即发送的帧（upHead）→ 客户端
    if (head && head.length) { try { upSocket.write(head); } catch (e) { /* ignore */ } }
    if (upHead && upHead.length) { try { socket.write(upHead); } catch (e) { /* ignore */ } }
    // 双向流转发（head 已单独转发，pipe 不会重复）
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => { try { socket.destroy(); } catch (e) { /* ignore */ } });
    socket.on('error', () => { try { upSocket.destroy(); } catch (e) { /* ignore */ } });
  });
  r.on('error', (e) => {
    try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch (e2) { /* ignore */ }
    try { socket.destroy(); } catch (e2) { /* ignore */ }
  });
  r.end();
}

/**
 * [R6 R4] 对上游响应做定向重写（仅 identity 编码；失败安全跳过）：
 *  - app.js：baseURL 写点追加 "/docker-mgr"（让 axios API 走 /docker-mgr/* 前缀）。
 * @returns {Buffer} 重写后的 body
 */
function maybeRewrite(targetPath, contentType, body, upstreamHeaders) {
  const ct = String(contentType || '').toLowerCase();
  const enc = String((upstreamHeaders && upstreamHeaders['content-encoding']) || '').toLowerCase();
  if (enc && enc !== 'identity') return body; // gzip 等不重写（安全降级）
  const isJs = /javascript|ecmascript/.test(ct) || /\.js$/i.test(targetPath);
  if (isJs) {
    const s = body.toString('utf8');
    if (s.indexOf(BASEURL_MARKER) >= 0) {
      return Buffer.from(s.split(BASEURL_MARKER).join(BASEURL_REWRITE), 'utf8');
    }
  }
  return body;
}

/**
 * [R9 R1] 是否容器管理入口页面（注入自动登录脚本的目标）。
 * 仅对 docker-mgr 入口 HTML 注入：根 /、/pc/、/pc/index.html 以及任意 .html 页面。
 * @param {string} targetPath 前缀剥离后的上游路径
 * @returns {boolean}
 */
function isDockerMgrEntry(targetPath) {
  const p = String(targetPath || '');
  if (p === '/' || p === '/pc' || p === '/pc/') return true;
  return /\.html?$/i.test(p);
}

/**
 * 主入口（由 server.js 在 /docker-mgr/* 与根 /ws、POST /login 转发）。
 * @param {object} req
 * @param {object} res
 * @param {URL} url
 * @param {object} cfg
 */
async function handle(req, res, url, cfg) {
  // 1) console 鉴权（iframe 场景 query token / cookie 兼容）
  const a = resolveAuth(req, cfg, url);
  if (!a.ok) return sendJson(res, a.status || 401, { ok: false, error: a.error || '未登录' });

  const cfgObj = cfgFrom(cfg);
  const isWs = isWsRequest(req);

  // 2) 前缀剥离：/docker-mgr/xxx → xxx（根 /docker-mgr → /）；根 /ws、POST /login 原样保留
  let targetPath = url.pathname;
  if (targetPath === '/docker-mgr' || targetPath.startsWith('/docker-mgr/')) {
    targetPath = targetPath.replace(/^\/docker-mgr\/?/, '') || '/';
  }
  const upstream = upstreamUrl(cfgObj, targetPath, url.search);

  // 3) WebSocket 隧道（终端/日志用；根 /ws 与 /docker-mgr/ws 均支持）
  if (isWs) return proxyWs(req, res, upstream, cfgObj);

  const isLoginReq = req.method === 'POST' && targetPath === '/login';

  // 4) 预登录（非登录请求前确保会话存在；失败 → 降级页）
  if (!isLoginReq) {
    const lg = await doLogin(cfgObj, false);
    if (!lg.ok) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(degradeHtml('容器管理登录失败', ['预登录失败：' + (lg.error || '未知错误'), '请在配置中心「容器管理」组核对 dockerMgrUrl / dockerMgrUser / dockerMgrPass。']));
      return;
    }
  }

  // 5) 转发（缓冲请求体，支持 401 重放）
  const body = await readRawBody(req);
  const headers = buildHeaders(req.headers, upstream, !isLoginReq && !req.headers.authorization);
  if (body.length) headers['content-length'] = String(body.length);

  let r = await httpReq(upstream, { method: req.method || 'GET', headers, body });

  // 6) 401（非登录请求）→ 强制重登一次并重放
  if (r.status === 401 && !isLoginReq && !r.error) {
    const lg2 = await doLogin(cfgObj, true);
    if (lg2.ok) {
      headers.authorization = 'Bearer ' + SESSION.token;
      r = await httpReq(upstream, { method: req.method || 'GET', headers, body });
    }
  }

  // 7) 上游错误 / 超时 → 降级页（200 text/html，iframe 内不白屏）
  if (r.error) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(degradeHtml('容器管理服务不可用', ['无法连接容器管理服务（' + cfgObj.url + '）：' + (r.error && r.error.message || r.error), '请确认上游 FastOSDocker 已启动。']));
    return;
  }

  // 8) 登录请求成功 → 同步缓存会话 token（用户经代理登录的凭据，供无 Authorization 请求复用）
  if (isLoginReq && r.status >= 200 && r.status < 300) {
    try {
      const d = JSON.parse(r.body.toString('utf8') || '{}');
      const tok = d.Data || d.data || d.token || d.access_token || '';
      if (tok) { SESSION.token = String(tok); SESSION.at = Date.now(); }
    } catch (e) { /* ignore */ }
  }

  // 9) 响应回写（带重写；首请求附带 Set-Cookie 供后续资产请求鉴权）
  let outBody = maybeRewrite(targetPath, r.headers['content-type'], r.body, r.headers);

  // [R9 R1] 容器管理 HTML 自动登录注入：text/html 且为 docker-mgr 入口页面时，
  // 在 `</head>` 前注入自动登录脚本（token 取服务端内存预登录 SESSION.token；
  // htmlInject 白名单校验通过才注入；token 非法/无 head 安全跳过；不落日志）。
  try {
    const ctLower = String(r.headers['content-type'] || '').toLowerCase();
    if (/text\/html/.test(ctLower) && isDockerMgrEntry(targetPath)) {
      const html = outBody.toString('utf8');
      const injected = htmlInject.injectIntoHtml(html, SESSION.token);
      if (injected !== html) outBody = Buffer.from(injected, 'utf8');
    }
  } catch (e) { /* 注入失败安全降级：原样回写 */ }

  // 完整复制上游响应头（保留 Location/Set-Cookie 等），仅过滤 hop-by-hop 与将由 outBody 重算的
  const hopSet = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-type', 'location',
  ]);
  const outHeaders = {};
  for (const k of Object.keys(r.headers)) {
    if (hopSet.has(k.toLowerCase())) continue;
    outHeaders[k] = r.headers[k];
  }
  outHeaders['Content-Type'] = r.headers['content-type'] || 'application/octet-stream';
  outHeaders['Content-Length'] = String(outBody.length);
  // Location 重写：绝对路径指向上游 origin → 前缀 /docker-mgr；相对路径（如 ./）原样（浏览器按当前 URL 相对解析）
  if (r.headers['location']) {
    const loc = String(r.headers['location']);
    const upOrigin = String(cfgObj.url || '').replace(/\/+$/, '');
    if (/^https?:\/\//i.test(loc)) {
      if (upOrigin && loc.indexOf(upOrigin) === 0) outHeaders['Location'] = '/docker-mgr' + loc.slice(upOrigin.length);
      else outHeaders['Location'] = loc;
    } else {
      outHeaders['Location'] = loc;
    }
  }
  if (a.cookie) {
    outHeaders['Set-Cookie'] = COOKIE_NAME + '=' + encodeURIComponent(a.cookie) + '; Path=/; HttpOnly; SameSite=Lax';
  }
  res.writeHead(r.status || 502, outHeaders);
  res.end(outBody);
}

/**
 * 侦察结论（2026-08-05，只读 GET，未修改生产）：
 *  - 服务：FastOSDocker，端口 8081；根 / 经 JS 跳转 ./pc/index.html（301 → /pc/）。
 *  - 资源路径：Vue SPA，全部相对路径（css/、js/），无绝对 /api、/static 前缀 → 无需 HTML 路径重写。
 *  - 登录机制：POST {baseURL}/login，JSON {username,password} → {Code:200, Msg, Data:<token>}；
 *    会话：localStorage token，后续请求 Authorization: Bearer <token>（axios 拦截器统一注入）。
 *  - app.js 启动即 localStorage.setItem("baseURL", location.origin) → 代理对 app.js 定向重写
 *    使 API 走 /docker-mgr/* 前缀（BASEURL_MARKER 缺失则跳过，安全降级）。
 *  - WebSocket：终端 `new WebSocket("ws://"+(baseURL?host:location.host)+"/ws?container=&shell=")`，
 *    根路径 /ws → 代理需支持根 /ws 与 /docker-mgr/ws 的 Upgrade 隧道。
 */
module.exports = {
  handle,
  handleUpgrade,
  cfgFrom,
  upstreamUrl,
  doLogin,
  degradeHtml,
  resolveAuth,
  maybeRewrite,
  isDockerMgrEntry,
  BASEURL_MARKER,
  BASEURL_REWRITE,
  COOKIE_NAME,
};
