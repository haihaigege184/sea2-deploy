'use strict';
/**
 * format-ctl.js — sea2 格式化强门禁执行器（三档分级，P4 原则，零三方依赖）
 *
 * 分级语义（system_design_sea2_ops_v1.0.md §3.3/§3.6/§7.8）：
 *   data    → wipeData()    清数据分区（/root/sea2/data）
 *   factory → factoryReset() 恢复出厂：清数据 + 打印配置，保留系统/程序/授权文件
 *             （/root/sea2/config 下 license/machineId 授权文件必须保留）
 *   disk    → wipeDisk()    整盘擦除（最危险，需 opts.diskTarget 显式配置，否则拒绝）
 *
 * P4 强门禁（客户端本地侧）：
 *   1) level 必须是三档之一；
 *   2) countdownSec 本地强制 ≥15（且不低于该档位下限），不足直接拒绝；
 *   3) 本地二次确认：execute(level, confirm, ...) 的 confirm 必须为
 *      'FORMAT-<LEVEL>'（大写）——本地操作员确认，绝不把「服务端已确认」当本地确认；
 *      未确认 → {ok:false, error:'local-rejected'}；
 *   4) 倒计时真实 sleep（可注入 mock 以便单测）；
 *   5) 结果上报：{ok:true, result:{level, action, ts, ...}} 或 {ok:false, error}。
 *
 * 安全设计：
 *  - wipe 动作通过注入的 execFile 执行（数组传参零 shell）；路径严格限定在
 *    /root/sea2/data 与 /root/sea2/config 等预定义目录内；
 *  - disk 档必须显式提供 diskTarget（如 /dev/sda），否则 {ok:false, error:'disk-target-required'}
 *    ——绝不在没搞清目标盘的情况下执行整盘擦除；
 *  - 所有异常捕获为 {ok:false, error}，不让调用方崩。
 */

const { execFile } = require('node:child_process');
const util = require('node:util');

const execFileP = util.promisify(execFile);

/** 三档配置：本地倒计时下限（秒）与本地确认词 */
const LEVELS = {
  data: { confirmWord: 'FORMAT-DATA', minCountdown: 15, action: 'wipe-data' },
  factory: { confirmWord: 'FORMAT-FACTORY', minCountdown: 20, action: 'factory-reset' },
  disk: { confirmWord: 'FORMAT-DISK', minCountdown: 30, action: 'wipe-disk' },
};

/** 全局最低倒计时（秒），与 §3.4 契约 countdownSec min=15 对齐 */
const MIN_COUNTDOWN_SEC = 15;

/** 数据目录（data 档/ factory 档清除对象） */
const DEFAULT_DATA_DIR = '/root/sea2/data';
/** 授权配置目录（factory 档必须保留） */
const DEFAULT_CONFIG_DIR = '/root/sea2/config';

/** 睡眠实现（可注入 mock） */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 本地倒计时。默认真实等待 countdownSec 秒；
 * 测试注入 opts.sleep 记录秒数并立即返回。
 * @param {number} sec 秒
 * @param {object} [opts]
 * @param {function} [opts.sleep] (ms)=>Promise 注入
 * @returns {Promise<number>} 实际等待的秒数
 */
async function countdown(sec, opts = {}) {
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : _sleep;
  const s = Math.max(0, Math.floor(sec));
  await sleep(s * 1000);
  return s;
}

/**
 * 低层 rm 执行器（execFile 数组传参，零 shell；路径必须绝对且限定在 data/config 内）。
 * @param {string} target 目标路径
 * @param {object} [opts]
 * @param {function} [opts.execFile] 注入实现（测试用），签名同 promisify(execFile)
 * @returns {Promise<{ok:boolean, error?:string, detail?:string}>}
 */
async function _safeRm(target, opts = {}) {
  const execFn = typeof opts.execFile === 'function' ? opts.execFile : execFileP;
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const configDir = opts.configDir || DEFAULT_CONFIG_DIR;
  // 路径白名单收口：只允许清 data 目录本身或 data 目录内子路径；config 目录一律禁止删除
  const norm = String(target || '').replace(/\/+$/, '');
  const dataBase = dataDir.replace(/\/+$/, '');
  if (norm !== dataBase && !norm.startsWith(dataBase + '/')) {
    return { ok: false, error: 'path-not-allowed', detail: '仅允许清理数据目录 ' + dataDir };
  }
  if (norm === configDir.replace(/\/+$/, '') || norm.startsWith(configDir.replace(/\/+$/, '') + '/')) {
    return { ok: false, error: 'config-dir-protected', detail: '授权配置目录禁止清除' };
  }
  try {
    await execFn('rm', ['-rf', norm], { timeout: 60000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    const stderr = (e && e.stderr) ? e.stderr.toString() : '';
    const code = e && e.code;
    const error = (typeof code === 'number') ? ('exit-' + code) : ((e && e.message) || 'rm-failed');
    return { ok: false, error, detail: stderr.slice(0, 500) };
  }
}

/**
 * data 档：清数据分区。
 * @param {object} [opts] 见 _safeRm / countdown
 * @returns {Promise<{ok:boolean, action:string, error?:string, detail?:string}>}
 */
async function wipeData(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const r = await _safeRm(dataDir, opts);
  if (!r.ok) return { ok: false, action: 'wipe-data', error: r.error, detail: r.detail };
  return { ok: true, action: 'wipe-data' };
}

/**
 * factory 档：恢复出厂。
 * 清除数据目录 + 打印队列；保留 /root/sea2/config（授权文件不丢）。
 * @param {object} [opts] 见 _safeRm / countdown
 * @returns {Promise<{ok:boolean, action:string, preserved:string[], error?:string, detail?:string}>}
 */
async function factoryReset(opts = {}) {
  const configDir = opts.configDir || DEFAULT_CONFIG_DIR;
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const dataRes = await _safeRm(dataDir, opts);
  if (!dataRes.ok) return { ok: false, action: 'factory-reset', error: dataRes.error, detail: dataRes.detail };

  // 清打印队列（cancel -a），失败不致命但如实回报
  const execFn = typeof opts.execFile === 'function' ? opts.execFile : execFileP;
  let queueRes = { ok: true };
  try {
    await execFn('cancel', ['-a'], { timeout: 15000, windowsHide: true });
  } catch (e) {
    const stderr = (e && e.stderr) ? e.stderr.toString() : '';
    const code = e && e.code;
    const error = (typeof code === 'number') ? ('exit-' + code) : ((e && e.message) || 'cancel-failed');
    queueRes = { ok: false, error, detail: stderr.slice(0, 500) };
  }

  return {
    ok: queueRes.ok,
    action: 'factory-reset',
    preserved: [configDir],
    queueCleared: queueRes.ok,
    error: queueRes.ok ? undefined : queueRes.error,
    detail: queueRes.ok ? undefined : queueRes.detail,
  };
}

/**
 * disk 档：整盘擦除（最危险）。
 * 必须显式配置 opts.diskTarget（如 /dev/sda），否则拒绝执行；
 * 执行方式为注入的 opts.wipeFn（默认不提供真实实现，防止误擦生产盘）。
 * @param {object} [opts]
 * @param {string} [opts.diskTarget] 目标整盘设备（如 /dev/sda）
 * @param {function} [opts.wipeFn] (target)=>Promise<{ok:boolean,error?:string,detail?:string}> 注入
 * @returns {Promise<{ok:boolean, action:string, target?:string, error?:string, detail?:string}>}
 */
async function wipeDisk(opts = {}) {
  const target = opts.diskTarget;
  if (!target) {
    return { ok: false, action: 'wipe-disk', error: 'disk-target-required', detail: '未配置目标整盘设备，拒绝执行整盘擦除' };
  }
  const wipeFn = typeof opts.wipeFn === 'function' ? opts.wipeFn : null;
  if (!wipeFn) {
    return { ok: false, action: 'wipe-disk', target, error: 'wipe-fn-not-configured', detail: '未注入 wipeFn，客户端默认拒绝真实整盘擦除（防误触）' };
  }
  const r = await wipeFn(target);
  if (!r.ok) return { ok: false, action: 'wipe-disk', target, error: r.error || 'wipe-failed', detail: r.detail };
  return { ok: true, action: 'wipe-disk', target };
}

/**
 * 三档格式化执行入口（P4 本地强门禁）。
 * @param {string} level 格式化级别：data | factory | disk
 * @param {string} confirm 本地二次确认词（必须 = LEVELS[level].confirmWord，不区分大小写）
 * @param {number} countdownSec 本地倒计时秒数（≥15 且 ≥ 该档位下限）
 * @param {object} [opts]
 * @param {object} [opts.execFile] 注入 execFile（测试用）
 * @param {function} [opts.sleep] 注入 sleep（测试用，避免真实等待）
 * @param {string} [opts.dataDir] 数据目录（默认 /root/sea2/data）
 * @param {string} [opts.configDir] 授权目录（默认 /root/sea2/config）
 * @param {string} [opts.diskTarget] disk 档目标整盘
 * @param {function} [opts.wipeFn] disk 档注入擦除实现
 * @returns {Promise<{ok:boolean, level:string, action?:string, result?:object, error?:string, detail?:string}>}
 */
async function execute(level, confirm, countdownSec, opts = {}) {
  const spec = LEVELS[level];
  if (!spec) {
    return { ok: false, level: level || '', error: 'invalid-level', detail: 'level 必须为 data/factory/disk 之一' };
  }

  const sec = Number(countdownSec);
  if (!Number.isInteger(sec) || sec < MIN_COUNTDOWN_SEC || sec < spec.minCountdown) {
    return {
      ok: false,
      level,
      error: 'countdown-too-short',
      detail: '本地倒计时必须 ≥ ' + Math.max(MIN_COUNTDOWN_SEC, spec.minCountdown) + ' 秒（' + level + ' 档下限 ' + spec.minCountdown + ' 秒）',
    };
  }

  // P4 本地二次确认：confirm 必须匹配本档确认词（本地操作员确认，不信任服务端单方面指令）
  const confirmWord = String(confirm || '').trim().toUpperCase();
  if (confirmWord !== spec.confirmWord) {
    return { ok: false, level, error: 'local-rejected', detail: '本地二次确认失败：期望 ' + spec.confirmWord };
  }

  // 本地倒计时（真实等待，可注入 mock）
  await countdown(sec, opts);

  // 按档执行
  let execRes;
  if (level === 'data') {
    execRes = await wipeData(opts);
  } else if (level === 'factory') {
    execRes = await factoryReset(opts);
  } else {
    execRes = await wipeDisk(opts);
  }

  if (!execRes.ok) {
    return { ok: false, level, error: execRes.error, detail: execRes.detail, result: null };
  }

  return {
    ok: true,
    level,
    action: execRes.action,
    result: {
      level,
      action: execRes.action,
      countdownSec: sec,
      ts: Math.floor(Date.now() / 1000),
      preserved: execRes.preserved || undefined,
      target: execRes.target || undefined,
    },
  };
}

module.exports = {
  execute,
  countdown,
  wipeData,
  factoryReset,
  wipeDisk,
  LEVELS,
  MIN_COUNTDOWN_SEC,
  DEFAULT_DATA_DIR,
  DEFAULT_CONFIG_DIR,
};
