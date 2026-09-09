'use strict';
/**
 * printer-provider.js — 客户端打印机枚举（供心跳上报 printers[]）
 *
 * 策略（与架构设计 D2 一致：打印机配置不再由服务端下发，改为客户端自报 + 远程禁用/启用）：
 *   1) 优先 `lpstat -p -d` + `lpstat -v`（CUPS，Linux/类 Unix）；
 *   2) 若 lpstat 缺失或返回为空，且 host 注入了 PrintPlugin 实例 → 走 PrintPlugin.scanPrinters() 兜底；
 *   3) Windows 下再尝试 `wmic printer get name /value` 兜底。
 *
 * 全程 try/catch，任何失败都返回 []，绝不抛错阻断心跳。
 * 零三方依赖：仅用 node:child_process 的 execFile（避免 shell 注入）。
 */

const { execFile } = require('node:child_process');
const util = require('node:util');

const execFileP = util.promisify(execFile);

/**
 * 安全执行 lpstat（不存在/超时均视为空输出）。
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function lpstat(args) {
  try {
    const { stdout } = await execFileP('lpstat', args, { timeout: 5000, windowsHide: true });
    return stdout || '';
  } catch (e) {
    return '';
  }
}

/**
 * 解析 `lpstat -v` 的 device-for 行，得到 队列名 → URI 映射。
 * 形如：device for HP_LaserJet: usb://HP/...
 * @param {string} out
 * @returns {Map<string,string>}
 */
function parseDeviceFor(out) {
  const map = new Map();
  const re = /^device for\s+([^\s:]+):\s+(\S+)/gim;
  let m;
  while ((m = re.exec(out || '')) !== null) map.set(m[1], m[2]);
  return map;
}

/**
 * 解析 `lpstat -p -d` 的 printer 行。
 * 形如：printer NAME is STATUS ["DESC"]
 * @param {string} out
 * @returns {Array<{name:string, status:string, description:string}>}
 */
function parsePrinterStatus(out) {
  const printers = [];
  const lines = (out || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^printer\s+([^\s]+)\s+is\s+([^\s]+)/i);
    if (m) {
      printers.push({
        name: m[1],
        status: m[2],
        description: line.trim(),
      });
    }
  }
  return printers;
}

/**
 * 解析 Windows `wmic printer get name /value`。
 * @param {string} out
 * @returns {Array<{name:string, status:string, description:string}>}
 */
function parseWmic(out) {
  const printers = [];
  const lines = (out || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^Name=(.+)$/i);
    if (m && m[1].trim()) {
      const name = m[1].trim();
      printers.push({ name, status: 'unknown', description: name });
    }
  }
  return printers;
}

/**
 * 枚举本机打印机。
 * @param {object} [opts]
 * @param {object} [opts.printPlugin] 可选 PrintPlugin 实例（兜底用）
 * @returns {Promise<Array<{name:string, status:string, description:string, uri:?string}>>}
 */
async function getPrinters(opts = {}) {
  // 1) CUPS（类 Unix 首选）
  try {
    const [pOut, vOut] = await Promise.all([
      lpstat(['-p', '-d']),
      lpstat(['-v']),
    ]);
    const uriMap = parseDeviceFor(vOut);
    const printers = parsePrinterStatus(pOut).map((p) => ({
      name: p.name,
      status: p.status,
      description: p.description,
      uri: uriMap.get(p.name) || null,
    }));
    if (printers.length) return printers;
  } catch (e) {
    // lpstat 不可用，继续兜底
  }

  // 2) PrintPlugin 兜底（host 注入）
  if (opts.printPlugin && typeof opts.printPlugin.scanPrinters === 'function') {
    try {
      const list = await opts.printPlugin.scanPrinters(true);
      if (Array.isArray(list) && list.length) {
        return list.map((p) => ({
          name: p.name,
          status: p.status || 'unknown',
          description: p.description || p.name,
          uri: null,
        }));
      }
    } catch (e) {
      // 忽略
    }
  }

  // 3) Windows wmic 兜底
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileP('wmic', ['printer', 'get', 'name', '/value'], {
        timeout: 5000,
        windowsHide: true,
      });
      const printers = parseWmic(stdout);
      if (printers.length) return printers;
    } catch (e) {
      // 忽略
    }
  }

  return [];
}

module.exports = { getPrinters, parsePrinterStatus, parseDeviceFor, parseWmic };
