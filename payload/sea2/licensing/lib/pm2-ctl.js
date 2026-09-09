'use strict';
/**
 * pm2-ctl.js — sea2 pm2 进程管控（白名单，零三方依赖）
 *
 * 相对 sea1 版本（T03 sea2 客户端能力扩展，§3.4/§4.2/§7.7）：
 *  - 白名单 ALLOWED_PROCESSES 扩展为 sea1-*（兼容旧栈）+ sea2-*（商用客户端栈）：
 *      sea2-bot / sea2-napcat / sea2-client
 *  - 新增 stop / start / logs / list 四个操作（原版只有 restart）；
 *  - list() 使用 `pm2 jlist` 的 JSON 输出（零 shell，数组传参）；
 *  - logs() 使用 `pm2 logs --lines N --nostream` 一次性取最近 N 行（不挂长连接）。
 *
 * 安全铁律（延续 sea1）：
 *  - 白名单外一律拒绝，返回 {ok:false, error:'process-not-allowed'}，绝不执行任意命令；
 *  - 仅用 node:child_process.spawn，绝不拼接 shell；
 *  - 任何异常都降级为 {ok:false, error}，不让调用方崩；
 *  - 所有操作支持 opts.spawn 注入，便于单测 mock（不依赖真实 pm2）。
 */

const { spawn } = require('node:child_process');

/**
 * 允许被远程管控的 pm2 进程名白名单。
 * sea1-* 为兼容旧栈（sea1 迁移期可能仍需要）；sea2-* 为商用客户端新栈。
 * 与 system_design_sea2_ops_v1.0.md §7.7「客户端 Sea2Pm2Ctl.ALLOWED_PROCESSES = sea2-*」对齐。
 */
const ALLOWED_PROCESSES = [
  // sea1 旧栈（兼容）
  'sea1-bot', 'ncqq', 'sea1-login-gateway',
  // sea2 商用客户端栈
  'sea2-bot', 'sea2-napcat', 'sea2-client',
];

/** @returns {string[]} 当前白名单副本（只读用途，如日志/审计） */
function whitelist() {
  return ALLOWED_PROCESSES.slice();
}

/** @param {string} name @returns {boolean} 是否在白名单内 */
function isAllowed(name) {
  return ALLOWED_PROCESSES.includes(name);
}

/**
 * 低层 pm2 执行器：spawn 数组传参，绝不拼接 shell。
 * @param {string[]} args pm2 子命令参数，如 ['restart','sea2-bot']
 * @param {object} [opts]
 * @param {function} [opts.spawn] 注入的 spawn 实现（测试用），签名同 child_process.spawn
 * @param {number} [opts.timeoutMs=15000] 超时（毫秒）
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code?:number, error?:string, detail?:string}>}
 */
function _runPm2(args, opts = {}) {
  return new Promise((resolve) => {
    const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
    const timeoutMs = opts.timeoutMs || 15000;

    let cp;
    try {
      cp = spawnFn('pm2', args, { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, stdout: '', stderr: '', error: 'spawn-failed:' + ((e && e.message) || e) });
    }

    let stdout = '';
    let stderr = '';
    if (cp.stdout) cp.stdout.on('data', (d) => { stdout += d.toString(); });
    if (cp.stderr) cp.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { cp.kill('SIGKILL'); } catch (_) { /* noop */ }
      resolve({ ok: false, stdout, stderr, error: 'timeout' });
    }, timeoutMs);

    cp.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: 'spawn-error:' + ((e && e.message) || e) });
    });

    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, stdout, stderr, code: 0 });
      resolve({ ok: false, stdout, stderr, code: code || 0, error: 'exit-' + (code || 0), detail: stderr.slice(0, 500) });
    });
  });
}

/** 白名单校验，未通过则立即 resolve 拒绝结果（不调用 spawn）。 */
function _guard(name) {
  return !name || !isAllowed(name);
}

/**
 * 重启一个 pm2 托管进程。
 * @param {string} name 进程名（必须在白名单内）
 * @param {object} [opts] 同 _runPm2
 * @returns {Promise<{ok:boolean, name:string, error?:string, code?:number, detail?:string}>}
 */
function restart(name, opts = {}) {
  return new Promise((resolve) => {
    if (_guard(name)) {
      return resolve({ ok: false, name: name || '', error: 'process-not-allowed' });
    }
    _runPm2(['restart', String(name)], opts).then((r) => {
      if (r.ok) return resolve({ ok: true, name });
      resolve({ ok: false, name, error: r.error, code: r.code, detail: r.detail });
    });
  });
}

/**
 * 停止一个 pm2 托管进程（危险操作，白名单外拒绝）。
 * @param {string} name 进程名
 * @param {object} [opts] 同 _runPm2
 * @returns {Promise<{ok:boolean, name:string, error?:string, code?:number, detail?:string}>}
 */
function stop(name, opts = {}) {
  return new Promise((resolve) => {
    if (_guard(name)) {
      return resolve({ ok: false, name: name || '', error: 'process-not-allowed' });
    }
    _runPm2(['stop', String(name)], opts).then((r) => {
      if (r.ok) return resolve({ ok: true, name });
      resolve({ ok: false, name, error: r.error, code: r.code, detail: r.detail });
    });
  });
}

/**
 * 启动一个 pm2 托管进程（白名单外拒绝）。
 * @param {string} name 进程名
 * @param {object} [opts] 同 _runPm2
 * @returns {Promise<{ok:boolean, name:string, error?:string, code?:number, detail?:string}>}
 */
function start(name, opts = {}) {
  return new Promise((resolve) => {
    if (_guard(name)) {
      return resolve({ ok: false, name: name || '', error: 'process-not-allowed' });
    }
    _runPm2(['start', String(name)], opts).then((r) => {
      if (r.ok) return resolve({ ok: true, name });
      resolve({ ok: false, name, error: r.error, code: r.code, detail: r.detail });
    });
  });
}

/**
 * 取指定 pm2 进程最近 N 行日志（--nostream：取完即退出，不挂长连接）。
 * @param {string} name 进程名（必须在白名单内）
 * @param {number} [lines=100] 日志行数（1~200，越界收敛）
 * @param {object} [opts] 同 _runPm2
 * @returns {Promise<{ok:boolean, name:string, lines:number, logs?:string, error?:string, code?:number, detail?:string}>}
 */
function logs(name, lines, opts = {}) {
  return new Promise((resolve) => {
    if (_guard(name)) {
      return resolve({ ok: false, name: name || '', error: 'process-not-allowed' });
    }
    let n = Number.isInteger(lines) ? lines : (Number.isInteger(opts.lines) ? opts.lines : 100);
    n = Math.max(1, Math.min(200, n));
    _runPm2(['logs', String(name), '--lines', String(n), '--nostream'], opts).then((r) => {
      if (r.ok) return resolve({ ok: true, name, lines: n, logs: r.stdout || '', stderrTail: (r.stderr || '').slice(0, 500) });
      resolve({ ok: false, name, lines: n, error: r.error, code: r.code, detail: r.detail });
    });
  });
}

/**
 * 采集 pm2 进程列表（pm2 jlist → JSON 解析，零 shell）。
 * @param {object} [opts] 同 _runPm2
 * @returns {Promise<{ok:boolean, processes:Array<{pm_id:number, name:string, status:string, restarts:number, uptime:number, cpu:number, mem:number}>, error?:string, detail?:string}>}
 */
function list(opts = {}) {
  return _runPm2(['jlist'], opts).then((r) => {
    if (!r.ok) {
      return { ok: false, processes: [], error: r.error, code: r.code, detail: r.detail };
    }
    let arr = [];
    try {
      arr = JSON.parse(r.stdout || '[]');
    } catch (e) {
      return { ok: false, processes: [], error: 'bad-jlist', detail: String(r.stdout || '').slice(0, 200) };
    }
    const processes = (Array.isArray(arr) ? arr : [])
      .filter((p) => p && p.name)
      .map((p) => ({
        pm_id: Number.isFinite(p.pm_id) ? p.pm_id : 0,
        name: String(p.name),
        status: String(p.status || 'unknown'),
        restarts: Number.isFinite(p.restarts) ? p.restarts : 0,
        uptime: Number.isFinite(p.uptime) ? p.uptime : 0,
        cpu: Number.isFinite(p.cpu) ? p.cpu : 0,
        mem: Number.isFinite(p.mem) ? p.mem : 0,
      }));
    return { ok: true, processes };
  });
}

module.exports = { restart, stop, start, logs, list, isAllowed, whitelist, ALLOWED_PROCESSES };
