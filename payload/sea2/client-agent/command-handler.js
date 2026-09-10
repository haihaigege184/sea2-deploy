'use strict';
/**
 * command-handler.js —— 运维中心远程指令执行器（SEA2 客户端侧）
 *
 * 契约以服务端 `lib/fleetCommands.js` 的 SPECS 为**唯一事实来源**：
 *   服务端下发 action + payload（随心跳响应 resp.commands），客户端执行后在下一次
 *   心跳携带 `ack_results:[{id, ok, error?, result?}]` 回传。
 *
 * 设计要点：
 *   1. **不自杀**：`restart_client` 若连 sea1-client（本进程）一起重启，ack 会随进程消失。
 *      故凡涉及本进程的重启，走 `_defer`（先回执、后执行）。
 *   2. **参数白名单**：进程名/打印机名严格正则 + 前缀约束，全部走 execFile（不经 shell），
 *      杜绝命令注入。
 *   3. **format_device 一律拒绝**：强门禁要求"本地二次确认 + 白名单 + 审计"，客户端不得
 *      凭一条网络指令就抹盘 —— 只落一条待人工确认记录，返回 rejected。
 *   4. 所有命令带超时与输出上限，单个指令异常绝不影响心跳。
 */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SEA2_DIR = process.env.SEA2_DIR || '/root/sea2';
const SEA1_DIR = process.env.SEA1_DIR || '/root/sea1';
const STATE_DIR = '/etc/sea1-x86';
const CONFIG_JSON = path.join(SEA2_DIR, 'config.json');
const DISABLED_FLAG = path.join(STATE_DIR, 'client-disabled');
const FORMAT_REQ = path.join(STATE_DIR, 'format-request.json');
const MIDDLE_PAGE = process.env.SEA2_QR_URL || 'http://127.0.0.1:13011';
const MAIN_ONEBOT = process.env.SEA2_MAIN_NAPCAT_URL || 'http://127.0.0.1:4000';
const EXEC_TIMEOUT = 20000;
const RESULT_MAX = 60 * 1024;

const log = (m) => console.log('[sea2-cmd] ' + m);

// ---------------------------------------------------------------------------
// 底层工具
// ---------------------------------------------------------------------------
function sh(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, Object.assign({ timeout: EXEC_TIMEOUT, maxBuffer: 1024 * 1024, encoding: 'utf8' }, opts || {}),
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? String((err && err.message) || err) : '',
        });
      });
  });
}

let _pm2Bin = '';
function pm2Bin() {
  if (_pm2Bin) return _pm2Bin;
  const cands = [
    '/usr/local/bin/pm2', '/usr/bin/pm2', '/usr/local/sbin/pm2',
    '/usr/lib/node_modules/pm2/bin/pm2', '/usr/local/lib/node_modules/pm2/bin/pm2',
    path.join(os.homedir(), '.npm-global/bin/pm2'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) { _pm2Bin = c; return c; } } catch (e) { /* ignore */ }
  }
  _pm2Bin = 'pm2'; // 回退 PATH
  return _pm2Bin;
}

const CUPS_BIN = {
  lpstat: ['/usr/sbin/lpstat', '/usr/bin/lpstat'],
  lpadmin: ['/usr/sbin/lpadmin', '/usr/bin/lpadmin'],
  cupsenable: ['/usr/sbin/cupsenable', '/usr/bin/cupsenable'],
  cupsdisable: ['/usr/sbin/cupsdisable', '/usr/bin/cupsdisable'],
  cancel: ['/usr/bin/cancel', '/usr/sbin/cancel'],
  lpinfo: ['/usr/sbin/lpinfo', '/usr/bin/lpinfo'],
};
function cupsBin(name) {
  for (const c of (CUPS_BIN[name] || [])) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return name;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function writeJson(p, obj) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/** 结果体大小护栏（服务端也会再截断一次，这里是第一道） */
function clampResult(r) {
  try {
    const s = JSON.stringify(r);
    if (s && s.length > RESULT_MAX) {
      return { truncated: true, note: '结果超过 60KB 已截断', head: s.slice(0, RESULT_MAX) };
    }
  } catch (e) { /* 循环引用等，交给上层序列化失败处理 */ }
  return r;
}

// ---------------------------------------------------------------------------
// 参数校验（白名单）
// ---------------------------------------------------------------------------
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// 只允许管理 sea2/sea1 自己的进程，且必须是本栈内已知进程（防止误停系统服务）
const PM2_KNOWN = new Set([
  'sea2-bot', 'sea2-print-server', 'sea2-qr', 'sea2-napcat', 'sea2-napcat-backup',
  'sea2-watchdog', 'sea1-client', 'sea1-bot',
]);
function validProcessName(n) {
  const s = String(n || '');
  if (!NAME_RE.test(s)) return false;
  if (!/^(sea2-|sea1-)/.test(s)) return false;
  return PM2_KNOWN.has(s);
}
function validPrinterName(n) {
  return NAME_RE.test(String(n || ''));
}

// ---------------------------------------------------------------------------
// 采集器（供 health_check / v2 心跳共用）
// ---------------------------------------------------------------------------
function parsePm2List(raw) {
  // pm2 jlist 偶尔会在 JSON 前打印告警行，这里从第一个 '[' 起解析
  const i = String(raw || '').indexOf('[');
  if (i < 0) return [];
  let arr;
  try { arr = JSON.parse(String(raw).slice(i)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => {
    const env = (p && p.pm2_env) || {};
    const monit = (p && p.monit) || {};
    const uptime = env.pm_uptime ? Math.max(0, Math.floor((Date.now() - env.pm_uptime) / 1000)) : 0;
    return {
      pm_id: p && Number.isFinite(p.pm_id) ? p.pm_id : 0,
      name: String((p && p.name) || '').slice(0, 128),
      status: String(env.status || 'unknown').slice(0, 32),
      restarts: Number.isFinite(env.restart_time) ? env.restart_time : 0,
      uptime,
      cpu: Number.isFinite(monit.cpu) ? monit.cpu : 0,
      mem: Number.isFinite(monit.memory) ? Math.round(monit.memory / 1048576) : 0, // MB
    };
  }).filter((x) => x.name);
}

async function collectPm2() {
  const r = await sh(pm2Bin(), ['jlist'], { timeout: 12000 });
  if (!r.ok && !r.stdout) return [];
  return parsePm2List(r.stdout);
}

/** 解析 `lpstat -p -d` + `lpstat -v`（不同 CUPS 版本输出布局略有差异，尽量宽松） */
function parseCups(outP, outV) {
  const printers = [];
  const byName = new Map();
  let defName = '';
  const dm = /system default destination:\s*(\S+)/i.exec(outP || '');
  if (dm) defName = dm[1];

  const uriByName = new Map();
  String(outV || '').split('\n').forEach((ln) => {
    const m = /device for ([^:]+):\s*(\S+)/i.exec(ln);
    if (m) uriByName.set(m[1].trim(), m[2].trim());
  });

  String(outP || '').split('\n').forEach((ln) => {
    // 形如: "printer HP is idle.  enabled since ..." / "printer HP disabled since ..."
    const m = /^printer\s+(\S+)\s+(?:is\s+)?(.*)$/i.exec(ln.trim());
    if (!m) return;
    const name = m[1];
    const rest = m[2] || '';
    const enabled = !/\bdisabled\b/i.test(rest);
    let state = 'idle';
    if (!enabled) state = 'disabled';
    else if (/\bprinting\b/i.test(rest)) state = 'printing';
    else if (/\bidle\b/i.test(rest)) state = 'idle';
    if (byName.has(name)) return;
    const item = {
      name,
      uri: uriByName.get(name) || '',
      model: '',
      driver: '',
      state,
      queueCount: 0,
      default: false,
      enabled,
    };
    byName.set(name, item);
    printers.push(item);
  });

  // 队列长度：lpstat -o 有多少行就代表多少待打任务（失败则忽略）
  printers.forEach((p) => { if (p.name === defName) p.default = true; });
  return { printers, defName };
}

async function collectCups() {
  const [pRes, vRes, oRes] = await Promise.all([
    sh(cupsBin('lpstat'), ['-p', '-d'], { timeout: 8000 }),
    sh(cupsBin('lpstat'), ['-v'], { timeout: 8000 }),
    sh(cupsBin('lpstat'), ['-o'], { timeout: 8000 }),
  ]);
  const running = !!(pRes.ok || (pRes.stdout && pRes.stdout.trim()));
  if (!running && !pRes.stdout) return { running: false, printers: [] };
  const { printers } = parseCups(pRes.stdout, vRes.stdout);
  // 队列计数：按打印机名聚合 `lpstat -o` 的输出行
  const counts = new Map();
  String(oRes.stdout || '').split('\n').forEach((ln) => {
    const m = /^(\S+?)-\d+/.exec(ln.trim());
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  });
  printers.forEach((p) => { p.queueCount = counts.get(p.name) || 0; });
  return { running: true, printers: printers.slice(0, 64) };
}

/** 登录态取自中间页 /api/status（NapCat get_login_info 的聚合视图） */
async function collectLoginInfo() {
  const j = await httpJson('GET', MIDDLE_PAGE + '/api/status');
  if (!j || !j.login_info) return { qq: '', nickname: '', avatar: '', remembered: false, loggedIn: false };
  const li = j.login_info || {};
  return {
    qq: String(li.qq || li.user_id || '').slice(0, 32),
    nickname: String(li.nickname || '').slice(0, 64),
    avatar: String(li.avatar || '').slice(0, 1024),
    remembered: li.remembered === true,
    loggedIn: li.loggedIn === true,
  };
}

async function diskInfo() {
  const r = await sh('df', ['-m', '/'], { timeout: 6000 });
  const lines = String(r.stdout || '').trim().split('\n');
  if (lines.length < 2) return null;
  const f = lines[lines.length - 1].split(/\s+/);
  const total = parseInt(f[1], 10); const used = parseInt(f[2], 10);
  if (!Number.isFinite(total)) return null;
  return { total_mb: total, used_mb: used, use_pct: Number.isFinite(used) ? Math.round((used / total) * 100) : 0 };
}

function cpuUsagePercent() {
  const n = os.cpus().length || 1;
  const la = os.loadavg()[0] || 0;
  return Math.min(100, Math.round((la / n) * 100));
}

function memUsagePercent() {
  const t = os.totalmem() || 1;
  return Math.round(((t - os.freemem()) / t) * 100);
}

function systemProfile() {
  return {
    platform: os.platform(),   // linux
    arch: os.arch(),           // arm64 / x64
    hostname: os.hostname(),
    cpu_count: os.cpus().length || 1,
    mem_total_mb: Math.round(os.totalmem() / 1048576),
  };
}

// ---------------------------------------------------------------------------
// HTTP（本地 OneBot / 中间页）
// ---------------------------------------------------------------------------
function httpJson(method, url, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      timeout: timeoutMs || 6000,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 指令实现
// ---------------------------------------------------------------------------
const HANDLERS = {};

async function pm2Action(verb, name) {
  if (!validProcessName(name)) return { ok: false, error: 'invalid-process-name' };
  const r = await sh(pm2Bin(), [verb, name], { timeout: 15000 });
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || ('pm2 ' + verb + ' 失败')).slice(0, 400) };
  return { ok: true, result: { process: name, action: verb, at: Math.floor(Date.now() / 1000) } };
}

HANDLERS.health_check = async () => {
  const [pm2, cups, login, disk] = await Promise.all([collectPm2(), collectCups(), collectLoginInfo(), diskInfo()]);
  return {
    ok: true,
    result: Object.assign({
      hostname: os.hostname(),
      arch: os.arch(),
      uptime_sec: Math.floor(os.uptime()),
      loadavg: os.loadavg(),
      cpu_usage: cpuUsagePercent(),
      mem_usage: memUsagePercent(),
      mem_total_mb: Math.round(os.totalmem() / 1048576),
      mem_free_mb: Math.round(os.freemem() / 1048576),
      disk,
      pm2_processes: pm2,
      cups,
      login_info: login,
      disabled: fs.existsSync(DISABLED_FLAG),
      ts: Math.floor(Date.now() / 1000),
    }),
  };
};

HANDLERS.restart_bot = async () => pm2Action('restart', 'sea2-bot');
HANDLERS.restart_napcat = async () => pm2Action('restart', 'sea2-napcat');

// 整栈重启：sea1-client（本进程）不能立即重启，否则回执随进程消失 → 走 _defer
HANDLERS.restart_client = async () => ({
  ok: true,
  result: { deferred: true, note: '业务栈将在回执送达后重启（含本客户端进程）' },
  _defer: async () => {
    await sh(pm2Bin(), ['restart', 'sea2-bot', 'sea2-print-server', 'sea2-qr', 'sea2-watchdog', 'sea1-client'], { timeout: 30000 });
  },
});

HANDLERS.disable_client = async () => {
  // 停业务栈（保留本进程，否则无法继续接受「启用」指令）
  await sh(pm2Bin(), ['stop', 'sea2-bot', 'sea2-print-server'], { timeout: 20000 });
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(DISABLED_FLAG, new Date().toISOString()); } catch (e) { /* ignore */ }
  return { ok: true, result: { disabled: true, stopped: ['sea2-bot', 'sea2-print-server'] } };
};

HANDLERS.enable_client = async () => {
  await sh(pm2Bin(), ['start', 'sea2-bot', 'sea2-print-server'], { timeout: 20000 });
  try { if (fs.existsSync(DISABLED_FLAG)) fs.unlinkSync(DISABLED_FLAG); } catch (e) { /* ignore */ }
  return { ok: true, result: { disabled: false, started: ['sea2-bot', 'sea2-print-server'] } };
};

async function setPrinterEnabled(name, enabled) {
  if (!validPrinterName(name)) return { ok: false, error: 'invalid-printer-name' };
  const bin = cupsBin(enabled ? 'cupsenable' : 'cupsdisable');
  const r = await sh(bin, [name], { timeout: 12000 });
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || '').slice(0, 400) || 'cups 操作失败' };
  return { ok: true, result: { printer: name, enabled, at: Math.floor(Date.now() / 1000) } };
}
HANDLERS.disable_printer = async (p) => setPrinterEnabled(p && (p.printerName || p.name), false);
HANDLERS.enable_printer = async (p) => setPrinterEnabled(p && (p.printerName || p.name), true);

HANDLERS.clear_print_queue = async () => {
  const before = await sh(cupsBin('lpstat'), ['-o'], { timeout: 8000 });
  const count = String(before.stdout || '').split('\n').filter((x) => x.trim()).length;
  const r = await sh(cupsBin('cancel'), ['-a'], { timeout: 15000 });
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || '').slice(0, 400) };
  return { ok: true, result: { canceled: count, at: Math.floor(Date.now() / 1000) } };
};

HANDLERS.push_notice = async (p) => {
  const text = String((p && p.text) || '').slice(0, 500);
  if (!text) return { ok: false, error: 'empty-text' };
  const cfg = readJson(CONFIG_JSON) || {};
  const token = String(cfg.napcat_token || '');
  if (!token) return { ok: false, error: 'napcat-token-missing' };
  const auth = { Authorization: 'Bearer ' + token };
  const target = (p && p.target) === 'admin' ? 'admin' : 'groups';
  const sent = [];
  const failed = [];

  if (target === 'admin') {
    const admins = [];
    if (cfg.superAdmin) admins.push(String(cfg.superAdmin));
    if (cfg.developer && String(cfg.developer) !== String(cfg.superAdmin)) admins.push(String(cfg.developer));
    if (!admins.length) return { ok: false, error: 'no-admin-configured' };
    for (const uid of admins) {
      const j = await httpJson('POST', MAIN_ONEBOT + '/send_private_msg', { user_id: Number(uid), message: text }, auth);
      if (j && (j.status === 'ok' || j.retcode === 0)) sent.push(uid); else failed.push(uid);
    }
  } else {
    const groups = Array.isArray(cfg.notify_groups) ? cfg.notify_groups.map(String) : [];
    if (!groups.length) return { ok: false, error: 'no-notify-group-configured' };
    for (const gid of groups) {
      const j = await httpJson('POST', MAIN_ONEBOT + '/send_group_msg', { group_id: Number(gid), message: text }, auth);
      if (j && (j.status === 'ok' || j.retcode === 0)) sent.push(gid); else failed.push(gid);
    }
  }
  if (!sent.length) return { ok: false, error: 'send-failed: ' + failed.join(',') };
  return { ok: true, result: { target, sent, failed } };
};

// push_config：只接受白名单键（与服务端 fleetCommands.CONFIG_WHITELIST 保持一致）
const CONFIG_WHITELIST = { printer: ['default'] };
HANDLERS.push_config = async (p) => {
  const cfg = readJson(CONFIG_JSON);
  if (!cfg) return { ok: false, error: 'config.json 不可读' };
  const patch = (p && p.config) || {};
  const applied = {};
  const ignored = [];
  Object.keys(patch).forEach((sec) => {
    const allow = CONFIG_WHITELIST[sec];
    if (!allow) { ignored.push(sec); return; }
    Object.keys(patch[sec] || {}).forEach((k) => {
      if (allow.indexOf(k) < 0) { ignored.push(sec + '.' + k); return; }
      const v = patch[sec][k];
      // printer.default 必须是合法 CUPS 队列名（防注入 / 防写坏 config.json）
      if (sec === 'printer' && (typeof v !== 'string' || !validPrinterName(v))) {
        ignored.push(sec + '.' + k + '(非法值)');
        return;
      }
      if (!cfg[sec] || typeof cfg[sec] !== 'object') cfg[sec] = {};
      cfg[sec][k] = v;
      applied[sec + '.' + k] = v;
    });
  });
  if (!Object.keys(applied).length) return { ok: false, error: 'no-applicable-key', ignored };
  try {
    if (fs.existsSync(CONFIG_JSON)) fs.copyFileSync(CONFIG_JSON, CONFIG_JSON + '.bak-config-push');
    writeJson(CONFIG_JSON, cfg);
  } catch (e) { return { ok: false, error: 'write-failed: ' + e.message }; }
  await sh(pm2Bin(), ['restart', 'sea2-print-server'], { timeout: 20000 });
  return { ok: true, result: { applied, ignored } };
};

HANDLERS.pm2_list = async () => ({ ok: true, result: { processes: await collectPm2() } });
HANDLERS.pm2_restart = async (p) => pm2Action('restart', p && p.processName);
HANDLERS.pm2_stop = async (p) => pm2Action('stop', p && p.processName);
HANDLERS.pm2_start = async (p) => pm2Action('start', p && p.processName);
HANDLERS.pm2_logs = async (p) => {
  const name = p && p.processName;
  if (!validProcessName(name)) return { ok: false, error: 'invalid-process-name' };
  let lines = parseInt(p && p.lines, 10);
  if (!Number.isFinite(lines)) lines = 100;
  lines = Math.max(1, Math.min(200, lines));
  const r = await sh(pm2Bin(), ['logs', name, '--lines', String(lines), '--nostream'], { timeout: 20000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return { ok: true, result: { process: name, lines, log: out.slice(-(RESULT_MAX - 1024)) } };
};

HANDLERS.cups_info = async () => {
  const cups = await collectCups();
  const dev = await sh(cupsBin('lpinfo'), ['-v'], { timeout: 12000 });
  return {
    ok: true,
    result: {
      cups,
      devices: String(dev.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 50),
    },
  };
};

HANDLERS.cups_set_printer = async (p) => {
  const name = p && p.name;
  if (!validPrinterName(name)) return { ok: false, error: 'invalid-printer-name' };
  if (p && p.enabled !== undefined) {
    const r = await setPrinterEnabled(name, p.enabled !== false);
    if (!r.ok) return r;
  }
  if (p && p.default === true) {
    const r = await sh(cupsBin('lpadmin'), ['-d', name], { timeout: 12000 });
    if (!r.ok) return { ok: false, error: (r.stderr || r.error || '').slice(0, 400) };
  }
  if (p && p.driver) {
    if (!NAME_RE.test(String(p.driver))) return { ok: false, error: 'invalid-driver' };
    const r = await sh(cupsBin('lpadmin'), ['-p', name, '-m', String(p.driver)], { timeout: 15000 });
    if (!r.ok) return { ok: false, error: (r.stderr || r.error || '').slice(0, 400) };
  }
  const cups = await collectCups();
  return { ok: true, result: { printer: (cups.printers || []).find((x) => x.name === name) || null, cups } };
};

HANDLERS.cups_add_printer = async (p) => {
  const name = p && p.name;
  const uri = String((p && p.uri) || '');
  if (!validPrinterName(name)) return { ok: false, error: 'invalid-printer-name' };
  if (!/^[A-Za-z0-9+._:/?=&%-]{1,512}$/.test(uri)) return { ok: false, error: 'invalid-uri' };
  const args = ['-p', name, '-E', '-v', uri];
  if (p && p.driver && NAME_RE.test(String(p.driver))) args.push('-m', String(p.driver));
  else args.push('-m', 'everywhere');
  const opts = (p && p.options) || {};
  Object.keys(opts).forEach((k) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(k)) return;
    const v = String(opts[k]);
    if (!/^[A-Za-z0-9._:/?=&%,+-]{1,256}$/.test(v)) return;
    args.push('-o', k + '=' + v);
  });
  const r = await sh(cupsBin('lpadmin'), args, { timeout: 25000 });
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || '').slice(0, 400) };
  const cups = await collectCups();
  return { ok: true, result: { printer: (cups.printers || []).find((x) => x.name === name) || null, cups } };
};

/**
 * format_device —— 一律拒绝（强门禁）。
 * 抹盘属于不可逆超控：必须"本地人工二次确认 + 白名单机型 + 审计留痕"三者齐备，
 * 客户端不得凭一条网络指令执行。这里只落一条待确认记录，供运维到机器本地处置。
 */
HANDLERS.format_device = async (p) => {
  const req = {
    at: new Date().toISOString(),
    level: String((p && p.level) || ''),
    countdownSec: p && p.countdownSec,
    diskTarget: (p && p.diskTarget) || '',
    nonce: (p && p.nonce) || '',
    commandId: (p && p.__commandId) || '',
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(FORMAT_REQ, JSON.stringify(req, null, 2), { mode: 0o600 });
  } catch (e) { /* ignore */ }
  log('拒绝 format_device 指令（强门禁：须本地人工确认）→ ' + FORMAT_REQ);
  return {
    ok: false,
    error: 'rejected: 格式化属强门禁超控，需在设备本地人工二次确认（已记录待确认请求）',
  };
};

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------
/**
 * 执行一条指令。
 * @param {string} action
 * @param {object} payload
 * @returns {Promise<{ok:boolean, error?:string, result?:any, _defer?:Function}>}
 */
async function execute(action, payload) {
  const fn = HANDLERS[action];
  if (!fn) return { ok: false, error: 'unsupported' };
  try {
    const r = (await fn(payload || {})) || { ok: false, error: 'empty-result' };
    if (r.result !== undefined) r.result = clampResult(r.result);
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 400) };
  }
}

/** 本地待处理（未回执）队列的持久化 —— 进程重启后补发回执，避免指令永远停在 sent */
const PENDING_ACK = path.join(STATE_DIR, 'pending-acks.json');
function loadPendingAcks() {
  const a = readJson(PENDING_ACK);
  return Array.isArray(a) ? a : [];
}
function savePendingAcks(list) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    if (!list || !list.length) { if (fs.existsSync(PENDING_ACK)) fs.unlinkSync(PENDING_ACK); return; }
    writeJson(PENDING_ACK, list.slice(-50));
  } catch (e) { /* ignore */ }
}

module.exports = {
  execute,
  collectPm2,
  collectCups,
  collectLoginInfo,
  systemProfile,
  cpuUsagePercent,
  memUsagePercent,
  loadPendingAcks,
  savePendingAcks,
  validProcessName,
  HANDLERS,
  ACTIONS: Object.keys(HANDLERS),
};
