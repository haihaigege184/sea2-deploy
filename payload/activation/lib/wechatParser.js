'use strict';
/**
 * wechatParser.js — SmsForwarder 转发 payload 的「字段无关」解析
 *
 * SmsForwarder 转发的字段名不固定（可能嵌套 / 改名 / 多包一层），因此本模块
 * 不依赖任何固定字段名：递归遍历整个 payload 的所有字符串叶子值，从中抽取
 * 金额、订单号（SEA1- 前缀）与备注文本。对齐 monitor/ 下 alipay-bill-monitor.js
 * 的「遍历文本抽金额/单号」风格。
 *
 * 解析优先级：
 *   - 金额：取首个 ¥/￥ 前缀的金额（兼容全角 ￥、千分位逗号、以及「N元」写法）。
 *   - 订单号：取首个含 SEA1- 片段的字符串中的订单号（标准化大写）。
 *   - 备注：若命中订单号，保留含订单号的原始片段；否则保留全部文本供人工核查。
 */

// 金额：¥ 或 ￥ 前缀，后跟数字（支持千分位逗号，可选 1-2 位小数）
const AMOUNT_RE = /[¥￥]\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/g;
// 金额（备用）：数字后跟「元」（支持千分位逗号）
const AMOUNT_YUAN_RE = /\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*元/g;
// 订单号：① 旧 SEA1- 前缀（大小写不敏感，后续统一大写）
//        ② 新 sea + 14 位秒级时间戳（可选 -XX 序号后缀，全小写；见 lib/orders.js makeOrderId）
// 统一解析：兼容两种格式，同时保留各自的大小写语义（新单号小写，旧单号大写）。
const ORDER_RE = /(?:SEA1-[A-Za-z0-9-]+|sea\d{14}(?:-\d{1,2})?)/i;

/**
 * 从单段文本抽取首个金额（单位：元）。兼容 ¥/￥ 前缀与「N元」写法。无则返回 null。
 * @param {string} text
 * @returns {number|null}
 */
function extractAmount(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(AMOUNT_RE);
  if (m) return normalizeAmount(m[0]);
  const y = text.match(AMOUNT_YUAN_RE);
  if (y) return normalizeAmount(y[0]);
  return null;
}

/** 清洗并解析金额为 number；失败返回 null。 */
function normalizeAmount(s) {
  const cleaned = String(s).replace(/[¥￥\s元,]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从单段文本抽取首个订单号。
 * - 新单号（sea + 14 位数字，可选 -XX 后缀）：保持小写（与 makeOrderId 输出一致），否则 store.getOrder 查不到。
 * - 旧单号（SEA1-...）：保持原样大写。
 * 无则返回 null。
 * @param {string} text
 * @returns {string|null}
 */
function extractOrderId(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(ORDER_RE);
  if (!m) return null;
  const raw = m[0];
  // 新单号：保持小写（与 makeOrderId 输出一致）
  if (/^sea\d{14}(?:-\d{1,2})?$/i.test(raw)) return raw.toLowerCase();
  // 旧单号 SEA1-...：保持原样大写
  return raw.toUpperCase();
}

/**
 * 递归收集对象中所有「字符串叶子值」（含数组 / 嵌套对象 / 基本类型转字符串）。
 * @param {*} node
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectStrings(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((x) => collectStrings(x, out));
    return out;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectStrings(node[k], out);
  }
  return out;
}

/**
 * 解析整个 SmsForwarder payload。
 * @param {*} payload  任意结构的 JSON 对象（字段名不固定）
 * @returns {{amount:?number, amounts:number[], orderId:?string, remark:?string, rawText:string}}
 */
function parseWechatPayload(payload) {
  const strings = collectStrings(payload);
  const rawText = strings.join('\n');
  const amounts = [];
  for (const s of strings) {
    const a = extractAmount(s);
    if (a != null) amounts.push(a);
  }
  // 订单号：优先取含 SEA1- 片段的字符串中的订单号
  let orderId = null;
  let remark = null;
  for (const s of strings) {
    const oid = extractOrderId(s);
    if (oid) {
      orderId = oid;
      remark = s; // 保留含订单号的原始片段作为备注
      break;
    }
  }
  // 备注兜底：若无订单号，保留全部文本供人工核查
  if (!remark && strings.length) remark = rawText.slice(0, 2000);
  return {
    amount: amounts.length ? amounts[0] : null,
    amounts,
    orderId,
    remark,
    rawText,
  };
}

module.exports = { extractAmount, extractOrderId, parseWechatPayload, collectStrings, AMOUNT_RE, ORDER_RE };
