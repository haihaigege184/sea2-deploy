'use strict';
/**
 * botNotifier.js — webhook 匹配成功后通知 bot 发 license（回调，best-effort）
 *
 * 设计背景：
 *   激活服务器把订单推进到 paid 后，需要让 bot（sea1 QQ 机器人）完成「发码 + 写盘 license」。
 *   当前 bot 通过用户在对话框发「已支付 <订单号>」进入 pollUntilPaid，立即检测到 paid 并自动发 license。
 *   为达成「无需用户手动发指令」的全自动，本模块在 markPaid 后向 bot 暴露的内部端点（loopback）
 *   POST {order_id}，触发其既有发码逻辑。
 *
 *   若部署时未配置 BOT_NOTIFY_URL（bot 尚未暴露内部端点），本模块为 no-op，
 *   既不影响既有「已支付」路径，也不阻塞 webhook 响应。
 *
 * 安全性：
 *   - 仅向受信的内部地址（BOT_NOTIFY_URL）发送订单号；并以共享令牌（BOT_NOTIFY_TOKEN，
 *     x-bot-notify-token 头 / ?token=）做单向鉴权，不携带任何用户敏感凭证。
 *   - 默认传输为 localhost loopback HTTP，失败仅告警，绝不抛错影响 webhook 主流程。
 */

const http = require('node:http');

/**
 * 通知 bot：某订单已支付，请发 license。
 * @param {object} cfg 激活服务器配置（含 botNotifyUrl）
 * @param {string} orderId 已支付订单号
 * @param {{transport?:Function}} [opts] 测试注入的传输函数 (url, body) => ({status}) | Promise<{status}>
 * @returns {{notified:boolean|'pending', status?:number|'pending', error?:string, reason?:string}}
 *          同步返回：notified=true 表示已尝试发送（异步传输为 'pending'）；false 表示未发送（no-op / 出错）。
 */
function notifyOrderPaid(cfg, orderId, opts = {}) {
  return _notify(cfg, { order_id: orderId }, opts);
}

/**
 * [T1-P1-7] 通知 bot：订单已签发（激活成功），请推送「开通成功」群通知。
 *
 * 背景：服务端无 QQ 群通道，激活成功群通知由 bot 端完成。签发成功（/api/order/issue
 * 或 console grant）后调用本函数，向 BOT_NOTIFY_URL 投递 `{order_id, event:'activated',
 * qq, plan}`；bot 端 botNotifyServer 识别 event='activated' 后向 config.notify_groups
 * 推送「激活成功」群消息（bot 端补丁见 patches/sea2-bot/）。
 *
 * 安全与容错与 notifyOrderPaid 完全一致：未配置 BOT_NOTIFY_URL 时 no-op；失败仅告警。
 *
 * @param {object} cfg 激活服务器配置（含 botNotifyUrl）
 * @param {string} orderId 已签发订单号
 * @param {{qq?:string, plan?:string, transport?:Function}} [opts]
 * @returns {{notified:boolean|'pending', status?:number|'pending', error?:string, reason?:string}}
 */
function notifyActivated(cfg, orderId, opts = {}) {
  const body = { order_id: orderId, event: 'activated' };
  if (opts.qq) body.qq = String(opts.qq);
  if (opts.plan) body.plan = String(opts.plan);
  return _notify(cfg, body, opts);
}

/** 统一回调投递（notifyOrderPaid / notifyActivated 共用） */
function _notify(cfg, body, opts = {}) {
  const url = (cfg && cfg.botNotifyUrl) || process.env.BOT_NOTIFY_URL || '';
  if (!url) {
    // 未配置 bot 回调地址：激活服务器已把订单推进到 paid/issued；
    // bot 将通过既有的「已支付 <订单号>」指令（其 pollUntilPaid 立即检测到 paid 并自动发 license）完成发码。
    return { notified: false, reason: 'no botNotifyUrl configured' };
  }
  // 共享令牌（与 bot 端点校验一致）：激活端 env BOT_NOTIFY_TOKEN 必须等于 bot 进程 env BOT_NOTIFY_TOKEN。
  const token = (cfg && cfg.botNotifyToken) || process.env.BOT_NOTIFY_TOKEN || '';
  const transport = opts.transport || ((u, b) => defaultTransport(u, b, token));
  try {
    const p = transport(url, body);
    if (p && typeof p.then === 'function') {
      // 异步传输：fire-and-forget，内部吞掉异常，不阻塞 webhook 响应
      p.catch((e) => console.warn('[botNotifier] 回调 bot 失败:', (e && e.message) || e));
      return { notified: 'pending', status: 'pending' };
    }
    return { notified: true, status: p && p.status };
  } catch (e) {
    return { notified: false, error: String((e && e.message) || e) };
  }
}

/**
 * 默认传输：node:http POST JSON 到 bot 内部端点。返回 Promise<{status:number}>。
 * 仅在 BOT_NOTIFY_URL 配置时调用；超时 3s 即放弃，避免拖慢 webhook。
 */
function defaultTransport(url, body, token) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
      // 以 query 形式兜底携带令牌（bot 端点优先校验 header，其次 query）
      if (token) {
        const params = new URLSearchParams(u.search);
        if (!params.has('token')) {
          params.set('token', token);
          u.search = params.toString();
        }
      }
    } catch (e) {
      return reject(e);
    }
    const data = JSON.stringify(body || {});
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    // 共享令牌：x-bot-notify-token 头（与 bot 端点校验一致）
    if (token) headers['x-bot-notify-token'] = token;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers,
      },
      (res) => {
        res.resume(); // 丢弃响应体
        resolve({ status: res.statusCode });
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('bot notify timeout')));
    req.write(data);
    req.end();
  });
}

module.exports = { notifyOrderPaid, notifyActivated, defaultTransport };
