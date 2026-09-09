'use strict';
/**
 * lib/alipay.js — 支付宝当面付（alipay.trade.precreate）动态下单
 *
 * 零依赖实现：用 node:crypto 做 RSA2 签名，node:https 调网关。
 * 返回订单专属收款二维码内容字符串（qrCode），客户端转成图片发给用户。
 *
 * 密钥来源（环境变量）：
 *   ALIPAY_APP_ID          应用 APPID
 *   ALIPAY_PRIVATE_KEY     应用私钥（PKCS8 格式，含 -----BEGIN/END-----）
 *   ALIPAY_PUBLIC_KEY      支付宝公钥（验签回调用，已存在于 server.js 配置）
 *
 * 安全要点：
 *   - 私钥只在本机内存/环境变量，绝不下发前端
 *   - 签名用 SHA256WithRSA（RSA2）
 *   - notify_url 必须是公网 HTTPS（由 server.js 的 publicBaseUrl 提供）
 */

const crypto = require('node:crypto');
const https = require('node:https');
const QRCode = require('qrcode');

// 过滤空值并排序，拼成阿里签名串
function buildSignContent(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function sign(params, privateKey) {
  const content = buildSignContent(params);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  return signer.sign(normalizeKey(privateKey), 'base64');
}

// 兼容多种私钥格式
function normalizeKey(key) {
  if (!key) return key;
  if (key.includes('BEGIN')) return key;
  // 纯 base64：尝试 PKCS8 头尾
  const pem = `-----BEGIN PRIVATE KEY-----\n${key.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  return pem;
}

function postForm(gateway, form) {
  return new Promise((resolve, reject) => {
    const body = Object.entries(form)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const u = new URL(gateway);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('网关超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 当面付预下单，返回 { qrCode, outTradeNo, tradeNo? }
 * 失败抛出 Error（调用方应降级到静态收款码）
 */
async function precreate(opts) {
  const { appId, privateKey, gateway, outTradeNo, totalAmount, subject, notifyUrl } = opts;
  if (!appId || !privateKey) throw new Error('缺少 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY');

  const bizContent = JSON.stringify({
    out_trade_no: outTradeNo,
    total_amount: Number(totalAmount).toFixed(2),
    subject,
    notify_url: notifyUrl || undefined,
  });

  const params = {
    app_id: appId,
    method: 'alipay.trade.precreate',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toLocaleString('sv-SE').replace('T', ' '),
    version: '1.0',
    biz_content: bizContent,
  };
  params.sign = sign(params, privateKey);

  const resp = await postForm(gateway, params);
  let json;
  try {
    // 响应形如 { "alipay_trade_precreate_response": {...}, "sign": "..." }
    json = JSON.parse(resp);
  } catch (e) {
    throw new Error('网关响应解析失败: ' + resp.slice(0, 200));
  }
  const r = json.alipay_trade_precreate_response;
  if (!r) throw new Error('网关响应缺少主体: ' + resp.slice(0, 200));
  if (r.code !== '10000') {
    throw new Error(`支付宝错误 ${r.code}: ${r.sub_msg || r.msg}`);
  }
  // 直接生成二维码 PNG 的 base64（data URL），供客户端直接发图，零额外依赖
  const qrPngBase64 = await QRCode.toDataURL(r.qr_code, { margin: 1, width: 320 });
  return { qrCode: r.qr_code, qrPngBase64, outTradeNo, tradeNo: r.out_trade_no };
}

module.exports = { precreate, sign, buildSignContent };
