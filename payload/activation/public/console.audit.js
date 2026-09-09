'use strict';
/**
 * public/console.audit.js — 审计中心视图（T04 + [T2 P2-12] 机器身份分区）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §2.2 / §7.5
 *  - 三类审计：op（操作）/ cmd（指令）/ highrisk（高危，单独高亮）
 *  - [T2 P2-12] 第四类 machine（机器身份）：合并风险面板 + 机器身份审计日志
 *  - 检索：时间范围 / 操作人 / 设备 / 动作 / 状态（GET /api/admin/ops/audit/:kind）
 *  - CSV 导出：带鉴权头 fetch → Blob → 下载（UTF-8 BOM，Excel 中文不乱码）
 *
 * 依赖 window.ConsoleApp；按序 <script> 引入。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var NS = window.ConsoleApp || {};
  if (!NS.registerView || !NS.api) return;

  var api = NS.api, $ = NS.$, esc = NS.esc, toast = NS.toast;
  var fmtTime = NS.fmtTime, enc = NS.enc, qs = NS.qs;
  var exportCsv = NS.exportCsv;
  var i18n = NS.i18n || function (s, k, f) { return f !== undefined ? f : String(k); };

  var T = function (scope, key, fb) { return i18n(scope, key, fb); };
  var AU = function (key, fb) { return T('audit', key, fb); };
  var HR = function (key, fb) { return T('highrisk', key, fb); };

  var currentKind = 'op';

  // 指令六态中文由 meta 驱动；此处仅作为展示兜底（不参与危险级判定）
  function statusCn(kind, st) {
    if (kind === 'cmd') {
      var m = NS.cmdStatusMeta ? NS.cmdStatusMeta(st) : null;
      if (m && m.label) return m.label;
      return String(st || '—');
    }
    if (kind === 'highrisk') {
      var map = {
        created: '已创建', issued: '已签发', 'local-confirmed': '本地已确认',
        done: '已完成', failed: '执行失败', rejected: '已拒绝',
      };
      return map[st] || String(st || '—');
    }
    if (kind === 'machine') {
      // 机器身份审计：status 字段未使用，动作经 action 展示
      return '';
    }
    // op 审计结果列：ok 布尔
    return '';
  }

  function levelCn(level) {
    var map = { data: '数据分区', factory: '恢复出厂', disk: '整盘擦除' };
    return map[level] || String(level || '—');
  }

  // [T2 P2-12] 机器身份动作中文
  function machineActionCn(action) {
    var map = {
      'identity-risk': AU('machActionRisk', '风险事件'),
      'merge-confirm': AU('machActionConfirm', '确认合并'),
      'merge-ignore': AU('machActionIgnore', '强制改绑'),
    };
    return map[action] || String(action || '—');
  }

  function machineDecisionCn(d) {
    if (d === 'same-device') return AU('machDecisionSame', '同一设备');
    if (d === 'force-rebind') return AU('machDecisionRebind', '强制改绑');
    return String(d || '—');
  }

  function summaryOf(entry, kind) {
    if (kind === 'cmd') {
      if (entry.result != null) {
        var rr = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result);
        return rr.slice(0, 200);
      }
      if (entry.error) return '错误：' + entry.error;
      return '—';
    }
    if (kind === 'highrisk') {
      if (entry.result != null) {
        var hr = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result);
        return hr.slice(0, 200);
      }
      if (entry.status === 'failed' && entry.detail) return entry.detail;
      return '—';
    }
    if (kind === 'machine') {
      return entry.detail != null ? String(entry.detail) : '—';
    }
    // op
    if (entry.before !== undefined && entry.before !== null || entry.after !== undefined && entry.after !== null) {
      var parts = [];
      if (entry.before !== undefined && entry.before !== null) parts.push('旧：' + JSON.stringify(entry.before));
      if (entry.after !== undefined && entry.after !== null) parts.push('新：' + JSON.stringify(entry.after));
      return parts.join(' → ');
    }
    return entry.detail != null ? String(entry.detail) : '—';
  }

  function buildFilter() {
    var f = {};
    var fromVal = ($('audFrom') || {}).value;
    var toVal = ($('audTo') || {}).value;
    if (fromVal) f.fromTs = Math.floor(new Date(fromVal).getTime() / 1000);
    if (toVal) f.toTs = Math.floor(new Date(toVal).getTime() / 1000);
    var op = (($('audOperator') || {}).value || '').trim(); if (op) f.operator = op;
    var dev = (($('audDevice') || {}).value || '').trim(); if (dev) f.mid = dev;
    var act = (($('audAction') || {}).value || '').trim(); if (act) f.action = act;
    var st = (($('audStatus') || {}).value || '');
    // [T2 P2-12] machine 类型：状态下拉实际筛选 action（机器身份记录无 status 字段）
    if (currentKind === 'machine') { if (st) f.action = st; }
    else if (st) f.status = st;
    f.page = 1;
    f.pageSize = 100;
    return f;
  }

  function fillStatusSelect() {
    var sel = $('audStatus');
    if (!sel) return;
    if (currentKind === 'cmd') {
      var opts = [['', '全部状态'], ['pending', '待下发'], ['sent', '已下发'], ['acked', '已确认'], ['failed', '执行失败'], ['unsupported', '未支持'], ['timeout', '超时']];
      sel.innerHTML = opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>';
      }).join('');
    } else if (currentKind === 'highrisk') {
      var opts2 = [['', '全部状态'], ['created', '已创建'], ['issued', '已签发'], ['local-confirmed', '本地已确认'], ['done', '已完成'], ['failed', '执行失败'], ['rejected', '已拒绝']];
      sel.innerHTML = opts2.map(function (o) {
        return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>';
      }).join('');
    } else if (currentKind === 'machine') {
      var opts3 = [['', '全部动作'], ['identity-risk', '风险事件'], ['merge-confirm', '确认合并'], ['merge-ignore', '强制改绑']];
      sel.innerHTML = opts3.map(function (o) {
        return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + '</option>';
      }).join('');
    } else {
      sel.innerHTML = '<option value="">全部结果</option><option value="ok">成功</option><option value="fail">失败</option>';
    }
  }

  // [T2 P2-12] 合并风险面板：拉取客户端列表，筛 mergeRisk=true，渲染卡片 + L3 操作按钮
  async function renderMachinePanel() {
    var panel = $('machineRiskPanel');
    if (!panel) return;
    if (currentKind !== 'machine') { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="loading">加载合并风险…</div>';
    try {
      var d = await api('GET', '/api/admin/fleet/clients?pageSize=500');
      var items = (d.items || []).filter(function (x) { return x.mergeRisk; });
      if (!items.length) {
        panel.innerHTML = '<div class="toolbar" style="margin:0 0 10px"><h3 class="sect" style="margin:0">' + esc(AU('machSectionTitle', '合并风险')) + '</h3><span class="filter-tip">' + esc(AU('machNoRisk', '暂无合并风险')) + '</span></div>';
        return;
      }
      panel.innerHTML = '<div class="toolbar" style="margin:0 0 10px"><h3 class="sect" style="margin:0">' + esc(AU('machSectionTitle', '合并风险')) + '</h3><span class="filter-tip">' + esc(AU('machRiskCount', '{n} 台设备存在唯一性风险，待人工合并').replace('{n}', String(items.length))) + '</span></div>';
      panel.innerHTML += '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>' + esc(AU('machColMachine', '机器码')) + '</th>' +
        '<th>' + esc(AU('machColReason', '风险原因')) + '</th>' +
        '<th>' + esc(AU('machColCount', '风险次数')) + '</th>' +
        '<th>' + esc(T('common', 'actions', '操作')) + '</th></tr></thead><tbody>' +
        items.map(function (x) {
          return '<tr>' +
            '<td class="wrap">' + esc(x.machineId) + '</td>' +
            '<td class="wrap">' + esc(x.riskReason || '—') + '</td>' +
            '<td>' + esc(String(x.mergeRiskCount || 0)) + '</td>' +
            '<td class="row-actions">' +
            '<button class="btn sm" data-merge-action="confirm" data-mid="' + esc(x.machineId) + '" data-count="' + esc(String(x.mergeRiskCount || 0)) + '">' + esc(AU('machConfirm', '确认同一设备')) + '</button>' +
            '<button class="btn sm danger" data-merge-action="ignore" data-mid="' + esc(x.machineId) + '" data-count="' + esc(String(x.mergeRiskCount || 0)) + '">' + esc(AU('machIgnore', '标记不同设备（强制改绑）')) + '</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } catch (e) {
      panel.innerHTML = '<div class="toolbar" style="margin:0 0 10px"><h3 class="sect" style="margin:0">' + esc(AU('machSectionTitle', '合并风险')) + '</h3><span class="filter-tip">加载失败：' + esc(e.message) + '</span></div>';
    }
  }

  // [T2 P2-12] 机器身份人工合并（仅 L3；二次确认后调用）
  function doMergeAction(action, mid, count) {
    var isIgnore = action === 'ignore';
    var title = isIgnore ? AU('machIgnoreTitle', '强制改绑（不同设备）') : AU('machConfirmTitle', '确认合并（同一设备）');
    var body = isIgnore
      ? AU('machIgnoreBody', '确认 <b>{mid}</b> 已换到另一台物理设备？将以当前特征为新基线强制改绑，并写入审计。危险操作，仅 L3 可执行。').replace('{mid}', esc(mid))
      : AU('machConfirmBody', '确认 <b>{mid}</b> 为同一台设备？将保留主记录、归档 {count} 条风险，并写入审计。').replace('{mid}', esc(mid)).replace('{count}', String(count || 0));
    NS.openModal(title, body, [
      { label: T('common', 'cancel', '取消'), cls: 'ghost', onClick: function () { NS.closeModal(); } },
      {
        label: isIgnore ? AU('machIgnore', '强制改绑') : AU('machConfirm', '确认合并'),
        cls: isIgnore ? 'danger' : '',
        onClick: function () {
          NS.closeModal();
          var ep = '/api/admin/fleet/clients/' + enc(mid) + '/merge-' + (isIgnore ? 'ignore' : 'confirm');
          api('POST', ep, {}).then(function () {
            toast(AU('machDone', '已处置，风险已归档') + '：' + mid, 'ok');
            renderMachinePanel();
            renderAudit();
          }).catch(function (e) {
            toast('操作失败：' + e.message, 'bad');
          });
        },
      },
    ]);
  }

  async function renderAudit() {
    var t = $('auditTable');
    if (!t) return;
    // [T2 P2-12] machine tab：先渲染合并风险面板，再渲染机器身份审计日志
    if (currentKind === 'machine') {
      await renderMachinePanel();
      var riskPanel = $('machineRiskPanel');
      if (riskPanel) riskPanel.classList.remove('hidden');
    } else {
      var rp = $('machineRiskPanel');
      if (rp) rp.classList.add('hidden');
    }
    fillStatusSelect();
    var headers = currentKind === 'op'
      ? '<tr><th>时间</th><th>操作人</th><th>动作</th><th>实体</th><th>对象</th><th>变更摘要</th><th>结果</th></tr>'
      : (currentKind === 'cmd'
        ? '<tr><th>时间</th><th>操作人</th><th>指令</th><th>目标设备</th><th>状态</th><th>结果摘要</th></tr>'
        : (currentKind === 'machine'
          ? '<tr><th>时间</th><th>操作人</th><th>动作</th><th>机器码</th><th>变化字段</th><th>变更（from → to）</th><th>决策</th><th>结果</th></tr>'
          : '<tr><th>时间</th><th>发起人</th><th>设备</th><th>档位</th><th>状态</th><th>确认词</th><th>验证码</th><th>结果</th></tr>'));
    t.querySelector('thead').innerHTML = headers;
    t.querySelector('tbody').innerHTML = '<tr><td colspan="10" class="loading">加载中…</td></tr>';
    var meta = $('auditMeta');
    if (meta) meta.textContent = '';
    try {
      var f = buildFilter();
      var d = await api('GET', '/api/admin/ops/audit/' + currentKind + (Object.keys(f).length ? '?' + qs(f) : ''));
      var list = d.items || [];
      if (meta) meta.textContent = '共 ' + (d.total || 0) + ' 条（第 ' + (d.page || 1) + ' 页，每页 ' + (d.pageSize || 100) + '）';
      if (!list.length) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="10" class="loading">暂无记录</td></tr>';
        return;
      }
      if (currentKind === 'op') {
        t.querySelector('tbody').innerHTML = list.map(function (r) {
          var ok = r.ok === false ? '<span class="tag s-revoked">失败</span>' : '<span class="tag s-normal">成功</span>';
          return '<tr><td>' + esc(fmtTime(r.tsSec || r.ts)) + '</td>' +
            '<td>' + esc(r.operator || '—') + '</td>' +
            '<td>' + esc(r.action || '—') + '</td>' +
            '<td>' + esc(r.entity || '—') + '</td>' +
            '<td class="wrap">' + esc(r.target || '—') + '</td>' +
            '<td class="wrap">' + esc(summaryOf(r, 'op')) + '</td>' +
            '<td>' + ok + '</td></tr>';
        }).join('');
      } else if (currentKind === 'cmd') {
        t.querySelector('tbody').innerHTML = list.map(function (r) {
          var stMeta = NS.cmdStatusMeta ? NS.cmdStatusMeta(r.status) : null;
          var badge = stMeta && stMeta.badge
            ? '<span class="tag ' + (stMeta.badge === 'ok' ? 's-normal' : (stMeta.badge === 'bad' ? 's-revoked' : 's-trial')) + '">' + esc(stMeta.label || r.status) + '</span>'
            : esc(statusCn('cmd', r.status));
          return '<tr><td>' + esc(fmtTime(r.tsSec || r.ts)) + '</td>' +
            '<td>' + esc(r.operator || '—') + '</td>' +
            '<td class="wrap">' + esc(r.action || '—') + '</td>' +
            '<td class="wrap">' + esc(r.target || '—') + '</td>' +
            '<td>' + badge + '</td>' +
            '<td class="wrap">' + esc(summaryOf(r, 'cmd')) + '</td></tr>';
        }).join('');
      } else if (currentKind === 'machine') {
        t.querySelector('tbody').innerHTML = list.map(function (r) {
          var ok = r.ok === false ? '<span class="tag s-revoked">失败</span>' : '<span class="tag s-normal">成功</span>';
          var change = (r.field ? esc(r.field) : '—');
          var fromTo = (r.from || r.to) ? esc((r.from || '') + ' → ' + (r.to || '')) : '—';
          return '<tr>' +
            '<td>' + esc(fmtTime(r.tsSec || r.ts)) + '</td>' +
            '<td>' + esc(r.operator || '—') + '</td>' +
            '<td>' + esc(machineActionCn(r.action)) + '</td>' +
            '<td class="wrap">' + esc(r.machineId || r.target || '—') + '</td>' +
            '<td>' + change + '</td>' +
            '<td class="wrap">' + fromTo + '</td>' +
            '<td>' + esc(machineDecisionCn(r.decision)) + '</td>' +
            '<td>' + ok + '</td></tr>';
        }).join('');
      } else {
        t.querySelector('tbody').innerHTML = list.map(function (r) {
          return '<tr class="hr-row">' +
            '<td>' + esc(fmtTime(r.tsSec || r.ts)) + '</td>' +
            '<td>' + esc(r.operator || '—') + '</td>' +
            '<td class="wrap">' + esc(r.machineId || r.target || '—') + '</td>' +
            '<td>' + esc(levelCn(r.level)) + '</td>' +
            '<td>' + esc(statusCn('highrisk', r.status)) + '</td>' +
            '<td>' + (r.confirmChecked ? '<span class="tag s-normal">通过</span>' : '<span class="tag s-revoked">未过</span>') + '</td>' +
            '<td>' + (r.totpChecked ? '<span class="tag s-normal">通过</span>' : '<span class="tag s-revoked">未过</span>') + '</td>' +
            '<td class="wrap">' + esc(summaryOf(r, 'highrisk')) + '</td></tr>';
        }).join('');
      }
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="10" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  async function doExport() {
    try {
      await exportCsv(currentKind, buildFilter());
      toast(AU('exported', 'CSV 已导出'), 'ok');
    } catch (e) {
      toast('导出失败：' + e.message, 'bad');
    }
  }

  function bindAudit() {
    document.querySelectorAll('#auditTabs .tab-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        currentKind = b.dataset.kind;
        document.querySelectorAll('#auditTabs .tab-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderAudit();
      });
    });
    var query = $('audQuery'); if (query) query.addEventListener('click', renderAudit);
    var exp = $('audExport'); if (exp) exp.addEventListener('click', doExport);
    var op = $('audOperator'); if (op) op.addEventListener('keydown', function (e) { if (e.key === 'Enter') renderAudit(); });
    var dev = $('audDevice'); if (dev) dev.addEventListener('keydown', function (e) { if (e.key === 'Enter') renderAudit(); });
    var act = $('audAction'); if (act) act.addEventListener('keydown', function (e) { if (e.key === 'Enter') renderAudit(); });

    // [T2 P2-12] 合并风险面板操作按钮：事件委托（面板为动态渲染）
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-merge-action]') : null;
      if (!btn) return;
      e.preventDefault();
      doMergeAction(btn.getAttribute('data-merge-action'), btn.getAttribute('data-mid'), btn.getAttribute('data-count'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAudit);
  } else {
    bindAudit();
  }

  NS.registerView('audit', renderAudit);
})();
