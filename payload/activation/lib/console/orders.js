'use strict';
/**
 * lib/console/orders.js — 订单富视图 + 开通会员
 *
 * 开通会员（grantMember）严格复用与 server.js /api/order/issue 一致的签发逻辑：
 *   codes.makeCodeRecord → license.buildLicense(keys.privateKey,…) →
 *   store.createCode / saveLicense / updateCode(active) / orders.attachCode
 * 不自建加密，保证激活码 + license 生成与既有激活流程完全一致。
 */

const codes = require('../codes');
const license = require('../license');
const ordersLib = require('../orders');
// [T1-P1-8] 签发即刷新 fleet 快照（试用→激活即时转换）
const fleetStore = require('../fleetStore');
// [T1-P1-7] 激活成功 → 回调 bot 推送群通知（best-effort）
const botNotifier = require('../botNotifier');
const devices = require('./devices');

const PLAN_NAME = { month: '月度会员', quarter: '季度会员', year: '年度会员', lifetime: '永久授权' };
const PRICE_NAME = { 5: '月度会员', 12: '季度会员', 48: '年度会员', 128: '永久授权' };

function planNameOf(order) {
  if (order.plan && PLAN_NAME[order.plan]) return PLAN_NAME[order.plan];
  if (PRICE_NAME[order.amount]) return PRICE_NAME[order.amount];
  return order.plan || '';
}

/**
 * 订单富查询（支持按 status / qq / limit 过滤）。
 *
 * [T2 P2-11] status 支持特殊值 `hung`：异常悬挂单（status=paid 但尚未发码 issued）。
 * 与 fleet meta 的 orderStatus 枚举（paid/issued/pending/await_verify/expired/cancelled）正交，
 * 是「对账视图」用的派生筛选，不改变订单真实 status 字段。
 */
function richList(store, { status, qq, limit } = {}) {
  let list = store.listOrders();
  if (status === 'hung') {
    list = list.filter((o) => o.status === 'paid' && !o.code);
  } else if (status) {
    list = list.filter((o) => o.status === status);
  }
  if (qq) list = list.filter((o) => String(o.qq) === String(qq));
  list = list.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return list.slice(0, n).map((o) => ({
    order_id: o.order_id,
    qq: o.qq,
    machine_id: o.machine_id || '',
    plan: o.plan || '',
    planName: planNameOf(o),
    channel: o.channel || '',
    amount: o.amount != null ? o.amount : 0,
    status: o.status,
    // 派生：异常悬挂 = 已支付但未发码（对账视图高亮依据；不影响真实 status）
    hung: o.status === 'paid' && !o.code,
    created_at: o.created_at || 0,
    paid_at: o.paid_at || 0,
    issued_at: o.issued_at || 0,
    code: o.code || '',
  }));
}

function _resolveMachineId(store, qq) {
  const q = String(qq);
  const os = store.listOrders()
    .filter((o) => String(o.qq) === q)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (os.length && os[0].machine_id) return os[0].machine_id;
  const cs = store.listCodes().filter((c) => String(c.customer) === q);
  for (const c of cs) if (c.bound_machine_id) return c.bound_machine_id;
  return '';
}

/**
 * 执行签发（与 /api/order/issue 一致）。
 * @returns {{ok:boolean, code?:string, license?:object, status?:string, order_id?:string, message?:string, error?:string}}
 */
function _issue(store, keys, cfg, { qq, plan, machine_id, order_id }) {
  const p = (cfg && cfg.plans && cfg.plans[plan]) || null;
  if (!p) return { ok: false, error: '未知套餐: ' + plan };
  // [T1-P1-4] expires_at 统一为「秒」：此前毫秒与 crud/makeCodeRecord 的秒值混用，
  // 导致 codes.isCodeExpired 按秒比较时毫秒值永不过期（存量毫秒值由 normalizeExpiresAt 换算）。
  const expires_at = p.durationDays > 0 ? Math.floor(Date.now() / 1000) + p.durationDays * 86400 : 0;
  const rec = codes.makeCodeRecord({
    customer: String(qq),
    features: (p && p.features) || ['*'],
    expires_at,
    max_groups: 0,
  });
  store.createCode(rec);
  const lic = license.buildLicense(keys.privateKey, {
    machine_id: machine_id || '',
    code: rec.code,
    customer: rec.customer,
    features: rec.features,
    expires_at: rec.expires_at || 0,
    max_groups: rec.max_groups,
  });
  store.saveLicense({ code: rec.code, license: lic, hmac: license.licenseHmac('sea1-lic', lic) });
  store.updateCode(rec.code, { status: 'active', bound_machine_id: machine_id || null });
  if (order_id) ordersLib.attachCode(store, order_id, rec.code);

  // [T1-P1-8] 签发即刷新 fleet 快照（试用→激活即时转换，集群页无需等心跳）
  // best-effort：快照刷新失败绝不影响签发结果。
  if (machine_id) {
    try {
      fleetStore.getInstance().setLicenseState(machine_id, {
        code: rec.code,
        qq: String(qq),
        license: lic,
        reason: 'ok',
        valid: true,
        licenseState: 'valid',
        isTrial: false,
        trialInfo: null,
        licenseCheckedAt: Math.floor(Date.now() / 1000),
      });
    } catch (e) { /* ignore */ }
  }

  // [T1-P1-7] 激活成功 → 回调 bot 推送「开通成功」群通知（best-effort；未配置 BOT_NOTIFY_URL 为 no-op）
  let activatedNotify = null;
  try {
    activatedNotify = order_id ? botNotifier.notifyActivated(cfg, order_id, { qq: String(qq), plan }) : null;
  } catch (e) {
    activatedNotify = { notified: false, error: String((e && e.message) || e) };
  }

  return {
    ok: true, status: 'issued', order_id: order_id || null, code: rec.code, license: lic,
    notify: order_id ? { event: 'activated', order_id, notified: !!(activatedNotify && activatedNotify.notified) } : null,
  };
}

/**
 * 开通会员。
 *  - 基于订单：orderId 命中已 issued 订单 → 返回既有；状态非 paid → 报错；paid → 签发并 attachCode。
 *  - 基于 qq + plan：无订单，按 store 中该 qq 的 machine_id（或空）签发。
 * @returns {{ok:boolean, code?:string, license?:object, status?:string, order_id?:string, already?:boolean, message?:string, error?:string}}
 */
function grantMember(store, keys, cfg, { orderId, qq, plan } = {}) {
  if (orderId) {
    const o = store.getOrder(orderId);
    if (!o) return { ok: false, error: '订单不存在' };
    if (o.status === 'issued' && o.code) {
      const licRec = store.getLicense(o.code);
      return { ok: true, already: true, status: 'issued', order_id: o.order_id, code: o.code, license: licRec ? licRec.license : null, message: '该订单已签发' };
    }
    if (o.status !== 'paid') {
      return { ok: false, error: '订单尚未支付: ' + o.status };
    }
    return _issue(store, keys, cfg, { qq: o.qq, plan: o.plan, machine_id: o.machine_id, order_id: o.order_id });
  }

  if (qq && plan) {
    const machine_id = _resolveMachineId(store, qq);
    return _issue(store, keys, cfg, { qq, plan, machine_id, order_id: null });
  }

  return { ok: false, error: '需要 orderId 或 {qq, plan}' };
}

/**
 * [T2 P2-11] 订单审计·取消会员（改已支付→未支付并吊销已发 code）。
 *
 * 语义（对齐 fleet meta orderStatus 枚举）：
 *  - 目标状态置为 `cancelled`（终态，避免误重开导致二次发码）；
 *  - 已发 code（status=issued）→ 走 devices.disable 吊销激活码（客户端下次心跳即降级）；
 *  - paid_at/issued_at 清零，code 置空，revoked_code 留痕供审计回溯。
 *
 * 校验：订单不存在 → 404；已是 pending/await_verify/expired/cancelled → 400（无会员可取消）。
 * @param {Object} store
 * @param {string} orderId
 * @returns {{ok:boolean, before?:object, after?:object, revokedCode?:string, status?:number, error?:string}}
 */
function revokeMember(store, orderId) {
  const o = store.getOrder(orderId);
  if (!o) return { ok: false, error: '订单不存在', status: 404 };
  if (o.status === 'pending' || o.status === 'await_verify') {
    return { ok: false, error: '订单未支付，无需取消会员: ' + o.status, status: 400 };
  }
  if (o.status === 'cancelled') {
    return { ok: false, error: '订单已取消', status: 400 };
  }
  if (o.status === 'expired') {
    return { ok: false, error: '订单已过期，无需取消', status: 400 };
  }
  const before = Object.assign({}, o);
  let revokedCode = '';
  if (o.code) {
    revokedCode = o.code;
    // 吊销激活码（best-effort：code 记录缺失也不阻断取消流程）
    try { devices.disable(store, o.code); } catch (e) { /* ignore */ }
  }
  o.status = 'cancelled';
  o.paid_at = 0;
  o.issued_at = 0;
  o.revoked_at = Date.now();
  o.revoked_code = revokedCode || null;
  o.code = null;
  store.saveOrder(o);
  return { ok: true, before, after: Object.assign({}, o), revokedCode };
}

module.exports = { richList, grantMember, revokeMember, planNameOf };
