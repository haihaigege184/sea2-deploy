'use strict';
/**
 * console.js — SEA1 商业化运维控制台前端逻辑
 * 纯原生 JS，无 CDN、无构建。fetch 统一带 x-console-token（超管也带 x-admin-token）。
 */
(function () {
  var API = location.origin;
  var LS_TOKEN = 'sea1_console_token';
  var LS_RAW = 'sea1_console_raw';

  var state = { token: '', raw: '', scope: '', level: 0, role: '' };
  // 配置视图快照（用于重置）
  var cfgOriginal = {};

  // FLEET 集群：/fleet/meta 缓存（前端零硬编码：徽标文案 / 阈值 / 指令分组全取自 meta）
  var META = null;
  var META_LOADING = false;
  var META_LOAD_AT = 0;
  // 自动刷新控制器状态
  var AUTO_TIMER = null;
  var AUTO_INFLIGHT = false;
  var CLUSTER_LAST_OK = 0; // 最近一次成功拉取的时间戳（ms）
  // 集群表格复选框选中态（machineId 集合），批量下发复用
  var SEL_MIDS = {};
  // 集群表格列数（改表头时同步改这里，否则空态/错误态的 colspan 会错位）
  var CLUSTER_COLS = 13;
  // 客户端详情抽屉：当前机器码与指令区轮询计时器
  var DETAIL_MID = '';
  var DETAIL_TIMER = null;
  // 集群表格当前渲染列表（shift 连选范围选择用，随主渲染/静默刷新同步）
  var CLUSTER_LIST = [];
  var LAST_CK_IDX = -1;
  // 连接四态降级文案（META 未加载时兜底，达成「前端零硬编码」闭环）
  var CONN_FALLBACK = {
    online: { key: 'online', label: '在线', badge: 'online' },
    stale: { key: 'stale', label: '掉线', badge: 'stale' },
    offline: { key: 'offline', label: '离线', badge: 'offline' },
    unreported: { key: 'unreported', label: '未上报', badge: 'unreported' },
  };

  // ---------------- 工具 ----------------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }
  function fmtDur(sec) {
    sec = Number(sec) || 0;
    var d = Math.floor(sec / 86400); sec -= d * 86400;
    var h = Math.floor(sec / 3600); sec -= h * 3600;
    var m = Math.floor(sec / 60); sec -= m * 60;
    return (d ? d + '天 ' : '') + h + '时' + m + '分' + sec + '秒';
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (kind || 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast ' + (kind || 'ok'); }, 3200);
  }

  function headers(extra) {
    var h = { 'Content-Type': 'application/json' };
    if (state.token) h['x-console-token'] = state.token;
    if (state.raw) h['x-admin-token'] = state.raw;
    return Object.assign(h, extra || {});
  }
  async function api(method, path, body) {
    var r = await fetch(API + path, {
      method: method, headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    var j = await r.json().catch(function () { return { error: '响应解析失败' }; });
    if (r.status === 401) { showLogin('会话已失效，请重新登录'); throw new Error(j.error || '未登录'); }
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ---------------- 登录 ----------------
  function showLogin(msg) {
    if (msg) $('loginErr').textContent = msg;
    $('loginMask').style.removeProperty('display');
    $('sidebar').style.display = '';
  }
  function hideLogin() {
    // 用内联 !important 替代 classList.hidden：生产环境 .hidden CSS 规则偶发不被浏览器解析（原因待查），
    // 导致登录 mask 在登录后仍覆盖页面。内联 style 是最稳兜底。
    $('loginMask').style.setProperty('display', 'none', 'important');
  }

  async function doLogin() {
    var token = $('loginToken').value.trim();
    var qq = $('loginQq').value.trim();
    if (!token && !qq) { $('loginErr').textContent = '请填写管理令牌或 QQ'; return; }
    try {
      var body = {};
      if (token) body.token = token;
      if (qq) body.qq = qq;
      var j = await fetch(API + '/api/admin/console/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).then(function (r) { return r.json().then(function (x) { return { ok: r.ok, data: x }; }); });
      if (!j.ok || !j.data.ok) { $('loginErr').textContent = (j.data && j.data.error) || '登录失败'; return; }
      state.token = j.data.token;
      state.raw = token || '';
      state.scope = j.data.scope;
      state.level = j.data.level;
      state.role = j.data.role;
      localStorage.setItem(LS_TOKEN, state.token);
      if (state.raw) localStorage.setItem(LS_RAW, state.raw); else localStorage.removeItem(LS_RAW);
      hideLogin();
      updateWho();
      loadView(currentView);
      toast('登录成功：' + j.data.role, 'ok');
    } catch (e) {
      $('loginErr').textContent = '登录失败：' + e.message;
    }
  }

  function logout() {
    state = { token: '', raw: '', scope: '', level: 0, role: '' };
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_RAW);
    showLanBadge(false);
    // [T2 P2-10] 局域网模式下「退出」无意义（后端对内网免登录）；退出后重新探测，
    // 若仍处于 LAN_BYPASS 环境则直接回到免登录态，否则显示登录遮罩。
    tryLanOrLogin();
  }

  function updateWho() {
    // [T2 P2-10] 局域网免登录：state.lan=true → 显示「局域网模式（L3）」，不展示令牌/登录态
    var txt = state.lan ? '局域网模式（L3）'
      : (state.role ? (state.raw ? '超管（令牌）' : ('登录：' + state.role + ' (L' + state.level + ')')) : '');
    $('who').textContent = txt;
    $('sideRole').textContent = txt;
    showLanBadge(!!state.lan);
  }

  // [T2 P2-10] 局域网免登录角标显隐
  function showLanBadge(on) {
    var el = $('lanBadge');
    if (el) el.classList.toggle('hidden', !on);
  }

  // [T2 P2-10] 未登录时探测局域网免登录（LAN_BYPASS）：
  //   后端对「内网来源 + 无 token」放行 L3 → 页面跳过登录遮罩直接进入；
  //   公网来源 / 开关关闭 → 401，显示登录遮罩。
  //   用裸 fetch（不走 api()），避免 api() 的 401 处理误弹「会话已失效」。
  function tryLanOrLogin() {
    fetch(API + '/api/admin/console/status', { method: 'GET', headers: { 'Content-Type': 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j && j.ok) {
          state = { token: '', raw: '', scope: 'super', level: 3, role: '局域网模式（L3）', lan: true };
          hideLogin();
          updateWho();
          loadView(viewFromHash());
          toast('局域网模式（L3）：免登录直达', 'ok');
        } else {
          showLogin('');
          currentView = viewFromHash();
        }
      })
      .catch(function () {
        showLogin('');
        currentView = viewFromHash();
      });
  }

  // ---------------- 视图切换 ----------------
  var currentView = 'overview';
  // T04：9 大菜单中文名（与 console.i18n.js I18N.menus 对齐；遗留视图保留 hash 兼容）
  var viewTitle = {
    overview: '总览', config: '配置中心', orders: '订单·会员', admins: '管理员',
    cluster: '集群管理', printers: '打印机', anomalies: '异常', license: '授权管理', system: '系统状态',
    process: '进程管理', cups: '打印与CUPS', device: '设备管理', highrisk: '高危操作', audit: '审计中心',
    'order-audit': '订单审计', // [T2 P2-11]
    docker: '容器管理', // [R6 R4]
    docs: '帮助中心', // [DOCS] 帮助中心视图
  };
  // hash 路由：/console#cluster 直达对应视图（与 /admin → /console#license 重定向配合）
  var HASH_VIEWS = ['overview', 'config', 'orders', 'admins', 'cluster', 'printers', 'anomalies', 'license', 'system', 'process', 'cups', 'device', 'highrisk', 'audit', 'order-audit', 'docker', 'docs'];
  var suppressHash = false;

  // ---------------- T04 视图注册表（多文件 IIFE 架构）----------------
  // console.js 注册基础视图；console.{admin,pm,cups,highrisk,audit}.js 按序加载后注册各自视图。
  var VIEW_REG = {};
  var VIEW_HOOKS = {};
  function registerView(name, fn) {
    if (name && typeof fn === 'function') VIEW_REG[name] = fn;
  }
  function callView(name) {
    var fn = VIEW_REG[name];
    if (fn) fn();
  }
  // 视图增强钩子：主视图渲染完成后执行（如配置中心追加「运维键/历史回滚」面板）
  function registerViewHook(name, fn) {
    if (!name || typeof fn !== 'function') return;
    (VIEW_HOOKS[name] = VIEW_HOOKS[name] || []).push(fn);
  }
  function runViewHooks(name) {
    (VIEW_HOOKS[name] || []).forEach(function (fn) {
      try { fn(); } catch (e) { /* 钩子异常不影响主视图 */ }
    });
  }

  // T04：中文字典兜底取词（window.I18N 未加载时回退 fallback，绝不回退英文 key）
  function i18n(scope, key, fallback) {
    try {
      var v = window.I18N && window.I18N[scope] && window.I18N[scope][key];
      return (v !== undefined && v !== null) ? v : (fallback !== undefined ? fallback : String(key));
    } catch (e) {
      return fallback !== undefined ? fallback : String(key);
    }
  }

  function viewFromHash() {
    var h = (location.hash || '').replace(/^#/, '').trim();
    return HASH_VIEWS.indexOf(h) >= 0 ? h : 'overview';
  }
  function syncHash(v) {
    suppressHash = true;
    if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
    suppressHash = false;
  }

  function loadView(v) {
    if (HASH_VIEWS.indexOf(v) < 0) v = 'overview';
    currentView = v;
    syncHash(v);
    document.querySelectorAll('.nav').forEach(function (n) { n.classList.toggle('active', n.dataset.view === v); });
    $('crumb').textContent = viewTitle[v] || v;
    document.querySelectorAll('.view').forEach(function (s) { s.classList.add('hidden'); });
    var el = $('view-' + v);
    if (el) el.classList.remove('hidden');
    // 离开集群视图立刻停掉自动刷新：否则定时器会一直空转到页面关闭
    if (v !== 'cluster') stopClusterAuto();
    // T04：视图渲染统一走注册表（基础视图在此文件注册，六大新视图由 console.*.js 注册）
    callView(v);
  }

  // ---------------- 概览 ----------------
  async function renderOverview() {
    var box = $('ovCards');
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      var d = await api('GET', '/api/admin/console/status');
      var s = d.status;
      var html = '';
      html += card('运行状态', [
        ['健康', s.health],
        ['运行时长', fmtDur(s.uptimeSec)],
        ['启动时间', fmtTime(s.startTime)],
      ]);
      html += card('CPU', [
        ['型号', s.cpu.model],
        ['核心数', s.cpu.count],
        ['负载', (s.cpu.loadavg || []).map(function (x) { return x.toFixed(2); }).join(' / ')],
      ]);
      var memPct = s.mem.usedPercent != null ? Number(s.mem.usedPercent) : 0;
      html += card('内存', [
        ['已用', fmtBytes(s.mem.used)],
        ['总量', fmtBytes(s.mem.total)],
        ['空闲', fmtBytes(s.mem.free)],
      ], memPct);
      html += card('统计', Object.keys(s.stats || {}).map(function (k) { return [k, s.stats[k]]; }));
      html += card('进程', [
        ['PID', s.process.pid],
        ['PM2', s.process.pm2 ? (s.process.pm2.length + ' 个') : '不可用'],
      ]);
      box.innerHTML = html || '<div class="loading">无数据</div>';
      // T04：总览聚合卡片 + 容量条（连接四态文案/配色仍由 META 驱动，前端零硬编码）
      renderFleetOverview();
    } catch (e) {
      box.innerHTML = '<div class="loading">加载失败：' + esc(e.message) + '</div>';
    }
  }

  // 总览-设备集群：聚合四态 + 异常 + 总计 + 1000 容量条
  async function renderFleetOverview() {
    var box = $('ovFleetCards');
    if (!box) return;
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      var d = await api('GET', '/api/admin/fleet/clients?pageSize=1');
      var agg = d.agg || {};
      var cards = [
        { label: metaConnLabel('online'), val: agg.online || 0, dot: metaConnBadge('online'), sub: agg.onlineLicenseBad ? ('其中 ' + agg.onlineLicenseBad + ' 台授权异常') : '' },
        { label: metaConnLabel('stale'), val: agg.stale || 0, dot: metaConnBadge('stale'), sub: '' },
        { label: metaConnLabel('offline'), val: agg.offline || 0, dot: metaConnBadge('offline'), sub: '' },
        { label: metaConnLabel('unreported'), val: agg.unreported || 0, dot: metaConnBadge('unreported'), sub: '' },
        { label: trialLabel(), val: agg.trial || 0, dot: 'trial', sub: agg.trial ? (agg.trial + ' 台试用设备') : '' },
        { label: '异常', val: agg.abnormal || 0, dot: 'abnormal', sub: agg.blacklisted ? ('已拉黑 ' + agg.blacklisted + ' 台') : '' },
        { label: '总计', val: agg.total || 0, dot: 'normal', sub: '容量 1000 台' },
      ];
      var cap = Math.min(100, Math.round(((agg.total || 0) / 1000) * 100));
      box.innerHTML = cards.map(function (c) {
        return '<div class="card" style="padding:14px 18px"><h3><span class="dot ' + c.dot + '"></span>' + esc(c.label) + '</h3>' +
          '<div style="font-size:26px;font-weight:700">' + c.val + '</div>' +
          (c.sub ? '<div class="filter-tip" style="margin-top:4px">' + esc(c.sub) + '</div>' : '') + '</div>';
      }).join('') +
        '<div class="card" style="grid-column:1/-1"><h3>容量条（当前 / 1000）</h3>' +
        '<div class="bar"><i style="width:' + cap + '%"></i></div>' +
        '<div class="filter-tip" style="margin-top:6px">已用容量 ' + cap + '%（' + (agg.total || 0) + '/1000）</div></div>';
    } catch (e) {
      box.innerHTML = '<div class="loading">集群数据加载失败（不影响其他模块）</div>';
    }
  }

  function card(title, kv, barPct) {
    var inner = kv.map(function (p) {
      return '<div class="kv"><span class="k">' + esc(p[0]) + '</span><span class="v">' + esc(p[1]) + '</span></div>';
    }).join('');
    var bar = (barPct != null) ? '<div class="bar"><i style="width:' + Math.min(100, Math.max(0, barPct)) + '%"></i></div>' : '';
    return '<div class="card"><h3>' + esc(title) + '</h3>' + inner + bar + '</div>';
  }

  // ---------------- 配置 ----------------
  // [R5] 配置分组编辑态（localStorage 持久化）
  // [R6 R2] 移除 HTML5 拖拽（cfgDrag*），改为编辑态 ↑/↓ 箭头相邻交换（moveGroup）即时持久化
  var cfgEditOn = false;
  var CFG_ORDER_LS = 'config_group_order';

  function loadGroupOrder() {
    try {
      var raw = localStorage.getItem(CFG_ORDER_LS);
      if (!raw) return null;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : null;
    } catch (e) { return null; }
  }
  function saveGroupOrder(order) {
    try { localStorage.setItem(CFG_ORDER_LS, JSON.stringify(order)); } catch (e) { /* ignore */ }
  }

  async function renderConfig() {
    var box = $('cfgGroups');
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      var d = await api('GET', '/api/admin/console/vars');
      var groups = d.groups || {};
      // [R5] 隐藏字段不渲染；group 内全 hidden → 整卡不渲染（「一键部署」由 console.deploy.js 面板承载）
      var visible = {};
      Object.keys(groups).forEach(function (g) {
        var fields = (groups[g] || []).filter(function (f) { return f.hidden !== true; });
        if (fields.length) visible[g] = fields;
      });
      // [R5] 分组顺序：localStorage 持久化（config_group_order）；非法回退 SCHEMA 顺序（buildGroupOrder 纯函数）
      var order = Object.keys(visible);
      var saved = loadGroupOrder();
      if (window.ConfigOrder && typeof window.ConfigOrder.buildGroupOrder === 'function') {
        order = window.ConfigOrder.buildGroupOrder(order, saved);
      }
      var html = '';
      order.forEach(function (g, gi) {
        // [R6 R2] 编辑态 ↑/↓ 箭头（首 ↑ 禁用、末 ↓ 禁用；CSS 控制仅编辑态显示）
        var upDisabled = gi === 0 ? ' disabled' : '';
        var downDisabled = gi === order.length - 1 ? ' disabled' : '';
        html += '<div class="cfg-group" data-gname="' + esc(g) + '">' +
          '<h2><span class="cfg-move" data-dir="up" title="上移分组"' + upDisabled + '>↑</span>' +
          '<span class="cfg-move" data-dir="down" title="下移分组"' + downDisabled + '>↓</span>' +
          '<span class="cfg-gname">' + esc(g) + '</span></h2>';
        visible[g].forEach(function (f) { html += cfgField(f); });
        html += '</div>';
      });
      box.innerHTML = html || '<div class="loading">无可配置项</div>';
      box.classList.toggle('editing', cfgEditOn);
      // 回填 + 记录快照
      cfgOriginal = {};
      order.forEach(function (g) {
        visible[g].forEach(function (f) { fillCfg(f); });
      });
      // T04：配置中心增强钩子（console.admin.js 追加运维键编辑 / 历史回滚面板；
      // [R4] console.deploy.js 追加「一键部署」面板——穿透地址 CRUD + git 推送）
      runViewHooks('config');
    } catch (e) {
      box.innerHTML = '<div class="loading">加载失败：' + esc(e.message) + '</div>';
    }
  }

  // [R5] 编辑态切换：卡片描边高亮 + ↑/↓ 箭头（[R6 R2] 移除拖拽，改相邻交换）
  function toggleCfgEdit() {
    cfgEditOn = !cfgEditOn;
    var box = $('cfgGroups');
    var btn = $('cfgEditBtn');
    if (box) box.classList.toggle('editing', cfgEditOn);
    if (btn) {
      btn.textContent = cfgEditOn ? '✓ 完成排序' : '✎ 编辑排序';
      btn.classList.toggle('active', cfgEditOn);
    }
    if (!cfgEditOn) persistCfgOrder();
    updateMoveButtons();
  }

  /**
   * [R6 R2] ↑/↓ 相邻交换：点击箭头即时交换相邻分组（DOM 级交换，保留字段输入值），
   * 并立即持久化到 localStorage(config_group_order)。
   * @param {'up'|'down'} dir
   * @param {HTMLElement} card 被点击箭头所在 .cfg-group
   */
  function moveGroup(dir, card) {
    var box = $('cfgGroups');
    if (!box || !card || !cfgEditOn) return;
    var cards = Array.prototype.slice.call(box.querySelectorAll('.cfg-group'));
    var idx = cards.indexOf(card);
    if (idx < 0) return;
    var target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= cards.length) return;
    // 纯函数辅助（config-order.js）：在旧顺序上计算新顺序并持久化（与 DOM 交换结果一致）
    var oldOrder = cards.map(function (c) { return c.dataset.gname || ''; }).filter(Boolean);
    var newOrder = null;
    if (window.ConfigOrder && typeof window.ConfigOrder.moveInOrder === 'function') {
      newOrder = window.ConfigOrder.moveInOrder(oldOrder, idx, dir);
    }
    if (!newOrder) {
      newOrder = oldOrder.slice();
      var tmp = newOrder[idx];
      newOrder[idx] = newOrder[target];
      newOrder[target] = tmp;
    }
    saveGroupOrder(newOrder);
    // DOM 级相邻交换（保留字段输入值，不重建表单）
    if (dir === 'up') box.insertBefore(card, cards[target]);
    else box.insertBefore(cards[target], card);
    updateMoveButtons();
  }

  /** [R6 R2] 更新全部分组 ↑/↓ 禁用态（首 ↑ 禁用、末 ↓ 禁用） */
  function updateMoveButtons() {
    var box = $('cfgGroups');
    if (!box) return;
    var cards = Array.prototype.slice.call(box.querySelectorAll('.cfg-group'));
    cards.forEach(function (c, i) {
      var up = c.querySelector('.cfg-move[data-dir="up"]');
      var down = c.querySelector('.cfg-move[data-dir="down"]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === cards.length - 1;
    });
  }

  function persistCfgOrder() {
    var box = $('cfgGroups');
    if (!box) return;
    var order = Array.prototype.map.call(box.querySelectorAll('.cfg-group'), function (c) { return c.dataset.gname || ''; }).filter(Boolean);
    if (order.length) saveGroupOrder(order);
  }

  function cfgField(f) {
    var tags = '';
    if (f.hot) tags += '<span class="tag hot">即时生效</span>';
    if (f.requiresRestart && !f.hot) tags += '<span class="tag restart">需重启</span>';
    var help = f.help ? '<div class="help">' + esc(f.help) + '</div>' : '';
    return '<div class="field" data-key="' + esc(f.key) + '">' +
      '<div class="flabel"><span class="name">' + esc(f.label) + '</span>' + helpTipHtml(f) +
      '<span class="env">' + esc(f.env || '') + '</span>' + tags + '</div>' +
      '<div class="control" id="ctl_' + esc(f.key) + '"></div>' + help + '</div>';
  }

  // [R5] 「?」图标：label 右侧悬停显示五段 helpDetail（含义/如何填写/示例/影响/填错后果）；
  //       无 helpDetail 时回退 help 文案；两者皆无则不渲染图标。
  function helpTipHtml(f) {
    var title = '';
    if (f.helpDetail && typeof f.helpDetail === 'object') {
      var parts = [
        f.helpDetail.meaning, f.helpDetail.howToFill, f.helpDetail.example,
        f.helpDetail.impact, f.helpDetail.wrongConsequence,
      ];
      title = parts.filter(Boolean).join('\n');
    } else if (f.help) {
      title = f.help;
    }
    return title ? '<span class="help-tip" title="' + esc(title) + '">?</span>' : '';
  }

  function fillCfg(f) {
    var ctl = $('ctl_' + f.key);
    if (!ctl) return;
    var v = (f.value && typeof f.value === 'object') ? f.value : { value: f.value };
    var h = '';
    if (f.type === 'secret') {
      var ph = v.set ? '已设置，留空保持不变' : '未设置，填写以设置新值';
      h = '<div class="secret-wrap"><input id="f_' + esc(f.key) + '" type="password" placeholder="' + esc(ph) + '" autocomplete="off" />' +
        '<span class="toggle" data-for="f_' + esc(f.key) + '">显示</span></div>';
    } else if (f.type === 'boolean') {
      var on = String(v.value) === '1' || String(v.value) === 'true';
      h = '<label class="switch"><input id="f_' + esc(f.key) + '" type="checkbox" ' + (on ? 'checked' : '') + ' /><span class="track"></span><span class="state" id="st_' + esc(f.key) + '">' + (on ? '开启' : '关闭') + '</span></label>';
    } else if (f.type === 'select') {
      h = '<select id="f_' + esc(f.key) + '">' + (f.options || []).map(function (o) {
        return '<option value="' + esc(o) + '"' + (String(v.value) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('') + '</select>';
    } else if (f.type === 'json') {
      h = '<textarea id="f_' + esc(f.key) + '" spellcheck="false" placeholder="{}">' + esc(v.value || '{}') + '</textarea>';
    } else {
      var t = f.type === 'number' ? 'number' : 'text';
      h = '<input id="f_' + esc(f.key) + '" type="' + t + '" value="' + esc(v.value || '') + '" />';
    }
    ctl.innerHTML = h;
    cfgOriginal[f.key] = curCfg(f);
    if (f.type === 'secret') {
      ctl.querySelector('.toggle').addEventListener('click', function () {
        var inp = $('f_' + f.key);
        if (inp.type === 'password') { inp.type = 'text'; this.textContent = '隐藏'; } else { inp.type = 'password'; this.textContent = '显示'; }
      });
    }
    if (f.type === 'boolean') {
      $('f_' + f.key).addEventListener('change', function (e) { $('st_' + f.key).textContent = e.target.checked ? '开启' : '关闭'; });
    }
  }

  function curCfg(f) {
    var el = $('f_' + f.key);
    if (!el) return '';
    if (f.type === 'boolean') return el.checked ? '1' : '0';
    return el.value == null ? '' : el.value;
  }

  async function saveConfig() {
    var btn = $('cfgSaveBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>保存中…';
    try {
      var patch = {};
      Object.keys(cfgOriginal).forEach(function (k) { patch[k] = curCfg({ key: k, type: inferType(k) }); });
      // 仅发送有变化的项
      var changed = {};
      Object.keys(patch).forEach(function (k) {
        if (patch[k] !== cfgOriginal[k]) changed[k] = patch[k];
      });
      var r = await api('POST', '/api/admin/console/vars', { patch: changed });
      if (r.restartRequired) toast('已保存，部分项需重启服务后生效', 'warn');
      else toast('已保存，配置即时生效', 'ok');
      await renderConfig();
    } catch (e) {
      toast('保存失败：' + e.message, 'bad');
    } finally {
      btn.disabled = false; btn.textContent = '保存配置';
    }
  }
  // 从 DOM 推断类型（secret/boolean/select/json/number/text）以正确取值
  function inferType(key) {
    var el = $('f_' + key);
    if (!el) return 'text';
    if (el.type === 'checkbox') return 'boolean';
    if (el.tagName === 'SELECT') return 'select';
    if (el.tagName === 'TEXTAREA') return 'json';
    if (el.type === 'password') return 'secret';
    if (el.type === 'number') return 'number';
    return 'text';
  }

  // ---------------- 订单 ----------------
  // 订单状态取词：metaStatus('orderStatus', st)（META 下发 → I18N 字典 → 原样 key，前端零硬编码）
  function statusTag(st) {
    var m = metaStatus('orderStatus', st);
    return '<span class="tag s-' + esc(m.badge) + '">' + esc(m.label) + '</span>';
  }
  async function renderOrders() {
    var t = $('ordersTable');
    t.querySelector('thead').innerHTML = '<tr><th>订单号</th><th>QQ</th><th>套餐</th><th>状态</th><th>金额</th><th>时间</th><th>激活码</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="7" class="loading">加载中…</td></tr>';
    try {
      var d = await api('GET', '/api/admin/console/orders');
      var rows = d.orders || [];
      if (!rows.length) { t.querySelector('tbody').innerHTML = '<tr><td colspan="7" class="loading">暂无订单</td></tr>'; return; }
      t.querySelector('tbody').innerHTML = rows.map(function (o) {
        return '<tr><td>' + esc(o.order_id) + '</td><td>' + esc(o.qq) + '</td><td>' + esc(o.planName || o.plan) +
          '</td><td>' + statusTag(o.status) + '</td><td>' + esc(o.amount) + '</td><td>' + esc(fmtTime(o.created_at)) +
          '</td><td class="wrap">' + esc(o.code || '—') + '</td></tr>';
      }).join('');
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="7" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  async function openGrant() {
    var orders;
    try { orders = (await api('GET', '/api/admin/console/orders')).orders || []; } catch (e) { orders = []; }
    var opt = '<option value="">— 选择已支付订单 —</option>' + orders.filter(function (o) { return o.status === 'paid' || o.status === 'issued'; }).map(function (o) {
      return '<option value="' + esc(o.order_id) + '">' + esc(o.order_id) + ' · ' + esc(o.qq) + ' · ' + esc(o.planName || o.plan) + '</option>';
    }).join('');
    var body = '<div><label style="font-size:12.5px;color:var(--mut)">按订单开通</label>' +
      '<select id="gOrder">' + opt + '</select></div>' +
      '<div style="border-top:1px solid var(--line);margin:4px 0"></div>' +
      '<div><label style="font-size:12.5px;color:var(--mut)">或按 QQ 直接开通</label>' +
      '<input id="gQq" type="text" placeholder="QQ 号" /></div>' +
      '<div><select id="gPlan"><option value="month">月 (5)</option><option value="quarter">季 (12)</option><option value="year">年 (48)</option><option value="lifetime">永久 (128)</option></select></div>';
    openModal('开通会员', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '开通', cls: '', onClick: submitGrant },
    ]);
  }
  async function submitGrant() {
    var orderId = $('gOrder').value;
    var qq = $('gQq').value.trim();
    var plan = $('gPlan').value;
    var payload;
    if (orderId) payload = { orderId: orderId };
    else if (qq && plan) payload = { qq: qq, plan: plan };
    else { toast('请选择订单或填写 QQ+套餐', 'warn'); return; }
    try {
      var r = await api('POST', '/api/admin/console/grant', payload);
      toast('已开通：' + (r.code || ''), 'ok');
      closeModal();
      renderOrders();
    } catch (e) { toast('开通失败：' + e.message, 'bad'); }
  }

  // ---------------- 管理员 ----------------
  async function renderAdmins() {
    var t = $('adminsTable');
    t.querySelector('thead').innerHTML = '<tr><th>QQ</th><th>等级</th><th>角色</th><th>来源</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">加载中…</td></tr>';
    try {
      var d = await api('GET', '/api/admin/console/admins');
      var list = d.admins || [];
      if (!list.length) { t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">暂无管理员（N4 桥接未就绪时仅超管可用）</td></tr>'; return; }
      t.querySelector('tbody').innerHTML = list.map(function (u) {
        return '<tr><td>' + esc(u.uin) + '</td><td>L' + esc(u.level) + '</td><td>' + esc(u.role || '') +
          '</td><td>' + (u.fallback ? '系统兜底' : 'N4') + '</td><td class="row-actions">' +
          '<button class="btn ghost sm" data-rm="' + esc(u.uin) + '">移除</button></td></tr>';
      }).join('');
      t.querySelectorAll('[data-rm]').forEach(function (b) {
        b.addEventListener('click', function () { confirmRemove(b.dataset.rm); });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }
  function openAddAdmin() {
    var body = '<div><input id="aQq" type="text" placeholder="QQ 号" /></div>' +
      '<div><select id="aLevel"><option value="0">L0 普通用户</option><option value="1">L1 管理员</option><option value="2">L2 超级管理员</option><option value="3">L3 开发者</option></select></div>';
    openModal('新增/设置管理员', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '提交（入队）', cls: '', onClick: submitAddAdmin },
    ]);
  }
  async function submitAddAdmin() {
    var qq = $('aQq').value.trim();
    var level = Number($('aLevel').value);
    if (!qq) { toast('请填写 QQ', 'warn'); return; }
    try {
      var r = await api('POST', '/api/admin/console/admins', { qq: qq, level: level });
      toast(r.message || '已入队', 'ok');
      closeModal();
      renderAdmins();
    } catch (e) { toast('失败：' + e.message, 'bad'); }
  }
  function confirmRemove(qq) {
    openModal('移除管理员', '<p>确认将 <b>' + esc(qq) + '</b> 移回普通用户（L0）？该操作异步生效。</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认移除', cls: 'danger', onClick: function () { doRemove(qq); } },
    ]);
  }
  async function doRemove(qq) {
    try {
      await api('DELETE', '/api/admin/console/admins/' + encodeURIComponent(qq));
      toast('已移除并入队', 'ok');
      closeModal();
      renderAdmins();
    } catch (e) { toast('失败：' + e.message, 'bad'); }
  }

  // ---------------- 设备 ----------------
  // 设备状态取词：metaStatus('deviceStatus', st)（META 下发 → I18N 兜底 → 原样 key）
  function devStatusTag(st) {
    var m = metaStatus('deviceStatus', st);
    return '<span class="tag s-' + esc(m.badge) + '">' + esc(m.label) + '</span>';
  }
  async function renderDevices() {
    var t = $('devicesTable');
    // [T1-P1-5] 兜底视图防护：console.html 中不存在 #devicesTable（旧授权页兜底），
    // 若 console.admin.js 未加载/加载失败，此处直接 return 并提示，而不是抛错中断整页。
    if (!t) {
      var alt = $('licenseTable');
      if (alt && alt.querySelector('tbody')) {
        alt.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">视图加载失败：缺少 #devicesTable 容器（请刷新页面重试）</td></tr>';
      }
      return;
    }
    t.querySelector('thead').innerHTML = '<tr><th>机器/ID</th><th>QQ</th><th>套餐</th><th>状态</th><th>到期</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="6" class="loading">加载中…</td></tr>';
    try {
      var d = await api('GET', '/api/admin/devices');
      var list = d.devices || [];
      if (!list.length) { t.querySelector('tbody').innerHTML = '<tr><td colspan="6" class="loading">暂无设备</td></tr>'; return; }
      t.querySelector('tbody').innerHTML = list.map(function (x) {
        return '<tr><td class="wrap">' + esc(x.machine_id || x.id) + '</td><td>' + esc(x.qq || '—') +
          '</td><td>' + esc(x.planName || x.plan || '—') + '</td><td>' + devStatusTag(x.status) +
          '</td><td>' + (x.license_expires_at ? fmtTime(x.license_expires_at) : '—') + '</td><td class="row-actions">' +
          '<button class="btn ghost sm" data-act="disable" data-id="' + enc(x.id) + '">禁用</button>' +
          '<button class="btn ghost sm" data-act="reset" data-id="' + enc(x.id) + '">重置</button>' +
          '<button class="btn danger sm" data-act="restart" data-id="' + enc(x.id) + '">重启</button></td></tr>';
      }).join('');
      t.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function () { deviceAction(b.dataset.id, b.dataset.act); });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="6" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }
  function enc(s) { return encodeURIComponent(s || ''); }
  function deviceAction(id, act) {
    var label = { disable: '禁用', reset: '重置', restart: '重启 bot' }[act] || act;
    openModal(label + ' 设备', '<p>确认对 <b>' + esc(decodeURIComponent(id)) + '</b> 执行「' + label + '」？' +
      (act === 'restart' ? '<br/><span style="color:var(--warn)">将重启 sea1-bot 进程（60 秒内限一次）。</span>' : '') + '</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认', cls: act === 'restart' ? 'danger' : '', onClick: function () { doDeviceAction(id, act); } },
    ]);
  }
  async function doDeviceAction(id, act) {
    try {
      await api('POST', '/api/admin/devices/' + enc(decodeURIComponent(id)) + '/action', { action: act });
      toast('操作成功：' + act, 'ok');
      closeModal();
      renderDevices();
    } catch (e) { toast('失败：' + e.message, 'bad'); }
  }

  // ---------------- 打印机（FLEET 客户端聚合） ----------------
  // D2：打印机配置不再由服务端下发，改为客户端自报 + 远程禁用/启用（通过指令下发到客户端）。
  async function renderFleetPrinters() {
    var t = $('fleetPrintersTable');
    t.querySelector('thead').innerHTML = '<tr><th>打印机</th><th>状态</th><th>所属客户端</th><th>客户端版本</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">加载中…</td></tr>';
    try {
      var d = await api('GET', '/api/admin/fleet/printers');
      var list = d.items || [];
      var q = ($('prnQ').value || '').trim().toLowerCase();
      if (q) list = list.filter(function (p) {
        return (p.name || '').toLowerCase().indexOf(q) >= 0 || (p.clientMachineId || '').toLowerCase().indexOf(q) >= 0;
      });
      if (!list.length) { t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">暂无打印机上报</td></tr>'; return; }
      t.querySelector('tbody').innerHTML = list.map(function (p) {
        var st = p.status || 'unknown';
        var stMeta = metaStatus('printerStatus', st);
        var dot = '<span class="dot ' + esc(stMeta.badge) + '"></span>';
        return '<tr><td>' + esc(p.name) + '</td><td>' + dot + esc(stMeta.label) +
          '</td><td class="wrap">' + esc(p.clientMachineId || '—') + '</td><td>' + esc(p.clientVersion || '—') +
          '</td><td class="row-actions">' +
          '<button class="btn ghost sm" data-fpa="disable" data-mid="' + enc(p.clientMachineId) + '" data-pn="' + enc(p.name) + '">禁用</button>' +
          '<button class="btn ghost sm" data-fpa="enable" data-mid="' + enc(p.clientMachineId) + '" data-pn="' + enc(p.name) + '">启用</button></td></tr>';
      }).join('');
      t.querySelectorAll('[data-fpa]').forEach(function (b) {
        b.addEventListener('click', function () { fleetPrinterAction(b.dataset.mid, b.dataset.pn, b.dataset.fpa); });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }
  function fleetPrinterAction(mid, name, act) {
    if (!requireWrite('远程' + (act === 'disable' ? '禁用' : '启用') + '打印机')) return;
    var label = act === 'disable' ? '禁用' : '启用';
    openModal(label + ' 打印机（远程指令）', '<p>将向客户端 <b>' + esc(decodeURIComponent(mid)) + '</b> 下发指令：' +
      label + '打印机 <b>' + esc(decodeURIComponent(name)) + '</b>。</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认下发', cls: act === 'disable' ? 'danger' : '', onClick: function () {
        issueFleetCommand(decodeURIComponent(mid), act === 'disable' ? 'disable_printer' : 'enable_printer',
          { printerName: decodeURIComponent(name) }, label + '打印机', 'printers');
      } },
    ]);
  }

  // ---------------- FLEET：权限 / 状态徽标 ----------------
  // L2+ 才能下发写操作（远程指令 / 异常处置）；L0/L1 仅只读。
  function requireWrite(label) {
    if (state.level < 2) { toast('需要 L2 及以上权限才能' + (label || '执行写操作'), 'warn'); return false; }
    return true;
  }
  // 相对时间（如「3分钟前」），用于「最后更新」「最近心跳」等场景
  function relTime(ts) {
    if (!ts) return '—';
    var sec = Math.floor(Date.now() / 1000) - (typeof ts === 'number' && ts < 1e12 ? ts : Math.floor(ts / 1000));
    if (sec < 0) sec = 0;
    if (sec < 60) return sec + '秒前';
    if (sec < 3600) return Math.floor(sec / 60) + '分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + '小时前';
    return Math.floor(sec / 86400) + '天前';
  }

  // 连接性徽标（四态，前端零硬编码）：online / stale / offline / unreported
  // 文案/配色全部来自 /fleet/meta.connectivity（服务端单一事实来源）；META 未加载时降级 CONN_FALLBACK
  function connBadge(connectivity) {
    var e = metaConn(connectivity);
    return '<span class="dot ' + e.badge + '"></span><span class="st-' + e.badge + '">' + esc(e.label) + '</span>';
  }

  // 授权态徽标（六/七态，全部来自 /fleet/meta.reasons，前端零硬编码）
  // 悬浮 title 显示 raw reason + advice
  function licenseBadge(licenseState, rawReason) {
    var r = metaReason(rawReason, licenseState);
    return '<span class="lic ' + (r.badge || 'unknown') + '" title="' +
      esc('reason: ' + (rawReason || '—') + (r.advice ? ('\n建议：' + r.advice) : '')) + '">' +
      esc(r.label || licenseState || '未知') + '</span>';
  }

  // /fleet/meta.limits 取值（服务端未下发时用调用方给的保守默认）
  function metaLimitOf(key, dft) {
    var l = (META && META.limits) || {};
    return l[key] != null ? l[key] : dft;
  }

  // licenseState -> {key,label,badge}（来自 /fleet/meta.licenseStates，服务端单一事实来源）
  function metaLicenseState(key) {
    var arr = (META && META.licenseStates) || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].key === key) return arr[i];
    }
    return null;
  }

  // 从 META.reasons 查 reason 字典（fail-safe：未收录时回退到 licenseState 语义表）
  function metaReason(rawReason, licenseState) {
    if (META && META.reasons) {
      for (var i = 0; i < META.reasons.length; i++) {
        if (META.reasons[i].reason === rawReason) return META.reasons[i];
      }
    }
    // 未命中：回退到 META.licenseStates（同样由服务端下发，前端不硬编码任何中文与配色）
    var ls = metaLicenseState(licenseState);
    return {
      reason: rawReason || 'unknown',
      licenseState: licenseState || 'unknown',
      label: ls ? ls.label : (licenseState || '未知'),
      badge: ls ? ls.badge : 'unknown',
      advice: '',
    };
  }

  function clientStatusBadge(st) {
    var map = {
      online: ['online', '在线'], offline: ['offline', '离线'], abnormal: ['abnormal', '异常'],
      blacklisted: ['blacklisted', '已拉黑'], normal: ['normal', '正常'],
      stale: ['stale', '掉线'], unreported: ['unreported', '未上报'],
    };
    var m = map[st] || ['unknown', String(st || '未知')];
    return '<span class="dot ' + m[0] + '"></span><span class="st-' + m[0] + '">' + m[1] + '</span>';
  }

  // ---------------- FLEET：连接态 / 指令态 零硬编码取词 ----------------
  // 从 META.connectivity 按 key 取 {key,label,badge}，未命中/未加载降级 CONN_FALLBACK
  function metaConn(key) {
    if (META && META.connectivity) {
      for (var i = 0; i < META.connectivity.length; i++) {
        if (META.connectivity[i].key === key) return META.connectivity[i];
      }
    }
    return CONN_FALLBACK[key] || { key: key || 'unknown', label: String(key || '未知'), badge: 'unknown' };
  }
  function metaConnLabel(key) { return metaConn(key).label; }
  function metaConnBadge(key) { return metaConn(key).badge; }

  // ---------------- FLEET：状态语义五表 零硬编码取词（设计 §9.3.2 / §9.4.5）----------------
  // metaStatus(metaKey, st)：返回 {key,label,badge}
  //   ① META[metaKey]（[{key,label,badge}] 数组，服务端单一事实来源）命中 → 直接返回；
  //   ② 未命中 → 回退 window.I18N[metaKey][st]（仅文案，badge 归 unknown 中性配色）；
  //   ③ 再未命中 → 原样 key（fail-safe：字典缺失时展示 key 本身，绝不伪造英文语义）。
  function metaStatus(metaKey, st) {
    var key = String(st == null ? '' : st);
    if (META && META[metaKey] && Array.isArray(META[metaKey])) {
      for (var i = 0; i < META[metaKey].length; i++) {
        if (META[metaKey][i] && META[metaKey][i].key === key) return META[metaKey][i];
      }
    }
    var dict = (typeof window !== 'undefined' && window.I18N) ? window.I18N[metaKey] : null;
    if (dict && dict[key] != null) return { key: key, label: dict[key], badge: 'unknown' };
    return { key: key, label: key || '未知', badge: 'unknown' };
  }

  // 试用徽标文案（设计 §9.4.5）：metaStatus('trialBadge','trial') 优先，
  // 兜底 I18N.trial.label 中文，绝不在集群行出现英文「trial」。
  function trialLabel() {
    var m = metaStatus('trialBadge', 'trial');
    return (m.label && m.label !== 'trial') ? m.label : i18n('trial', 'label', '试用');
  }
  // 试用徽标 HTML：固定 s-trial 橙色调（与正式授权绿/蓝区分），文案走 trialLabel()
  function trialBadgeTag() {
    return '<span class="tag s-trial">' + esc(trialLabel()) + '</span>';
  }
  // [R4] 授权类型标签（永久/月卡/季卡/年卡/未授权）；试用由 trialBadgeTag 单独展示，此处不重复
  function planNameTag(pn, isTrial) {
    if (isTrial || !pn) return '';
    var cls = (pn === '未授权') ? 's-unknown' : 's-normal';
    return ' <span class="tag ' + cls + '">' + esc(pn) + '</span>';
  }

  // 指令状态文案由 cmdStatusMeta（renderCmdTimeline 内）统一提供，此处不重复定义。

  // 文本复制 / JSON 下载（指令结果查看）
  function copyText(txt) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt); return; } } catch (e) {}
    var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  function downloadJson(filename, txt) {
    var blob = new Blob([txt], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // T05④：下发成功后，在指令时间线顶部插入「跟踪中」行；
  // 既有 startDetailPoll 每 5s 拉取该客户端指令列表并整段重绘（即 CmdTracker 的等价实现），
  // 会在下一轮把「跟踪中」替换为真实状态（pending/sent/acked…），无需平行计时器。
  function insertTrackingRow(mid, commandId, action) {
    var box = $('cdCmdTl');
    if (!box) return;
    var row = document.createElement('div');
    row.className = 'cmd-tl-item tracking';
    row.setAttribute('data-cmdid', String(commandId));
    row.innerHTML = '<div class="cmd-tl-head">' +
      '<span class="act">' + esc(action) + '</span>' +
      '<span class="cmd-st pending">跟踪中…</span>' +
      '<span class="spacer"></span>' +
      '<span class="filter-tip">' + esc(commandId || '') + '</span></div>' +
      '<div class="cmd-tl-meta"><span>已下发，等待客户端回执</span></div>';
    box.insertBefore(row, box.firstChild);
    var cnt = $('cdCmdCount');
    if (cnt) cnt.textContent = (parseInt(cnt.textContent, 10) || 0) + 1;
  }



  // ---------------- FLEET：批量操作（T05⑧，并发上限 5，复用现有单机接口） ----------------
  // meta 内指令规格查找（action -> spec）
  function bulkSpecOf(action) {
    var cmds = (META && META.commands) ? META.commands : [];
    for (var i = 0; i < cmds.length; i++) if (cmds[i].action === action) return cmds[i];
    return null;
  }
  // 根据 payloadSchema 判断批量所需载荷形态
  function bulkPayloadKind(spec) {
    var schema = (spec && spec.payloadSchema) || {};
    var keys = Object.keys(schema);
    if (!keys.length) return 'none';
    for (var i = 0; i < keys.length; i++) {
      var f = schema[keys[i]];
      if (f.widget === 'printer') return 'printer';
      if (f.widget === 'kv') return 'config';
      if (keys[i] === 'text' || f.widget === 'textarea') return 'notice';
    }
    return 'none';
  }
  // 批量载荷收集弹窗的 HTML
  function bulkPromptHtml(kind) {
    if (kind === 'printer') {
      return '<p>批量禁用/启用打印机：请输入打印机名称（所有选中设备将应用同一名称）。</p>' +
        '<input id="bulkPVal" type="text" placeholder="打印机名称" style="width:100%" />';
    }
    if (kind === 'notice') {
      return '<p>批量推送通知：</p>' +
        '<textarea id="bulkPVal" rows="3" placeholder="通知内容（必填）" style="width:100%"></textarea>' +
        '<select id="bulkPVal2" style="width:100%;margin-top:8px"><option value="groups">推送目标：通知群</option><option value="admin">推送目标：超管私聊</option></select>';
    }
    if (kind === 'config') {
      // 白名单（来自 meta.configWhitelist，前端零硬编码）：当前为 printer.default
      var wl = (META && META.configWhitelist) || {};
      var rows = '';
      Object.keys(wl).forEach(function (top) {
        (wl[top] || []).forEach(function (nested) {
          rows += '<div style="margin:6px 0"><label>' + esc(top + '.' + nested) +
            '</label><input id="bulkCfg_' + esc(top) + '_' + esc(nested) + '" type="text" style="width:100%" placeholder="值" /></div>';
        });
      });
      return '<p>批量下发配置（仅白名单键生效）：</p>' + (rows || '<div class="filter-tip">无可用配置键</div>');
    }
    return '';
  }
  // 从弹窗读取并校验批量载荷；校验失败返回 false（toast 已在内部给出）
  function bulkReadPayload(kind) {
    if (kind === 'none') return {};
    if (kind === 'printer') {
      var pn = ($('bulkPVal') || {}).value;
      if (!pn || !pn.trim()) { toast('请填写打印机名称', 'warn'); return false; }
      return { printerName: pn.trim() };
    }
    if (kind === 'notice') {
      var tx = ($('bulkPVal') || {}).value;
      if (!tx || !tx.trim()) { toast('请填写通知内容', 'warn'); return false; }
      var tg = ($('bulkPVal2') || {}).value || 'groups';
      return { text: tx.trim(), target: tg };
    }
    if (kind === 'config') {
      var wl = (META && META.configWhitelist) || {};
      var config = {};
      var ok = true;
      Object.keys(wl).forEach(function (top) {
        config[top] = {};
        (wl[top] || []).forEach(function (nested) {
          var el = $('bulkCfg_' + top + '_' + nested);
          var v = el ? el.value.trim() : '';
          if (v) config[top][nested] = v;
        });
      });
      if (!Object.keys(config).length) { toast('请至少填写一个配置值', 'warn'); return false; }
      return { config: config };
    }
    return {};
  }

  // 集群表格 shift 连选（T05⑧ range select）
  function onClusterTableClick(e) {
    var box = e.target.closest ? e.target.closest('.ckbox') : null;
    if (!box) return;
    var mid = decodeURIComponent(box.dataset.mid);
    var idx = -1;
    for (var i = 0; i < CLUSTER_LIST.length; i++) if (CLUSTER_LIST[i].machineId === mid) { idx = i; break; }
    if (e.shiftKey && LAST_CK_IDX >= 0 && idx >= 0) {
      var lo = Math.min(LAST_CK_IDX, idx), hi = Math.max(LAST_CK_IDX, idx);
      var setVal = box.checked;
      for (var j = lo; j <= hi; j++) {
        var m = CLUSTER_LIST[j].machineId;
        if (setVal) SEL_MIDS[m] = true; else delete SEL_MIDS[m];
        var cb = document.querySelector('.ckbox[data-mid="' + enc(m) + '"]');
        if (cb) cb.checked = setVal;
      }
      syncBulkBar();
    }
    LAST_CK_IDX = idx;
  }
  // 异常状态徽标：metaStatus('anomalyStatus', st)（META 下发 → I18N 兜底 → 原样 key），
  // 组件内不再持有中文 map（设计 §9.3.2），未知值亦不回退英文。
  function anomalyStatusBadge(st) {
    var m = metaStatus('anomalyStatus', st);
    return '<span class="dot ' + esc(m.badge) + '"></span><span class="st-' + esc(m.badge) + '">' + esc(m.label) + '</span>';
  }
  // 5 条异常规则的中文说明（用于规则卡片展示）
  var RULE_DESC = {
    code_shared: '同一授权码在 ≥N 台不同机器上活跃（疑似共享/盗用）',
    expired_online: '授权已过期但客户端仍在活跃心跳',
    machine_mismatch: '心跳机器码与授权绑定的机器码不符',
    long_offline: '超过离线阈值（默认 7 天）未上报',
    freq_anomaly: '心跳频率异常（过密或过疏，疑似脚本/异常）',
  };

  // ---------------- FLEET：集群 ----------------
  // 拉取 /fleet/meta（R0，无需特殊权限），缓存到模块级 META，供徽标/阈值/指令分组驱动
  async function ensureMeta() {
    if (META && (Date.now() - META_LOAD_AT) < 60000) return META;
    if (META_LOADING) return META;
    META_LOADING = true;
    try {
      var d = await api('GET', '/api/admin/fleet/meta');
      if (d && d.ok) { META = d; META_LOAD_AT = Date.now(); }
    } catch (e) { /* meta 拉取失败不阻塞列表，徽标降级为兜底文案 */ }
    finally { META_LOADING = false; }
    return META;
  }

  // 顶部红条：轮询/拉取失败提示（不清空表格，数据保留）
  function clusterError(msg) {
    var bar = $('clusterErr');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'clusterErr';
      bar.className = 'err-bar';
      var tb = $('view-cluster').querySelector('.table-wrap');
      tb.parentNode.insertBefore(bar, tb);
    }
    bar.textContent = '⚠ ' + (msg || '数据刷新失败，当前显示上次结果');
    bar.style.display = '';
    setTimeout(function () { if (bar) bar.style.display = 'none'; }, 4000);
  }

  // 复选态变化 → 更新批量条
  function syncBulkBar() {
    var n = Object.keys(SEL_MIDS).filter(function (k) { return SEL_MIDS[k]; }).length;
    $('bulkN').textContent = n;
    $('clusterBulk').classList.toggle('hidden', n === 0);
  }

  // 批量动作下拉（由 /fleet/meta 驱动，按分组组织）
  function fillBulkAct() {
    var sel = $('bulkAct');
    if (!sel) return;
    var cmds = ((META && META.commands) || []).filter(bulkAllowed);
    var groups = (META && META.groups) ? META.groups.slice() : [];
    var byGroup = {};
    cmds.forEach(function (c) {
      var g = c.group || '其他';
      byGroup[g] = byGroup[g] || [];
      byGroup[g].push(c);
    });
    Object.keys(byGroup).forEach(function (g) { if (groups.indexOf(g) < 0) groups.push(g); });
    var cur = sel.value;
    sel.innerHTML = groups.map(function (g) {
      var items = byGroup[g] || [];
      if (!items.length) return '';
      return '<optgroup label="' + esc(g) + '">' + items.map(function (c) {
        return '<option value="' + esc(c.action) + '"' + (c.action === cur ? ' selected' : '') + '>' +
          esc(c.label || c.action) + (c.dangerous ? ' ⚠' : '') + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    syncBulkPayload();
  }

  /**
   * 批量场景排除「必须逐台指定打印机」的指令：各设备打印机名不同，
   * 用同一个名字群发要么全部失败、要么误伤同名设备，没有安全的批量语义。
   * @param {object} c 指令契约
   * @returns {boolean} 是否允许批量下发
   */
  function bulkAllowed(c) {
    return !schemaNeedsPrinter(c);
  }

  // 批量输入框只暴露首个可填字段：批量场景保持极简，复杂载荷请走单机指令面板
  function bulkPrimaryField(spec) {
    var schema = (spec && spec.payloadSchema) || {};
    var keys = Object.keys(schema);
    return keys.length ? { key: keys[0], def: schema[keys[0]] } : null;
  }
  function syncBulkPayload() {
    var inp = $('bulkPayload');
    if (!inp) return;
    var f = bulkPrimaryField(specOfAction($('bulkAct').value));
    if (!f) { inp.style.display = 'none'; inp.value = ''; return; }
    inp.style.display = '';
    inp.placeholder = (f.def.label || f.key) + (f.def.required ? '（必填）' : '（可选）');
  }

  /**
   * 批量下发：按服务端下发的并发上限分批推进，单台失败不影响其余台，
   * 结束后汇总「成功 N / 失败 M」并列出失败明细，便于定点重试。
   * @param {Array<string>} targets 目标机器码
   * @param {string} action 指令
   * @param {object} payload 载荷
   * @param {string} label 指令中文名
   * @param {string} confirmWord 二次确认词（无则空串）
   */
  async function runBatch(targets, action, payload, label, confirmWord) {
    closeModal();
    var conc = Math.max(1, metaLimitOf('batchConcurrency', 5));
    var btn = $('bulkSend');
    var prog = $('bulkProgress');
    var done = 0;
    var okN = 0;
    var fails = [];
    btn.disabled = true;
    function tick() {
      prog.textContent = '进度 ' + done + '/' + targets.length +
        '（成功 ' + okN + '，失败 ' + fails.length + '）';
    }
    tick();
    var idx = 0;
    async function worker() {
      while (idx < targets.length) {
        var mid = targets[idx++];
        var body = { action: action, payload: payload };
        if (confirmWord) body.confirm = confirmWord;
        try {
          await api('POST', '/api/admin/fleet/clients/' + enc(mid) + '/command', body);
          okN++;
        } catch (e) {
          fails.push(mid + '：' + e.message);
        }
        done++;
        tick();
      }
    }
    var pool = [];
    for (var i = 0; i < Math.min(conc, targets.length); i++) pool.push(worker());
    await Promise.all(pool);
    btn.disabled = false;
    if (fails.length) {
      toast('批量下发完成：成功 ' + okN + '，失败 ' + fails.length, 'warn');
      openModal('批量下发结果',
        '<p>「' + esc(label) + '」成功 <b>' + okN + '</b> 台，失败 <b>' + fails.length + '</b> 台。</p>' +
        '<div class="cmd-tl-res">' + esc(fails.join('\n')) + '</div>',
        [{ label: '知道了', cls: '', onClick: closeModal }]);
    } else {
      toast('批量下发完成：' + okN + ' 台已受理', 'ok');
    }
    renderCluster();
  }

  // 批量下发入口：读取勾选设备 + 载荷校验 + 危险指令二次确认
  function doBulkSend() {
    var targets = Object.keys(SEL_MIDS).filter(function (k) { return SEL_MIDS[k]; });
    if (!targets.length) { toast('请先勾选设备', 'warn'); return; }
    var action = $('bulkAct').value;
    var spec = specOfAction(action);
    var label = spec.label || action;
    if (!requireWrite('批量下发「' + label + '」')) return;

    var payload = {};
    var f = bulkPrimaryField(spec);
    if (f) {
      var raw = ($('bulkPayload').value || '').trim();
      if (!raw && f.def.required) { toast('请填写' + (f.def.label || f.key), 'warn'); return; }
      if (raw) {
        if (f.def.type === 'object') {
          try { payload[f.key] = JSON.parse(raw); }
          catch (e) { toast((f.def.label || f.key) + ' 需为合法 JSON', 'warn'); return; }
        } else {
          if (f.def.maxLen && raw.length > f.def.maxLen) {
            toast((f.def.label || f.key) + ' 超长（最多 ' + f.def.maxLen + ' 字）', 'warn'); return;
          }
          payload[f.key] = raw;
        }
      }
    }

    if (spec.dangerous) {
      confirmDangerous(spec, '<b>' + targets.length + '</b> 台设备', function (word) {
        runBatch(targets, action, payload, label, word);
      });
    } else {
      openModal('确认批量下发',
        '<p>将对 <b>' + targets.length + '</b> 台设备下发「' + esc(label) + '」。</p>', [
        { label: '取消', cls: 'ghost', onClick: closeModal },
        { label: '确认下发', cls: '', onClick: function () { runBatch(targets, action, payload, label, ''); } },
      ]);
    }
  }

  // ---------------- 统一管理（集群集中化）----------------
  /**
   * 统一管理面板：把原本分散在「进程管理 / 打印与 CUPS / 设备管理」的能力收拢到集群页，
   * 对已勾选设备一次性下发 —— 免去多视图来回跳转（需求：集群内统一设备管理）。
   * 所有动作仍走同一契约通道 POST /clients/:mid/command，危险项复用 confirmDangerous 强确认，
   * 不新增任何绕过服务端门禁的路径。
   */
  var UMGR_PROCS = ['sea2-bot', 'sea2-print-server', 'sea2-qr', 'sea2-napcat',
    'sea2-napcat-backup', 'sea2-watchdog', 'sea1-client', 'sea1-bot'];

  function openUnifiedMgr() {
    var targets = Object.keys(SEL_MIDS).filter(function (k) { return SEL_MIDS[k]; });
    if (!targets.length) { toast('请先勾选设备', 'warn'); return; }
    if (!requireWrite('统一管理 ' + targets.length + ' 台设备')) return;

    var sec = 'style="border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:10px 12px;margin:10px 0"';
    var h4 = 'style="margin:0 0 8px;font-size:14px"';
    var h = '<p>将对已勾选的 <b>' + targets.length + '</b> 台设备执行操作（进度与结果见批量弹窗）。</p>';

    h += '<div ' + sec + '><h4 ' + h4 + '>① 进程</h4>' +
      '<select id="umgrProc" style="max-width:200px">' + UMGR_PROCS.map(function (p) {
        return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
      }).join('') + '</select> ' +
      [['pm2_list', '列表'], ['pm2_restart', '重启'], ['pm2_stop', '停止'], ['pm2_start', '启动'], ['pm2_logs', '最近100行日志']]
        .map(function (a) { return '<button class="btn ghost sm" data-um="' + a[0] + '">' + a[1] + '</button> '; }).join('') +
      '<div class="filter-tip">列表 / 日志为回执型指令，结果在设备详情「指令历史」中展开查看。</div></div>';

    h += '<div ' + sec + '><h4 ' + h4 + '>② 打印</h4>' +
      '<input id="umgrPrinter" type="text" placeholder="打印机队列名（如 HP_LaserJet_P2015_Series）" style="max-width:300px" /> ' +
      [['enable_printer', '启用'], ['disable_printer', '停用'], ['printer_default', '设为默认'],
        ['clear_print_queue', '清空队列'], ['cups_info', 'CUPS 状态']]
        .map(function (a) { return '<button class="btn ghost sm" data-um="' + a[0] + '">' + a[1] + '</button> '; }).join('') +
      '<div class="filter-tip">「设为默认」经下发配置 printer.default 生效（仅白名单键会被客户端接受）。</div></div>';

    h += '<div ' + sec + '><h4 ' + h4 + '>③ 服务与下发</h4>' +
      '<input id="umgrNotice" type="text" placeholder="通知内容（≤500 字，推送到通知群）" style="max-width:320px" /> ' +
      [['push_notice', '推送通知'], ['health_check', '健康检查'], ['enable_client', '启用客户端']]
        .map(function (a) { return '<button class="btn ghost sm" data-um="' + a[0] + '">' + a[1] + '</button> '; }).join('') + '</div>';

    openModal('统一管理（' + targets.length + ' 台设备）', h,
      [{ label: '关闭', cls: 'ghost', onClick: closeModal }]);

    $('modalBody').querySelectorAll('[data-um]').forEach(function (b) {
      b.addEventListener('click', function () { unifiedAction(b.dataset.um, targets); });
    });
  }

  /** 单个统一管理动作 → 组装契约载荷 → 走既有 runBatch（危险项自动二次确认） */
  function unifiedAction(kind, targets) {
    var proc = $('umgrProc') ? $('umgrProc').value : '';
    var pname = $('umgrPrinter') ? ($('umgrPrinter').value || '').trim() : '';
    var notice = $('umgrNotice') ? ($('umgrNotice').value || '').trim() : '';
    var action;
    var payload = {};

    switch (kind) {
      case 'pm2_list': action = 'pm2_list'; break;
      case 'pm2_restart': case 'pm2_stop': case 'pm2_start':
        action = kind; payload = { processName: proc }; break;
      case 'pm2_logs': action = 'pm2_logs'; payload = { processName: proc, lines: 100 }; break;
      case 'enable_printer': case 'disable_printer':
        action = kind; payload = { printerName: pname }; break;
      case 'printer_default':
        action = 'push_config'; payload = { config: { printer: { default: pname } } }; break;
      case 'clear_print_queue': action = 'clear_print_queue'; break;
      case 'cups_info': action = 'cups_info'; break;
      case 'push_notice':
        action = 'push_notice'; payload = { text: notice, target: 'groups' }; break;
      case 'health_check': action = 'health_check'; break;
      case 'enable_client': action = 'enable_client'; break;
      default: toast('未知操作', 'warn'); return;
    }

    if ((kind === 'enable_printer' || kind === 'disable_printer' || kind === 'printer_default')) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(pname)) {
        toast('打印机队列名只允许字母、数字、点、下划线、连字符', 'warn'); return;
      }
    }
    if (kind === 'push_notice' && !notice) { toast('请填写通知内容', 'warn'); return; }
    if (kind === 'push_notice' && notice.length > 500) { toast('通知内容超长（最多 500 字）', 'warn'); return; }

    var sp = specOfAction(action);
    var label = (sp && sp.label) || action;
    var note = (kind === 'printer_default') ? '（默认打印机改为 ' + pname + '）' : '';
    if (sp && sp.dangerous) {
      confirmDangerous(sp, '<b>' + targets.length + '</b> 台设备' + esc(note), function (word) {
        runBatch(targets, action, payload, label, word);
      });
      return;
    }
    runBatch(targets, action, payload, label, '');
  }

  // 分布条点击：写入对应维度筛选并重渲染（再次点击同一项 = 取消该筛选）
  function distPick(kind, key) {
    // 「其他」「未知」是聚合桶而非真实取值，不能拿去当筛选条件
    if (!key || key === '其他' || key === '未知') return;
    var sel = kind === 'version' ? $('clusterVersion') : $('clusterRegion');
    if (!sel) return;
    sel.value = (sel.value === key) ? '' : key;
    renderCluster();
  }

  // 版本 / 地域下拉：用服务端聚合分布填充
  function fillDimSelect(sel, allLabel, keys) {
    if (!sel) return;
    var cur = sel.value;
    var seen = {};
    var list = [];
    // 当前选中项即使不在本次结果里也必须保留，否则筛选后下拉会自己弹回「全部」
    keys.concat(cur ? [cur] : []).forEach(function (k) {
      if (!k || k === '其他' || seen[k]) return;
      seen[k] = 1;
      list.push(k);
    });
    list.sort();
    sel.innerHTML = '<option value="">' + esc(allLabel) + '</option>' + list.map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(k) + '</option>';
    }).join('');
  }
  function fillDimFilters(agg) {
    fillDimSelect($('clusterVersion'), '全部版本', (agg.byVersion || []).map(function (p) { return p.key; }));
    fillDimSelect($('clusterRegion'), '全部地域', (agg.byRegion || []).map(function (p) { return p.key; }));
  }

  // CPU / 内存占用条：阈值来自服务端（fleetCpuWarn / fleetMemWarn），超阈值转红、逼近阈值转橙
  function usageCell(pct, warn) {
    if (pct == null || pct === '' || isNaN(Number(pct))) {
      return '<span class="usage"><span class="usage-num">—</span></span>';
    }
    var v = Math.max(0, Math.min(100, Math.round(Number(pct))));
    var cls = v >= warn ? ' bad' : (v >= warn * 0.8 ? ' warn' : '');
    return '<span class="usage' + cls + '" title="' + v + '%（告警阈值 ' + warn + '%）">' +
      '<span class="usage-bar"><i style="width:' + v + '%"></i></span>' +
      '<span class="usage-num">' + v + '%</span></span>';
  }

  // 集群列表拉取：筛选条件集中在此，主渲染与静默刷新共用同一套参数
  function fetchClusterData() {
    var qs = [];
    var q = ($('clusterQ').value || '').trim(); if (q) qs.push('q=' + enc(q));
    var conn = $('clusterConn').value; if (conn) qs.push('connectivity=' + enc(conn));
    var lic = $('clusterLicense').value; if (lic) qs.push('licenseState=' + enc(lic));
    var ver = $('clusterVersion').value; if (ver) qs.push('version=' + enc(ver));
    var rg = $('clusterRegion').value; if (rg) qs.push('region=' + enc(rg));
    qs.push('pageSize=500');
    return api('GET', '/api/admin/fleet/clients?' + qs.join('&'));
  }

  // 聚合卡片：连接性四态 + 异常 + 总计；在线卡下挂「其中 N 台授权异常」（连接性与授权态正交）
  // 连接四态文案/配色来自 META.connectivity（前端零硬编码），未加载降级写死四态
  function renderClusterAgg(agg) {
    var cards = [
      { label: metaConnLabel('online'), val: agg.online || 0, dot: metaConnBadge('online'), sub: agg.online ? ('其中 ' + (agg.onlineLicenseBad || 0) + ' 台授权异常') : '' },
      { label: metaConnLabel('stale'), val: agg.stale || 0, dot: metaConnBadge('stale'), sub: '' },
      { label: metaConnLabel('offline'), val: agg.offline || 0, dot: metaConnBadge('offline'), sub: '' },
      { label: metaConnLabel('unreported'), val: agg.unreported || 0, dot: metaConnBadge('unreported'), sub: '' },
      { label: trialLabel(), val: agg.trial || 0, dot: 'trial', sub: agg.trial ? (agg.trial + ' 台试用设备') : '' },
      { label: '异常', val: agg.abnormal || 0, dot: 'abnormal', sub: agg.blacklisted ? ('已拉黑 ' + agg.blacklisted + ' 台') : '' },
      { label: '总计', val: agg.total || 0, dot: 'normal', sub: '' },
    ];
    $('clusterAgg').innerHTML = cards.map(function (c) {
      return '<div class="card" style="padding:14px 18px"><h3><span class="dot ' + c.dot + '"></span>' + esc(c.label) + '</h3>' +
        '<div style="font-size:26px;font-weight:700">' + c.val + '</div>' +
        (c.sub ? '<div class="filter-tip" style="margin-top:4px">' + esc(c.sub) + '</div>' : '') + '</div>';
    }).join('');
  }

  // 版本 / 地域分布条
  function renderClusterDist(agg) {
    $('clusterDist').innerHTML = buildDistCard('版本分布', 'version', agg.byVersion) +
      buildDistCard('地域分布', 'region', agg.byRegion);
  }

  // 机器码折叠单元格（T02 需求3）：长度 >16 时显示 前8…后4，附复制按钮（复制完整机器码）
  // 复制复用 copyText（navigator.clipboard 优先、textarea execCommand 兜底）+ toast 提示
  function midFoldCell(mid) {
    var safe = esc(mid);
    var folded = mid && mid.length > 16 ? esc(mid.slice(0, 8)) + '…' + esc(mid.slice(-4)) : safe;
    return '<span class="mid-fold" title="' + safe + '">' + folded + '</span>' +
      '<button class="btn ghost sm mid-copy" data-copy-mid="' + safe + '" title="复制机器码">⧉</button>';
  }

  // 单行 HTML：主渲染与静默刷新共用，避免两份实现随时间漂移
  function clusterRowHtml(x, cpuWarn, memWarn) {
    var checked = SEL_MIDS[x.machineId] ? ' checked' : '';
    var dimCls = (x.connectivity === 'offline' || x.connectivity === 'stale') ? 'row-dim' : '';
    var pending = x.pendingCount > 0 ? ('<span class="cmd-badge blue">' + x.pendingCount + '</span>') : '0';
    var sent = x.sentCount > 0 ? ('<span class="cmd-badge yellow">' + x.sentCount + '</span>') : '';
    // 列序与 renderCluster() thead 严格一致（T02 需求3）：QQ/连接/授权/版本/最近心跳/机器码/授权码/CPU/内存/地域/待执行/操作
    return '<tr class="' + dimCls + '">' +
      '<td class="ck"><input type="checkbox" class="ckbox" data-mid="' + esc(x.machineId) + '"' + checked + ' /></td>' +
      '<td>' + esc(x.qq || '—') + '</td>' +
      '<td>' + connBadge(x.connectivity) + (x.blacklisted ? ' <span class="tag s-revoked">拉黑</span>' : '') + '</td>' +
      '<td>' + licenseBadge(x.licenseState, x.reason) + (x.isTrial ? ' ' + trialBadgeTag() : '') + planNameTag(x.planName, x.isTrial) + '</td>' +
      '<td>' + esc(x.version || '—') + '</td>' +
      '<td title="' + esc(x.lastHeartbeatAt ? fmtTime(x.lastHeartbeatAt) : '从未上报') + '">' + relTime(x.lastHeartbeatAt) + '</td>' +
      '<td>' + midFoldCell(x.machineId) + '</td>' +
      '<td>' + esc(x.code || '—') + '</td>' +
      '<td>' + usageCell(x.cpuUsage, cpuWarn) + '</td>' +
      '<td>' + usageCell(x.memUsage, memWarn) + '</td>' +
      '<td>' + esc(x.region || '—') + '</td>' +
      '<td>' + pending + ' ' + sent + '</td>' +
      '<td class="row-actions">' +
      '<button class="btn ghost sm" data-cd="detail" data-mid="' + esc(x.machineId) + '">详情</button>' +
      '<button class="btn ghost sm" data-cd="disable_client" data-mid="' + esc(x.machineId) + '">禁用</button>' +
      '<button class="btn danger sm" data-cd="restart_client" data-mid="' + esc(x.machineId) + '">重启</button></td></tr>';
  }

  // 行内事件绑定：innerHTML 重写会清掉旧监听，两条刷新路径都必须重绑，否则按钮会静默失效
  function bindClusterRows(t, list) {
    t.querySelectorAll('.ckbox').forEach(function (b) {
      b.addEventListener('change', function () {
        if (b.checked) SEL_MIDS[b.dataset.mid] = true;
        else delete SEL_MIDS[b.dataset.mid];
        syncBulkBar();
      });
    });
    t.querySelectorAll('[data-cd]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mid = b.dataset.mid;
        if (b.dataset.cd === 'detail') openClientDetail(mid);
        else quickClientAction(mid, b.dataset.cd);
      });
    });
    // T02 需求3：机器码复制按钮（复制完整机器码 + toast）
    t.querySelectorAll('.mid-copy').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var mid = b.getAttribute('data-copy-mid') || '';
        if (!mid) return;
        copyText(mid);
        toast(i18n('cluster', 'copied', '已复制'), 'ok');
      });
    });
    var all = $('clusterCkAll');
    if (all) {
      all.checked = list.length > 0 && list.every(function (x) { return SEL_MIDS[x.machineId]; });
      all.onchange = function () {
        list.forEach(function (x) {
          if (all.checked) SEL_MIDS[x.machineId] = true; else delete SEL_MIDS[x.machineId];
        });
        t.querySelectorAll('.ckbox').forEach(function (cb) { cb.checked = all.checked; });
        syncBulkBar();
      };
    }
  }

  // 一次性重绘：聚合 + 分布 + 维度下拉 + 表格体 + 事件绑定
  function paintCluster(d) {
    var t = $('clusterTable');
    var agg = d.agg || {};
    var list = d.items || [];
    CLUSTER_LIST = list; // shift 连选用：记录当前渲染列表顺序
    var cpuWarn = (META && META.thresholds && META.thresholds.cpuWarn) || 85;
    var memWarn = (META && META.thresholds && META.thresholds.memWarn) || 85;
    renderClusterAgg(agg);
    renderClusterDist(agg);
    fillDimFilters(agg);
    if (!list.length) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="' + CLUSTER_COLS + '" class="loading">暂无客户端</td></tr>';
    } else {
      t.querySelector('tbody').innerHTML = list.map(function (x) {
        return clusterRowHtml(x, cpuWarn, memWarn);
      }).join('');
      bindClusterRows(t, list);
    }
    CLUSTER_LAST_OK = Date.now();
    var upd = $('clusterUpdated');
    if (upd) { upd.textContent = '最后更新 ' + relTime(Math.floor(CLUSTER_LAST_OK / 1000)); upd.classList.remove('spin'); }
    syncBulkBar();
  }

  async function renderCluster() {
    var t = $('clusterTable');
    // T02 需求3：新列序 = QQ/连接/授权/版本/最近心跳/机器码(折叠+复制)/授权码/CPU/内存/地域/待执行/操作（保留末尾两列）
    // 表头文案走 console.i18n.js 字典（col* 词条，T04 已补全），状态列（连接/授权）仍由 meta 驱动
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th class="ck"><input type="checkbox" id="clusterCkAll" title="全选当前筛选结果" /></th>' +
      '<th>' + i18n('cluster', 'colQq', 'QQ') + '</th>' +
      '<th>' + i18n('cluster', 'colConn', '连接') + '</th>' +
      '<th>' + i18n('cluster', 'colLicense', '授权') + '</th>' +
      '<th>' + i18n('cluster', 'colVersion', '版本') + '</th>' +
      '<th>' + i18n('cluster', 'colHb', '最近心跳') + '</th>' +
      '<th>' + i18n('cluster', 'colMachine', '机器码') + '</th>' +
      '<th>' + i18n('cluster', 'colCode', '授权码') + '</th>' +
      '<th>' + i18n('cluster', 'colCpu', 'CPU') + '</th>' +
      '<th>' + i18n('cluster', 'colMem', '内存') + '</th>' +
      '<th>' + i18n('cluster', 'colRegion', '地域') + '</th>' +
      '<th>' + i18n('cluster', 'colPending', '待执行') + '</th>' +
      '<th>' + i18n('common', 'actions', '操作') + '</th></tr>';
    // 仅首屏显示骨架：手动刷新时保留旧数据，避免整表闪一下
    if (!CLUSTER_LAST_OK) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="' + CLUSTER_COLS + '" class="loading">加载中…</td></tr>';
    }
    try {
      await ensureMeta();
      buildClusterFilters();
      paintCluster(await fetchClusterData());
      startClusterAuto();
    } catch (e) {
      clusterError(e.message);
      var upd = $('clusterUpdated');
      if (upd) { upd.textContent = '刷新失败，显示上次结果'; upd.classList.remove('spin'); }
      // 从没成功过才把错误写进表格；否则保留上次结果，别让一次抖动清空运维视野
      if (!CLUSTER_LAST_OK) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="' + CLUSTER_COLS +
          '" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
      }
    }
  }

  // 分布卡片（Top5 + 占比）
  function buildDistCard(title, kind, dist) {
    if (!dist || !dist.length) return '';
    var rows = dist.slice(0, 5).map(function (p) {
      return '<div class="dist-line" data-kind="' + kind + '" data-key="' + enc(p.key) + '" title="点击筛选：' + esc(p.key) + '">' +
        '<span class="dist-key">' + esc(p.key) + '</span>' +
        '<span class="dist-track"><i style="width:' + Math.min(100, p.pct || 0) + '%"></i></span>' +
        '<span class="dist-val">' + p.count + ' · ' + (p.pct || 0) + '%</span></div>';
    }).join('');
    return '<div class="dist-card"><div class="dist-title">' + esc(title) + '</div>' + rows + '</div>';
  }

  // 用 meta 填充连接性 / 授权态 两个正交下拉（前端零硬编码）+ 批量动作下拉
  function buildClusterFilters() {
    var conn = $('clusterConn');
    var lic = $('clusterLicense');
    if (META && META.connectivity) {
      var curC = conn.value;
      conn.innerHTML = '<option value="">全部连接性</option>' + META.connectivity.map(function (c) {
        return '<option value="' + esc(c.key) + '"' + (c.key === curC ? ' selected' : '') + '>' + esc(c.label) + '</option>';
      }).join('');
    }
    if (META && META.licenseStates) {
      var curL = lic.value;
      // licenseStates 由服务端下发为 {key,label,badge}，中文与配色都不在前端维护
      lic.innerHTML = '<option value="">全部授权态</option>' + META.licenseStates.map(function (s) {
        return '<option value="' + esc(s.key) + '"' + (s.key === curL ? ' selected' : '') + '>' + esc(s.label) + '</option>';
      }).join('');
    }
    fillBulkAct();
  }

  // 自动刷新控制器：间隔由工具栏下拉决定（0 = 关闭），localStorage 持久化
  function clusterAutoMs() {
    var sel = $('clusterAuto');
    var sec = sel ? parseInt(sel.value, 10) : 0;
    return (isNaN(sec) || sec <= 0) ? 0 : sec * 1000;
  }
  function stopClusterAuto() {
    if (AUTO_TIMER) { clearInterval(AUTO_TIMER); AUTO_TIMER = null; }
  }
  function startClusterAuto() {
    stopClusterAuto();
    var ms = clusterAutoMs();
    if (!ms) return;
    AUTO_TIMER = setInterval(function () {
      // 四个前置条件缺一不可：停留在集群视图、页面可见、无在途请求、无弹窗。
      // 后台标签页刷新纯属浪费带宽；弹窗期间刷新会打断正在进行的确认操作。
      if (currentView !== 'cluster' || document.visibilityState !== 'visible') return;
      if (AUTO_INFLIGHT) return;
      if (!$('modalMask').classList.contains('hidden')) return;
      renderClusterSilent();
    }, ms);
  }

  // 静默刷新：复用同一套筛选参数与渲染函数，不清空表格、不打断详情抽屉
  async function renderClusterSilent() {
    AUTO_INFLIGHT = true;
    var upd = $('clusterUpdated');
    if (upd) { upd.textContent = '刷新中…'; upd.classList.add('spin'); }
    try {
      paintCluster(await fetchClusterData());
    } catch (e) {
      clusterError(e.message);
      if (upd) { upd.textContent = '刷新失败，显示上次结果'; upd.classList.remove('spin'); }
    } finally {
      AUTO_INFLIGHT = false;
    }
  }

  // action -> 指令契约。未命中时给一个保守兜底：按危险处理，强制走二次确认
  function specOfAction(action) {
    var cmds = (META && META.commands) || [];
    for (var i = 0; i < cmds.length; i++) { if (cmds[i].action === action) return cmds[i]; }
    return { action: action, label: action, dangerous: true, confirmWord: null, payloadSchema: {} };
  }

  /**
   * 危险指令二次确认弹窗。带 confirmWord 的指令（如 disable_client 需输入 DISABLE）
   * 必须逐字输入确认词才放行。服务端同样校验、且校验前置于任何副作用，
   * 这一层只是防手滑，不是安全边界。
   * @param {object} spec /fleet/meta 下发的指令契约
   * @param {string} targetHtml 目标描述（HTML 片段，调用方负责转义）
   * @param {function(string):void} onOk 确认回调，入参为确认词（无确认词时为空串）
   */
  function confirmDangerous(spec, targetHtml, onOk) {
    var needWord = !!spec.confirmWord;
    var html = '<p>将对 ' + targetHtml + ' 下发危险指令 <b>' + esc(spec.label || spec.action) + '</b>。</p>' +
      (spec.desc ? '<p class="cmd-hint">' + esc(spec.desc) + '</p>' : '') +
      (needWord
        ? '<p class="cmd-hint danger">此操作不可自动撤销。请输入 <b>' + esc(spec.confirmWord) + '</b> 确认：</p>' +
          '<input id="cfmWord" class="confirm-input" type="text" autocomplete="off" placeholder="' + esc(spec.confirmWord) + '" />'
        : '<p class="cmd-hint danger">该操作会中断设备上的业务，请确认影响范围。</p>');
    openModal('确认下发危险指令', html, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认下发', cls: 'danger', onClick: function () {
        var word = '';
        if (needWord) {
          var el = $('cfmWord');
          word = ((el && el.value) || '').trim();
          if (word !== spec.confirmWord) { toast('确认词不正确，请输入 ' + spec.confirmWord, 'warn'); return; }
        }
        onOk(word);
      } },
    ]);
    if (needWord && $('cfmWord')) $('cfmWord').focus();
  }

  // 行内快捷操作：文案 / 危险性 / 确认词全部取自 meta，前端不再判断具体是哪条指令
  function quickClientAction(mid, action) {
    var spec = specOfAction(action);
    var label = spec.label || action;
    if (!requireWrite('下发「' + label + '」')) return;
    if (!spec.dangerous) {
      issueFleetCommand(mid, action, {}, null, label, 'cluster');
      return;
    }
    confirmDangerous(spec, '客户端 <b>' + esc(mid) + '</b>', function (word) {
      issueFleetCommand(mid, action, {}, word || null, label, 'cluster');
    });
  }

  // ---------------- FLEET：客户端详情 ----------------
  // 详情抽屉打开期间轮询指令区：下发后无需手动刷新即可看到 sent → acked 的流转
  var DETAIL_POLL_MS = 5000;

  function openClientDetail(mid) {
    DETAIL_MID = mid;
    $('clientModalMask').classList.remove('hidden');
    renderClientDetail(mid);
    startDetailPoll();
  }
  function closeClientModal() {
    stopDetailPoll();
    DETAIL_MID = '';
    $('clientModalMask').classList.add('hidden');
  }
  function stopDetailPoll() {
    if (DETAIL_TIMER) { clearInterval(DETAIL_TIMER); DETAIL_TIMER = null; }
  }
  function startDetailPoll() {
    stopDetailPoll();
    DETAIL_TIMER = setInterval(function () {
      if (!DETAIL_MID || $('clientModalMask').classList.contains('hidden')) { stopDetailPoll(); return; }
      if (document.visibilityState !== 'visible') return;
      // 二次确认弹窗打开时不刷新：避免把用户正在填的确认词连同 DOM 一起换掉
      if (!$('modalMask').classList.contains('hidden')) return;
      refreshDetailCommands(DETAIL_MID);
    }, DETAIL_POLL_MS);
  }

  /**
   * 只重绘指令时间线，不动整个抽屉。
   * 整屏重绘会把用户正在填写的指令面板（选中的指令、已输入的载荷）冲掉。
   * @param {string} mid 机器码
   */
  async function refreshDetailCommands(mid) {
    try {
      var d = await api('GET', '/api/admin/fleet/clients/' + enc(mid));
      // 轮询回来时用户可能已经切到别的设备，丢弃过期响应
      if (DETAIL_MID !== mid) return;
      var box = $('cdCmdTl');
      if (!box) return;
      var cmds = d.commands || [];
      box.innerHTML = renderCmdTimeline(cmds);
      bindResToggles(box);
      var n = $('cdCmdCount');
      if (n) n.textContent = cmds.length;
    } catch (e) {
      // 轮询失败静默等下一轮：详情页已有内容，不该因一次抖动报错打断操作
    }
  }

  /**
   * 指令时间线：六态徽标 + 结果体 + 截断标 + 迟到回执标。
   * 服务端 commands 已是「最新在前」，此处不再反转。
   * @param {Array<object>} cmds 指令记录
   * @returns {string} HTML
   */
  function renderCmdTimeline(cmds) {
    if (!cmds || !cmds.length) return '<div class="filter-tip">暂无指令记录</div>';
    return cmds.map(function (c, i) {
      var spec = specOfAction(c.action);
      var stMeta = cmdStatusMeta(c.status);
      var resText = c.result == null ? ''
        : (typeof c.result === 'string' ? c.result : JSON.stringify(c.result, null, 2));
      var rid = 'cdres' + i;
      var metaBits = ['下发 ' + fmtTime(c.issuedAt)];
      if (c.sentAt) metaBits.push('送达 ' + fmtTime(c.sentAt));
      if (c.ackedAt) metaBits.push('回执 ' + fmtTime(c.ackedAt));
      if (c.operator) metaBits.push('操作人 ' + c.operator);
      if (c.resultBytes) metaBits.push('结果 ' + fmtBytes(c.resultBytes));
      return '<div class="cmd-tl-item">' +
        '<div class="cmd-tl-head">' +
          '<span class="act">' + esc(spec.label || c.action) + '</span>' +
          '<span class="cmd-st ' + esc(stMeta.badge) + '">' + esc(stMeta.label) + '</span>' +
          (c.dangerous ? '<span class="tag-trunc">危险</span>' : '') +
          (c.lateAck ? '<span class="tag-late">迟到回执</span>' : '') +
          (c.resultTruncated ? '<span class="tag-trunc">结果已截断</span>' : '') +
          (c.resultEvicted ? '<span class="tag-late">结果已清理</span>' : '') +
          '<span class="spacer"></span>' +
          '<span class="filter-tip">' + esc(c.id || '') + '</span>' +
        '</div>' +
        '<div class="cmd-tl-meta">' + metaBits.map(function (m) {
          return '<span>' + esc(m) + '</span>';
        }).join('') + '</div>' +
        (c.error ? '<div class="cmd-tl-err">✕ ' + esc(c.error) + '</div>' : '') +
        (resText
          ? '<div class="cmd-tl-res clip" id="' + rid + '">' + esc(resText) + '</div>' +
            '<div class="res-actions">' +
            '<button class="res-toggle" data-res="' + rid + '">展开结果</button>' +
            '<button class="btn ghost sm" data-copy="' + rid + '">复制</button>' +
            '<button class="btn ghost sm" data-dl="' + rid + '">下载 JSON</button>' +
            '</div>'
          : '') +
        '</div>';
    }).join('');
  }

  // 指令状态 -> 徽标语义（同样来自 /fleet/meta.commandStatus）
  function cmdStatusMeta(status) {
    var arr = (META && META.commandStatus) || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].key === status) return arr[i];
    }
    return { key: status, label: String(status || '未知'), badge: 'unknown' };
  }

  function bindResToggles(box) {
    box.querySelectorAll('[data-res]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = $(b.dataset.res);
        if (!el) return;
        var clipped = el.classList.toggle('clip');
        b.textContent = clipped ? '展开结果' : '收起结果';
      });
    });
    // 复制 / 下载 JSON（T05⑦）
    box.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = $(b.dataset.copy);
        if (!el) return;
        copyText(el.textContent);
        toast('已复制返回结果', 'ok');
      });
    });
    box.querySelectorAll('[data-dl]').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = $(b.dataset.dl);
        if (!el) return;
        downloadJson((DETAIL_MID || 'client') + '-' + b.dataset.dl + '.json', el.textContent);
      });
    });
  }

  async function renderClientDetail(mid) {
    var body = $('clientModalBody');
    body.innerHTML = '<div class="loading">加载中…</div>';
    $('clientModalTitle').textContent = '客户端 ' + mid;
    try {
      var d = await api('GET', '/api/admin/fleet/clients/' + enc(mid));
      var s = d.snapshot || {};
      var der = d.derived || {};
      var rd = der.reasonDesc || metaReason(d.reason, d.licenseState);

      // —— 顶部状态条（规格 T04⑥）：机器码 + 连接徽标(相对时间) + 授权徽标(raw reason) ——
      var topBar = '<div class="cd-topbar">' +
        '<div class="cd-top-main"><b class="cd-mid">' + esc(mid) + '</b> ' +
        connBadge(d.connectivity) +
        (d.blacklisted ? ' <span class="tag s-revoked">拉黑</span>' : '') + ' ' +
        licenseBadge(d.licenseState, d.reason) +
        (d.isTrial ? ' ' + trialBadgeTag() : '') +
        '</div>' +
        '<div class="cd-top-meta">' +
        esc([s.version || '—', (s.platform || '?') + '/' + (s.arch || '?'), s.region || '—', s.publicIp || '—',
          '已运行 ' + (der.uptimeSec ? fmtDur(der.uptimeSec) : '—')].join(' · ')) +
        (s.hostname ? ' · ' + esc(s.hostname) : '') +
        '</div>' +
        (rd && rd.advice ? '<div class="cd-advice">建议：' + esc(rd.advice) + '</div>' : '') +
        '</div>';

      // —— 基础信息增强（规格 T04⑦）：platform/arch/hostname/uptime/heartbeatLag/待回执指令数 ——
      var info = [
        ['机器码', mid],
        ['授权码', d.code || '—'],
        ['QQ', d.qq || '—'],
        ['连接状态', connBadge(d.connectivity)],
        ['授权状态', licenseBadge(d.licenseState, d.reason)],
        ['Raw Reason', esc(d.reason || '—')],
        ['版本', s.version || '—'],
        ['平台/架构', esc((s.platform || '?') + ' / ' + (s.arch || '?'))],
        ['主机名', s.hostname || '—'],
        ['地域', s.region || '—'],
        ['公网IP', s.publicIp || '—'],
        ['开机时长', der.uptimeSec ? fmtDur(der.uptimeSec) : '—'],
        ['心跳时延', (der.heartbeatLagSec != null ? der.heartbeatLagSec + 's' : '—')],
        ['待回执指令', (der.pendingCount || 0) + ' 待下发 / ' + (der.sentCount || 0) + ' 已下发'],
        ['最近心跳', s.lastHeartbeatAt ? (fmtTime(s.lastHeartbeatAt) + '（' + relTime(s.lastHeartbeatAt) + '）') : '从未上报'],
        ['CPU', (s.cpuUsage != null ? s.cpuUsage + '%' : '—')],
        ['内存', (s.memUsage != null ? s.memUsage + '%' : '—')],
      ];
      var html = topBar +
        '<div class="cd-section"><h4>基础信息</h4><div class="cd-grid">' +
        info.map(function (p) { return '<div class="kv"><span class="k">' + esc(p[0]) + '</span><span class="v">' + p[1] + '</span></div>'; }).join('') +
        '</div></div>';
      var prn = d.printers || [];
      html += '<div class="cd-section"><h4>打印机（' + prn.length + '）</h4><div class="cd-printers">' +
        (prn.length ? prn.map(function (p) { return '<div class="cd-prn"><span>' + esc(p.name) + '</span><span class="filter-tip">' + esc(p.status || '') + '</span></div>'; }).join('') : '<div class="filter-tip">无</div>') +
        '</div></div>';
      var anoms = d.anomalies || [];
      html += '<div class="cd-section"><h4>关联异常（' + anoms.length + '）</h4><div class="cd-anoms">' +
        (anoms.length ? anoms.map(function (a) { return '<div class="cd-anom"><span>' + esc(a.rule) + '</span>' + anomalyStatusBadge(a.status) + '</div>'; }).join('') : '<div class="filter-tip">无</div>') +
        '</div></div>';
      // 指令时间线（T05）：状态流转 + 结果体 + 截断/迟到标记，每 5 秒自动刷新
      var cmds = d.commands || [];
      html += '<div class="cd-section"><h4>指令时间线（<span id="cdCmdCount">' + cmds.length + '</span>）</h4>' +
        '<div class="cmd-tl" id="cdCmdTl">' + renderCmdTimeline(cmds) + '</div></div>';
      html += '<div class="cd-section"><h4>下发远程指令</h4><div class="cmd-panel" id="cdCmdPanel"></div>' +
        '<div class="cmd-hint">危险指令需二次确认，<b>禁用客户端</b>还需输入确认词；L2+ 可下发。' +
        '结果体单条上限 ' + fmtBytes(metaLimitOf('resultMaxBytes', 65536)) +
        '，每台设备保留最近 ' + metaLimitOf('resultsPerClient', 10) + ' 条。</div></div>';
      body.innerHTML = html;
      bindResToggles($('cdCmdTl'));
      buildCommandPanel(mid, prn);
    } catch (e) {
      body.innerHTML = '<div class="loading">加载失败：' + esc(e.message) + '</div>';
    }
  }

  function buildCommandPanel(mid, prn) {
    var panel = $('cdCmdPanel');
    if (!panel) return;
    if (state.level < 2) { panel.innerHTML = '<span class="filter-tip">当前账号权限不足（需 L2+），无法下发指令。</span>'; return; }
    // 指令清单来自 /fleet/meta（前端零硬编码），按 group 分组下拉
    var cmds = (META && META.commands) ? META.commands : [];
    if (!cmds.length) {
      // meta 尚未就绪：等待并兜底重载
      ensureMeta().then(function () { buildCommandPanel(mid, prn); });
      panel.innerHTML = '<span class="filter-tip">指令列表加载中…</span>';
      return;
    }
    var groups = (META && META.groups) ? META.groups : [];
    // 按 groups 顺序 + 其余分组归类
    var byGroup = {};
    cmds.forEach(function (c) {
      var g = c.group || '其他';
      byGroup[g] = byGroup[g] || [];
      byGroup[g].push(c);
    });
    var orderedGroups = groups.slice();
    Object.keys(byGroup).forEach(function (g) { if (orderedGroups.indexOf(g) < 0) orderedGroups.push(g); });

    var optsHtml = orderedGroups.map(function (g) {
      var items = byGroup[g] || [];
      if (!items.length) return '';
      var os = items.map(function (c) {
        // 该设备没上报打印机时，禁用「必须指定打印机」的指令（可选打印机的指令仍可用）
        var dis = (!prn || !prn.length) && schemaNeedsPrinter(c) ? ' disabled' : '';
        return '<option value="' + esc(c.action) + '"' + dis + '>' + esc(c.label || c.action) + (c.dangerous ? ' ⚠' : '') + '</option>';
      }).join('');
      return '<optgroup label="' + esc(g) + '">' + os + '</optgroup>';
    }).join('');

    panel.innerHTML = '<select id="cdAct">' + optsHtml + '</select>' +
      '<span id="cdPayloadWrap"></span>' +
      '<button class="btn sm" id="cdSend">下发</button>' +
      '<div class="cmd-hint" id="cdDesc"></div>';
    var cdAct = $('cdAct');

    // 按 payloadSchema 渲染表单：新增指令只要服务端补 schema，这里无需改代码
    function syncPayload() {
      var spec = specOfAction(cdAct.value);
      var schema = spec.payloadSchema || {};
      var keys = Object.keys(schema);
      $('cdDesc').textContent = spec.desc || '';
      $('cdPayloadWrap').innerHTML = keys.length
        ? keys.map(function (k) { return fieldHtml(k, schema[k], prn); }).join('')
        : '<span class="filter-tip">该指令无需载荷</span>';
    }
    cdAct.addEventListener('change', syncPayload);
    syncPayload();

    $('cdSend').addEventListener('click', function () {
      var a = cdAct.value;
      var spec = specOfAction(a);
      var payload = collectPayload(spec);
      if (payload === null) return; // 校验未过，collectPayload 已经 toast 过原因
      var label = spec.label || a;
      if (spec.dangerous) {
        confirmDangerous(spec, '客户端 <b>' + esc(mid) + '</b>', function (word) {
          issueFleetCommand(mid, a, payload, word || null, label, 'cluster');
        });
      } else {
        issueFleetCommand(mid, a, payload, null, label, 'cluster');
      }
    });
  }

  // 指令是否「必须」指定打印机（必填 + printer 控件）
  function schemaNeedsPrinter(spec) {
    var schema = (spec && spec.payloadSchema) || {};
    return Object.keys(schema).some(function (k) {
      return schema[k].required && schema[k].widget === 'printer';
    });
  }

  /**
   * 单个载荷字段的输入控件。控件类型由服务端 schema 的 widget 决定：
   * printer（打印机下拉）/ textarea（多行）/ select（枚举）/ kv（JSON 对象）/ 默认单行文本。
   * @param {string} key 字段名
   * @param {object} def 字段定义
   * @param {Array<object>} prn 该客户端上报的打印机列表
   * @returns {string} HTML
   */
  function fieldHtml(key, def, prn) {
    var id = 'cdF_' + key;
    var label = esc(def.label || key) + (def.required ? ' <span style="color:var(--bad)">*</span>' : '');
    var ctrl;
    if (def.widget === 'printer') {
      if (prn && prn.length) {
        ctrl = '<select id="' + id + '">' +
          (def.required ? '' : '<option value="">（全部打印机）</option>') +
          prn.map(function (p) { return '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>'; }).join('') +
          '</select>';
      } else {
        ctrl = '<input id="' + id + '" type="text" placeholder="该客户端未上报打印机"' + (def.required ? ' disabled' : '') + ' />';
      }
    } else if (def.widget === 'select' && def.enum) {
      ctrl = '<select id="' + id + '">' +
        (def.required ? '' : '<option value="">（默认）</option>') +
        def.enum.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('') +
        '</select>';
    } else if (def.widget === 'textarea') {
      ctrl = '<textarea id="' + id + '" rows="2" placeholder="' + esc(def.label || key) +
        (def.maxLen ? '（最多 ' + def.maxLen + ' 字）' : '') + '"></textarea>';
    } else if (def.widget === 'kv' || def.type === 'object') {
      ctrl = '<input id="' + id + '" type="text" placeholder="' + esc(configPlaceholder()) + '" />';
    } else {
      ctrl = '<input id="' + id + '" type="text" placeholder="' + esc(def.label || key) + '" />';
    }
    var help = def.help ? '<div class="cmd-hint">' + esc(def.help) + '</div>' : '';
    if ((def.widget === 'kv' || def.type === 'object') && whitelistHint()) {
      help += '<div class="cmd-hint">可用键：' + esc(whitelistHint()) + '</div>';
    }
    return '<span class="cmd-field"><label for="' + id + '">' + label + '</label>' + ctrl + help + '</span>';
  }

  // 配置下发的 JSON 占位符与白名单提示，均由 /fleet/meta.configWhitelist 生成
  function configPlaceholder() {
    var wl = (META && META.configWhitelist) || {};
    var g = Object.keys(wl)[0];
    if (!g) return 'JSON 对象';
    var k = (wl[g] || [])[0] || 'key';
    var demo = {};
    demo[g] = {};
    demo[g][k] = '值';
    return 'JSON，如 ' + JSON.stringify(demo);
  }
  function whitelistHint() {
    var wl = (META && META.configWhitelist) || {};
    return Object.keys(wl).map(function (g) {
      return g + '.' + (wl[g] || []).join('/' + g + '.');
    }).join('，');
  }

  /**
   * 读取并校验指令面板里的载荷。校验规则镜像服务端 validatePayload，
   * 服务端仍是最终权威——这里只是把错误提前暴露给运维，少一次往返。
   * @param {object} spec 指令契约
   * @returns {object|null} 合法载荷；校验失败返回 null（并已提示原因）
   */
  function collectPayload(spec) {
    var schema = (spec && spec.payloadSchema) || {};
    var payload = {};
    var keys = Object.keys(schema);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var def = schema[k];
      var el = $('cdF_' + k);
      var raw = el ? String(el.value == null ? '' : el.value).trim() : '';
      if (!raw) {
        if (def.required) { toast('请填写' + (def.label || k), 'warn'); return null; }
        continue; // 可选字段留空 = 不下发该键，交由客户端取默认值
      }
      if (def.type === 'object') {
        var parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) { toast((def.label || k) + ' 需为合法 JSON', 'warn'); return null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          toast((def.label || k) + ' 需为 JSON 对象', 'warn'); return null;
        }
        payload[k] = parsed;
        continue;
      }
      if (def.maxLen && raw.length > def.maxLen) {
        toast((def.label || k) + ' 超长（最多 ' + def.maxLen + ' 字）', 'warn'); return null;
      }
      if (def.enum && def.enum.indexOf(raw) < 0) {
        toast((def.label || k) + ' 取值非法', 'warn'); return null;
      }
      if (def.pattern && !new RegExp(def.pattern).test(raw)) {
        toast((def.label || k) + ' 格式不合法', 'warn'); return null;
      }
      payload[k] = raw;
    }
    return payload;
  }

  function issueFleetCommand(mid, action, payload, confirm, label, refreshView) {
    if (!requireWrite('下发远程指令 ' + (label || action))) return;
    var body = { action: action, payload: payload || {} };
    if (confirm) body.confirm = confirm; // 二次确认词（disable_client 必须）
    api('POST', '/api/admin/fleet/clients/' + enc(mid) + '/command', body)
      .then(function (r) {
        toast('已下发：' + (label || action) + (r.commandId ? '（' + r.commandId + '）' : ''), 'ok');
        closeModal();
        // T05④：仅关闭载荷子面板；详情抽屉保持打开，时间线插入「跟踪中」行，
        // 由 CmdTracker（startDetailPoll）每 5s 轮询刷新为终态。
        if (refreshView === 'cluster') {
          insertTrackingRow(mid, r.commandId, action);
          renderCluster();
        } else if (refreshView === 'printers') {
          renderFleetPrinters();
        }
      })
      .catch(function (e) { toast('下发失败：' + e.message, 'bad'); });
  }

  // ---------------- FLEET：异常 ----------------
  async function renderAnomalies() {
    var ruleBox = $('anomalyRules');
    var t = $('anomalyTable');
    t.querySelector('thead').innerHTML = '<tr><th>规则</th><th>客户端</th><th>授权码</th><th>严重程度</th><th>状态</th><th>首次</th><th>最近</th><th>详情</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="9" class="loading">加载中…</td></tr>';
    try {
      var qs = [];
      var st = $('anomalyStatus').value; if (st) qs.push('status=' + enc(st));
      var d = await api('GET', '/api/admin/fleet/anomalies' + (qs.length ? '?' + qs.join('&') : ''));
      var rules = d.rules || [];
      ruleBox.innerHTML = (rules.length ? rules : Object.keys(RULE_DESC)).map(function (r) {
        return '<div class="card" style="padding:12px 16px"><h3>' + esc(r) + '</h3><div class="help">' + esc(RULE_DESC[r] || '自定义规则') + '</div></div>';
      }).join('');
      var list = d.items || [];
      if (!list.length) { t.querySelector('tbody').innerHTML = '<tr><td colspan="9" class="loading">未检测到异常</td></tr>'; return; }
      t.querySelector('tbody').innerHTML = list.map(function (a) {
        return '<tr><td>' + esc(a.rule) + '</td><td class="wrap">' + esc(a.machineId || '—') + '</td><td>' + esc(a.code || '—') +
          '</td><td>' + esc(a.severity || '—') + '</td><td>' + anomalyStatusBadge(a.status) +
          '</td><td>' + (a.firstSeen ? fmtTime(a.firstSeen) : '—') + '</td><td>' + (a.lastSeen ? fmtTime(a.lastSeen) : '—') +
          '</td><td class="wrap">' + esc(a.detail || '—') + '</td><td class="row-actions">' +
          '<button class="btn ghost sm" data-aa="ignore" data-id="' + enc(a.id) + '">忽略</button>' +
          '<button class="btn ghost sm" data-aa="blacklist" data-id="' + enc(a.id) + '">拉黑</button>' +
          '<button class="btn danger sm" data-aa="revoke" data-id="' + enc(a.id) + '">吊销</button></td></tr>';
      }).join('');

      t.querySelectorAll('[data-aa]').forEach(function (b) {
        b.addEventListener('click', function () {
          var map = { ignore: '忽略', blacklist: '拉黑', revoke: '吊销' };
          anomalyAction(decodeURIComponent(b.dataset.id), b.dataset.aa, map[b.dataset.aa] || b.dataset.aa);
        });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="9" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }
  function anomalyAction(id, act, label) {
    if (!requireWrite(label + '异常')) return;
    var path = '/api/admin/fleet/anomalies/' + enc(id) + '/' + act;
    openModal(label + ' 异常', '<p>确认对异常 <b>' + esc(id) + '</b> 执行「' + label + '」？' +
      (act === 'blacklist' ? ' <span style="color:var(--warn)">将把该客户端加入黑名单，禁止心跳。</span>' : '') +
      (act === 'revoke' ? ' <span style="color:var(--warn)">将吊销该客户端授权。</span>' : '') + '</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认', cls: act === 'ignore' ? '' : 'danger', onClick: function () { doAnomalyAction(path, label); } },
    ]);
  }
  async function doAnomalyAction(path, label) {
    try {
      await api('POST', path, {});
      toast(label + '成功', 'ok');
      closeModal();
      renderAnomalies();
    } catch (e) { toast(label + '失败：' + e.message, 'bad'); }
  }

  // ---------------- 系统状态 ----------------
  async function renderSystem() {
    var box = $('sysCards');
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      var d = await api('GET', '/api/admin/console/status');
      var s = d.status;
      var html = '';
      html += card('运行时', [['健康', s.health], ['PID', s.process.pid], ['运行时长', fmtDur(s.uptimeSec)]]);
      if (s.process.pm2) {
        s.process.pm2.forEach(function (p) {
          html += card('进程 ' + p.name, [['状态', p.status], ['CPU%', p.cpu], ['内存', fmtBytes(p.memory)]]);
        });
      } else if (s.process.self) {
        html += card('进程（本进程）', [['状态', s.process.self.status], ['内存', fmtBytes(s.process.self.memory)]]);
      }
      (s.disk || []).forEach(function (ds) {
        html += card('磁盘 ' + ds.mount, [['文件系统', ds.fs], ['已用', fmtBytes(ds.used)], ['可用', fmtBytes(ds.avail)]], ds.usedPercent);
      });
      box.innerHTML = html;
      renderAudit();
    } catch (e) {
      box.innerHTML = '<div class="loading">加载失败：' + esc(e.message) + '</div>';
    }
  }
  async function renderAudit() {
    var box = $('auditTimeline');
    box.innerHTML = '<div class="loading">加载中…</div>';
    try {
      var d = await api('GET', '/api/admin/console/audit?limit=50');
      var list = d.logs || [];
      if (!list.length) { box.innerHTML = '<div class="loading">暂无审计记录</div>'; return; }
      box.innerHTML = list.map(function (r) {
        return '<div class="tl-item"><div class="tl-meta">' + esc(fmtTime(r.ts)) + '<br/>' + esc(r.operator) +
          '</div><div class="tl-body"><span class="tl-act">' + esc(r.action) + '</span> → ' + esc(r.target) +
          (r.detail ? '（' + esc(r.detail) + '）' : '') + (r.ok === false ? ' ❌' : '') + '</div></div>';
      }).join('');
    } catch (e) {
      box.innerHTML = '<div class="loading">审计加载失败：' + esc(e.message) + '</div>';
    }
  }

  // ---------------- 弹窗 ----------------
  function openModal(title, bodyHtml, buttons) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    $('modalFoot').innerHTML = '';
    (buttons || []).forEach(function (b) {
      var el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      $('modalFoot').appendChild(el);
    });
    $('modalMask').classList.remove('hidden');
  }
  function closeModal() { $('modalMask').classList.add('hidden'); }

  // ---------------- 容器管理（[R6 R4] FastOSDocker 反代 iframe）----------------
  // iframe 直连 /docker-mgr/pc/（相对资源路径，无需 HTML 重写）；令牌经 query 透传给
  // dockerMgrProxy 鉴权（iframe 无法带自定义请求头）；加载失败/超时显示降级提示。
  var dockerFrameTimer = null;
  function renderDocker() {
    var frame = $('dockerFrame');
    var degrade = $('dockerDegrade');
    var msg = $('dockerDegradeMsg');
    if (!frame) return;
    if (frame.getAttribute('src')) { return; } // 已初始化过，仅首次加载
    var base = frame.getAttribute('data-src') || '/docker-mgr/pc/';
    var sep = base.indexOf('?') >= 0 ? '&' : '?';
    var tok = state.token || state.raw || '';
    frame.setAttribute('src', base + sep + 'token=' + encodeURIComponent(tok));
    // 加载失败/超时（12s 未完成）→ 降级提示（iframe 内不白屏）
    frame.addEventListener('load', function () {
      clearTimeout(dockerFrameTimer);
      if (degrade) degrade.classList.add('hidden');
    });
    frame.addEventListener('error', function () {
      clearTimeout(dockerFrameTimer);
      if (msg) msg.textContent = '容器管理服务加载失败：请检查配置中心「容器管理」组（dockerMgrUrl）与上游服务可用性。';
      if (degrade) degrade.classList.remove('hidden');
    });
    clearTimeout(dockerFrameTimer);
    dockerFrameTimer = setTimeout(function () {
      var done = frame.contentWindow && frame.contentWindow.document;
      // 无法跨域探测内容；仅当 iframe 尚未触发 load 事件且 loading 状态仍为进行中时提示
      if (!done || done.readyState === 'loading') {
        if (msg) msg.textContent = '容器管理服务响应超时：请确认 dockerMgrUrl（默认 http://127.0.0.1:8081）可访问。';
        if (degrade) degrade.classList.remove('hidden');
      }
    }, 12000);
  }

  // ---------------- 绑定 ----------------
  function debounce(fn, ms) {
    var t = null;
    return function () { clearTimeout(t); t = setTimeout(fn, ms || 300); };
  }  function bind() {
    $('loginBtn').addEventListener('click', doLogin);
    $('loginToken').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('loginQq').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('logoutBtn').addEventListener('click', logout);
    document.querySelectorAll('.nav').forEach(function (n) {
      n.addEventListener('click', function () { loadView(n.dataset.view); });
    });
    $('cfgSaveBtn').addEventListener('click', saveConfig);
    // [R5] 配置分组编辑态（编辑按钮 + localStorage 持久化）
    // [R6 R2] 移除 HTML5 拖拽监听；改为 ↑/↓ 箭头点击（事件委托）相邻交换
    var cfgEditBtn = $('cfgEditBtn');
    if (cfgEditBtn) cfgEditBtn.addEventListener('click', toggleCfgEdit);
    var cfgGroupsEl = $('cfgGroups');
    if (cfgGroupsEl) {
      cfgGroupsEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.cfg-move');
        if (!btn || !cfgEditOn) return;
        var dir = btn.dataset.dir === 'down' ? 'down' : 'up';
        moveGroup(dir, btn.closest('.cfg-group'));
      });
    }
    $('grantBtn').addEventListener('click', openGrant);
    $('ordersRefresh').addEventListener('click', renderOrders);
    $('adminAddBtn').addEventListener('click', openAddAdmin);

    // FLEET：集群筛选（连接性 / 授权态 为两个正交维度，各自独立筛选）
    $('clusterRefresh').addEventListener('click', renderCluster);
    $('clusterQ').addEventListener('input', debounce(renderCluster, 350));
    $('clusterConn').addEventListener('change', renderCluster);
    $('clusterLicense').addEventListener('change', renderCluster);
    $('clusterVersion').addEventListener('change', renderCluster);
    $('clusterRegion').addEventListener('change', renderCluster);
    // 自动刷新间隔（localStorage 持久化，默认 30s）
    var autoSel = $('clusterAuto');
    var saved = parseInt(localStorage.getItem('sea1.console.cluster.autoRefresh') || '30', 10);
    autoSel.value = [0, 15, 30, 60].indexOf(saved) >= 0 ? String(saved) : '30';
    autoSel.addEventListener('change', function () {
      localStorage.setItem('sea1.console.cluster.autoRefresh', autoSel.value);
      if (currentView === 'cluster') startClusterAuto();
    });
    // 分布条点击筛选
    $('clusterDist').addEventListener('click', function (e) {
      var line = e.target.closest('.dist-line');
      if (!line) return;
      distPick(line.dataset.kind, decodeURIComponent(line.dataset.key));
    });
    // 批量条：取消选择（原地清空，保持对象引用一致供 T04 跨文件共享）
    $('bulkClear').addEventListener('click', function () {
      Object.keys(SEL_MIDS).forEach(function (k) { delete SEL_MIDS[k]; });
      syncBulkBar();
      var t = $('clusterTable');
      t.querySelectorAll('.ckbox').forEach(function (b) { b.checked = false; });
      var all = $('clusterCkAll'); if (all) all.checked = false;
    });
    // 批量动作下拉（由 /fleet/meta 驱动，切换指令时联动载荷输入框）
    $('bulkAct').addEventListener('change', syncBulkPayload);
    // 批量下发：并发上限取自 meta.limits.batchConcurrency
    $('bulkSend').addEventListener('click', doBulkSend);
    // 统一管理：进程/打印/配置集中面板（分散设置收拢到集群，免多视图跳转）
    if ($('bulkUnified')) $('bulkUnified').addEventListener('click', openUnifiedMgr);
    // FLEET：打印机
    $('prnRefresh').addEventListener('click', renderFleetPrinters);
    $('prnQ').addEventListener('input', debounce(renderFleetPrinters, 350));
    // FLEET：异常
    $('anomalyRefresh').addEventListener('click', renderAnomalies);
    $('anomalyStatus').addEventListener('change', renderAnomalies);

    $('modalMask').addEventListener('click', function (e) { if (e.target === $('modalMask')) closeModal(); });
    $('clientModalMask').addEventListener('click', function (e) { if (e.target === $('clientModalMask')) closeClientModal(); });

    // hash 路由：浏览器前进/后退直达视图
    window.addEventListener('hashchange', function () {
      if (suppressHash) return;
      loadView(viewFromHash());
    });
    // 切回前台：若停留在集群视图，立即重启自动刷新（后台期间 setInterval 可能被节流）
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && currentView === 'cluster') startClusterAuto();
    });
  }

  // ---------------- 启动 ----------------
  window.addEventListener('DOMContentLoaded', function () {
    bind();
    var tok = localStorage.getItem(LS_TOKEN);
    var raw = localStorage.getItem(LS_RAW);
    if (tok) {
      state.token = tok; state.raw = raw || '';
      // 探活：拉一次状态确认会话有效
      api('GET', '/api/admin/console/status').then(function (d) {
        hideLogin();
        updateWho();
        loadView(viewFromHash());
        toast('已恢复登录会话', 'ok');
      }).catch(function () {
        showLogin('会话已失效，请重新登录');
      });
    } else {
      // [T2 P2-10] 无 token：先探测局域网免登录，失败再显示登录遮罩
      tryLanOrLogin();
    }
  });

  // ---------------- T04：基础视图注册（六大新视图由 console.*.js 注册）----------------
  registerView('overview', renderOverview);
  registerView('config', renderConfig);
  registerView('orders', renderOrders);
  registerView('admins', renderAdmins);
  registerView('cluster', renderCluster);
  registerView('printers', renderFleetPrinters);
  registerView('anomalies', renderAnomalies);
  registerView('license', renderDevices); // 旧授权页兜底；console.admin.js 加载后覆盖为 codes CRUD
  registerView('system', renderSystem);
  registerView('docker', renderDocker); // [R6 R4] 容器管理（FastOSDocker 反代 iframe）
  registerView('docs', function () { // [DOCS] 帮助中心（console.docs.js 加载后覆盖）
    var el = $('docsContent');
    if (el) el.innerHTML = '<div class="loading">帮助中心加载中…</div>';
  });

  // ---------------- T04：导出共享工具/状态给 console.*.js（window.ConsoleApp）----------------
  // 多文件 IIFE 架构的单一出口：新视图文件一律通过 window.ConsoleApp 复用主控能力，
  // 状态值中文/危险级仍由 META（/fleet/meta 下发）驱动，这里只导函数不导硬编码。
  window.ConsoleApp = window.ConsoleApp || {};
  window.ConsoleApp.registerView = registerView;
  window.ConsoleApp.callView = callView;
  window.ConsoleApp.registerViewHook = registerViewHook;
  window.ConsoleApp.runViewHooks = runViewHooks;
  window.ConsoleApp.i18n = i18n;
  window.ConsoleApp.api = api;
  window.ConsoleApp.headers = headers;
  window.ConsoleApp.$ = $;
  window.ConsoleApp.esc = esc;
  window.ConsoleApp.toast = toast;
  window.ConsoleApp.openModal = openModal;
  window.ConsoleApp.closeModal = closeModal;
  window.ConsoleApp.copyText = copyText;
  window.ConsoleApp.downloadJson = downloadJson;
  window.ConsoleApp.fmtBytes = fmtBytes;
  window.ConsoleApp.fmtDur = fmtDur;
  window.ConsoleApp.fmtTime = fmtTime;
  window.ConsoleApp.relTime = relTime;
  window.ConsoleApp.enc = enc;
  window.ConsoleApp.getState = function () { return state; };
  window.ConsoleApp.getMeta = function () { return META; };
  window.ConsoleApp.getCurrentView = function () { return currentView; };
  window.ConsoleApp.getClusterList = function () { return CLUSTER_LIST; };
  window.ConsoleApp.selMids = SEL_MIDS;
  window.ConsoleApp.syncBulkBar = syncBulkBar;
  window.ConsoleApp.ensureMeta = ensureMeta;
  window.ConsoleApp.specOfAction = specOfAction;
  window.ConsoleApp.connBadge = connBadge;
  window.ConsoleApp.licenseBadge = licenseBadge;
  window.ConsoleApp.metaConn = metaConn;
  window.ConsoleApp.metaConnLabel = metaConnLabel;
  window.ConsoleApp.metaConnBadge = metaConnBadge;
  window.ConsoleApp.metaReason = metaReason;
  window.ConsoleApp.metaStatus = metaStatus;
  window.ConsoleApp.metaLicenseState = metaLicenseState;
  window.ConsoleApp.metaLimitOf = metaLimitOf;
  window.ConsoleApp.cmdStatusMeta = cmdStatusMeta;
  window.ConsoleApp.requireWrite = requireWrite;
  window.ConsoleApp.debounce = debounce;
  window.ConsoleApp.issueFleetCommand = issueFleetCommand;
  window.ConsoleApp.confirmDangerous = confirmDangerous;
  window.ConsoleApp.schemaNeedsPrinter = schemaNeedsPrinter;
  window.ConsoleApp.anomalyStatusBadge = anomalyStatusBadge;
  window.ConsoleApp.renderFleetPrinters = renderFleetPrinters;
})();
