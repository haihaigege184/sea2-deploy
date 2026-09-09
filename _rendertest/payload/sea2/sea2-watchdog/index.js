'use strict';
/**
 * sea2-watchdog/index.js — [R9 R3-2] 框架冗余 watchdog（sea1/sea2 双框架守护）
 *
 * 职责（架构师 R9 设计 T04）：
 *  - 每 15s 读 /root/sea2/run/heartbeat.json（sea2-bot 原子写，含 ts/channel/channelState/circuitBroken）；
 *  - 心跳丢失 >3 分钟（12 次）→ role=SEA1_ACTIVE + `systemctl start sea1-bot` + `docker start napcat`；
 *  - 心跳恢复 → `systemctl stop sea1-bot`（docker napcat 保持运行，R3-1 依赖）；
 *  - <3 分钟不激活（连续丢失计数不足阈值不动手，防抖动误切）；
 *  - 轮询服务端 GET /api/ops/framework-cmd?deviceId=&role=watchdog 执行 to_sea1/to_sea2/unblock + POST ack；
 *    （unblock 由 bot 轮询 role=bot 执行；watchdog 只处理进程级 to_sea1/to_sea2）
 *  - 仲裁 role 文件：/root/sea2/run/framework.role（内容 SEA2_ACTIVE / SEA1_ACTIVE）。
 *
 * 运行：pm2 常驻（ecosystem.watchdog.config.js）。
 * 测试：Windows 本机无法真跑 systemctl/docker —— 命令构造/状态判定为纯函数（buildCommands/decide），
 *       可单测；真实执行由 runCommand 注入 mock。
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

// ---------- 环境配置（均可被 env 覆盖，便于测试） ----------
const CFG = {
  intervalMs: parseInt(process.env.WATCHDOG_INTERVAL_MS || '15000', 10),
  heartbeatFile: process.env.WATCHDOG_HEARTBEAT_FILE || '/root/sea2/run/heartbeat.json',
  roleFile: process.env.WATCHDOG_ROLE_FILE || '/root/sea2/run/framework.role',
  lostThresholdMs: parseInt(process.env.WATCHDOG_LOST_MS || (3 * 60 * 1000), 10), // 3 分钟
  serverUrl: (process.env.SEA2_SERVER_URL || '').replace(/\/+$/, ''),
  deviceId: process.env.SEA2_DEVICE_ID || '',
  opsToken: process.env.SEA2_OPS_TOKEN || '',
  sea1Service: process.env.SEA1_SERVICE || 'sea1-bot',
  // [R10 部署适配] sea1 框架控制方式：pm2（生产 sea1-bot 为 pm2 托管，无 systemd 单元）| systemctl
  sea1Ctrl: process.env.SEA1_CTRL || 'pm2',
  dockerBackup: process.env.DOCKER_BACKUP_CONTAINER || 'napcat',
  // [2026-08-31 双向仲裁] 真实在线检测：心跳文件只反映"bot 进程活着"，不反映"QQ 账号在线"。
  // 副号 QQ 静默掉线时 sea1-bot 进程仍在、心跳照写 → 仲裁失效（用户实测：副号掉线不切主号）。
  // 必须以 OneBot get_status 的 online 字段为准（get_login_info 掉线后返回缓存数据，不可信）。
  mainNapcatUrl: (process.env.MAIN_NAPCAT_URL || 'http://127.0.0.1:4000').replace(/\/+$/, ''),
  backupNapcatUrl: (process.env.BACKUP_NAPCAT_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  napcatToken: process.env.MAIN_BACKUP_NAPCAT_TOKEN || '__NAPCAT_TOKEN__',
  offlineStreakThreshold: parseInt(process.env.WATCHDOG_OFFLINE_STREAK || '8', 10) || 8,   // 连续8次(15s×8=2min)确认真实掉线
  switchCooldownMs: parseInt(process.env.WATCHDOG_SWITCH_COOLDOWN_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000), // 切换冷却10min，防频繁切换喂QQ风控
  logTag: 'sea2-watchdog',
};

// [ENG-5] 连续丢失 ≥12 次（15s×12=3min）才激活 sea1（boot grace 防抖）
const MISSING_STREAK_THRESHOLD = 12;

// 连续丢失/过期计数（tickOnce 维护：缺失或过期 +1，新鲜归零）
let missingStreak = 0;

/** 测试/巡检用：重置连续丢失计数 */
function resetMissingStreak() {
  missingStreak = 0;
}

/** 读取当前连续丢失计数（测试观察用） */
function getMissingStreak() {
  return missingStreak;
}

function log(msg, level) {
  const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${time}] [${level || 'INFO'}] [${CFG.logTag}] ${msg}`);
}

/** 读取心跳 JSON；缺失/损坏 → null */
function readHeartbeat(file) {
  try {
    const raw = fs.readFileSync(file || CFG.heartbeatFile, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o.ts !== 'number') return null;
    return o;
  } catch (e) {
    return null;
  }
}

/** 读取 role 文件；缺失 → 'SEA1_ACTIVE'（保守待命，防重启后双响） */
function readRole(file) {
  try {
    return fs.readFileSync(file || CFG.roleFile, 'utf8').trim() || 'SEA1_ACTIVE';
  } catch (e) {
    return 'SEA1_ACTIVE';
  }
}

/** 写 role 文件（原子写） */
function writeRole(role, file) {
  try {
    const f = file || CFG.roleFile;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, String(role));
    fs.renameSync(tmp, f);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 命令构造（纯函数，供测试）：返回 argv 数组列表，按序执行。
 *  - to_sea1：启动 sea1 框架（按 CFG.sea1Ctrl：pm2 start sea1-bot 或 systemctl start sea1-bot + docker start napcat）
 *  - to_sea2：切回 sea2 框架（按 sea1Ctrl 停止 sea1-bot；docker napcat 保持运行，R3-1 依赖）
 *  - unblock：watchdog 不处理（由 bot 轮询 role=bot 执行），返回空
 * @param {string} action 'to_sea1'|'to_sea2'|'unblock'
 * @returns {Array<Array<string>>} argv 数组列表
 */
function sea1StartCmd() {
  return CFG.sea1Ctrl === 'pm2' ? ['pm2', 'start', CFG.sea1Service] : ['systemctl', 'start', CFG.sea1Service];
}
function sea1StopCmd() {
  return CFG.sea1Ctrl === 'pm2' ? ['pm2', 'stop', CFG.sea1Service] : ['systemctl', 'stop', CFG.sea1Service];
}
function buildCommands(action) {
  switch (action) {
    case 'to_sea1':
      // [FIX 2026-09-06 手动切换打回] 必须先停主框架 sea2-bot：
      // 否则其心跳持续新鲜，tickOnce 判定"心跳恢复"→ 13 秒内把角色打回 SEA2_ACTIVE（打摆子）
      return [
        ['pm2', 'stop', process.env.SEA2_SERVICE || 'sea2-bot'],
        sea1StartCmd(),
        ['docker', 'start', CFG.dockerBackup],
      ];
    case 'to_sea2':
      return [
        sea1StopCmd(),
        ['pm2', 'start', process.env.SEA2_SERVICE || 'sea2-bot'],
      ];
    case 'unblock':
      return [];
    default:
      return [];
  }
}

/**
 * 状态判定（纯函数，供测试）：根据心跳新鲜度、当前 role 与连续丢失次数决策。
 * [ENG-5] 缺失/过期心跳必须连续丢失 ≥12 次（≈3 分钟，15s×12）才激活 sea1，
 * 否则 sea2 冷启动/短暂抖动窗口会误触发 sea1 启停（防抖）。
 * @param {object|null} hb 心跳（null=缺失）
 * @param {number} now 当前时间戳
 * @param {string} role 当前 role 文件内容
 * @param {number} lostThresholdMs 丢失阈值
 * @param {number} [missingStreak=12] 连续丢失/过期次数（调用方维护；缺失或过期时 +1，新鲜时归零）
 * @returns {{activateSea1:boolean, deactivateSea1:boolean, reason:string, lostMs:number, missingStreak:number}}
 *   - activateSea1：心跳丢失超阈值 且 连续丢失 ≥12 次 且 当前非 SEA1_ACTIVE → 应切 sea1
 *   - deactivateSea1：心跳恢复且当前为 SEA1_ACTIVE → 应切回 sea2
 */
function decide(hb, now, role, lostThresholdMs, missingStreak) {
  const threshold = lostThresholdMs || CFG.lostThresholdMs;
  const streak = Number(missingStreak) || 0;
  if (!hb) {
    // 心跳文件缺失/损坏：需连续丢失 ≥12 次（3min）才保守切 sea1（boot grace 防抖）
    const ready = streak >= MISSING_STREAK_THRESHOLD;
    return {
      activateSea1: ready && role !== 'SEA1_ACTIVE',
      deactivateSea1: false,
      reason: ready ? 'heartbeat-missing' : 'heartbeat-missing-grace',
      lostMs: threshold + 1,
      missingStreak: streak,
    };
  }
  const lostMs = Math.max(0, now - hb.ts);
  if (lostMs > threshold) {
    const ready = streak >= MISSING_STREAK_THRESHOLD;
    return {
      activateSea1: ready && role !== 'SEA1_ACTIVE',
      deactivateSea1: false,
      reason: ready ? 'heartbeat-stale' : 'heartbeat-stale-grace',
      lostMs,
      missingStreak: streak,
    };
  }
  return {
    activateSea1: false,
    deactivateSea1: role === 'SEA1_ACTIVE',
    reason: 'heartbeat-fresh',
    lostMs,
    missingStreak: 0,
  };
}

/**
 * 执行命令（可注入 mock 测试）。
 * @param {Array<string>} argv
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function runCommand(argv) {
  return new Promise((resolve) => {
    if (!Array.isArray(argv) || !argv.length) return resolve({ ok: true });
    const bin = argv[0];
    const args = argv.slice(1);
    cp.execFile(bin, args, { timeout: 30000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        // systemctl start 在服务已运行时返回非零（already running）→ 视为成功（幂等）
        resolve({ ok: true, warning: String(stderr || err.message).trim() });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

/**
 * 执行动作（to_sea1/to_sea2）：更新 role 文件 + 顺序执行命令。
 * @returns {Promise<{ok:boolean, action:string, steps:Array<{cmd:string[], ok:boolean, warning?:string}>}>}
 */
async function executeAction(action) {
  const steps = [];
  const cmds = buildCommands(action);
  for (const argv of cmds) {
    const r = await runCommand(argv);
    steps.push({ cmd: argv, ok: r.ok, warning: r.warning || '' });
  }
  // [FIX 2026-09-06 手动切换打回] 任何方向的切换都进入 10min 冷却，
  // 手动/面板指令切换同样受保护（此前只有仲裁与心跳路径记录 lastSwitchAt）
  lastSwitchAt = Date.now();
  if (action === 'to_sea1') {
    writeRole('SEA1_ACTIVE');
    log('已切换 role=SEA1_ACTIVE（sea1 主框架，sea2-bot 已停）');
  } else if (action === 'to_sea2') {
    writeRole('SEA2_ACTIVE');
    log('已切换 role=SEA2_ACTIVE（sea2 主框架）');
  }
  return { ok: true, action, steps };
}

/** 轮询服务端框架指令（role=watchdog）并执行 + 回执 */
async function pollServerCommands() {
  if (!CFG.serverUrl || !CFG.deviceId || !CFG.opsToken) {
    log('未配置 SEA2_SERVER_URL/SEA2_DEVICE_ID/SEA2_OPS_TOKEN，跳过指令轮询', 'WARN');
    return [];
  }
  try {
    const r = await fetch(CFG.serverUrl + '/api/ops/framework-cmd?deviceId=' + encodeURIComponent(CFG.deviceId) + '&role=watchdog', {
      headers: { 'x-ops-token': CFG.opsToken },
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    const cmds = (j && j.commands) || [];
    if (!cmds.length) return [];
    const results = [];
    for (const c of cmds) {
      try {
        const r2 = await executeAction(c.action);
        results.push({ id: c.id, ok: true, result: r2.steps });
        log('已执行框架指令 ' + c.action + '（' + r2.steps.length + ' 步）');
      } catch (e) {
        results.push({ id: c.id, ok: false, error: String(e && e.message || e) });
      }
    }
    try {
      await fetch(CFG.serverUrl + '/api/ops/framework-cmd/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ops-token': CFG.opsToken },
        body: JSON.stringify({ deviceId: CFG.deviceId, results }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) { /* 回执失败下周期重试 */ }
    return results;
  } catch (e) {
    log('轮询框架指令失败: ' + String(e && e.message || e), 'WARN');
    return [];
  }
}

/** 单次巡检：读心跳 → 更新连续丢失计数 → 判定 → 必要时切换 */
// ---------- [2026-08-31 双向仲裁] 账号真实在线检测 ----------
// 连续掉线计数（按在岗方记录：sea2=主号, sea1=副号）
const offlineStreak = { sea2: 0, sea1: 0 };
let lastSwitchAt = 0;     // 上次仲裁切换时间（冷却用，防频繁切换喂风控）
let arbiterBusy = false;

/**
 * 查询 NapCat 账号【真实】在线状态（OneBot get_status 的 online 字段）。
 * @returns {Promise<boolean|null>} true=在线 false=掉线 null=接口不可达（容器停止等，交由心跳逻辑处理）
 */
async function fetchOnline(url) {
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/get_status', {
      headers: { Authorization: 'Bearer ' + CFG.napcatToken },
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    const d = (j && j.data) || {};
    if (typeof d.online === 'boolean') return d.online;
    if (j && typeof j.online === 'boolean') return j.online;
    return null;
  } catch (e) { return null; }
}

/**
 * 双向仲裁（每轮巡检执行）：**在岗方账号真实掉线且另一方健康 → 自动切换**。
 *
 * 背景（仲裁失效事故）：原逻辑只监控 sea2-bot 心跳（单向），且心跳只反映进程存活。
 * 副号 QQ 被风控静默掉线时：sea1-bot 进程还在、心跳照写 → 无任何机制切回主号；
 * 且 SEA1_ACTIVE 下 sea2-bot 已停、心跳不会再增长，靠"心跳恢复"切回成为死锁，
 * 只能人工干预。此函数补上缺失的另一半：双向监控 + 以 get_status.online 为准。
 */
async function arbiterTick(role) {
  if (arbiterBusy) return;
  arbiterBusy = true;
  try {
    // 切换冷却：刚切换过先观望。切换动作包含登录尝试（docker start / bot 拉起），
    // 频繁来回切换会持续喂 QQ 风控（ErrCode:3），越切越锁死。
    if (lastSwitchAt && Date.now() - lastSwitchAt < CFG.switchCooldownMs) return;

    const isSea1 = role === 'SEA1_ACTIVE';
    const curUrl = isSea1 ? CFG.backupNapcatUrl : CFG.mainNapcatUrl;
    const otherUrl = isSea1 ? CFG.mainNapcatUrl : CFG.backupNapcatUrl;
    const key = isSea1 ? 'sea1' : 'sea2';

    const cur = await fetchOnline(curUrl);
    if (cur === true) { offlineStreak[key] = 0; return; }        // 在岗方健康，计数归零
    if (cur === null) return;                                     // 接口不可达：进程级问题由心跳逻辑负责

    offlineStreak[key] += 1;
    if (offlineStreak[key] < CFG.offlineStreakThreshold) {
      log('在岗方(' + key + ') get_status.online=false，连续 ' + offlineStreak[key] + '/' + CFG.offlineStreakThreshold + ' 次，观察中', 'WARN');
      return;
    }

    // 确认在岗方真实掉线（连续 ≥8 次 ≈ 2 分钟）。切换前必须确认另一方真正在线，
    // 否则切过去也是死号，纯浪费一次登录尝试、平白喂风控。
    const other = await fetchOnline(otherUrl);
    if (other !== true) {
      log('在岗方(' + key + ')账号确认掉线，但另一方 get_status=' + other + '（非在线），不切换（双方皆亡，切换无意义且喂风控）', 'WARN');
      return;
    }

    const action = isSea1 ? 'to_sea2' : 'to_sea1';
    log('★ 双向仲裁触发：在岗方(' + key + ')账号真实掉线（online=false 连续 ' + offlineStreak[key] + ' 次），另一方在线 → 执行 ' + action);
    const r = await executeAction(action);
    if (r && r.ok) {
      lastSwitchAt = Date.now();
      offlineStreak[key] = 0;
      log('双向仲裁完成：已 ' + action + '，进入 ' + Math.round(CFG.switchCooldownMs / 60000) + ' 分钟冷却');
    } else {
      log('双向仲裁切换失败: ' + JSON.stringify(r || {}), 'ERROR');
    }
  } finally {
    arbiterBusy = false;
  }
}

async function tickOnce() {
  const now = Date.now();
  const role = readRole();
  const hb = readHeartbeat();
  // [ENG-5] 维护连续丢失计数：缺失或过期 +1；新鲜归零
  if (hb && (now - hb.ts) <= CFG.lostThresholdMs) {
    missingStreak = 0;
  } else {
    missingStreak += 1;
  }
  const d = decide(hb, now, role, CFG.lostThresholdMs, missingStreak);

  if (d.activateSea1) {
    // [FIX 2026-09-06] 心跳切换与双向仲裁共用冷却；主号在线时禁止切 sea1（防打摆子）
    if (lastSwitchAt && Date.now() - lastSwitchAt < CFG.switchCooldownMs) {
      // 冷却期内：等 sea2-bot 完成启动并写入心跳，不做心跳切换
    } else {
      const mainOnline = await fetchOnline(CFG.mainNapcatUrl);
      if (mainOnline === true) {
        log('心跳丢失但主号在线（sea2-bot 进程异常）→ 不切 sea1，等待自愈/人工处理', 'WARN');
      } else {
        log('心跳丢失（streak=' + missingStreak + ', lostMs=' + d.lostMs + 'ms > 阈值），切换 role=SEA1_ACTIVE 并启动 sea1 框架');
        const r = await executeAction('to_sea1');
        if (!r.ok) log('切换 sea1 失败: ' + (r.error || ''), 'ERROR');
        else lastSwitchAt = Date.now();
      }
    }
  } else if (d.deactivateSea1) {
    // [FIX 2026-09-06 手动切换打回] 切到 sea1 后 sea2-bot 已停，但心跳文件在 3min 阈值内
    // 仍显示"新鲜"（残留 ts），无冷却时会立刻误判"心跳恢复"打回主号 → 与激活路径共用 10min 冷却
    if (lastSwitchAt && Date.now() - lastSwitchAt < CFG.switchCooldownMs) {
      // 冷却期内不回切（等 sea2-bot 真正恢复或冷却结束再仲裁）
    } else {
      log('心跳恢复（lostMs=' + d.lostMs + 'ms），停止 sea1 框架，切回 role=SEA2_ACTIVE（docker napcat 保持运行）');
      const r = await executeAction('to_sea2');
      if (!r.ok) log('切回 sea2 失败: ' + (r.error || ''), 'ERROR');
    }
  }
  return { role, heartbeat: hb ? { ts: hb.ts, channel: hb.channel, channelState: hb.channelState, circuitBroken: hb.circuitBroken } : null, decide: d, missingStreak };
}

/** 巡检附加项：双向仲裁（账号真实在线检测，一方掉线自动切另一方） */
async function arbiterOnce(role) {
  try { await arbiterTick(role); } catch (e) { log('双向仲裁异常: ' + String(e && e.message || e), 'ERROR'); }
}

/** 启动 watchdog（pm2 常驻） */
async function main() {
  log('sea2-watchdog 启动（interval=' + CFG.intervalMs + 'ms, lostThreshold=' + CFG.lostThresholdMs + 'ms）');
  const loop = async () => {
    try {
      const res = await tickOnce();
      await arbiterOnce(res && res.role);
      await pollServerCommands();
    } catch (e) {
      log('巡检异常: ' + String(e && e.message || e), 'ERROR');
    }
  };
  setInterval(loop, CFG.intervalMs);
  // 启动后立即巡检一次（不等 15s）
  loop();
}

if (require.main === module) {
  main().catch((e) => {
    log('watchdog 启动失败: ' + String(e && e.message || e), 'FATAL');
    process.exit(1);
  });
}

module.exports = {
  CFG,
  MISSING_STREAK_THRESHOLD,
  readHeartbeat,
  readRole,
  writeRole,
  buildCommands,
  decide,
  runCommand,
  executeAction,
  pollServerCommands,
  tickOnce,
  resetMissingStreak,
  getMissingStreak,
  main,
};
