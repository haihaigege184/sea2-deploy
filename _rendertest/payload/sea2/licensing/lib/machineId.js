'use strict';
/**
 * machineId.js — 机器码派生（容器化友好）
 *
 * 层1（决定层）：持久化 UUID 文件（如 /etc/sea1/machine-id）。
 *   容器重建后只要挂载同一文件，机器码不变。
 * 层2（辅助校验，不绑定授权）：宿主机硬件指纹，仅用于异常检测/审计。
 * 输出：MachineID = HMAC_SHA256(PersistentUUID, SecretSeed)
 */
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// ⚠️ 混淆前需将 SEED 拆片/加密（见 ACTIVATION_SYSTEM_DESIGN.md 5.1）。
// 此处为可移植明文种子，商业构建时替换。
const SECRET_SEED = 'sea1-machine-seed-v1-replace-in-obfuscated-build';

function readOrCreatePersistent(path) {
  try {
    const v = fs.readFileSync(path, 'utf8').trim();
    if (v) return v;
  } catch { /* 文件不存在 */ }
  const uuid = crypto.randomUUID();
  fs.mkdirSync(require('node:path').dirname(path), { recursive: true });
  fs.writeFileSync(path, uuid, { mode: 0o600 });
  return uuid;
}

/** 计算机器码（HMAC） */
function deriveMachineId(persistent) {
  return crypto.createHmac('sha256', SECRET_SEED).update(persistent, 'utf8').digest('hex');
}

/**
 * 取得机器码。
 * @param {string} [machineIdPath] 持久化文件路径，默认 /etc/sea1/machine-id（Windows 开发回退到用户目录）
 */
function getMachineId(machineIdPath) {
  const p = machineIdPath
    || (process.platform === 'win32'
      ? require('node:path').join(os.homedir(), '.sea1', 'machine-id')
      : '/etc/sea1/machine-id');
  const persistent = readOrCreatePersistent(p);
  return { persistent, machineId: deriveMachineId(persistent), path: p };
}

/**
 * 辅助硬件指纹（不绑定授权，仅异常检测）。
 * 任一来源不可用则返回 ''，绝不抛错。
 */
function hostFingerprint() {
  const parts = [];
  try {
    const cpus = os.cpus();
    if (cpus && cpus[0]) parts.push('cpu:' + cpus[0].model.trim());
  } catch { /* noop */ }
  try {
    const mid = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (mid) parts.push('hid:' + mid);
  } catch { /* noop */ }
  try {
    const ifaces = os.networkInterfaces();
    const macs = [];
    for (const k of Object.keys(ifaces)) {
      for (const a of ifaces[k] || []) if (a.mac && a.mac !== '00:00:00:00:00:00') macs.push(a.mac);
    }
    if (macs[0]) parts.push('mac:' + macs[0]);
  } catch { /* noop */ }
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

module.exports = { getMachineId, deriveMachineId, hostFingerprint, SECRET_SEED };
