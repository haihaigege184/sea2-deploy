'use strict';
/**
 * webhookLog.js — SmsForwarder 微信收款推送「收件日志」（增量功能）
 *
 * 职责：
 *   维护一份「全部收到的 webhook 推送」落盘日志，用于排查「接口通不通 / 匹配对没对上」。
 *   与订单匹配解耦：无论是否匹配到订单，只要通过密钥校验的推送都会被记录（先存原始收件）。
 *
 * 存储：
 *   - 落盘到 data/webhook-logs.json（与 orders.json 同目录，即激活服务的 DATA_DIR）。
 *   - 启动时若文件不存在则初始化为空数组。
 *   - 追加写入：数组 push 后整体写回，保留最近 MAX_LOGS 条（超出截断头部）。
 *   - 同步写（node 单线程，load→push→save 全程无 await，天然并发安全）。
 *   - 写文件失败绝不中断 webhook 主流程（由调用方 try/catch 兜底，本模块内部再兜底一次）。
 *
 * 导出：
 *   - appendWebhookLog(entry)：追加一条收件记录。
 *   - listWebhookLogs(limit)：返回最近 limit 条（最新在前）；limit 默认 5、上限 50。
 *   - setDataDir(dataDir)：设定落盘目录（由 server.js 启动时注入 DATA_DIR）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 最多保留的收件条数（超出截断头部，保留最新） */
const MAX_LOGS = 200;

/** 落盘文件默认位置（未通过 setDataDir 注入时兜底） */
let _file = null;

/** 设定落盘目录；file = dataDir/webhook-logs.json */
function setDataDir(dataDir) {
  _file = path.join(dataDir || __dirname, 'webhook-logs.json');
  return _file;
}

/** 解析实际落盘文件路径（兜底：lib/../data/webhook-logs.json） */
function resolveFile() {
  if (_file) return _file;
  return path.join(__dirname, '..', 'data', 'webhook-logs.json');
}

/**
 * 读取现有日志数组（文件不存在 / 损坏 → 返回空数组，不抛错）。
 * @returns {Array<object>}
 */
function load() {
  try {
    const f = resolveFile();
    if (!fs.existsSync(f)) return [];
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    // 损坏的日志文件不致命：回退为空数组，后续覆盖写入。
    console.warn('[webhookLog] 读取收件日志失败（已回退空数组）:', (e && e.message) || e);
    return [];
  }
}

/**
 * 写回日志数组（截断头部 + 原子写：临时文件 + rename）。
 * @param {Array<object>} arr
 * @returns {Array<object>} 实际写回的数组（已截断）
 */
function save(arr) {
  // 超过上限则截断头部，仅保留最近 MAX_LOGS 条
  if (arr.length > MAX_LOGS) arr = arr.slice(arr.length - MAX_LOGS);
  const f = resolveFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, f); // 原子替换，避免半写文件
  return arr;
}

/**
 * 追加一条收件记录。
 * 即使写入失败也【绝不】抛出（主流程照常返回，日志错误被静默吞掉）。
 * @param {object} entry 见 lib/wechatWebhook.js 构造的收件记录
 */
function appendWebhookLog(entry) {
  try {
    const arr = load();
    arr.push(entry);
    save(arr);
  } catch (e) {
    // 日志写入失败不得中断 webhook 主流程
    console.warn('[webhookLog] 写入收件日志失败（已忽略）:', (e && e.message) || e);
  }
}

/**
 * 返回最近 limit 条收件记录（最新在前）。
 * @param {number} [limit] 条数，默认 5，上限 50，非数字按 5
 * @returns {Array<object>}
 */
function listWebhookLogs(limit) {
  let n = (typeof limit === 'number' && Number.isFinite(limit)) ? limit : 5;
  if (!Number.isFinite(n) || n < 1) n = 5; // 非数字 / 负数 → 5
  if (n > 50) n = 50; // 上限 50
  const arr = load();
  // 取尾部 n 条并反转，使最新在前
  return arr.slice(-n).reverse();
}

module.exports = { appendWebhookLog, listWebhookLogs, setDataDir, resolveFile, MAX_LOGS };
