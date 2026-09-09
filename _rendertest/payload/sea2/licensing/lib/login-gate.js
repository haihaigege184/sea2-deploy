'use strict';
/**
 * login-gate.js — sea2 登录中间页（本地 localhost 服务 + 状态持久化，零三方依赖）
 *
 * 作用（§2.3 / §3.2 / Q10）：
 *  - 设备首次启动先落在登录中间页，确认 QQ 登录后才进入主界面；
 *  - 查询 napcat 登录态（QQ号/昵称/头像），供心跳 login_info 上报；
 *  - 「记住本机」开关：默认关闭；开启后本机后续启动自动进入主界面；
 *  - confirm()/switchAccount()/logout() 分别对应 确认进入 / 切换账号 / 退出登录。
 *
 * 诚实原则：
 *  - 未配置 napcatStatusUrl（或查询失败）时 status() 如实返回本地已知状态，
 *    绝不伪造 QQ 号/昵称/头像（未知即空字符串）；
 *  - 所有 IO 异常都被捕获，不让调用方崩。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

/** 默认状态文件：/root/sea2/config/login-gate.json（与授权文件同目录，备份/清理一并走） */
const DEFAULT_STATE_PATH = '/root/sea2/config/login-gate.json';
/** 默认本地端口（仅监听 127.0.0.1） */
const DEFAULT_PORT = 17890;

/** 空登录态（未登录时如实返回） */
function emptyState() {
  return { qq: '', nickname: '', avatar: '', remembered: false, loggedIn: false };
}

class LoginGate {
  /**
   * @param {object} [opts]
   * @param {string} [opts.statePath] 状态持久化文件（默认 /root/sea2/config/login-gate.json）
   * @param {number} [opts.port] 本地 HTTP 端口（默认 17890，仅 127.0.0.1）
   * @param {string} [opts.napcatStatusUrl] napcat 登录态查询地址（如 http://127.0.0.1:6099/api/...）；留空 = 不查询
   * @param {function} [opts.fetch] 注入 fetch（测试用）
   * @param {object} [opts.logger] 日志对象（默认 console）
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.statePath = opts.statePath || DEFAULT_STATE_PATH;
    this.port = opts.port || DEFAULT_PORT;
    this.napcatStatusUrl = opts.napcatStatusUrl || '';
    this.fetchFn = typeof opts.fetch === 'function' ? opts.fetch : global.fetch;
    this.logger = opts.logger || console;
    this.state = emptyState();
    this._server = null;
    this._load();
  }

  /** 读盘；文件不存在/损坏时以空状态启动（绝不抛错）。 */
  _load() {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.state = {
          qq: typeof parsed.qq === 'string' ? parsed.qq : '',
          nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
          avatar: typeof parsed.avatar === 'string' ? parsed.avatar : '',
          remembered: parsed.remembered === true,
          loggedIn: parsed.loggedIn === true,
        };
      }
    } catch (e) {
      this._warn('登录状态读取失败，以空状态启动：' + ((e && e.message) || e));
      this.state = emptyState();
    }
  }

  /** 原子落盘（临时文件 + rename），失败仅告警。 */
  _save() {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8');
      fs.renameSync(tmp, this.statePath);
    } catch (e) {
      this._warn('登录状态落盘失败：' + ((e && e.message) || e));
    }
  }

  _warn(msg) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[login-gate] ' + msg);
  }

  /**
   * 登录态查询（供心跳 login_info 上报与本地页面渲染）。
   * 优先查询 napcat（配置了 napcatStatusUrl 且可用），失败/未配置回退本地状态。
   * @returns {Promise<{qq:string, nickname:string, avatar:string, remembered:boolean, loggedIn:boolean}>}
   */
  async status() {
    let remote = null;
    if (this.napcatStatusUrl && typeof this.fetchFn === 'function') {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await this.fetchFn(this.napcatStatusUrl, { signal: ctrl.signal });
        clearTimeout(t);
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          if (j && typeof j === 'object') {
            remote = {
              qq: typeof j.qq === 'string' ? j.qq : (typeof j.uin === 'string' ? j.uin : ''),
              nickname: typeof j.nickname === 'string' ? j.nickname : '',
              avatar: typeof j.avatar === 'string' ? j.avatar : '',
              loggedIn: j.loggedIn === true || j.logged_in === true || (typeof j.qq === 'string' && !!j.qq),
            };
          }
        }
      } catch (e) {
        // napcat 不可达 → 回退本地状态（如实，不伪造）
      }
    }

    const base = this.state;
    return {
      qq: remote ? remote.qq : base.qq,
      nickname: remote ? remote.nickname : base.nickname,
      avatar: remote ? remote.avatar : base.avatar,
      remembered: base.remembered,
      loggedIn: remote ? remote.loggedIn : base.loggedIn,
    };
  }

  /**
   * 「记住本机」开关。默认关闭；开启后本机后续启动自动进入主界面。
   * @param {boolean} on
   * @returns {void}
   */
  remember(on) {
    this.state.remembered = !!on;
    this._save();
  }

  /** 本地操作员点击「确认进入」→ 标记已登录并进入主界面。 */
  confirm() {
    this.state.loggedIn = true;
    this._save();
  }

  /** 切换账号：清登录态（保留 remembered 语义，由前端按需重置）。 */
  switchAccount() {
    this.state.qq = '';
    this.state.nickname = '';
    this.state.avatar = '';
    this.state.loggedIn = false;
    this._save();
  }

  /** 退出登录：清登录态并关闭「记住本机」。 */
  logout() {
    this.state.qq = '';
    this.state.nickname = '';
    this.state.avatar = '';
    this.state.loggedIn = false;
    this.state.remembered = false;
    this._save();
  }

  /**
   * 启动本地登录中间页 HTTP 服务（仅监听 127.0.0.1）。
   * 绑定失败仅告警，绝不抛错（登录页不是主链路）。
   * @returns {object|null} http.Server 实例（启动失败返回 null）
   */
  start() {
    if (this._server) return this._server;
    const self = this;
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/api/status') {
        self.status().then((s) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(s));
        });
        return;
      }
      if (req.url === '/api/remember' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          try {
            const j = JSON.parse(body || '{}');
            self.remember(j.on === true);
          } catch (e) { /* ignore */ }
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true, remembered: self.state.remembered }));
        });
        return;
      }
      if (req.url === '/api/confirm' && req.method === 'POST') {
        self.confirm();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, loggedIn: true }));
        return;
      }
      if (req.url === '/api/switch' && req.method === 'POST') {
        self.switchAccount();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/api/logout' && req.method === 'POST') {
        self.logout();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // 默认：渲染登录中间页（最小内联页面，零外部资源）
      res.end(self._renderPage());
    });
    try {
      server.listen(this.port, '127.0.0.1');
      this._server = server;
    } catch (e) {
      this._warn('本地登录页启动失败：' + ((e && e.message) || e));
      return null;
    }
    return server;
  }

  /** 停止本地 HTTP 服务。 */
  stop() {
    if (this._server) {
      try { this._server.close(); } catch (e) { /* ignore */ }
      this._server = null;
    }
  }

  /** 渲染最小登录中间页 HTML。 */
  _renderPage() {
    const s = this.state;
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<title>sea2 登录中间页</title>'
      + '<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;color:#222}'
      + '.card{border:1px solid #e2e2e2;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.06)}'
      + 'h1{font-size:20px;margin-top:0}label{display:block;margin:12px 0}button{margin:6px 6px 0 0;padding:8px 16px;border:1px solid #ccc;border-radius:8px;background:#fafafa;cursor:pointer}'
      + '</style></head><body><div class="card">'
      + '<h1>sea2 设备登录</h1>'
      + '<p>QQ: ' + escapeHtml(s.qq || '未登录') + '</p>'
      + '<p>昵称: ' + escapeHtml(s.nickname || '-') + '</p>'
      + '<label><input type="checkbox" id="remember"' + (s.remembered ? ' checked' : '') + '> 记住本机（下次自动进入主界面）</label>'
      + '<div><button onclick="remember()">保存记住设置</button>'
      + '<button onclick="confirm()">确认进入</button>'
      + '<button onclick="switchAccount()">切换账号</button>'
      + '<button onclick="logout()">退出登录</button></div>'
      + '<script>'
      + 'async function post(p, b){await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:b?JSON.stringify(b):undefined})}'
      + 'function remember(){post("/api/remember",{on:document.getElementById("remember").checked})}'
      + 'function confirm(){post("/api/confirm")}'
      + 'function switchAccount(){post("/api/switch")}'
      + 'function logout(){post("/api/logout")}'
      + '</script></div></body></html>';
  }
}

/** 简单 HTML 转义（登录页渲染防注入）。 */
function escapeHtml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { LoginGate, emptyState, DEFAULT_STATE_PATH, DEFAULT_PORT, escapeHtml };
