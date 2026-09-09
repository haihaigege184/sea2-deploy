'use strict';
/**
 * sysinfo.js — 客户端本地系统信息采集（零三方依赖，仅用 Node 内置模块）
 *
 * 采集项（用于心跳富化，供服务端集群看板展示/异常检测）：
 *  - version    : sea1 客户端版本（读 package.json，回退到环境变量）
 *  - cpu_usage  : CPU 占用率（0~100，双采样法，失败返回 null）
 *  - mem_usage  : 内存占用率（0~100）
 *  - boot_time  : 开机时间戳（秒）
 *  - platform/arch/hostname : 基础环境信息
 *
 * 设计约束：
 *  - 全程 try/catch，绝不因采集失败导致心跳中断；
 *  - 不引入任何 npm 依赖；
 *  - 兼容混淆打包场景（require('../../package.json') 可能失败 → 环境变量兜底）。
 */

const os = require('node:os');

/**
 * 读取客户端版本号。
 * @returns {string}
 */
function readVersion() {
  try {
    // 运行时相对路径：licensing/lib/sysinfo.js → ../../package.json = sea1/package.json
    // 混淆单文件打包时该 require 会失败，走下方兜底。
    // eslint-disable-next-line global-require
    return require('../../package.json').version || '0.0.0';
  } catch (e) {
    return process.env.SEA1_VERSION || process.env.npm_package_version || '0.0.0';
  }
}

/**
 * 单次 CPU 时间采样（累计 idle 与 total）。
 * @returns {{idle:number, total:number}}
 */
function cpuSample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times || {};
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + (t.idle || 0);
    idle += (t.idle || 0);
  }
  return { idle, total };
}

/**
 * 双采样计算 CPU 占用率（百分比）。
 * @param {number} [ms=200] 采样间隔
 * @returns {Promise<number>} 0~100，无 CPU 信息时返回 0
 */
async function getCpuUsage(ms = 200) {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;
  const a = cpuSample();
  await new Promise((r) => setTimeout(r, Math.max(50, ms)));
  const b = cpuSample();
  const idleDiff = b.idle - a.idle;
  const totalDiff = b.total - a.total;
  if (totalDiff <= 0) return 0;
  const usage = (1 - idleDiff / totalDiff) * 100;
  return Math.max(0, Math.min(100, Math.round(usage)));
}

/**
 * 采集完整系统信息。
 * @param {object} [opts]
 * @param {boolean} [opts.cpu=true] 是否采样 CPU（需要短延时，不需要时可关闭）
 * @param {number}  [opts.cpuSampleMs=200] CPU 采样间隔
 * @returns {Promise<{version:string, cpu_usage:?number, mem_usage:number, boot_time:number, platform:string, arch:string, hostname:string}>}
 */
async function getSysInfo(opts = {}) {
  const sampleCpu = opts.cpu !== false;
  const cpu_usage = sampleCpu ? await getCpuUsage(opts.cpuSampleMs || 200) : null;

  let mem_usage = 0;
  try {
    const total = os.totalmem();
    const free = os.freemem();
    if (total > 0) mem_usage = Math.round((1 - free / total) * 100);
  } catch (e) {
    mem_usage = 0;
  }

  let boot_time = 0;
  try {
    const up = typeof os.uptime() === 'number' ? os.uptime() : 0;
    boot_time = Math.floor((Date.now() - up * 1000) / 1000);
  } catch (e) {
    boot_time = 0;
  }

  return {
    version: readVersion(),
    cpu_usage,
    mem_usage,
    boot_time,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
  };
}

module.exports = { getSysInfo, getCpuUsage, readVersion };
