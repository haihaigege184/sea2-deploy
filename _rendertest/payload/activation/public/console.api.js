'use strict';
/**
 * public/console.api.js — fetch 封装 + 通用 CRUD 客户端 + 轮询助手（T04）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §2.2 / §3.5
 *  - fetch 统一带 x-console-token（超管另带 x-admin-token），失败结构 {ok:false, error}
 *  - 通用 CRUD 客户端：list/create/update/remove per entity（codes|devices|printers|configs）
 *  - 轮询助手沿用 CmdTracker 模式（可停止 / 防重入 / 可带停止条件）
 *  - CSV 导出（审计中心用）：带鉴权头 fetch → Blob → 触发下载，UTF-8 BOM 便于 Excel 中文
 *
 * 零依赖、零构建，随 console.html 按序 <script> 引入（先于 console.js）。
 * 注意：console.js 会在加载完成后用自身 api() 覆盖 window.ConsoleApp.api（行为等价，且
 *       401 时联动登录遮罩），本文件的 crud/poll/csv 均按调用时取用 ConsoleApp.api。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  var NS = window.ConsoleApp = window.ConsoleApp || {};

  // ---------------- 基础工具 ----------------
  function enc(s) { return encodeURIComponent(s == null ? '' : String(s)); }

  /** 查询串构建：{a:1,b:'x y'} -> 'a=1&b=x%20y'（空值跳过） */
  function qs(params) {
    var out = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v)) {
        v.forEach(function (x) { out.push(enc(k) + '=' + enc(x)); });
      } else {
        out.push(enc(k) + '=' + enc(v));
      }
    });
    return out.join('&');
  }

  // ---------------- fetch 封装（供 console.js 覆盖前兜底）----------------
  function currentToken() {
    var st = NS.getState ? NS.getState() : null;
    return st || { token: '', raw: '' };
  }
  function headers(extra) {
    var st = currentToken();
    var h = { 'Content-Type': 'application/json' };
    if (st.token) h['x-console-token'] = st.token;
    if (st.raw) h['x-admin-token'] = st.raw;
    return Object.assign(h, extra || {});
  }
  async function api(method, path, body) {
    var st = currentToken();
    var h = { 'Content-Type': 'application/json' };
    if (st.token) h['x-console-token'] = st.token;
    if (st.raw) h['x-admin-token'] = st.raw;
    var r = await fetch(window.location.origin + path, {
      method: method, headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    var j = await r.json().catch(function () { return { error: '响应解析失败' }; });
    if (r.status === 401) { throw new Error(j.error || '未登录'); }
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ---------------- 通用 CRUD 客户端（§3.5）----------------
  /**
   * @param {string} entity 'codes' | 'devices' | 'printers' | 'configs'
   */
  function crud(entity) {
    return {
      list: function (params) {
        return api('GET', '/api/admin/ops/crud/' + entity + (params ? '?' + qs(params) : ''));
      },
      create: function (body) {
        return api('POST', '/api/admin/ops/crud/' + entity, body || {});
      },
      update: function (id, body) {
        return api('PUT', '/api/admin/ops/crud/' + entity + '/' + enc(id), body || {});
      },
      remove: function (id) {
        return api('DELETE', '/api/admin/ops/crud/' + entity + '/' + enc(id));
      },
    };
  }

  // ---------------- 轮询助手（CmdTracker 模式）----------------
  /**
   * 启动一个轮询循环；满足停止条件或超时自动停止。
   * @param {number} intervalMs 轮询间隔（毫秒）
   * @param {Function} fn 每轮执行（可返回 Promise；异常不外抛）
   * @param {Function} [shouldStop] 每轮后判定是否停止（返回 true 即停）
   * @param {number} [maxRounds] 最大轮数（默认 0 = 不限）
   * @returns {{start:Function, stop:Function}}
   */
  function poll(intervalMs, fn, shouldStop, maxRounds) {
    var timer = null;
    var rounds = 0;
    var inflight = false;
    function tick() {
      if (inflight) return;
      if (shouldStop && shouldStop()) { stop(); return; }
      if (maxRounds > 0 && rounds >= maxRounds) { stop(); return; }
      inflight = true;
      rounds++;
      Promise.resolve()
        .then(fn)
        .catch(function () { /* 单轮失败静默，等待下一轮 */ })
        .then(function () { inflight = false; });
    }
    function start() {
      stop();
      timer = setInterval(tick, intervalMs);
    }
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }
    return { start: start, stop: stop, tick: tick };
  }

  // ---------------- CSV 导出（带鉴权头）----------------
  /**
   * 导出审计 CSV：带鉴权头 fetch → Blob → 触发下载（UTF-8 BOM）。
   * @param {string} kind 'op' | 'cmd' | 'highrisk'
   * @param {object} params 筛选参数（同查询接口）
   */
  async function exportCsv(kind, params) {
    var path = '/api/admin/ops/audit/' + kind + '/export' + (params ? '?' + qs(params) : '');
    var st = currentToken();
    var h = {};
    if (st.token) h['x-console-token'] = st.token;
    if (st.raw) h['x-admin-token'] = st.raw;
    var r = await fetch(window.location.origin + path, { method: 'GET', headers: h });
    if (!r.ok) {
      var j = await r.json().catch(function () { return null; });
      throw new Error((j && j.error) || ('HTTP ' + r.status));
    }
    var text = await r.text();
    // UTF-8 BOM：Excel 直接打开中文不乱码
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ops-audit-' + kind + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
  }

  // ---------------- 导出到 window.ConsoleApp ----------------
  NS.enc = enc;
  NS.qs = qs;
  NS.headers = headers;
  NS.api = NS.api || api; // console.js 加载后会覆盖为更完善的版本
  NS.crud = crud;
  NS.poll = poll;
  NS.exportCsv = exportCsv;
})();
