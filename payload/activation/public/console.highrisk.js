'use strict';
/**
 * public/console.highrisk.js — 高危操作专区（T04，强门禁流程向导）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §2.2 / §3.3 / §4.4；PRD §5 强门禁七原则
 *  - 绝不 UI 一键直达：进入专区前先展示红黑警告落地页 + L3 权限校验 + 二次确认
 *  - 流程向导：选档位 → 选设备 → 白名单校验(GET gate) → 手输确认词(禁粘贴) → 签发 → 进度/结果
 *  - [R2/R5] 去 TOTP：签发链不再校验管理员验证码，向导移除 TOTP 输入步（verifyTotp 服务端保留不调用）
 *  - 三档分级 data/factory/disk 各自门禁参数由服务端 gate 返回（countdownSec/confirmWord）
 *  - 高危记录列表高亮展示；TOTP 状态查询 + 重置保留为独立管理功能（仅 L3，密钥明文仅展示一次）
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
  var fmtTime = NS.fmtTime, relTime = NS.relTime, enc = NS.enc;
  var getState = NS.getState;
  var poll = NS.poll, cmdStatusMeta = NS.cmdStatusMeta;
  var i18n = NS.i18n || function (s, k, f) { return f !== undefined ? f : String(k); };

  var T = function (scope, key, fb) { return i18n(scope, key, fb); };
  var HR = function (key, fb) { return T('highrisk', key, fb); };

  var LEVELS = [
    { key: 'data', countdownHint: '≥15s' },
    { key: 'factory', countdownHint: '≥20s' },
    { key: 'disk', countdownHint: '≥30s' },
  ];
  var LEVEL_CN = {
    data: '数据分区', factory: '恢复出厂', disk: '整盘擦除',
    '数据分区': '数据分区', '恢复出厂': '恢复出厂', '整盘擦除': '整盘擦除',
  };
  var HR_STATUS_CN = {
    created: '已创建', issued: '已签发', 'local-confirmed': '本地已确认',
    done: '已完成', failed: '执行失败', rejected: '已拒绝',
  };

  var zoneState = { entered: false, level: 'data', mid: '', gate: null, issuing: false };

  // ---------------- 落地页 / 专区入口 ----------------
  function renderHighrisk() {
    var box = $('hrZone');
    if (!box) return;
    var st = getState ? getState() : { level: 0 };
    if (st.level < 3) {
      box.innerHTML = '<div class="hr-landing">' +
        '<div class="hr-warn-icon">⛔</div>' +
        '<h2>高危操作专区</h2>' +
        '<p>本专区包含不可逆的毁灭性操作（远程格式化等）。<br/>绝不提供一键直达，必须逐项通过门禁校验。</p>' +
        '<p class="filter-tip">仅 L3 超管可进入本专区。</p>' +
        '</div>';
      return;
    }
    if (!zoneState.entered) {
      box.innerHTML = '<div class="hr-landing">' +
        '<div class="hr-warn-icon">⛔</div>' +
        '<h2>高危操作专区</h2>' +
        '<p>格式化 / 强门禁 · 全程审计</p>' +
        '<ul class="hr-landing-list">' +
        '<li>① 二次独立确认：手输确认词（不可粘贴），服务端独立校验</li>' +
        '<li>② 白名单机型：非白名单直接拒绝（前端后端双重校验）</li>' +
        '<li>③ 客户端本地再确认：本地警告 + 倒计时 ≥15s（整盘档 ≥30s）</li>' +
        '<li>④ 全程审计留痕：发起人/设备/档位/结果</li>' +
        '</ul>' +
        '<button class="btn danger" id="hrEnterBtn">进入高危操作专区</button>' +
        '</div>';
      var btn = $('hrEnterBtn');
      if (btn) btn.addEventListener('click', function () {
        openModal('确认进入高危操作专区',
          '<p class="cmd-hint danger">确认已阅读警告并拥有 L3 超管权限？进入后所有操作将全程审计。</p>', [
          { label: '取消', cls: 'ghost', onClick: closeModal },
          { label: '确认进入', cls: 'danger', onClick: function () {
            zoneState.entered = true;
            closeModal();
            renderHighrisk();
          } },
        ]);
      });
      return;
    }
    renderZone(box);
  }

  // ---------------- 专区向导 ----------------
  function renderZone(box) {
    box.innerHTML = '<div class="hr-zone">' +
      '<div class="hr-head"><span class="hr-head-icon">⛔</span> 高危操作专区（强门禁）' +
      '<button class="btn ghost sm" id="hrExitBtn" style="float:right">退出专区</button></div>' +
      '<div class="hr-wizard">' +
      wizardStepHtml(1, '选择档位', levelCardsHtml()) +
      '<div class="hr-step" data-step="device">' +
      '<div class="hr-step-no">2</div><div class="hr-step-body">' +
      '<h4>选择目标设备</h4>' +
      '<select id="hrDevice" style="max-width:340px"><option value="">选择设备…</option></select>' +
      '</div></div>' +
      '<div class="hr-step" data-step="gate">' +
      '<div class="hr-step-no">3</div><div class="hr-step-body">' +
      '<h4>白名单校验</h4>' +
      '<button class="btn ghost sm" id="hrGateBtn">校验白名单</button> <span id="hrGateResult" class="filter-tip"></span>' +
      '</div></div>' +
      '<div class="hr-step hidden" data-step="confirm">' +
      '<div class="hr-step-no">4</div><div class="hr-step-body">' +
      '<h4>手输确认词（不可粘贴）</h4>' +
      '<input id="hrWord" type="text" autocomplete="off" placeholder="请手输确认词（不可粘贴）" ' +
      'onpaste="return false" ondrop="return false" oncontextmenu="return false" style="max-width:300px" />' +
      '</div></div>' +
      '<div class="hr-step hidden" data-step="issue">' +
      '<div class="hr-step-no">5</div><div class="hr-step-body">' +
      '<h4>签发与进度</h4>' +
      '<button class="btn danger" id="hrIssueBtn">签发格式化指令</button> <span id="hrIssueResult" class="filter-tip"></span>' +
      '<div id="hrProgress" class="cmd-hint" style="margin-top:8px"></div>' +
      '</div></div>' +
      '</div>' +
      '<div class="hr-totp-card">' +
      '<h4>TOTP 状态</h4><span id="hrTotpStatus"></span> ' +
      '<button class="btn ghost sm" id="hrTotpReset">重置 TOTP 密钥</button>' +
      '</div>' +
      '<div class="hr-records"><h4>高危记录（高亮展示）</h4><div id="hrRecordsList"><div class="loading">加载中…</div></div></div>' +
      '</div>';

    var exit = $('hrExitBtn');
    if (exit) exit.addEventListener('click', function () { zoneState.entered = false; renderHighrisk(); });

    // 档位选择
    document.querySelectorAll('.hr-level-card').forEach(function (card) {
      card.addEventListener('click', function () {
        zoneState.level = card.dataset.level;
        zoneState.gate = null;
        document.querySelectorAll('.hr-level-card').forEach(function (c) { c.classList.toggle('active', c === card); });
        resetGateSteps();
        loadZoneDevices();
      });
    });

    // 设备
    var dev = $('hrDevice');
    if (dev) dev.addEventListener('change', function () {
      zoneState.mid = dev.value;
      zoneState.gate = null;
      resetGateSteps();
    });

    // 白名单校验
    var gateBtn = $('hrGateBtn');
    if (gateBtn) gateBtn.addEventListener('click', doGateCheck);

    // 签发
    var issueBtn = $('hrIssueBtn');
    if (issueBtn) issueBtn.addEventListener('click', doIssueFormat);

    // TOTP 重置
    var totpReset = $('hrTotpReset');
    if (totpReset) totpReset.addEventListener('click', resetTotp);

    loadZoneDevices();
    renderTotpStatus();
    renderHighriskRecords();
  }

  function wizardStepHtml(no, title, extra) {
    return '<div class="hr-step"><div class="hr-step-no">' + no + '</div><div class="hr-step-body">' +
      '<h4>' + esc(title) + '</h4>' + (extra || '') + '</div></div>';
  }

  function levelCardsHtml() {
    return '<div class="hr-levels">' + LEVELS.map(function (lv) {
      var desc = lv.key === 'data' ? '清空业务/打印数据分区，保留系统与 napcat 程序。'
        : (lv.key === 'factory' ? '重置系统配置与数据，回到出厂态（保留授权文件）。'
          : '磁盘级格式化，最不可逆，门禁最强（倒计时 ≥30s）。');
      return '<div class="hr-level-card' + (lv.key === zoneState.level ? ' active' : '') + '" data-level="' + lv.key + '">' +
        '<div class="hr-level-name">' + (lv.key === 'data' ? '数据分区' : (lv.key === 'factory' ? '恢复出厂' : '整盘擦除')) + '</div>' +
        '<div class="hr-level-desc">' + esc(desc) + '</div>' +
        '<div class="hr-level-count">本地倒计时 ' + lv.countdownHint + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function resetGateSteps() {
    // 隐藏 4/5 步，复位门禁上下文（[R2/R5] 无 TOTP 步）
    zoneState.gate = null;
    var steps = document.querySelectorAll('.hr-step[data-step="confirm"], .hr-step[data-step="issue"]');
    steps.forEach(function (s) { s.classList.add('hidden'); });
    var res = $('hrGateResult');
    if (res) res.textContent = '';
    var issueRes = $('hrIssueResult');
    if (issueRes) issueRes.textContent = '';
    var prog = $('hrProgress');
    if (prog) prog.textContent = '';
  }

  async function loadZoneDevices() {
    var sel = $('hrDevice');
    if (!sel) return;
    sel.innerHTML = '<option value="">选择设备…</option>';
    try {
      var d = await api('GET', '/api/admin/fleet/clients?pageSize=500');
      var list = d.items || [];
      var cur = zoneState.mid;
      sel.innerHTML = '<option value="">选择设备…</option>' + list.map(function (c) {
        return '<option value="' + esc(c.machineId) + '"' + (c.machineId === cur ? ' selected' : '') + '>' +
          esc(c.machineId) + (c.qq ? '（' + esc(c.qq) + '）' : '') + '</option>';
      }).join('');
      zoneState.mid = sel.value;
    } catch (e) {
      sel.innerHTML = '<option value="">设备加载失败</option>';
    }
  }

  async function doGateCheck() {
    var res = $('hrGateResult');
    if (!res) return;
    var mid = zoneState.mid;
    var level = zoneState.level;
    if (!mid) { res.textContent = '请先选择设备'; return; }
    res.textContent = '校验中…';
    zoneState.gate = null;
    try {
      var r = await api('GET', '/api/admin/ops/highrisk/gate?mid=' + enc(mid) + '&level=' + enc(level));
      zoneState.gate = r;
      res.innerHTML = '<span class="tag s-normal">白名单校验通过</span> ' +
        '确认词 <b>' + esc(r.confirmWord || '') + '</b> · 本地倒计时 <b>' + esc(String(r.countdownSec || 0)) + '</b> 秒';
      var stepConfirm = document.querySelector('.hr-step[data-step="confirm"]');
      if (stepConfirm) stepConfirm.classList.remove('hidden');
      var word = $('hrWord');
      if (word) { word.value = ''; word.focus(); }
    } catch (e) {
      res.innerHTML = '<span class="tag s-revoked">已拒绝：' + esc(e.message) + '</span>';
      zoneState.gate = null;
    }
  }

  async function doIssueFormat() {
    if (zoneState.issuing) return;
    var res = $('hrIssueResult');
    var prog = $('hrProgress');
    if (!res || !prog) return;
    var gate = zoneState.gate;
    var mid = zoneState.mid;
    var level = zoneState.level;
    if (!mid || !gate) { res.textContent = '请先完成白名单校验'; return; }
    var word = (($('hrWord') || {}).value || '').trim();
    if (word !== gate.confirmWord) { res.textContent = '确认词不正确，请手输 ' + gate.confirmWord; return; }
    var stepIssue = document.querySelector('.hr-step[data-step="issue"]');
    if (stepIssue) stepIssue.classList.remove('hidden');

    zoneState.issuing = true;
    res.textContent = '签发中…';
    prog.textContent = '正在校验确认词…';
    try {
      var r = await api('POST', '/api/admin/ops/highrisk/format', {
        mid: mid, level: level, confirm: word,
      });
      zoneState.issuing = false;
      res.innerHTML = '<span class="tag s-normal">已签发</span> 记录 <b>' + esc(r.recordId || '') + '</b> · 指令 <b>' + esc(r.commandId || '') + '</b>';
      prog.textContent = '指令状态：' + (cmdStatusMeta(r.cmdStatus || '').label || '待下发') +
        '；客户端将本地警告 + 倒计时 ' + esc(String(r.countdownSec || 0)) + ' 秒后二次确认执行。';
      pollHighriskProgress(mid, r.commandId);
      renderHighriskRecords();
    } catch (e) {
      zoneState.issuing = false;
      res.innerHTML = '<span class="tag s-revoked">签发失败：' + esc(e.message) + '</span>';
    }
  }

  function pollHighriskProgress(mid, commandId) {
    var prog = $('hrProgress');
    if (!prog) return;
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
          prog.textContent = '指令终态：' + stMeta.label + (c.result != null ? ' — ' + (typeof c.result === 'string' ? c.result : JSON.stringify(c.result)) : '') +
            (c.status === 'failed' && c.error ? '；错误：' + c.error : '');
          renderHighriskRecords();
        }
      });
    }, null, 40); // 最长约 2 分钟（整盘档本地倒计时 ≥30s）
    p.start();
  }

  // ---------------- 高危记录列表 ----------------
  function hrStatusBadge(st) {
    var cn = HR_STATUS_CN[st] || String(st || '未知');
    var cls = st === 'done' ? 's-normal' : (st === 'failed' || st === 'rejected' ? 's-revoked' : 's-trial');
    return '<span class="tag ' + cls + '">' + esc(cn) + '</span>';
  }

  async function renderHighriskRecords() {
    var box = $('hrRecordsList');
    if (!box) return;
    try {
      var d = await api('GET', '/api/admin/ops/highrisk/records?pageSize=50');
      var list = d.items || [];
      if (!list.length) {
        box.innerHTML = '<div class="filter-tip">暂无高危记录</div>';
        return;
      }
      box.innerHTML = '<table class="tbl hr-table"><thead><tr>' +
        '<th>时间</th><th>发起人</th><th>设备</th><th>档位</th><th>状态</th><th>确认词</th><th>结果</th></tr></thead><tbody>' +
        list.map(function (r) {
          var resText = '';
          if (r.result != null) resText = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
          if (r.status === 'failed' && r.detail) resText = r.detail;
          return '<tr>' +
            '<td>' + esc(r.issuedAt ? fmtTime(r.issuedAt) : '—') + '</td>' +
            '<td>' + esc(r.operator || '—') + '</td>' +
            '<td class="wrap">' + esc(r.machineId || '—') + '</td>' +
            '<td>' + esc(LEVEL_CN[r.level] || r.level || '—') + '</td>' +
            '<td>' + hrStatusBadge(r.status) + '</td>' +
            '<td>' + (r.confirmChecked ? '<span class="tag s-normal">通过</span>' : '<span class="tag s-revoked">未过</span>') + '</td>' +
            '<td class="wrap">' + esc(resText || '—') + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (e) {
      box.innerHTML = '<div class="loading">加载失败：' + esc(e.message) + '</div>';
    }
  }

  // ---------------- TOTP 状态 / 重置 ----------------
  async function renderTotpStatus() {
    var box = $('hrTotpStatus');
    if (!box) return;
    try {
      var r = await api('GET', '/api/admin/ops/totp/status');
      box.innerHTML = r.configured
        ? '<span class="tag s-normal">已配置</span>'
        : '<span class="tag s-revoked">未配置（请重置并绑定管理员验证器）</span>';
    } catch (e) {
      box.textContent = '状态查询失败';
    }
  }

  function resetTotp() {
    var st = getState ? getState() : { level: 0 };
    if (st.level < 3) { toast('仅 L3 超管可重置 TOTP', 'warn'); return; }
    openModal('重置 TOTP 密钥',
      '<p class="cmd-hint danger">确认重置 TOTP 密钥？旧密钥立即失效，需重新绑定管理员验证器（Google Authenticator 等）。</p>', [
      { label: '取消', cls: 'ghost', onClick: closeModal },
      { label: '确认重置', cls: 'danger', onClick: doResetTotp },
    ]);
  }

  async function doResetTotp() {
    try {
      var r = await api('POST', '/api/admin/ops/totp/reset');
      closeModal();
      openModal('TOTP 密钥已重置（仅此一次展示明文）',
        '<p class="cmd-hint">请立即将以下密钥录入管理员验证器（TOTP / 30 秒 / 6 位）：</p>' +
        '<div class="cmd-tl-res" style="font-size:16px;letter-spacing:1px;user-select:all">' + esc(r.secret || '') + '</div>' +
        '<p class="filter-tip">密钥不会再次展示；丢失需重新重置。</p>', [
        { label: '我已录入', cls: '', onClick: closeModal },
      ]);
      renderTotpStatus();
    } catch (e) {
      toast('重置失败：' + e.message, 'bad');
    }
  }

  // ---------------- 注册 ----------------
  NS.registerView('highrisk', renderHighrisk);
})();
