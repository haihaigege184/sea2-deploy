'use strict';
/**
 * botNotifyServer.js — bot 侧 localhost-only HTTP 回调端点
 *
 * 作用：激活服务端（sea1-installer/activation-server）在 SmsForwarder 微信收款 webhook 识别到账、
 * 把订单 markPaid 后，会向本端点的 BOT_NOTIFY_URL（loopback）POST {order_id}。
 * 本端点校验共享令牌后，直接复用 vip_core.pollUntilPaid 触发服务端发 license（/api/order/issue），
 * 并通过 onIssue 回调落盘 license —— 实现「无需用户发任何消息」的全自动最后一公里。
 *
 * [T1-P0-1] 端口冲突修复：sea1-bot 与 sea2-bot 的 plugins/vip/botNotifyServer.js 默认端口都是
 * 13007，sea1-bot 先占用 → sea2-bot 反复 EADDRINUSE、自动发码端点从未起来。本文件（sea2-bot 侧）
 * 默认端口改为 **13008**；部署时同步把 sea1-activation-server config.env 的
 * BOT_NOTIFY_URL 改为 http://127.0.0.1:13008/vip/notify-paid。
 * （若 sea2-bot 通过 BOT_NOTIFY_PORT 环境变量指定端口，也可用该变量覆盖，两者等效。）
 *
 * [T1-P1-7] 激活成功群通知：激活服务端在 /api/order/issue 签发成功后，会向本端点 POST
 * {order_id, event:'activated', qq, plan}。本端点识别 event='activated' 后回调 opts.onActivated，
 * 由 vip/index.js 向 config.notify_groups 推送「开通成功」群消息（见 vip/index.js 补丁）。
 *
 * 安全：
 *  - 仅监听 127.0.0.1（loopback），绝不监听 0.0.0.0，防外网直达。
 *  - 共享令牌校验（fail-closed）：header x-bot-notify-token 或 ?token= 必须等于进程 env BOT_NOTIFY_TOKEN；
 *    不符/缺失 → 401（绝不执行发码逻辑）。
 *  - 未配置 BOT_NOTIFY_TOKEN 时不启动端点（降级为无全自动，不影响其他功能、不崩溃）。
 *  - 服务错误（如端口占用 EADDRINUSE）不抛崩 bot 主进程（error 事件吞掉并降级）。
 */

const http = require('node:http');
const core = require('./vip_core');

/** 订单号格式：兼顾旧 SEA1-YYYYMMDD-XXXXXX 与新 sea+14 位秒级时间戳系列（与激活端/监控器一致） */
const ORDER_ID_RE = /^(?:SEA1-[A-Za-z0-9-]+|sea\d{14}(?:-\d{1,2})?)$/i;

/**
 * [T1-P0-1] 默认监听端口 13007 → 13008。
 * 13007 被 sea1-bot（/root/sea1/sea.js）占用；sea2-bot 固定使用 13008 避免 EADDRINUSE。
 * 仍可通过 BOT_NOTIFY_PORT 环境变量覆盖。
 */
const DEFAULT_PORT = 13008;

/**
 * 纯处理逻辑（与 HTTP 解耦，便于单测）。
 * @param {object} params
 * @param {string} params.orderId           请求体中的订单号
 * @param {string} [params.event]           事件类型：'activated'（激活成功群通知）| 缺省（发码）
 * @param {string} [params.qq]              激活客户 QQ（event='activated' 时携带）
 * @param {string} [params.plan]            激活套餐（event='activated' 时携带）
 * @param {string} params.token             请求携带的令牌（header 或 query）
 * @param {string} params.expectedToken     进程 env BOT_NOTIFY_TOKEN（空=未启用）
 * @param {string} params.actServer         激活服务器地址
 * @param {Function} [params.onIssue]       发码成功后回调（落盘 license），签 (licenseObj)=>void
 * @param {Function} [params.onActivated]   激活成功群通知回调（T1-P1-7），签 ({orderId, qq, plan})=>void
 * @param {Function} [params.pollUntilPaid] 可注入（测试用），默认 core.pollUntilPaid
 * @param {{timeoutMs?:number, intervalMs?:number}} [params.pollOpts]
 * @returns {Promise<{status:number, body:object}>}
 */
async function processNotifyPaid(params) {
  const orderId = params && params.orderId;
  const event = (params && params.event) || '';
  const qq = (params && params.qq) || '';
  const plan = (params && params.plan) || '';
  const token = params && params.token;
  const expectedToken = (params && params.expectedToken) || '';
  const actServer = (params && params.actServer) || '';
  const onIssue = (params && params.onIssue) || (() => {});
  const onActivated = (params && params.onActivated) || (() => {});
  const pollUntilPaid = (params && params.pollUntilPaid) || core.pollUntilPaid;
  const pollOpts = (params && params.pollOpts) || {};

  // 1) 令牌校验（fail-closed）
  if (!expectedToken || token !== expectedToken) {
    return { status: 401, body: { ok: false, error: 'invalid notify token' } };
  }
  // 2) order_id 存在 + 格式合法
  if (!orderId || typeof orderId !== 'string') {
    return { status: 400, body: { ok: false, error: 'order_id required' } };
  }
  // 归一化：sea+14位时间戳系列→全小写；SEA1- 系列→全大写（与创建/解析口径一致）
  let normalized = orderId.trim();
  if (/^sea\d{14}/i.test(normalized)) {
    normalized = normalized.toLowerCase();
  } else {
    normalized = normalized.toUpperCase();
  }
  if (!ORDER_ID_RE.test(normalized)) {
    return { status: 400, body: { ok: false, error: 'invalid order_id format' } };
  }

  // [T1-P1-7] 激活成功事件：不触发发码轮询，仅回调 onActivated（推送群通知）
  if (event === 'activated') {
    try {
      await onActivated({ orderId: normalized, qq, plan });
    } catch (e) {
      console.warn('[botNotify] 激活成功群通知回调失败（已忽略）:', (e && e.message) || e);
    }
    return { status: 200, body: { ok: true, event: 'activated', order_id: normalized, notified: true } };
  }

  // 3) 触发既有发码逻辑（订单已 paid，pollUntilPaid 首次轮询即检测到并 issueOrder）
  const res = await pollUntilPaid(actServer, normalized, pollOpts);
  // 4) 落盘 license（与 onMessage 闭环一致），无需用户消息
  if (res && res.license) {
    try {
      onIssue(res.license);
    } catch (e) {
      console.warn('[botNotify] 落盘 license 失败（已忽略）:', (e && e.message) || e);
    }
  }
  return { status: 200, body: { ok: true, order_id: normalized, issued: !!(res && res.license) } };
}

/** 读取 JSON 请求体（损坏/空 → {}） */
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/**
 * 构造请求处理器（用于真实 HTTP 服务）。
 * @param {object} opts { actServer, token, onIssue, onActivated, pollOpts }
 * @returns {(req, res) => Promise<void>}
 */
function createBotNotifyHandler(opts) {
  const expectedToken = (opts && opts.token) || '';
  const actServer = (opts && opts.actServer) || '';
  const onIssue = (opts && opts.onIssue) || (() => {});
  const onActivated = (opts && opts.onActivated) || (() => {});
  const pollOpts = (opts && opts.pollOpts) || {};
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/vip/notify-paid') {
        return sendJson(res, 404, { ok: false, error: 'not found' });
      }
      // 令牌：header x-bot-notify-token 优先，其次 ?token=
      const headerToken = (req.headers['x-bot-notify-token'] || '').toString();
      const queryToken = url.searchParams.get('token') || '';
      const token = headerToken || queryToken;
      const body = await readJson(req);
      const orderId = (body && body.order_id) || '';
      const event = (body && body.event) || '';
      const qq = (body && body.qq) || '';
      const plan = (body && body.plan) || '';
      const result = await processNotifyPaid({
        orderId, event, qq, plan, token, expectedToken, actServer, onIssue, onActivated, pollOpts,
      });
      return sendJson(res, result.status, result.body);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'bad request: ' + ((e && e.message) || e) });
    }
  };
}

/**
 * 启动 localhost-only 回调端点。
 * @param {object} opts { actServer, token?, port?, onIssue?, onActivated?, pollOpts? }
 * @returns {Promise<import('http').Server|null>}
 *          已监听的 server；未配置 token 时返回 null（不启动，降级为无全自动）。
 */
function startBotNotifyServer(opts) {
  const token = (opts && opts.token) || process.env.BOT_NOTIFY_TOKEN || '';
  if (!token) {
    // 降级：未配置令牌则不暴露端点，全自动退化为「用户发已支付」路径，不影响其他功能
    console.log('[botNotify] 未配置 BOT_NOTIFY_TOKEN，自动发码端点不启动（降级为无全自动）。');
    return Promise.resolve(null);
  }
  const port = (opts && opts.port != null) ? opts.port : (parseInt(process.env.BOT_NOTIFY_PORT || '', 10) || DEFAULT_PORT);
  const actServer = (opts && opts.actServer) || '';
  const onIssue = (opts && opts.onIssue) || (() => {});
  const onActivated = (opts && opts.onActivated) || (() => {});
  const pollOpts = (opts && opts.pollOpts) || {};
  const handler = createBotNotifyHandler({ actServer, token, onIssue, onActivated, pollOpts });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.on('error', (e) => {
      // 优雅：端口占用等错误不抛崩 bot 主进程，降级为无全自动
      console.warn('[botNotify] 自动发码端点启动失败（已忽略，降级为无全自动）:', (e && e.message) || e);
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[botNotify] 自动发码端点已启动：http://127.0.0.1:${port}/vip/notify-paid（仅 localhost）`);
      resolve(server);
    });
  });
}

module.exports = {
  startBotNotifyServer,
  createBotNotifyHandler,
  processNotifyPaid,
  DEFAULT_PORT,
  ORDER_ID_RE,
};
