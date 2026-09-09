'use strict';
/**
 * lib/console/runtime.js — 服务端运行状态采集
 *
 * 数据来源（全部容错，失败不影响主流程）：
 *  - 本进程：os / process.memoryUsage
 *  - 同机：pm2 jlist（解析 sea1-activation / sea1-bot 状态）
 *  - Linux：/proc/meminfo（内存）、df -P（磁盘）
 */

const os = require('node:os');
const fs = require('node:fs');
const child_process = require('node:child_process');
// [SEA2 运维] 服务端 pm2 直控（白名单 + 审计），runtime 从「只读采集」扩展为「可操作」
const opsPm2 = require('../ops/pm2');

const startTime = Date.now();

function _readMemInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const map = {};
    txt.split(/\n/).forEach((l) => {
      const m = l.match(/^(\w+):\s+(\d+)\s*kB/);
      if (m) map[m[1]] = Number(m[2]) * 1024;
    });
    const total = map.MemTotal || 0;
    const free = map.MemFree != null ? map.MemFree : (map.MemAvailable != null ? map.MemAvailable : 0);
    return { total, free, used: total - free, usedPercent: total ? ((total - free) / total) * 100 : 0 };
  } catch (e) {
    return null;
  }
}

function _disk() {
  try {
    const out = child_process.execSync('df -P', { encoding: 'utf8', timeout: 5000 });
    const lines = out.split(/\n/).slice(1).filter(Boolean);
    const disk = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const fsName = parts[0];
      const total = Number(parts[1]) * 1024;
      const used = Number(parts[2]) * 1024;
      const avail = Number(parts[3]) * 1024;
      const usedPercent = Number(String(parts[4]).replace('%', '')) || 0;
      const mount = parts.slice(5).join(' ');
      disk.push({ fs: fsName, mount, total, used, avail, usedPercent });
    }
    return disk;
  } catch (e) {
    return [];
  }
}

function _pm2() {
  try {
    const out = child_process.execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) return null;
    return arr.map((p) => ({
      name: p.name,
      status: (p.pm2_env && p.pm2_env.status) || p.status || '',
      cpu: (p.monit && p.monit.cpu) || 0,
      memory: (p.monit && p.monit.memory) || 0,
    }));
  } catch (e) {
    return null; // 失败则列本进程
  }
}

/**
 * 状态采集缓存（单进程 Node，简单对象缓存即可保证进程内安全）。
 * 用于避免每次调用都执行 pm2 jlist（实测 ~1234ms），将接口耗时压到 <200ms。
 *
 * 关键设计（解决"数据很慢"）：
 *  - TTL 设为 30s：真实浏览中概览/系统页等调用间隔通常远超 3s，3s TTL 形同虚设；
 *    30s TTL 配合后台预热后，除部署后首次调用外，用户每次加载都命中热缓存（~0ms）。
 *  - 后台预热：每 TTL/2（15s）用最近一次真实请求的 ctx 重建状态并刷新缓存，
 *    使缓存常驻新鲜，避免 TTL 过期后用户请求再次冷跑 pm2 jlist。
 *  - 缓存键：区分是否有 store（stats 依赖 store），用 store 引用本身做 key 精确区分不同实例。
 */
const STATUS_TTL_MS = 30000;
const STATUS_CACHE = new Map(); // key(store 引用或哨兵) -> { at:number, value:object }
let LAST_CTX = null; // 最近一次真实请求的 ctx，供后台预热使用

/**
 * 降级状态：当采集整体失败且无旧缓存时返回，保持与正常返回完全一致的 JSON 结构，避免前端字段缺失。
 */
function _degradedStatus() {
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  return {
    health: 'degraded',
    uptimeSec,
    startTime: new Date(startTime).toISOString(),
    cpu: { model: 'unknown', count: 0, loadavg: os.loadavg(), platform: os.platform(), arch: os.arch() },
    mem: { total: 0, free: 0, used: 0, usedPercent: 0, source: 'unknown' },
    disk: [],
    process: { pid: process.pid },
    stats: {},
  };
}

/**
 * 真正的状态采集逻辑（成本较高，含 pm2 jlist / df 等子进程调用）。
 * @param {{cfg?:object, store?:object, keys?:object}} ctx
 */
function _buildStatus(ctx) {
  const store = (ctx && ctx.store) || null;
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);

  const cpus = os.cpus();
  const cpu = {
    model: cpus.length ? cpus[0].model : 'unknown',
    count: cpus.length,
    loadavg: os.loadavg(),
    platform: os.platform(),
    arch: os.arch(),
  };

  let mem;
  const meminfo = _readMemInfo();
  if (meminfo && meminfo.total) {
    mem = {
      total: meminfo.total,
      free: meminfo.free,
      used: meminfo.used,
      usedPercent: Math.round(meminfo.usedPercent * 100) / 100,
      source: 'proc',
    };
  } else {
    const total = os.totalmem();
    const free = os.freemem();
    mem = {
      total,
      free,
      used: total - free,
      usedPercent: Math.round((total - free) / total * 10000) / 100,
      source: 'os',
    };
  }

  const disk = _disk();

  const processList = _pm2();
  const processInfo = { pid: process.pid, pm2: processList };
  if (!processList) {
    processInfo.self = {
      name: 'sea1-activation',
      status: 'online',
      cpu: 0,
      memory: process.memoryUsage().heapUsed,
    };
  }

  let stats = {};
  if (store) {
    try {
      const orders = store.listOrders();
      const now = Date.now();
      const dayStart = now - 24 * 3600 * 1000;
      stats = {
        ordersTotal: orders.length,
        ordersPaid: orders.filter((o) => o.status === 'paid' || o.status === 'issued').length,
        ordersIssued: orders.filter((o) => o.status === 'issued').length,
        ordersToday: orders.filter((o) => o.created_at >= dayStart).length,
        codes: store.listCodes().length,
        licenses: store.listLicenses().length,
        trialUsers: store.listTrialUsers().length,
      };
    } catch (e) { stats = {}; }
  }

  return {
    health: 'ok',
    uptimeSec,
    startTime: new Date(startTime).toISOString(),
    cpu,
    mem,
    disk,
    process: processInfo,
    stats,
  };
}

/**
 * 采集服务端运行状态（带短周期缓存）。
 *
 * 行为：
 *  - TTL（默认 3000ms）内重复调用直接返回缓存，不再执行 pm2 jlist，接口耗时降到 <200ms。
 *  - 缓存键区分是否有 store（stats 依赖 store），用 store 引用本身做 key 精确区分实例。
 *  - TTL 过期后第一次调用重新采集；采集失败时优先保留旧缓存，无旧缓存则降级为结构完整的 _degradedStatus，避免接口 500。
 *  - 不改变返回的 JSON 结构（health/uptimeSec/startTime/cpu/mem/disk/process/stats）。
 *
 * @param {{cfg?:object, store?:object, keys?:object}} ctx
 * @returns {object} 与历史结构完全一致的运行时状态对象
 */
function getStatus(ctx) {
  const store = (ctx && ctx.store) || null;
  if (ctx) LAST_CTX = ctx; // 记录最近 ctx 供后台预热
  const key = store || '__no_store__'; // store 引用做 key；无 store 用哨兵
  const now = Date.now();
  const hit = STATUS_CACHE.get(key);
  if (hit && (now - hit.at) < STATUS_TTL_MS) {
    return hit.value;
  }
  try {
    const value = _buildStatus(ctx);
    STATUS_CACHE.set(key, { at: now, value });
    return value;
  } catch (e) {
    // 采集失败：优先保留旧缓存，避免接口 500
    if (hit) return hit.value;
    // 无旧缓存则降级为结构完整的对象
    return _degradedStatus();
  }
}

/**
 * 后台预热：每 TTL/2 用最近一次真实请求的 ctx 重建状态并刷新缓存，
 * 使后续任意用户请求几乎总是命中新鲜缓存（~0ms），彻底消除 pm2 jlist 造成的卡顿。
 * 仅进程内、单实例，开销为每 15s 一次 pm2 jlist，远低于此前每次请求一次。
 */
function _warm() {
  if (!LAST_CTX) return;
  try {
    const value = _buildStatus(LAST_CTX);
    STATUS_CACHE.set(LAST_CTX.store || '__no_store__', { at: Date.now(), value });
  } catch (e) { /* 预热失败忽略，下一个周期再试 */ }
}
const _warmTimer = setInterval(_warm, Math.floor(STATUS_TTL_MS / 2));
if (_warmTimer && _warmTimer.unref) _warmTimer.unref(); // 不阻止进程退出
setTimeout(_warm, 0); // 启动后尽快预热一次（首请求前 ctx 为空则跳过，由间隔接管）

// ================= [SEA2 运维] PM2 操作能力（白名单 + 审计，§4.1）=================
/**
 * 读取服务端 pm2 进程列表（白名单过滤）。
 * @returns {Promise<{ok:boolean, processes:Array<object>, error?:string}>}
 */
function pm2List() {
  return opsPm2.default.listLocal();
}

/**
 * 服务端 pm2 即时操作（restart/stop/start）。
 * @param {string} name 进程名
 * @param {string} action 'restart' | 'stop' | 'start'
 * @param {string} [operator] 操作人
 * @param {number|string} [operatorLevel] 操作人等级
 * @returns {Promise<{ok:boolean, action:string, name:string, error?:string, status?:number}>}
 */
function pm2Action(name, action, operator, operatorLevel) {
  return opsPm2.default.action(name, action, operator, operatorLevel);
}

/**
 * 读取进程最近 N 行日志。
 * @param {string} name 进程名
 * @param {number} [lines] 行数（1~200）
 * @returns {Promise<{ok:boolean, name:string, lines:number, logs:string, error?:string, status?:number}>}
 */
function pm2Logs(name, lines) {
  return opsPm2.default.logs(name, lines);
}

module.exports = { getStatus, startTime, pm2List, pm2Action, pm2Logs, opsPm2 };
