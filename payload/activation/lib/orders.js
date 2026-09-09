'use strict';
/**
 * orders.js — 订单生命周期（支付/激活绑定的数据层）
 *
 * 状态机：
 *   pending --(用户申报付款)--> await_verify --(监控器/商户核验到账)--> paid --(发码激活)--> issued
 *   pending / await_verify --(超时未付)--> expired
 *
 * 安全加固说明（2025-07-30）：
 *   个人收款码场景下，用户发「已支付 <订单号>」只是【申报】，并不代表真实付款。
 *   因此新增 await_verify 中间态：confirmManual 不再直接 markPaid，
 *   而是由支付宝账单监控器（或商户后台）核验到账无误后，
 *   调用 /api/admin/order/confirm 把状态推进到 paid，之后才允许发码。
 *   这样「申报」与「真正发码」彻底解耦，杜绝「未付款却白嫖 license」的漏洞。
 *
 * 与激活服务器的解耦：
 *   - 本模块只负责订单数据的创建/更新/查询。
 *   - 真正生成激活码 + license 的逻辑在 server.js（需要服务端私钥）。
 *   - 这样支付监控（订单侧）与授权签发（license 侧）职责清晰、可独立测试。
 */

const crypto = require('./crypto');

function makeOrderId() {
  // 新订单号（激活流程简化）：sea + YYYYMMDDhhmmss（14 位秒级时间戳，全小写）。
  // 例：sea20260729123059。旧 SEA1- 格式仍兼容解析与匹配（见 lib/wechatParser.js）。
  // 详见 system_design_activation_simplify.md §3.1。
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `sea${ts}`;
}

/**
 * 生成「人工确认码」：仅展示给下单者本人（与其 QQ 绑定），
 * 用于个人收款码场景下「已支付」指令的轻量校验，防他人误确认。
 */
function makeConfirmCode(orderId, qq) {
  return crypto.hmac('confirm', `${orderId}:${qq}`).slice(0, 8).toUpperCase();
}

/**
 * 判定是否为「微信家族」通道。
 * 当前 bot 创建订单时发 channel='wechat'，未来可发 'smsforwarder_wechat'；
 * 两者均启用「唯一化偏移 + 金额匹配」，使 SmsForwarder 金额匹配可靠。
 * 单一事实来源，供本模块与 lib/wechatWebhook.js 共用。
 * @param {string} ch
 * @returns {boolean}
 */
function isWechatChannel(ch) {
  return ch === 'smsforwarder_wechat' || ch === 'wechat';
}

function createOrder(store, { qq, machine_id, plan, channel, amount, expire_at }) {
  const now = Date.now();
  const recChannel = channel || 'alipay';
  const baseAmount = typeof amount === 'number' ? amount : 0;
  // 激活流程简化：微信通道不再引入金额偏移，金额 = 基准价（纯备注匹配，金额不再作为匹配主键）。
  const recAmount = baseAmount;

  // 生成订单号（sea + 14 位秒级时间戳）；同秒撞号则追加 2 位序号后缀（如 sea20260801120000-01），
  // 保证唯一（已被 ORDER_RE 解析正则覆盖，见 lib/wechatParser.js）。
  let order_id = makeOrderId();
  let seq = 0;
  while (store.getOrder(order_id)) {
    seq++;
    order_id = `${makeOrderId()}-${String(seq % 100).padStart(2, '0')}`;
  }

  const rec = {
    order_id,
    qq: String(qq),
    machine_id,
    plan,
    channel: recChannel,
    amount: recAmount,
    amount_offset: 0, // 偏移已停用（简化匹配），保留字段以兼容历史记录
    status: 'pending',
    created_at: now,
    expire_at: expire_at || (now + 30 * 60 * 1000), // 默认 30 分钟有效
    paid_at: 0,
    issued_at: 0,
    code: null,
    confirm_code: makeConfirmCode(order_id, String(qq)),
  };
  return store.saveOrder(rec);
}

function getOrder(store, orderId) {
  return store.getOrder(orderId);
}

function markPaid(store, orderId, { channel, trade_no } = {}) {
  const o = store.getOrder(orderId);
  if (!o) return null;
  if (o.status === 'issued') return o; // 已发码，幂等
  o.status = 'paid';
  o.paid_at = Date.now();
  if (channel) o.paid_channel = channel;
  if (trade_no) o.trade_no = trade_no;
  return store.saveOrder(o);
}

/**
 * 标记「待核验」（await_verify）：仅个人码场景的 confirmManual 调用。
 * 含义：用户已申报付款，但系统尚未确认真实到账，禁止发码。
 * 幂等：已是 await_verify 直接返回；已是 paid/issued/expired 则保持原状不回退。
 *
 * @param {object} store
 * @param {string} orderId
 * @param {{channel?: string}} [opts]
 * @returns {object|null} 更新后的订单记录，或 null（订单不存在）
 */
function markAwaitVerify(store, orderId, { channel } = {}) {
  const o = store.getOrder(orderId);
  if (!o) return null;
  // 已进入终态（paid/issued/expired）则维持原状，避免状态回退造成混乱
  if (o.status === 'paid' || o.status === 'issued' || o.status === 'expired') return o;
  o.status = 'await_verify';
  o.await_verify_at = Date.now();
  if (channel) o.paid_channel = channel;
  return store.saveOrder(o);
}

function markExpired(store, orderId) {
  const o = store.getOrder(orderId);
  if (!o) return null;
  if (o.status !== 'pending') return o;
  o.status = 'expired';
  return store.saveOrder(o);
}

function attachCode(store, orderId, code) {
  const o = store.getOrder(orderId);
  if (!o) return null;
  o.status = 'issued';
  o.issued_at = Date.now();
  o.code = code;
  return store.saveOrder(o);
}

/**
 * 定时清理：把超时的 pending 订单标记 expired（由 server 定时调用）。
 */
function sweepExpired(store) {
  const now = Date.now();
  let n = 0;
  for (const o of store.listOrders()) {
    // await_verify 同样参与超时清理：若长时间未被监控器/商户核验到账，
    // 视为放弃/异常，回退为 expired，避免订单永久悬挂（用户可重新申报）。
    if ((o.status === 'pending' || o.status === 'await_verify') && o.expire_at && now > o.expire_at) {
      o.status = 'expired';
      n++;
    }
  }
  if (n) store._flush();
  return n;
}

module.exports = {
  makeOrderId, makeConfirmCode, isWechatChannel,
  createOrder, getOrder, markPaid, markAwaitVerify, markExpired, attachCode, sweepExpired,
};
