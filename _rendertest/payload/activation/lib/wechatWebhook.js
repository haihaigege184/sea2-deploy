'use strict';
/**
 * wechatWebhook.js — SmsForwarder 微信收款通知 webhook 处理
 *
 * 职责（验签在 server.js 路由层以 fail-closed 完成，本模块假设已进入「已验签」分支）：
 *   1) 字段无关解析（lib/wechatParser）抽取金额 / 订单号 / 备注；
 *   2) 订单匹配：单号强匹配优先，无单号则按金额匹配（仅微信家族 pending/await_verify 订单）；
 *   3) 幂等 markPaid（复用 orders.markPaid，终态不回退）；
 *   4) 触发 bot 发 license（回调，best-effort，见 lib/botNotifier）。
 *   5)【增量】无论是否匹配，先落盘「收件日志」（lib/webhookLog），便于对账与排查。
 *
 * 安全要点（fail-closed 红线）：
 *   - 验签失败绝不会进入本模块（server.js 已 401 拦截）；未过密钥的推送不落盘、不处理。
 *   - 匹配失败（未知单号 / 无金额 / 金额不符 / 金额无对应订单）→ 仍返回 200（received:true,
 *     matched:false, reason），但【绝不】调用 markPaid / 发码。区分「接口通」与「是否匹配到订单」。
 *   - 同单号重复推送（已 paid/issued）→ 200 + dedup:true，绝不重复触发发 license。
 *
 * 与支付宝当面付的关系：本模块完全独立，不触碰 /api/pay/notify、/api/admin/order/confirm、
 * /api/order/issue 等既有路径。
 */

const crypto = require('node:crypto');
const orders = require('./orders');
const parser = require('./wechatParser');
const botNotify = require('./botNotifier');
const webhookLog = require('./webhookLog');

/**
 * 微信家族通道判定。当前 bot 创建订单时发 channel='wechat'，未来可发 'smsforwarder_wechat'；
 * 两者均启用「唯一化偏移 + 金额匹配」。单一事实来源在 lib/orders.js。
 * @param {string} ch
 * @returns {boolean}
 */
function isWechatChannel(ch) {
  return orders.isWechatChannel(ch);
}

/**
 * 校验 webhook 共享密钥（fail-closed）。
 * 未配置 WEBHOOK_SECRET（cfg.webhookSecret 为空）→ 端点视为关闭，任何密钥均拒绝。
 * @param {object} cfg 含 webhookSecret
 * @param {string} [providedSecret]
 * @returns {boolean}
 */
function verifyWebhookSecret(cfg, providedSecret) {
  const expected = (cfg && cfg.webhookSecret) || '';
  if (!expected) return false; // 未配置 WEBHOOK_SECRET → 端点关闭
  const got = typeof providedSecret === 'string' ? providedSecret : '';
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // 常量时间比较，避免时序侧信道
}

/**
 * 可选纵深防御：HMAC-SHA256(rawBody, webhookSecret) === X-Signature（hex）。
 * 仅当请求头带 X-Signature 时才校验（SmsForwarder 可能不发，故不强制）。
 * @returns {boolean}
 */
function verifySignature(secret, rawBody, signature) {
  if (typeof signature !== 'string' || !signature) return false;
  const calc = crypto.createHmac('sha256', secret || '').update(rawBody || '', 'utf8').digest('hex');
  const a = Buffer.from(calc);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 从 SmsForwarder payload 提取「主要通知文本」（用于收件日志 content 字段）。
 * 优先 body.content；否则取第一个含 微信/收款/¥ 的字符串值；再兜底取第一个非空字符串。
 * @param {*} payload
 * @returns {string}
 */
function extractContent(payload) {
  if (payload && typeof payload.content === 'string' && payload.content.trim()) {
    return payload.content.trim();
  }
  const strings = parser.collectStrings(payload || {});
  for (const s of strings) {
    if (/微信|收款|[¥￥]/.test(String(s))) return String(s);
  }
  for (const s of strings) {
    if (String(s).trim()) return String(s);
  }
  return '';
}

/**
 * 匹配订单（微信收款通知）：订单号强匹配为主，无单号时按金额兜底匹配唯一同金额订单。
 *
 * 匹配策略：
 *   1) 有 orderId → 按订单号强匹配（优先，最可靠）；
 *   2) 无 orderId 但有金额 → 过滤出「微信通道 + 待支付/待核验 + 金额完全相同」的候选订单；
 *      - 候选恰好 1 笔 → 命中（markPaid 或 dedup，matched_by:'amount'）；
 *      - 候选 >1 笔 → 金额不唯一，需备注订单号，绝不瞎匹配（ignore: ambiguous_amount）；
 *   3) 无任何可匹配信息 → 忽略（200 收件、绝不 markPaid/发码）。
 *
 * @param {object} store
 * @param {{orderId?:?string, amount?:?number}} parsed
 * @returns {{action:'markPaid'|'dedup'|'ignore', orderId?:string, order?:object, reason?:string, matched_by?:string}}
 */
function matchOrder(store, { orderId, amount }) {
  if (orderId) {
    // 1) 订单号强匹配（优先）
    const o = store.getOrder(orderId);
    if (!o) {
      // 解析出单号但订单不存在 → 忽略，不告警刷屏
      return { action: 'ignore', reason: 'no_order_found' };
    }
    // 已是终态（paid/issued）→ 重复推送，幂等返回，不重复触发发 license
    if (o.status === 'paid' || o.status === 'issued') {
      return { action: 'dedup', orderId, order: o };
    }
    // 命中待支付订单 → 标记已支付（触发发 license）
    return { action: 'markPaid', orderId, order: o, matched_by: 'order_id' };
  }

  // 2) 无单号：尝试按金额兜底匹配（仅限微信通道、待支付/待核验、金额唯一）
  if (typeof amount === 'number' && amount > 0) {
    const candidates = (store.listOrders() || []).filter((o) =>
      isWechatChannel(o.channel) &&
      (o.status === 'pending' || o.status === 'await_verify') &&
      typeof o.amount === 'number' && o.amount === amount
    );
    if (candidates.length === 1) {
      const o = candidates[0];
      if (o.status === 'paid' || o.status === 'issued') {
        return { action: 'dedup', orderId: o.order_id, order: o };
      }
      return { action: 'markPaid', orderId: o.order_id, order: o, matched_by: 'amount' };
    }
    if (candidates.length > 1) {
      // 多笔同金额，无法唯一确定 → 需备注订单号，绝不瞎匹配
      return { action: 'ignore', reason: 'ambiguous_amount' };
    }
    // candidates.length === 0 → 无对应微信待支付订单，落到下面 ignore
  }

  // 3) 无单号且无有效金额 → 无法唯一匹配，忽略
  return { action: 'ignore', reason: 'no_order_id' };
}

/**
 * 处理已验签的 SmsForwarder webhook。
 * @param {object} opts
 * @param {object} opts.cfg 激活服务器配置（含 webhookSecret、botNotifyUrl）
 * @param {object} opts.store
 * @param {*} opts.payload 已解析的 JSON body
 * @param {string} [opts.rawBody] 原始请求体（用于可选 HMAC 校验 / 坏 JSON 兜底存盘）
 * @param {object} [opts.headers] 请求头
 * @returns {{status:number, body:object}}
 */
function handleWechatWebhook({ cfg, store, payload, rawBody, headers }) {
  const parsed = parser.parseWechatPayload(payload || {});
  const m = matchOrder(store, { orderId: parsed.orderId, amount: parsed.amount });

  // 先定「匹配结论」，再落盘收件（含匹配结论），最后才执行副作用（markPaid）。
  // 这样即便后续 markPaid 抛错，原始收件也已落盘。
  let logMatched = false;
  let logOrderId = null;
  let logReason = 'unknown';
  if (m.action === 'markPaid' || m.action === 'dedup') {
    logMatched = true;
    logReason = 'matched';
    logOrderId = m.orderId || null;
  } else {
    // ignore：未匹配（无单号 / 未知单号）
    logReason = m.reason || 'no_order_found';
  }

  // 原始 body：优先完整 JSON 对象；坏 JSON（payload={}）时退化存原始字符串
  const rawValue = (payload && typeof payload === 'object' && Object.keys(payload).length)
    ? payload
    : (rawBody || '');

  // 先存原始收件（密钥已通过，secretOk=true）。日志写入失败不得中断主流程。
  try {
    webhookLog.appendWebhookLog({
      ts: Date.now(),
      matched: logMatched,
      orderId: logOrderId,
      reason: logReason,
      content: extractContent(payload),
      amount: (typeof parsed.amount === 'number') ? parsed.amount : null,
      secretOk: true,
      raw: rawValue,
    });
  } catch (_) { /* 收件日志异常由 webhookLog 内部兜底，这里再兜一层，主流程照常 */ }

  // ---- 匹配成功：markPaid（副作用，仅此分支触发发码）----
  if (m.action === 'markPaid') {
    // 幂等：终态不回退
    orders.markPaid(store, m.orderId, {
      channel: 'smsforwarder_wechat',
      trade_no: parsed.orderId ? `smsfwd-${parsed.orderId}` : `smsfwd-${m.orderId}-${Date.now()}`,
    });
    // 触发 bot 发 license（回调，best-effort；未配置 BOT_NOTIFY_URL 时为 no-op）
    const note = botNotify.notifyOrderPaid(cfg, m.orderId);
    return {
      status: 200,
      body: {
        ok: true,
        matched: true,
        order_id: m.orderId,
        matched_by: m.matched_by || 'order_id',
        amount: parsed.amount,
        notified: !!note.notified,
      },
    };
  }

  // ---- 重复推送（已 paid/issued）：幂等 200 + dedup:true，不重复发码 ----
  if (m.action === 'dedup') {
    return {
      status: 200,
      body: {
        ok: true,
        matched: true,
        dedup: true,
        order_id: m.orderId,
        status: m.order && m.order.status,
      },
    };
  }

  // ---- 未匹配（无单号 / 未知单号）：200 已收，绝不发码 ----
  return {
    status: 200,
    body: {
      ok: true,
      received: true,
      matched: false,
      reason: logReason,
    },
  };
}

module.exports = {
  isWechatChannel,
  verifyWebhookSecret,
  verifySignature,
  matchOrder,
  handleWechatWebhook,
  extractContent,
};
