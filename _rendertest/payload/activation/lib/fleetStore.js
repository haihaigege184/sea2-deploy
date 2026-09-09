'use strict';
/**
 * lib/fleetStore.js — 外网客户端集群（fleet）独立存储
 *
 * 设计要点（见 system_design_fleet.md §1.2）：
 *  - 内存索引 Map<machineId, ClientRecord>：心跳写 = O(1) 内存更新，**不碰磁盘**。
 *  - 落盘 debounce（默认 2s）批量写 data/fleet.json（原子 tmp + rename）。
 *  - 黑名单 / 指令 / 忽略 等低频写即时 flush（如 admin 拉黑强制落盘）。
 *  - 列表 / 聚合 / 详情 / 异常扫描全在内存，零同步全文件重写。
 *
 * 与既有 store.js 的关系：store.json 不再写心跳（store.recordHeartbeat 保留但 fleet 不调用它），
 * fleet 心跳走本模块，避免 500 台 × 60s 高频全文件重写阻塞主流程。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FLUSH_MS = 2000;
const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

/** 指令 id 格式：cmd-${issuedAt}-${randomHex} */
function genCommandId(issuedAt) {
  const crypto = require('node:crypto');
  return `cmd-${issuedAt}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 高危记录 id 格式：hr-${issuedAt}-${randomHex} */
function genHighriskId(issuedAt) {
  const crypto = require('node:crypto');
  return `hr-${issuedAt}-${crypto.randomBytes(4).toString('hex')}`;
}

/** [T2 P2-12] 机器身份风险 id 格式：risk-${issuedAt}-${randomHex} */
function genRiskId(issuedAt) {
  const crypto = require('node:crypto');
  return `risk-${issuedAt}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 异常 id 格式：${rule}:${machineId}（去重键） */
function anomalyId(rule, machineId) {
  return `${rule}:${machineId}`;
}

/** 单条指令 result 序列化后的字节上限，超出截断（设计 §0.4） */
const RESULT_MAX_BYTES = 64 * 1024;
/** 每台设备最多保留带 result 的指令条数，超出仅丢结果体、保留元数据 */
const RESULT_KEEP_PER_CLIENT = 10;
/** 全局带 result 的指令总量上限，防止 fleet.json 无限膨胀 */
const RESULT_KEEP_GLOBAL = 2000;
/** 指令终态：不再被任何回执改写（timeout 为准终态，允许迟到回执覆盖） */
const CMD_TERMINAL = ['acked', 'failed', 'unsupported'];
/** 高危记录状态机（设计 §3.3）：created | issued | local-confirmed | done | failed | rejected */
const HIGHRISK_STATUS = ['created', 'issued', 'local-confirmed', 'done', 'failed', 'rejected'];
/** 每台设备最多保留的高危记录条数（审计权威在 T02 的 highrisk-audit.jsonl，此处为近端缓存） */
const HIGHRISK_KEEP_PER_CLIENT = 200;
/** 每台设备最多保留的 pm2 进程快照条数 */
const PM2_PROCESSES_MAX = 100;
/** 每台设备最多保留的 CUPS 打印机快照条数 */
const CUPS_PRINTERS_MAX = 100;

/** 高危记录空模板（sea2 强门禁，设计 §3.3） */
function emptyHighrisk(mid) {
  return {
    recordId: '',
    machineId: mid || '',
    code: '',
    level: 'data',            // data | factory | disk
    confirmWord: '',
    confirmChecked: false,
    totpChecked: false,
    totpOperator: '',
    whitelistChecked: false,
    commandId: '',
    status: 'created',        // created | issued | local-confirmed | done | failed | rejected
    countdownSec: 15,
    issuedAt: 0,
    ackedAt: 0,
    result: null,
    before: null,             // 前后状态快照（缺一不可，P5）
    after: null,
  };
}

function emptySnapshot(mid) {
  return {
    machineId: mid,
    code: '',
    qq: '',
    version: '',
    publicIp: '',
    region: '',
    cpuUsage: 0,
    memUsage: 0,
    bootTime: 0,
    clientTs: 0,
    lastHeartbeatAt: 0,
    online: false,
    status: 'normal',
    license: null,
    // —— v1.0 集群运维增强新增（设计 §3.2）——
    // 零迁移：_normalizeClient 用 Object.assign(emptySnapshot(mid), c.snapshot) 自动补默认值
    reason: '',            // 最近一次授权校验的原始 reason（修 F4：此前只写 history[0]）
    valid: false,          // 最近一次授权校验结论
    licenseState: '',      // 由 reason 派生并冻结，避免列表每次重算
    licenseCheckedAt: 0,   // 授权校验时刻（Unix 秒）
    platform: '',          // 客户端早已上报，服务端此前未接（P1-2）
    arch: '',
    hostname: '',
    // —— sea2 商用运维新增（设计 §3.2 心跳 v2；snake_case 心跳 → camelCase 快照）——
    heartbeatProto: 1,     // 心跳协议版本（旧客户端无版本字段 → 1；sea2 → 2）
    commandsProto: 1,      // 指令协议版本（sea2 → 2）
    pm2Processes: [],      // PM2 进程列表快照
    cups: { running: false, printers: [] }, // CUPS 服务状态 + 打印机清单
    loginInfo: { qq: '', nickname: '', avatar: '', remembered: false, loggedIn: false }, // 登录中间页状态
    // —— sea2 商用运维：试用设备标记（设计 §9.4）——
    // 试用设备心跳 code='' + trial:true；试用不进入授权七态（licenseState 恒为 unknown），
    // 用独立布尔表达，便于列表/聚合/详情直接消费。
    isTrial: false,        // 是否为试用设备（未绑定正式授权码）
    trialInfo: null,       // 试用状态详情 {active, expired, remaining_ms, end}（客户端上报原样落库）
  };
}

/** 归一化客户端上报的打印机字段（兼容 paper_level / ink_level / last_print_at 与 camelCase） */
function normalizePrinter(p) {
  if (!p || typeof p !== 'object') return null;
  const paperLevel = (typeof p.paperLevel === 'number') ? p.paperLevel
    : (typeof p.paper_level === 'number') ? p.paper_level : 0;
  const inkLevel = (typeof p.inkLevel === 'number') ? p.inkLevel
    : (typeof p.ink_level === 'number') ? p.ink_level : 0;
  const lastPrintAt = p.lastPrintAt || p.last_print_at || 0;
  const status = p.status || 'online';
  const online = p.online !== false && status !== 'offline' && status !== 'error';
  const name = p.name || p.printerId || '';
  if (!name) return null;
  return {
    printerId: p.printerId || name,
    name,
    status,
    paperLevel,
    inkLevel,
    lastPrintAt,
    online,
  };
}

/** 归一化客户端上报的 PM2 进程（sea2 心跳 v2，pm2_processes[]） */
function normalizePm2Process(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').slice(0, 128);
  if (!name) return null;
  return {
    pm_id: Number.isFinite(p.pm_id) ? p.pm_id : (Number.isFinite(p.pmId) ? p.pmId : 0),
    name,
    status: String(p.status || 'unknown').slice(0, 32),
    restarts: Number.isFinite(p.restarts) ? p.restarts : 0,
    uptime: Number.isFinite(p.uptime) ? p.uptime : 0,
    cpu: Number.isFinite(p.cpu) ? p.cpu : 0,
    mem: Number.isFinite(p.mem) ? p.mem : 0,
  };
}

/** 归一化客户端上报的 CUPS 打印机（sea2 心跳 v2，cups.printers[]） */
function normalizeCupsPrinter(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name || '').slice(0, 128);
  if (!name) return null;
  return {
    name,
    uri: String(p.uri || '').slice(0, 512),
    model: String(p.model || '').slice(0, 256),
    driver: String(p.driver || '').slice(0, 128),
    state: String(p.state || 'idle').slice(0, 32),
    queueCount: Number.isFinite(p.queueCount) ? p.queueCount : (Number.isFinite(p.queue_count) ? p.queue_count : 0),
    default: p.default === true,
    enabled: p.enabled !== false,
  };
}

/** 归一化客户端上报的 CUPS 服务状态（sea2 心跳 v2，cups{}） */
function normalizeCups(cups) {
  if (!cups || typeof cups !== 'object') return { running: false, printers: [] };
  return {
    running: cups.running === true,
    printers: Array.isArray(cups.printers)
      ? cups.printers.map(normalizeCupsPrinter).filter(Boolean).slice(0, CUPS_PRINTERS_MAX)
      : [],
  };
}

/** 归一化客户端上报的登录中间页状态（sea2 心跳 v2，login_info{}） */
function normalizeLoginInfo(li) {
  if (!li || typeof li !== 'object') return { qq: '', nickname: '', avatar: '', remembered: false, loggedIn: false };
  return {
    qq: String(li.qq || '').slice(0, 32),
    nickname: String(li.nickname || '').slice(0, 64),
    avatar: String(li.avatar || '').slice(0, 1024),
    remembered: li.remembered === true,
    loggedIn: li.loggedIn === true,
  };
}

class FleetStore {
  /**
   * @param {string} [dataDir] 数据目录（默认 activation-server/data）
   */
  constructor(dataDir) {
    this.dataDir = dataDir || DEFAULT_DATA_DIR;
    this.file = path.join(this.dataDir, 'fleet.json');
    this.clients = new Map();
    this.blacklist = new Map();      // machineId -> BlacklistEntry
    this.anomalies = new Map();      // id -> Anomaly
    this.ignored = new Map();        // id -> true
    this._flushMs = DEFAULT_FLUSH_MS;
    this._flushTimer = null;
    this._dirty = false;
    this._hydrate();
  }

  setFlushMs(ms) {
    this._flushMs = Number(ms) || DEFAULT_FLUSH_MS;
  }

  // ---------------- 持久化 ----------------
  _hydrate() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const o = JSON.parse(raw);
      const clients = o.clients || {};
      for (const mid of Object.keys(clients)) {
        this.clients.set(mid, this._normalizeClient(mid, clients[mid]));
      }
      const bl = o.blacklist || {};
      for (const mid of Object.keys(bl)) this.blacklist.set(mid, bl[mid]);
      const an = o.anomalies || {};
      for (const id of Object.keys(an)) this.anomalies.set(id, an[id]);
      const ig = o.ignored || {};
      for (const id of Object.keys(ig)) if (ig[id]) this.ignored.set(id, true);
    } catch (e) {
      // 无文件 / 损坏：以空状态启动（首次运行正常）
    }
  }

  _normalizeClient(mid, c) {
    c = c || {};
    return {
      machineId: mid,
      snapshot: Object.assign(emptySnapshot(mid), c.snapshot || {}),
      history: Array.isArray(c.history) ? c.history : [],
      printers: (Array.isArray(c.printers) ? c.printers : []).map(normalizePrinter).filter(Boolean),
      commands: Array.isArray(c.commands) ? c.commands : [],
      anomalies: Array.isArray(c.anomalies) ? c.anomalies : [],
      // —— sea2 商用运维：强门禁记录表（设计 §3.3，近端缓存；权威在 T02 auditStore）——
      highrisk: Array.isArray(c.highrisk) ? c.highrisk : [],
      // [T2 P2-12] 机器身份唯一性（镜像/克隆/备份恢复/多客户端共数据目录的识别依据）：
      //   first* = 首次上报基线；last* = 最近一次上报；risks = open 风险；resolvedRisks = 已处置；
      //   decisions = 人工合并决策历史（L3）。零迁移：旧记录经 Object.assign 自动补默认值。
      identity: Object.assign({
        firstPublicIp: '',
        firstHostname: '',
        lastPublicIp: '',
        lastHostname: '',
        risks: [],
        resolvedRisks: [],
        decisions: [],
      }, c.identity || {}),
    };
  }

  _toJSON() {
    const clients = {};
    for (const [mid, rec] of this.clients) clients[mid] = rec;
    const blacklist = {};
    for (const [mid, b] of this.blacklist) blacklist[mid] = b;
    const anomalies = {};
    for (const [id, a] of this.anomalies) anomalies[id] = a;
    const ignored = {};
    for (const [id, v] of this.ignored) ignored[id] = v;
    return { clients, blacklist, anomalies, ignored };
  }

  /** 原子写：先写临时文件再 rename，避免半写损坏 */
  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._toJSON()));
      fs.renameSync(tmp, this.file); // 原子替换
      this._dirty = false;
    } catch (e) {
      // best-effort：落盘失败绝不影响主流程
    }
  }

  /** debounce 落盘：高频心跳写仅标记脏，定时器批量落盘 */
  _scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return; // 已在等待
    const ms = Math.max(200, this._flushMs);
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, ms);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  // ---------------- 心跳记录 ----------------
  /**
   * 记录一次心跳（富化字段 + 打印机）。
   * @param {string} mid 机器码
   * @param {object} info 字段集合：{ code, qq, online, version, publicIp, region,
   *   cpuUsage, memUsage, bootTime, clientTs, valid, reason, licenseState, nonce,
   *   license, printers, platform, arch, hostname, isTrial, trialInfo }
   *   （sea2 试用：isTrial 布尔 + trialInfo 对象，见设计 §9.4）
   */
  recordHeartbeat(mid, info) {
    info = info || {};
    const now = Math.floor(Date.now() / 1000);
    let rec = this.clients.get(mid);
    if (!rec) {
      rec = this._normalizeClient(mid, {});
      this.clients.set(mid, rec);
    }
    const snap = rec.snapshot;
    snap.machineId = mid;
    if (info.code) snap.code = info.code;
    if (info.qq !== undefined && info.qq !== '') snap.qq = info.qq;
    if (info.online !== undefined) snap.online = !!info.online;
    if (info.version) snap.version = String(info.version);
    if (info.publicIp) snap.publicIp = info.publicIp;
    if (info.region !== undefined) snap.region = info.region || '';
    if (typeof info.cpuUsage === 'number') snap.cpuUsage = info.cpuUsage;
    if (typeof info.memUsage === 'number') snap.memUsage = info.memUsage;
    if (info.bootTime) snap.bootTime = info.bootTime;
    if (info.clientTs) snap.clientTs = info.clientTs;
    snap.lastHeartbeatAt = now;
    if (info.license) snap.license = info.license;

    // —— 修 F4：授权结论同步写入快照，不再只躺在 history[0] ——
    // 列表页「原因/授权」列此前全为 `—`，根因即在此。
    if (info.reason !== undefined) snap.reason = String(info.reason || '');
    if (info.valid !== undefined) snap.valid = !!info.valid;
    if (info.licenseState !== undefined) snap.licenseState = String(info.licenseState || '');
    // 只要本次心跳跑过授权判定（reason 有值），就刷新校验时刻
    if (info.reason !== undefined) snap.licenseCheckedAt = now;

    // —— P1-2：客户端早已上报却被丢弃的三个字段 ——
    if (info.platform) snap.platform = String(info.platform).slice(0, 32);
    if (info.arch) snap.arch = String(info.arch).slice(0, 32);
    if (info.hostname) snap.hostname = String(info.hostname).slice(0, 128);

    // [T2 P2-12] 机器身份唯一性检测：同 machineId 的 publicIp/hostname 变化 → 记录风险（不静默覆盖）。
    // 放置在快照字段更新之后：既保留「最新值」用于展示，又通过 identity 表留下变化痕迹供审计/人工合并。
    this._recordIdentity(mid, rec, info);

    // —— sea2 心跳 v2：协议版本 + pm2_processes / cups / login_info（snake_case 心跳 → camelCase 快照）——
    // 旧客户端不携带版本字段 → 保持默认 1，兼容 v1 判定；显式 0 视为缺省。
    if (info.heartbeatProto !== undefined && info.heartbeatProto !== null) {
      snap.heartbeatProto = Number(info.heartbeatProto) || 1;
    }
    if (info.commandsProto !== undefined && info.commandsProto !== null) {
      snap.commandsProto = Number(info.commandsProto) || 1;
    }
    const pm2Raw = Array.isArray(info.pm2Processes) ? info.pm2Processes
      : (Array.isArray(info.pm2_processes) ? info.pm2_processes : null);
    if (pm2Raw) snap.pm2Processes = pm2Raw.map(normalizePm2Process).filter(Boolean).slice(0, PM2_PROCESSES_MAX);
    if (info.cups !== undefined && info.cups !== null) snap.cups = normalizeCups(info.cups);
    const loginRaw = info.loginInfo !== undefined && info.loginInfo !== null ? info.loginInfo
      : (info.login_info !== undefined && info.login_info !== null ? info.login_info : null);
    if (loginRaw !== null) snap.loginInfo = normalizeLoginInfo(loginRaw);

    // —— sea2 商用运维：试用标记落库（设计 §9.4）——
    // 调用方（server.js /api/heartbeat）负责把客户端心跳的 trial / trial_info 翻译为
    // camelCase 的 isTrial / trialInfo 传入；此处只落库，不改既有字段语义。
    if (info.isTrial !== undefined) snap.isTrial = !!info.isTrial;
    if (info.trialInfo !== undefined && info.trialInfo !== null) {
      snap.trialInfo = (typeof info.trialInfo === 'object') ? Object.assign({}, info.trialInfo) : info.trialInfo;
    }

    rec.history.unshift({
      at: now,
      code: info.code || snap.code,
      valid: !!info.valid,
      reason: info.reason || 'ok',
      nonce: info.nonce || null,
    });
    rec.history = rec.history.slice(0, 50);

    if (Array.isArray(info.printers)) {
      const ps = info.printers.map(normalizePrinter).filter(Boolean);
      if (ps.length) rec.printers = ps;
    }
    this._scheduleFlush();
    return rec;
  }

  /**
   * [T2 P2-12] 机器身份唯一性检测（recordHeartbeat 内部调用）。
   *
   * 场景：镜像/克隆/备份恢复/多客户端共数据目录 → 同一 machineId 出现不同 lastPublicIp/hostname。
   * 策略：
   *  - 首次上报：建立基线（firstPublicIp/firstHostname），不产生风险；
   *  - 后续上报：lastPublicIp / lastHostname 与本次不同 → 追加 open 风险条目（不覆盖原记录，
   *    历史痕迹全部保留在 identity.risks），并把本次值更新为 last*（快照仍展示最新值）；
   *  - 每个变化只记录一条风险（下次同值不再重复追加）；
   *  - 风险事件同时 best-effort 写入 ops-audit-machine.jsonl（auditStore.logMachine）。
   *
   * @param {string} mid 机器码
   * @param {object} rec 客户端记录（含 identity）
   * @param {object} info 本次心跳字段（publicIp / hostname）
   * @returns {object|null} 新产生的风险条目；无变化返回 null
   * @private
   */
  _recordIdentity(mid, rec, info) {
    if (!rec.identity) {
      rec.identity = {
        firstPublicIp: '', firstHostname: '', lastPublicIp: '', lastHostname: '',
        risks: [], resolvedRisks: [], decisions: [],
      };
    }
    const ident = rec.identity;
    const now = Math.floor(Date.now() / 1000);
    const ip = info.publicIp ? String(info.publicIp).slice(0, 64) : '';
    const hn = info.hostname ? String(info.hostname).slice(0, 128) : '';

    // 首次上报：只建基线，不判风险
    const firstTime = !ident.firstPublicIp && !ident.firstHostname;
    if (firstTime) {
      if (ip) ident.firstPublicIp = ip;
      if (hn) ident.firstHostname = hn;
      ident.lastPublicIp = ip || ident.lastPublicIp;
      ident.lastHostname = hn || ident.lastHostname;
      return null;
    }

    const changes = [];
    if (ip && ident.lastPublicIp && ident.lastPublicIp !== ip) {
      changes.push({ field: 'publicIp', from: ident.lastPublicIp, to: ip });
    }
    if (hn && ident.lastHostname && ident.lastHostname !== hn) {
      changes.push({ field: 'hostname', from: ident.lastHostname, to: hn });
    }
    if (ip) ident.lastPublicIp = ip;
    if (hn) ident.lastHostname = hn;
    if (!changes.length) return null;

    const risk = {
      riskId: genRiskId(now),
      at: now,
      fields: changes.map((c) => c.field),
      from: changes.map((c) => c.from).join('|'),
      to: changes.map((c) => c.to).join('|'),
      detail: changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join('；'),
      status: 'open',
      decision: '',
      resolvedAt: 0,
      resolvedBy: '',
    };
    ident.risks.push(risk);
    // 防膨胀：单机最多保留最近 20 条 open 风险
    ident.risks = ident.risks.slice(-20);
    this._scheduleFlush();

    // best-effort 写机器身份审计（失败绝不影响心跳主流程）
    try {
      const auditStore = require('./ops/auditStore');
      auditStore.logMachine({
        operator: 'system',
        action: 'identity-risk',
        machineId: mid,
        field: changes.map((c) => c.field).join(','),
        from: risk.from,
        to: risk.to,
        detail: risk.detail,
        ok: true,
      });
    } catch (e) { /* ignore */ }

    return risk;
  }

  /**
   * [T2 P2-12] 人工合并决策（仅 L3 调用，经 consoleApi 路由）。
   *  - decision='same-device'  ：确认同一台设备（保留主记录），把 open 风险归档为已处置；
   *  - decision='force-rebind' ：标记为不同设备（强制改绑），以当前特征为新基线，清空 open 风险。
   * 审计由调用方（consoleApi）负责写 machine + op 两类记录；此处只落状态。
   *
   * @param {string} mid 机器码
   * @param {string} decision 'same-device' | 'force-rebind'
   * @param {string} operator 操作人（QQ / super / lan）
   * @returns {{resolved:number, mergeRisk:boolean}|null} null = 客户端不存在
   */
  resolveIdentityRisks(mid, decision, operator) {
    const rec = this.clients.get(mid);
    if (!rec) return null;
    if (!rec.identity) {
      rec.identity = {
        firstPublicIp: '', firstHostname: '', lastPublicIp: '', lastHostname: '',
        risks: [], resolvedRisks: [], decisions: [],
      };
    }
    const ident = rec.identity;
    const now = Math.floor(Date.now() / 1000);
    const open = Array.isArray(ident.risks) ? ident.risks.filter((r) => r.status === 'open') : [];
    const decisionStr = decision === 'force-rebind' ? 'force-rebind' : 'same-device';

    if (decisionStr === 'force-rebind') {
      // 标记为不同设备：以当前特征为新基线（原 first* 视为已废弃）
      ident.firstPublicIp = ident.lastPublicIp;
      ident.firstHostname = ident.lastHostname;
    }
    for (const r of open) {
      r.status = 'resolved';
      r.decision = decisionStr;
      r.resolvedAt = now;
      r.resolvedBy = operator || 'unknown';
      ident.resolvedRisks.push(r);
    }
    // risks 表只保留仍 open 的风险（已处置的已迁入 resolvedRisks）
    ident.risks = Array.isArray(ident.risks) ? ident.risks.filter((r) => r.status === 'open') : [];
    ident.decisions.push({ decision: decisionStr, operator: operator || 'unknown', at: now, count: open.length });
    ident.decisions = ident.decisions.slice(-20);
    this._scheduleFlush();
    return { resolved: open.length, mergeRisk: (ident.risks || []).length > 0 };
  }

  getClient(mid) {
    return this.clients.get(mid) || null;
  }

  /**
   * [T1-P1-8] 服务端签发授权后立即刷新该机快照的授权语义（试用→激活即时转换）。
   *
   * 背景：授权管理页读 store（codes/licenses），集群页读 fleet 快照；此前签发路径
   * （/api/order/issue、console grant）只写 store，fleet 快照要等客户端下一次正式心跳
   * 才把 isTrial 翻 false → 集群页长期显示「试用中」。本方法在签发成功钩子中调用，
   * 立即把 snapshot 的授权态更新为已激活。
   *
   * 注意：**不写 lastHeartbeatAt、不写 history**——这不是一次真实心跳，不能伪造
   * 在线/时间线数据；连接性仍由客户端下次心跳校正。
   *
   * @param {string} mid 机器码
   * @param {object} fields { code?, qq?, license?, reason?, valid?, licenseState?, isTrial?, trialInfo?, licenseCheckedAt? }
   * @returns {boolean} 是否命中该机快照并更新
   */
  setLicenseState(mid, fields) {
    if (!mid || !this.clients.has(mid)) return false;
    fields = fields || {};
    const snap = this.clients.get(mid).snapshot;
    if (fields.code !== undefined) snap.code = String(fields.code || '');
    if (fields.qq !== undefined) snap.qq = String(fields.qq || '');
    if (fields.license !== undefined && fields.license !== null) snap.license = fields.license;
    if (fields.reason !== undefined) snap.reason = String(fields.reason || '');
    if (fields.valid !== undefined) snap.valid = !!fields.valid;
    if (fields.licenseState !== undefined) snap.licenseState = String(fields.licenseState || '');
    if (fields.isTrial !== undefined) snap.isTrial = !!fields.isTrial;
    if (fields.trialInfo !== undefined) snap.trialInfo = fields.trialInfo || null;
    if (fields.licenseCheckedAt !== undefined) snap.licenseCheckedAt = Number(fields.licenseCheckedAt) || 0;
    this._scheduleFlush();
    return true;
  }

  listClients() {
    return Array.from(this.clients.values());
  }

  // ---------------- 指令队列 ----------------
  /**
   * 下发指令（入队，status='pending'）。
   * @returns {object} Command
   */
  addCommand(mid, cmd) {
    let rec = this.clients.get(mid);
    if (!rec) {
      rec = this._normalizeClient(mid, {});
      this.clients.set(mid, rec);
    }
    const command = Object.assign({
      id: genCommandId(cmd.issuedAt || Math.floor(Date.now() / 1000)),
      action: '',
      payload: {},
      status: 'pending',
      issuedAt: Math.floor(Date.now() / 1000),
      sentAt: 0,
      ackedAt: 0,
      timeoutAt: 0,
      operator: '',
      // —— Command schema v2（设计 §3.3）——
      dangerous: false,        // 下发时冻结，避免事后改契约表导致历史审计漂移
      error: '',               // ok=false 时的错误原文
      result: null,            // 客户端回传的结果体
      resultTruncated: false,  // 结果体超 64KB 被截断
      resultBytes: 0,          // 结果体原始字节数
      resultEvicted: false,    // 结果体被保留策略驱逐（元数据仍在）
      lateAck: false,          // timeout 之后才到达的迟到回执
    }, cmd || {});
    rec.commands.unshift(command);
    rec.commands = rec.commands.slice(0, 50);
    this._scheduleFlush();
    return command;
  }

  /**
   * 取该机待下发指令（status='pending'），并标记为 'sent'（已交给客户端）。
   * 返回 {id, action, payload, issued_at}。
   */
  getPendingCommands(mid) {
    const rec = this.clients.get(mid);
    if (!rec) return [];
    const now = Math.floor(Date.now() / 1000);
    const out = [];
    for (const c of rec.commands) {
      if (c.status === 'pending') {
        c.status = 'sent';
        c.sentAt = now;
        out.push({ id: c.id, action: c.action, payload: c.payload || {}, issued_at: c.issuedAt });
      }
    }
    if (out.length) this._scheduleFlush();
    return out;
  }

  /**
   * 按 id 定位指令。
   * @param {string} id 指令 id
   * @returns {{rec: object, cmd: object}|null}
   * @private
   */
  _findCommand(id) {
    for (const rec of this.clients.values()) {
      for (const c of rec.commands) {
        if (c.id === id) return { rec, cmd: c };
      }
    }
    return null;
  }

  /**
   * 序列化并按 64KB 截断结果体。
   *
   * 不信任客户端：即便客户端已截断，服务端仍再做一次。
   * 截断后统一存为 `{truncated:true, bytes, text}` 形态，避免下游拿到半截 JSON 解析崩溃。
   *
   * @param {*} result 客户端回传的原始 result
   * @returns {{value: *, bytes: number, truncated: boolean}}
   * @private
   */
  _normalizeResult(result) {
    if (result === undefined || result === null) {
      return { value: null, bytes: 0, truncated: false };
    }
    let text = '';
    try {
      text = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
      // 循环引用等不可序列化的输入：降级为字符串描述，绝不抛出
      text = String(result);
    }
    if (text === undefined || text === null) text = '';

    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= RESULT_MAX_BYTES) {
      return { value: result, bytes, truncated: false };
    }
    // 按字节安全截断（Buffer.slice 可能截断多字节字符，toString 会产出替换符，可接受）
    const cut = Buffer.from(text, 'utf8').slice(0, RESULT_MAX_BYTES).toString('utf8');
    return { value: { truncated: true, bytes, text: cut }, bytes, truncated: true };
  }

  /**
   * 客户端回执：写入执行结果并推进状态机（幂等）。
   *
   * 状态机（设计 §3.3）：
   *   ok:true                        → acked
   *   ok:false, error='unsupported'  → unsupported
   *   ok:false, error='unknown-action' → unsupported
   *   ok:false, 其他 error           → failed
   *
   * 幂等规则：
   *   1. 已处于 acked/failed/unsupported 的指令，不再被任何回执改写；
   *   2. timeout 为准终态，允许被迟到回执覆盖并置 lateAck:true
   *      （真实场景：设备离线 3 天后上线，指令排队执行）。
   *
   * @param {string} id 指令 id
   * @param {{ok: boolean, error?: string, result?: *}} outcome 执行结果
   * @returns {boolean} 是否实际改写了状态
   */
  markResult(id, outcome) {
    if (!id) return false;
    const hit = this._findCommand(String(id));
    if (!hit) return false;

    const { rec, cmd } = hit;
    // 规则 1：终态不可改写
    if (CMD_TERMINAL.indexOf(cmd.status) >= 0) return false;

    const o = outcome || {};
    const ok = !!o.ok;
    const error = ok ? '' : String(o.error || 'unknown');
    const wasTimeout = cmd.status === 'timeout';

    if (ok) {
      cmd.status = 'acked';
      cmd.error = '';
    } else if (error === 'unsupported' || error === 'unknown-action') {
      cmd.status = 'unsupported';
      cmd.error = error;
    } else {
      cmd.status = 'failed';
      cmd.error = error.slice(0, 2000);
    }

    cmd.ackedAt = Math.floor(Date.now() / 1000);
    // 规则 2：迟到回执打标，便于控制台区分「按时回执」与「设备重新上线后补回执」
    if (wasTimeout) cmd.lateAck = true;

    const norm = this._normalizeResult(o.result);
    cmd.result = norm.value;
    cmd.resultBytes = norm.bytes;
    cmd.resultTruncated = norm.truncated;
    if (norm.value !== null) cmd.resultEvicted = false;

    this._pruneResults(rec);
    this._scheduleFlush();
    return true;
  }

  /**
   * 客户端回执（旧通道）：标记指令为 'acked'。
   *
   * 保留为 markResult 的薄封装以兼容只发 `ack_id` 的旧客户端。
   * 调用方须保证在 `ack_results` **之后**处理，否则会把 unsupported 错误地翻成 acked
   * ——markResult 的终态保护已挡住这种情况，此处再次强调调用顺序约定。
   *
   * @param {string} id 指令 id
   * @returns {boolean}
   */
  markAcked(id) {
    return this.markResult(id, { ok: true });
  }

  /**
   * 单机结果体保留策略：只保留最近 10 条带 result 的指令。
   *
   * 第 11 条起把 result 置 null 并打 `resultEvicted:true`——
   * **保留指令元数据与状态，只丢结果体**，既避免 fleet.json 膨胀，也避免历史断档。
   *
   * @param {object} rec 客户端记录
   * @private
   */
  _pruneResults(rec) {
    if (!rec || !Array.isArray(rec.commands)) return;
    let kept = 0;
    // commands 按 unshift 维护，天然从新到旧
    for (const c of rec.commands) {
      if (c.result === null || c.result === undefined) continue;
      kept++;
      if (kept > RESULT_KEEP_PER_CLIENT) {
        c.result = null;
        c.resultEvicted = true;
      }
    }
  }

  /**
   * 全局结果体保留策略：带 result 的指令总量上限 2000 条。
   *
   * 超出时按 ackedAt 最旧优先驱逐 result 体。由 timeoutScan 顺带调用，
   * 不额外起定时器。默认量级（<50 台设备）下不会触发，可视为保险丝。
   *
   * @returns {number} 被驱逐的结果体数量
   * @private
   */
  _pruneGlobalResults() {
    const withResult = [];
    for (const rec of this.clients.values()) {
      for (const c of rec.commands) {
        if (c.result !== null && c.result !== undefined) withResult.push(c);
      }
    }
    if (withResult.length <= RESULT_KEEP_GLOBAL) return 0;

    // 最旧优先：ackedAt 升序（未回执的用 issuedAt 兜底）
    withResult.sort((a, b) => (a.ackedAt || a.issuedAt || 0) - (b.ackedAt || b.issuedAt || 0));
    const evictCount = withResult.length - RESULT_KEEP_GLOBAL;
    for (let i = 0; i < evictCount; i++) {
      withResult[i].result = null;
      withResult[i].resultEvicted = true;
    }
    return evictCount;
  }

  /** 指令历史（用于 API 展示） */
  listCommands(mid) {
    const rec = this.clients.get(mid);
    return rec ? rec.commands.slice() : [];
  }

  /**
   * 超时扫描：pending/sent 且超 timeoutAt → 'timeout'。
   * 顺带执行全局结果体保留策略（零额外定时器）。
   */
  timeoutScan(now) {
    now = now || Math.floor(Date.now() / 1000);
    let changed = 0;
    for (const rec of this.clients.values()) {
      for (const c of rec.commands) {
        if ((c.status === 'pending' || c.status === 'sent') && c.timeoutAt && now > c.timeoutAt) {
          c.status = 'timeout';
          changed++;
        }
      }
    }
    const evicted = this._pruneGlobalResults();
    if (changed || evicted) this._scheduleFlush();
    return changed;
  }

  // ---------------- 高危记录表（sea2 强门禁，设计 §3.3）----------------
  /**
   * 新增一条高危操作记录（强门禁引擎签发，status='created'/'issued'）。
   * 幂等：传入 recordId 且已存在 → 直接返回既有记录（不重复入表）。
   *
   * @param {string} mid 机器码
   * @param {object} record 记录字段（见 emptyHighrisk；缺省字段自动补默认值）
   * @returns {object} 高危记录
   */
  addHighrisk(mid, record) {
    if (!mid) return null;
    let rec = this.clients.get(mid);
    if (!rec) {
      rec = this._normalizeClient(mid, {});
      this.clients.set(mid, rec);
    }
    const now = Math.floor(Date.now() / 1000);
    const hr = Object.assign(emptyHighrisk(mid), record || {});
    hr.machineId = mid;
    if (!hr.recordId) hr.recordId = genHighriskId(hr.issuedAt || now);
    if (!hr.issuedAt) hr.issuedAt = now;
    if (HIGHRISK_STATUS.indexOf(hr.status) < 0) hr.status = 'created';
    // 幂等：同 recordId 不重复入表
    const exist = (rec.highrisk || []).find((x) => x.recordId === hr.recordId);
    if (exist) return exist;
    rec.highrisk.unshift(hr);
    rec.highrisk = rec.highrisk.slice(0, HIGHRISK_KEEP_PER_CLIENT);
    this._scheduleFlush();
    return hr;
  }

  /**
   * 推进一条高危记录（状态机推进 / 回执结果落库）。
   * 状态机（设计 §3.3）：created → issued → local-confirmed → done/failed/rejected；
   * 只允许向前推进，终态（done/failed/rejected）不可再改写。
   *
   * @param {string} recordId 高危记录 id
   * @param {object} patch 推进字段：{ status, ackedAt, result, before, after }
   * @returns {boolean} 是否实际改写
   */
  advanceHighrisk(recordId, patch) {
    if (!recordId) return false;
    patch = patch || {};
    for (const rec of this.clients.values()) {
      const hr = (rec.highrisk || []).find((x) => x.recordId === String(recordId));
      if (!hr) continue;
      const cur = hr.status;
      if (['done', 'failed', 'rejected'].indexOf(cur) >= 0) return false; // 终态不可改写
      if (patch.status) {
        if (HIGHRISK_STATUS.indexOf(patch.status) < 0) return false;
        hr.status = patch.status;
      }
      if (patch.commandId !== undefined) hr.commandId = String(patch.commandId);
      if (patch.ackedAt !== undefined) hr.ackedAt = patch.ackedAt;
      if (patch.result !== undefined) hr.result = patch.result;
      if (patch.before !== undefined) hr.before = patch.before;
      if (patch.after !== undefined) hr.after = patch.after;
      this._scheduleFlush();
      return true;
    }
    return false;
  }

  /** 取某机高危记录（API 展示用，从新到旧）。 */
  listHighrisk(mid) {
    const rec = this.clients.get(mid);
    return rec ? (rec.highrisk || []).slice() : [];
  }

  /**
   * 全量高危记录（跨客户端，按 issuedAt 倒序）。
   * @param {object} [filter] { mid?, status? } 可选过滤
   * @returns {Array<object>}
   */
  listAllHighrisk(filter) {
    filter = filter || {};
    let arr = [];
    for (const rec of this.clients.values()) {
      for (const hr of (rec.highrisk || [])) arr.push(hr);
    }
    if (filter.mid) arr = arr.filter((x) => x.machineId === filter.mid);
    if (filter.status) arr = arr.filter((x) => x.status === filter.status);
    arr.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
    return arr;
  }

  // ---------------- 黑名单 ----------------
  addBlacklist(mid, reason, by) {
    if (!mid) return;
    this.blacklist.set(mid, {
      machineId: mid,
      reason: reason || 'manual',
      at: Math.floor(Date.now() / 1000),
      by: by || 'unknown',
    });
    this._recomputeClientAnomalies();
    this.flush(); // 即时生效：强制落盘
  }

  isBlacklisted(mid) {
    return this.blacklist.has(mid);
  }

  listBlacklist() {
    return Array.from(this.blacklist.values());
  }

  // ---------------- 异常缓存 ----------------
  /**
   * 写入异常扫描结果（去重缓存）。
   *  - 当前检测到的：新建为 open（首次）；已有则继承 status/disposition/firstSeen。
   *  - 不再被检测到的 open 异常：标记 resolved（自愈）。
   *  - ignored 集合中的：保持 ignored。
   */
  setAnomalies(list) {
    const detected = list || [];
    const detectedIds = new Set(detected.map((a) => a.id));
    const now = Math.floor(Date.now() / 1000);
    for (const a of detected) {
      const prev = this.anomalies.get(a.id);
      a.lastSeen = now;
      if (!prev) {
        a.firstSeen = a.firstSeen || now;
        a.status = this.ignored.has(a.id) ? 'ignored' : 'open';
      } else {
        if (prev.status === 'ignored') a.status = 'ignored';
        else if (prev.status === 'resolved') a.status = 'resolved';
        else a.status = 'open';
        a.firstSeen = prev.firstSeen || a.firstSeen || now;
        a.disposition = prev.disposition || a.disposition;
      }
      this.anomalies.set(a.id, a);
    }
    for (const [id, a] of this.anomalies) {
      if (!detectedIds.has(id) && a.status === 'open') {
        a.status = 'resolved';
        a.disposition = a.disposition || 'auto-resolved';
      }
    }
    this._recomputeClientAnomalies();
    this._scheduleFlush();
  }

  /** 处置后更新异常状态（revoke/blacklist/ignore 调用） */
  setAnomalyStatus(id, status, disposition) {
    const a = this.anomalies.get(id);
    if (!a) return false;
    a.status = status;
    if (disposition) a.disposition = disposition;
    this._recomputeClientAnomalies();
    this._scheduleFlush();
    return true;
  }

  ignoreAnomaly(id) {
    this.ignored.set(id, true);
    const a = this.anomalies.get(id);
    if (a) { a.status = 'ignored'; a.disposition = 'ignore'; }
    this._recomputeClientAnomalies();
    this.flush(); // 持久化 ignored
  }

  getAnomaly(id) {
    return this.anomalies.get(id) || null;
  }

  listAnomalies(filter) {
    filter = filter || {};
    let arr = Array.from(this.anomalies.values());
    if (filter.rule) arr = arr.filter((a) => a.rule === filter.rule);
    if (filter.severity) arr = arr.filter((a) => a.severity === filter.severity);
    if (filter.status) arr = arr.filter((a) => a.status === filter.status);
    if (filter.q) {
      const q = String(filter.q).toLowerCase();
      arr = arr.filter((a) =>
        (a.machineId || '').toLowerCase().includes(q) ||
        (a.code || '').toLowerCase().includes(q) ||
        (a.detail || '').toLowerCase().includes(q));
    }
    return arr;
  }

  listRules() {
    const set = new Set();
    for (const a of this.anomalies.values()) set.add(a.rule);
    return Array.from(set);
  }

  /** 把 open 异常回挂到各客户端（用于 status 派生与详情展示） */
  _recomputeClientAnomalies() {
    for (const rec of this.clients.values()) rec.anomalies = [];
    for (const [id, a] of this.anomalies) {
      if (a.status === 'open' && a.machineId) {
        const rec = this.clients.get(a.machineId);
        if (rec && !rec.anomalies.includes(id)) rec.anomalies.push(id);
      }
    }
  }

  /** 关闭（进程退出前可调用，强制落盘脏数据） */
  close() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._dirty) this.flush();
  }
}

// ---------------- 单例（跨模块共享同一内存索引）----------------
let _instance = null;
/**
 * 获取（惰性创建）全局单例。server.start 会用正确的 dataDir 调用一次。
 * @param {string} [dataDir] 若提供且与当前不同，则重绑定（重新 hydrate）。
 */
function getInstance(dataDir) {
  if (!_instance) {
    _instance = new FleetStore(dataDir);
  } else if (dataDir && _instance.dataDir !== dataDir) {
    _instance.dataDir = dataDir;
    _instance.file = path.join(dataDir, 'fleet.json');
    _instance._hydrate();
  }
  return _instance;
}

module.exports = {
  FleetStore,
  getInstance,
  genCommandId,
  genHighriskId,
  genRiskId,
  anomalyId,
  emptySnapshot,
  emptyHighrisk,
  normalizePrinter,
  normalizePm2Process,
  normalizeCups,
  normalizeLoginInfo,
  // 限额常量（供 fleet.buildMeta 与测试引用，避免各处重复硬编码）
  RESULT_MAX_BYTES,
  RESULT_KEEP_PER_CLIENT,
  RESULT_KEEP_GLOBAL,
  CMD_TERMINAL,
  // sea2 高危记录表常量
  HIGHRISK_STATUS,
  HIGHRISK_KEEP_PER_CLIENT,
};
