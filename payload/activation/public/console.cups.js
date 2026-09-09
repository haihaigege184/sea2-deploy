'use strict';
/**
 * public/console.cups.js — 打印与 CUPS 视图（T04）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §2.2 / §4.3
 *  - 跨设备打印机列表：客户端自报聚合（/api/admin/fleet/printers）
 *  - 设备 CUPS 详情：GET /api/admin/fleet/clients/{mid} → cups 字段（running/printers[]）
 *  - 驱动识别推荐：GET /api/admin/ops/cups/recommend?model=&uri= → {driver, confidence, label, alternatives}
 *  - 添加/配置打印机：经指令通道 cups_add_printer / cups_set_printer（人工确认驱动，不静默安装）
 *  - 本机打印机档案 CRUD（printers 实体）
 *
 * 依赖 window.ConsoleApp；按序 <script> 引入。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var NS = window.ConsoleApp || {};
  if (!NS.registerView || !NS.api) return;

  var api = NS.api, $ = NS.$, esc = NS.esc, toast = NS.toast;
  var openModal = NS.openModal, closeModal = NS.closeModal;
  var relTime = NS.relTime, enc = NS.enc;
  var requireWrite = NS.requireWrite;
  var poll = NS.poll, cmdStatusMeta = NS.cmdStatusMeta, specOfAction = NS.specOfAction;
  var crud = NS.crud, i18n = NS.i18n || function (s, k, f) { return f !== undefined ? f : String(k); };

  var T = function (scope, key, fb) { return i18n(scope, key, fb); };

  var CLIENT_CACHE = [];
  var CLIENT_CACHE_AT = 0;

  function printerStateCn(st) {
    var map = {
      idle: '空闲', printing: '打印中', stopped: '已停止', disabled: '已禁用',
      enabled: '已启用', archived: '仅档案', unknown: '未知', error: '错误',
    };
    return map[st] || String(st || '未知');
  }
  function printerStateBadge(st) {
    var s = String(st || 'unknown');
    var cn = printerStateCn(st);
    var cls = s === 'idle' || s === 'enabled' ? 's-normal' : (s === 'error' || s === 'stopped' || s === 'disabled' ? 's-revoked' : 's-trial');
    return '<span class="tag ' + cls + '">' + esc(cn) + '</span>';
  }

  // ---------------- 跨设备打印机列表 ----------------
  async function renderCrossPrinters() {
    var t = $('cupsTable');
    if (!t) return;
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th>打印机</th><th>状态</th><th>所属客户端</th><th>客户端版本</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">加载中…</td></tr>';
    try {
      var q = (($('cupsQ') || {}).value || '').trim();
      var d = await api('GET', '/api/admin/fleet/printers' + (q ? '?q=' + enc(q) : ''));
      var list = d.items || [];
      if (!list.length) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">暂无打印机上报</td></tr>';
        return;
      }
      t.querySelector('tbody').innerHTML = list.map(function (p) {
        return '<tr><td class="wrap">' + esc(p.name) + '</td>' +
          '<td>' + printerStateBadge(p.status) + '</td>' +
          '<td class="wrap">' + esc(p.clientMachineId || '—') + '</td>' +
          '<td>' + esc(p.clientVersion || '—') + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn ghost sm" data-cups="disable" data-mid="' + enc(p.clientMachineId) + '" data-pn="' + enc(p.name) + '">禁用</button>' +
          '<button class="btn ghost sm" data-cups="enable" data-mid="' + enc(p.clientMachineId) + '" data-pn="' + enc(p.name) + '">启用</button>' +
          '<button class="btn ghost sm" data-cups="view" data-mid="' + enc(p.clientMachineId) + '">详情</button>' +
          '</td></tr>';
      }).join('');
      t.querySelectorAll('[data-cups]').forEach(function (b) {
        b.addEventListener('click', function () {
          var mid = decodeURIComponent(b.dataset.mid);
          var pn = decodeURIComponent(b.dataset.pn || '');
          if (b.dataset.cups === 'view') { selectCupsDevice(mid); return; }
          cupsPrinterToggle(mid, pn, b.dataset.cups);
        });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="5" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  function cupsPrinterToggle(mid, name, act) {
    if (!requireWrite('远程' + (act === 'disable' ? '禁用' : '启用') + '打印机')) return;
    var action = act === 'disable' ? 'disable_printer' : 'enable_printer';
    var spec = specOfAction(action);
    var label = spec.label || action;
    var payload = { printerName: name };
    openModal(label + '（远程指令）',
      '<p>将向客户端 <b>' + esc(mid) + '</b> 下发：<b>' + esc(label + ' (' + action + ')') + '</b>，打印机 <b>' + esc(name) + '</b>。</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认下发', cls: act === 'disable' ? 'danger' : '', onClick: function () {
        runCupsCmd(mid, action, payload, label, null);
      } },
    ]);
  }

  // ---------------- 设备 CUPS 详情 ----------------
  async function loadCupsDevices() {
    var now = Date.now();
    if (CLIENT_CACHE.length && (now - CLIENT_CACHE_AT) < 20000) return CLIENT_CACHE;
    var d = await api('GET', '/api/admin/fleet/clients?pageSize=500');
    CLIENT_CACHE = d.items || [];
    CLIENT_CACHE_AT = Date.now();
    return CLIENT_CACHE;
  }

  function fillCupsDeviceSelect(clients) {
    var sel = $('cupsDevice');
    if (!sel) return;
    var cur = sel.value;
    // 列表接口不含 cups 字段：全部客户端均可选，选中后再拉详情
    sel.innerHTML = '<option value="">选择设备…</option>' + clients.map(function (c) {
      return '<option value="' + esc(c.machineId) + '"' + (c.machineId === cur ? ' selected' : '') + '>' +
        esc(c.machineId) + (c.qq ? '（' + esc(c.qq) + '）' : '') + '</option>';
    }).join('');
  }

  function selectCupsDevice(mid) {
    var sel = $('cupsDevice');
    if (sel) sel.value = mid;
    renderCupsDeviceDetail(mid);
  }

  async function renderCupsDeviceDetail(mid) {
    var t = $('cupsDeviceTable');
    if (!t) return;
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th>打印机</th><th>型号</th><th>驱动</th><th>状态</th><th>队列</th><th>默认</th><th>URI</th><th>操作</th></tr>';
    if (!mid) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">请先选择设备</td></tr>';
      var meta = $('cupsDeviceMeta');
      if (meta) meta.textContent = '';
      return;
    }
    t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">加载中…</td></tr>';
    try {
      var d = await api('GET', '/api/admin/fleet/clients/' + enc(mid));
      var cups = d.cups || { running: false, printers: [] };
      var meta2 = $('cupsDeviceMeta');
      if (meta2) meta2.textContent = cups.running ? 'CUPS 运行中' : 'CUPS 未运行';
      var printers = Array.isArray(cups.printers) ? cups.printers : [];
      if (!printers.length) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">该设备未上报打印机</td></tr>';
        return;
      }
      t.querySelector('tbody').innerHTML = printers.map(function (p) {
        return '<tr>' +
          '<td class="wrap"><b>' + esc(p.name) + '</b></td>' +
          '<td class="wrap">' + esc(p.model || '—') + '</td>' +
          '<td class="wrap">' + esc(p.driver || '—') + '</td>' +
          '<td>' + printerStateBadge(p.state || p.status) + '</td>' +
          '<td>' + (p.queueCount != null ? esc(String(p.queueCount)) : '—') + '</td>' +
          '<td>' + (p.default ? '是' : '—') + '</td>' +
          '<td class="wrap">' + esc(p.uri || '—') + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn ghost sm" data-cd2="enable" data-pn="' + enc(p.name) + '">启用</button>' +
          '<button class="btn ghost sm" data-cd2="disable" data-pn="' + enc(p.name) + '">禁用</button>' +
          '<button class="btn ghost sm" data-cd2="default" data-pn="' + enc(p.name) + '">设为默认</button>' +
          '</td></tr>';
      }).join('');
      t.querySelectorAll('[data-cd2]').forEach(function (b) {
        b.addEventListener('click', function () {
          var pn = decodeURIComponent(b.dataset.pn);
          var kind = b.dataset.cd2;
          if (!requireWrite('配置打印机')) return;
          var payload = { name: pn };
          if (kind === 'enable') payload.enabled = true;
          if (kind === 'disable') payload.enabled = false;
          if (kind === 'default') payload.default = true;
          var label = kind === 'default' ? '设为默认' : (kind === 'enable' ? '启用' : '禁用');
          openModal(label + '打印机（远程指令）',
            '<p>将向客户端 <b>' + esc(mid) + '</b> 下发 cups_set_printer：<b>' + esc(pn) + '</b> → ' + esc(label) + '。</p>', [
            { label: '取消', cls: 'ghost', onClick: closeModal },
            { label: '确认下发', cls: '', onClick: function () {
              runCupsCmd(mid, 'cups_set_printer', payload, '设置打印机', null);
            } },
          ]);
        });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  // ---------------- 添加打印机（驱动识别推荐 + 人工确认）----------------
  function openAddPrinter() {
    if (!requireWrite('添加打印机')) return;
    var mid = ($('cupsDevice') || {}).value;
    if (!mid) { toast('请先选择目标设备', 'warn'); return; }
    var body = '<p>目标设备：<b>' + esc(mid) + '</b></p>' +
      '<div><label class="ml">打印机名称（必填）</label><input id="cupName" type="text" placeholder="如 EPSON-L3150" /></div>' +
      '<div><label class="ml">设备 URI（必填）</label><input id="cupUri" type="text" placeholder="如 usb://EPSON/L3150?serial=xxx 或 socket://192.168.1.100" /></div>' +
      '<div><label class="ml">型号（用于驱动识别，可空）</label><input id="cupModel" type="text" placeholder="如 EPSON L3150 Series" /></div>' +
      '<div class="toolbar" style="margin:10px 0 0"><button class="btn ghost sm" id="cupRecommendBtn">识别驱动</button><span class="filter-tip" id="cupRecResult"></span></div>' +
      '<div style="margin-top:8px"><label class="ml">PPD 驱动标识（人工确认，不静默安装）</label><input id="cupDriver" type="text" placeholder="如 epson-inkjet-printer-escpr" /></div>' +
      '<div class="cmd-hint">驱动推荐仅供人工确认；确认后经指令通道下发 cups_add_printer。</div>';
    openModal('添加打印机（下发指令）', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认下发', cls: '', onClick: submitAddPrinter },
    ]);
    var recBtn = $('cupRecommendBtn');
    if (recBtn) recBtn.addEventListener('click', doRecommend);
  }

  async function doRecommend() {
    var model = (($('cupModel') || {}).value || '').trim();
    var uri = (($('cupUri') || {}).value || '').trim();
    var out = $('cupRecResult');
    if (!out) return;
    if (!model && !uri) { out.textContent = '请先填写型号或 URI'; return; }
    out.textContent = '识别中…';
    try {
      var r = await api('GET', '/api/admin/ops/cups/recommend?model=' + enc(model) + '&uri=' + enc(uri));
      var drv = $('cupDriver');
      if (r.driver && drv) drv.value = r.driver;
      var conf = Math.round((r.confidence || 0) * 100);
      out.innerHTML = '推荐：<b>' + esc(r.driver || '—') + '</b>（置信度 ' + conf + '%）' +
        ((r.alternatives || []).length ? '；备选：' + esc((r.alternatives || []).join('、')) : '') +
        (r.driver ? '' : '；未匹配到内置型号，建议使用通用驱动并现场验证。');
    } catch (e) {
      out.textContent = '识别失败：' + e.message;
    }
  }

  async function submitAddPrinter() {
    var mid = ($('cupsDevice') || {}).value;
    var name = (($('cupName') || {}).value || '').trim();
    var uri = (($('cupUri') || {}).value || '').trim();
    var driver = (($('cupDriver') || {}).value || '').trim();
    if (!name || !uri) { toast('打印机名称与 URI 必填', 'warn'); return; }
    var payload = { name: name, uri: uri };
    if (driver) payload.driver = driver;
    var label = '添加打印机';
    runCupsCmd(mid, 'cups_add_printer', payload, label, null);
  }

  // ---------------- 指令下发 + 轮询终态 ----------------
  function runCupsCmd(mid, action, payload, label, confirmWord) {
    var body = { action: action, payload: payload || {} };
    if (confirmWord) body.confirm = confirmWord;
    api('POST', '/api/admin/fleet/clients/' + enc(mid) + '/command', body)
      .then(function (r) {
        closeModal();
        toast('已下发：' + label + '（' + (r.commandId || '') + '），等待客户端回执', 'ok');
        pollCupsResult(mid, r.commandId, label);
      })
      .catch(function (e) { toast('下发失败：' + e.message, 'bad'); });
  }

  function pollCupsResult(mid, commandId, label) {
    var p = poll(3000, function () {
      return api('GET', '/api/admin/fleet/clients/' + enc(mid)).then(function (d) {
        var cmds = d.commands || [];
        var c = null;
        for (var i = 0; i < cmds.length; i++) {
          if (cmds[i].id === commandId) { c = cmds[i]; break; }
        }
        if (!c) return;
        var terminal = (c.status === 'acked' || c.status === 'failed' || c.status === 'unsupported' || c.status === 'timeout');
        if (terminal) {
          p.stop();
          var stMeta = cmdStatusMeta(c.status);
          var resText = c.result == null ? '' : (typeof c.result === 'string' ? c.result : JSON.stringify(c.result));
          toast(label + '：' + stMeta.label + (resText ? ' — ' + resText.slice(0, 200) : ''), c.status === 'acked' ? 'ok' : 'bad');
          renderCrossPrinters();
          renderCupsDeviceDetail(mid);
        }
      });
    }, null, 22);
    p.start();
  }

  // ---------------- 本机打印机档案 CRUD ----------------
  function openAddProfile() {
    if (!requireWrite('新增打印机档案')) return;
    var body = '<div><label class="ml">打印机名称（必填）</label><input id="ppName" type="text" placeholder="打印机名称" /></div>' +
      '<div><label class="ml">型号</label><input id="ppModel" type="text" placeholder="型号" /></div>' +
      '<div><label class="ml">驱动</label><input id="ppDriver" type="text" placeholder="PPD 驱动" /></div>' +
      '<div><label class="ml">URI</label><input id="ppUri" type="text" placeholder="设备 URI" /></div>' +
      '<div><label class="ml">队列</label><input id="ppQueue" type="text" placeholder="队列名" /></div>';
    openModal('新增打印机档案', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '创建', cls: '', onClick: submitAddProfile },
    ]);
  }

  async function submitAddProfile() {
    var name = (($('ppName') || {}).value || '').trim();
    if (!name) { toast('打印机名称必填', 'warn'); return; }
    try {
      await crud('printers').create({
        name: name,
        model: (($('ppModel') || {}).value || '').trim(),
        driver: (($('ppDriver') || {}).value || '').trim(),
        uri: (($('ppUri') || {}).value || '').trim(),
        queue: (($('ppQueue') || {}).value || '').trim(),
      });
      toast('已创建打印机档案', 'ok');
      closeModal();
      renderCrossPrinters();
    } catch (e) {
      toast('创建失败：' + e.message, 'bad');
    }
  }

  // ---------------- 绑定 + 注册 ----------------
  function bindCups() {
    var ref = $('cupsRefresh'); if (ref) ref.addEventListener('click', function () { loadCupsDevices().then(renderCrossPrinters); });
    var q = $('cupsQ'); if (q) q.addEventListener('input', NS.debounce ? NS.debounce(renderCrossPrinters, 350) : renderCrossPrinters);
    var add = $('cupsAddBtn'); if (add) add.addEventListener('click', openAddPrinter);
    var profAdd = $('cupsProfileAdd'); if (profAdd) profAdd.addEventListener('click', openAddProfile);
    var dev = $('cupsDevice'); if (dev) dev.addEventListener('change', function () { renderCupsDeviceDetail(dev.value); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindCups);
  } else {
    bindCups();
  }

  NS.registerView('cups', function () {
    renderCrossPrinters();
    loadCupsDevices().then(function (clients) {
      fillCupsDeviceSelect(clients);
      var sel = $('cupsDevice');
      renderCupsDeviceDetail(sel ? sel.value : '');
    });
  });
})();
