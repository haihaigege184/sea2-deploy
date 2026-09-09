'use strict';
/**
 * public/console.orders.js — 订单审计视图（[T2 P2-11]）
 *
 * 设计依据：sea2 运维系统 T2 需求 P2-11
 *  - 数据源：GET /api/admin/console/orders（富视图，支持 status/qq/limit 筛选）
 *  - 操作端点（L2+，全部写 ops 审计）：
 *      POST   /api/admin/orders/:id/mark-paid   手动改未支付→已支付
 *      POST   /api/admin/orders/:id/issue       手动开通会员（复用 /api/order/issue 同款签发）
 *      POST   /api/admin/orders/:id/revoke      改已支付→未支付并取消会员（吊销已发 code）
 *      DELETE /api/admin/orders/:id             删除任意订单
 *  - 「异常悬挂」= paid 且未 issued（code 为空），服务端派生 hung=true，对账视图高亮。
 *
 * 依赖 window.ConsoleApp；按序 <script> 引入（先于 console.audit.js 亦可，互不依赖）。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var NS = window.ConsoleApp || {};
  if (!NS.registerView || !NS.api) return;

  var api = NS.api, $ = NS.$, esc = NS.esc, toast = NS.toast;
  var fmtTime = NS.fmtTime, enc = NS.enc, qs = NS.qs;
  var i18n = NS.i18n || function (s, k, f) { return f !== undefined ? f : String(k); };
  var T = function (scope, key, fb) { return i18n(scope, key, fb); };
  var OA = function (key, fb) { return T('orderAudit', key, fb); };
  var OAST = function (key, fb) { return T('orderStatus', key, fb); };

  var state = { status: '', q: '' };

  // 状态徽标：优先 meta（/fleet/meta orderStatus），兜底本地字典（meta 未加载/离线）
  function statusMeta(st) {
    // 'hung' 是派生状态（paid 未 issued），不在 meta orderStatus 枚举中，直接本地映射
    if (st === 'hung') return { label: '异常悬挂', badge: 's-revoked' };
    var m = NS.metaStatus ? NS.metaStatus('orderStatus', st) : null;
    if (m && m.label && m.label !== String(st)) return m;
    var fb = {
      pending: ['s-trial', '待支付'],
      'await_verify': ['s-trial', '待核验'],
      paid: ['s-normal', '已支付'],
      issued: ['s-normal', '已签发'],
      expired: ['s-revoked', '已过期'],
      cancelled: ['s-revoked', '已取消'],
      hung: ['s-revoked', '异常悬挂'],
    };
    var f = fb[st] || ['', st || '—'];
    return { label: f[1], badge: f[0] };
  }
  function statusBadge(st, hung) {
    var eff = hung ? 'hung' : st;
    var m = statusMeta(eff);
    return '<span class="tag ' + (m.badge || '') + '">' + esc(m.label) + '</span>';
  }

  function buildFilter() {
    var f = {};
    var st = (($('orderAuditStatus') || {}).value || '');
    if (st) f.status = st;
    var q = (($('orderAuditQ') || {}).value || '').trim();
    if (q) f.qq = q;
    f.limit = 500;
    return f;
  }

  function renderMeta(d) {
    var meta = $('orderAuditMeta');
    if (meta) meta.textContent = '共 ' + (d.orders || []).length + ' 条';
  }

  // 行操作按钮（依据状态派生）
  function actionButtons(o) {
    var btns = [];
    var status = o.status;
    var hung = !!o.hung;
    if (status === 'pending' || status === 'await_verify') {
      btns.push('<button class="btn sm" data-act="mark-paid" data-id="' + esc(o.order_id) + '">' + esc(OA('markPaid', '标记已支付')) + '</button>');
    }
    if (status === 'paid' || hung) {
      btns.push('<button class="btn sm" data-act="issue" data-id="' + esc(o.order_id) + '">' + esc(OA('issue', '开通会员')) + '</button>');
      btns.push('<button class="btn sm danger" data-act="revoke" data-id="' + esc(o.order_id) + '">' + esc(OA('revoke', '取消会员')) + '</button>');
    }
    if (status === 'issued') {
      btns.push('<button class="btn sm danger" data-act="revoke" data-id="' + esc(o.order_id) + '">' + esc(OA('revoke', '取消会员')) + '</button>');
    }
    btns.push('<button class="btn sm ghost" data-act="detail" data-id="' + esc(o.order_id) + '">' + esc(OA('detail', '详情')) + '</button>');
    btns.push('<button class="btn sm danger" data-act="delete" data-id="' + esc(o.order_id) + '">' + esc(OA('delete', '删除')) + '</button>');
    return btns.join(' ');
  }

  async function renderOrderAudit() {
    var t = $('orderAuditTable');
    if (!t) return;
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th>' + esc(OA('colTime', '创建时间')) + '</th>' +
      '<th>' + esc(OA('colOrder', '订单号')) + '</th>' +
      '<th>' + esc(OA('colQq', 'QQ')) + '</th>' +
      '<th>' + esc(OA('colMachine', '机器码')) + '</th>' +
      '<th>' + esc(OA('colPlan', '套餐')) + '</th>' +
      '<th>' + esc(OA('colAmount', '金额')) + '</th>' +
      '<th>' + esc(OA('colStatus', '状态')) + '</th>' +
      '<th>' + esc(OA('colPaidAt', '支付时间')) + '</th>' +
      '<th>' + esc(OA('colIssuedAt', '签发时间')) + '</th>' +
      '<th>' + esc(OA('colCode', '授权码')) + '</th>' +
      '<th>' + esc(OA('colAction', '操作')) + '</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="11" class="loading">加载中…</td></tr>';
    try {
      var f = buildFilter();
      var d = await api('GET', '/api/admin/console/orders?' + qs(f));
      var list = d.orders || [];
      renderMeta(d);
      if (!list.length) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="11" class="loading">' + esc(OA('noData', '暂无订单')) + '</td></tr>';
        return;
      }
      t.querySelector('tbody').innerHTML = list.map(function (o) {
        var rowCls = o.hung ? ' class="hung-row"' : '';
        return '<tr' + rowCls + '>' +
          '<td>' + esc(fmtTime(o.created_at)) + '</td>' +
          '<td class="wrap">' + esc(o.order_id) + '</td>' +
          '<td>' + esc(o.qq || '—') + '</td>' +
          '<td class="wrap">' + esc(o.machine_id || '—') + '</td>' +
          '<td>' + esc(o.planName || o.plan || '—') + '</td>' +
          '<td>' + esc(o.amount != null ? String(o.amount) : '—') + '</td>' +
          '<td>' + statusBadge(o.status, o.hung) + (o.hung ? ' <span class="filter-tip">悬挂</span>' : '') + '</td>' +
          '<td>' + esc(o.paid_at ? fmtTime(o.paid_at) : '—') + '</td>' +
          '<td>' + esc(o.issued_at ? fmtTime(o.issued_at) : '—') + '</td>' +
          '<td class="wrap">' + esc(o.code || '—') + '</td>' +
          '<td class="row-actions">' + actionButtons(o) + '</td></tr>';
      }).join('');
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="11" class="loading">' + esc(OA('loadFailed', '加载失败')) + '：' + esc(e.message) + '</td></tr>';
    }
  }

  // 通用二次确认 + 执行
  function confirmAndRun(orderId, action, titleKey, bodyKey, okLabel, cls, fn) {
    var body = OA(bodyKey, '').replace('{id}', esc(orderId));
    NS.openModal(OA(titleKey, '确认'), body, [
      { label: T('common', 'cancel', '取消'), cls: 'ghost', onClick: function () { NS.closeModal(); } },
      {
        label: OA(okLabel, '确认'),
        cls: cls || '',
        onClick: function () {
          NS.closeModal();
          fn(orderId);
        },
      },
    ]);
  }

  function doMarkPaid(orderId) {
    api('POST', '/api/admin/orders/' + enc(orderId) + '/mark-paid', {}).then(function () {
      toast(OA('marked', '已标记支付，可开通会员'), 'ok');
      renderOrderAudit();
    }).catch(function (e) { toast(OA('opFailed', '操作失败') + '：' + e.message, 'bad'); });
  }

  function doIssue(orderId) {
    api('POST', '/api/admin/orders/' + enc(orderId) + '/issue', {}).then(function (r) {
      toast(OA('issuedOk', '已开通会员') + '：' + (r.code || ''), 'ok');
      renderOrderAudit();
    }).catch(function (e) { toast(OA('opFailed', '操作失败') + '：' + e.message, 'bad'); });
  }

  function doRevoke(orderId) {
    api('POST', '/api/admin/orders/' + enc(orderId) + '/revoke', {}).then(function () {
      toast(OA('revokedOk', '已取消会员并吊销授权码'), 'ok');
      renderOrderAudit();
    }).catch(function (e) { toast(OA('opFailed', '操作失败') + '：' + e.message, 'bad'); });
  }

  function doDelete(orderId) {
    api('DELETE', '/api/admin/orders/' + enc(orderId)).then(function () {
      toast(OA('deletedOk', '订单已删除'), 'ok');
      renderOrderAudit();
    }).catch(function (e) { toast(OA('opFailed', '操作失败') + '：' + e.message, 'bad'); });
  }

  // 订单详情弹窗
  function showDetail(orderId) {
    api('GET', '/api/admin/console/orders?limit=500').then(function (d) {
      var o = (d.orders || []).find(function (x) { return x.order_id === orderId; });
      if (!o) { toast('订单不存在', 'bad'); return; }
      var rows = [
        [OA('fOrder', '订单号'), o.order_id],
        [OA('fQq', 'QQ'), o.qq || '—'],
        [OA('fMachine', '机器码'), o.machine_id || '—'],
        [OA('fPlan', '套餐'), o.planName || o.plan || '—'],
        [OA('fChannel', '渠道'), o.channel || '—'],
        [OA('fAmount', '金额'), o.amount != null ? String(o.amount) : '—'],
        [OA('fStatus', '状态'), statusBadge(o.status, o.hung) + (o.hung ? '（异常悬挂）' : '')],
        [OA('fCreated', '创建时间'), o.created_at ? fmtTime(o.created_at) : '—'],
        [OA('fPaidAt', '支付时间'), o.paid_at ? fmtTime(o.paid_at) : '—'],
        [OA('fIssuedAt', '签发时间'), o.issued_at ? fmtTime(o.issued_at) : '—'],
        [OA('fCode', '授权码'), o.code || '—'],
      ];
      NS.openModal(OA('detailTitle', '订单详情'), '<table class="kv"><tbody>' +
        rows.map(function (r) {
          return '<tr><th>' + esc(r[0]) + '</th><td>' + r[1] + '</td></tr>';
        }).join('') + '</tbody></table>', [
        { label: T('common', 'close', '关闭'), cls: 'ghost', onClick: function () { NS.closeModal(); } },
      ]);
    }).catch(function (e) { toast(OA('loadFailed', '加载失败') + '：' + e.message, 'bad'); });
  }

  function onActionClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    e.preventDefault();
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');
    if (act === 'mark-paid') {
      confirmAndRun(id, act, 'markPaidConfirmTitle', 'markPaidConfirm', 'confirm', '', doMarkPaid);
    } else if (act === 'issue') {
      confirmAndRun(id, act, 'issueConfirmTitle', 'issueConfirm', 'confirm', '', doIssue);
    } else if (act === 'revoke') {
      confirmAndRun(id, act, 'revokeConfirmTitle', 'revokeConfirm', 'confirm', 'danger', doRevoke);
    } else if (act === 'delete') {
      confirmAndRun(id, act, 'deleteConfirmTitle', 'deleteConfirm', 'confirm', 'danger', doDelete);
    } else if (act === 'detail') {
      showDetail(id);
    }
  }

  function bindOrderAudit() {
    var q = $('orderAuditQuery'); if (q) q.addEventListener('click', renderOrderAudit);
    var rf = $('orderAuditRefresh'); if (rf) rf.addEventListener('click', renderOrderAudit);
    var st = $('orderAuditStatus'); if (st) st.addEventListener('change', renderOrderAudit);
    var inp = $('orderAuditQ');
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') renderOrderAudit(); });
    // 行操作按钮：事件委托（表格动态渲染）
    var tbl = $('orderAuditTable');
    if (tbl) tbl.addEventListener('click', onActionClick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindOrderAudit);
  } else {
    bindOrderAudit();
  }

  NS.registerView('order-audit', renderOrderAudit);
})();
