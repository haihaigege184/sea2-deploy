'use strict';
/**
 * lib/channelManager.js — [R9 R3-1] 双通道状态机 + 仲裁锁
 *
 * 职责（架构师 R9 设计 T03）：
 *  状态机：
 *    MAIN_ONLINE ──(3 次连续丢失, 5s 探测间隔)──▶ MAIN_DOWN
 *    MAIN_DOWN ──(30s 未恢复)──▶ BACKUP_ACTIVE
 *    BACKUP_ACTIVE ──(主通道恢复 3 连 OK)──▶ MAIN_RECOVERING
 *    MAIN_RECOVERING ──(≤10s 保持 OK)──▶ MAIN_ONLINE
 *  通道：
 *    main    = 二进制 NapCat HTTP API（端口从配置读取，如 napcat-http.env / 进程 env）
 *    backup  = 本机 docker NapCat localhost:3000（同机无穿透）
 *  探活：HTTP 请求 NapCat 状态接口（POST {url}/ {action:"get_login_info"}，200 且有 user_id 视为 OK）
 *  仲裁锁 send(channel)：仅当 state.channel===channel 且 role==='SEA2_ACTIVE' 才允许发送。
 *    - 进程内单例（模块级 _singleton）+ /root/sea2/run/framework.role 文件跨进程双保险；
 *    - role 文件内容 'SEA2_ACTIVE' → sea2 主框架；'SEA1_ACTIVE' → sea1 主框架（sea2 待命不响应）。
 *  通道状态进心跳表：原子写 /root/sea2/run/heartbeat.json（含 ts/channel/channelState/circuitBroken），
 *    供 sea2-watchdog 监控（丢失 >3 分钟 → 切 sea1）。
 *
 * 零新增 npm 依赖：node:http / node:fs / node:path。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const STATES = {
  MAIN_ONLINE: 'MAIN_ONLINE',
  MAIN_DOWN: 'MAIN_DOWN',
  BACKUP_ACTIVE: 'BACKUP_ACTIVE',
  MAIN_RECOVERING: 'MAIN_RECOVERING',
};

const DEFAULT_OPTS = {
  mainUrl: process.env.SEA2_MAIN_NAPCAT_URL || 'http://127.0.0.1:4000',
  mainToken: process.env.SEA2_MAIN_NAPCAT_TOKEN || '',
  backupUrl: process.env.SEA2_BACKUP_NAPCAT_URL || 'http://127.0.0.1:3000',
  backupToken: process.env.SEA2_BACKUP_NAPCAT_TOKEN || '',
  roleFile: process.env.SEA2_ROLE_FILE || '/root/sea2/run/framework.role',
  heartbeatFile: process.env.SEA2_HEARTBEAT_FILE || '/root/sea2/run/heartbeat.json',
  probeIntervalMs: 5000,       // 探活间隔
  mainDownAfterMs: 30000,      // MAIN_DOWN 后等待主恢复的超时（超时切 backup）
  recoveringMs: 10000,         // MAIN_RECOVERING 观察窗口
  recoverConsecutive: 3,       // 主通道恢复连续 OK 次数（切 recovering）
  ownQq: process.env.SEA2_OWN_QQ || '',
  probeImpl: null,             // 可注入探活实现（测试用）：async (url, token) => boolean
  roleReader: null,            // 可注入 role 读取（测试用）：() => 'SEA2_ACTIVE'|'SEA1_ACTIVE'
};

/** 解析 http(s) URL 为 {protocol, host, port, path} */
function parseHttpUrl(u) {
  const m = String(u || '').match(/^(https?):\/\/([^/:]+)(?::(\d+))?(.*)$/);
  if (!m) return { protocol: 'http:', host: '127.0.0.1', port: 80, path: '' };
  const dflt = m[1] === 'https' ? 443 : 80;
  return { protocol: m[1] + ':', host: m[2], port: parseInt(m[3] || '', 10) || dflt, path: (m[4] || '').replace(/\/+$/, '') };
}

/** 默认探活：POST {url}/ {action:"get_login_info"}。
 * NapCat4 实测（2026-08-07）：HTTP 端点对任意 action 返回 {status:"ok",retcode:0,data:{},message:"NapCat4 Is Running"}（非 OneBot action 执行）。
 * 判定口径（R10 部署适配）：
 *   - 响应 retcode===0 且 status==='ok' → 通道可达（NapCat 进程活着；登录态由实际收发验证）；
 *   - 或 data.user_id 非空（兼容真正执行 action 的 NapCat/OneBot 实现）→ 可达。
 */
function defaultProbe(url, token) {
  return new Promise((resolve) => {
    const u = parseHttpUrl(url);
    const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'sea2-channel-manager/1.0' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = lib.request(
      { host: u.host, port: u.port, path: u.path || '/', method: 'POST', headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let ok = res.statusCode >= 200 && res.statusCode < 300;
          if (ok) {
            try {
              const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              const data = j.data || {};
              // [R10] NapCat4 运行态响应：retcode/status 在响应顶层（data 为 {}）→ 可达；兼容含 user_id 的登录态
              if (j.retcode === 0 || j.status === 'ok') ok = true;
              else if (data.user_id !== undefined && data.user_id !== null && data.user_id !== '') ok = true;
              else ok = false;
            } catch (e) {
              ok = false;
            }
          }
          resolve(ok);
        });
        res.on('error', () => resolve(false));
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(false); });
    req.end();
  });
}

/** 原子写 JSON（tmp+rename） */
function writeJsonAtomic(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    return false;
  }
}

/** 读取 role 文件（默认实现） */
function defaultRoleReader(roleFile) {
  try {
    const raw = fs.readFileSync(roleFile, 'utf8').trim();
    return raw || 'SEA1_ACTIVE'; // 文件缺失 → 保守待命（防重启后双响）
  } catch (e) {
    return 'SEA1_ACTIVE';
  }
}

/**
 * 创建双通道状态机实例。
 * 进程内单例：createChannelManager 重复调用返回同一实例（避免多个定时器/状态漂移）；
 * 测试可用 createChannelManager(opts, {forceNew:true}) 强制新建。
 * @param {object} [opts]
 * @returns {{
 *   getState(): string,
 *   getChannel(): string,
 *   getRole(): string,
 *   canSend(channel: string): boolean,
 *   send(channel: string): boolean,
 *   probeOnce(): Promise<void>,
 *   start(): void,
 *   stop(): void,
 *   writeHeartbeat(circuitBroken?: boolean): void,
 *   state(): object,
 * }}
 */
function createChannelManager(opts, internal) {
  if (!internal || !internal.forceNew) {
    if (_singleton) return _singleton;
  }
  const o = Object.assign({}, DEFAULT_OPTS, opts || {});
  const probeImpl = o.probeImpl || ((url, token) => defaultProbe(url, token));
  const roleReader = o.roleReader || (() => defaultRoleReader(o.roleFile));

  const st = {
    state: STATES.MAIN_ONLINE,   // 当前状态机状态
    channel: 'main',             // 当前活跃通道（'main' | 'backup'）
    mainLossStreak: 0,           // 主通道连续丢失次数
    mainOkStreak: 0,             // 主通道连续 OK 次数
    mainDownSince: 0,            // 进入 MAIN_DOWN 的时刻
    recoveringSince: 0,          // 进入 MAIN_RECOVERING 的时刻
    lastProbeAt: 0,
    mainOk: true,
    backupOk: false,
    circuitBroken: false,
    role: 'SEA1_ACTIVE',
    started: false,
  };

  let timer = null;

  function getRole() {
    try { st.role = roleReader(); } catch (e) { st.role = 'SEA1_ACTIVE'; }
    return st.role;
  }

  /** 核心状态机推进（纯函数式，便于测试） */
  function advance(mainOk, backupOk) {
    const t = Date.now();
    st.mainOk = mainOk;
    st.backupOk = backupOk;

    switch (st.state) {
      case STATES.MAIN_ONLINE:
        if (!mainOk) {
          st.mainLossStreak += 1;
          if (st.mainLossStreak >= 3) {
            st.state = STATES.MAIN_DOWN;
            st.mainDownSince = t;
            st.channel = 'main'; // 仍标记 main（未切 backup，等待恢复）
          }
        } else {
          st.mainLossStreak = 0;
        }
        break;
      case STATES.MAIN_DOWN:
        if (mainOk) {
          st.mainOkStreak += 1;
          if (st.mainOkStreak >= o.recoverConsecutive) {
            st.state = STATES.MAIN_RECOVERING;
            st.recoveringSince = t;
            st.channel = 'main';
            st.mainOkStreak = 0;
          }
        } else {
          st.mainOkStreak = 0;
          if (t - st.mainDownSince >= o.mainDownAfterMs) {
            st.state = STATES.BACKUP_ACTIVE;
            st.channel = 'backup';
          }
        }
        break;
      case STATES.BACKUP_ACTIVE:
        if (mainOk) {
          st.mainOkStreak += 1;
          if (st.mainOkStreak >= o.recoverConsecutive) {
            st.state = STATES.MAIN_RECOVERING;
            st.recoveringSince = t;
            st.channel = 'main';
            st.mainOkStreak = 0;
          }
        } else {
          st.mainOkStreak = 0;
        }
        break;
      case STATES.MAIN_RECOVERING:
        if (mainOk) {
          if (t - st.recoveringSince >= o.recoveringMs) {
            st.state = STATES.MAIN_ONLINE;
            st.channel = 'main';
            st.mainLossStreak = 0;
            st.mainOkStreak = 0;
          }
        } else {
          // 观察窗口内主再次失败 → 回 MAIN_DOWN
          st.state = STATES.MAIN_DOWN;
          st.mainDownSince = t;
          st.channel = 'main';
          st.mainLossStreak = 3; // 已连续失败，视为立即 down
        }
        break;
      default:
        st.state = STATES.MAIN_ONLINE;
        st.channel = 'main';
    }
  }

  /** 单次探活（主 + 副）并推进状态机 */
  async function probeOnce() {
    const mainOk = await probeImpl(o.mainUrl, o.mainToken);
    const backupOk = await probeImpl(o.backupUrl, o.backupToken);
    st.lastProbeAt = Date.now();
    advance(mainOk, backupOk);
    getRole();
    return { mainOk, backupOk, state: st.state, channel: st.channel };
  }

  /**
   * 仲裁锁：仅当 state.channel===channel 且 role==='SEA2_ACTIVE' 才允许发送。
   * @param {string} channel 'main' | 'backup'
   * @returns {boolean}
   */
  function canSend(channel) {
    if (getRole() !== 'SEA2_ACTIVE') return false;
    return st.channel === channel;
  }

  /** 仲裁锁别名（设计口径 send(channel)） */
  function send(channel) {
    return canSend(channel);
  }

  /** 写心跳表（原子写；供 watchdog 监控） */
  function writeHeartbeat(circuitBroken) {
    if (circuitBroken !== undefined) st.circuitBroken = !!circuitBroken;
    const hb = {
      ts: Date.now(),
      channel: st.channel,
      channelState: st.state,
      circuitBroken: st.circuitBroken,
      role: getRole(),
      mainOk: st.mainOk,
      backupOk: st.backupOk,
    };
    writeJsonAtomic(o.heartbeatFile, hb);
    return hb;
  }

  /** 启动定时探活（5s）+ 立即探活一次 */
  function start() {
    if (st.started) return;
    st.started = true;
    probeOnce().catch(() => { /* 首探失败不阻断 */ });
    timer = setInterval(() => {
      probeOnce().catch(() => { /* 探活异常忽略 */ });
    }, o.probeIntervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    st.started = false;
  }

  function getState() { return st.state; }
  function getChannel() { return st.channel; }

  /** 测试专用：直接修改内部状态（生产勿用） */
  function _debugSet(patch) {
    Object.assign(st, patch || {});
  }

  function state() {
    return {
      state: st.state,
      channel: st.channel,
      role: getRole(),
      mainOk: st.mainOk,
      backupOk: st.backupOk,
      mainLossStreak: st.mainLossStreak,
      mainOkStreak: st.mainOkStreak,
      mainDownSince: st.mainDownSince,
      recoveringSince: st.recoveringSince,
      lastProbeAt: st.lastProbeAt,
      circuitBroken: st.circuitBroken,
      started: st.started,
      heartbeatFile: o.heartbeatFile,
      roleFile: o.roleFile,
    };
  }

  const inst = { getState, getChannel, getRole, canSend, send, probeOnce, start, stop, writeHeartbeat, state, _debugSet };
  if (!_singleton) _singleton = inst;
  return inst;
}

// 进程内单例（双保险之一；跨进程由 role 文件兜底）
let _singleton = null;

/** 测试专用：重置单例 */
function resetSingleton() {
  if (_singleton && typeof _singleton.stop === 'function') _singleton.stop();
  _singleton = null;
}

module.exports = { createChannelManager, resetSingleton, STATES, DEFAULT_OPTS, parseHttpUrl, defaultProbe, writeJsonAtomic, defaultRoleReader };
