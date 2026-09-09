'use strict';
/**
 * lib/fleet.js — 外网客户端集群（fleet）业务逻辑
 *
 * 纯函数 + 依赖注入（fleetStore 实例 / store / cfg），不持有状态。
 * 状态派生、列表筛选/搜索/聚合、详情、跨客户端打印机聚合、指令下发/历史/超时扫描。
 *
 * 【v1.0 集群运维增强】正交状态模型（设计文档 §1.3 M1）：
 *   connectivity ∈ {online, stale, offline, unreported}   只看心跳新鲜度
 *   licenseState ∈ {valid, invalid, expired, mismatch, revoked, no-record, unknown}  只看授权
 *   status = blacklisted > abnormal > connectivity        兼容旧前端 + 置顶告警
 * 二者正交：设备可以「在线但未授权」，此前被单一 status 耦合掩盖（PRD F1）。
 */

const fleetStore = require('./fleetStore');
const fleetConfig = require('./fleetConfig');
const fleetCommands = require('./fleetCommands');
const fleetReason = require('./fleetReason');
// [R4] 轻量 IP 归属段表（零外部依赖）：publicIp → 省+市，未命中回退心跳自报 region
const geoip = require('./geoip-lite');

/**
 * 允许的指令类型。
 * 【契约转出】名单唯一事实来源为 lib/fleetCommands.js，此处仅转出以保持既有导出签名不变。
 */
const COMMANDS = fleetCommands.COMMANDS;
/** 危险指令（额外审计 dangerous:true）。同样转出自 fleetCommands。 */
const DANGEROUS = fleetCommands.DANGEROUS;

/** 分布条 Top N（超出部分归并为「其他」） */
const DIST_TOP_N = 5;

// [R4] 授权类型中文名（listClients 授权列：永久/月卡/季卡/年卡；试用/未授权单独判定）
const PLAN_NAME_MAP = { month: '月卡', quarter: '季卡', year: '年卡', lifetime: '永久' };

/** 从异常 id（rule:mid）解析出 machineId */
function midFromAnomalyId(id) {
  const i = String(id).indexOf(':');
  return i >= 0 ? id.substring(i + 1) : id;
}

/**
 * 派生连接性（只看心跳新鲜度，与授权无关）。
 *
 * 三档判定（设计 §1.3 M1）：
 *   lastHeartbeatAt === 0                    → unreported（从未上报）
 *   now - last <= 2×fleetHeartbeatInterval   → online
 *   now - last <= fleetStaleMinutes×60       → stale（掉线，短时失联）
 *   否则                                      → offline
 *
 * 注意：`fleetOfflineDays` **不再参与列表状态判定**，它仅供 anomaly.js 的
 * `ruleLongOffline`（long_offline 异常规则）使用。改判定阈值请改 fleetStaleMinutes。
 *
 * @param {Object} record 客户端记录
 * @param {Object} cfg fleetConfig.load() 结果
 * @param {number} now Unix 秒
 * @returns {string} connectivity 枚举值
 */
function deriveConnectivity(record, cfg, now) {
  const last = (record && record.snapshot && record.snapshot.lastHeartbeatAt) || 0;
  if (last <= 0) return 'unreported';

  const interval = cfg.fleetHeartbeatInterval || 60;
  const onlineSec = 2 * interval;
  // 防配置倒挂：staleSec 至少比 onlineSec 大 1 秒，避免 stale 档位被吃掉
  const staleSec = Math.max(onlineSec + 1, (cfg.fleetStaleMinutes || 30) * 60);

  const age = now - last;
  if (age <= onlineSec) return 'online';
  if (age <= staleSec) return 'stale';
  return 'offline';
}

/**
 * 派生授权状态（只看授权，与连接性无关）。
 *
 * 数据来源优先级：
 *   1. snapshot.licenseState —— 心跳时由服务端算好并冻结（P0-1，避免列表每次重算）
 *   2. snapshot.reason       —— 兼容刚升级、licenseState 尚未回填的存量数据
 *   3. history[0].reason     —— 兼容升级前只写 history 的老数据（F4 修复前的形态）
 *   4. 'unknown'             —— 从未上报
 *
 * @param {Object} record 客户端记录
 * @returns {string} licenseState 枚举值
 */
function deriveLicenseState(record) {
  const snap = (record && record.snapshot) || {};
  if (snap.licenseState) return snap.licenseState;
  if (snap.reason) return fleetReason.toLicenseState(snap.reason);

  const h0 = record && record.history && record.history[0];
  if (h0 && h0.reason) return fleetReason.toLicenseState(h0.reason);
  return 'unknown';
}

/**
 * 取当前生效的 raw reason（与 deriveLicenseState 同源，供 UI 悬浮显示原值）。
 * @param {Object} record 客户端记录
 * @returns {string} raw reason，未知时为 'unknown'
 */
function deriveReason(record) {
  const snap = (record && record.snapshot) || {};
  if (snap.reason) return snap.reason;
  const h0 = record && record.history && record.history[0];
  if (h0 && h0.reason) return h0.reason;
  return 'unknown';
}

/**
 * 派生顶层状态（兼容旧前端 + 置顶告警）。
 * 优先级：blacklisted > abnormal > connectivity。
 *
 * 与旧实现的差异（修 PRD F1/F2）：
 *   - 不再因「授权无效」把在线设备打成 normal —— 授权维度已独立为 licenseState；
 *   - 不再产生 `normal` 这个语义黑洞值，四态 connectivity 全覆盖。
 *
 * @see system_design_fleet_ops_v1.0.md §1.3 M1
 */
function deriveStatus(fsInst, record, cfg, now) {
  const mid = record.machineId;
  // 1) 黑名单（最高优先级：服务端不再校验授权，也不看心跳）
  if (fsInst.isBlacklisted(mid)) return 'blacklisted';
  // 2) 有 open 异常
  if (record.anomalies && record.anomalies.some((id) => {
    const a = fsInst.getAnomaly(id);
    return a && a.status === 'open';
  })) return 'abnormal';
  // 3) 回落到连接性
  return deriveConnectivity(record, cfg, now);
}

function _enrichQq(store, rec) {
  let qq = rec.snapshot.qq || '';
  if (!qq && rec.snapshot.code) {
    const cr = store.getCode(rec.snapshot.code);
    if (cr && cr.customer) qq = cr.customer;
  }
  return qq;
}

/**
 * 构建 Top N 分布（P1-6），超出部分归并为「其他」。
 * @param {Array<Object>} items 列表项
 * @param {string} key 取值字段名
 * @returns {Array<{key:string, count:number, pct:number}>}
 */
function _buildDistribution(items, key) {
  const total = items.length;
  if (total === 0) return [];

  const counter = new Map();
  for (const item of items) {
    const value = item[key] || '未知';
    counter.set(value, (counter.get(value) || 0) + 1);
  }

  const sorted = Array.from(counter.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, DIST_TOP_N);
  const rest = sorted.slice(DIST_TOP_N);

  const dist = top.map(([k, count]) => ({
    key: k,
    count,
    pct: Math.round((count / total) * 100),
  }));

  if (rest.length > 0) {
    const restCount = rest.reduce((sum, [, count]) => sum + count, 0);
    dist.push({ key: '其他', count: restCount, pct: Math.round((restCount / total) * 100) });
  }
  return dist;
}

/**
 * [T2 P2-12] 派生客户端「唯一性风险」（mergeRisk）。
 *
 * 数据源：fleetStore 心跳时写入的 rec.identity（publicIp/hostname 变化痕迹）。
 * 判定：存在 open 风险条目 → mergeRisk=true；riskReason 汇总最近至多 3 条变化细节。
 * 语义：同一 machineId 出现多来源特征（镜像/克隆/备份恢复/多客户端共数据目录）→ 交人工合并。
 *
 * @param {Object} record 客户端记录
 * @returns {{mergeRisk:boolean, riskReason:string, mergeRiskCount:number}}
 */
function deriveMergeRisk(record) {
  const ident = (record && record.identity) || {};
  const open = Array.isArray(ident.risks) ? ident.risks.filter((r) => r.status === 'open') : [];
  if (!open.length) return { mergeRisk: false, riskReason: '', mergeRiskCount: 0 };
  const parts = open.slice(0, 3).map((r) => r.detail || (Array.isArray(r.fields) ? r.fields.join('+') + ' 变化' : '特征变化'));
  let reason = parts.join('；');
  if (open.length > 3) reason += '…';
  return { mergeRisk: true, riskReason: reason, mergeRiskCount: open.length };
}

/**
 * 客户端列表。
 *
 * 筛选：status（兼容旧书签）/ connectivity / licenseState / version / region
 * 搜索：machine_id / qq / code
 * 聚合：agg（含新增 stale / unreported / blacklisted / onlineLicenseBad / byVersion / byRegion）
 *
 * @returns {{items:Array, total:number, page:number, pageSize:number, agg:object}}
 */
function listClients(fsInst, store, cfg, filter) {
  filter = filter || {};
  const now = Math.floor(Date.now() / 1000);
  // [T03 需求5] includeProcesses=1 时列表项附 pm2Processes（自报快照，含试用设备），
  // 供进程管理「全部设备」聚合直接消费；默认不带，避免无谓的列表体量膨胀（设计 §10.5.2）。
  const includeProcesses = String(filter.includeProcesses || '') === '1';
  // [R4] 预建 code → order 映射（store.listOrders 一次性扫描，避免每行 O(n)）
  const orderByCode = new Map();
  if (store && typeof store.listOrders === 'function') {
    for (const o of store.listOrders() || []) {
      if (o && o.code && !orderByCode.has(o.code)) orderByCode.set(o.code, o);
    }
  }
  let items = [];

  for (const rec of fsInst.clients.values()) {
    const connectivity = deriveConnectivity(rec, cfg, now);
    const licenseState = deriveLicenseState(rec);
    const reason = deriveReason(rec);
    const status = deriveStatus(fsInst, rec, cfg, now);
    const qq = _enrichQq(store, rec);
    const snap = rec.snapshot;
    // [T2 P2-12] 唯一性风险（镜像/克隆/备份恢复的识别依据）
    const mr = deriveMergeRisk(rec);

    // [R4] 授权列：试用优先，其次按 code 反查订单套餐；无 code/无订单 → 未授权
    let planName = '未授权';
    if (snap.isTrial) {
      planName = '试用';
    } else if (snap.code) {
      const order = orderByCode.get(snap.code);
      if (order && order.plan) planName = PLAN_NAME_MAP[order.plan] || String(order.plan);
      else planName = '未授权';
    }

    // [R4] 地域列：publicIp 命中 geoip → 「省+市」（直辖市省=市时只显示一次）；未命中回退心跳自报
    const geo = snap.publicIp ? geoip.lookup(snap.publicIp) : null;
    const region = geo
      ? (geo.province === geo.city ? geo.province : geo.province + geo.city)
      : (snap.region || '');

    let pendingCount = 0;
    let sentCount = 0;
    for (const c of rec.commands) {
      if (c.status === 'pending') pendingCount++;
      else if (c.status === 'sent') sentCount++;
    }

    items.push({
      machineId: rec.machineId,
      code: snap.code,
      qq,
      version: snap.version,
      publicIp: snap.publicIp,
      region,
      cpuUsage: snap.cpuUsage,
      memUsage: snap.memUsage,
      bootTime: snap.bootTime,
      lastHeartbeatAt: snap.lastHeartbeatAt,
      online: snap.online,
      status,
      // —— 本期新增（正交状态模型 + 详情增强）——
      connectivity,
      licenseState,
      reason,
      valid: !!snap.valid,
      licenseCheckedAt: snap.licenseCheckedAt || 0,
      platform: snap.platform || '',
      arch: snap.arch || '',
      hostname: snap.hostname || '',
      // sea2 试用设备标记（设计 §9.4）：试用不进入授权七态，独立布尔供前端徽标/聚合
      isTrial: !!snap.isTrial,
      // [R4] 授权类型（永久/月卡/季卡/年卡/试用/未授权）
      planName,
      // [T03 需求5] 仅 includeProcesses=1 时携带进程快照（设计 §10.5.2 方案 A）
      ...(includeProcesses
        ? { pm2Processes: Array.isArray(snap.pm2Processes) ? snap.pm2Processes : [] }
        : {}),
      pendingCount,
      sentCount,
      blacklisted: fsInst.isBlacklisted(rec.machineId),
      // [T2 P2-12] 唯一性风险字段（前端审计中心「机器身份」分区消费）
      mergeRisk: mr.mergeRisk,
      riskReason: mr.riskReason,
      mergeRiskCount: mr.mergeRiskCount,
      // 兼容字段：旧前端读的是 pendingCommands（pending + sent 合计）
      pendingCommands: pendingCount + sentCount,
    });
  }

  // 筛选（status 与 connectivity 可同时存在，语义为「与」）
  if (filter.status) items = items.filter((x) => x.status === filter.status);
  if (filter.connectivity) items = items.filter((x) => x.connectivity === filter.connectivity);
  if (filter.licenseState) items = items.filter((x) => x.licenseState === filter.licenseState);
  if (filter.version) items = items.filter((x) => x.version === filter.version);
  if (filter.region) items = items.filter((x) => x.region === filter.region);
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    items = items.filter((x) =>
      (x.machineId || '').toLowerCase().includes(q) ||
      (x.qq || '').toLowerCase().includes(q) ||
      (x.code || '').toLowerCase().includes(q));
  }

  // 聚合（旧字段保留，确保旧前端不炸）
  const agg = {
    online: 0,
    offline: 0,
    abnormal: 0,
    total: items.length,
    stale: 0,
    unreported: 0,
    blacklisted: 0,
    trial: 0,               // sea2 试用设备计数（设计 §9.4）
    onlineLicenseBad: 0,
    mergeRisk: 0,           // [T2 P2-12] 唯一性风险设备计数（待人工合并）
    byVersion: [],
    byRegion: [],
  };
  for (const x of items) {
    // connectivity 维度计数（与 status 解耦：拉黑/异常设备的连接性照常统计）
    if (x.connectivity === 'online') agg.online++;
    else if (x.connectivity === 'stale') agg.stale++;
    else if (x.connectivity === 'offline') agg.offline++;
    else if (x.connectivity === 'unreported') agg.unreported++;

    if (x.status === 'abnormal') agg.abnormal++;
    if (x.blacklisted) agg.blacklisted++;
    if (x.isTrial) agg.trial++;
    if (x.mergeRisk) agg.mergeRisk++;
    // P0-1 验收 3：「在线」卡片下方「其中 N 台授权异常」
    if (x.connectivity === 'online' && x.licenseState !== 'valid') agg.onlineLicenseBad++;
  }
  agg.byVersion = _buildDistribution(items, 'version');
  agg.byRegion = _buildDistribution(items, 'region');

  // 排序：最近心跳在前
  items.sort((a, b) => (b.lastHeartbeatAt || 0) - (a.lastHeartbeatAt || 0));

  // 分页
  const page = Math.max(1, parseInt(filter.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(filter.pageSize, 10) || 50));
  const total = items.length;
  const startIdx = (page - 1) * pageSize;
  const paged = items.slice(startIdx, startIdx + pageSize);
  return { items: paged, total, page, pageSize, agg };
}

/**
 * 客户端详情（snapshot + history + printers + license + recent anomalies + commands + derived）。
 */
function clientDetail(fsInst, store, cfg, mid) {
  const rec = fsInst.getClient(mid);
  if (!rec) return null;

  const now = Math.floor(Date.now() / 1000);
  const connectivity = deriveConnectivity(rec, cfg, now);
  const licenseState = deriveLicenseState(rec);
  const reason = deriveReason(rec);
  const status = deriveStatus(fsInst, rec, cfg, now);
  const snap = rec.snapshot;

  // license：优先 store，回退快照
  let license = null;
  if (snap.code) {
    const lr = store.getLicense(snap.code);
    if (lr) license = lr.license;
  }
  if (!license && snap.license) license = snap.license;

  const anomalies = rec.anomalies.map((id) => fsInst.getAnomaly(id)).filter(Boolean);

  let pendingCount = 0;
  let sentCount = 0;
  for (const c of rec.commands) {
    if (c.status === 'pending') pendingCount++;
    else if (c.status === 'sent') sentCount++;
  }

  // 服务端算好派生量，避免前端踩时区/客户端时钟漂移的坑
  const bootTime = snap.bootTime || 0;
  const clientTs = snap.clientTs || 0;
  const lastHb = snap.lastHeartbeatAt || 0;
  const derived = {
    uptimeSec: bootTime > 0 ? Math.max(0, now - bootTime) : 0,
    // 负数 = 客户端时钟超前于服务端，可据此发现时钟漂移
    heartbeatLagSec: lastHb > 0 && clientTs > 0 ? lastHb - clientTs : 0,
    pendingCount,
    sentCount,
    reasonDesc: fleetReason.describe(reason),
  };

  return {
    machineId: mid,
    code: snap.code,
    qq: _enrichQq(store, rec),
    status,
    connectivity,
    licenseState,
    snapshot: Object.assign({}, snap, { status, connectivity, licenseState }),
    derived,
    history: rec.history.slice(),
    printers: rec.printers.slice(),
    license,
    anomalies,
    commands: rec.commands.slice(),
    // —— sea2 商用运维：心跳 v2 快照字段 + 高危记录最近列表（设计 §3.2 / §3.3）——
    pm2Processes: Array.isArray(snap.pm2Processes) ? snap.pm2Processes : [],
    cups: snap.cups && typeof snap.cups === 'object'
      ? snap.cups
      : { running: false, printers: [] },
    loginInfo: snap.loginInfo && typeof snap.loginInfo === 'object'
      ? snap.loginInfo
      : { qq: '', nickname: '', avatar: '', remembered: false, loggedIn: false },
    heartbeatProto: snap.heartbeatProto || 1,
    commandsProto: snap.commandsProto || 1,
    // —— sea2 商用运维：试用标记（设计 §9.4）——
    isTrial: !!snap.isTrial,
    trialInfo: snap.trialInfo && typeof snap.trialInfo === 'object' ? Object.assign({}, snap.trialInfo) : null,
    highrisk: (rec.highrisk || []).slice(0, 50),
    // —— sea2 商用运维：高危记录摘要（T02 确保 API 可消费；权威审计在 auditStore）——
    highriskCount: (rec.highrisk || []).length,
    highriskLast: (rec.highrisk && rec.highrisk.length)
      ? Object.assign({}, rec.highrisk[0])
      : null,
    // [T2 P2-12] 机器身份唯一性详情（open 风险 / 处置历史，供审计中心人工合并）
    identity: rec.identity || { firstPublicIp: '', firstHostname: '', lastPublicIp: '', lastHostname: '', risks: [], resolvedRisks: [], decisions: [] },
    mergeRisk: deriveMergeRisk(rec).mergeRisk,
    riskReason: deriveMergeRisk(rec).riskReason,
  };
}

/**
 * 跨客户端打印机聚合（打上 clientMachineId / clientVersion）。
 */
function listAllPrinters(fsInst, cfg, filter) {
  filter = filter || {};
  // 注意：此处必须为 let —— 下方筛选会整体重新赋值（旧版误用 const，一旦带筛选参数即抛
  // TypeError: Assignment to constant variable，属既有缺陷，本次一并修复）
  let items = [];
  for (const rec of fsInst.clients.values()) {
    const clientMachineId = rec.machineId;
    const clientVersion = rec.snapshot.version;
    for (const p of rec.printers) {
      items.push({
        printerId: p.printerId,
        name: p.name,
        clientMachineId,
        clientVersion,
        status: p.status,
        paperLevel: p.paperLevel,
        inkLevel: p.inkLevel,
        lastPrintAt: p.lastPrintAt,
        online: p.online,
      });
    }
  }
  if (filter.status) items = items.filter((x) => x.status === filter.status);
  if (filter.client) items = items.filter((x) => x.clientMachineId === filter.client);
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    items = items.filter((x) =>
      (x.name || '').toLowerCase().includes(q) ||
      (x.printerId || '').toLowerCase().includes(q) ||
      (x.clientMachineId || '').toLowerCase().includes(q));
  }
  return { items };
}

/**
 * 下发指令（入队，status='pending'）。
 *
 * 载荷经 fleetCommands.validatePayload 校验并净化（只保留 schema 声明的键）。
 * `dangerous` 在下发时冻结进指令对象，避免事后改契约表导致历史审计漂移。
 *
 * @returns {{ok:boolean, command?:object, commandId?:string, action?:string,
 *            cmdStatus?:string, dangerous?:boolean, timeoutAt?:number,
 *            error?:string, status?:number}}
 */
function issueCommand(fsInst, mid, action, payload, operator) {
  const spec = fleetCommands.get(action);
  if (!spec) {
    return { ok: false, error: '未知指令类型: ' + action, status: 400 };
  }

  const checked = fleetCommands.validatePayload(action, payload);
  if (!checked.ok) {
    return { ok: false, error: checked.error, status: 400 };
  }

  const now = Math.floor(Date.now() / 1000);
  const cfg = fleetConfig.load();
  const interval = cfg.fleetHeartbeatInterval || 60;
  const issuedAt = now;
  const cmd = {
    id: fleetStore.genCommandId(issuedAt),
    action,
    payload: checked.payload,
    status: 'pending',
    issuedAt,
    sentAt: 0,
    ackedAt: 0,
    timeoutAt: issuedAt + 2 * interval, // 超时 = 2×心跳间隔
    operator: operator || '',
    dangerous: !!spec.dangerous,
    error: '',
    result: null,
    resultTruncated: false,
    resultBytes: 0,
    resultEvicted: false,
    lateAck: false,
  };
  fsInst.addCommand(mid, cmd);
  return {
    ok: true,
    command: cmd,
    commandId: cmd.id,
    action,
    // 注意：'pending' 是**指令状态**。旧版把它塞在 `status` 字段里，与 HTTP 错误码字段
    // 同名（失败分支的 status:400），语义冲突。此处新增 cmdStatus 承载真实语义，
    // 同时保留 status 以兼容既有前端。
    cmdStatus: 'pending',
    status: 'pending',
    dangerous: !!spec.dangerous,
    timeoutAt: cmd.timeoutAt,
  };
}

/**
 * 构建控制台元数据（指令契约 / reason 字典 / 连接性字典 / 阈值）。
 * 供 `GET /api/admin/fleet/meta` 下发，前端据此驱动指令面板与徽标，零硬编码。
 *
 * @param {Object} cfg fleetConfig.load() 结果
 * @returns {Object} meta 数据（不含 ok 字段，由路由层包装）
 */
function buildMeta(cfg) {
  const conf = cfg || fleetConfig.load();
  const interval = conf.fleetHeartbeatInterval || 60;
  return {
    commands: fleetCommands.list(),
    groups: fleetCommands.GROUPS.slice(),
    configWhitelist: JSON.parse(JSON.stringify(fleetCommands.CONFIG_WHITELIST)),
    reasons: fleetReason.list(),
    connectivity: [
      { key: 'online', label: '在线', badge: 'online' },
      { key: 'stale', label: '掉线', badge: 'stale' },
      { key: 'offline', label: '离线', badge: 'offline' },
      { key: 'unreported', label: '未上报', badge: 'unreported' },
    ],
    // 对象数组（key/label/badge），前端筛选下拉与徽标配色直接消费，杜绝硬编码中文
    licenseStates: fleetReason.listLicenseStates(),
    commandStatus: [
      { key: 'pending', label: '待下发', badge: 'pending' },
      { key: 'sent', label: '已下发', badge: 'sent' },
      { key: 'acked', label: '已确认', badge: 'ok' },
      { key: 'failed', label: '执行失败', badge: 'bad' },
      { key: 'unsupported', label: '未支持', badge: 'unknown' },
      { key: 'timeout', label: '超时', badge: 'bad' },
    ],
    // —— sea2 商用运维：状态语义五表（设计 §9.3.2）——
    // 供前端 metaStatus(metaKey, st) 取词（label/badge），meta 未加载时回退 I18N 字典；
    // badge 给配色 class 后缀，取值沿用既有词汇（ok/bad/warn/unknown/black/online/offline/trial）。
    deviceStatus: [
      { key: 'unused', label: '未使用', badge: 'unknown' },
      { key: 'active', label: '已激活', badge: 'ok' },
      { key: 'revoked', label: '已吊销', badge: 'bad' },
      { key: 'expired', label: '已过期', badge: 'warn' },
      { key: 'disabled', label: '已禁用', badge: 'black' },
    ],
    orderStatus: [
      { key: 'paid', label: '已支付', badge: 'ok' },
      { key: 'issued', label: '已签发', badge: 'ok' },
      { key: 'pending', label: '待支付', badge: 'warn' },
      { key: 'await_verify', label: '待核验', badge: 'warn' },
      { key: 'expired', label: '已过期', badge: 'warn' },
      { key: 'cancelled', label: '已取消', badge: 'unknown' },
    ],
    anomalyStatus: [
      { key: 'open', label: '待处置', badge: 'warn' },
      { key: 'ignored', label: '已忽略', badge: 'unknown' },
      { key: 'revoked', label: '已吊销', badge: 'bad' },
      { key: 'blacklisted', label: '已拉黑', badge: 'black' },
      { key: 'resolved', label: '已自愈', badge: 'ok' },
    ],
    printerStatus: [
      { key: 'online', label: '在线', badge: 'online' },
      { key: 'offline', label: '离线', badge: 'offline' },
      { key: 'error', label: '异常', badge: 'bad' },
      { key: 'idle', label: '空闲', badge: 'ok' },
      { key: 'disabled', label: '已禁用', badge: 'black' },
    ],
    trialBadge: [
      { key: 'trial', label: '试用', badge: 'trial' },
      { key: 'trialExpired', label: '试用到期', badge: 'trial' },
    ],
    thresholds: {
      heartbeatInterval: interval,
      staleMinutes: conf.fleetStaleMinutes || 30,
      cpuWarn: conf.fleetCpuWarn || 85,
      memWarn: conf.fleetMemWarn || 85,
      commandTimeoutSec: 2 * interval,
      offlineDays: conf.fleetOfflineDays || 7,
    },
    // —— sea2 商用运维：配置中心扩展（设计 §3.6）——
    // 注意：totpSecret 绝不回显明文，只下发 totpConfigured 布尔（是否已生成密钥）。
    config: {
      formatWhitelist: Array.isArray(conf.formatWhitelist) ? conf.formatWhitelist.slice() : [],
      formatLevels: conf.formatLevels && typeof conf.formatLevels === 'object' ? conf.formatLevels : {},
      highriskEnabled: conf.highriskEnabled !== false,
      cupsDriverRepo: String(conf.cupsDriverRepo || ''),
      pm2ServerWhitelist: Array.isArray(conf.pm2ServerWhitelist) ? conf.pm2ServerWhitelist.slice() : [],
      formatDiskTarget: String(conf.formatDiskTarget || ''), // T05：disk 档目标盘（空=拒绝签发）
      totpConfigured: !!(conf.totpSecret && String(conf.totpSecret).length > 0),
    },
    limits: {
      ackResultsPerHeartbeat: 20,
      resultMaxBytes: 64 * 1024,
      resultsPerClient: 10,
      resultsGlobal: 2000,
      batchConcurrency: 5,
    },
  };
}

/** 指令超时扫描（委托 fleetStore） */
function timeoutScan(fsInst, now) {
  return fsInst.timeoutScan(now || Math.floor(Date.now() / 1000));
}

module.exports = {
  COMMANDS,
  DANGEROUS,
  midFromAnomalyId,
  deriveConnectivity,
  deriveLicenseState,
  deriveReason,
  deriveStatus,
  deriveMergeRisk,
  listClients,
  clientDetail,
  listAllPrinters,
  issueCommand,
  buildMeta,
  timeoutScan,
};
