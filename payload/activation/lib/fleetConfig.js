'use strict';
/**
 * lib/fleetConfig.js — Fleet 阈值运行时读写（热更）
 *
 * 9 个 fleet 阈值落 data/fleet-config.json（与 config.env 解耦，避免重启才生效）。
 * configManager 的「集群管理」分组委托本模块读写；服务端 fleet 逻辑经 load() 实时取值。
 *
 * 热更策略：
 *  - load() 每次重读文件（并叠加环境变量覆盖）→ 配置改完立即生效，无需重启。
 *  - save() 合并写入文件，返回全量。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  externalEndpoint: '',
  internalEndpoint: 'http://10.0.0.11:3457',
  fleetHeartbeatInterval: 60,   // 秒
  fleetOfflineDays: 7,          // 天：仅供 anomaly.js:ruleLongOffline 使用，不参与列表状态判定
  fleetCodeSharedMin: 2,        // 台
  fleetScanInterval: 60,        // 秒
  fleetFreqMinMul: 0.5,         // 频率下限系数
  fleetFreqMaxMul: 2,           // 频率上限系数
  fleetFlushMs: 2000,           // 毫秒
  // —— v1.0 集群运维增强新增 ——
  fleetStaleMinutes: 30,        // 分钟：掉线(stale) → 离线(offline) 的分界
  fleetCpuWarn: 85,             // %：集群表 CPU 标橙阈值
  fleetMemWarn: 85,             // %：集群表内存标橙阈值
  // —— sea2 商用运维新增（system_design_sea2_ops_v1.0.md §3.6 配置中心扩展）——
  formatWhitelist: ['SEA2-', 'SEA1-8GA4'],   // 机器码前缀白名单（格式化强门禁校验）
  formatLevels: {                              // 格式化三档分级参数
    data: { countdownSec: 15, confirmWord: 'FORMAT-DATA' },
    factory: { countdownSec: 20, confirmWord: 'FORMAT-FACTORY' },
    disk: { countdownSec: 30, confirmWord: 'FORMAT-DISK' },
  },
  totpSecret: '',               // 管理员二次验证码共享密钥（首次生成，不回显明文）
  highriskEnabled: true,        // 高危专区总开关（false = 全区拒绝）
  cupsDriverRepo: '',           // 驱动包仓库 URL（空 = 仅内置型号库）
  pm2ServerWhitelist: ['sea1-activation', 'sea1-bot', 'sea1-client-x86'], // 服务端 pm2 直控白名单
  formatDiskTarget: '',         // disk 档整盘擦除目标设备（如 /dev/sda；空 = 拒绝签发 disk 档，T05）
  // —— [R9 R2] 机器人防互激发（botGuard 热更；服务端 fleetConfig → 运维下发客户端）——
  botRateLimitPer5s: 3,         // 群/QQ 每 5s 最多回复条数
  botBurstPer10s: 20,           // 群每 10s 消息条数上限（超过触发熔断）
  botCircuitBreakSec: 60,       // 群熔断暂停秒数
};

// 环境变量覆盖（可选，便于容器注入）
const ENV_MAP = {
  EXTERNAL_ENDPOINT: 'externalEndpoint',
  INTERNAL_ENDPOINT: 'internalEndpoint',
  FLEET_HB_INTERVAL: 'fleetHeartbeatInterval',
  FLEET_OFFLINE_DAYS: 'fleetOfflineDays',
  FLEET_CODE_SHARED_MIN: 'fleetCodeSharedMin',
  FLEET_SCAN_INTERVAL: 'fleetScanInterval',
  FLEET_FREQ_MIN_MUL: 'fleetFreqMinMul',
  FLEET_FREQ_MAX_MUL: 'fleetFreqMaxMul',
  FLEET_FLUSH_MS: 'fleetFlushMs',
  FLEET_STALE_MINUTES: 'fleetStaleMinutes',
  FLEET_CPU_WARN: 'fleetCpuWarn',
  FLEET_MEM_WARN: 'fleetMemWarn',
  BOT_RATE_LIMIT_PER_5S: 'botRateLimitPer5s',
  BOT_BURST_PER_10S: 'botBurstPer10s',
  BOT_CIRCUIT_BREAK_SEC: 'botCircuitBreakSec',
};

let _cacheFile = null;
let _cache = null;

function file() {
  if (!_cacheFile) {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    _cacheFile = path.join(dataDir, 'fleet-config.json');
  }
  return _cacheFile;
}

/** 仅测试/特殊场景用：指定文件位置 */
function setFile(p) {
  _cacheFile = p;
  _cache = null;
}

function _readFile() {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const o = JSON.parse(raw);
    return Object.assign({}, DEFAULTS, o);
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

/**
 * 热读：重读文件 + 环境变量覆盖 + 数值字段归一。
 * @returns {object} 完整阈值对象
 */
function load() {
  const base = _readFile();
  // 环境变量覆盖
  for (const envKey of Object.keys(ENV_MAP)) {
    const v = process.env[envKey];
    if (v !== undefined && v !== '') {
      const k = ENV_MAP[envKey];
      base[k] = (typeof DEFAULTS[k] === 'number') ? Number(v) : v;
    }
  }
  // 数值字段归一（防脏数据）
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'number') base[k] = Number(base[k]) || DEFAULTS[k];
  }
  _cache = base;
  return base;
}

/** 取单字段（懒加载） */
function get(key) {
  const c = _cache || load();
  return c[key];
}

/**
 * 合并保存（热更，不重启）。
 * @param {object} patch 部分字段
 * @returns {object} 全量
 */
function save(patch) {
  const cur = _readFile();
  const next = Object.assign({}, cur, patch || {});
  // 数值字段归一
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'number') next[k] = Number(next[k]) || DEFAULTS[k];
  }
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file()); // 原子写
  } catch (e) {
    // best-effort
  }
  _cache = next;
  return next;
}

module.exports = { DEFAULTS, ENV_MAP, load, get, save, file, setFile };
