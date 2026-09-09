'use strict';
/**
 * public/console.admin.js — 授权管理 / 设备管理 / 配置中心增强（T04）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §2.2 / §3.5
 *  - 授权管理：codes 实体 CRUD（增/删/改/查）+ 绑定纠正（/api/admin/ops/binding，仅 L3）
 *  - 设备管理：devices 实体 CRUD（备注/分组/机型/格式化白名单标记）
 *  - 配置中心：追加「运维配置键」编辑（configs 实体，热生效/重启后生效标注 + 恢复默认）
 *             与「配置变更历史与回滚」（读 op 审计 crud-update/vars，fleet 键可一键回滚旧值）
 *
 * 依赖 window.ConsoleApp（console.js 已导出）；按序 <script> 引入。
 * 零依赖、零构建；状态值中文仍以 meta 下发为准，本文件只做展示。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var NS = window.ConsoleApp || {};
  if (!NS.registerView || !NS.api) return; // 主控未加载则静默

  var api = NS.api, $ = NS.$, esc = NS.esc, toast = NS.toast;
  var openModal = NS.openModal, closeModal = NS.closeModal;
  var fmtTime = NS.fmtTime, relTime = NS.relTime, enc = NS.enc, qs = NS.qs;
  var requireWrite = NS.requireWrite, getState = NS.getState;
  var metaStatus = NS.metaStatus;
  var crud = NS.crud, i18n = NS.i18n || function (s, k, f) { return f !== undefined ? f : String(k); };

  var T = function (scope, key, fb) { return i18n(scope, key, fb); };
  var common = function (key, fb) { return T('common', key, fb); };

  // ============================================================
  // 授权管理（codes CRUD + 换绑新设备向导）
  // ============================================================

  // 授权码状态取词：metaStatus('deviceStatus', st)（设计 §9.3.2，与设备状态语义表统一）
  function codeStatusTag(st) {
    var m = (metaStatus || function (k, s) { return { label: String(s), badge: 'unknown' }; })('deviceStatus', st);
    return '<span class="tag s-' + esc(m.badge) + '">' + esc(m.label) + '</span>';
  }

  function codeExpireText(rec) {
    var t = rec.expires_at || rec.license_expires_at || 0;
    if (!t) return '永久';
    return fmtTime(t);
  }

  async function renderLicense() {
    var t = $('licenseTable');
    if (!t) return;
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th>授权码</th><th>客户 / QQ</th><th>状态</th><th>到期</th><th>绑定机器</th><th>功能包</th><th>签发时间</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">加载中…</td></tr>';
    try {
      await NS.ensureMeta();
      var q = ($('licQ').value || '').trim();
      var d = await crud('codes').list({ page: 1, pageSize: 100, q: q });
      var list = d.items || [];
      var meta = $('licMeta');
      if (meta) meta.textContent = '共 ' + (d.total || 0) + ' 条';
      if (!list.length) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">暂无授权码</td></tr>';
        return;
      }
      t.querySelector('tbody').innerHTML = list.map(function (c) {
        var bound = c.bound_machine_id ? esc(c.bound_machine_id) : '<span class="filter-tip">未绑定</span>';
        return '<tr><td class="wrap">' + esc(c.code || c.id || '—') + '</td>' +
          '<td>' + esc(c.customer || c.qq || '—') + '</td>' +
          '<td>' + codeStatusTag(c.status) + '</td>' +
          '<td>' + esc(codeExpireText(c)) + '</td>' +
          '<td class="wrap">' + bound + '</td>' +
          '<td class="wrap">' + esc((c.features || []).join('、') || '—') + '</td>' +
          '<td>' + esc(c.created_at ? fmtTime(c.created_at) : (c.issued_at ? fmtTime(c.issued_at) : '—')) + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn ghost sm" data-lic="edit" data-id="' + enc(c.code || c.id) + '">编辑</button>' +
          '<button class="btn danger sm" data-lic="del" data-id="' + enc(c.code || c.id) + '">删除</button>' +
          '</td></tr>';
      }).join('');
      t.querySelectorAll('[data-lic]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.dataset.lic === 'edit') openEditCode(decodeURIComponent(b.dataset.id));
          else openDelCode(decodeURIComponent(b.dataset.id));
        });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="8" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  function openAddCode() {
    if (!requireWrite('新增授权码')) return;
    var body = '<div><label class="ml">客户 / QQ</label><input id="cCustomer" type="text" placeholder="客户名或 QQ" /></div>' +
      '<div><label class="ml">授权码（留空自动生成）</label><input id="cCode" type="text" placeholder="SEA1-XXXX-XXXX-XXXX" /></div>' +
      '<div><label class="ml">有效期（天，0=永久）</label><input id="cDays" type="number" value="365" /></div>' +
      '<div><label class="ml">功能包（逗号分隔）</label><input id="cFeatures" type="text" value="print,a3,batch,web" /></div>' +
      '<div><label class="ml">最大群数</label><input id="cGroups" type="number" value="10" /></div>';
    openModal('新增授权码', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '创建', cls: '', onClick: submitAddCode },
    ]);
  }

  async function submitAddCode() {
    var days = Number(($('cDays') || {}).value || 0);
    var body = {
      customer: ($('cCustomer') || {}).value || '',
      code: ($('cCode') || {}).value || '',
      expires_at: days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0,
      features: (($('cFeatures') || {}).value || 'print,a3,batch,web').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
      max_groups: Number(($('cGroups') || {}).value || 10),
    };
    try {
      var r = await crud('codes').create(body);
      toast('已创建授权码：' + (r.record && r.record.code || ''), 'ok');
      closeModal();
      renderLicense();
    } catch (e) {
      toast('创建失败：' + e.message, 'bad');
    }
  }

  function openEditCode(id) {
    if (!requireWrite('编辑授权码')) return;
    var body = '<p>编辑授权码 <b>' + esc(id) + '</b>（code/status/绑定机器不可经此处修改，绑定纠正请用「绑定纠正」）。</p>' +
      '<div><label class="ml">客户 / QQ</label><input id="cCustomer" type="text" placeholder="客户名或 QQ" /></div>' +
      '<div><label class="ml">有效期（天，0=永久；留空保持不变）</label><input id="cDays" type="number" placeholder="如 365" /></div>' +
      '<div><label class="ml">功能包（逗号分隔，留空保持不变）</label><input id="cFeatures" type="text" placeholder="print,a3,batch,web" /></div>' +
      '<div><label class="ml">最大群数</label><input id="cGroups" type="number" placeholder="如 10" /></div>';
    openModal('编辑授权码', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '保存', cls: '', onClick: function () { submitEditCode(id); } },
    ]);
  }

  async function submitEditCode(id) {
    var body = {};
    var customer = (($('cCustomer') || {}).value || '').trim();
    var days = (($('cDays') || {}).value || '').trim();
    var features = (($('cFeatures') || {}).value || '').trim();
    var groups = (($('cGroups') || {}).value || '').trim();
    if (customer) body.customer = customer;
    if (days !== '') body.expires_at = (Number(days) > 0 ? Math.floor(Date.now() / 1000) + Number(days) * 86400 : 0);
    if (features) body.features = features.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (groups !== '') body.max_groups = Number(groups);
    if (!Object.keys(body).length) { toast('请至少填写一个字段', 'warn'); return; }
    try {
      await crud('codes').update(id, body);
      toast('已保存授权码', 'ok');
      closeModal();
      renderLicense();
    } catch (e) {
      toast('保存失败：' + e.message, 'bad');
    }
  }

  function openDelCode(id) {
    if (!requireWrite('删除授权码')) return;
    openModal('确认删除授权码',
      '<p>确认删除授权码 <b>' + esc(id) + '</b>？将标记为已删除并写入审计（软删）。</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认删除', cls: 'danger', onClick: function () { doDelCode(id); } },
    ]);
  }

  async function doDelCode(id) {
    try {
      await crud('codes').remove(id);
      toast('已删除授权码', 'ok');
      closeModal();
      renderLicense();
    } catch (e) {
      toast('删除失败：' + e.message, 'bad');
    }
  }

  // ============================================================
  // 换绑新设备向导（设计 §9.2.2）：绑定纠正升级为「先查后换」
  // ①输入授权码 → ②GET lookup 展示旧设备绑定信息（警告：旧设备将立即失效）
  // → ③输入新设备机器码（可选旧机器二次校验）→ ④POST 换绑 → ⑤toast + 刷新 + 审计提示
  // 词条走 I18N.rebind，复用既有 modal，零新增依赖。
  // ============================================================
  var REBIND_STATE = { step: 1, code: '', oldInfo: null };

  function openBinding() {
    var st = getState ? getState() : { level: 0 };
    if (st.level < 3) { toast(T('rebind', 'title', '换绑新设备') + '（仅 L3 超管）', 'warn'); return; }
    REBIND_STATE = { step: 1, code: '', oldInfo: null };
    rebindRenderStep(1);
  }

  // 渲染向导当前步（复用既有 modal：改标题/正文/底部按钮即完成步进切换）
  function rebindRenderStep(step) {
    REBIND_STATE.step = step;
    var steps = [
      T('rebind', 'stepCode', '第 1 步 · 输入授权码'),
      T('rebind', 'stepLookup', '第 2 步 · 核对旧设备绑定'),
      T('rebind', 'stepNew', '第 3 步 · 输入新设备机器码'),
      T('rebind', 'stepDone', '第 4 步 · 完成换绑'),
    ];
    var stepBar = '<div class="rebind-steps">' + steps.map(function (s, i) {
      return '<span class="rebind-step' + (i + 1 === step ? ' on' : '') + '">' + esc(s) + '</span>';
    }).join('') + '</div>';
    var title = T('rebind', 'title', '换绑新设备');

    if (step === 1) {
      var body1 = stepBar +
        '<p class="rebind-warn">⚠ ' + esc(T('rebind', 'warn', '换绑后旧设备将立即失效，仅新设备可激活使用；全程审计。')) + '</p>' +
        '<div><label class="ml">' + esc(T('rebind', 'codePh', '输入授权码（如 SEA2-XXXX）')) + '</label>' +
        '<input id="bCode" type="text" placeholder="SEA2-XXXX" autocomplete="off" /></div>';
      openModal(title, body1, [
        { label: common('cancel', '取消'), cls: 'ghost', onClick: closeModal },
        { label: T('rebind', 'lookupBtn', '查询绑定信息'), cls: '', onClick: rebindLookup },
      ]);
      return;
    }

    if (step === 2) {
      var info = REBIND_STATE.oldInfo || {};
      var rows = [
        ['授权码', info.code || '—'],
        [T('rebind', 'oldBound', '当前绑定机器'), info.bound_machine_id || T('rebind', 'notBound', '（未绑定）')],
        [T('rebind', 'statusLabel', '授权状态'), info.status || '—'],
        [T('rebind', 'expires', '到期时间'), info.expires_at ? fmtTime(info.expires_at) : T('rebind', 'forever', '永久')],
        [T('rebind', 'customer', '客户 / QQ'), info.customer || '—'],
      ];
      var body2 = stepBar +
        '<div class="rebind-oldbox">' + rows.map(function (r) {
          return '<div class="kv"><span class="k">' + esc(r[0]) + '</span><span class="v">' + esc(r[1]) + '</span></div>';
        }).join('') + '</div>' +
        '<p class="rebind-warn">⚠ ' + esc(T('rebind', 'warn', '换绑后旧设备将立即失效，仅新设备可激活使用；全程审计。')) + '</p>';
      openModal(title, body2, [
        { label: common('cancel', '取消'), cls: 'ghost', onClick: closeModal },
        { label: T('rebind', 'back', '返回上一步'), cls: 'ghost', onClick: function () { rebindRenderStep(1); } },
        { label: T('rebind', 'next', '下一步'), cls: '', onClick: function () { rebindRenderStep(3); } },
      ]);
      return;
    }

    if (step === 3) {
      var info3 = REBIND_STATE.oldInfo || {};
      var body3 = stepBar +
        '<div class="rebind-oldbox"><div class="kv"><span class="k">' + esc(T('rebind', 'oldBound', '当前绑定机器')) + '</span>' +
        '<span class="v">' + esc(info3.bound_machine_id || T('rebind', 'notBound', '（未绑定）')) + '</span></div></div>' +
        '<div><label class="ml">' + esc(T('rebind', 'newDeviceLabel', '新设备机器码')) + '（必填）</label>' +
        '<input id="bMid" type="text" placeholder="' + esc(T('rebind', 'newDevicePh', '输入新设备机器码（≤128，建议前缀 SEA2-）')) + '" autocomplete="off" /></div>' +
        '<div><label class="ml">' + esc(T('rebind', 'oldMachineOptional', '（可选）输入旧设备机器码二次校验')) + '</label>' +
        '<input id="bOld" type="text" placeholder="' + esc(T('rebind', 'oldDeviceLabel', '旧设备（换绑后立即失效）')) + '" autocomplete="off" /></div>' +
        '<div class="cmd-hint">' + esc(T('rebind', 'auditHint', '该操作将写入审计记录（binding-correct / rebind-replacement）。')) + '</div>';
      openModal(title, body3, [
        { label: common('cancel', '取消'), cls: 'ghost', onClick: closeModal },
        { label: T('rebind', 'back', '返回上一步'), cls: 'ghost', onClick: function () { rebindRenderStep(2); } },
        { label: T('rebind', 'confirm', '确认换绑'), cls: 'danger', onClick: rebindSubmit },
      ]);
      return;
    }
  }

  // ② GET /api/admin/ops/binding/lookup?code= —— 先查后换，展示旧设备绑定信息
  async function rebindLookup() {
    var code = (($('bCode') || {}).value || '').trim();
    if (!code) { toast(T('rebind', 'empty', '请填写授权码与新设备机器码'), 'warn'); return; }
    try {
      var r = await api('GET', '/api/admin/ops/binding/lookup?code=' + encodeURIComponent(code));
      if (!r || !r.ok) { toast((r && r.error) || T('rebind', 'notFound', '授权码不存在'), 'bad'); return; }
      REBIND_STATE.code = r.code || code;
      REBIND_STATE.oldInfo = r;
      rebindRenderStep(2);
    } catch (e) {
      var msg = String((e && e.message) || '');
      toast(/not.?found|不存在|404/i.test(msg) ? T('rebind', 'notFound', '授权码不存在') : (msg || T('rebind', 'notFound', '授权码不存在')), 'bad');
    }
  }

  // ④ POST /api/admin/ops/binding —— 换绑（可选 oldMachineId 二次校验，防误换）
  async function rebindSubmit() {
    var mid = (($('bMid') || {}).value || '').trim();
    var code = REBIND_STATE.code || '';
    if (!code || !mid) { toast(T('rebind', 'empty', '请填写授权码与新设备机器码'), 'warn'); return; }
    if (mid.length > 128) { toast(T('rebind', 'newDevicePh', '输入新设备机器码（≤128，建议前缀 SEA2-）'), 'warn'); return; }
    var old = (($('bOld') || {}).value || '').trim();
    var payload = { code: code, machineId: mid };
    if (old) payload.oldMachineId = old;
    try {
      var r = await api('POST', '/api/admin/ops/binding', payload);
      toast(T('rebind', 'success', '换绑成功，旧设备已失效') + '（' + (r.code || code) + '）', 'ok');
      closeModal();
      renderLicense();
    } catch (e) {
      var em = String((e && e.message) || '');
      if (em.indexOf('old-machine-mismatch') >= 0) toast(T('rebind', 'mismatch', '旧设备机器码不匹配，已拒绝换绑'), 'bad');
      else toast(em || T('rebind', 'success', '换绑成功，旧设备已失效') + '失败', 'bad');
    }
  }

  // ============================================================
  // 设备管理（devices CRUD；[T03 需求5 方案 B] 自动纳入集群心跳设备（含试用））
  // ============================================================
  function devStatusCn(st) {
    var map = {
      archived: '仅档案', normal: '正常', disabled: '已禁用', blacklisted: '已拉黑', unknown: '未知',
      activated: '已激活', revoked: '已吊销', expired: '已过期', trial: '试用',
      // [T03] fleet 自动纳入设备的连接态（与集群管理连接四态语义一致）
      online: '在线', stale: '掉线', offline: '离线', unreported: '未上报',
    };
    return map[st] || String(st || '未知');
  }

  // 试用徽标（复用 s-trial 橙色调；文案走 metaStatus('trialBadge') → I18N 兜底，不硬编码）
  function trialBadgeTag() {
    var m = (NS.metaStatus || function () { return { label: '' }; })('trialBadge', 'trial');
    var label = (m.label && m.label !== 'trial') ? m.label : T('trial', 'label', '试用');
    return '<span class="tag s-trial">' + esc(label) + '</span>';
  }

  // 来源徽标：[T03] fleet 自动纳入 → 心跳设备；试用设备在「试用」列单独展示
  function devSourceTag(x) {
    if (x.source === 'fleet') {
      return '<span class="tag s-trial">' + esc(T('admin', 'sourceFleet', '心跳设备')) + '</span>';
    }
    return '<span class="filter-tip">—</span>';
  }

  // 连接列：metaStatus('connectivity', …) 取词（meta 未加载时 I18N 兜底）；
  // 徽标复用集群管理的 dot+st 模式（dot.online/st-stale/st-unreported 等，样式齐全）
  function devConnTag(conn) {
    if (!conn) return '<span class="filter-tip">—</span>';
    var m = NS.metaStatus('connectivity', conn);
    var badge = (m.badge && m.badge !== 'unknown') ? m.badge : 'unknown';
    return '<span class="dot ' + esc(badge) + '"></span>' +
      '<span class="st-' + esc(badge) + '">' + esc(m.label) + '</span>';
  }

  async function renderDevicesOps() {
    var t = $('devicesOpsTable');
    if (!t) return;
    t.querySelector('thead').innerHTML = '<tr>' +
      '<th>机器码</th><th>来源</th><th>QQ</th><th>状态</th><th>试用</th><th>连接</th><th>最近心跳</th><th>版本</th>' +
      '<th>分组</th><th>机型</th><th>格式化白名单</th><th>备注</th><th>档案更新</th><th>操作</th></tr>';
    t.querySelector('tbody').innerHTML = '<tr><td colspan="14" class="loading">加载中…</td></tr>';
    try {
      await NS.ensureMeta();
      var q = ($('devQ').value || '').trim();
      var d = await crud('devices').list({ page: 1, pageSize: 100, q: q });
      var list = d.items || [];
      if (!list.length) {
        t.querySelector('tbody').innerHTML = '<tr><td colspan="14" class="loading">暂无设备（含自动纳入的心跳设备）</td></tr>';
        return;
      }
      t.querySelector('tbody').innerHTML = list.map(function (x) {
        var mid = x.machine_id || x.machineId || x.id;
        var wl = x.whitelisted === true;
        var hbAt = x.last_heartbeat && x.last_heartbeat.at ? fmtTime(x.last_heartbeat.at) : '<span class="filter-tip">—</span>';
        return '<tr><td class="wrap">' + esc(mid) + '</td>' +
          '<td>' + devSourceTag(x) + '</td>' +
          '<td>' + esc(x.qq || '—') + '</td>' +
          '<td>' + esc(devStatusCn(x.status)) + '</td>' +
          '<td>' + (x.isTrial ? trialBadgeTag() : '<span class="filter-tip">—</span>') + '</td>' +
          '<td>' + devConnTag(x.connectivity) + '</td>' +
          '<td>' + hbAt + '</td>' +
          '<td>' + esc(x.version || '—') + '</td>' +
          '<td>' + esc(x.group || '—') + '</td>' +
          '<td>' + esc(x.model || '—') + '</td>' +
          '<td>' + (wl ? '<span class="tag s-normal">白名单</span>' : '<span class="filter-tip">否</span>') + '</td>' +
          '<td class="wrap">' + esc(x.remark || '—') + '</td>' +
          '<td>' + (x.profileUpdatedAt ? relTime(x.profileUpdatedAt) : '—') + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn ghost sm" data-dev="edit" data-id="' + enc(mid) + '">编辑</button>' +
          '<button class="btn danger sm" data-dev="del" data-id="' + enc(mid) + '">删除</button>' +
          '</td></tr>';
      }).join('');
      t.querySelectorAll('[data-dev]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (b.dataset.dev === 'edit') openEditDevice(decodeURIComponent(b.dataset.id));
          else openDelDevice(decodeURIComponent(b.dataset.id));
        });
      });
    } catch (e) {
      t.querySelector('tbody').innerHTML = '<tr><td colspan="14" class="loading">加载失败：' + esc(e.message) + '</td></tr>';
    }
  }

  function openAddDevice() {
    if (!requireWrite('新增设备档案')) return;
    var body = '<div><label class="ml">机器码（必填）</label><input id="dMid" type="text" placeholder="机器码" /></div>' +
      '<div><label class="ml">备注</label><input id="dRemark" type="text" placeholder="备注（≤500 字）" /></div>' +
      '<div><label class="ml">分组</label><input id="dGroup" type="text" placeholder="分组（≤100 字）" /></div>' +
      '<div><label class="ml">机型</label><input id="dModel" type="text" placeholder="机型（≤200 字）" /></div>' +
      '<div><label class="switch"><input id="dWl" type="checkbox" /><span class="track"></span><span class="state">标记为格式化白名单机型</span></label></div>';
    openModal('新增设备档案', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '创建', cls: '', onClick: submitAddDevice },
    ]);
  }

  async function submitAddDevice() {
    var mid = (($('dMid') || {}).value || '').trim();
    if (!mid) { toast('机器码必填', 'warn'); return; }
    try {
      await crud('devices').create({
        machineId: mid,
        remark: (($('dRemark') || {}).value || '').trim(),
        group: (($('dGroup') || {}).value || '').trim(),
        model: (($('dModel') || {}).value || '').trim(),
        whitelisted: !!($('dWl') || {}).checked,
      });
      toast('已创建设备档案', 'ok');
      closeModal();
      renderDevicesOps();
    } catch (e) {
      toast('创建失败：' + e.message, 'bad');
    }
  }

  function openEditDevice(mid) {
    if (!requireWrite('编辑设备档案')) return;
    var body = '<p>编辑设备 <b>' + esc(mid) + '</b></p>' +
      '<div><label class="ml">备注</label><input id="dRemark" type="text" placeholder="备注" /></div>' +
      '<div><label class="ml">分组</label><input id="dGroup" type="text" placeholder="分组" /></div>' +
      '<div><label class="ml">机型</label><input id="dModel" type="text" placeholder="机型" /></div>' +
      '<div><label class="switch"><input id="dWl" type="checkbox" /><span class="track"></span><span class="state">标记为格式化白名单机型</span></label></div>';
    openModal('编辑设备档案', body, [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '保存', cls: '', onClick: function () { submitEditDevice(mid); } },
    ]);
  }

  async function submitEditDevice(mid) {
    try {
      await crud('devices').update(mid, {
        remark: (($('dRemark') || {}).value || '').trim(),
        group: (($('dGroup') || {}).value || '').trim(),
        model: (($('dModel') || {}).value || '').trim(),
        whitelisted: !!($('dWl') || {}).checked,
      });
      toast('已保存设备档案', 'ok');
      closeModal();
      renderDevicesOps();
    } catch (e) {
      toast('保存失败：' + e.message, 'bad');
    }
  }

  function openDelDevice(mid) {
    if (!requireWrite('删除设备档案')) return;
    openModal('确认删除设备档案',
      '<p>确认删除设备 <b>' + esc(mid) + '</b> 的档案？仅删除档案记录（软删），不影响该设备心跳与授权。</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认删除', cls: 'danger', onClick: function () { doDelDevice(mid); } },
    ]);
  }

  async function doDelDevice(mid) {
    try {
      await crud('devices').remove(mid);
      toast('已删除设备档案', 'ok');
      closeModal();
      renderDevicesOps();
    } catch (e) {
      toast('删除失败：' + e.message, 'bad');
    }
  }

  // ============================================================
  // 配置中心增强：运维配置键（热生效/重启后生效标注 + 恢复默认）
  //               配置变更历史与回滚（读 op 审计，fleet 键一键回滚）
  // ============================================================
  var OPS_KEY_TYPE_HINT = {
    formatWhitelist: '机器码前缀白名单（数组 JSON，如 ["SEA2-","SEA1-8GA4"]）',
    formatLevels: '三档格式化参数（JSON，countdownSec/confirmWord）',
    highriskEnabled: '高危专区总开关（false = 全区拒绝）',
    cupsDriverRepo: '驱动包仓库 URL（空 = 仅内置型号库）',
    pm2ServerWhitelist: '服务端 pm2 白名单（数组 JSON，sea1-* / sea2-server-*）',
    totpSecret: '管理员 TOTP 共享密钥（重置见高危专区）',
  };

  // 类型感知的配置值序列化（与 crud._updateConfig 对齐）
  function fmtCfgValue(f) {
    var v = f.value;
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  function cfgInputHtml(f) {
    var id = 'opsCfg_' + f.key;
    var raw = fmtCfgValue(f);
    if (f.type === 'boolean') {
      var on = (raw === 'true' || raw === '1');
      return '<label class="switch"><input id="' + id + '" type="checkbox" ' + (on ? 'checked' : '') + ' /><span class="track"></span><span class="state">' + (on ? '开启' : '关闭') + '</span></label>';
    }
    if (f.type === 'json') {
      return '<textarea id="' + id + '" rows="2" spellcheck="false" style="width:100%;font-family:monospace">' + esc(raw) + '</textarea>';
    }
    if (f.type === 'secret') {
      return '<input id="' + id + '" type="password" value="' + esc(raw) + '" autocomplete="off" style="width:100%" />';
    }
    return '<input id="' + id + '" type="text" value="' + esc(raw) + '" style="width:100%" />';
  }
  function readCfgInput(f) {
    var el = $('opsCfg_' + f.key);
    if (!el) return undefined;
    if (f.type === 'boolean') return el.checked;
    var raw = el.value;
    if (f.type === 'json') {
      try { return JSON.parse(raw); } catch (e) { return { __parseError: String(e.message) }; }
    }
    return raw;
  }

  // 配置变更历史（op 审计合并：crud-update + vars）
  async function fetchConfigHistory(limit) {
    var out = [];
    try {
      var a = await api('GET', '/api/admin/ops/audit/op?action=crud-update&pageSize=' + (limit || 30));
      out = out.concat((a.items || []));
    } catch (e) { /* 忽略单通道失败 */ }
    try {
      var b = await api('GET', '/api/admin/ops/audit/op?action=vars&pageSize=' + (limit || 30));
      out = out.concat((b.items || []));
    } catch (e) { /* 忽略单通道失败 */ }
    out.sort(function (x, y) { return (y.tsSec || 0) - (x.tsSec || 0); });
    return out.slice(0, limit || 30);
  }

  function renderConfigOpsPanel() {
    var box = $('cfgOpsPanel');
    if (!box) return;
    box.innerHTML = '<div class="card cfg-ops-card">' +
      '<h3>运维配置键（热生效 / 重启后生效标注）</h3>' +
      '<div id="opsCfgList"><div class="loading">加载中…</div></div>' +
      '</div>' +
      '<div class="card cfg-ops-card">' +
      '<h3>配置变更历史与回滚</h3>' +
      '<div class="cmd-hint">回滚仅对运维配置键（crud-update）提供；完整操作审计见「审计中心」。</div>' +
      '<div id="opsCfgHist"><div class="loading">加载中…</div></div>' +
      '</div>';
    loadOpsCfgList();
    loadOpsCfgHistory();
  }

  async function loadOpsCfgList() {
    var box = $('opsCfgList');
    if (!box) return;
    try {
      var d = await crud('configs').list({ page: 1, pageSize: 100 });
      var fleetKeys = (d.items || []).filter(function (f) { return f.fleet === true; });
      if (!fleetKeys.length) {
        box.innerHTML = '<div class="filter-tip">暂无运维配置键（configs 实体仅支持 fleet 键）</div>';
        return;
      }
      box.innerHTML = '<table class="tbl"><thead><tr>' +
        '<th>配置键</th><th>说明</th><th>生效</th><th>当前值</th><th>操作</th></tr></thead><tbody>' +
        fleetKeys.map(function (f) {
          var eff = f.hot ? '<span class="tag hot">即时生效</span>' : (f.requiresRestart ? '<span class="tag restart">需重启</span>' : '<span class="filter-tip">—</span>');
          var hint = OPS_KEY_TYPE_HINT[f.key] || f.help || '';
          return '<tr><td class="wrap"><b>' + esc(f.key) + '</b></td>' +
            '<td class="wrap">' + esc(hint) + '</td>' +
            '<td>' + eff + '</td>' +
            '<td style="min-width:240px">' + cfgInputHtml(f) + '</td>' +
            '<td class="row-actions">' +
            '<button class="btn ghost sm" data-cfg-save="' + esc(f.key) + '">保存</button>' +
            '<button class="btn ghost sm" data-cfg-reset="' + esc(f.key) + '">恢复默认</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table>';
      box.querySelectorAll('[data-cfg-save]').forEach(function (b) {
        b.addEventListener('click', function () {
          var key = b.dataset.cfgSave;
          var f = fleetKeys.filter(function (x) { return x.key === key; })[0];
          if (f) saveOpsCfg(f);
        });
      });
      box.querySelectorAll('[data-cfg-reset]').forEach(function (b) {
        b.addEventListener('click', function () {
          var key = b.dataset.cfgReset;
          var f = fleetKeys.filter(function (x) { return x.key === key; })[0];
          if (f) resetOpsCfg(f);
        });
      });
      // boolean 开关文案联动
      box.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var st = cb.parentNode.querySelector('.state');
          if (st) st.textContent = cb.checked ? '开启' : '关闭';
        });
      });
    } catch (e) {
      box.innerHTML = '<div class="loading">加载失败：' + esc(e.message) + '</div>';
    }
  }

  async function saveOpsCfg(f) {
    if (!requireWrite('保存配置键 ' + f.key)) return;
    var val = readCfgInput(f);
    if (val === undefined) return;
    if (val && val.__parseError) { toast('JSON 解析失败：' + val.__parseError, 'bad'); return; }
    try {
      await crud('configs').update(f.key, { key: f.key, value: val });
      toast('已保存：' + f.key + (f.hot ? '（即时生效）' : '（重启后生效）'), 'ok');
      loadOpsCfgList();
      loadOpsCfgHistory();
    } catch (e) {
      toast('保存失败：' + e.message, 'bad');
    }
  }

  async function resetOpsCfg(f) {
    if (!requireWrite('恢复默认 ' + f.key)) return;
    openModal('恢复默认配置',
      '<p>确认将 <b>' + esc(f.key) + '</b> 恢复为出厂默认值？将写入审计。</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '恢复默认', cls: 'danger', onClick: function () { doResetOpsCfg(f); } },
    ]);
  }

  async function doResetOpsCfg(f) {
    try {
      await crud('configs').remove(f.key);
      toast('已恢复默认：' + f.key, 'ok');
      closeModal();
      loadOpsCfgList();
      loadOpsCfgHistory();
    } catch (e) {
      toast('恢复失败：' + e.message, 'bad');
    }
  }

  async function loadOpsCfgHistory() {
    var box = $('opsCfgHist');
    if (!box) return;
    try {
      var rows = await fetchConfigHistory(30);
      if (!rows.length) {
        box.innerHTML = '<div class="filter-tip">暂无配置变更记录</div>';
        return;
      }
      box.innerHTML = '<table class="tbl"><thead><tr>' +
        '<th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>变更摘要</th><th>操作</th></tr></thead><tbody>' +
        rows.map(function (r, idx) {
          var key = r.target || (r.entity === 'configs' ? r.target : '');
          var before = r.before && r.before.value !== undefined ? r.before.value : (r.before || null);
          var after = r.after && r.after.value !== undefined ? r.after.value : (r.after || null);
          var summary = '';
          if (r.action === 'vars') summary = '配置保存：' + esc(String(r.detail || ''));
          else if (before !== null || after !== null) {
            summary = '<span class="filter-tip">旧：</span>' + esc(JSON.stringify(before)) +
              ' <span class="filter-tip">→ 新：</span>' + esc(JSON.stringify(after));
          } else {
            summary = esc(String(r.detail || ''));
          }
          var canRollback = r.action === 'crud-update' && key && before !== null && before !== undefined && r.entity === 'configs';
          var act = canRollback
            ? '<button class="btn ghost sm" data-rollback="' + idx + '">回滚</button>'
            : '<span class="filter-tip">—</span>';
          return '<tr data-rb-key="' + esc(key) + '" data-rb-val="' + esc(typeof before === 'string' ? before : JSON.stringify(before)) + '"' +
            (canRollback ? ' data-rb-ok="1"' : '') + '>' +
            '<td>' + esc(fmtTime(r.tsSec)) + '</td>' +
            '<td>' + esc(r.operator || '—') + '</td>' +
            '<td>' + esc(r.action) + '</td>' +
            '<td class="wrap">' + esc(key || r.target || '—') + '</td>' +
            '<td class="wrap">' + summary + '</td>' +
            '<td>' + act + '</td></tr>';
        }).join('') + '</tbody></table>';
      box.querySelectorAll('[data-rollback]').forEach(function (b) {
        b.addEventListener('click', function () {
          var tr = b.closest('tr');
          if (!tr) return;
          rollbackCfg(tr.dataset.rbKey, tr.dataset.rbVal);
        });
      });
    } catch (e) {
      box.innerHTML = '<div class="loading">历史加载失败：' + esc(e.message) + '</div>';
    }
  }

  function rollbackCfg(key, rawVal) {
    if (!key) return;
    if (!requireWrite('回滚配置 ' + key)) return;
    var val;
    try { val = JSON.parse(rawVal); } catch (e) { val = rawVal; }
    openModal('确认回滚配置',
      '<p>确认将 <b>' + esc(key) + '</b> 回滚为旧值：</p><div class="cmd-tl-res">' + esc(JSON.stringify(val)) + '</div>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '回滚', cls: 'danger', onClick: function () { doRollbackCfg(key, val); } },
    ]);
  }

  async function doRollbackCfg(key, val) {
    try {
      await crud('configs').update(key, { key: key, value: val });
      toast('已回滚：' + key, 'ok');
      closeModal();
      loadOpsCfgList();
      loadOpsCfgHistory();
    } catch (e) {
      toast('回滚失败：' + e.message, 'bad');
    }
  }

  // ============================================================
  // 绑定事件 + 注册视图
  // ============================================================
  function bindAdmin() {
    var add = $('licAddBtn'); if (add) add.addEventListener('click', openAddCode);
    var bindBtn = $('licBindBtn'); if (bindBtn) bindBtn.addEventListener('click', openBinding);
    var ref = $('licRefresh'); if (ref) ref.addEventListener('click', renderLicense);
    var q = $('licQ'); if (q) q.addEventListener('input', NS.debounce ? NS.debounce(renderLicense, 350) : renderLicense);
    var dAdd = $('devAddBtn'); if (dAdd) dAdd.addEventListener('click', openAddDevice);
    var dRef = $('devRefresh'); if (dRef) dRef.addEventListener('click', renderDevicesOps);
    var dQ = $('devQ'); if (dQ) dQ.addEventListener('input', NS.debounce ? NS.debounce(renderDevicesOps, 350) : renderDevicesOps);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAdmin);
  } else {
    bindAdmin();
  }

  NS.registerView('license', renderLicense);
  NS.registerView('device', renderDevicesOps);
  NS.registerViewHook('config', renderConfigOpsPanel);
})();
