'use strict';
/**
 * cups-ctl.js — CUPS 打印机管控封装（零三方依赖）
 *
 * 封装 cupsenable / cupsdisable / cancel，供客户端指令
 * enable_printer / disable_printer / clear_print_queue 调用。
 * 所有命令均通过 execFile 直接传参，禁用 shell，避免打印机名注入。
 *
 * 设计约束：
 *  - 仅用 node:child_process.execFile，绝不拼接 shell；
 *  - 任何异常都降级为 {ok:false, error}，不让调用方崩；
 *  - run(cmd, args, opts) 的 opts.execFile 可注入，便于单测 mock。
 */

const { execFile } = require('node:child_process');
const util = require('node:util');

const execFileP = util.promisify(execFile);

/**
 * 安全地执行一条 CUPS 命令（无 shell）。
 * @param {string} cmd 可执行文件名（cupsenable/cupsdisable/cancel）
 * @param {string[]} args 参数列表
 * @param {object} [opts]
 * @param {function} [opts.execFile] 注入实现（测试用），签名同 execFileP
 * @param {number} [opts.timeoutMs=10000] 超时（毫秒）
 * @returns {Promise<{ok:boolean, error?:string, detail?:string}>}
 */
async function run(cmd, args, opts = {}) {
  const execFn = typeof opts.execFile === 'function' ? opts.execFile : execFileP;
  try {
    await execFn(cmd, args, { timeout: opts.timeoutMs || 10000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    const stderr = (e && e.stderr) ? e.stderr.toString() : '';
    const code = e && e.code;
    const error = (typeof code === 'number') ? ('exit-' + code) : ((e && e.message) || 'cups-error');
    return { ok: false, error, detail: stderr.slice(0, 500) };
  }
}

/** 启用一台打印机。 */
async function enablePrinter(name, opts = {}) {
  if (!name) return { ok: false, error: 'printer-name-required' };
  return run('cupsenable', [String(name)], opts);
}

/** 停用一台打印机。 */
async function disablePrinter(name, opts = {}) {
  if (!name) return { ok: false, error: 'printer-name-required' };
  return run('cupsdisable', [String(name)], opts);
}

/**
 * 清空打印队列。
 * @param {string} [name] 打印机名；缺省则清空所有队列（cancel -a）
 */
async function clearQueue(name, opts = {}) {
  const args = name ? ['-a', String(name)] : ['-a'];
  return run('cancel', args, opts);
}

module.exports = { enablePrinter, disablePrinter, clearQueue, run };
