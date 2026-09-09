'use strict';
/**
 * public/console.deploy.js — 一键部署面板（R4，sea2 第 4 批增量）
 *
 * 设计依据：class-diagram-sea2-r4.mermaid / 增量系统设计 §R4-P0
 *  - 穿透地址 CRUD（新增/删除/启用禁用/部分更新）
 *  - 主通信地址编辑（保存走 /api/admin/deploy/master，即 deployConfig.setMasterAddress）
 *  - 一键推送 deploy-config.json 到私有仓（/api/admin/deploy/push-to-git，结果回显 commit hash）
 *
 * 依赖 window.ConsoleApp（console.js 已导出）；按序 <script> 引入。
 * 复用既有 console.css 类（tbl/btn/filter-tip/card/tag），零新增样式体系、零新增 npm 依赖。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var NS = window.ConsoleApp || {};
  if (!NS.registerViewHook || !NS.api) return;

  var api = NS.api, $ = NS.$, esc = NS.esc, toast = NS.toast;

  // [R3/R5] 服务端地址常量：穿透地址「服务端对应」标注与录入区静态说明共用；
  //   生产服务端 = 10.0.0.11:3457（与 configManager SCHEMA.deployMasterAddress 默认一致）。
  var SERVER_ADDR = '10.0.0.11:3457';

  // ---------------- 面板渲染 ----------------
  function renderDeployPanel() {
    var box = $('cfgDeployPanel');
    if (!box) return;
    box.innerHTML = '<div class="card cfg-ops-card"><h3>一键部署（穿透地址 + git 推送）</h3>' +
      '<div class="cmd-hint">配置「部署脚本主通信地址」与「穿透地址清单」（服务端对应：' + esc(SERVER_ADDR) + '）；点击推送后，服务端将 deploy-config.json 提交并推送到私有仓（SEA2_GIT_TOKEN 未注入时推送会明确报错）。</div>' +
      '<div id="deployPanelBody"><div class="loading">加载中…</div></div></div>';
    loadDeployPanel();
  }

  // ---------------- 加载 + 渲染 ----------------
  async function loadDeployPanel() {
    var body = $('deployPanelBody');
    if (!body) return;
    try {
      var d = await api('GET', '/api/admin/deploy/config');
      var tunnels = d.tunnels || [];
      var master = d.masterAddress || '';
      var html = '';

      // 主通信地址
      html += '<div style="margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<label style="font-size:12px;color:var(--mut)">部署脚本主通信地址</label>' +
        '<input id="deployMasterInput" type="text" style="min-width:300px" value="' + esc(master) + '" placeholder="http://' + esc(SERVER_ADDR) + '" />' +
        '<button class="btn sm" id="deployMasterSave">保存主地址</button>' +
        '<span class="filter-tip" id="deployMasterMeta"></span></div>';

      // [R5] 录入区静态说明（服务端地址常量共用）
      html += '<div class="cmd-hint" style="margin-bottom:10px">' +
        '本面板管理「一键部署」所需配置：主通信地址 + 穿透地址清单。' +
        '服务端对应：<b>' + esc(SERVER_ADDR) + '</b>；录入的穿透地址将经「一键推送」发布到私有仓 deploy-config.json。' +
        '</div>';

      // 新增穿透地址
      html += '<div style="margin-bottom:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<input id="deployTName" type="text" placeholder="名称（如 深圳主线路）" style="width:140px" />' +
        '<input id="deployTInternalAddr" type="text" placeholder="内网地址 10.0.0.11" style="width:150px" />' +
        '<input id="deployTInternalPort" type="number" placeholder="内网端口" style="width:96px" />' +
        '<input id="deployTPublicAddr" type="text" placeholder="公网/穿透地址 http://1.2.3.4:9000" style="width:260px" />' +
        '<button class="btn sm" id="deployTAdd">＋ 新增穿透地址</button></div>';

      // 穿透地址列表（每条标注「服务端对应：SERVER_ADDR」灰色小字弱化）
      html += '<table class="tbl"><thead><tr>' +
        '<th>名称</th><th>内网地址</th><th>公网/穿透地址</th><th>状态</th><th>操作</th>' +
        '</tr></thead><tbody>';
      if (!tunnels.length) {
        html += '<tr><td colspan="5" class="loading">暂无穿透地址（新增后点击「一键推送」发布到私有仓）</td></tr>';
      }
      tunnels.forEach(function (t) {
        html += '<tr>' +
          '<td class="wrap">' + esc(t.name) + '</td>' +
          '<td>' + esc(t.internalAddr) + ':' + esc(t.internalPort) + '</td>' +
          '<td class="wrap">' + esc(t.publicAddr) + '<div class="filter-tip" style="margin-top:3px">服务端对应：' + esc(SERVER_ADDR) + '</div></td>' +
          '<td>' + (t.enabled ? '<span class="tag s-ok">启用</span>' : '<span class="tag s-offline">停用</span>') + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn ghost sm" data-deploy-toggle="' + esc(t.id) + '">' + (t.enabled ? '停用' : '启用') + '</button>' +
          '<button class="btn danger sm" data-deploy-del="' + esc(t.id) + '">删除</button>' +
          '</td></tr>';
      });
      html += '</tbody></table>';

      // 一键推送
      html += '<div style="margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<button class="btn" id="deployPushBtn">⇪ 一键推送 deploy-config.json 到私有仓</button>' +
        '<span class="filter-tip" id="deployPushMeta"></span></div>';

      body.innerHTML = html;

      // 事件绑定
      $('deployMasterSave').addEventListener('click', saveMaster);
      $('deployTAdd').addEventListener('click', addTunnel);
      $('deployPushBtn').addEventListener('click', pushToGit);
      body.querySelectorAll('[data-deploy-toggle]').forEach(function (b) {
        b.addEventListener('click', function () { toggleTunnel(b.dataset.deployToggle); });
      });
      body.querySelectorAll('[data-deploy-del]').forEach(function (b) {
        b.addEventListener('click', function () { removeTunnel(b.dataset.deployDel); });
      });
      // 回车快捷键：主地址 / 新增表单
      $('deployMasterInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') saveMaster(); });
      $('deployTPublicAddr').addEventListener('keydown', function (e) { if (e.key === 'Enter') addTunnel(); });
    } catch (e) {
      body.innerHTML = '<div class="loading">加载失败：' + esc(e.message) + '</div>';
    }
  }

  // ---------------- 主地址 ----------------
  async function saveMaster() {
    var input = $('deployMasterInput');
    var meta = $('deployMasterMeta');
    if (!input) return;
    var addr = (input.value || '').trim();
    if (!addr) { toast('主通信地址不能为空', 'bad'); return; }
    try {
      var r = await api('POST', '/api/admin/deploy/master', { masterAddress: addr });
      if (!r.ok) throw new Error(r.error || '保存失败');
      if (meta) meta.textContent = '已保存（热生效）';
      toast('主通信地址已保存（热生效）', 'ok');
    } catch (e) {
      toast('保存失败：' + e.message, 'bad');
    }
  }

  // ---------------- 新增穿透地址 ----------------
  async function addTunnel() {
    var name = $('deployTName'), ia = $('deployTInternalAddr'), ip = $('deployTInternalPort'), pa = $('deployTPublicAddr');
    if (!name || !ia || !ip || !pa) return;
    var body = {
      name: (name.value || '').trim(),
      internalAddr: (ia.value || '').trim(),
      internalPort: Number(ip.value) || 0,
      publicAddr: (pa.value || '').trim(),
    };
    if (!body.name || !body.internalAddr || !body.internalPort || !body.publicAddr) {
      toast('请完整填写新增穿透地址（名称/内网地址/内网端口/公网地址）', 'bad');
      return;
    }
    try {
      var r = await api('POST', '/api/admin/deploy/tunnels', body);
      if (!r.ok) throw new Error(r.error || '新增失败');
      toast('已新增穿透地址：' + body.name, 'ok');
      loadDeployPanel();
    } catch (e) {
      toast('新增失败：' + e.message, 'bad');
    }
  }

  // ---------------- 启用/禁用 ----------------
  async function toggleTunnel(id) {
    try {
      var cur = await api('GET', '/api/admin/deploy/config');
      var t = (cur.tunnels || []).filter(function (x) { return x.id === id; })[0];
      var next = t ? !t.enabled : true;
      var r = await api('POST', '/api/admin/deploy/tunnels/' + encodeURIComponent(id) + '/toggle', { enabled: next });
      if (!r.ok) throw new Error(r.error || '切换失败');
      toast(next ? '已启用穿透地址' : '已停用穿透地址', 'ok');
      loadDeployPanel();
    } catch (e) {
      toast('切换失败：' + e.message, 'bad');
    }
  }

  // ---------------- 删除 ----------------
  async function removeTunnel(id) {
    if (!window.confirm('确认删除该穿透地址？')) return;
    try {
      var r = await api('DELETE', '/api/admin/deploy/tunnels/' + encodeURIComponent(id));
      if (!r.ok) throw new Error(r.error || '删除失败');
      toast('已删除穿透地址', 'ok');
      loadDeployPanel();
    } catch (e) {
      toast('删除失败：' + e.message, 'bad');
    }
  }

  // ---------------- 一键推送 ----------------
  async function pushToGit() {
    var btn = $('deployPushBtn');
    var meta = $('deployPushMeta');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>推送中…';
    if (meta) meta.textContent = '正在提交并推送（超时 60s）…';
    try {
      var r = await api('POST', '/api/admin/deploy/push-to-git');
      if (!r.ok) throw new Error(r.error || '推送失败');
      var msg = r.unchanged ? '内容无变化（unchanged）' : ('已推送 commit ' + (r.commitHash || '').slice(0, 12));
      if (meta) meta.textContent = msg + (r.remote ? ' → ' + r.remote : '');
      toast(r.unchanged ? '仓库内容无变化，无需推送' : '已推送部署配置到私有仓', 'ok');
    } catch (e) {
      if (meta) meta.textContent = '推送失败：' + e.message;
      toast('推送失败：' + e.message, 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = '⇪ 一键推送 deploy-config.json 到私有仓';
    }
  }

  // ---------------- 注册配置视图增强钩子 ----------------
  NS.registerViewHook('config', renderDeployPanel);
})();
