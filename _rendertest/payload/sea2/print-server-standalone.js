#!/usr/bin/env node
'use strict';
/**
 * print-server-standalone.js — 独立常驻本地打印服务（127.0.0.1:13012）
 * ------------------------------------------------------------------
 * 背景（[独立化改造 2026-08-08]）：
 *  - 原 printServer 内嵌在 sea2-bot(sea.js) 里启动，SEA1 模式下 sea2-bot 停止
 *    后 WEB 打印随之消失（qr-server /api/webprint/tasks 返回 502 打印服务不可达）。
 *  - 本脚本将 printServer 拆为 pm2 常驻进程（进程名 sea2-print-server），
 *    与 sea2-bot 生命周期解耦 → SEA1/SEA2 双模式 WEB 打印均可用。
 *
 * 实现要点：
 *  - 复用 lib/printServer.createPrintServer()（默认端口 13012，JSON 队列原子写，
 *    单协程顺序打印，TTL 24h 清理）；
 *  - 所有内部路径基于 __dirname 绝对定位（require 相对本文件解析），
 *    可在任意 cwd 启动，不依赖进程工作目录；
 *  - 执行器显式注入 plugins/print.printFile（懒加载单例，读 /root/sea2/config.json，
 *    走 CUPS lp；已实测在独立 node 进程可正常加载与调用）；
 *  - 优雅退出：SIGTERM / SIGINT → stop() 关闭 HTTP 服务与工作协程后退出。
 *
 * 托管：pm2 start ecosystem.sea2-print-server.config.js --only sea2-print-server
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;

const { createPrintServer } = require(path.join(ROOT, 'lib', 'printServer'));

const PORT = parseInt(process.env.SEA2_PRINT_SERVER_PORT || '13012', 10) || 13012;
const HOST = '127.0.0.1';
const QUEUE_FILE = process.env.SEA2_WEBPRINT_QUEUE || path.join(ROOT, 'webprint', 'queue.json');
const UPLOAD_DIR = process.env.SEA2_WEBPRINT_UPLOADS || path.join(ROOT, 'webprint', 'uploads');

/** 统一日志（与 sea.js 风格一致，前缀标识独立进程） */
function log(msg, level = 'INFO') {
  const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log('[' + time + '] [' + level + '] [sea2-print-server] ' + msg);
}

let server = null;
let cleanupTimer = null;

async function main() {
  // 确保队列/上传目录存在（幂等）
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  } catch (e) {
    log('创建目录失败（忽略，继续启动）: ' + (e && e.message || e), 'WARN');
  }

  server = createPrintServer({
    port: PORT,
    host: HOST,
    queueFile: QUEUE_FILE,
    uploadDir: UPLOAD_DIR,
    // 复用 print 插件导出（懒加载单例；绝对定位不受 cwd 影响）
    printFile: (opts) => require(path.join(ROOT, 'plugins', 'print')).printFile(opts),
  });

  await server.start();
  const addr = server.getServer() && server.getServer().address();
  log('本地打印服务已启动（' + HOST + ':' + (addr ? addr.port : PORT) + '）');
  log('队列文件: ' + QUEUE_FILE);
  log('上传目录: ' + UPLOAD_DIR);

  // TTL 清理（24h；每小时巡检；与 sea.js 内嵌行为一致）
  cleanupTimer = setInterval(() => {
    try { server.cleanupExpired(); } catch (e) { /* best-effort */ }
  }, 60 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

/** 优雅退出：停止 HTTP 服务与工作协程，最多 5s 强制兜底 */
function shutdown(sig) {
  log('收到 ' + sig + '，正在优雅退出...');
  setTimeout(() => {
    try { process.exit(0); } catch (e) { /* ignore */ }
  }, 5000).unref();
  const doStop = async () => {
    try {
      if (server && typeof server.stop === 'function') await server.stop();
    } catch (e) {
      log('stop 异常（忽略）: ' + (e && e.message || e), 'WARN');
    }
    log('已停止，进程退出');
    process.exit(0);
  };
  doStop();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  // 崩溃日志后退出（pm2 自动重启），避免静默挂死
  log('未捕获异常，进程退出（pm2 将自动重启）: ' + (e && e.stack || e), 'ERROR');
  try { process.exit(1); } catch (err) { /* ignore */ }
});
process.on('unhandledRejection', (e) => {
  // 工作协程内错误已被 printServer 捕获；此处仅记录，不退出
  log('未处理 Promise 拒绝: ' + (e && e.stack || e), 'ERROR');
});

main().catch((e) => {
  log('启动失败: ' + (e && e.stack || e), 'ERROR');
  try { process.exit(1); } catch (err) { /* ignore */ }
});
