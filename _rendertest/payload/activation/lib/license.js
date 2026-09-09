'use strict';
/**
 * license.js — license 对象构建 / 签名 / 校验
 */
const crypto = require('./crypto');

/** 构建并签名一份 license（服务端调用，需私钥） */
function buildLicense(privateKeyPem, fields) {
  const now = Math.floor(Date.now() / 1000);
  const lic = {
    version: 1,
    machine_id: fields.machine_id,
    code: fields.code,
    customer: fields.customer || '',
    features: Array.isArray(fields.features) ? fields.features : ['print', 'a3', 'batch', 'web'],
    issued_at: fields.issued_at || now,
    expires_at: fields.expires_at,
    max_groups: fields.max_groups || 10,
  };
  lic.signature = crypto.signLicense(privateKeyPem, lic);
  return lic;
}

/**
 * 校验 license（客户端/服务端调用，需公钥）
 * 返回 { ok, reason, license }
 */
function verifyLicenseObject(publicKeyPem, lic) {
  if (!lic || typeof lic !== 'object') return { ok: false, reason: 'empty' };
  if (!crypto.verifyLicense(publicKeyPem, lic)) return { ok: false, reason: 'bad-signature' };
  const required = ['version', 'machine_id', 'code', 'features', 'issued_at', 'expires_at'];
  for (const k of required) if (!(k in lic)) return { ok: false, reason: `missing:${k}` };
  const now = Math.floor(Date.now() / 1000);
  if (lic.expires_at && now > lic.expires_at) return { ok: false, reason: 'expired' };
  if (lic.issued_at && now < lic.issued_at) return { ok: false, reason: 'not-yet-valid' };
  return { ok: true, reason: 'ok', license: lic };
}

/** 防篡改：对 license 做 HMAC 自校验串（存盘后用，检测文件被手改） */
function licenseHmac(seed, lic) {
  const { signature, ...rest } = lic;
  return crypto.hmac(seed, JSON.stringify(rest) + '|' + signature);
}

module.exports = { buildLicense, verifyLicenseObject, licenseHmac };
