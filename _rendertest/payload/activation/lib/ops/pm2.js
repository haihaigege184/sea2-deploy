'use strict';
/**
 * lib/ops/pm2.js — 服务端 pm2 直控（OpsPm2，sea2 运维引擎）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §3.1 / §4.1 / §7.7
 *
 * 职责：
 *  - listLocal(whitelist)：读取本机 pm2 进程列表并过滤到白名单（只读采集）；
 *  - action(name, action, operator)：restart/stop/start 即时操作（白名单 + 审计）；
 *  - logs(name, lines)：读取进程最近 N 行日志。
 *
 * 安全铁律（§7.7）：
 *  - 白名单 = pm2ServerWhitelist（sea1-*、sea2-server-*），名单外一律拒绝；
 *  - execFile 数组传参，**绝不拼接 shell**；
 *  - 操作超时 15s。
 */

const { execFile } = require('node:child_process');
const auditStore = require('./auditStore');

const ACTION_TIMEOUT_MS = 15000;
const ACTIONS = ['restart', 'stop', 'start'];
const LOG_LINES_MAX = 200;

/** 进程名校验：仅允许字母数字 . _ -（与 fleetCommands pm2 系列 pattern 一致） */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

class OpsPm2 {
  /**
   * @param {object} [deps] 依赖注入（测试用）
   * @param {Function} [deps.execFileAsync] async (cmd, args, opts) => {stdout,stderr,code}
   * @param {Function} [deps.whitelistProvider] () => string[] 白名单提供者（默认读 fleetConfig）
   */
  constructor(deps) {
    deps = deps || {};
    this._execFileAsync = deps.execFileAsync || null;
    this._whitelistProvider = deps.whitelistProvider || null;
  }

  /**
   * 默认白名单提供者：读 fleetConfig.load().pm2ServerWhitelist。
   * @returns {string[]}
   * @private
   */
  _defaultWhitelist() {
    try {
      const fleetConfig = require('../fleetConfig');
      const wl = fleetConfig.load().pm2ServerWhitelist;
      return Array.isArray(wl) ? wl : [];
    } catch (e) {
      return [];
    }
  }

  whitelist() {
    if (this._whitelistProvider) return this._whitelistProvider();
    return this._defaultWhitelist();
  }

  /**
   * 进程名是否在白名单内（精确匹配 + 名单内前缀兜底：sea1-*、sea2-server-*）。
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  isAllowed(name) {
    if (!name || !NAME_RE.test(name)) return false;
    const wl = this.whitelist();
    if (wl.indexOf(name) >= 0) return true;
    // 名单内通配前缀（sea1-* / sea2-server-*）匹配
    for (const item of wl) {
      if (item.endsWith('*') && name.startsWith(item.slice(0, -1))) return true;
    }
    return false;
  }

  /**
   * 执行命令（execFile 数组传参，零 shell；默认 15s 超时）。
   * @param {string} cmd
   * @param {string[]} args
   * @param {number} [timeoutMs]
   * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number|null, error?:string}>}
   * @private
   */
  _exec(cmd, args, timeoutMs) {
    const timeout = timeoutMs || ACTION_TIMEOUT_MS;
    if (this._execFileAsync) {
      return Promise.resolve()
        .then(() => this._execFileAsync(cmd, args, { timeout }))
        .then((r) => ({
          ok: !!(r && r.code === 0),
          stdout: (r && r.stdout) || '',
          stderr: (r && r.stderr) || '',
          code: (r && r.code != null) ? r.code : 0,
          error: (r && r.error) || '',
        }))
        .catch((e) => ({
          ok: false, stdout: '', stderr: String(e && e.message || e), code: -1,
          error: String(e && e.message || e),
        }));
    }
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, stdout: stdout || '', stderr: stderr || '', code: err.code != null ? err.code : -1, error: String(err.message || err) });
        } else {
          resolve({ ok: true, stdout: stdout || '', stderr: stderr || '', code: 0, error: '' });
        }
      });
    });
  }

  /**
   * 读取本机 pm2 进程列表（过滤白名单）。
   * @param {string[]} [whitelist] 覆盖默认白名单（测试传参）
   * @returns {Promise<{ok:boolean, processes:Array<object>, error?:string}>}
   */
  async listLocal(whitelist) {
    const r = await this._exec('pm2', ['jlist'], 8000);
    if (!r.ok && r.code !== 0 && r.error && !r.stdout) {
      // pm2 不存在 / 无守护进程：返回空列表而非 500（采集容错）
      return { ok: false, processes: [], error: r.stderr || r.error };
    }
    let arr = [];
    try {
      arr = JSON.parse(r.stdout || '[]');
    } catch (e) {
      return { ok: false, processes: [], error: 'pm2 jlist 输出解析失败' };
    }
    const wl = Array.isArray(whitelist) ? whitelist : this.whitelist();
    const processes = (Array.isArray(arr) ? arr : [])
      .map((p) => ({
        pm_id: (p && p.pm_id != null) ? p.pm_id : 0,
        name: (p && p.name) || '',
        status: (p && p.pm2_env && p.pm2_env.status) || (p && p.status) || 'unknown',
        restarts: (p && p.pm2_env && p.pm2_env.restart_time) || 0,
        uptime: (p && p.pm2_env && p.pm2_env.pm_uptime) || 0,
        cpu: (p && p.monit && p.monit.cpu) || 0,
        mem: (p && p.monit && p.monit.memory) || 0,
      }))
      .filter((p) => this.isAllowed(p.name));
    return { ok: true, processes };
  }

  /**
   * 即时操作：restart / stop / start（白名单外拒绝 + 审计）。
   * @param {string} name 进程名
   * @param {string} action 'restart' | 'stop' | 'start'
   * @param {string} [operator] 操作人
   * @param {number} [operatorLevel] 操作人等级
   * @returns {Promise<{ok:boolean, action:string, name:string, error?:string, status?:number}>}
   */
  async action(name, action, operator, operatorLevel) {
    const processName = String(name || '');
    if (ACTIONS.indexOf(action) < 0) {
      return { ok: false, error: '未知操作（restart|stop|start）', status: 400 };
    }
    if (!this.isAllowed(processName)) {
      auditStore.logOp({
        operator: operator || 'system', operatorLevel,
        action: 'pm2-' + action, entity: 'pm2', target: processName,
        before: null, after: null, detail: '白名单外拒绝', ok: false,
      });
      return { ok: false, error: `进程「${processName}」不在服务端 pm2 白名单内`, status: 403 };
    }

    const before = { name: processName, action };
    const r = await this._exec('pm2', [action, processName], ACTION_TIMEOUT_MS);
    const ok = r.ok && (r.code === 0 || r.code == null);
    const after = { name: processName, action, code: r.code, stderr: (r.stderr || '').slice(0, 500) };
    auditStore.logOp({
      operator: operator || 'system', operatorLevel,
      action: 'pm2-' + action, entity: 'pm2', target: processName,
      before, after, detail: ok ? '执行成功' : (r.error || r.stderr || '执行失败'), ok,
    });
    if (!ok) {
      return { ok: false, error: (r.error || r.stderr || 'pm2 执行失败').slice(0, 500), status: 500 };
    }
    return { ok: true, action, name: processName, message: action === 'restart' ? '重启指令已执行' : `已${action === 'stop' ? '停止' : '启动'} ${processName}` };
  }

  /**
   * 读取进程最近 N 行日志。
   * @param {string} name 进程名
   * @param {number} [lines] 行数（1~200，默认 50）
   * @returns {Promise<{ok:boolean, name:string, lines:number, logs:string, error?:string, status?:number}>}
   */
  async logs(name, lines) {
    const processName = String(name || '');
    if (!this.isAllowed(processName)) {
      return { ok: false, error: `进程「${processName}」不在服务端 pm2 白名单内`, status: 403 };
    }
    const n = Math.min(LOG_LINES_MAX, Math.max(1, parseInt(lines, 10) || 50));
    const r = await this._exec('pm2', ['logs', processName, '--lines', String(n), '--nostream'], ACTION_TIMEOUT_MS);
    if (!r.ok) {
      return { ok: false, error: (r.error || r.stderr || '读取日志失败').slice(0, 500), status: 500 };
    }
    const logs = (r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-LOG_LINES_MAX).join('\n');
    return { ok: true, name: processName, lines: n, logs };
  }
}

/** 默认单例（生产用） */
const _default = new OpsPm2();

module.exports = { OpsPm2, default: _default, ACTIONS, LOG_LINES_MAX, NAME_RE };
