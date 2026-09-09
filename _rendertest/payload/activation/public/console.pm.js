'use strict';
/**
 * public/console.pm.js — 进程管理视图（T04）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §2.2 / §4.1 / §4.2
 *  - 服务端进程（sea1-*）：GET /api/admin/ops/pm2/list 本机直控，重启/停止(红)/启动/日志
 *  - 客户端进程（sea2-*）：设备上报 pm2Processes，经指令通道 pm2_restart/pm2_stop/pm2_start/pm2_logs
 *  - 停止类危险操作红色二次确认（confirmWord 来自 /fleet/meta 指令契约，不硬编码）
 *  - 操作结果回显 + 轮询指令终态 + 审计提示
 *
 * 依赖 window.ConsoleApp（console.js 已导出）；按序 <script> 引入。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var NS = window.ConsoleApp || {};
  if (!NS.registerView || !NS.api) return;

  var api = NS.api, $ = NS.$, esc = NS.esc, toast = NS.toast;
  var openModal = NS.openModal, closeModal = NS.closeModal;
  var fmtBytes = NS.fmtBytes, fmtDur = NS.fmtDur, fmtTime = NS.fmtTime, relTime = NS.relTime, enc = NS.enc;
  var requireWrite = NS.requireWrite, getState = NS.getState;
  var poll = NS.poll, i18n = NS.i18n || function (s, k, f) { return f !== undefined ? f : String(k); };
  var specOfAction = NS.specOfAction, cmdStatusMeta = NS.cmdStatusMeta;

  var T = function (scope, key, fb) { return i18n(scope, key, fb); };

  // 已加载的客户端列表缓存（含 pm2Processes）
  var CLIENT_CACHE = [];
  var CLIENT_CACHE_AT = 0;

  // 服务端 pm2 进程状态中文（本地直控返回，非 meta 状态机，属进程态展示）
  var PROC_STATUS_CN = {
    online: '运行中', stopped: '已停止', stopping: '停止中', launching: '启动中',
    errored: '异常', 'online;errored': '运行异常', 'stopped;errored': '停止异常',
    offline: '离线',
  };
  function procStatusBadge(st) {
    var cn = PROC_STATUS_CN[st] || String(st || '未知');
    var cls = st === 'online' ? 's-normal' : (String(st).indexOf('errored') >= 0 ? 's-revoked' : 's-trial');
    return '<span class="tag ' + cls + '">' + esc(cn) + '</span>';
  }

  // ---------------- 服务端进程 ----------------
  async function renderServerProcesses() {
    var t = $('pmServerTable');
    if (!t) return;
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th>进程名</th><th>状态</th><th>重启次数</th><th>运行时长</th><th>CPU</th><th>内存</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="7" class="loading">加载中…</td></tr>';
    try {
      var d = await api('GET', '/api/admin/ops/pm2/list');
      var list = d.processes || [];
      var meta = $('pmServerMeta');
      if (meta) {
        if (d.error) meta.textContent = 'pm2 不可用：' + d.error;
        else meta.textContent = '共 ' + list.length + ' 个白名单进程';
      }
      if (!list.length) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="7" class="loading">暂无白名单内的服务端进程</td></tr>';
        return;
      }
      t.querySelector('tbody').innerHTML = list.map(function (p, i) {
        var name = p.name || p.pm_id || ('proc-' + i);
        return '<tr>' +
          '<td class="wrap"><b>' + esc(name) + '</b></td>' +
          '<td>' + procStatusBadge(p.status || p.pm2_env && p.pm2_env.status) + '</td>' +
          '<td>' + (p.restarts != null ? esc(String(p.restarts)) : '—') + '</td>' +
          '<td>' + (p.uptime ? fmtDur(Math.floor((Date.now() - p.uptime) / 1000)) : '—') + '</td>' +
          '<td>' + (p.cpu != null ? esc(String(p.cpu) + '%') : '—') + '</td>' +
          '<td>' + (p.memory ? fmtBytes(p.memory) : (p.mem ? fmtBytes(p.mem) : '—')) + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn ghost sm" data-sp="restart" data-name="' + enc(name) + '">重启</button>' +
          '<button class="btn danger sm" data-sp="stop" data-name="' + enc(name) + '">停止</button>' +
          '<button class="btn ghost sm" data-sp="start" data-name="' + enc(name) + '">启动</button>' +
          '<button class="btn ghost sm" data-sp="logs" data-name="' + enc(name) + '">日志</button>' +
          '</td></tr>';
      }).join('');
      t.querySelectorAll('[data-sp]').forEach(function (b) {
        // 日志走 bindPm 里的容器级委托（避免与单行绑定重复触发）
        if (b.dataset.sp === 'logs') return;
        b.addEventListener('click', function () {
          serverProcAction(decodeURIComponent(b.dataset.name), b.dataset.sp);
        });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="7" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  function serverProcAction(name, act) {
    if (!requireWrite('服务端进程「' + name + '」' + ({ restart: '重启', stop: '停止', start: '启动' }[act] || act))) return;
    var label = { restart: '重启', stop: '停止', start: '启动' }[act] || act;
    if (act === 'stop') {
      openModal('确认停止进程',
        '<p>将停止进程 <b>' + esc(name) + '</b>（危险操作，红色二次确认）。</p>' +
        '<div class="cmd-hint">服务端 pm2 直控，操作记录审计（操作人 / 时间 / 目标进程）。</div>', [
        { label: '取消', cls: 'ghost', onClick: closeModal },
        { label: '确认停止', cls: 'danger', onClick: function () { doServerProcAction(name, act); } },
      ]);
      return;
    }
    if (act === 'restart') {
      openModal('确认重启进程',
        '<p>将重启进程 <b>' + esc(name) + '</b>，业务会短暂中断。</p>', [
        { label: '取消', cls: 'ghost', onClick: closeModal },
        { label: '确认重启', cls: 'danger', onClick: function () { doServerProcAction(name, act); } },
      ]);
      return;
    }
    doServerProcAction(name, act);
  }

  async function doServerProcAction(name, act) {
    try {
      var r = await api('POST', '/api/admin/ops/pm2/' + enc(name) + '/action', { action: act });
      toast((r.message || ('已' + ({ restart: '重启', stop: '停止', start: '启动' }[act] || act) + ' ' + name)) + '（已记审计）', 'ok');
      closeModal();
      renderServerProcesses();
    } catch (e) {
      toast('操作失败：' + e.message, 'bad');
    }
  }

  async function serverProcLogs(name) {
    try {
      var r = await api('GET', '/api/admin/ops/pm2/' + enc(name) + '/logs?lines=120');
      var logs = r.logs || '';
      openModal('进程日志：' + name,
        '<div class="cmd-tl-res" style="max-height:420px;white-space:pre-wrap">' + esc(logs || '（无日志输出）') + '</div>', [
        { label: '复制', cls: 'ghost', onClick: function () { NS.copyText(logs || ''); toast('已复制', 'ok'); } },
        { label: '关闭', cls: '', onClick: closeModal },
      ]);
    } catch (e) {
      toast('读取日志失败：' + e.message, 'bad');
    }
  }

  // ---------------- 客户端进程 ----------------
  // [T03 需求5 方案 A]「全部设备」聚合：列表接口带 includeProcesses=1（服务端列表项附
  // pm2Processes 自报快照，含试用设备），进程页默认态不再是空白（设计 §10.5.2）。
  async function loadClients(force) {
    var now = Date.now();
    if (!force && CLIENT_CACHE.length && (now - CLIENT_CACHE_AT) < 20000) return CLIENT_CACHE;
    var d = await api('GET', '/api/admin/fleet/clients?pageSize=500&includeProcesses=1');
    CLIENT_CACHE = Array.isArray(d && d.items) ? d.items : [];
    CLIENT_CACHE_AT = Date.now();
    return CLIENT_CACHE;
  }

  // [T03 修复] 进程数组取数兼容多种字段形态（防止“数据有但不显示”）：
  //   ① item.pm2Processes           —— listClients includeProcesses=1 顶层（标准）
  //   ② item.pm2_processes          —— snake_case 兼容
  //   ③ item.snapshot.pm2Processes  —— 快照内嵌（clientDetail 亦同源）
  //   ④ item.snapshot.pm2_processes —— snake_case + 快照内嵌
  // 兜底返回 []，绝不因字段缺失抛错或留下空白。
  function pickProcesses(item) {
    if (!item || typeof item !== 'object') return [];
    var arr = item.pm2Processes;
    if (!Array.isArray(arr)) arr = item.pm2_processes;
    if (!Array.isArray(arr) && item.snapshot && typeof item.snapshot === 'object') {
      arr = item.snapshot.pm2Processes;
      if (!Array.isArray(arr)) arr = item.snapshot.pm2_processes;
    }
    return Array.isArray(arr) ? arr : [];
  }

  // 试用徽标（复用 s-trial 橙色调；文案走 metaStatus('trialBadge') → I18N 兜底，不硬编码）
  function trialBadgeTag() {
    var m = (NS.metaStatus || function () { return { label: '' }; })('trialBadge', 'trial');
    var label = (m.label && m.label !== 'trial') ? m.label : T('trial', 'label', '试用');
    return '<span class="tag s-trial">' + esc(label) + '</span>';
  }

  function fillPmDeviceFilter(clients) {
    var sel = $('pmDeviceFilter');
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">全部设备</option>' + clients.map(function (c) {
      return '<option value="' + esc(c.machineId) + '"' + (c.machineId === cur ? ' selected' : '') + '>' +
        esc(c.machineId) + (c.qq ? '（' + esc(c.qq) + '）' : '') + '</option>';
    }).join('');
  }

  // 设备单元格：机器码 + QQ 副行 + 试用徽标（试用设备在聚合列表可辨识）
  function deviceCell(mid, isTrial, qq) {
    var html = esc(mid);
    if (qq) html += '<div class="filter-tip">' + esc(qq) + '</div>';
    if (isTrial) html += ' ' + trialBadgeTag();
    return html;
  }

  // 单条进程行（聚合与单设备共用，保证操作按钮/徽标行为一致）
  function clientProcRow(mid, isTrial, qq, p) {
    var name = p.name || p.pm_id || ('proc');
    return '<tr>' +
      '<td class="wrap">' + deviceCell(mid, isTrial, qq) + '</td>' +
      '<td class="wrap"><b>' + esc(name) + '</b></td>' +
      '<td>' + procStatusBadge(p.status || p.pm2_env && p.pm2_env.status) + '</td>' +
      '<td>' + (p.restarts != null ? esc(String(p.restarts)) : '—') + '</td>' +
      '<td>' + (p.uptime ? fmtDur(Math.floor((Date.now() - p.uptime) / 1000)) : '—') + '</td>' +
      '<td>' + (p.cpu != null ? esc(String(p.cpu) + '%') : '—') + '</td>' +
      '<td>' + (p.memory ? fmtBytes(p.memory) : (p.mem ? fmtBytes(p.mem) : '—')) + '</td>' +
      '<td class="row-actions">' +
      '<button class="btn ghost sm" data-cp="pm2_restart" data-mid="' + enc(mid) + '" data-name="' + enc(name) + '">重启</button>' +
      '<button class="btn danger sm" data-cp="pm2_stop" data-mid="' + enc(mid) + '" data-name="' + enc(name) + '">停止</button>' +
      '<button class="btn ghost sm" data-cp="pm2_start" data-mid="' + enc(mid) + '" data-name="' + enc(name) + '">启动</button>' +
      '<button class="btn ghost sm" data-cp="pm2_logs" data-mid="' + enc(mid) + '" data-name="' + enc(name) + '">日志</button>' +
      '</td></tr>';
  }

  // 无进程设备行：「无进程上报」替代空白（设计 §10.5.2：无进程的设备不显示空白）
  function noProcRow(mid, isTrial, qq, tipText) {
    return '<tr><td class="wrap">' + deviceCell(mid, isTrial, qq) + '</td>' +
      '<td colspan="7" class="filter-tip">' + esc(tipText) + '</td></tr>';
  }

  async function renderClientProcesses() {
    var t = $('pmClientTable');
    if (!t) return;
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th>设备</th><th>进程名</th><th>状态</th><th>重启次数</th><th>运行时长</th><th>CPU</th><th>内存</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">加载中…</td></tr>';
    var hintEl = $('pmClientHint');
    if (hintEl) hintEl.textContent = T('pm', 'allHint', '数据来自各设备自报快照（含试用设备），选择设备可精准操作');
    try {
      await NS.ensureMeta();
      var clients = await loadClients(false);
      if (!Array.isArray(clients)) clients = []; // 防御：接口异常形态绝不抛错
      fillPmDeviceFilter(clients);
      var filter = ($('pmDeviceFilter') || {}).value || '';
      var htmlRows = '';
      if (filter) {
        // 单设备模式：走 clientDetail（行为不变，详情含 pm2Processes/isTrial）
        var det = await api('GET', '/api/admin/fleet/clients/' + enc(filter));
        var procs = pickProcesses(det);
        if (procs.length) {
          procs.forEach(function (p) { htmlRows += clientProcRow(filter, !!det.isTrial, det.qq || '', p); });
        } else {
          htmlRows += noProcRow(filter, !!det.isTrial, det.qq || '', T('pm', 'emptyProcesses', '该设备未上报进程'));
        }
      } else {
        // [T03 需求5 方案 A]「全部设备」聚合（含试用）：遍历列表项自报快照直出进程行；
        // 无进程的设备也显示「无进程上报」而非空白。
        var noProc = [];
        clients.forEach(function (c) {
          var procs = pickProcesses(c);
          if (procs.length) {
            procs.forEach(function (p) { htmlRows += clientProcRow(c.machineId, !!c.isTrial, c.qq || '', p); });
          } else {
            noProc.push(c);
          }
        });
        if (!htmlRows && !noProc.length) {
          t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">' +
            T('pm', 'clientNone', '暂无客户端上报 PM2 进程') + '</td></tr>';
          return;
        }
        noProc.forEach(function (c) {
          htmlRows += noProcRow(c.machineId, !!c.isTrial, c.qq || '', T('pm', 'noProcessReported', '无进程上报'));
        });
      }
      // 兜底：即便极端形态下没有产出任何行，也绝不留下空白表格
      if (!htmlRows) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">' +
          T('pm', 'clientNone', '暂无客户端上报 PM2 进程') + '</td></tr>';
        return;
      }
      t.querySelector('tbody').innerHTML = htmlRows;
      t.querySelectorAll('[data-cp]').forEach(function (b) {
        b.addEventListener('click', function () {
          clientProcAction(decodeURIComponent(b.dataset.mid), decodeURIComponent(b.dataset.name), b.dataset.cp);
        });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  function clientProcAction(mid, name, action) {
    if (!requireWrite('客户端进程「' + name + '」' + ({ pm2_restart: '重启', pm2_stop: '停止', pm2_start: '启动', pm2_logs: '日志' }[action] || action))) return;
    var spec = specOfAction(action);
    var label = spec.label || action;
    var payload = { processName: name };
    if (action === 'pm2_logs') payload.lines = 120;
    if (spec.dangerous) {
      NS.confirmDangerous(spec, '客户端 <b>' + esc(mid) + '</b> 进程 <b>' + esc(name) + '</b>', function (word) {
        runClientCmd(mid, action, payload, label, word || null);
      });
    } else {
      openModal('确认下发：' + label,
        '<p>将向客户端 <b>' + esc(mid) + '</b> 下发 <b>' + esc(label + ' (' + action + ')') + '</b>，目标进程 <b>' + esc(name) + '</b>。</p>' +
        '<div class="cmd-hint">经既有指令通道（心跳 pull + ack_results），结果实时回显，操作记录审计。</div>', [
        { label: '取消', cls: 'ghost', onClick: closeModal },
        { label: '确认下发', cls: '', onClick: function () { runClientCmd(mid, action, payload, label, null); } },
      ]);
    }
  }

  function runClientCmd(mid, action, payload, label, confirmWord) {
    var body = { action: action, payload: payload || {} };
    if (confirmWord) body.confirm = confirmWord;
    api('POST', '/api/admin/fleet/clients/' + enc(mid) + '/command', body)
      .then(function (r) {
        closeModal();
        toast('已下发：' + label + '（' + (r.commandId || '') + '），等待客户端回执', 'ok');
        pollCmdResult(mid, r.commandId, label);
      })
      .catch(function (e) { toast('下发失败：' + e.message, 'bad'); });
  }

  // 轮询指令终态（复用 console.api 轮询助手，CmdTracker 模式）
  function pollCmdResult(mid, commandId, label) {
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
          renderClientProcesses();
        }
      });
    }, null, 22); // 最长约 66s
    p.start();
  }

  async function clientProcLogs(mid, name) {
    var spec = specOfAction('pm2_logs');
    var payload = { processName: name, lines: 120 };
    try {
      var r = await api('POST', '/api/admin/fleet/clients/' + enc(mid) + '/command', { action: 'pm2_logs', payload: payload });
      var commandId = r.commandId;
      openModal('进程日志：' + name + '（' + mid + '）',
        '<div class="cmd-tl-res" style="max-height:420px;white-space:pre-wrap">等待客户端回执…</div>', [
        { label: '关闭', cls: '', onClick: closeModal },
      ]);
      var box = $('modalBody').querySelector('.cmd-tl-res');
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
            var txt = '';
            if (c.result != null) {
              var rr = typeof c.result === 'string' ? c.result : JSON.stringify(c.result, null, 2);
              txt = rr;
            } else if (c.error) {
              txt = '错误：' + c.error;
            }
            var stMeta = cmdStatusMeta(c.status);
            var body = $('modalBody');
            if (body) body.innerHTML = '<div class="cmd-tl-res" style="max-height:420px;white-space:pre-wrap">' +
              esc(txt || ('（无日志输出，状态：' + stMeta.label + '）')) + '</div>';
          }
        });
      }, null, 22);
      p.start();
    } catch (e) {
      toast('下发日志指令失败：' + e.message, 'bad');
    }
  }

  // ---------------- 绑定 + 注册 ----------------
  function bindPm() {
    var sRef = $('pmServerRefresh'); if (sRef) sRef.addEventListener('click', renderServerProcesses);
    var cRef = $('pmClientRefresh'); if (cRef) cRef.addEventListener('click', function () { loadClients(true).then(renderClientProcesses); });
    var filter = $('pmDeviceFilter'); if (filter) filter.addEventListener('change', renderClientProcesses);
    var logs = $('pmServerTable');
    if (logs) logs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-sp]') : null;
      if (b && b.dataset.sp === 'logs') {
        e.preventDefault();
        serverProcLogs(decodeURIComponent(b.dataset.name));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindPm);
  } else {
    bindPm();
  }

  NS.registerView('process', function () {
    renderServerProcesses();
    renderClientProcesses();
  });
})();
