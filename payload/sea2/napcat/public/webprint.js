'use strict';
/**
 * public/webprint.js — [R9 R4] Web 打印页前端逻辑
 *
 * 职责：
 *  - 文件选择/拖拽 → FileReader → base64 JSON 上传（POST /api/webprint/upload）；
 *  - 参数表单（份数/双面/纸张）→ POST /api/webprint/tasks；
 *  - 任务状态轮询回显（3s 刷新）。
 * 零依赖（原生 fetch / FileReader）。
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const dropZone = $('#dropZone');
  const fileInput = $('#fileInput');
  const fileInfo = $('#fileInfo');
  const printBtn = $('#printBtn');
  const msg = $('#msg');
  const taskArea = $('#taskArea');
  const taskCount = $('#taskCount');

  let currentFile = null;   // {name, type, size, dataBase64}

  // [O-2] 管理端点口令（x-web-token）辅助：与 index.html 同模式（localStorage 'web_admin_token' +
  // NapCat WebUI 登录态 Credential（key='token'）经 /api/web-token 换取），调用管理端点自动附带。
  async function getAdminToken() {
    let t = '';
    try { t = localStorage.getItem('web_admin_token') || ''; } catch (e) {}
    if (t) return t;
    let cred = '';
    try {
      const raw = localStorage.getItem('token');
      if (raw) {
        let j = null; try { j = JSON.parse(raw); } catch (e) { j = null; }
        cred = (typeof j === 'string') ? j : ((j && (j.Credential || j.credential)) || raw);
      }
    } catch (e) {}
    if (!cred) return '';
    try {
      const r = await fetch('/api/web-token', { headers: { 'Authorization': 'Bearer ' + cred } });
      const j = await r.json();
      if (j && j.ok && j.token) {
        try { localStorage.setItem('web_admin_token', j.token); } catch (e) {}
        return j.token;
      }
    } catch (e) {}
    return '';
  }
  async function adminFetch(url, opts) {
    opts = opts || {};
    const h = Object.assign({}, opts.headers || {});
    const t = await getAdminToken();
    if (t) h['x-web-token'] = t;
    if (opts.body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    let r = await fetch(url, Object.assign({}, opts, { headers: h }));
    if (r.status === 401 || r.status === 503) {
      try { localStorage.removeItem('web_admin_token'); } catch (e) {}
      const t2 = await getAdminToken();
      if (t2) {
        const h2 = Object.assign({}, opts.headers || {}, { 'x-web-token': t2 });
        if (opts.body !== undefined && !h2['Content-Type']) h2['Content-Type'] = 'application/json';
        r = await fetch(url, Object.assign({}, opts, { headers: h2 }));
      }
    }
    return r;
  }

  function showMsg(kind, text) {
    msg.className = 'note ' + kind;
    msg.textContent = text;
  }
  function clearMsg() {
    msg.className = 'note';
    msg.textContent = '';
  }
  function esc(s) {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---- 文件选择 ----
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  function handleFile(file) {
    const allowed = /\.(png|jpe?g|gif|webp|bmp|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp|rtf|csv|txt|wps|et|dps|mdb)$/i.test(file.name) &&
      (/^image\//.test(file.type) || file.type === 'application/pdf' ||
       /^(application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.ms-works|x-msaccess|x-ks-|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument|rtf|octet-stream)|text\/(csv|plain))/.test(file.type));
    if (!allowed) {
      showMsg('err', '仅支持图片、PDF 与 office 文档（Word/Excel/PPT/RTF/CSV/TXT 等）');
      currentFile = null;
      printBtn.disabled = true;
      fileInfo.innerHTML = '';
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      showMsg('err', '文件超过 50MB 上限');
      currentFile = null;
      printBtn.disabled = true;
      fileInfo.innerHTML = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result || '').split(',')[1] || '';
      currentFile = {
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        dataBase64: b64,
      };
      fileInfo.innerHTML = '<b>' + esc(file.name) + '</b> · ' + (file.size / 1024).toFixed(1) + ' KB · ' + esc(file.type || '未知类型');
      printBtn.disabled = false;
      clearMsg();
    };
    reader.onerror = () => {
      showMsg('err', '文件读取失败');
      currentFile = null;
      printBtn.disabled = true;
    };
    reader.readAsDataURL(file);
  }

  // ---- 上传 + 提交打印 ----
  printBtn.addEventListener('click', async () => {
    if (!currentFile) return;
    printBtn.disabled = true;
    printBtn.textContent = '上传中…';
    try {
      const upRes = await adminFetch('/api/webprint/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // [FIX 2026-08-08] 服务端 validateUploadPayload 读取 fileName/mime/size/dataBase64，
        // 前端 currentFile 字段为 name/type/size/dataBase64，必须显式映射，否则恒报「fileName 必填」。
        body: JSON.stringify({ fileName: currentFile.name, mime: currentFile.type, size: currentFile.size, dataBase64: currentFile.dataBase64 }),
      });
      const up = await upRes.json();
      if (!up.ok) throw new Error(up.error || '上传失败');
      showMsg('info', '上传成功，正在提交打印任务…');
      const copies = Math.min(Math.max(parseInt($('#copies').value || '1', 10) || 1, 1), 20);
      const duplex = $('#duplex').checked;
      const paper = $('#paper').value || 'A4';
      const taskRes = await adminFetch('/api/webprint/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: up.filePath, copies, duplex, paper }),
      });
      const task = await taskRes.json();
      if (!task.ok) throw new Error(task.error || '任务创建失败');
      showMsg('ok', '✓ 打印任务已提交：' + (task.task ? task.task.id : ''));
      currentFile = null;
      fileInput.value = '';
      fileInfo.innerHTML = '';
      refreshTasks();
    } catch (e) {
      showMsg('err', '提交失败：' + (e && e.message ? e.message : String(e)));
    } finally {
      printBtn.disabled = !currentFile;
      printBtn.textContent = '提交打印';
    }
  });

  // ---- 任务状态轮询 ----
  function statusCn(s) {
    return { queued: '排队中', printing: '打印中', done: '已完成', failed: '失败' }[s] || s;
  }
  async function refreshTasks() {
    try {
      const r = await adminFetch('/api/webprint/tasks', { cache: 'no-store' });
      const j = await r.json();
      const tasks = (j && j.tasks) || [];
      taskCount.textContent = String(tasks.length);
      if (!tasks.length) {
        taskArea.innerHTML = '<div class="empty">暂无任务</div>';
        return;
      }
      let html = '';
      for (const t of tasks.slice(0, 20)) {
        const st = t.status || 'queued';
        const meta = '×' + (t.copies || 1) + ' · ' + esc(t.paper || 'A4') + (t.duplex ? ' · 双面' : '');
        html += '<div class="task">' +
          '<span class="st ' + esc(st) + '">' + esc(statusCn(st)) + '</span>' +
          '<div style="flex:1;min-width:0">' +
            '<div class="nm">' + esc(t.fileName || t.id) + '</div>' +
            '<div class="meta">' + esc(t.id) + ' · ' + meta + (t.startedAt ? ' · ' + new Date(t.startedAt).toLocaleTimeString() : '') + '</div>' +
            (t.error ? '<div class="err">' + esc(t.error) + '</div>' : '') +
          '</div>' +
        '</div>';
      }
      taskArea.innerHTML = html;
    } catch (e) {
      taskArea.innerHTML = '<div class="empty">任务列表加载失败（打印服务不可达？）</div>';
    }
  }
  $('#refreshBtn').addEventListener('click', refreshTasks);
  setInterval(refreshTasks, 3000);
  refreshTasks();
})();
