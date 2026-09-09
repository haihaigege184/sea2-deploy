'use strict';
/**
 * verify.js — license 验签（客户端侧，仅需公钥）
 * 与激活服务端使用相同的规范化(JSON 排序)+RSA-SHA256 方案。
 */
const crypto = require('node:crypto');

function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
}

function verifyLicense(publicKeyPem, lic) {
  if (!lic || typeof lic !== 'object') return { ok: false, reason: 'empty' };
  const { signature, ...rest } = lic;
  if (!signature || typeof signature !== 'string') return { ok: false, reason: 'no-signature' };
  const data = JSON.stringify(sortKeys(rest));
  const v = crypto.createVerify('RSA-SHA256');
  v.update(data);
  v.end();
  try {
    if (!v.verify(publicKeyPem, signature, 'base64')) return { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  const required = ['version', 'machine_id', 'code', 'features', 'issued_at', 'expires_at'];
  for (const k of required) if (!(k in lic)) return { ok: false, reason: `missing:${k}` };
  const now = Math.floor(Date.now() / 1000);
  if (lic.expires_at && lic.expires_at > 0 && now > lic.expires_at) return { ok: false, reason: 'expired' };
  if (lic.issued_at && now < lic.issued_at) return { ok: false, reason: 'not-yet-valid' };
  return { ok: true, reason: 'ok', license: lic };
}

module.exports = { verifyLicense };
