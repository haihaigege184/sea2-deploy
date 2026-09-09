'use strict';
/**
 * lib/printServer.js — [R9 R4] 本地打印任务 HTTP 服务（127.0.0.1:13012）
 *
 * 职责（架构师 R9 设计 T06）：
 *  - JSON 任务队列（/root/sea2/webprint/queue.json，原子写）；
 *  - POST /api/tasks  创建打印任务（{filePath, copies, duplex, paper}）；
 *  - GET  /api/tasks  查询全部任务；
 *  - GET  /api/tasks/:taskId 查询单个任务；
 *  - 执行：调用 require('../plugins/print').printFile({filePath,copies,duplex,paper})
 *    （复用 CUPS 打印；PDF 走现有双面/去黑管线，图片经 img2pdf 再打印）；
 *  - 状态流转：queued → printing → done | failed；
 *  - TTL 24h 清理：done/failed 超时任务从队列移除并删除上传文件。
 *
 * 设计要点：
 *  - 执行器可注入（测试 mock printFile）；队列文件路径可注入（测试用临时目录）；
 *  - 单工作协程顺序处理，避免并发打印争抢 CUPS；
 *  - 零新增 npm 依赖：node:http / node:fs / node:path / node:crypto。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_QUEUE_FILE = process.env.SEA2_WEBPRINT_QUEUE || '/root/sea2/webprint/queue.json';
const DEFAULT_UPLOAD_DIR = process.env.SEA2_WEBPRINT_UPLOADS || '/root/sea2/webprint/uploads';
const TTL_MS = 24 * 60 * 60 * 1000;   // 任务保留 24h
const MAX_QUEUE = 200;                // 队列上限（防堆积）

/** 默认执行器：调用 print 插件导出 printFile */
function defaultPrintFile(opts) {
  const print = require('../plugins/print');
  return print.printFile(opts);
}

/**
 * 创建打印服务。
 * @param {object} [opts]
 * @param {number} [opts.port=13012]
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.queueFile]
 * @param {string} [opts.uploadDir]
 * @param {Function} [opts.printFile] 执行器（默认 require('../plugins/print').printFile）
 * @param {number} [opts.ttlMs=86400000]
 * @param {number} [opts.workerIntervalMs=3000]
 * @returns {{
 *   start(): Promise<object>, stop(): Promise<void>,
 *   createTask(input): Promise<object>, getTask(id): object|null, listTasks(): Array,
 *   cleanupExpired(): number, getServer(): object|null, queueFile(): string,
 * }}
 */
function createPrintServer(opts) {
  opts = opts || {};
  const port = (opts.port === undefined || opts.port === null) ? 13012 : opts.port; // 0 = 随机端口（测试用）
  const host = opts.host || '127.0.0.1';
  const queueFile = opts.queueFile || DEFAULT_QUEUE_FILE;
  const uploadDir = opts.uploadDir || DEFAULT_UPLOAD_DIR;
  const printFile = opts.printFile || defaultPrintFile;
  const ttlMs = opts.ttlMs || TTL_MS;
  const workerIntervalMs = opts.workerIntervalMs || 3000;

  let server = null;
  let workerTimer = null;
  let working = false;
  let queue = [];

  function loadQueue() {
    try {
      if (fs.existsSync(queueFile)) {
        const raw = fs.readFileSync(queueFile, 'utf8');
        const arr = JSON.parse(raw);
        queue = Array.isArray(arr) ? arr : [];
      } else {
        queue = [];
      }
    } catch (e) {
      queue = [];
    }
    // [ENG-3] 崩溃重启恢复：printing 任务重置为 queued（重新入队），
    // 否则重读后 printing 占住队列槽且 worker 永不处理 → 任务永久卡死。
    let changed = false;
    for (const t of queue) {
      if (t && t.status === 'printing') {
        t.status = 'queued';
        t.startedAt = 0;
        changed = true;
      }
    }
    if (changed) saveQueue();
    return queue;
  }

  /**
   * [O-1] 目录内判定（realpath 复核）：target 的物理路径必须位于 base 物理路径内。
   * 仅做字符串 resolve 归一会被 uploads 内的符号链接绕过（symlink → 目录外文件）。
   * 规则：
   *  - base 与 target 各自 realpath（target 不存在时回退为「父目录 realpath + basename」，
   *    与 createTask「先白名单后查存在」的顺序兼容）；
   *  - realpath 失败（父目录都不存在）→ 拒绝（fail-closed）；
   *  - 以 `baseReal + path.sep` 前缀匹配（win32 大小写不敏感）。
   * @param {string} base 基准目录（uploads）
   * @param {string} target 待校验路径
   * @returns {boolean}
   */
  function realpathWithin(base, target) {
    const baseResolved = path.resolve(base);
    const targetResolved = path.resolve(String(target || ''));
    // 基准目录 realpath：目录不存在时回退 resolve（避免误拒首次启动未建目录的场景）
    let baseReal = '';
    try { baseReal = fs.realpathSync(baseResolved); } catch (e) { baseReal = baseResolved; }
    // 目标 realpath：文件存在 → 直接解析（符号链接在此被解引用）；不存在 → 父目录 realpath + basename
    let targetReal = '';
    try {
      targetReal = fs.realpathSync(targetResolved);
    } catch (e) {
      try {
        const parent = path.dirname(targetResolved);
        const parentReal = fs.realpathSync(parent);
        targetReal = path.join(parentReal, path.basename(targetResolved));
      } catch (e2) {
        return false; // 父目录都不存在 → fail-closed
      }
    }
    const b = process.platform === 'win32' ? baseReal.toLowerCase() : baseReal;
    const t = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal;
    return t === b || t.startsWith(b + path.sep);
  }

  /**
   * [ENG-2] filePath 是否位于 uploadDir 目录内（resolve + realpath 双重校验，防任意文件打印/路径泄露/符号链接逃逸）。
   * @param {string} filePath
   * @returns {boolean}
   */
  function isInsideUploadDir(filePath) {
    return realpathWithin(uploadDir, filePath);
  }

  function saveQueue() {
    try {
      fs.mkdirSync(path.dirname(queueFile), { recursive: true });
      const tmp = queueFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
      fs.renameSync(tmp, queueFile);
    } catch (e) {
      // best-effort
    }
  }

  function findTask(id) {
    return queue.find((t) => t.id === String(id)) || null;
  }

  function updateTask(id, patch) {
    const t = findTask(id);
    if (!t) return null;
    Object.assign(t, patch);
    saveQueue();
    return t;
  }

  /**
   * 创建任务（校验参数）。
   * @param {object} input {filePath, copies, duplex, paper}
   * @returns {{ok:boolean, task?:object, error?:string}}
   */
  function createTask(input) {
    input = input || {};
    const filePath = String(input.filePath || '').trim();
    if (!filePath) return { ok: false, error: 'filePath 必填' };
    // [ENG-2] 白名单：filePath resolve 后必须位于 uploadDir 内（防任意文件打印/路径泄露）。
    // 上传仅经 qr-server /api/webprint/upload → saveUpload 落盘 uploads 目录；越界路径一律拒绝。
    if (!isInsideUploadDir(filePath)) {
      return { ok: false, error: 'filePath 必须在上传目录内（uploads 白名单）' };
    }
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在: ' + filePath };
    if (fs.statSync(filePath).isDirectory()) return { ok: false, error: 'filePath 必须是文件' };
    const copies = Math.min(Math.max(parseInt(input.copies, 10) || 1, 1), 20);
    const duplex = !!input.duplex;
    const paper = /^[A-Za-z0-9_-]{1,16}$/.test(String(input.paper || '')) ? String(input.paper).toUpperCase() : 'A4';
    if (queue.length >= MAX_QUEUE) return { ok: false, error: '队列已满，请稍后再试' };
    const task = {
      id: 'wp-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      filePath,
      fileName: path.basename(filePath),
      copies,
      duplex,
      paper,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      error: '',
      result: null,
    };
    queue.push(task);
    saveQueue();
    kickWorker();
    // 返回快照（worker 可能已异步推进状态，避免响应体引用被并发改写）
    return { ok: true, task: Object.assign({}, task) };
  }

  function getTask(id) { return findTask(id); }
  function listTasks() { return queue.slice().reverse(); }

  /** 顺序工作协程：一次处理一个 queued 任务 */
  async function processNext() {
    if (working) return;
    working = true;
    try {
      const next = queue.find((t) => t.status === 'queued');
      if (!next) return;
      updateTask(next.id, { status: 'printing', startedAt: Date.now() });
      try {
        const result = await printFile({
          filePath: next.filePath,
          copies: next.copies,
          duplex: next.duplex,
          paper: next.paper,
        });
        updateTask(next.id, { status: 'done', finishedAt: Date.now(), result: result || { ok: true } });
      } catch (e) {
        updateTask(next.id, { status: 'failed', finishedAt: Date.now(), error: String(e && e.message || e) });
      }
    } finally {
      working = false;
    }
  }

  function kickWorker() {
    // 下一事件循环再处理，保证 createTask 的响应体先序列化（worker 不会同步改写引用）
    setImmediate(() => { processNext().catch(() => { /* 工作协程异常吞掉 */ }); });
  }

  /** TTL 清理：删除 done/failed 且超过 ttlMs 的任务，并删除其上传文件（若在 uploadDir 内） */
  function cleanupExpired() {
    const now = Date.now();
    const before = queue.length;
    const removed = [];
    queue = queue.filter((t) => {
      if (t.status === 'done' || t.status === 'failed') {
        const finished = t.finishedAt || t.createdAt || 0;
        if (now - finished > ttlMs) {
          removed.push(t);
          // 仅删除本服务上传目录内的文件（防误删任意路径；[O-1] realpath 复核防符号链接逃逸）
          const fp = t.filePath || '';
          if (fp && uploadDir && realpathWithin(uploadDir, fp)) {
            try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) { /* ignore */ }
          }
          return false;
        }
      }
      return true;
    });
    if (queue.length !== before) saveQueue();
    return removed.length;
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const method = req.method;

    if (method === 'POST' && p === '/api/tasks') {
      readBody(req).then((body) => {
        const r = createTask(body);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (method === 'GET' && p === '/api/tasks') {
      sendJson(res, 200, { ok: true, tasks: listTasks() });
      return;
    }
    const single = p.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)$/);
    if (method === 'GET' && single) {
      const t = getTask(single[1]);
      if (!t) return sendJson(res, 404, { ok: false, error: '任务不存在' });
      sendJson(res, 200, { ok: true, task: t });
      return;
    }
    if (method === 'GET' && p === '/health') {
      sendJson(res, 200, { ok: true, service: 'sea2-print-server', queue: queue.length });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  function start() {
    return new Promise((resolve, reject) => {
      if (server) return resolve(server);
      loadQueue();
      server = http.createServer(handler);
      server.on('error', reject);
      server.listen(port, host, () => {
        workerTimer = setInterval(() => { kickWorker(); }, workerIntervalMs);
        if (workerTimer.unref) workerTimer.unref();
        resolve(server);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
      if (server) {
        if (typeof server.closeAllConnections === 'function') { try { server.closeAllConnections(); } catch (e) { /* ignore */ } }
        server.close(() => resolve());
        server = null;
      } else {
        resolve();
      }
    });
  }

  function getServer() { return server; }

  return { start, stop, createTask, getTask, listTasks, cleanupExpired, getServer, queueFile: () => queueFile, loadQueue, saveQueue, isInsideUploadDir, realpathWithin };
}

module.exports = { createPrintServer, DEFAULT_QUEUE_FILE, DEFAULT_UPLOAD_DIR, TTL_MS };
