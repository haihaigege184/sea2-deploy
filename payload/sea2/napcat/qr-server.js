'use strict';
const http = require('http');
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
// QRCode 懒加载：仅在 /fixed.png 生成固定码时 require（避免测试/无依赖环境 require 失败）
let QRCode = null;

const PORT = process.env.PORT || 13011;
const QR_PATH = '/app/napcat/cache/qrcode.png';
// [2026-08-08 副号扫码] docker 铁柱号二维码路径（容器内路径，经 docker exec napcat cat 读取）
const BACKUP_QR_PATH = '/app/napcat/cache/qrcode.png';
/**
 * [2026-08-30] 副号二维码最大可展示时长（毫秒）。
 * NapCat 约每 120 秒刷新一次二维码，超过该阈值即视为已/即将失效。
 * 以往 /backup-qr.png 不校验新鲜度，容器停止或码过期时前端仍显示一张废码，
 * 用户扫了必然失败——而每次失败扫码都是一次登录尝试，会持续喂 QQ 风控（ErrCode:3）。
 */
const BACKUP_QR_MAX_AGE_MS = parseInt(process.env.BACKUP_QR_MAX_AGE_MS || '110000', 10) || 110000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const EXTERNAL_URL = process.env.EXTERNAL_URL || ''; // 可选：固定码用外网域名而非 LAN IP

// ---------- NapCat HTTP API（登录态查询）----------
// token 绝不硬编码：只从独立 env 文件（napcat-http.env）或进程环境变量读取；
// 未配置 token 时 napcat_http_configured=false，前端诚实显示「未登录」，绝不伪造账号。
const NAPCAT_HTTP_ENV = process.env.NAPCAT_HTTP_ENV || path.join(__dirname, 'napcat-http.env');
let NAPCAT_HTTP_URL = (process.env.NAPCAT_HTTP_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
let NAPCAT_HTTP_TOKEN = (process.env.NAPCAT_HTTP_TOKEN || '').trim();

// ---------- [R9 R3-3/R3-4] 双系统 + Web 打印 配置（ops.env 可选注入）----------
// 服务端地址/令牌/设备码：优先进程 env，其次同目录 ops.env，最后默认值。
const OPS_ENV = process.env.OPS_ENV || path.join(__dirname, 'ops.env');
let SEA2_SERVER_URL = (process.env.SEA2_SERVER_URL || 'http://127.0.0.1:3457').replace(/\/+$/, '');
let SEA2_OPS_TOKEN = (process.env.SEA2_OPS_TOKEN || '').trim();
let SEA2_DEVICE_ID = (process.env.SEA2_DEVICE_ID || '').trim();
// [O-2] 管理端点统一门禁令牌：优先 WEB_ADMIN_TOKEN（独立密钥），未配置时回落 SEA2_OPS_TOKEN；
// 两者均空 → 管理端点 fail-closed（503「未配置管理口令」），与 verifyOpsToken 的 O-3 策略一致。
let WEB_ADMIN_TOKEN = (process.env.WEB_ADMIN_TOKEN || '').trim();
let SEA2_WEBPRINT_URL = (process.env.SEA2_WEBPRINT_URL || 'http://127.0.0.1:13012').replace(/\/+$/, '');
let SEA2_WEBPRINT_UPLOADS = process.env.SEA2_WEBPRINT_UPLOADS || '/root/sea2/webprint/uploads';
let SEA2_BACKUP_NAPCAT_URL = (process.env.SEA2_BACKUP_NAPCAT_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
let SEA2_BACKUP_NAPCAT_TOKEN = (process.env.SEA2_BACKUP_NAPCAT_TOKEN || '').trim();

/** 加载 ops.env（与 napcat-http.env 同模式；缺失按默认） */
function loadOpsEnv() {
  try {
    if (fs.existsSync(OPS_ENV)) {
      const raw = fs.readFileSync(OPS_ENV, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const i = t.indexOf('=');
        const k = t.slice(0, i).trim();
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (k === 'SEA2_SERVER_URL' && v) SEA2_SERVER_URL = v.replace(/\/+$/, '');
        if (k === 'SEA2_OPS_TOKEN' && v && !SEA2_OPS_TOKEN) SEA2_OPS_TOKEN = v.trim();
        if (k === 'WEB_ADMIN_TOKEN' && v && !WEB_ADMIN_TOKEN) WEB_ADMIN_TOKEN = v.trim();
        if (k === 'SEA2_DEVICE_ID' && v && !SEA2_DEVICE_ID) SEA2_DEVICE_ID = v.trim();
        if (k === 'SEA2_WEBPRINT_URL' && v) SEA2_WEBPRINT_URL = v.replace(/\/+$/, '');
        if (k === 'SEA2_WEBPRINT_UPLOADS' && v) SEA2_WEBPRINT_UPLOADS = v;
        if (k === 'SEA2_BACKUP_NAPCAT_URL' && v) SEA2_BACKUP_NAPCAT_URL = v.replace(/\/+$/, '');
        if (k === 'SEA2_BACKUP_NAPCAT_TOKEN' && v && !SEA2_BACKUP_NAPCAT_TOKEN) SEA2_BACKUP_NAPCAT_TOKEN = v.trim();
      }
    }
  } catch (e) { /* ops.env 缺失/损坏：按默认处理 */ }
}
loadOpsEnv();

// ---------- SEA2 专属常量（严禁指向 /root/napcat 或 /root/.config/QQ 等 sea1/SEA 资源） ----------
const SEA2 = {
  wsPort: 9093,                                   // SEA2 bot 反向 WS 端口（sea1 是 9092，勿混用）
  qqBinary: '/root/sea2/napcat/QQ/qq',              // SEA2 二进制 napcat 的 QQ 进程路径（已归入项目主目录 /root/sea2）
  configDir: '/root/sea2/napcat/.config',         // SEA2 会话隔离目录（HOME 重定向，已归入 /root/sea2/napcat）
  pm2App: process.env.SEA2_PM2_APP || 'sea2-napcat',
};
// 允许被本服务删除的目录白名单：只要不在白名单内，一律拒绝执行 rm -rf
const REMOVABLE_DIRS = ['/root/sea2/napcat/.config'];
// 原生主号（宿主机）onebot11 配置目录：与 docker 副号（/app/napcat/config）区分，靠模板继承补全 network
const NATIVE_NAPCAT_CONFIG_DIR = '/app/napcat/config';
// 副号（docker NapCat）onebot11 配置在宿主机的落点（挂载进容器 /app/napcat/config）
const BACKUP_NAPCAT_CONFIG_DIR = process.env.BACKUP_NAPCAT_CONFIG_DIR || '/root/napcat/config';
// 副号 onebot11 network 持久化模板。
// 关键：副号模板绝不能只靠"从现有 onebot11 里找"——清理历史配置后 NapCat 重建的都是空壳，
// 找不到模板就会跳过补写，OneBot 永不启动，表现为"手机登录没掉、控制台却上不了线"。
const BACKUP_ONEBOT_TEMPLATE = process.env.BACKUP_ONEBOT_TEMPLATE || path.join(BACKUP_NAPCAT_CONFIG_DIR, '_sea2_backup_network_template.json');
// 主号 onebot11 network 持久化模板（切换时固化，删除旧配置后仍有模板可继承，避免换行后 :4000 被旧配置占用）
const NATIVE_ONEBOT_TEMPLATE = process.env.NATIVE_ONEBOT_TEMPLATE || path.join(NATIVE_NAPCAT_CONFIG_DIR, '_sea2_onebot_network_template.json');
// pm2 可执行文件候选路径（按序尝试，兼容不同安装方式）
const PM2_CANDIDATES = [process.env.PM2_BIN, 'pm2', '/usr/local/bin/pm2', '/usr/bin/pm2'].filter(Boolean);
// NapCat 原生 WebUI 配置文件：token 与配置端口都必须动态读取，禁止硬编码
const WEBUI_CONFIG = process.env.WEBUI_CONFIG || '/app/napcat/config/webui.json';
// NapCat 原生 WebUI 已知实际端口：配置端口 6099 被 docker 占用时，napcat 实际起在 6100
const WEBUI_KNOWN_PORT = parseInt(process.env.WEBUI_PORT || '6100', 10) || 6100;
// WebUI 代理目标主机（NapCat 与 qr-server 同机，走本机回环）
const WEBUI_TARGET_HOST = process.env.WEBUI_TARGET_HOST || '127.0.0.1';
// Credential 缓存有效期：NapCat login 返回的 Credential 长时间有效，6 小时重取一次；遇 401 自动清缓存重取
const WEBUI_CREDENTIAL_TTL = 6 * 60 * 60 * 1000;

// ---------- 状态 ----------
const state = {
  lanIp: '',
  connected: false,
  token: '',
  drivers: [],     // [{driver, desc}]
  driversLoaded: false,
  switching: false, // 账号切换进行中，防并发重入
  loginInfo: { loggedIn: false, user_id: '', qq: '', nickname: '', avatar: '' }, // NapCat 已登录 QQ 账号（get_login_info）
  backupLoginInfo: { loggedIn: false, user_id: '', qq: '', nickname: '', avatar: '' }, // [R9] 副通道（docker NapCat）登录态
};
// 原生 WebUI 代理状态（Credential 缓存）
const webui = {
  credential: '',
  credentialExpire: 0,
};

// ---------- 工具 ----------
function exec(cmd, args, timeout) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout: timeout || 20000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      resolve({ err, out: stdout || '', errout: stderr || '' });
    });
  });
}
function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function shortText(s, n) {
  return (s || '').toString().trim().replace(/\s+/g, ' ').slice(0, n || 200);
}
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// ---------- NapCat HTTP API 工具（登录态查询 / 头像代理）----------
/** 解析 http(s) URL 为 {protocol, host, port, path}（path 去掉尾斜杠） */
function parseHttpUrl(u) {
  const m = String(u || '').match(/^(https?):\/\/([^/:]+)(?::(\d+))?(.*)$/);
  if (!m) return { protocol: 'http:', host: '127.0.0.1', port: 4000, path: '' };
  const dflt = m[1] === 'https' ? 443 : 80;
  return { protocol: m[1] + ':', host: m[2], port: parseInt(m[3] || '', 10) || dflt, path: (m[4] || '').replace(/\/+$/, '') };
}

/**
 * 通用 http/https 请求（返回原始 Buffer 体，支持 302 跟随）。
 * 仅用于 NapCat HTTP API 与头像代理等新增链路；既有 WebUI 代理仍走 httpRequestJson，不受影响。
 * @param {string} url 完整 URL
 * @param {{method?: string, headers?: Object, body?: Buffer|string, timeout?: number, maxRedirects?: number}} [opts]
 * @returns {Promise<{status: number, headers: Object, body: Buffer, finalUrl: string}>}
 */
function requestRaw(url, opts) {
  opts = opts || {};
  const maxRedirects = opts.maxRedirects === undefined ? 3 : opts.maxRedirects;
  const u = parseHttpUrl(url);
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'User-Agent': 'sea2-qr-server/1.0' }, opts.headers || {});
    const req = lib.request({ host: u.host, port: u.port, path: u.path || '/', method: opts.method || 'GET', headers }, (res) => {
      // 302 类跳转：301/302/303 改为 GET（去掉 body），307/308 保留原方法
      if (res.headers.location && maxRedirects > 0) {
        const code = res.statusCode;
        if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
          res.resume();
          let loc = res.headers.location;
          try { loc = new URL(loc, url).toString(); } catch (e) { /* 相对路径兜底：原样跟随 */ }
          if (code === 307 || code === 308) {
            resolve(requestRaw(loc, Object.assign({}, opts, { maxRedirects: maxRedirects - 1 })));
          } else {
            resolve(requestRaw(loc, { method: 'GET', headers: opts.headers, timeout: opts.timeout, maxRedirects: maxRedirects - 1 }));
          }
          return;
        }
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 8000, () => req.destroy(new Error('upstream timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 空登录信息（诚实空态：未配置 / 查询失败 / 切换账号后统一使用） */
function emptyLoginInfo() {
  return { loggedIn: false, user_id: '', qq: '', nickname: '', avatar: '' };
}

/**
 * 加载 napcat-http.env（与 qr-server 同目录）：NAPCAT_HTTP_URL / NAPCAT_HTTP_TOKEN。
 * token 只允许来自 env 文件或进程环境变量，绝不写死在代码里；文件缺失/损坏按未配置处理。
 */
function loadNapcatHttpEnv() {
  try {
    if (fs.existsSync(NAPCAT_HTTP_ENV)) {
      const raw = fs.readFileSync(NAPCAT_HTTP_ENV, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const i = t.indexOf('=');
        const k = t.slice(0, i).trim();
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (k === 'NAPCAT_HTTP_URL' && v) NAPCAT_HTTP_URL = v.replace(/\/+$/, '');
        if (k === 'NAPCAT_HTTP_TOKEN' && v && !NAPCAT_HTTP_TOKEN) NAPCAT_HTTP_TOKEN = v.trim();
      }
    }
  } catch (e) { /* env 文件缺失/损坏：按未配置处理（不调 NapCat API） */ }
}
loadNapcatHttpEnv();

/**
 * 查询 NapCat 已登录 QQ 账号信息。
 * 主路径：OneBot v11 POST {url}/ {action:"get_login_info"}；兜底：GET {url}/get_login_info。
 * 未配置 token / 请求失败 / 响应无 user_id → 返回 null（不阻断，诚实降级）。
 * @param {string} [url] 通道地址（默认 NAPCAT_HTTP_URL）
 * @param {string} [token] 通道 token（默认 NAPCAT_HTTP_TOKEN）
 * @returns {Promise<{user_id: string|number, nickname: string}|null>}
 */
async function fetchLoginInfo(url, token) {
  const base = (url || NAPCAT_HTTP_URL).replace(/\/+$/, '');
  const tok = (token === undefined) ? NAPCAT_HTTP_TOKEN : token;
  if (!tok) return null;
  let r = null;
  try {
    r = await requestRaw(base + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
      body: Buffer.from(JSON.stringify({ action: 'get_login_info', params: {} }), 'utf8'),
      timeout: 3000,
    });
  } catch (e) { r = null; }
  let j = null;
  if (r) { try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { j = null; } }
  let data = (j && j.data) || null;
  if (!data || data.user_id === undefined || data.user_id === null || data.user_id === '') {
    // 兜底：GET /get_login_info（部分 OneBot 实现仅支持 GET 风格）
    try {
      r = await requestRaw(base + '/get_login_info', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + tok },
        timeout: 3000,
      });
      j = JSON.parse(r.body.toString('utf8'));
      data = (j && j.data) || null;
    } catch (e) { data = null; }
  }
  if (!data || data.user_id === undefined || data.user_id === null || data.user_id === '') return null;
  return { user_id: data.user_id, nickname: String(data.nickname || '').trim() };
}

/**
 * [2026-08-30] 查询 NapCat 的【真实】在线状态（OneBot `get_status` 的 `online` 字段）。
 *
 * 背景（"幽灵在线"故障）：账号掉线后，`get_login_info` 仍会返回**缓存的旧登录信息**
 * （status=ok + 旧 user_id/nickname），仅凭它判定在线会把已掉线的号显示成在线，
 * 于是指令照发、机器人不回，而手机端早已显示 Linux 登录掉线。
 * 实测对照：同一时刻 `get_login_info` 返回 __BACKUP_QQ__，而 `get_status` 返回 `online:false`。
 *
 * @returns {boolean|null} true=确实在线；false=确实掉线；null=无法判定（接口不可用/格式异常），
 *                         调用方应回退到 get_login_info 的结果，避免引入误判。
 */
async function fetchNapcatOnline(url, token) {
  const base = (url || NAPCAT_HTTP_URL).replace(/\/+$/, '');
  const tok = (token === undefined) ? NAPCAT_HTTP_TOKEN : token;
  if (!tok) return null;
  const tryOne = async (method) => {
    try {
      const opt = { method, headers: { 'Authorization': 'Bearer ' + tok }, timeout: 4000 };
      if (method === 'POST') {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = Buffer.from(JSON.stringify({}), 'utf8');
      }
      const r = await requestRaw(base + '/get_status', opt);
      const j = JSON.parse(r.body.toString('utf8'));
      const d = (j && j.data) || {};
      if (typeof d.online === 'boolean') return d.online;
      if (j && typeof j.online === 'boolean') return j.online;
      return null;
    } catch (e) { return null; }
  };
  const a = await tryOne('GET');
  if (a !== null) return a;
  return await tryOne('POST');
}

/**
 * 用指定 token（可为空串=无鉴权）查询 OneBot 登录态。比 fetchLoginInfo 多支持“空 token”场景，
 * 用于换号后新账号自带的 httpServer 可能未设 token 的情况。
 */
async function probeLoginInfo(base, token) {
  const tok = token || '';
  const h1 = { 'Content-Type': 'application/json' };
  if (tok) h1['Authorization'] = 'Bearer ' + tok;
  let r = null;
  try {
    r = await requestRaw(base + '/', { method: 'POST', headers: h1, body: Buffer.from(JSON.stringify({ action: 'get_login_info', params: {} }), 'utf8'), timeout: 3000 });
  } catch (e) { r = null; }
  let data = null;
  if (r) { try { const j = JSON.parse(r.body.toString('utf8')); data = j && j.data; } catch (e) {} }
  if (!data || data.user_id === undefined || data.user_id === null || data.user_id === '') {
    try {
      const h2 = {}; if (tok) h2['Authorization'] = 'Bearer ' + tok;
      r = await requestRaw(base + '/get_login_info', { method: 'GET', headers: h2, timeout: 3000 });
      const j = JSON.parse(r.body.toString('utf8')); data = j && j.data;
    } catch (e) { data = null; }
  }
  if (!data || data.user_id === undefined || data.user_id === null || data.user_id === '') return null;
  return { user_id: data.user_id, nickname: String(data.nickname || '').trim() };
}

/**
 * 发现本机 qq/napcat 进程监听的 OneBot HTTP 端口（主号各账号独立监听，端口不固定）。
 * 固定轮询 4000 会漏掉换号后的新端口，故扫描 4000-4999 区间的 qq 监听端口。
 */
async function discoverNapcatHttpPorts() {
  try {
    const { out } = await exec('ss', ['-tlnp']);
    const ports = new Set();
    for (const line of out.split('\n')) {
      if (!/qq|napcat/i.test(line)) continue;
      const m = line.match(/:(\d{4,5})\b/);
      if (!m) continue;
      const p = parseInt(m[1], 10);
      if (p >= 4000 && p <= 4199) ports.add(p); // OneBot HTTP 端口区间，避开 43xx 等 wsServer 端口
    }
    if (ports.size) return Array.from(ports).sort((a, b) => a - b);
  } catch (e) { /* ss 不可用则回落单端口 */ }
  return [4000];
}

/**
 * 主号登录态探测：扫描所有 qq 监听的 OneBot HTTP 端口，返回首个“非管理员”已登录账号。
 * 解决换号后新账号落在非 4000 端口、控制台检测不到的问题。
 * @returns {Promise<{user_id, nickname}|null>}
 */
async function fetchMainLoginInfo() {
  const seen = new Set();
  const candidates = [];
  // ① 主路径：读宿主机每个 onebot11_<uin>.json，用“该账号自己的 token”探测其真实端口。
  //    换号后 NapCat 自生成的 onebot11 用自有端口+自有 token，必须用配置里的 token 才能命中。
  for (const u of hostListOnebotUins()) {
    if (NON_BOT_UINS.has(String(u))) continue;
    const { found, data } = hostReadOnebot(u);
    if (!found || !data || !data.network) continue;
    const servers = Array.isArray(data.network.httpServers) ? data.network.httpServers : [];
    for (const s of servers) {
      if (!s || s.enable === false) continue;
      const port = parseInt(s.port, 10);
      if (!port || seen.has(port)) continue;
      seen.add(port);
      candidates.push({ port, token: (s.token || '').trim() });
    }
  }
  // ② 兜底：扫描 qq/napcat 真实监听的 4000-4199 端口（防配置文件与运行时不一致）
  try {
    const ports = await discoverNapcatHttpPorts();
    for (const p of ports) {
      if (seen.has(p)) continue;
      seen.add(p);
      candidates.push({ port: p, token: NAPCAT_HTTP_TOKEN });
    }
  } catch (e) { /* ignore */ }
  // ③ 逐端口探测，命中首个非管理员已登录账号
  for (const c of candidates) {
    let info = null;
    if (c.token) info = await probeLoginInfo('http://127.0.0.1:' + c.port, c.token);
    // 用账号自身 token 失败 → 试全局 token
    if (!info && c.token && NAPCAT_HTTP_TOKEN && c.token !== NAPCAT_HTTP_TOKEN) {
      info = await probeLoginInfo('http://127.0.0.1:' + c.port, NAPCAT_HTTP_TOKEN);
    }
    // 仍失败 → 无鉴权兜底（个别 httpServer 未设 token）
    if (!info) info = await probeLoginInfo('http://127.0.0.1:' + c.port, '');
    if (info && !NON_BOT_UINS.has(String(info.user_id))) return info;
  }
  return null;
}

/** 更新登录信息到 state（tick 轮询调用；失败/未配置保持诚实空态） */
async function detectLoginInfo() {
  const info = await fetchMainLoginInfo();
  if (!info) { state.loginInfo = emptyLoginInfo(); return; }
  // [2026-08-30 FIX] 复核真实在线状态：get_login_info 在掉线后仍返回缓存数据，
  // 仅凭它会造成"幽灵在线"（控制台显示在线、指令发出去无人回）。get_status.online 才是真实状态。
  const online = await fetchNapcatOnline(NAPCAT_HTTP_URL, NAPCAT_HTTP_TOKEN);
  if (online === false) {
    console.log('[login-detect] 主号 get_login_info 有数据但 get_status.online=false → 判定已掉线');
    state.loginInfo = emptyLoginInfo();
    return;
  }
  const uid = String(info.user_id);
  state.loginInfo = {
    loggedIn: true,
    user_id: uid,
    qq: uid,
    nickname: info.nickname || ('QQ ' + uid),
    avatar: '/api/avatar?qq=' + encodeURIComponent(uid),
  };
  // [2026-08-30 产品化] 登录成功 → 自动同步主号 autoLogin（换号后重启自动登录新号，免预置号码）
  syncMainAutoLogin(uid);
}

/**
 * 非业务号排除名单（如纯管理通知号，不参与 bot 消息收发、不占用 OneBot 端口）。
 *
 * [2026-08-30 修复] 原为硬编码 `new Set(['__ADMIN_QQ__'])`，属于"预置号码"，商业版不允许。
 * 且当部署方把该号用作【主号业务号】时造成双重致命后果：
 *   ① INHERIT 见到即 `continue`（打印"管理员，跳过"）→ 其 onebot11 network 永远为空
 *      → OneBot HTTP(:4000) 永不监听；
 *   ② fetchMainLoginInfo() 也把它过滤掉 → 即便已上线，控制台仍显示"待扫码"。
 * 表现即"手机显示已登录、控制台没上线"。
 *
 * 现改为由环境变量 `NON_BOT_UINS`（逗号分隔）配置，**默认为空**——不预置任何号码，
 * 所有登录的号都按业务号处理；确需排除的部署自行注入该变量。
 */
const NON_BOT_UINS = new Set(
  String(process.env.NON_BOT_UINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

function hasNetwork(data) {
  if (!data || !data.network) return false;
  const net = data.network;
  const hasHttp = Array.isArray(net.httpServers) && net.httpServers.length > 0;
  const hasWs = Array.isArray(net.websocketClients) && net.websocketClients.length > 0;
  return hasHttp && hasWs;
}

// --- docker 副号（容器内 /app/napcat/config）---
async function dockerReadOnebot(uin) {
  const r = await exec('docker', ['exec', 'napcat', 'cat', '/app/napcat/config/onebot11_' + uin + '.json'], 15000);
  if (r.err || !r.out) return { found: false };
  try { return { found: true, data: JSON.parse(r.out) }; } catch (e) { return { found: false }; }
}
async function dockerWriteOnebot(uin, obj) {
  const tmp = '/tmp/onebot11_' + uin + '.json';
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); } catch (e) { return false; }
  const r = await exec('docker', ['cp', tmp, 'napcat:/app/napcat/config/onebot11_' + uin + '.json'], 15000);
  try { fs.unlinkSync(tmp); } catch (e) {}
  return !r.err;
}
async function listOnebotUins() {
  // 注意：docker exec 直接把参数传给 ls，glob 不展开，故走 sh -c
  const r = await exec('docker', ['exec', 'napcat', 'sh', '-c', 'ls /app/napcat/config/onebot11_*.json 2>/dev/null'], 15000);
  if (r.err || !r.out) return [];
  return r.out.split('\n').map(s => s.trim()).filter(Boolean)
    .map(p => p.split('/').pop().replace('onebot11_', '').replace('.json', '')).filter(Boolean);
}

// --- 原生主号（宿主机 /app/napcat/config，非 docker）---
function hostListOnebotUins() {
  try {
    const files = fs.readdirSync(NATIVE_NAPCAT_CONFIG_DIR).filter(f => /^onebot11_.*\.json$/.test(f));
    return files.map(f => f.replace('onebot11_', '').replace('.json', '')).filter(Boolean);
  } catch (e) { return []; }
}
function hostReadOnebot(uin) {
  try {
    const raw = fs.readFileSync(NATIVE_NAPCAT_CONFIG_DIR + '/onebot11_' + uin + '.json', 'utf8');
    return { found: true, data: JSON.parse(raw) };
  } catch (e) { return { found: false }; }
}
function hostWriteOnebot(uin, obj) {
  try {
    fs.writeFileSync(NATIVE_NAPCAT_CONFIG_DIR + '/onebot11_' + uin + '.json', JSON.stringify(obj, null, 2));
    return true;
  } catch (e) { return false; }
}

// 仅列出“确实有账号配置文件 napcat_<uin>.json”的 uin。
// NapCat 在账号被配置/登录后会生成此文件（核心配置），但【不会】自动生成 onebot11_<uin>.json（OneBot 适配器）。
// 因此以 napcat_*.json 作为“账号发现源”，弥补换号后新号无 onebot11 的空白。
// 注意：全局 napcat.json 不匹配；napcat_protocol_*.json 不匹配（须严格 napcat_<纯数字>.json）。
function hostListAccountUins() {
  try {
    const files = fs.readdirSync(NATIVE_NAPCAT_CONFIG_DIR).filter(f => /^napcat_(\d+)\.json$/.test(f));
    return files.map(f => f.replace('napcat_', '').replace('.json', '')).filter(Boolean);
  } catch (e) { return []; }
}

// 当前登录账号：NapCat 登录/更新配置时会写 napcat_<uin>.json，故取 mtime 最新者。
// 用途：换号后旧号的 napcat_<uin>.json 会残留，若也给旧号补写模板端口 :4000，
// 多个 onebot11 争用同一 HTTP 端口会让真正登录的账号起不来，因此只认"当前账号"。
function hostCurrentAccountUin() {
  let best = null, bestMtime = -1;
  for (const uin of hostListAccountUins()) {
    if (NON_BOT_UINS.has(String(uin))) continue;
    try {
      const st = fs.statSync(path.join(NATIVE_NAPCAT_CONFIG_DIR, 'napcat_' + uin + '.json'));
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = uin; }
    } catch (e) { /* 读取失败则跳过 */ }
  }
  return best;
}

// 用模板网络构造一个完整的 onebot11 配置对象（NapCat 要求的字段全部补齐）。
function buildOnebotFromTemplate(tpl) {
  return {
    network: tpl,
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 }
  };
}

/**
 * 主号是否"确实有账号登录"：QQ 会在 <configDir>/QQ/nt_qq_<hash> 下写入登录数据，
 * 退出登录后该目录会被清空/移除。据此可区分「真登录」与「仅残留 napcat_<uin>.json 核心配置」。
 *
 * 关键止血：未登录时绝不能基于残留核心配置主动创建 onebot11 并重启 NapCat——
 * 那会形成「创建 → 重启 → 账号未登录探测不到 → 清理删除 → 再创建」的无限重启循环
 * （曾导致 sea2-napcat 重启上百次、:4000/:6100 永远起不来，用户表现为"主副号全都登不上"）。
 */
function nativeHasLoggedInAccount() {
  try {
    const dir = path.join(SEA2.configDir, 'QQ');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some(e => e.isDirectory() && /^nt_qq_/.test(e.name));
  } catch (e) { return false; }
}

/**
 * 主号是否正在"等待扫码"：NapCat 在等待扫码时会持续刷新二维码文件，登录成功后即停止刷新。
 * 用它区分「真在线」与「会话目录残留但登录态已失效」——后者若仍补写+重启，
 * 会形成无意义的重启循环；反复上下线会触发 QQ 风控
 * （Login Error ErrType:1 ErrCode:3，表现为扫码后约 30 秒被踢、新老号都登不上）。
 */
function nativeAwaitingQrScan(freshMs) {
  try {
    const st = fs.statSync(QR_PATH);
    return (Date.now() - st.mtimeMs) < (freshMs || 150000);
  } catch (e) { return false; }
}

// 进程内记忆：为某 uin 创建 onebot11 后若探测到它并未登录，则本次进程内不再重复创建（杜绝重启循环）
const failedCreateUins = new Set();

// 重启冷却：补写 onebot11 后必须重启 NapCat 才生效，但每次重启都会让 QQ 上下线一次，
// 过于频繁会触发风控（登录后被踢）。故放宽到 10 分钟，并与 NapCat 的配置写回隔离。
const RESTART_COOLDOWN_MS = 600000;
let lastNativeRestartAt = 0;   // 主号（原生 NapCat）上次重启时刻
let lastBackupRestartAt = 0;   // 副号（docker napcat）上次重启时刻

// 主号原生：确保某账号有 onebot11 配置。已存在则按模板对齐网络；不存在则从模板完整创建。
// 关键修复：换号后新账号只生成 napcat_<uin>.json，不会自动生成 onebot11_<uin>.json，
// 导致 OneBot HTTP 不启动、控制台永远检测不到新号（手机显示已登录，但后端扫不到）。
async function hostEnsureOnebotForAccount(uin) {
  if (!uin || NON_BOT_UINS.has(String(uin))) return { changed: false };
  if (failedCreateUins.has(String(uin))) return { changed: false }; // 曾探测为未登录，不再重复创建
  const tpl = await readTemplateNetwork('main');
  if (!tpl) return { changed: false };
  const { found, data } = hostReadOnebot(uin);
  if (found && data) {
    if (!networkNeedsAlign(data.network, tpl)) return { changed: false };
    const merged = Object.assign({}, data, { network: tpl });
    return { changed: hostWriteOnebot(uin, merged) };
  }
  // 不存在 → 从模板创建完整 onebot11（NapCat 重启后才会加载生效）
  const obj = buildOnebotFromTemplate(tpl);
  return { changed: hostWriteOnebot(uin, obj) };
}

/**
 * [2026-08-30] 主号账号发现源：扫描 NapCat 为每个登录过的号生成的核心配置
 * `napcat_<uin>.json`（文件名即 UIN），按 mtime 降序返回（最近登录的在前）。
 *
 * 为什么需要它：主号（原生 NapCat）换号后【不会】为新号自动生成 `onebot11_<uin>.json`
 * （与 docker 副号行为不同），而原主号分支只扫描 `onebot11_<uin>.json`，
 * 于是新号永远进不了补写循环 → `:4000` 永不监听 → 控制台永远检测不到，
 * 表现正是"手机显示已登录、控制台却一直让扫码"。
 */
function hostListNapcatCoreUins() {
  try {
    const files = fs.readdirSync(NATIVE_NAPCAT_CONFIG_DIR).filter(f => /^napcat_\d+\.json$/.test(f));
    const items = files.map(f => {
      const uin = f.replace(/^napcat_/, '').replace(/\.json$/, '');
      let mt = 0;
      try { mt = fs.statSync(path.join(NATIVE_NAPCAT_CONFIG_DIR, f)).mtimeMs; } catch (e) { mt = 0; }
      return { uin, mt };
    });
    items.sort((a, b) => b.mt - a.mt);
    return items.map(x => x.uin);
  } catch (e) { return []; }
}

// 取同类型"已完整配置"账号的网络块作为模板（kind: 'main'=原生主号 | 'backup'=docker 副号）
async function readTemplateNetwork(kind) {
  if (kind === 'main') {
    // 优先用持久化模板（切换时已固化，删旧配置后仍有模板可继承）
    try {
      if (fs.existsSync(NATIVE_ONEBOT_TEMPLATE)) {
        const t = JSON.parse(fs.readFileSync(NATIVE_ONEBOT_TEMPLATE, 'utf8'));
        if (t && t.network && hasNetwork(t)) return t.network;
      }
    } catch (e) { /* 模板损坏则回落到实时扫描 */ }
    for (const u of hostListOnebotUins()) {
      if (NON_BOT_UINS.has(String(u))) continue;
      const { found, data } = hostReadOnebot(u);
      if (found && hasNetwork(data)) return data.network;
    }
    return null;
  }
  // 副号：① 持久化模板 → ② 现有配置扫描 → ③ 内置兜底模板（绝不返回 null，防死锁）
  try {
    if (fs.existsSync(BACKUP_ONEBOT_TEMPLATE)) {
      const t = JSON.parse(fs.readFileSync(BACKUP_ONEBOT_TEMPLATE, 'utf8'));
      if (t && t.network && hasNetwork(t)) return t.network;
    }
  } catch (e) { /* 模板损坏则继续回落 */ }
  const uins = await listOnebotUins();
  for (const u of uins) {
    const { found, data } = await dockerReadOnebot(u);
    if (found && hasNetwork(data)) return data.network;
  }
  return buildBackupFallbackNetwork();
}

/** 读取副号 config.json（含 NAPCAT_PORT / NAPCAT_TOKEN） */
function readBackupConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(BACKUP_NAPCAT_CONFIG_DIR, 'config.json'), 'utf8')); }
  catch (e) { return {}; }
}

/**
 * 副号网络兜底模板：当持久化模板与所有现存配置都不可用时启用，避免"找不到模板→不补写→
 * OneBot 永不启动"的死锁。端口/token 取自副号 config.json，WS 为 sea1(9092)+sea2(9093) 双通道。
 */
function buildBackupFallbackNetwork() {
  const cfg = readBackupConfig();
  const port = parseInt(cfg.NAPCAT_PORT, 10) || 3000;
  const token = cfg.NAPCAT_TOKEN || '';
  const ws = (url, name) => ({
    enable: true, name, url, reportSelfMessage: true, messagePostFormat: 'array',
    token, debug: true, heartInterval: 30000, reconnectInterval: 30000
  });
  return {
    httpServers: [{
      enable: true, name: '文件服务器', host: '0.0.0.0', port,
      enableCors: true, enableWebsocket: true, messagePostFormat: 'array', token, debug: true
    }],
    httpSseServers: [], httpClients: [], websocketServers: [],
    websocketClients: [
      ws('ws://172.17.0.1:9092/api/bot/qqws', 'sea1'),
      ws('ws://172.17.0.1:9093/api/bot/qqws', 'sea2')
    ],
    plugins: []
  };
}

/**
 * 固化副号当前 network 为持久化模板（清理历史配置前调用），与 snapshotMainNetworkTemplate 对称。
 * @returns {boolean}
 */
async function snapshotBackupNetworkTemplate() {
  try {
    const uins = await listOnebotUins();
    for (const u of uins) {
      if (NON_BOT_UINS.has(String(u))) continue;
      const { found, data } = await dockerReadOnebot(u);
      if (found && hasNetwork(data)) {
        fs.writeFileSync(BACKUP_ONEBOT_TEMPLATE, JSON.stringify({ network: data.network }, null, 2));
        return true;
      }
    }
  } catch (e) { console.error('[switch] 固化副号 network 模板失败', e); }
  return false;
}

// 把模板网络写入目标账号（保留 musicSignUrl/timeout 等其它字段），幂等。
// 关键修正：换号后 NapCat 自生成的 onebot11_<新号>.json 已带 network（自有端口+自有 token），
// 旧逻辑 if(hasNetwork) return 会跳过它 → 新号落在陌生端口/ token，控制台检测不到、机器人 WS 也不连通。
// 改为：只要现有 network 的 HTTP 端口/ token 与模板不一致、或缺失 WS 通道，就强制重写模板网络。
async function inheritOnebot(uin, kind) {
  if (!uin || NON_BOT_UINS.has(String(uin))) return { changed: false };
  const readFn = kind === 'main' ? hostReadOnebot : dockerReadOnebot;
  const writeFn = kind === 'main' ? hostWriteOnebot : dockerWriteOnebot;
  // [2026-08-29 FIX] readFn/writeFn 对副号(docker)是 async，必须 await，否则解构出 undefined → 永远走 !found 分支、从不写入
  const { found, data } = await readFn(uin);
  if (!found) return { changed: false };
  const tpl = await readTemplateNetwork(kind);
  if (!tpl) return { changed: false }; // 无模板，诚实降级
  if (!networkNeedsAlign(data.network, tpl)) return { changed: false }; // 已对齐，幂等不重启
  const merged = Object.assign({}, data, { network: tpl });
  const ok = await writeFn(uin, merged);
  return { changed: ok };
}

/**
 * 现有 network 是否需要重写为模板：HTTP 端口!=模板端口、或 token 不匹配、或缺失到 9093 的 WS 通道。
 * @returns {boolean} true=需要对齐
 */
function networkNeedsAlign(net, tpl) {
  if (!net || !Array.isArray(net.httpServers) || !net.httpServers.length) return true;
  const wantPort = (tpl.httpServers && tpl.httpServers[0] && tpl.httpServers[0].port) || 4000;
  const wantToken = (tpl.httpServers && tpl.httpServers[0] && (tpl.httpServers[0].token || '')) || '';
  const s = net.httpServers[0];
  const portOk = parseInt(s.port, 10) === parseInt(wantPort, 10);
  const tokenOk = (s.token || '') === wantToken;
  const wsOk = Array.isArray(net.websocketClients) && net.websocketClients.some(w => w && w.enable && /9093/.test(w.url || ''));
  return !portOk || !tokenOk || !wsOk;
}

// 重启原生主号 NapCat（区别于 docker 副号容器重启）
async function restartNativeNapcat() {
  try {
    await exec('sh', ['-c', 'pm2 restart sea2-napcat'], 60000);
    return true;
  } catch (e) { console.error('[inherit] pm2 restart sea2-napcat 失败', e); return false; }
}

/**
 * [2026-08-30 产品化] 确保 NapCat **全局默认**配置 `onebot11.json` 存在且网络正确。
 *
 * 原理（已实证 /app/napcat/napcat.mjs）：
 *   const i = join(configPath, `onebot11_${uin}.json`);
 *   exists(i) ? readFileSync(i) : readFileSync(join(configPath, "onebot11.json"))
 * 即「账号专属配置 → 不存在则回落全局默认」。
 *
 * 价值：商业版不可能为每个客户/每个号手工预置专属文件。只要全局默认正确，
 * **任何从未在本容器登录过的新号，扫码登录时自动继承该网络，登录即绑定 :3000
 * ——零预置号码、零额外重启**。这是换号可规模化的关键。
 */
let defaultOnebotCfgDone = false;
async function ensureDefaultOnebotConfig() {
  const file = path.join(BACKUP_NAPCAT_CONFIG_DIR, 'onebot11.json');
  try {
    const tpl = await readTemplateNetwork('backup');
    if (!tpl) return false;
    // 幂等：本轮已确认过且文件仍在 → 跳过，避免每 8s 无谓 IO
    if (defaultOnebotCfgDone && fs.existsSync(file)) return true;
    if (fs.existsSync(file)) {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur && !networkNeedsAlign(cur.network, tpl)) { defaultOnebotCfgDone = true; return true; }
      } catch (e) { /* 损坏或解析失败 → 落到下面重写 */ }
    }
    const payload = {
      network: tpl,
      musicSignUrl: '',
      enableLocalFile2Url: false,
      parseMultMsg: false,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    defaultOnebotCfgDone = true;
    console.log('[default-cfg] 已写入 NapCat 全局默认 onebot11.json（新号登录自动继承：免预置、免重启）');
    return true;
  } catch (e) {
    console.error('[default-cfg] 写入全局默认配置失败', e && e.message);
    return false;
  }
}

/**
 * [2026-08-30 产品化] 副号登录成功后，自动把 webui.json 的 autoLoginAccount 同步为当前登录 UIN。
 * 价值：换号后容器重启会自动快速登录「新号」，不再被钉死在旧号上（旧 bug 根因）。
 * 幂等：值一致则不动文件。
 */
function syncBackupAutoLogin(uin) {
  const f = BACKUP_WEBUI_CONFIG;
  try {
    if (!uin || !fs.existsSync(f)) return false;
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (String(obj.autoLoginAccount || '') === String(uin)) return false; // 已一致
    const prev = obj.autoLoginAccount || '(空)';
    obj.autoLoginAccount = String(uin);
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    console.log('[auto-login] 副号登录成功，已同步 autoLoginAccount: ' + prev + ' -> ' + uin);
    return true;
  } catch (e) {
    console.error('[auto-login] 同步 autoLoginAccount 失败', e && e.message);
    return false;
  }
}

// 定时扫描：docker 副号 + 原生主号，自动补全空白 network 配置（解药：不依赖先探测到登录态）
async function ensureAllOnebotConfigs() {
  // 0) [产品化] 全局默认配置优先：新号免预置的关键（专属配置缺失时 NapCat 回落 onebot11.json）
  await ensureDefaultOnebotConfig();        // 副号（docker NapCat）
  await ensureNativeDefaultOnebotConfig();  // 主号（原生 NapCat）
  // 1) docker 副号：先批量补写，再统一重启一次（restart 会重载容器内全部 onebot11）
  let dockerChanged = [];
  try {
    const uins = await listOnebotUins();
    console.log('[inherit] 副号候选账号: ' + (uins.join(',') || '(无)'));
    for (const uin of uins) {
      if (NON_BOT_UINS.has(String(uin))) { console.log('[inherit] 副号 ' + uin + ': 管理员，跳过'); continue; }
      const r = await inheritOnebot(uin, 'backup');
      console.log('[inherit] 副号 ' + uin + ': 补写结果 changed=' + r.changed);
      if (r.changed) dockerChanged.push(uin);
    }
  } catch (e) { console.error('[inherit] 副号批量继承异常', e); }
  if (dockerChanged.length) {
    // 冷却：重启过密会把用户刚扫上的号踢掉（副号"新号登不上"的成因之一）
    const since = Date.now() - lastBackupRestartAt;
    if (since < RESTART_COOLDOWN_MS) {
      console.log('[inherit] 副号配置已补写(' + dockerChanged.join(',') + ')，但距上次重启仅 ' + Math.round(since / 1000) + 's，冷却中，下轮再重启');
    } else {
      lastBackupRestartAt = Date.now();
      // 延迟重启（非阻塞）：等刚扫码的登录会话落盘，避免"登录一秒就消失"
      console.log('[inherit] docker 副号配置已补全: ' + dockerChanged.join(',') + '，45s 后优雅重启（等登录会话落盘）');
      setTimeout(async () => {
        try {
          // [2026-08-30 风控] 冷却期内绝不重启：每次 stop/start 都是一次登录尝试，会把风控重新喂死
          if (backupInRiskCooldown()) {
            const leftMin = Math.ceil((backupRiskUntil - Date.now()) / 60000);
            console.error('[inherit] 副号处于 QQ 风控冷却期（剩余约 ' + leftMin + ' 分钟），拒绝重启以免前功尽弃');
            return;
          }
          // [2026-08-29 SAFE] 若配置已热加载生效（:3000 已应答），绝不重启，避免丢掉刚落盘的登录会话
          const probe = await exec('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '3', 'http://127.0.0.1:3000/'], 15000);
          if (probe && !probe.err && probe.out && probe.out.trim() && probe.out.trim() !== '000') {
            console.log('[inherit] docker 副号 :3000 已自行应答(http=' + probe.out.trim() + ')，跳过重启（保护登录会话）');
            return;
          }
          // 优雅停止：给 QQ NT 充足时间把登录会话刷盘，再启动；粗暴 docker restart 会在 10s 内 SIGKILL 丢会话
          console.log('[inherit] docker 副号执行优雅重启（stop -t 60 + start）');
          await exec('docker', ['stop', '-t', '60', 'napcat'], 90000);
          await exec('docker', ['start', 'napcat'], 60000);
        } catch (e) { console.error('[inherit] 重启 docker napcat 失败', e); }
      }, 45000);
    }
  }
  // 2) 原生主号：以 napcat_<uin>.json 为账号发现源（换号后新号仅生成此文件），
  //    对每个账号确保 onebot11 配置存在并对齐模板网络，再统一重启 sea2-napcat。
  //    【门禁】必须先确认主号确实有账号登录（存在 nt_qq_* 登录数据）。
  //    未登录时残留的 napcat_<uin>.json 会让"创建→重启→探测不到→删除→再创建"形成死循环，
  //    表现为 sea2-napcat 无限重启、:4000/:6100 永不监听，用户"全都登不上"。
  if (!nativeHasLoggedInAccount()) {
    console.log('[inherit] 主号当前无登录账号（无 nt_qq_* 登录数据），跳过 onebot11 补写，避免 NapCat 重启循环');
    return;
  }
  // [2026-08-30 FIX] 原逻辑"只要二维码文件新鲜(默认150s)就跳过"，会把【刚扫码登录成功、
  // 二维码文件尚未失效】误判成"仍在等待扫码"，从而永久跳过补写 → 新号永远拿不到 :4000，
  // 表现正是"手机已登录、控制台检测不到"。上面已用 nativeHasLoggedInAccount() 确认存在
  // 登录会话目录（退出登录后该目录会被清空），即为真登录，此时不应再因二维码新鲜而永久跳过；
  // 仅在二维码【极新鲜】(<60s) 时让登录态稳定一轮，避免打断正在进行的扫码。
  if (nativeAwaitingQrScan(60000)) {
    console.log('[inherit] 二维码 60s 内刚刷新，登录态可能未稳定，本轮跳过（下轮补写）');
    return;
  }
  let nativeChanged = [];
  try {
    // [2026-08-30 FIX] 主号原生 NapCat 换号后【不会】为新号自动生成 onebot11_<uin>.json
    // （与 docker 副号行为不同），所以不能只扫描 onebot11_<uin>.json —— 新号没有该文件，
    // 永远进不了补写循环 → :4000 永不监听 → 控制台检测不到（手机已登录、控制台没上线）。
    // 账号发现源改用 NapCat 为每个登录过的号生成的核心配置 napcat_<uin>.json（文件名即 UIN），
    // 取 mtime 最新者视为"最近登录的号"，再用 hostEnsureOnebotForAccount 【创建】它的 onebot11
    // ——该函数此前定义了却从未被调用，是本次故障的主因。
    // 发现源优先级：① onebot11_<uin>.json —— NapCat 只为【已登录】的号创建它，最可靠；
    //               ② 一个都没有时（全新号），才回落到 napcat_<uin>.json 的 mtime 最新者兜底
    //                 （napcat_<uin>.json 的 mtime 不会随每次登录刷新，用它排序选号并不可靠，
    //                  实测曾误选到未登录的旧号并给它补写、把新号的端口抢走）。
    let primaryUins = hostListOnebotUins().filter(u => !NON_BOT_UINS.has(String(u)));
    let srcName = 'onebot11_*.json';
    if (!primaryUins.length) {
      primaryUins = hostListNapcatCoreUins().filter(u => !NON_BOT_UINS.has(String(u))).slice(0, 1);
      srcName = 'napcat_*.json(兜底)';
    }
    if (primaryUins.length) {
      const currentUin = primaryUins[0];
      console.log('[inherit] 主号账号发现源 ' + srcName + ': ' + primaryUins.join(',') + '，取: ' + currentUin);
      const rc = await hostEnsureOnebotForAccount(currentUin);
      if (rc.changed) {
        nativeChanged.push(currentUin);
        // 用从文件名得到的 UIN 直接回写 autoLogin，不依赖 :4000 探测，
        // 打破"检测不到登录 → 不写 autoLogin → 重启后不自动登录 → 又要重扫"的死循环。
        syncMainAutoLogin(currentUin);
      }
    }
    // 仍对已存在的 onebot11 做模板对齐（兼容历史路径）
    for (const uin of hostListOnebotUins()) {
      if (NON_BOT_UINS.has(String(uin))) continue;
      const r = await inheritOnebot(uin, 'main');
      if (r.changed) nativeChanged.push(uin);
    }
  } catch (e) { console.error('[inherit] 主号原生批量继承异常', e); }
  if (nativeChanged.length) {
    // 冷却：补写后需重启才生效，但重启过密会把用户刚扫上的号踢掉（"一秒就消失"）
    const since = Date.now() - lastNativeRestartAt;
    if (since < RESTART_COOLDOWN_MS) {
      console.log('[inherit] 主号配置已补写(' + nativeChanged.join(',') + ')，但距上次重启仅 ' + Math.round(since / 1000) + 's，冷却中，下轮再重启');
      return;
    }
    lastNativeRestartAt = Date.now();
    // 延迟重启（非阻塞）：用户刚扫码登录时会话未必已落盘，立即重启会丢会话，
    // 表现为"手机显示已登录一秒就消失"。给 45s 让登录态稳定后再重启，
    // 重启后 QQ 会凭已保存的会话自动恢复，无需重新扫码。
    const delayMs = 45000;
    console.log('[inherit] 原生主号配置已补全: ' + nativeChanged.join(',') + '，' + (delayMs / 1000) + 's 后重启 sea2-napcat（等登录会话落盘）');
    setTimeout(async () => {
      try {
        await restartNativeNapcat();
      } catch (e) { console.error('[inherit] 延迟重启 sea2-napcat 失败', e); return; }
      // 兜底：重启后探测，删除"未登录"账号的 onebot11。
      // 给足 25s：NapCat 重启后 OneBot 监听起来需要时间，过早探测会把刚登录的账号误删。
      setTimeout(() => { pruneNonLoggedInNativeOnebot().catch(e => console.error('[inherit] 清理未登录 onebot11 异常', e)); }, 25000);
    }, delayMs);
  }
}

// 重启后二次清理：仅保留“当前真正登录”的账号 onebot11，删除其余（如刚被换下的旧主号）。
// 避免多个 onebot11 同时占用 :4000 导致真正登录的账号起不来。NapCat 只为登录账号激活 OneBot，
// 但保险起见仍显式清理未登录者，确保 :4000 落在当前账号上。
async function pruneNonLoggedInNativeOnebot() {
  // 保守清理：只要主号仍存在登录会话（可能还在登录中/OneBot 尚未就绪），就绝不删除。
  // 曾因"端口探测不到就删"形成「补写→重启→探测失败→删除→NapCat 重建空壳→再补写」的循环，
  // 反复上下线最终触发 QQ 风控。只有在"完全无登录会话"时才做清理。
  if (nativeHasLoggedInAccount()) {
    console.log('[inherit] 主号存在登录会话（可能仍在登录/就绪中），跳过清理以免误删');
    return;
  }
  const uins = hostListOnebotUins().filter(u => !NON_BOT_UINS.has(String(u)));
  let removed = [];
  for (const uin of uins) {
    const { found, data } = hostReadOnebot(uin);
    if (!found) continue;
    const s = data && data.network && Array.isArray(data.network.httpServers) ? data.network.httpServers[0] : null;
    if (!s || !s.port) { removed.push(uin); continue; }
    // NapCat 重启后 OneBot 监听起来较慢，给 3 次机会（间隔 8s，总窗口约 24s）再判定"未登录"。
    // 判定过急会误删刚补写好的配置，使账号退回空壳、控制台又检测不到。
    let info = null;
    for (let i = 0; i < 3 && !info; i++) {
      info = await probeLoginInfo('http://127.0.0.1:' + parseInt(s.port, 10), s.token || '');
      if (!info && i < 2) await new Promise(r => setTimeout(r, 8000));
    }
    if (!info || NON_BOT_UINS.has(String(info.user_id))) removed.push(uin);
  }
  if (!removed.length) return;
  for (const uin of removed) {
    try { fs.unlinkSync(NATIVE_NAPCAT_CONFIG_DIR + '/onebot11_' + uin + '.json'); console.log('[inherit] 清理未登录 onebot11: ' + uin); } catch (e) {}
    failedCreateUins.add(String(uin)); // 记住该账号未登录，本次进程内不再为其重复创建，杜绝重启循环
  }
  // 不再重启 NapCat：删掉的是"未登录账号"的配置，它本就不会监听端口，无需重启释放；
  // 而 prune 自身再重启正是"创建→重启→删除→重启"循环的根源之一。
}

// [INHERIT] 换号后主动触发配置继承（不阻塞切换响应）：NapCat 登录并生成空白 onebot11 后，
// 由本函数安排的两轮延迟扫描主动补全 network，使换号瞬间即完整；tick() 仍作兜底。
// 说明：换号瞬间尚不知道新号 uin，故采用"延迟主动扫描"而非一次性直写，复用已验证的 ensureAllOnebotConfigs。
function triggerInheritSoon(kind) {
  const attempt = (delay) => setTimeout(() => {
    ensureAllOnebotConfigs()
      .then(() => {})
      .catch(e => console.error('[inherit] 主动继承异常(' + (kind || 'all') + ')', e));
  }, delay);
  attempt(6000);   // 等 NapCat 登录并生成 onebot11 配置后再补写
  attempt(15000);  // 二次兜底，确保不漏
}

/** [R9 R3-1] 更新副通道（docker NapCat localhost:3000）登录态；未配置 token → 诚实空态 */
async function detectBackupLoginInfo() {
  const info = await fetchLoginInfo(SEA2_BACKUP_NAPCAT_URL, SEA2_BACKUP_NAPCAT_TOKEN);
  if (!info) { state.backupLoginInfo = emptyLoginInfo(); return; }
  // [2026-08-30 FIX] 复核真实在线状态（"幽灵在线"修复）：
  // 副号自动掉线后 get_login_info 仍返回缓存的旧账号，控制台据此误判在线 →
  // 指令照发却无人回复。必须以 get_status.online 为准；查不到(null)时回退旧逻辑，避免误判离线。
  const online = await fetchNapcatOnline(SEA2_BACKUP_NAPCAT_URL, SEA2_BACKUP_NAPCAT_TOKEN);
  if (online === false) {
    console.log('[login-detect] 副号 get_login_info 有数据(' + info.user_id + ')但 get_status.online=false → 判定已掉线（避免幽灵在线）');
    state.backupLoginInfo = emptyLoginInfo();
    return;
  }
  const uid = String(info.user_id);
  state.backupLoginInfo = {
    loggedIn: true,
    user_id: uid,
    qq: uid,
    nickname: info.nickname || ('QQ ' + uid),
    avatar: '/api/avatar?qq=' + encodeURIComponent(uid),
  };
  // [2026-08-30 产品化] 登录成功 → 自动同步 autoLogin，换号后重启自动登录新号（不再被旧号钉死）
  syncBackupAutoLogin(uid);
}

/**
 * [2026-08-30 产品化] 主号（原生 NapCat）登录成功后，自动把 webui.json 的 autoLoginAccount
 * 同步为当前登录 UIN。与 syncBackupAutoLogin 对称：换号后重启自动登录「新号」，免预置号码。
 */
function syncMainAutoLogin(uin) {
  const f = WEBUI_CONFIG;
  try {
    if (!uin || !fs.existsSync(f)) return false;
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (String(obj.autoLoginAccount || '') === String(uin)) return false; // 已一致
    const prev = obj.autoLoginAccount || '(空)';
    obj.autoLoginAccount = String(uin);
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    console.log('[auto-login] 主号登录成功，已同步 autoLoginAccount: ' + prev + ' -> ' + uin);
    return true;
  } catch (e) {
    console.error('[auto-login] 主号同步 autoLoginAccount 失败', e && e.message);
    return false;
  }
}

/**
 * [2026-08-30 产品化] 主号（原生 NapCat）全局默认配置 onebot11.json，与副号 ensureDefaultOnebotConfig 对称。
 * NapCat 读取链：onebot11_<uin>.json（专属）→ 不存在则回落 onebot11.json（全局默认）。
 * 保证任何新号登录主号时自动继承正确网络，免预置号码、免重启。
 * 主号模板缺失时诚实返回 false（不写入），避免用错误配置污染主号。
 */
let nativeDefaultCfgDone = false;
async function ensureNativeDefaultOnebotConfig() {
  const file = path.join(NATIVE_NAPCAT_CONFIG_DIR, 'onebot11.json');
  try {
    const tpl = await readTemplateNetwork('main');
    if (!tpl) return false;
    if (nativeDefaultCfgDone && fs.existsSync(file)) return true;
    if (fs.existsSync(file)) {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur && !networkNeedsAlign(cur.network, tpl)) { nativeDefaultCfgDone = true; return true; }
      } catch (e) { /* 损坏或解析失败 → 重写 */ }
    }
    fs.writeFileSync(file, JSON.stringify({
      network: tpl,
      musicSignUrl: '',
      enableLocalFile2Url: false,
      parseMultMsg: false,
    }, null, 2));
    nativeDefaultCfgDone = true;
    console.log('[default-cfg] 已写入主号全局默认 onebot11.json（新号登录自动继承：免预置、免重启）');
    return true;
  } catch (e) {
    console.error('[default-cfg] 主号全局默认配置写入失败', e && e.message);
    return false;
  }
}

/** 字母头像 SVG（首字符 + 按 QQ 号哈希取色的背景），头像代理失败时的同源兜底 */
function letterAvatarSvg(text) {
  const t = String(text || '?').trim();
  const ch = t.charAt(0) || '?';
  const qq = t.replace(/\D/g, '');
  const palette = ['#5b8cff', '#7b6bff', '#36d2a0', '#ffb454', '#ff6b6b', '#2dd4bf', '#a78bfa', '#f472b6'];
  let idx = 0;
  for (let i = 0; i < qq.length; i++) idx = (idx + qq.charCodeAt(i)) % palette.length;
  const safe = String(ch).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="24" fill="' + palette[idx] + '"/><text x="50" y="54" font-size="52" font-family="-apple-system,Segoe UI,sans-serif" font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="middle">' + safe + '</text></svg>';
  return Buffer.from(svg, 'utf8');
}

/** TCP 连通性探测（/api/webui/diag 用） */
function tcpProbe(host, port, timeout) {
  return new Promise((resolve) => {
    let s = null;
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } };
    try { s = net.connect({ host, port }); } catch (e) { return fin(false); }
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    setTimeout(() => fin(false), timeout || 2000);
  });
}

/**
 * 简易 http.request 封装：发起 JSON 请求并完整收取响应。
 * @param {{host: string, port: number, path: string, method?: string, headers?: Object, timeout?: number}} opts
 * @param {string} [bodyStr] 请求体字符串
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
function httpRequestJson(opts, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 8000, () => req.destroy(new Error('upstream timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * 收集请求体为 Buffer（WebUI 请求体均不大，收集后便于 401 重试重放）。
 * @param {IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}


// ==========================================================================
// [PRINTER-MODEL] 打印机"干净品牌型号"解析（修复驱动匹配错位）
// --------------------------------------------------------------------------
// 问题现场：lpinfo -v 的 usb 设备行是 `direct usb://HP/LaserJet%20P2015%20Series?serial=00CNCJD24599`
//   · 行首是 `direct `（不是 URI）→ 旧代码 grep '^usb://' 永远匹配不到；
//   · 拿整串当查询做驱动打分时，norm() 会把 usb / serial / 序列号 一起变成 token，
//     整串包含命不中，token 命中又被序列号带偏 → 匹配到别的型号的驱动。
// 正确做法：CUPS 已经帮我们算好了干净型号，直接取（比字符串清洗可靠）：
//   lpinfo -l -v → Device 块里的  make-and-model = HP LaserJet P2015 Series
//                              device-id      = MFG:Hewlett-Packard;MDL:HP LaserJet P2015 Series;...
// 拿不到时再用 URI 清洗兜底。
// ==========================================================================

/** 解析 lpinfo -l -v → Map<uri, {info, makeAndModel, deviceId}> */
async function lpDevicesDetailed() {
  const map = new Map();
  const { out } = await exec('sh', ['-c', 'lpinfo -l -v 2>/dev/null']);
  if (!out) return map;
  let cur = null;
  const flush = () => { if (cur && cur.uri) map.set(cur.uri, cur); cur = null; };
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^Device:/.test(line)) {
      flush();
      const m = line.match(/uri\s*=\s*(.+)$/);
      cur = m ? { uri: m[1].trim(), info: '', makeAndModel: '', deviceId: '' } : null;
      continue;
    }
    if (!cur) continue;
    let mm;
    if ((mm = line.match(/^\s*make-and-model\s*=\s*(.*)$/))) cur.makeAndModel = mm[1].trim();
    else if ((mm = line.match(/^\s*info\s*=\s*(.*)$/))) cur.info = mm[1].trim();
    else if ((mm = line.match(/^\s*device-id\s*=\s*(.*)$/))) cur.deviceId = mm[1].trim();
  }
  flush();
  return map;
}

/** 解析 device-id：MFG:Hewlett-Packard;MDL:HP LaserJet P2015 Series;CMD:PCL,POSTSCRIPT;... */
function parseDeviceId(id) {
  const out = {};
  for (const part of String(id || '').split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().toUpperCase();
    const v = part.slice(i + 1).trim();
    if (k === 'MFG' || k === 'MANUFACTURER') out.mfg = v;
    else if (k === 'MDL' || k === 'MODEL') out.mdl = v;
    else if (k === 'DES') out.des = v;
    else if (k === 'CMD') out.cmd = v;
  }
  return out;
}

/** 厂商名归一（Hewlett-Packard → HP） */
function normMakeName(mfg, model) {
  const t = ((mfg || '') + ' ' + (model || '')).toLowerCase();
  if (/hewlett|packard|\bhp\b/.test(t)) return 'HP';
  return guessMake(t) || '';
}

/** 兜底：从 URI 清洗出干净型号（去 backend 前缀 / ?serial 后缀 / ._ipp._tcp 等） */
function cleanModelFromUri(uri) {
  let u = String(uri || '').trim();
  const backend = (u.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1] || '';
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  u = u.split('#')[0].split('?')[0];
  try { u = decodeURIComponent(u); } catch (e) { u = u.replace(/%20/gi, ' '); }
  u = u.replace(/\+/g, ' ');
  if (/^usb$/i.test(backend)) {
    // usb://HP/LaserJet P2015 Series → HP LaserJet P2015 Series（斜杠当空格，厂商段要保留）
    u = u.replace(/\//g, ' ');
  } else {
    // dnssd://Xxx._ipp._tcp.local/cups → Xxx
    u = u.replace(/\._(ipp|ipps|printer|pdl-datastream|tcp|udp)[^/]*/gi, '');
    u = u.replace(/\.local\b/gi, '');
    u = u.split('/')[0];
  }
  return u.replace(/\s+/g, ' ').trim();
}


// ==========================================================================
// [PRINTER-MODEL-2] 设备详情关联索引
// --------------------------------------------------------------------------
// lpinfo -v 与 lpinfo -l -v 对同一台打印机会给出两种 backend 写法：
//   usb://HP/LaserJet%20P2015%20Series?serial=00CNCJD24599   (listPrinters 用这条)
//   hp:/usb/HP_LaserJet_P2015_Series?serial=00CNCJD24599      (lpinfo -l -v 的 Device.uri)
// 精确 Map<uri> 查表会落空 → 拿不到 CUPS 算好的权威型号。
// 这里用三级回退把两边对上：序列号 → 归一 URI → 精确 URI。
// ==========================================================================

/** URI 归一 key：抹平 backend 写法 / %20 / 大小写 / 下划线差异 */
function cleanUriKey(u) {
  let s = String(u || '').trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '');      // usb://  hp:/  dnssd:// 全去掉
  s = s.split('?')[0].split('#')[0];                  // 去 ?serial=... / #fragment
  try { s = decodeURIComponent(s); } catch (e) { s = s.replace(/%20/gi, ' '); }
  s = s.replace(/[/_+]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  s = s.replace(/^(usb|direct|hp|hplip|network|socket|lpd|ipp|ipps|dnssd|mdns)\s+/, '');  // 再剥一层
  return s;
}

/** 从 URI 抠序列号 —— 同一台设备换 backend 写法后序列号不变，是最可靠的关联键 */
function uriSerial(u) {
  const m = String(u || '').match(/serial=([A-Za-z0-9._-]{4,})/i);
  return m ? m[1].toUpperCase() : '';
}

/** 三级回退查找设备详情 */
function resolveDeviceDetail(detail, index, d) {
  if (!detail || !detail.size) return null;
  if (detail.has(d.uri)) return detail.get(d.uri);
  const ser = uriSerial(d.uri);
  if (ser && index.bySerial.has(ser)) return index.bySerial.get(ser);
  const k = cleanUriKey(d.uri);
  if (k && index.byKey.has(k)) return index.byKey.get(k);
  return null;
}

/** 给 listPrinters() 的 discovered 补上干净 make / model（含来源标注，便于排查） */
async function enrichDiscoveredModels(discovered) {
  let detail;
  try { detail = await lpDevicesDetailed(); } catch (e) { detail = new Map(); }
  // [PRINTER-MODEL-2] 建关联索引（序列号 / 归一 URI），跨 backend 写法也能对上
  const index = { bySerial: new Map(), byKey: new Map() };
  for (const [k, v] of detail) {
    const s = uriSerial(k); if (s && !index.bySerial.has(s)) index.bySerial.set(s, v);
    const nk = cleanUriKey(k); if (nk && !index.byKey.has(nk)) index.byKey.set(nk, v);
  }
  for (const d of discovered) {
    const det = resolveDeviceDetail(detail, index, d);
    const idp = parseDeviceId(det && det.deviceId);
    const mm = det && det.makeAndModel && det.makeAndModel !== 'Unknown' ? det.makeAndModel : '';
    const fromId = idp.mdl && idp.mdl !== 'Unknown' ? idp.mdl : '';
    const clean = fromId || mm || cleanModelFromUri(d.uri);
    d.model = clean || '';
    d.model_raw = mm || (det && det.info) || d.info || d.uri;   // 原始串仅作展示，不参与匹配
    d.model_source = fromId ? 'device-id' : (mm ? 'lpinfo' : 'uri');
    if (!d.make) d.make = normMakeName(idp.mfg, clean);
    d.device_id = (det && det.deviceId) || '';
  }
  return discovered;
}

/**
 * [PRINTER-MODEL] 匹配查询清洗：即使调用方传进来的是原始 URI / 脏字符串，
 * 也要保证 usb:// / ?serial= / 序列号 这类噪声不参与驱动打分。
 */
function cleanMatchQuery(q) {
  let s = String(q || '');
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\//gi, ' ');   // 去 backend 前缀
  s = s.split('#')[0].split('?')[0];                 // 去 ?serial=... / #fragment
  try { s = decodeURIComponent(s); } catch (e) { s = s.replace(/%20/gi, ' '); }
  const drop = /^(usb|direct|network|serial|uuid|local|cups|ipp|ipps|socket|lpd|dnssd|mdns|print|printer|port|host|beh|tcp|udp|pdl|datastream)$/i;
  return norm(s).split(' ')
    .filter((t) => t && !drop.test(t) && !/^[0-9a-f]{6,}$/i.test(t) && !/^\d{5,}$/.test(t))
    .join(' ');
}

// ---------- 驱动库预加载 ----------
async function loadDrivers() {
  const { out } = await exec('lpinfo', ['-m']);
  if (!out) { state.driversLoaded = true; return; }
  const lines = out.split('\n').map(x => x.trim()).filter(Boolean);
  const arr = [];
  for (const line of lines) {
    const sp = line.indexOf(' ');
    const driver = sp > 0 ? line.slice(0, sp) : line;
    const desc = sp > 0 ? line.slice(sp + 1).trim() : line;
    arr.push({ driver, desc });
  }
  state.drivers = arr;
  state.driversLoaded = true;
  console.log('[drivers] loaded', arr.length);
}

// ---------- 驱动匹配打分 ----------
function scoreDriver(query, desc) {
  // [PRINTER-MODEL] 查询先清洗：去 backend 前缀 / ?serial 后缀 / 序列号 token
  const q = cleanMatchQuery(query), d = norm(desc);
  if (!q) return 0;
  let score = 0;
  if (d.includes(q)) score += 120;            // 整串包含(强)
  const qt = q.split(' ').filter(Boolean);
  const dt = d.split(' ').filter(Boolean);
  for (const t of qt) {
    if (!t) continue;
    if (dt.includes(t)) score += 12;          // 完整 token 命中
    else if (d.includes(t)) score += 4;        // 子串命中
  }
  // 通用/占位驱动降权（除非无更好匹配）
  if (/(generic|raw|postscript only|text only|everything|everywhere|pdf|pcl|ghostscript)/.test(d)) score -= 6;
  return score;
}
function matchDrivers(query, limit) {
  if (!state.drivers.length) return [];
  const scored = state.drivers.map(d => ({ ...d, score: scoreDriver(query, d.desc) }));
  scored.sort((a, b) => b.score - a.score);
  let top = scored.filter(x => x.score > 0).slice(0, limit || 8);
  // 保证 IPP Everywhere 兜底在列
  const hasEverywhere = top.some(x => /everywhere/i.test(x.desc));
  if (!hasEverywhere) {
    const ev = scored.find(x => /IPP Everywhere/i.test(x.desc)) || scored.find(x => /everywhere/i.test(x.desc));
    if (ev) top = top.concat([{ ...ev, score: ev.score, note: '通用驱动(无需特定PPD)' }]).slice(0, limit || 8);
  }
  return top;
}

// ---------- 网络 / 连接探测 ----------
async function detectLanIp() {
  const { out } = await exec('sh', ['-c', 'ip route get 1.1.1.1 2>/dev/null | grep -oP "src \\K\\S+" | head -1']);
  const ip = (out || '').trim();
  if (ip && ip !== state.lanIp) {
    state.lanIp = ip;
    console.log('[lan] detected', ip);
  } else if (!state.lanIp && ip) {
    state.lanIp = ip;
  }
}
function fixedUrl() {
  if (EXTERNAL_URL) return EXTERNAL_URL.replace(/\/+$/, '') + '/s';
  return 'http://' + (state.lanIp || '127.0.0.1') + ':' + PORT + '/s';
}
async function detectConnected() {
  // 连接指示器必须随当前激活系统变化：SEA1 副号走 9092，SEA2 主号走 9093（SEA2.wsPort）。
  // 旧逻辑写死 9093，导致切到 SEA1 时 9093 本就不监听 → 永远误报「未连接」。
  const role = readFrameworkRole();
  const port = role === 'SEA1_ACTIVE' ? 9092 : SEA2.wsPort;
  const { out } = await exec('sh', ['-c', 'ss -tn 2>/dev/null | grep -E ":' + port + '" | grep -iE "estab" | head -1']);
  const wsOk = !!out.trim();
  // [CONN-3STATE] WS 只代表"管道在"，不代表 QQ 真在线。项目铁律：判活必须用 get_status.online。
  // 旧实现只看 ss → 扫码后 OneBot 模块重启的窗口内（无 ESTAB）控制台显示「未连接」，
  // 而登录卡片却显示「已登录」，用户极易误判为故障。这里补账号在线复核：
  //   connected = wsOk && accountOnline；探针不可用(null) → 回退只看 wsOk，不引入新误判。
  let online = null;
  try {
    if (role === 'SEA1_ACTIVE') online = await fetchNapcatOnline(SEA2_BACKUP_NAPCAT_URL, SEA2_BACKUP_NAPCAT_TOKEN);
    else online = await fetchNapcatOnline(NAPCAT_HTTP_URL, NAPCAT_HTTP_TOKEN);
  } catch (e) { online = null; }
  state.wsOk = wsOk;
  state.accountOnline = online;
  state.connected = (online === null) ? wsOk : (wsOk && online);
}
async function detectToken() {
  if (!fs.existsSync(QR_PATH)) return;
  const { out } = await exec('sh', ['-c', 'grep -aoE "https?://txz\\.qq\\.com/p\\?k=[A-Za-z0-9_=-]+" ' + QR_PATH + ' 2>/dev/null | head -1; strings ' + QR_PATH + ' 2>/dev/null | grep -aoE "txz\\.qq\\.com/p\\?k=[A-Za-z0-9_=-]+" | head -1']);
  const m = (out || '').trim();
  if (m) state.token = m.startsWith('http') ? m : 'https://' + m;
}

// ---------- 原生 WebUI 探测 ----------
/** [2026-08-08] readFrameworkRole + backup-webui proxy helpers */
function readFrameworkRole() {
  try { return fs.readFileSync('/root/sea2/run/framework.role', 'utf8').trim() || 'SEA2_ACTIVE'; }
  catch (e) { return 'SEA2_ACTIVE'; }
}

const BACKUP_WEBUI_CONFIG = process.env.BACKUP_WEBUI_CONFIG || '/root/napcat/config/webui.json';
const BACKUP_WEBUI_PORT = parseInt(process.env.BACKUP_WEBUI_PORT || '6099', 10) || 6099;
// [2026-08-29 FIX] 账号钉死根因：NapCat 自动登录目标由 webui.json 的 autoLoginAccount 决定，
// 而非 napcat.json / napcat_<uin>.json。切换时必须把该字段校正为正确的号，否则会被过期/外号钉死。
const BACKUP_QQ_UIN = process.env.BACKUP_QQ_UIN || '__BACKUP_QQ__';
const MAIN_QQ_UIN = process.env.MAIN_QQ_UIN || '__MAIN_QQ__';
const backupWebui = { credential: '', credentialExpire: 0 };

/**
 * [2026-08-08 FIX] 统一 WebUI 代理目标端口：按当前活跃框架角色动态决定。
 *   - SEA1_ACTIVE → docker 铁柱号（副号）WebUI：BACKUP_WEBUI_PORT（6099，docker-proxy）
 *   - 否则（SEA2_ACTIVE）→ 主号 NapCat WebUI：detectWebuiPort() 探测（当前 6100）
 * 目的：浏览器 URL 恒为 /webui/（React Router basename=/webui/ 天然匹配，副号不再白屏），
 *      注入脚本的 fetch('/api/auth/login') 打在 /webui/ 裸路径上也自动转发到正确端口。
 * @returns {Promise<number>} 当前应代理到的 WebUI 端口
 */
async function resolveWebuiTargetPort() {
  if (readFrameworkRole() === 'SEA1_ACTIVE') return BACKUP_WEBUI_PORT;
  try { return await detectWebuiPort(); } catch (e) { return WEBUI_KNOWN_PORT; }
}
/** 端口是否为副号（docker 铁柱号）WebUI 目标 */
function isBackupTargetPort(port) {
  return port === BACKUP_WEBUI_PORT;
}
/** [2026-08-08 FIX] 当前活跃角色的 WebUI 配置（自动登录脚本据此计算 hash） */
function getActiveWebuiConfig() {
  if (readFrameworkRole() === 'SEA1_ACTIVE') return readBackupWebuiConfig();
  return readWebuiConfig();
}

function readBackupWebuiConfig() {
  let token = '';
  try { if (fs.existsSync(BACKUP_WEBUI_CONFIG)) token = (JSON.parse(fs.readFileSync(BACKUP_WEBUI_CONFIG, 'utf8')).token || '').trim(); } catch (e) {}
  return { token, port: BACKUP_WEBUI_PORT };
}
function mapBackupWebuiPath(p) {
  if (p.startsWith('/assets') || p === '/favicon.ico') return p;
  if (p.startsWith('/webui') || p.startsWith('/api')) return p;
  let rest = p.slice('/backup-webui'.length);
  if (rest === '') rest = '/';
  if (rest === '/') return '/webui/';
  return rest;
}
function rewriteBackupWebuiBody(buf) {
  const s = buf.toString('utf8');
  const out = s.replace(/\/(webui|api|assets|files)\//g, (m, p1) => '/backup-webui/' + p1 + '/');
  return Buffer.from(out, 'utf8');
}
async function getBackupWebuiCredential(force) {
  const now = Date.now();
  if (!force && backupWebui.credential && now < backupWebui.credentialExpire) return backupWebui.credential;
  const cfg = readBackupWebuiConfig();
  if (!cfg.token) return '';
  const hash = sha256Hex(cfg.token + '.napcat');
  let r = null;
  try { r = await httpRequestJson({ host: '127.0.0.1', port: BACKUP_WEBUI_PORT, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 8000 }, JSON.stringify({ hash })); }
  catch (e) { return backupWebui.credential || ''; }
  let j = null; try { j = JSON.parse(r.body); } catch (e) { j = null; }
  const cred = j && j.data && (j.data.Credential || j.data.credential || '');
  if (!cred) return backupWebui.credential || '';
  backupWebui.credential = cred; backupWebui.credentialExpire = now + WEBUI_CREDENTIAL_TTL;
  console.log('[backup-webui] credential refreshed (len=' + cred.length + ')');
  return cred;
}
function injectBackupAutoLogin(buf) {
  let hash = '';
  try { const cfg = readBackupWebuiConfig(); if (cfg.token) hash = require('node:crypto').createHash('sha256').update(String(cfg.token) + '.napcat').digest('hex'); } catch (e) {}
  if (!hash) return buf;
  const script = '<script>(function(){try{var K="__sea2b_al_done",T="backup_token",TTL=5*60*1000,now=Date.now();var done=localStorage.getItem(K);if(done){var dt=parseInt(done,10);if(!isNaN(dt)&&now-dt<TTL&&localStorage.getItem(T))return;}function markDone(){try{localStorage.setItem(K,String(Date.now()));}catch(e){}}function getCred(){try{var raw=localStorage.getItem(T);if(!raw)return "";var j=JSON.parse(raw);return(typeof j==="string")?j:((j&&(j.Credential||j.credential))||raw);}catch(e){return "";}}function checkValid(cred){return fetch("/api/auth/check",{method:"POST",headers:{"Authorization":"Bearer "+cred}}).then(function(r){return r.json().catch(function(){return null;});}).then(function(j){return !!(j&&j.code===0);}).catch(function(){return false;});}function doLogin(){return fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({hash:"' + hash + '"})}).then(function(r){return r.json().catch(function(){return null;});}).then(function(j){if(j&&j.code===0&&j.data&&j.data.Credential){localStorage.setItem(T,JSON.stringify(j.data.Credential));markDone();}else{markDone();if(window.console)window.console.warn("[sea2b-autologin] login failed");}}).catch(function(){markDone();});}var cred=getCred();if(!cred){doLogin();return;}checkValid(cred).then(function(ok){if(ok){markDone();return;}doLogin();});}catch(e){}})();</script>';
  const s = buf.toString('utf8');
  const out = s.replace(/<head[^>]*>/, function (m) { return m + script; });
  return Buffer.from(out, 'utf8');
}
async function proxyBackupWebuiRequest(req, res, fullUrl, retried, bodyBuf) {
  const pathname = fullUrl.split('?')[0];
  if (!pathname.startsWith('/backup-webui')) { res.writeHead(404); res.end('not found'); return; }
  if (bodyBuf === undefined) bodyBuf = await collectBody(req);
  const query = fullUrl.indexOf('?') >= 0 ? '?' + fullUrl.split('?')[1] : '';
  if (pathname === '/backup-webui' || pathname === '/backup-webui/') { res.writeHead(302, { Location: '/backup-webui/webui/' + query, 'Cache-Control': 'no-store' }); res.end(); return; }
  const targetPath = mapBackupWebuiPath(pathname) + query;
  const port = BACKUP_WEBUI_PORT;
  const cred = await getBackupWebuiCredential();
  if (!cred) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'backup WebUI 未配置 token 或登录失败' })); }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(host|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|authorization|accept-encoding|content-length)$/i.test(k)) continue;
    headers[k] = v;
  }
  headers['host'] = '127.0.0.1:' + port;
  headers['authorization'] = 'Bearer ' + cred;
  headers['accept-encoding'] = 'identity';
  headers['content-length'] = bodyBuf.length;
  const proxyReq = http.request({ host: '127.0.0.1', port, method: req.method, path: targetPath, headers }, (proxyRes) => {
    const status = proxyRes.statusCode;
    if (status === 401 && !retried) {
      proxyRes.resume();
      backupWebui.credential = ''; backupWebui.credentialExpire = 0;
      getBackupWebuiCredential(true).then((c2) => {
        if (c2) proxyBackupWebuiRequest(req, res, fullUrl, true, bodyBuf).catch((e2) => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'backup WebUI 重试失败' })); } else res.destroy(); });
        else { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'backup WebUI 登录失败' })); }
      }).catch(() => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'backup WebUI 异常' })); });
      return;
    }
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (isHtml(proxyRes.headers) && buf.length) buf = rewriteBackupWebuiBody(buf);
      if (isHtml(proxyRes.headers) && buf.length) buf = injectBackupAutoLogin(buf);
      const outHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (/^(content-length|connection|keep-alive|transfer-encoding|upgrade)$/i.test(k)) continue;
        if (k === 'location') outHeaders[k] = String(v).startsWith('/') ? ('/backup-webui' + v) : v;
        else outHeaders[k] = v;
      }
      res.writeHead(status, outHeaders);
      res.end(buf);
    });
  });
  proxyReq.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'backup WebUI 代理错误: ' + shortText(e && e.message ? e.message : e, 200) })); } else res.destroy(); });
  if (bodyBuf.length) proxyReq.write(bodyBuf);
  proxyReq.end();
}

/**
 * 读取 NapCat 原生 WebUI 配置（token + 配置端口）。文件缺失/损坏时返回空配置。
 * 支持环境变量覆盖：WEBUI_TOKEN（token）、WEBUI_PORT（配置端口），便于部署/测试时注入。
 * @returns {{port: number, token: string}}
 */
function readWebuiConfig() {
  const envToken = (process.env.WEBUI_TOKEN || '').trim();
  const envPort = parseInt(process.env.WEBUI_PORT || '', 10) || 0;
  let port = 0, token = '';
  try {
    if (fs.existsSync(WEBUI_CONFIG)) {
      const raw = JSON.parse(fs.readFileSync(WEBUI_CONFIG, 'utf8'));
      port = parseInt(raw.port, 10) || 0;
      token = (raw.token || '').trim();
    }
  } catch (e) {
    // 配置损坏时忽略，使用环境变量兜底
  }
  return { port: envPort > 0 ? envPort : port, token: envToken || token };
}

/**
 * 探测 NapCat 原生 WebUI 实际监听端口。
 * 背景：webui.json 配置端口 6099 被 docker 占用时，napcat 实际起在 6100。
 * 策略：① WEBUI_PORT 环境变量（显式指定）；② 配置端口若在监听则用之；
 *       ③ 否则用已知实际端口 6100；④ 仍无则扫 6099-6110 找 qq/napcat 进程监听的端口；⑤ 兜底 6100。
 * @returns {Promise<number>} 实际端口
 */
async function detectWebuiPort() {
  const envPort = parseInt(process.env.WEBUI_PORT || '', 10);
  if (envPort > 0) return envPort;
  const cfg = readWebuiConfig();
  const lines = (await exec('ss', ['-tlnp'])).out.split('\n').filter(Boolean);
  const qqListening = (p) => lines.some(l => new RegExp(':' + p + '\\s').test(l) && /qq|napcat/i.test(l));
  // ① 优先找 qq/napcat 进程真实监听的端口（区分 docker-proxy 占用的 6099 —— 那是老项目 docker napcat，不是 sea2 二进制）
  for (const line of lines) {
    if (!/qq|napcat/i.test(line)) continue;
    const m = line.match(/:(\d{4,5})\b/);
    const p = m ? parseInt(m[1], 10) : 0;
    if (p >= 6099 && p <= 6110) return p;
  }
  // ② 配置端口兜底（仅当确为 qq 进程监听，防 docker-proxy 误判）
  if (cfg.port && qqListening(cfg.port)) return cfg.port;
  // ③ 已知端口兜底（同样要求 qq 进程监听）
  if (qqListening(WEBUI_KNOWN_PORT)) return WEBUI_KNOWN_PORT;
  return WEBUI_KNOWN_PORT;
}

/**
 * 组装原生管理台入口地址（指向本服务代理 /napcat-webui/，由代理注入 Credential 完成自动登录）。
 * @returns {Promise<{ok: boolean, url: string, port: number, tokenPresent: boolean, error?: string}>}
 */
async function buildWebuiUrl() {
  const cfg = getActiveWebuiConfig();
  const port = await resolveWebuiTargetPort();
  // origin-aware 入口：EXTERNAL_URL 优先（穿透/外网域名），否则回退 lanIp 本机地址（现状兜底）
  const entryUrl = EXTERNAL_URL
    ? EXTERNAL_URL.replace(/\/+$/, '') + '/webui/'
    : 'http://' + (state.lanIp || '127.0.0.1') + ':' + PORT + '/webui/';
  return {
    ok: true,
    url: entryUrl,          // 兼容旧字段（原 url 语义不变）
    entryUrl,               // 新字段：origin-aware 入口地址（外网域名优先）
    external: EXTERNAL_URL || null,
    port,
    tokenPresent: !!cfg.token,
  };
}

// ---------- 原生 WebUI 反向代理（Credential 注入，实现真正的自动登录） ----------
// NapCat WebUI 不认 URL 上的 ?token= 参数，认证流程为：
//   1) 前端算 SHA256(token + ".napcat") → hash
//   2) POST /api/auth/login {hash} → 返回 data.Credential（256 字符）
//   3) 后续所有请求带 Authorization: Bearer <Credential>
// 因此由本服务代调 login 拿 Credential，并在代理转发时统一注入该 header。

/**
 * 路径映射：/napcat-webui/* → NapCat WebUI 实际路径。
 *   /napcat-webui/            → /webui/   （入口直接落到 WebUI 页面）
 *   /napcat-webui/webui/*     → /webui/*
 *   /napcat-webui/api/*       → /api/*
 *   /napcat-webui/assets/*    → /assets/*
 *   /napcat-webui/其他        → /其他
 * @param {string} p 客户端路径（以 /napcat-webui 开头）
 * @returns {string} 目标路径
 */
function mapWebuiPath(p) {
  // 根路径静态资源：原样转发（NapCat WebUI 可能引用 /assets/*、/favicon.ico，防御性透传，内网同样受益）
  if (p.startsWith('/assets') || p === '/favicon.ico') return p;
  // [2026-08-08 FIX] NapCat WebUI 主题 CSS 由 JS fetch('/files/theme.css') 注入 <style>，
  // 必须原样透传 /files/*，否则经代理后 404 → 主题丢失（控制台反复报 Failed to load theme.css）。
  if (p.startsWith('/files')) return p;
  // [2026-08-08 FIX] 兼容旧式相对路径 <link href="theme.css">（解析为 /webui/theme.css）：
  // NapCat 实际资源在 /files/theme.css，这里做等价改写，避免 SPA fallback 的 text/html 被浏览器拒载。
  if (p === '/webui/theme.css') return '/files/theme.css';
  // 裸路径（/webui/*、/api/*）：原样转发（URL 与 React Router basename=/webui/ 匹配）
  if (p.startsWith('/webui') || p.startsWith('/api')) return p;
  // 带前缀路径（/napcat-webui/*）：去掉前缀
  let rest = p.slice('/napcat-webui'.length);
  if (rest === '') rest = '/';
  if (rest === '/') return '/webui/';
  return rest;
}
/**
 * 重写响应体中的绝对路径，使 WebUI 内部请求全部回到代理前缀下。
 * 覆盖 /webui/、/api/、/assets/ 三种前缀（HTML/JS/CSS/JSON 文本均适用）。
 * 注意：必须单次正则遍历替换，避免链式替换重复命中（如 /webui/assets 先被 /webui/ 规则改写后
 *       又被 /assets/ 规则二次改写，产生 /napcat-webui/webui/napcat-webui/assets 的错误前缀）。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function rewriteWebuiBody(buf) {
  const s = buf.toString('utf8');
  const out = s.replace(/\/(webui|api|assets|files)\//g, (m, p1) => '/napcat-webui/' + p1 + '/');
  return Buffer.from(out, 'utf8');
}

/**
 * 重写 Location 头（302 跳转目标），统一回到代理前缀（相对路径，浏览器基于当前 URL 解析）。
 * @param {string|string[]} loc
 * @returns {string}
 */
function rewriteLocation(loc) {
  const s = String(Array.isArray(loc) ? loc[0] : loc || '');
  const m = s.match(/^(?:https?:\/\/[^/]+)?(\/.*)$/);
  const p = m ? m[1] : s;
  return p.replace(/\/(webui|api|assets|files)\//g, (m2, p2) => '/napcat-webui/' + p2 + '/');
}

/**
 * 判断响应是否为可重写文本（HTML/JS/CSS/JSON 等）。
 * @param {Object} headers
 * @returns {boolean}
 */
function isTextual(headers) {
  const ct = (headers['content-type'] || '').toLowerCase();
  return /text\/html|text\/css|text\/javascript|application\/javascript|application\/x-javascript|application\/json|text\/plain|application\/xml|text\/xml|image\/svg\+xml/.test(ct);
}

/** 是否 HTML 响应（仅 HTML 需要路径重写；JS/CSS/JSON 不重写，避免破坏 API baseURL 逻辑） */
function isHtml(headers) {
  const ct = (headers['content-type'] || '').toLowerCase();
  return /text\/html/.test(ct);
}

/**
 * HTML 注入自动登录脚本：用 webui.json 的 token 自动完成 NapCat WebUI 登录。
 * NapCat WebUI 登录态存 localStorage（key='token'，值=JSON.stringify(Credential)），
 * 前端加载时读 localStorage → 带 Bearer 调 /auth/check → 已登录则进主界面。
 * 代理注入的 Bearer header 只对后端转发请求有效，前端自身不知道已登录，故需注入脚本：
 *   1) 已有 token → 先带 Bearer 调 /api/auth/check 校验：code:0 有效则静默（前端自己进）；
 *   2) 无效/缺失 → 用 token 算 SHA256(token+'.napcat') → POST /api/auth/login {hash} → 新 Credential
 *   3) localStorage.setItem('token', JSON.stringify(Credential)) + 重设标记 → location.reload() 一次
 *
 * 失效自愈（生产故障修复：NapCat 重启/重登后 Credential 失效，旧标记永久跳过导致锁死）：
 *   - 每次加载都校验 Credential，失效即重登，不再因旧标记永久跳过；
 *   - 防重入标记 __sea2_al_done 存时间戳（Date.now()）：5 分钟内不重试（防死循环），
 *     超过 5 分钟允许重新尝试——既解决"永久锁死"又保留"防死循环"；
 *     （旧版标记为 "1"：parseInt 得 1970 时间戳，视为已过期，自动迁移放行）
 *   - 自动登录成功 → 先设标记、再 reload 一次（reload 后脚本因 TTL 直接 return，不会二次 login）；
 *     （skipReload=true 时主页场景不 reload：getAdminToken 每次 adminFetch 动态读 localStorage，无需 reload）
 *   - login 失败（如 napcat token 配置变了）→ 设标记熔断、不 reload、不循环，停留登录页（console 提示）；
 *   - 校验有效 → 设标记静默返回（5 分钟内不再重复探测，减少请求）。
 * token 缺失时注入空脚本（页面停留登录页，用户可手输 token，符合需求兜底）。
 * @param {Buffer} buf HTML 响应体
 * @param {boolean} [skipReload] true 时登录成功只写 localStorage + 标记、不 location.reload()
 *   （主页/中间页场景：前端每次请求动态读 localStorage，无需刷新即可生效，避免首访闪烁）；
 *   默认 false 保留 reload（/webui/ 原生管理台 React 应用需刷新感知登录态）。
 * @returns {Buffer}
 */
function injectAutoLogin(buf, skipReload) {
  let hash = '';
  try {
    // [2026-08-08 FIX] 统一 /webui/ 后按当前活跃角色取配置：
    // SEA1_ACTIVE 用副号 docker 铁柱号 webui token，否则用主号 token。
    const cfg = getActiveWebuiConfig();
    if (cfg.token) {
      const crypto = require('node:crypto');
      hash = crypto.createHash('sha256').update(String(cfg.token) + '.napcat').digest('hex');
    }
  } catch (e) { /* token 缺失/损坏：不注入，停留登录页 */ }
  if (!hash) return buf;
  // skipReload=true：登录成功分支只写 Credential + markDone，不 reload（主页 getAdminToken 动态读 localStorage）
  const reloadStmt = skipReload ? '' : 'location.reload();';
  const script = `<script>(function(){try{
var K="__sea2_al_done",T="token",TTL=5*60*1000,now=Date.now();
var done=localStorage.getItem(K);
if(done){var dt=parseInt(done,10);if(!isNaN(dt)&&now-dt<TTL&&localStorage.getItem(T))return;}
function markDone(){try{localStorage.setItem(K,String(Date.now()));}catch(e){}}
function getCred(){try{var raw=localStorage.getItem(T);if(!raw)return "";var j=JSON.parse(raw);return(typeof j==="string")?j:((j&&(j.Credential||j.credential))||raw);}catch(e){return "";}}
function checkValid(cred){return fetch("/api/auth/check",{method:"POST",headers:{"Authorization":"Bearer "+cred}}).then(function(r){return r.json().catch(function(){return null;});}).then(function(j){return !!(j&&j.code===0);}).catch(function(){return false;});}
function doLogin(){return fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({hash:"${hash}"})}).then(function(r){return r.json().catch(function(){return null;});}).then(function(j){if(j&&j.code===0&&j.data&&j.data.Credential){localStorage.setItem(T,JSON.stringify(j.data.Credential));markDone();${reloadStmt}}else{markDone();if(window.console)window.console.warn("[sea2-autologin] login failed, stay on login page");}}).catch(function(){markDone();});}
var cred=getCred();
if(!cred){doLogin();return;}
checkValid(cred).then(function(ok){if(ok){markDone();return;}doLogin();});
}catch(e){}})();</script>`;
  const s = buf.toString('utf8');
  const out = s.replace(/<head[^>]*>/, function (m) { return m + script; });
  return Buffer.from(out, 'utf8');
}

/**
 * 读取并返回 public 目录下的 HTML 静态页（主页 /、/s 与 /webprint、/webprint.html 共用）。
 * 与裸 fs.readFile 的区别：返回前对 HTML 执行 injectAutoLogin(buf, true)（skipReload 模式），
 * 使中间页主页/打印页在同一 origin 下自动完成 NapCat WebUI 登录（写 localStorage 'token' Credential），
 * 从而前端 getAdminToken() 能经 /api/web-token 换取管理口令，双系统开关/打印等管理端点不再 401。
 * @param {string} file public 目录下文件名（index.html / webprint.html）
 * @param {ServerResponse} res
 */
function servePublicHtml(file, res) {
  fs.readFile(path.join(PUBLIC_DIR, file), function (err, buf) {
    if (err) { res.writeHead(404); return res.end('no page'); }
    if (buf && buf.length) buf = injectAutoLogin(buf, true);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/**
 * 获取（并缓存）WebUI 登录 Credential。
 * 代调 POST /api/auth/login {hash: SHA256(token + ".napcat")}，成功缓存 6 小时。
 * @param {boolean} [force] 强制重新获取（401 时使用）
 * @returns {Promise<string>} Credential，失败返回 ''（或退回旧 Credential）
 */
async function getWebuiCredential(force) {
  const now = Date.now();
  if (!force && webui.credential && now < webui.credentialExpire) return webui.credential;
  const cfg = readWebuiConfig();
  if (!cfg.token) {
    console.log('[webui] no token configured, cannot auto-login');
    return '';
  }
  const port = await detectWebuiPort();
  const hash = sha256Hex(cfg.token + '.napcat');
  let r = null;
  try {
    r = await httpRequestJson({
      host: WEBUI_TARGET_HOST,
      port,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    }, JSON.stringify({ hash }));
  } catch (e) {
    console.log('[webui] login request failed:', shortText(e && e.message ? e.message : e, 120));
    return webui.credential || ''; // 网络异常时退回旧 Credential
  }
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { j = null; }
  const cred = j && j.data && (j.data.Credential || j.data.credential || '');
  if (!cred) {
    console.log('[webui] login response missing Credential, http', r.status, shortText(r.body, 120));
    return webui.credential || '';
  }
  webui.credential = cred;
  webui.credentialExpire = now + WEBUI_CREDENTIAL_TTL;
  console.log('[webui] credential refreshed (len=' + cred.length + ')');
  return cred;
}

/**
 * 反向代理主流程：转发 /napcat-webui/* 到 NapCat WebUI，注入 Authorization: Bearer <Credential>。
 * 支持 401 时清缓存重取 Credential 并重试一次（重放已收集的请求体）。
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {string} fullUrl 含查询串的原始 URL
 * @param {boolean} [retried] 是否已重试过（防死循环）
 * @param {Buffer} [bodyBuf] 重试时复用已收集的请求体
 */
/**
 * 原生管理台代理不可达/失败时，给新开标签页一个友好的中文提示页（而非裸 JSON 报错）。
 * 典型场景：切换账号时原生 NapCat(:6100) 重启的短暂窗口内点击“打开管理台”会触发 ECONNREFUSED，
 * 此时返回“管理台启动中，请稍候重试”的提示，避免用户误以为功能坏掉。
 */
function webuiErrorHtml(title, detail) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title>'
    + '<style>body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
    + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
    + '.box{max-width:440px;padding:28px 32px;border:1px solid #30363d;border-radius:12px;background:#161b22;'
    + 'box-shadow:0 0 24px rgba(80,200,120,.15)}h2{margin:0 0 10px;color:#7ee787;font-size:18px}'
    + 'p{margin:6px 0;line-height:1.6;font-size:14px;color:#8b949e}code{color:#79c0ff}</style></head>'
    + '<body><div class="box"><h2>⚙️ ' + title + '</h2>'
    + '<p>' + detail + '</p>'
    + '<p>若刚执行过“切换账号”，原生 NapCat 正在重启，请等待约 10 秒后重新点击“打开管理台”。</p>'
    + '</div></body></html>';
}

async function proxyWebuiRequest(req, res, fullUrl, retried, bodyBuf) {
  const pathname = fullUrl.split('?')[0];
  if (!pathname.startsWith('/napcat-webui') && !pathname.startsWith('/webui') && !pathname.startsWith('/api') && !pathname.startsWith('/assets') && !pathname.startsWith('/files') && pathname !== '/favicon.ico') {
    res.writeHead(404); res.end('not found');
    return;
  }
  if (bodyBuf === undefined) bodyBuf = await collectBody(req);
  const query = fullUrl.indexOf('?') >= 0 ? '?' + fullUrl.split('?')[1] : '';
  // 入口重定向：/napcat-webui/ 必须落到 /webui/（匹配 React Router basename=/webui/，否则页面不渲染）
  if (pathname === '/napcat-webui' || pathname === '/napcat-webui/') {
    res.writeHead(302, { Location: '/webui/' + query, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const targetPath = mapWebuiPath(pathname) + query;

  // [2026-08-08 FIX] 统一 /webui/：目标端口按当前活跃角色动态决定（SEA1_ACTIVE→6099 副号，否则→主号探测端口）
  let port = WEBUI_KNOWN_PORT;
  try { port = await resolveWebuiTargetPort(); } catch (e) {}
  const isBackup = isBackupTargetPort(port);
  // Credential 必须与目标端口匹配：副号用 backup Credential（登录 6099），主号用主 Credential（登录探测端口）
  const cred = isBackup ? await getBackupWebuiCredential() : await getWebuiCredential();
  if (!cred) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(webuiErrorHtml('管理台未就绪', (isBackup ? '备份' : '原生') + ' WebUI 未配置 token（NapCat webui.json 缺失或无 token），无法自动登录。请检查 NapCat 配置后重试。'));
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(host|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|authorization|accept-encoding|content-length)$/i.test(k)) continue;
    headers[k] = v;
  }
  headers['host'] = WEBUI_TARGET_HOST + ':' + port;
  headers['authorization'] = 'Bearer ' + cred;
  headers['accept-encoding'] = 'identity'; // 强制未压缩，保证响应体可重写
  headers['content-length'] = bodyBuf.length;

  const proxyReq = http.request({ host: WEBUI_TARGET_HOST, port, method: req.method, path: targetPath, headers }, (proxyRes) => {
    const status = proxyRes.statusCode;
    // 401：Credential 失效，清缓存重取并重试一次（按目标端口取对应 Credential）
    if (status === 401 && !retried) {
      proxyRes.resume();
      if (isBackup) {
        backupWebui.credential = '';
        backupWebui.credentialExpire = 0;
        getBackupWebuiCredential(true).then((c2) => {
          if (c2) {
            proxyWebuiRequest(req, res, fullUrl, true, bodyBuf).catch((e2) => {
              if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'WebUI 代理重试失败: ' + shortText(e2 && e2.message ? e2.message : e2, 200) }));
              } else { res.destroy(); }
            });
          } else {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: '备份 WebUI 自动登录失败：Credential 获取无结果' }));
          }
        }).catch(() => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '备份 WebUI 自动登录异常' }));
        });
      } else {
        webui.credential = '';
        webui.credentialExpire = 0;
        getWebuiCredential(true).then((c2) => {
          if (c2) {
            proxyWebuiRequest(req, res, fullUrl, true, bodyBuf).catch((e2) => {
              if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'WebUI 代理重试失败: ' + shortText(e2 && e2.message ? e2.message : e2, 200) }));
              } else { res.destroy(); }
            });
          } else {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'WebUI 自动登录失败：Credential 获取无结果' }));
          }
        }).catch(() => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'WebUI 自动登录异常' }));
        });
      }
      return;
    }
    // 正常响应：收集 → 文本重写 → 回写
    const chunks = [];
    proxyRes.on('data', c => chunks.push(c));
    proxyRes.on('end', () => {
      let buf = Buffer.concat(chunks);
      const textual = isTextual(proxyRes.headers);
      // 只对 text/html 做路径重写（HTML 里的 /webui/assets 等绝对资源引用需改到代理前缀下）。
      // JS/CSS/JSON 一律不重写：JS 的 /api/xxx 请求会由前端按当前 origin（=代理地址）自动发出，
      // 代理的 mapWebuiPath 已处理 /api/* → 6100；重写 JS 会把 API 路径字符串改坏导致双重前缀 404。
      // 仅带 /napcat-webui 前缀时需重写；裸路径（/webui、/api）下资源路径天然正确，重写反而画蛇添足。
      const needsRewrite = pathname.startsWith('/napcat-webui');
      if (isHtml(proxyRes.headers) && needsRewrite && buf.length) buf = rewriteWebuiBody(buf);
      // HTML 注入自动登录脚本：用已知 token 自动完成 /auth/login → 写 localStorage → reload
      // （NapCat WebUI 登录态存 localStorage，代理注入的 Bearer header 只对后端请求有效，前端不知已登录）
      if (isHtml(proxyRes.headers) && buf.length) buf = injectAutoLogin(buf);
      const outHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (/^(content-length|connection|keep-alive|transfer-encoding|upgrade)$/i.test(k)) continue;
        if (k === 'location') outHeaders[k] = needsRewrite ? rewriteLocation(v) : v;
        else outHeaders[k] = v;
      }
      outHeaders['cache-control'] = 'no-store';
      res.writeHead(status, outHeaders);
      res.end(buf);
    });
  });
  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(webuiErrorHtml('管理台暂时无法打开', '原生管理台（NapCat WebUI）当前不可达：' + shortText(e && e.message ? e.message : e, 160) + '。'));
    } else { res.destroy(); }
  });
  proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('upstream timeout')));
  proxyReq.end(bodyBuf);
}

// ---------- 打印机识别 ----------
async function listPrinters() {
  // 已配置
  const { out: pa } = await exec('sh', ['-c', 'lpstat -p 2>/dev/null']);
  const configured = [];
  for (const line of (pa || '').split('\n')) {
    const m = line.match(/^printer (\S+) (?:is|disabled)/);
    if (m) {
      const name = m[1];
      const st = /idle/i.test(line) ? 'idle' : /busy|printing/i.test(line) ? 'printing' : /stopped|disabled/i.test(line) ? 'disabled' : 'unknown';
      configured.push({ name, status: st });
    }
  }
  // 已发现(未配置) 设备
  const { out: dv } = await exec('sh', ['-c', 'lpinfo -v 2>/dev/null']);
  const configuredUris = configured.map(c => c.uri);
  const discovered = [];
  for (const line of (dv || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const idx = t.search(/\s+(usb|dnssd|socket|lpd|ipp|https?|mdns|network|direct)\S*:\/\//) ;
    // 仅取带真实 URI 的行
    const uriMatch = t.match(/(usb|dnssd|mdns|socket|lpd|ipp|https?):\/\/\S+/);
    if (!uriMatch) continue;
    const uri = uriMatch[0].replace(/%20/g, ' ');
    const backend = uri.split('://')[0];
    const info = t.replace(uriMatch[0], '').replace(/^(direct|network)\s+/, '').replace(/^[\s:]+/, '').trim();
    discovered.push({ uri, backend, info: info || uri, make: guessMake(info || uri) });
  }
  // [PRINTER-MODEL] 覆盖成 CUPS 算好的"干净品牌型号"（取不到才回退 URI 清洗）
  await enrichDiscoveredModels(discovered);
  return { configured, discovered };
}
function guessMake(s) {
  const m = (s || '').match(/(hp|canon|epson|brother|samsung|xerox|lexmark|ricoh|kyocera|dell|panasonic|sharp|konica|oki|fuji)/i);
  return m ? m[1].toUpperCase() : '';
}

// ---------- 添加打印机 ----------
async function addPrinter(body) {
  const name = (body.name || '').trim();
  const uri = (body.uri || '').trim();
  const driver = (body.driver || '').trim();
  const location = (body.location || '').trim().replace(/[;&|`$()<>]/g, '');
  const isDefault = !!body.is_default;
  const pageSize = (body.page_size || 'A4').trim();
  // 严格校验
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return { ok: false, error: '打印机名称非法(仅字母数字_-，≤32)' };
  if (!/^(usb|dnssd|mdns|socket|lpd|ipp|https?):\/\/.+/.test(uri)) return { ok: false, error: 'URI 非法' };
  const drvOk = state.drivers.some(d => d.driver === driver);
  if (!drvOk) return { ok: false, error: '驱动不在已知驱动库中' };
  // 先删除同名旧打印机(若存在)
  await exec('lpadmin', ['-x', name]);
  let r = await exec('lpadmin', ['-p', name, '-v', uri, '-m', driver, '-L', location || name, '-E']);
  if (r.err && !/already exists/i.test(r.errout)) {
    return { ok: false, error: 'lpadmin 失败: ' + (r.errout || r.err).trim().slice(0, 200) };
  }
  await exec('lpadmin', ['-p', name, '-o', 'PageSize=' + pageSize]);
  if (isDefault) await exec('lpadmin', ['-d', name]);
  const v = await exec('sh', ['-c', 'lpstat -p ' + name + ' 2>/dev/null | head -1']);
  return { ok: true, name, uri, driver, is_default: isDefault, pageSize, verify: (v.out || '').trim() };
}

// ---------- 账号切换辅助：清除 autoLoginAccount + 动态清理会话 ----------

/**
 * 递归查找目录下所有指定文件名的路径（主机侧）。
 * @returns {string[]}
 */
function findFilesRecursive(root, name) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  try {
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git' || e.name === 'cache') continue;
          walk(p);
        } else if (e.name === name) {
          out.push(p);
        }
      }
    };
    walk(root);
  } catch (e) {}
  return out;
}

/**
 * 清空单个 napcat.json 的 autoLoginAccount 字段，强制重启后出现新二维码而非自动重登旧号。
 * @returns {{ok:boolean, detail:string}}
 */
function clearAutoLoginInFile(f) {
  try {
    if (!fs.existsSync(f)) return { ok: false, detail: '配置文件不存在: ' + f };
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (obj && obj.autoLoginAccount) {
      obj.autoLoginAccount = '';
      fs.writeFileSync(f, JSON.stringify(obj, null, 2));
      return { ok: true, detail: '已清除 autoLoginAccount: ' + f };
    }
    return { ok: true, detail: 'autoLoginAccount 本就为空: ' + f };
  } catch (e) {
    return { ok: false, detail: '清除 autoLoginAccount 失败(' + f + '): ' + shortText(String(e && e.message ? e.message : e), 160) };
  }
}

/**
 * [2026-08-28 FIX] 主号（宿主机 native NapCat）切换前：动态发现并清空 autoLoginAccount。
 * 不写死路径——在已知 SEA2 根目录（/root/sea2、/app/napcat）下递归查找 napcat.json。
 * 若主号 napcat.json 落在 .config 内，clearSea2Session 的 rm -rf 会一并清掉（重启后无 autoLoginAccount）；
 * 若落在 .config 外（如 /app/napcat/config），此步负责清空，二者互补。
 * @returns {{found:boolean, details:string[]}}
 */
async function clearMainAutoLogin() {
  const details = [];
  let found = false;
  for (const root of ['/root/sea2', '/app/napcat']) {
    for (const f of findFilesRecursive(root, 'napcat.json')) {
      const r = clearAutoLoginInFile(f);
      found = true;
      details.push(r.detail);
    }
  }
  // [2026-08-29 FIX] 主号自动登录同样钉死在 webui.json 的 autoLoginAccount，而非 napcat.json；
  // 之前只清 napcat.json 是无效操作。校正为正确的主号 UIN，避免被过期/外号钉死。
  try {
    if (fs.existsSync(WEBUI_CONFIG)) {
      const obj = JSON.parse(fs.readFileSync(WEBUI_CONFIG, 'utf8'));
      const prev = obj.autoLoginAccount;
      // [2026-08-30 产品化] 同副号：清空而非写死号码，登录后由 syncMainAutoLogin 自动回写真实 UIN
      obj.autoLoginAccount = '';
      fs.writeFileSync(WEBUI_CONFIG, JSON.stringify(obj, null, 2));
      details.push('主号 webui.json autoLoginAccount: ' + (prev || '(空)') + ' -> (空，扫码后自动写入)');
      found = true;
    }
  } catch (e) {
    details.push('主号 webui.json autoLoginAccount 校正失败: ' + shortText(String(e && e.message ? e.message : e), 160));
  }
  if (!found) details.push('未在 /root/sea2、/app/napcat 下发现 napcat.json（autoLoginAccount 未清除，需人工确认主号配置位置）');
  return { found, details };
}

/**
 * [2026-08-28 FIX] 副号（docker 铁柱号）切换前：容器内动态发现并清空 autoLoginAccount。
 * 通过 docker exec 在容器内用 node 改写（容器自带 node）。
 * @returns {{ok:boolean, details:string[]}}
 */
async function clearBackupAutoLogin() {
  const details = [];
  // [2026-08-29 FIX] 之前用 docker exec 在容器内翻 napcat.json 的 autoLoginAccount —— 但真正的
  // 自动登录目标在 webui.json（BACKUP_WEBUI_CONFIG，宿主挂载源），napcat.json 根本没这个字段，
  // 因此旧逻辑是无效操作，过期号 __BACKUP_QQ__ 一直被钉死。这里直接改宿主挂载的 webui.json。
  // 必须在容器停止、会话已清后调用（见 switchBackupAccount），避免运行中的 QQ 落盘覆盖。
  const f = BACKUP_WEBUI_CONFIG;
  try {
    if (!fs.existsSync(f)) {
      details.push('副号 webui.json 不存在: ' + f + '（autoLoginAccount 无法校正，需人工确认）');
      return { ok: false, details };
    }
    const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
    const prev = obj.autoLoginAccount;
    // [2026-08-30 产品化] 退出换号时【清空】而不是写死某个号：
    // 商业版不能预置号码（客户想换哪个号就换哪个）。清空后 NapCat 直接出码；
    // 扫码登录成功时由 syncBackupAutoLogin 自动回写真实 UIN，重启即自动登录新号。
    obj.autoLoginAccount = '';
    fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    details.push('副号 webui.json autoLoginAccount: ' + (prev || '(空)') + ' -> (空，扫码后自动写入)');
    return { ok: true, details };
  } catch (e) {
    details.push('副号 webui.json autoLoginAccount 校正失败: ' + shortText(String(e && e.message ? e.message : e), 160));
    return { ok: false, details };
  }
}

// ---------- 更换账号（退出当前 QQ 登录并触发新二维码） ----------
/**
 * 结束 SEA2 专属的 QQ 进程。
 * 用 `[q]q` 括号技巧构造正则，使 pkill 自身所在的 `sh -c ...` 命令行不会被自己的 pattern 命中，
 * 从而避免误杀执行该命令的 shell；同时该 pattern 只能匹配 /root/sea2/napcat 下的进程，
 * 绝不会命中 SEA/sea1 的 docker napcat。
 * @returns {Promise<{ok: boolean, killed: boolean, detail: string}>}
 */
async function killSea2Qq() {
  const pattern = SEA2.qqBinary.replace(/\/qq$/, '/[q]q');
  const r = await exec('sh', ['-c', "pkill -f '" + pattern + "' >/dev/null 2>&1; echo $?"], 15000);
  const code = parseInt((r.out || '').trim(), 10);
  // pkill 退出码：0=已杀掉进程，1=无匹配进程(也视为成功，可能本来就没在跑)
  if (code === 0 || code === 1) {
    return { ok: true, killed: code === 0, detail: code === 0 ? '已结束 SEA2 QQ 进程' : '未发现运行中的 SEA2 QQ 进程' };
  }
  return { ok: false, killed: false, detail: 'pkill 异常退出码 ' + (isNaN(code) ? '?' : code) + ' ' + shortText(r.errout, 120) };
}

/**
 * 清除 SEA2 的登录会话目录。仅允许删除白名单内的路径。
 * @returns {Promise<{ok: boolean, detail: string, error?: string}>}
 */
async function clearSea2Session() {
  const dir = SEA2.configDir;
  if (!REMOVABLE_DIRS.includes(dir)) {
    return { ok: false, detail: '', error: '拒绝删除非白名单路径: ' + dir };
  }
  const r = await exec('rm', ['-rf', dir], 15000);
  if (r.err) {
    return { ok: false, detail: '', error: 'rm -rf 失败: ' + shortText(r.errout || r.err.message, 200) };
  }
  return { ok: true, detail: '已清除登录会话 ' + dir };
}

/**
 * 固化当前主号 onebot11 的 network 块为模板文件，供换号后继承（删除旧配置后仍有模板来源）。
 * @returns {boolean} 是否成功固化
 */
async function snapshotMainNetworkTemplate() {
  try {
    for (const u of hostListOnebotUins()) {
      if (NON_BOT_UINS.has(String(u))) continue;
      const { found, data } = hostReadOnebot(u);
      if (found && hasNetwork(data)) {
        fs.writeFileSync(NATIVE_ONEBOT_TEMPLATE, JSON.stringify({ network: data.network }, null, 2));
        return true;
      }
    }
  } catch (e) { console.error('[switch] 固化主号 network 模板失败', e); }
  return false;
}

/**
 * 清除旧的（非管理员）主号 onebot11 配置，释放被旧配置占用的 HTTP 端口（如 :4000），
 * 使换号后的新主号能干净接管该端口，控制台轮询即可检测到。
 * 保留管理员号（NON_BOT_UINS）配置不受影响。
 * @returns {boolean}
 */
function clearStaleMainOnebotConfigs() {
  try {
    const files = fs.readdirSync(NATIVE_NAPCAT_CONFIG_DIR).filter(f => /^onebot11_.*\.json$/.test(f));
    for (const f of files) {
      const uin = f.replace(/^onebot11_/, '').replace(/\.json$/, '');
      if (NON_BOT_UINS.has(String(uin))) continue; // 保留管理员号
      fs.unlinkSync(path.join(NATIVE_NAPCAT_CONFIG_DIR, f));
    }
    return true;
  } catch (e) { console.error('[switch] 清除旧主号 onebot11 配置失败', e); return false; }
}

/**
 * 清除副号（docker）旧的、非管理员的 onebot11 配置，释放被占用的 :3000。
 * 副号容器里历史上堆积了多个同样配置 :3000 的 onebot11（如 __BACKUP_QQ__ / __BACKUP_QQ__ / __MAIN_QQ__），
 * 端口争用会让新登录的号起不到监听 → "副号新号不能在控制台上线"。
 * 保留管理员号；网络配置靠副号模板/INHERIT 重新补齐，不丢失端口与 token。
 * @returns {{ok: boolean, removed: string[], error?: string}}
 */
function clearStaleBackupOnebotConfigs() {
  try {
    const files = fs.readdirSync(BACKUP_NAPCAT_CONFIG_DIR).filter(f => /^onebot11_\d+\.json$/.test(f));
    const removed = [];
    for (const f of files) {
      const uin = f.replace(/^onebot11_/, '').replace(/\.json$/, '');
      if (NON_BOT_UINS.has(String(uin))) continue; // 保留管理员号
      fs.unlinkSync(path.join(BACKUP_NAPCAT_CONFIG_DIR, f));
      removed.push(uin);
    }
    return { ok: true, removed };
  } catch (e) {
    console.error('[switch] 清除旧副号 onebot11 配置失败', e);
    return { ok: false, removed: [], error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 清除副号（docker）旧的、非管理员的 napcat_<uin>.json / napcat_protocol_<uin>.json 核心配置。
 * 历史堆积的过期/外号核心配置（如 __BACKUP_QQ__ 过期号、__MAIN_QQ__ 主号误入）会让 NapCat 把"自动快速登录"
 * 错误地定向到这些号——哪怕它们登录态早已失效、且真正要上线的号（__BACKUP_QQ__）明明在"可用于快速登录"列表里，
 * 也会被跳过。表现为：副号永远上不了线、控制台检测不到。
 * 换号时一并清掉，强制 NapCat 只认"当前真正登录的号"。与 onebot11 清理同理，但清的是账号核心配置（非网络配置）。
 * 注：网络配置在 config.json / webui.json / 模板文件，本函数一个都不动。
 * @returns {{ok: boolean, removed: string[], error?: string}}
 */
function clearStaleBackupCoreConfigs() {
  try {
    const files = fs.readdirSync(BACKUP_NAPCAT_CONFIG_DIR).filter(f => /^napcat_(protocol_)?\d+\.json$/.test(f));
    const removed = [];
    for (const f of files) {
      const uin = f.replace(/^napcat_(protocol_)?/, '').replace(/\.json$/, '');
      if (NON_BOT_UINS.has(String(uin))) continue; // 保留管理员号
      fs.unlinkSync(path.join(BACKUP_NAPCAT_CONFIG_DIR, f));
      removed.push(uin);
    }
    return { ok: true, removed };
  } catch (e) {
    console.error('[switch] 清除旧副号核心配置失败', e);
    return { ok: false, removed: [], error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 依次尝试候选 pm2 路径重启指定应用。
 * @param {string} app pm2 应用名
 * @returns {Promise<{ok: boolean, detail: string, error?: string}>}
 */
async function pm2Restart(app) {
  let lastErr = '';
  for (const bin of PM2_CANDIDATES) {
    const r = await exec(bin, ['restart', app], 30000);
    if (!r.err) {
      return { ok: true, detail: 'pm2(' + bin + ') restart ' + app + ' 成功' };
    }
    lastErr = shortText(r.errout || r.err.message, 200);
    if (r.err.code === 'ENOENT') continue; // 该候选路径没有 pm2，试下一个
    return { ok: false, detail: '', error: 'pm2 restart ' + app + ' 失败: ' + lastErr };
  }
  return { ok: false, detail: '', error: '未找到可用的 pm2 可执行文件' + (lastErr ? ' (' + lastErr + ')' : '') };
}

/**
 * pm2 控制（stop / start / restart）。
 * 关键：换号清会话前必须用 stop 而不是 kill/pkill —— QQ 由 pm2 托管，
 * 直接 kill 会被 pm2 立即自动拉起，导致"清会话时 QQ 正在运行、退出时把登录态写回磁盘"，
 * 重启后旧账号自动复活（即"只能登老号""退出后自己重新上线"的真因）。
 * @param {'stop'|'start'|'restart'} action
 * @param {string} app pm2 应用名
 * @returns {Promise<{ok: boolean, detail: string, error?: string}>}
 */
async function pm2Control(action, app) {
  let lastErr = '';
  for (const bin of PM2_CANDIDATES) {
    const r = await exec(bin, [action, app], 60000);
    if (!r.err) return { ok: true, detail: 'pm2(' + bin + ') ' + action + ' ' + app + ' 成功' };
    lastErr = shortText(r.errout || r.err.message, 200);
    if (r.err.code === 'ENOENT') continue;
    return { ok: false, detail: '', error: 'pm2 ' + action + ' ' + app + ' 失败: ' + lastErr };
  }
  return { ok: false, detail: '', error: '未找到可用的 pm2 可执行文件' + (lastErr ? ' (' + lastErr + ')' : '') };
}

/**
 * 轮询等待 SEA2 的 QQ 进程完全退出。
 * 必须在清除会话前确认进程已死，否则 QQ 退出落盘会把登录态写回，清了也白清。
 * @param {number} timeoutMs 最长等待时间
 * @returns {Promise<boolean>} 进程是否已全部退出
 */
async function waitQqExit(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  while (Date.now() < deadline) {
    const r = await exec('sh', ['-c', "pgrep -f '" + SEA2.qqBinary.replace(/\/qq$/, '/[q]q') + "' | wc -l"], 8000);
    const n = parseInt((r.out || '1').trim(), 10);
    if (n === 0) return true;
    await sleep(700);
  }
  return false;
}

/**
 * 更换账号主流程：停止 napcat → 等 QQ 完全退出 → 固化网络模板 → 清旧 onebot11 →
 * 清除登录会话 → 启动 napcat（全新二维码）。全过程只操作 SEA2 专属路径。
 * 全过程只操作 SEA2 专属路径，与 SEA/sea1 完全隔离。
 * @returns {Promise<{ok: boolean, msg?: string, error?: string, steps: Array<Object>}>}
 */
async function switchAccount() {
  if (state.switching) {
    return { ok: false, error: '账号切换正在进行中，请稍候再试', steps: [] };
  }
  state.switching = true;
  const steps = [];
  try {
    // ① 先 stop（绝不能只 kill）：QQ 由 pm2 托管，kill 会被 pm2 立即自动拉起，
    //    于是"清会话"时 QQ 仍在运行，它退出落盘时会把登录态写回 → 旧号复活（只能登老号的真因）。
    const st = await pm2Control('stop', SEA2.pm2App);
    steps.push({ step: 'pm2_stop', ok: st.ok, detail: st.ok ? st.detail : st.error });
    if (!st.ok) return { ok: false, error: st.error, steps };

    // ② 等 QQ 完全退出（pm2 已 stop，不会再被拉起）；超时则补刀强杀
    const gone = await waitQqExit(15000);
    if (gone) {
      steps.push({ step: 'wait_qq_exit', ok: true, detail: 'QQ 已完全退出，不会再写回会话' });
    } else {
      const k = await killSea2Qq();
      const gone2 = await waitQqExit(8000);
      steps.push({ step: 'force_kill_qq', ok: gone2, detail: '等待退出超时，强杀(' + k.detail + ')，二次确认=' + (gone2 ? '已退出' : '仍未退出') });
    }

    // ③ 清空 autoLoginAccount 防御（停服状态下改文件，避免被运行中的 QQ 覆盖）
    const al = await clearMainAutoLogin();
    steps.push({ step: 'clear_autoLogin', ok: al.found, detail: al.details.join(' ; ') || '已尝试清除主号 autoLoginAccount' });

    // ④ 固化网络模板（删 onebot11 之前）+ 清旧 onebot11 释放 :4000。
    //    网络配置以模板形式保留，后续注入新号 —— 满足"网络配置不能清除"。
    const snap = await snapshotMainNetworkTemplate();
    steps.push({ step: 'snapshot_template', ok: !!snap, detail: snap ? '已固化网络模板（端口/token/WS 保留）' : '固化模板失败（将回退实时扫描）' });
    const clr = clearStaleMainOnebotConfigs();
    steps.push({ step: 'clear_onebot_configs', ok: clr, detail: clr ? '已清旧主号 onebot11（模板已保留网络配置，保留管理员号 __ADMIN_QQ__）' : '清除主号 onebot11 配置失败' });

    // ⑤ 清除登录会话（此时 QQ 已停，不可能写回）
    const c = await clearSea2Session();
    steps.push({ step: 'clear_session', ok: c.ok, detail: c.ok ? c.detail : c.error });
    if (!c.ok) {
      await pm2Control('start', SEA2.pm2App); // 失败要恢复服务，避免机器人掉线
      return { ok: false, error: c.error, steps };
    }

    // ⑥ 启动 napcat → 无会话 → 全新二维码
    const p = await pm2Control('start', SEA2.pm2App);
    steps.push({ step: 'pm2_start', ok: p.ok, detail: p.ok ? p.detail : p.error });
    if (!p.ok) {
      return { ok: false, error: p.error + '（会话已清除，请手动执行 pm2 start ' + SEA2.pm2App + '）', steps };
    }

    // 立即复位本地状态，前端可马上回到“等待扫码”视图
    state.connected = false;
    state.token = '';
    state.loginInfo = emptyLoginInfo(); // 清空旧账号信息，避免切换后残留
    console.log('[switch] account switched (session cleared), waiting for new qrcode');
    triggerInheritSoon('main'); // [INHERIT] 换号后主动补全主号 onebot11 network（tick 兜底）
    return { ok: true, msg: '已退出并清除登录缓存，请扫描新二维码全新登录', steps };
  } catch (e) {
    steps.push({ step: 'exception', ok: false, detail: String(e && e.message ? e.message : e) });
    return { ok: false, error: '切换账号异常: ' + shortText(e && e.message ? e.message : e, 200), steps };
  } finally {
    state.switching = false;
  }
}

// [2026-08-08] 副号（docker 铁柱号）退出重登：删容器内会话目录 + 重启容器 -> 新二维码
async function switchBackupAccount() {
  if (state.switching) {
    return { ok: false, error: '账号切换正在进行中，请稍候再试', steps: [] };
  }
  state.switching = true;
  const steps = [];
  try {
    // ② 停容器（绝不能运行中删会话）：容器里的 QQ 退出落盘时会把登录态写回，
    //    于是"清完重启又自动上线旧号"——副号该现象的真因之一。
    const stopR = await exec('docker', ['stop', 'napcat'], 90000);
    const stopped = !stopR.err;
    steps.push({ step: 'docker_stop', ok: stopped, detail: stopped ? 'docker 副号已停止（QQ 已退出，不会再写回会话）' : ('停止失败: ' + shortText(stopR.errout || stopR.err.message, 160)) });
    if (!stopped) return { ok: false, error: '停止 docker napcat 失败，未清除会话', steps };

    // ③ 清除【全部】登录态数据：在宿主机挂载点删除（容器已停，不可能被写回）。
    //    关键：除 nt_qq_<hash> 账号会话外，还必须清掉通用全局库 nt_qq（其 global/nt_db 存账号列表）
    //    与 NapCat 数据目录 —— 实测只删 nt_qq_* 会让 NapCat 从全局库把旧号恢复回来。
    //    不写死单个 hash：换号后 hash 会变，写死会清错/漏清。
    //    注：网络配置在 /root/napcat/config（另一目录），不受影响。
    const r1 = await exec('sh', ['-c', 'rm -rf /root/napcat/.config/nt_qq_* /root/napcat/.config/nt_qq /root/napcat/.config/NapCat && echo CLEARED'], 30000);
    const cleared = !r1.err && /CLEARED/.test(r1.out || '');
    steps.push({ step: 'clear_session', ok: cleared, detail: cleared ? '已清除副号全部登录会话（宿主机挂载点 /root/napcat/.config）' : ('清除会话失败: ' + shortText(r1.errout || r1.out || '', 160)) });
    if (!cleared) {
      await exec('docker', ['start', 'napcat'], 90000); // 失败要恢复服务，避免副号掉线
      return { ok: false, error: '清除副号会话失败，已尝试恢复容器', steps };
    }

    // ③.4 先固化副号网络模板（清理之前！），保证清理后仍有模板可重建；
    //     否则所有配置变空壳后会找不到模板 → 跳过补写 → OneBot 永不启动（副号彻底上不了线）。
    const bsnap = await snapshotBackupNetworkTemplate();
    steps.push({ step: 'snapshot_backup_template', ok: bsnap, detail: bsnap ? '已固化副号网络模板（端口/token/WS 保留）' : '无可固化配置，将启用内置兜底模板' });

    // ③.5 清除副号历史残留的 onebot11（多份都配置 :3000 会争用端口，导致新号起不来）
    const bc = clearStaleBackupOnebotConfigs();
    steps.push({ step: 'clear_backup_onebot', ok: bc.ok, detail: bc.ok ? ('已清副号历史 onebot11: ' + (bc.removed.join(',') || '(无)') + '，:3000 已释放给新号') : ('清除失败: ' + (bc.error || '')) });

    // ③.6 清除副号历史残留的核心配置 napcat_<uin>.json / napcat_protocol_<uin>.json（非管理员）。
    // 关键：过期/外号核心配置（__BACKUP_QQ__ 过期号、__MAIN_QQ__ 主号误入）会让 NapCat 把"自动快速登录"
    // 错误定向到它们，导致真正要上线的号永远拿不到登录态、控制台检测不到。清掉后 NapCat 只认当前号。
    const bcc = clearStaleBackupCoreConfigs();
    steps.push({ step: 'clear_backup_core', ok: bcc.ok, detail: bcc.ok ? ('已清副号历史核心配置: ' + (bcc.removed.join(',') || '(无)') + '，自动登录将只认当前号') : ('清除失败: ' + (bcc.error || '')) });

    // ③.7 [2026-08-29 FIX] 校正副号 webui.json 的 autoLoginAccount 为正确副号 UIN。
    // 关键：自动登录目标由 webui.json（而非 napcat.json）决定；之前只改 napcat.json 是无效操作。
    // 必须在容器停止、会话已清后执行，避免运行中的 QQ 落盘覆盖；下一步 docker start 即读取新值。
    const al = await clearBackupAutoLogin();
    steps.push({ step: 'correct_autoLogin', ok: al.ok, detail: al.details.join(' ; ') || '已校正副号 autoLoginAccount' });

    // ④ 启动容器 → 无会话 → 全新二维码
    const r2 = await exec('docker', ['start', 'napcat'], 90000);
    const ok2 = !r2.err;
    steps.push({ step: 'docker_start', ok: ok2, detail: ok2 ? 'docker 副号已启动，等待新二维码' : ('启动失败: ' + shortText(r2.errout || r2.err.message, 160)) });
    if (!ok2) return { ok: false, error: 'docker napcat 启动失败，请手动 docker start napcat', steps };
    triggerInheritSoon('backup'); // [INHERIT] 换号后主动补全副号 onebot11 network（tick 兜底）
    state.backupLoginInfo = emptyLoginInfo(); // 清空旧副号登录态，避免切换后残留
    return { ok: true, msg: '副号已退出并清除登录缓存，请扫描新二维码全新登录', steps };
  } catch (e) {
    steps.push({ step: 'exception', ok: false, detail: String(e && e.message ? e.message : e) });
    return { ok: false, error: '切换副号异常: ' + shortText(e && e.message ? e.message : e, 200), steps };
  } finally {
    state.switching = false;
  }
}

// ---------- [R9 R4] Web 打印：上传校验 / base64 落盘（纯函数，可单测） ----------
const WEBPRINT_MAX_BYTES = 50 * 1024 * 1024;   // ≤50MB
const WEBPRINT_ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf)$/i;
const WEBPRINT_ALLOWED_EXT = /\.(png|jpe?g|jpeg|gif|webp|bmp|pdf)$/i;

/**
 * 校验上传 payload。
 * @param {object} payload {fileName, mime, size, dataBase64}
 * @returns {{ok:boolean, error?:string}}
 */
function validateUploadPayload(payload) {
  payload = payload || {};
  const fileName = String(payload.fileName || '').trim();
  const mime = String(payload.mime || '').toLowerCase().trim();
  const size = Number(payload.size);
  const b64 = String(payload.dataBase64 || '');
  if (!fileName) return { ok: false, error: 'fileName 必填' };
  if (fileName.length > 255) return { ok: false, error: '文件名过长' };
  if (!WEBPRINT_ALLOWED_EXT.test(fileName)) return { ok: false, error: '仅支持图片与 PDF 文件' };
  if (!WEBPRINT_ALLOWED_MIME.test(mime)) return { ok: false, error: '仅支持 image/* 与 application/pdf' };
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'size 非法' };
  if (size > WEBPRINT_MAX_BYTES) return { ok: false, error: '文件超过 50MB 上限' };
  if (!b64) return { ok: false, error: 'dataBase64 必填' };
  // 实际解码字节数校验（防伪造 size）
  let decodedLen = 0;
  try { decodedLen = Buffer.from(b64, 'base64').length; } catch (e) { decodedLen = 0; }
  if (decodedLen <= 0) return { ok: false, error: 'dataBase64 解码为空' };
  if (decodedLen > WEBPRINT_MAX_BYTES) return { ok: false, error: '文件超过 50MB 上限（解码后）' };
  return { ok: true };
}

/**
 * 保存 base64 上传到 uploads 目录（防路径穿越：文件名白名单化）。
 * @param {object} payload {fileName, mime, size, dataBase64}
 * @param {string} [uploadDir]
 * @returns {{ok:boolean, filePath?:string, fileName?:string, size?:number, type?:string, error?:string}}
 */
function saveUpload(payload, uploadDir) {
  const dir = uploadDir || SEA2_WEBPRINT_UPLOADS;
  const v = validateUploadPayload(payload);
  if (!v.ok) return { ok: false, error: v.error };
  const rawName = String(payload.fileName || '').trim();
  // 仅保留安全字符（去路径分隔符/../），生成唯一文件名
  const safeBase = rawName.replace(/[\\/]/g, '_').replace(/\.\./g, '_').replace(/[^A-Za-z0-9_.\-\u4e00-\u9fa5]/g, '_');
  const stamp = Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  const fileName = stamp + '_' + safeBase;
  const filePath = path.join(dir, fileName);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const buf = Buffer.from(String(payload.dataBase64 || ''), 'base64');
    fs.writeFileSync(filePath, buf);
    return {
      ok: true,
      filePath,
      fileName,
      size: buf.length,
      type: String(payload.mime || '').toLowerCase(),
    };
  } catch (e) {
    return { ok: false, error: '保存失败: ' + String(e && e.message || e) };
  }
}

/** [R9 R4] 清理 uploads 目录中超过 24h 的上传文件 */
function cleanupUploads(uploadDir, maxAgeMs) {
  const dir = uploadDir || SEA2_WEBPRINT_UPLOADS;
  const age = maxAgeMs || 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return removed;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (st.isFile() && now - st.mtimeMs > age) {
          fs.unlinkSync(fp);
          removed += 1;
        }
      } catch (e) { /* 单文件失败跳过 */ }
    }
  } catch (e) { /* 目录不可用跳过 */ }
  return removed;
}

// ---------- [R9] 服务端 / printServer 转发助手 ----------
/** 向 sea2-server 发起 ops 请求（JSON），返回 {ok, status, body} */
async function opsRequest(method, apiPath, bodyObj) {
  const url = SEA2_SERVER_URL + apiPath;
  try {
    const r = await requestRaw(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-ops-token': SEA2_OPS_TOKEN },
      body: bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : undefined,
      timeout: 10000,
    });
    let j = null;
    try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { j = null; }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, body: j };
  } catch (e) {
    return { ok: false, status: 0, body: { ok: false, error: '服务端不可达: ' + String(e && e.message || e) } };
  }
}

/** 向本地 printServer（127.0.0.1:13012）转发 JSON 请求 */
async function printServerRequest(method, apiPath, bodyObj) {
  const url = SEA2_WEBPRINT_URL + apiPath;
  try {
    const r = await requestRaw(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : undefined,
      timeout: 15000,
    });
    let j = null;
    try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { j = null; }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, body: j };
  } catch (e) {
    return { ok: false, status: 0, body: { ok: false, error: '打印服务不可达: ' + String(e && e.message || e) } };
  }
}

// ---------- [O-2] 管理端点统一口令门禁（x-web-token） ----------
// 背景：qr-server 0.0.0.0 监听 + frp 外网可达，/api/dual/*、/api/account/switch、/api/webprint/*、
//       /api/printer/* 等管理端点此前无鉴权 → 任意人可远程开关双系统/切账号/提交打印。
// 方案：管理操作一律要求请求头 `x-web-token: <token>`，否则 401；token 未配置 → 503 fail-closed。
// 前端在中间页 NapCat WebUI 登录后（localStorage 已有 Credential），经 /api/web-token 换取
// 管理口令并存入 localStorage，调用管理端点时自动附带。

/** 生效管理口令：WEB_ADMIN_TOKEN（env/ops.env）优先，回落 SEA2_OPS_TOKEN；均空 → ''（fail-closed） */
function getWebAdminToken() {
  const envToken = (process.env.WEB_ADMIN_TOKEN || '').trim();
  return envToken || WEB_ADMIN_TOKEN || SEA2_OPS_TOKEN || '';
}

/**
 * 校验请求头 x-web-token。
 * @param {object} req
 * @returns {{ok:boolean, status?:number, error?:string}}
 */
function verifyWebTokenHeader(req) {
  const expected = getWebAdminToken();
  if (!expected) return { ok: false, status: 503, error: '未配置管理口令（WEB_ADMIN_TOKEN），管理接口已停用' };
  const provided = String((req && req.headers && req.headers['x-web-token']) || '').trim();
  if (!provided || provided !== expected) return { ok: false, status: 401, error: '需要有效的管理口令（x-web-token）' };
  return { ok: true };
}

/**
 * 管理端点门禁：通过返回 true；不通过则写 401/503 响应并返回 false。
 * @param {object} req
 * @param {object} res
 * @returns {boolean}
 */
function requireWebToken(req, res) {
  const v = verifyWebTokenHeader(req);
  if (v.ok) return true;
  res.writeHead(v.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: v.error }));
  return false;
}

// 测试注入：替换 NapCat Credential 校验器（默认走真实 NapCat /api/auth/check）
let _webTokenValidator = null;
function __setWebTokenValidator(fn) { _webTokenValidator = fn; }

/**
 * 校验客户端持有的 NapCat WebUI Credential 是否有效（POST /api/auth/check，code===0）。
 * 用于 /api/web-token 发证：只有持有效 NapCat 会话（已登录用户）才能换取管理口令。
 * @param {string} cred
 * @returns {Promise<boolean>}
 */
async function validateNapcatCredential(cred) {
  if (_webTokenValidator) return !!_webTokenValidator(cred);
  if (!cred) return false;
  let port = WEBUI_KNOWN_PORT;
  // [2026-08-08 FIX] 统一 /webui/ 后按当前活跃角色校验（SEA1_ACTIVE→副号 6099），
  // 否则 /api/web-token 在副号上岗时永远校验失败 → 管理端点 401。
  try { port = await resolveWebuiTargetPort(); } catch (e) {}
  try {
    const r = await httpRequestJson({
      host: WEBUI_TARGET_HOST,
      port,
      path: '/api/auth/check',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + String(cred).trim() },
      timeout: 8000,
    }, '{}');
    let j = null;
    try { j = JSON.parse(r.body); } catch (e) { j = null; }
    return !!(j && j.code === 0);
  } catch (e) {
    return false;
  }
}

// ---------- HTTP ----------
const server = http.createServer(async function (req, res) {
  const url = req.url.split('?')[0];
  const q = req.url.indexOf('?') >= 0 ? new URLSearchParams(req.url.split('?')[1]) : new URLSearchParams();

  // 静态页（主页：注入自动登录脚本，保证双系统开关等管理端点可用——
  // getAdminToken 需 localStorage Credential，经 /api/web-token 换管理口令，否则永远 401）
  if (url === '/' || url === '/s') {
    servePublicHtml('index.html', res);
    return;
  }

  // 登录二维码图
  if (url === '/qr.png') {
    fs.readFile(QR_PATH, function (err, buf) {
      if (err) { res.writeHead(404); return res.end('no qr'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  // 副号（docker 铁柱号）二维码：docker exec napcat cat 读取容器内二维码；失败 404
  // 注意：必须 encoding:null 以 Buffer 读二进制 PNG，否则 utf8 解码会损坏图片头（PNG → �PNG）
  if (url === '/backup-qr.png') {
    try {
      // [2026-08-30 FIX] 先校验二维码新鲜度：过期/容器停止时绝不返回旧码，
      // 改用 409 + JSON 让前端显示"已过期，等待刷新"，避免用户扫废码喂风控。
      const mtimeMs = await new Promise((resolve) => {
        cp.execFile('docker', ['exec', 'napcat', 'stat', '-c', '%Y', BACKUP_QR_PATH],
          { timeout: 8000, encoding: 'utf8' }, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const mt = parseInt(String(stdout).trim(), 10) * 1000;
            resolve(isNaN(mt) ? null : mt);
          });
      });
      if (mtimeMs === null) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ ok: false, stale: true, msg: '副号二维码不可用（容器可能已停止）' }));
      }
      const ageMs = Date.now() - mtimeMs;
      if (ageMs > BACKUP_QR_MAX_AGE_MS) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({
          ok: false, stale: true, ageMs,
          msg: '二维码已过期，正在等待 NapCat 刷新，请稍候（勿重复扫码）',
        }));
      }
      const buf = await new Promise((resolve, reject) => {
        cp.execFile('docker', ['exec', 'napcat', 'cat', BACKUP_QR_PATH], { timeout: 15000, killSignal: 'SIGKILL', encoding: null, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout);
        });
      });
      if (!buf || !buf.length) {
        res.writeHead(404);
        return res.end('no backup qr');
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(buf);
    } catch (e) {
      res.writeHead(404);
      return res.end('no backup qr');
    }
  }

  // 固定码(动态绑定 LAN IP)
  if (url === '/fixed.png') {
    try {
      if (!QRCode) QRCode = require('qrcode');
      const png = await QRCode.toBuffer(fixedUrl(), { width: 360, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    } catch (e) {
      res.writeHead(500); return res.end('qr gen err');
    }
  }

  // 原生 WebUI 反向代理：/napcat-webui/* → NapCat WebUI，自动注入 Credential 实现真正登录
  // [2026-08-08] 副号（docker 铁柱号）原生 WebUI 代理
  if (url.startsWith('/backup-webui')) {
    proxyBackupWebuiRequest(req, res, req.url).catch((e) => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'backup WebUI 代理异常: ' + shortText(e && e.message ? e.message : e, 200) })); } else { res.destroy(); }
    });
    return;
  }

  if (url.startsWith('/napcat-webui')) {
    proxyWebuiRequest(req, res, req.url).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'WebUI 代理异常: ' + shortText(e && e.message ? e.message : e, 200) }));
      } else { res.destroy(); }
    });
    return;
  }

  // API
  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // [CONN-3STATE] conn_state: connected=在线可用 / connecting=QQ已登录但控制通道未建立 / offline=未登录
    const _loggedIn = !!(state.loginInfo && state.loginInfo.loggedIn) || !!(state.backupLoginInfo && state.backupLoginInfo.loggedIn);
    const _connState = state.connected ? 'connected' : (_loggedIn ? 'connecting' : 'offline');
    return res.end(JSON.stringify({ connected: state.connected, conn_state: _connState, ws_ok: state.wsOk === true, account_online: state.accountOnline === true, lan_ip: state.lanIp, external: EXTERNAL_URL || null, fixed_url: fixedUrl(), token: state.token ? 'present' : 'absent', switching: state.switching, role: readFrameworkRole(), login_info: state.loginInfo, backup_login_info: state.backupLoginInfo, napcat_http_configured: !!NAPCAT_HTTP_TOKEN, ts: Date.now() }));
  }

  // 原生管理台入口信息：返回指向本服务代理的地址（自动登录由代理完成）
  if (url === '/api/webui') {
    try {
      const r = await buildWebuiUrl();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(Object.assign({}, r, { ts: Date.now() })));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'WebUI 探测失败: ' + shortText(e && e.message ? e.message : e, 200) }));
    }
  }

  // 原生管理台排障诊断（白屏时先看此接口）：入口地址 + 隧道提示
  if (url === '/api/webui/diag') {
    try {
      const r = await buildWebuiUrl();
      const upstreamReachable = await tcpProbe(WEBUI_TARGET_HOST, r.port, 2000);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ok: true,
        entryUrl: r.entryUrl,
        externalUrl: EXTERNAL_URL || null,
        lanIp: state.lanIp || '',
        port: r.port,
        wsSupported: true, // 本代理已支持 /webui、/api 的 WS Upgrade 透传
        upstreamReachable,
        hints: [
          'frp 隧道需 type=tcp 透传 13011 单端口（HTTP+WS 全透传）',
          '若使用 HTTP 隧道/反代，必须透传 Upgrade 头（proxy_set_header Upgrade $http_upgrade; Connection "upgrade"）',
          '内网访问正常、外网白屏 = 隧道未透传 WebSocket，请检查 frp 是否 TCP 模式',
          '可点「复制地址」在外网浏览器重试',
        ],
        ts: Date.now(),
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'WebUI 诊断失败: ' + shortText(e && e.message ? e.message : e, 200) }));
    }
  }

  // QQ 头像同源代理：/api/avatar?qq= → qlogo.cn（服务端 fetch 回写；失败降级字母头像 SVG，保证同源、布局不破）
  if (url === '/api/avatar') {
    const qq = (q.get('qq') || '').trim();
    if (!/^\d{5,12}$/.test(qq)) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'qq 参数非法' }));
    }
    try {
      const img = await requestRaw('https://q1.qlogo.cn/g?b=qq&nk=' + qq + '&s=100', { timeout: 5000, maxRedirects: 3 });
      if (img.status === 200 && img.body && img.body.length > 0) {
        const ct = (img.headers['content-type'] || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
        return res.end(img.body);
      }
    } catch (e) { /* qlogo 不可达（离线/内网）→ 字母头像兜底 */ }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
    return res.end(letterAvatarSvg(qq));
  }

  if (url === '/api/printers') {
    try {
      const data = await listPrinters();
      // 给已发现的补一个推荐驱动
      for (const d of data.discovered) {
        // [PRINTER-MODEL] 匹配只用"干净品牌+型号"：HP LaserJet P2015 Series
        // 旧实现用 d.info||d.uri（= usb://HP/...?serial=...）→ 匹配到别的型号的驱动
        let qry = d.model || '';
        const mk = d.make || '';
        if (mk && !new RegExp('(^|[^a-z0-9])' + mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i').test(qry)) {
          qry = (mk + ' ' + qry).trim();
        }
        if (!cleanMatchQuery(qry)) qry = d.model_raw || d.uri;   // 极端兜底：型号实在解析不出
        d.match_query = qry;
        d.drivers = matchDrivers(qry, 6).map(x => ({ driver: x.driver, desc: x.desc, score: x.score }));
        d.best = d.drivers[0] || null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  if (url === '/api/drivers') {
    const qry = q.get('q') || '';
    const matches = matchDrivers(qry, 10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // cleaned：实际参与打分的清洗后查询（前端展示"用什么在匹配"，便于人工改型号重试）
    return res.end(JSON.stringify({ query: qry, cleaned: cleanMatchQuery(qry), matches }));
  }

  if (url === '/api/printer/add' && req.method === 'POST') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) {}
      const r = await addPrinter(parsed);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }

  // [O-2] 管理口令发证：仅持有效 NapCat WebUI 登录凭证（已登录用户）可换取管理口令
  if (url === '/api/web-token' && req.method === 'GET') {
    const expected = getWebAdminToken();
    if (!expected) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: '未配置管理口令（WEB_ADMIN_TOKEN），管理接口已停用' }));
    }
    const auth = String(req.headers['authorization'] || '');
    const cred = auth.replace(/^Bearer\s+/i, '').trim();
    if (!cred) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: '需要有效的 NapCat 登录凭证（Authorization: Bearer <cred>）' }));
    }
    const valid = await validateNapcatCredential(cred);
    if (!valid) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'NapCat 登录凭证无效或已过期，请先在管理台登录' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, token: expected }));
  }

  // 更换账号：退出当前 QQ 登录并出新二维码（仅 SEA2 专属路径）
  if (url === '/api/account/switch') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
      return res.end(JSON.stringify({ ok: false, error: '请使用 POST 调用本接口' }));
    }
    req.resume(); // 丢弃请求体，本接口无需参数
    try {
      const r = await switchAccount();
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '服务内部错误: ' + shortText(e && e.message ? e.message : e, 200) }));
    }
  }

  // [2026-08-08] 副号（docker 铁柱号）退出重登
  if (url === '/api/account/switch-backup') {
    if (!requireWebToken(req, res)) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' });
      return res.end(JSON.stringify({ ok: false, error: '请使用 POST 调用本接口' }));
    }
    req.resume();
    try {
      const r = await switchBackupAccount();
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: '服务内部错误: ' + shortText(e && e.message ? e.message : e, 200) }));
    }
  }

  // ---------- [R9 R4] Web 打印：上传 / 任务 ----------
  // 上传（base64 JSON，零依赖避免手写 multipart）
  if (url === '/api/webprint/upload' && req.method === 'POST') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 70 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
      const r = saveUpload(parsed, SEA2_WEBPRINT_UPLOADS);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    });
    return;
  }
  // 创建打印任务（转发本地 printServer）
  if (url === '/api/webprint/tasks' && req.method === 'POST') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
      const r = await printServerRequest('POST', '/api/tasks', parsed);
      res.writeHead(r.status || (r.ok ? 200 : 502), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    return;
  }
  // 任务列表
  if (url === '/api/webprint/tasks' && req.method === 'GET') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    const r = await printServerRequest('GET', '/api/tasks', undefined);
    res.writeHead(r.status || (r.ok ? 200 : 502), { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r.body));
  }
  // 单个任务状态
  const wpTask = url.match(/^\/api\/webprint\/tasks\/([A-Za-z0-9_-]+)$/);
  if (wpTask && req.method === 'GET') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    const r = await printServerRequest('GET', '/api/tasks/' + encodeURIComponent(wpTask[1]), undefined);
    res.writeHead(r.status || (r.ok ? 200 : 502), { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r.body));
  }

  // ---------- [R9 R3-3/R3-4] 双系统：状态 / 开关 / 切换框架 ----------
  if (url === '/api/dual/status' && req.method === 'GET') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    const r = await opsRequest('GET', '/api/ops/dual-system/status?deviceId=' + encodeURIComponent(SEA2_DEVICE_ID), undefined);
    res.writeHead(r.status || (r.ok ? 200 : 502), { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.assign({ ok: r.ok, deviceId: SEA2_DEVICE_ID, role: readFrameworkRole() }, r.body)));
  }
  if ((url === '/api/dual/enable' || url === '/api/dual/disable') && req.method === 'POST') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    const path2 = url === '/api/dual/enable' ? '/api/ops/dual-system/enable' : '/api/ops/dual-system/disable';
    const r = await opsRequest('POST', path2, { deviceId: SEA2_DEVICE_ID });
    res.writeHead(r.status || (r.ok ? 200 : 502), { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(r.body));
  }
  // 切换框架（原生管理台主/副切换按钮）：to_sea1 / to_sea2
  if (url === '/api/dual/switch' && req.method === 'POST') {
    if (!requireWebToken(req, res)) return; // [O-2] 管理端点门禁
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
      const action = String(parsed.action || '').trim();
      if (['to_sea1', 'to_sea2', 'unblock'].indexOf(action) < 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'action 非法（to_sea1/to_sea2/unblock）' }));
      }
      const r = await opsRequest('POST', '/api/ops/framework-cmd/request', { deviceId: SEA2_DEVICE_ID, action });
      res.writeHead(r.status || (r.ok ? 200 : 502), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    return;
  }

  // ---------- [R9 R4] Web 打印静态页（同样注入自动登录：/api/webprint/* 是管理端点，同 origin 共享 localStorage）
  if (req.method === 'GET' && (url === '/webprint' || url === '/webprint.html')) {
    servePublicHtml('webprint.html', res);
    return;
  }
  if (req.method === 'GET' && url === '/webprint.js') {
    fs.readFile(path.join(PUBLIC_DIR, 'webprint.js'), function (err, buf) {
      if (err) { res.writeHead(404); return res.end('no js'); }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  // 裸路径转发：/webui/*、/files/* 与未命中的 /api/* → NapCat WebUI（URL 匹配 React Router basename=/webui/，
  // 前端 JS 的 API 请求 /api/xxx 也在此转发，但 qr-server 自身 /api/status 等已优先匹配；
  // /files/* 是 NapCat 主题 CSS 等资源（JS fetch('/files/theme.css')），必须透传否则主题 404）
  if (url.startsWith('/webui') || url.startsWith('/api') || url.startsWith('/files')) {
    proxyWebuiRequest(req, res, req.url).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'WebUI 代理异常: ' + shortText(e && e.message ? e.message : e, 200) }));
      } else { res.destroy(); }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

// WebSocket 升级代理：/napcat-webui/* 的 WS 请求转发到 NapCat WebUI（带 Credential 注入）
server.on('upgrade', function (req, socket, head) {
  const pathname = req.url.split('?')[0];
  // [2026-08-08] 副号（docker 铁柱号）WebUI WS 透传：/backup-webui/* → 127.0.0.1:6099（带 backup Credential）
  if (pathname.startsWith('/backup-webui')) {
    const bquery = req.url.indexOf('?') >= 0 ? '?' + req.url.split('?')[1] : '';
    const btargetPath = mapBackupWebuiPath(pathname) + bquery;
    (async () => {
      try {
        const bcred = await getBackupWebuiCredential();
        if (!bcred) { socket.destroy(); return; }
        const btarget = net.connect(BACKUP_WEBUI_PORT, '127.0.0.1', () => {
          let bheadStr = req.method + ' ' + btargetPath + ' HTTP/1.1\r\n';
          for (const [k, v] of Object.entries(req.headers)) {
            if (/^(host|connection|upgrade)$/i.test(k)) continue;
            bheadStr += k + ': ' + v + '\r\n';
          }
          bheadStr += 'Host: 127.0.0.1:' + BACKUP_WEBUI_PORT + '\r\n';
          bheadStr += 'Authorization: Bearer ' + bcred + '\r\n';
          bheadStr += 'Connection: Upgrade\r\n';
          bheadStr += 'Upgrade: websocket\r\n\r\n';
          btarget.write(bheadStr);
          if (head && head.length) btarget.write(head);
          btarget.pipe(socket);
          socket.pipe(btarget);
        });
        btarget.on('error', () => { try { socket.destroy(); } catch (e) {} });
        socket.on('error', () => { try { btarget.destroy(); } catch (e) {} });
      } catch (e) {
        try { socket.destroy(); } catch (e2) {}
      }
    })();
    return;
  }
  if (!pathname.startsWith('/napcat-webui') && !pathname.startsWith('/webui') && !pathname.startsWith('/api')) { socket.destroy(); return; }
  const query = req.url.indexOf('?') >= 0 ? '?' + req.url.split('?')[1] : '';
  const targetPath = mapWebuiPath(pathname) + query;
  (async () => {
    try {
      // [2026-08-08 FIX] WS 透传目标同样按活跃角色动态决定（SEA1_ACTIVE→6099 副号）
      let port = await resolveWebuiTargetPort();
      const isBackup = isBackupTargetPort(port);
      const cred = isBackup ? await getBackupWebuiCredential() : await getWebuiCredential();
      if (!cred) { socket.destroy(); return; }
      const target = net.connect(port, WEBUI_TARGET_HOST, () => {
        let headStr = req.method + ' ' + targetPath + ' HTTP/1.1\r\n';
        for (const [k, v] of Object.entries(req.headers)) {
          if (/^(host|connection|upgrade)$/i.test(k)) continue;
          headStr += k + ': ' + v + '\r\n';
        }
        headStr += 'Host: ' + WEBUI_TARGET_HOST + ':' + port + '\r\n';
        headStr += 'Authorization: Bearer ' + cred + '\r\n';
        headStr += 'Connection: Upgrade\r\n';
        headStr += 'Upgrade: websocket\r\n\r\n';
        target.write(headStr);
        if (head && head.length) target.write(head);
        target.pipe(socket);
        socket.pipe(target);
      });
      target.on('error', () => { try { socket.destroy(); } catch (e) {} });
      socket.on('error', () => { try { target.destroy(); } catch (e) {} });
    } catch (e) {
      try { socket.destroy(); } catch (e2) {}
    }
  })();
});

// ---------- 副号 QQ 风控（ErrCode:3）自动止损 ----------
let backupRiskUntil = 0;   // 风控冷却截止时间戳（0=未冷却）
let backupRiskHits = 0;    // 连续命中的检测轮次
const BACKUP_RISK_COOLDOWN_MS = parseInt(
  process.env.BACKUP_RISK_COOLDOWN_MS || String(3 * 60 * 60 * 1000), 10) || (3 * 60 * 60 * 1000);

/**
 * 背景：副号登录失败后 NapCat 会进入"出码 → 失败 → 出码"的**重试风暴**（约每 2 分钟一次），
 * 每一次尝试都在继续喂 QQ 风控，于是越试越锁死——表现正是"扫码后约 30 秒被踢、
 * 换号登录还是会掉线"。以往只能靠人工发现后 docker stop；现改为自动止损。
 */
async function checkBackupRiskControl() {
  try {
    const r = await exec('docker', ['logs', '--tail', '40', 'napcat'], 20000);
    const txt = String((r && (r.out || r.errout)) || '');
    const hits = (txt.match(/ErrCode:\s*3/gi) || []).length;
    if (hits >= 2) {
      backupRiskHits += 1;
      console.error('[risk-ctl] 检测到副号 QQ 风控 ErrCode:3（近40行 ' + hits + ' 次，连续命中 ' + backupRiskHits + ' 轮）');
      if (backupRiskHits >= 2) {
        const sr = await exec('docker', ['ps', '-a', '--filter', 'name=napcat', '--format', '{{.Status}}'], 10000);
        const st = String((sr && sr.out) || '');
        if (/Up/.test(st)) {
          console.error('[risk-ctl] 确认为重试风暴 → 立即 docker stop napcat 止损，避免持续喂风控');
          await exec('docker', ['stop', '-t', '30', 'napcat'], 60000);
          backupRiskUntil = Date.now() + BACKUP_RISK_COOLDOWN_MS;
          console.error('[risk-ctl] 已进入风控冷却，冷却期内拒绝一切重启/登录尝试（至 ' + new Date(backupRiskUntil).toLocaleString() + '）');
        }
      }
      return true;
    }
    backupRiskHits = 0;
    return false;
  } catch (e) { return false; }
}

/** 副号是否处于风控冷却期（冷却期内禁止重启/登录尝试，否则前功尽弃） */
function backupInRiskCooldown() {
  if (!backupRiskUntil) return false;
  if (Date.now() >= backupRiskUntil) { backupRiskUntil = 0; return false; }
  return true;
}

// ---------- 后台循环 ----------
async function tick() {
  try { await checkBackupRiskControl(); } catch (e) {}   // [风控] ErrCode:3 重试风暴自动止损
  try { await ensureAllOnebotConfigs(); } catch (e) {}  // [INHERIT] 换号后兜底自动补全 onebot11 network
  try { await detectLanIp(); } catch (e) {}
  try { await detectConnected(); } catch (e) {}
  try { await detectToken(); } catch (e) {}
  try { await detectLoginInfo(); } catch (e) {}
  try { await detectBackupLoginInfo(); } catch (e) {}
}

// 仅直接运行时自动启动（require 用于测试时不占用端口/定时器）
if (require.main === module) {
  setInterval(tick, 8000);
  tick();

  // [R9 R4] 上传目录 TTL 清理（24h；每小时巡检一次）
  setInterval(() => {
    try { cleanupUploads(SEA2_WEBPRINT_UPLOADS, 24 * 60 * 60 * 1000); } catch (e) { /* best-effort */ }
  }, 60 * 60 * 1000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log('SEA2 qr-server listening on', PORT, 'ws=', SEA2.wsPort, 'external=', EXTERNAL_URL || '(lan)');
  });

  loadDrivers();
}

// [R9] 导出纯函数（测试用：上传校验 / base64 落盘 / 清理 / env 加载）
// [O-2] 导出管理口令门禁纯函数（测试用）
module.exports = {
  validateUploadPayload,
  saveUpload,
  cleanupUploads,
  loadOpsEnv,
  fetchLoginInfo,
  emptyLoginInfo,
  WEBPRINT_MAX_BYTES,
  WEBPRINT_ALLOWED_MIME,
  WEBPRINT_ALLOWED_EXT,
  getWebAdminToken,
  verifyWebTokenHeader,
  requireWebToken,
  validateNapcatCredential,
  __setWebTokenValidator,
  injectAutoLogin,
  servePublicHtml,
};
