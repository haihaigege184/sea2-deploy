'use strict';
/**
 * payments.js — 支付结果监控（解耦于激活签发）
 *
 * 两种落地模式，由环境变量 PAYMENT_MODE 选择：
 *
 * 1) manual（默认，适配个人支付宝/微信收款码）
 *    - 用户扫码付款后，在机器人里发「已支付 <订单号>」。
 *    - 服务端校验：仅下单者本人(QQ 一致)可确认 → 标记 await_verify（待核验）。
 *    - 此时【绝不】直接 markPaid：用户只是「申报」付款，不代表真付款。
 *    - 真正的 paid 由支付宝账单监控器（见 activation-server/monitor/）或商户后台
 *      核验到账后，调用 /api/admin/order/confirm 推进。随后才允许发码。
 *    - 这是当下个人码可用、且零资质依赖的「半自动」监控入口（安全加固版）。
 *
 * 2) webhook（适配支付宝/微信【商户】平台异步通知 notify_url）
 *    - 商户后台把 notify_url 指向本服务的 /api/pay/notify。
 *    - 服务端按渠道验签（支付宝 RSA2 / 微信 V2 HMAC / 共享密钥代理）→ 标记 paid。
 *    - 这是「全自动」商业标准路径。
 *
 * 无论哪种模式，paid 之后都由 /api/order/issue 生成并绑定 license。
 */

const crypto = require('node:crypto');
const orders = require('./orders');

// ---------- 渠道验签实现 ----------

/** 支付宝异步通知：RSA2 验签（sign_type=RSA2） */
function verifyAlipay(pubKey, params) {
  const sign = params.sign;
  if (!sign) return { ok: false, error: '缺少 sign' };
  if (!pubKey) return { ok: false, error: '未配置支付宝公钥' };
  const kv = Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && v !== '' && v != null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(kv, 'utf8');
    const ok = verifier.verify(pubKey, sign, 'base64');
    return { ok, error: ok ? null : '支付宝签名校验失败' };
  } catch (e) {
    return { ok: false, error: '支付宝验签异常: ' + e.message };
  }
}

/** 微信支付 V2 异步通知：MD5 / HMAC-SHA256 验签 */
function verifyWechatV2(key, params, signType) {
  const sign = params.sign;
  if (!sign) return { ok: false, error: '缺少 sign' };
  if (!key) return { ok: false, error: '未配置微信 API 密钥' };
  const st = (signType || params.sign_type || 'MD5').toUpperCase();
  const kv = Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && v !== '' && v != null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&') + `&key=${key}`;
  const algo = st === 'HMAC-SHA256' ? 'sha256' : 'md5';
  const calc = crypto.createHash(algo).update(kv, 'utf8').digest('hex').toUpperCase();
  const ok = calc === String(sign).toUpperCase();
  return { ok, error: ok ? null : '微信签名校验失败' };
}

/** 自建/第三方网关：共享密钥 HMAC 验签 */
function verifySharedSecret(secret, params) {
  const sign = params.sign;
  if (!sign) return { ok: false, error: '缺少 sign' };
  if (!secret) return { ok: false, error: '未配置 webhook 共享密钥' };
  const calc = crypto.createHmac('sha256', secret)
    .update(`${params.out_trade_no}|${params.total_amount}|${params.trade_status || 'SUCCESS'}`)
    .digest('hex');
  const ok = calc === sign;
  return { ok, error: ok ? null : '网关签名校验失败' };
}

class PaymentMonitor {
  /**
   * @param {object} cfg
   * @param {string} cfg.mode  'manual' | 'webhook'
   * @param {string} [cfg.alipayPublicKey]
   * @param {string} [cfg.wechatApiKey]
   * @param {string} [cfg.webhookSecret]
   */
  constructor(cfg = {}) {
    this.mode = cfg.mode || 'manual';
    this.cfg = cfg;
  }

  /**
   * 个人码场景：仅下单者本人可「申报」付款。
   *
   * 安全加固（2025-07-30）：这里【不再】直接 markPaid，而是把订单推进到
   * await_verify（待核验）中间态。只有支付宝账单监控器或商户后台核验到账后，
   * 调用 /api/admin/order/confirm 才会真正 markPaid。
   * 这样即便用户没付款、只发了句「已支付」，也拿不到 license（白嫖漏洞已堵死）。
   *
   * @returns {{ok:boolean, error?:string, already?:boolean, status?:string}}
   *          status 为 'await_verify' 表示已受理申报、等待核验；
   *          already:true 且 status 为 paid/issued 表示早已核验通过（幂等）。
   */
  confirmManual(store, orderId, qq) {
    const o = store.getOrder(orderId);
    if (!o) return { ok: false, error: '订单不存在' };
    if (o.qq !== String(qq)) return { ok: false, error: '仅下单者本人可确认' };
    // 已核验通过（paid/issued）：幂等返回，让上游知道无需再等
    if (o.status === 'paid' || o.status === 'issued') return { ok: true, already: true, status: o.status };
    if (o.status === 'expired') return { ok: false, error: '订单已过期，请重新下单' };
    if (o.status === 'await_verify') return { ok: true, already: true, status: 'await_verify' };
    // 关键修复：仅标记「待核验」，不直接发码
    const updated = orders.markAwaitVerify(store, orderId, { channel: o.channel });
    if (!updated) return { ok: false, error: '订单状态更新失败' };
    return { ok: true, status: 'await_verify' };
  }

  /** 商户 webhook 入口 */
  async handleWebhook(store, channel, params) {
    if (this.mode !== 'webhook') return { ok: false, error: '未启用 webhook 模式（当前为 manual）' };
    const v = this._verifierFor(channel)(params);
    if (!v.ok) return v;
    const orderId = params.out_trade_no || params.order_id;
    if (!orderId) return { ok: false, error: '通知缺少订单号(out_trade_no)' };
    const o = store.getOrder(orderId);
    if (!o) return { ok: false, error: '订单不存在' };
    const paidAmount = Number(params.total_amount || params.cash_fee || params.amount || 0);
    if (o.amount && paidAmount && Math.abs(paidAmount - o.amount) > 0.001) {
      return { ok: false, error: `金额不符：订单 ${o.amount}，通知 ${paidAmount}` };
    }
    const tradeNo = params.trade_no || params.transaction_id || params.tradeId;
    orders.markPaid(store, orderId, { channel, trade_no: tradeNo });
    return { ok: true, order_id: orderId };
  }

  _verifierFor(channel) {
    const c = this.cfg;
    switch (channel) {
      case 'alipay':
        return (p) => verifyAlipay(c.alipayPublicKey, p);
      case 'wechat':
        return (p) => verifyWechatV2(c.wechatApiKey, p, p.sign_type);
      case 'proxy':
        return (p) => verifySharedSecret(c.webhookSecret, p);
      default:
        return () => ({ ok: false, error: `不支持的支付渠道: ${channel}` });
    }
  }
}

module.exports = {
  PaymentMonitor,
  verifyAlipay, verifyWechatV2, verifySharedSecret,
};
