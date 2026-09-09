'use strict';
/**
 * lib/ops/totp.js — TOTP（RFC 6238）实现（Totp，sea2 强门禁二次验证）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §3.1 / §7.9
 *
 * 规格：
 *  - HMAC-SHA1，6 位数字；
 *  - 时间步长 30s（T0 = 0）；
 *  - 校验容差 ±1 窗口（window=1 → 检查 [now-1, now, now+1]）；
 *  - node:crypto 实现，零新增依赖（不引入 otplib）。
 *
 * 兼容性：与 Google Authenticator 相同算法（base32 密钥 + HMAC-SHA1 + 6 位）。
 */

const crypto = require('node:crypto');

const STEP_SEC = 30;
const DIGITS = 6;

/** RFC 4648 base32 字母表 */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * base32 编码（无 padding，便于展示/存储）。
 * @param {Buffer} buf
 * @returns {string}
 */
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * base32 解码（宽容：忽略空格/连字符，容忍小写，容忍 padding '='）。
 * @param {string} str
 * @returns {Buffer}
 */
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i]);
    if (idx < 0) continue; // 非法字符跳过（保持宽容）
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * 生成随机共享密钥（20 字节 = 160 bit，base32 编码，Google Authenticator 可扫码）。
 * @returns {string} base32 密钥（无 padding）
 */
function generateSecret() {
  const buf = crypto.randomBytes(20);
  return base32Encode(buf);
}

/**
 * HOTP 动态口令（RFC 4226）。
 * @param {Buffer} key 密钥字节
 * @param {number} counter 计数器（8 字节大端）
 * @returns {string} DIGITS 位数字
 */
function hotp(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(counter)));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const code = bin % (10 ** DIGITS);
  return String(code).padStart(DIGITS, '0');
}

/**
 * 计算某时刻的 TOTP 码。
 * @param {string} secret base32 密钥
 * @param {number} [timeSec] Unix 秒（默认当前时间）
 * @param {number} [step] 时间步长（默认 30）
 * @returns {string} 6 位数字
 */
function totpAt(secret, timeSec, step) {
  const s = step || STEP_SEC;
  const t = Math.floor((timeSec || Math.floor(Date.now() / 1000)) / s);
  return hotp(base32Decode(secret), t);
}

/**
 * 校验 TOTP 码（±window 窗口容差）。
 * @param {string} token 用户输入的 6 位码
 * @param {string} secret base32 密钥
 * @param {number} [window] 前后容差窗口数（默认 1）
 * @param {number} [nowSec] 当前 Unix 秒（测试注入）
 * @returns {boolean}
 */
function verify(token, secret, window, nowSec) {
  const text = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(text)) return false;
  if (!secret) return false;
  const w = Number.isInteger(window) ? window : 1;
  const now = nowSec || Math.floor(Date.now() / 1000);
  const current = Math.floor(now / STEP_SEC);
  for (let d = -w; d <= w; d++) {
    if (hotp(base32Decode(secret), current + d) === text) return true;
  }
  return false;
}

module.exports = {
  STEP_SEC,
  DIGITS,
  generateSecret,
  verify,
  totpAt,
  hotp,
  base32Encode,
  base32Decode,
};
