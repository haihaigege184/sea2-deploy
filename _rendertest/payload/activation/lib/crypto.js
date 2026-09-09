'use strict';
/**
 * crypto.js — 激活系统密码学原语
 * - RSA 密钥对生成（激活服务器持有私钥，客户端仅持有公钥）
 * - license 规范化(JSON 排序) + RSA 签名/验签
 * - 机器码派生 HMAC
 * 全部使用 Node 内置 crypto，无第三方依赖。
 */
const crypto = require('node:crypto');

const RSA_MODULUS = 2048;

/** 生成 RSA 密钥对，返回 PEM 字符串 */
function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/** 递归按 key 排序，保证签名确定性 */
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
}

/** 规范化 JSON 字符串（用于签名/验签），剔除 signature 字段 */
function canonicalize(payload) {
  const { signature, ...rest } = payload;
  return JSON.stringify(sortKeys(rest));
}

/** 用私钥对 license 负载签名，返回 base64 */
function signLicense(privateKeyPem, payload) {
  const data = canonicalize(payload);
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(privateKeyPem, 'base64');
}

/** 用公钥验证 license 签名 */
function verifyLicense(publicKeyPem, payload) {
  const { signature, ...rest } = payload;
  if (!signature || typeof signature !== 'string') return false;
  const data = canonicalize(rest);
  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(data);
  verify.end();
  try {
    return verify.verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}

/** HMAC-SHA256，用于机器码派生 */
function hmac(seed, msg) {
  return crypto.createHmac('sha256', seed).update(msg, 'utf8').digest('hex');
}

/** 生成随机十六进制串 */
function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 生成带分组的激活码 SEA1-XXXX-XXXX-XXXX（base32 无歧义字符集） */
function generateActivationCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除 I O 0 1
  const pick = () => alphabet[crypto.randomInt(0, alphabet.length)];
  const group = (n) => Array.from({ length: n }, pick).join('');
  return `SEA1-${group(4)}-${group(4)}-${group(4)}`;
}

module.exports = {
  RSA_MODULUS,
  generateKeyPair,
  canonicalize,
  signLicense,
  verifyLicense,
  hmac,
  randomHex,
  generateActivationCode,
};
