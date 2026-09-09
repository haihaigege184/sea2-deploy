'use strict';
/**
 * lib/anomaly.js — 外网客户端异常授权检测引擎（5 规则）
 *
 * 扫描频率：fleetScanInterval（默认 60s），结果去重缓存到 fleetStore.anomalies（key=`rule:mid`）。
 * 规则：
 *  - code_shared    ：同一 code 在 ≥N 台不同 machine 出现近期有效心跳（高）
 *  - expired_online ：license 已过期（超宽限期）但仍有近期有效心跳（高）
 *  - machine_mismatch：心跳 reason==='machine-mismatch'（高）
 *  - long_offline   ：最后心跳距 now > T 天（低）
 *  - freq_anomaly    ：心跳间隔持续偏离区间（<0.5× / >2× interval，持续 3 次）（中）
 *
 * 处置（revoke/blacklist/ignore）在 consoleApi 中执行，本引擎只负责「检测 + 缓存」。
 * 已处置（resolved/ignored）的异常在 setAnomalies 中会保留状态，不重复浮现。
 */

const fleetStore = require('./fleetStore');
const codes = require('./codes');
const redundancy = require('./redundancy');

/** 近期窗口：最近 2×心跳间隔内视为「活跃」 */
function isRecent(rec, cfg, now) {
  const interval = (cfg.fleetHeartbeatInterval || 60);
  const last = rec.snapshot.lastHeartbeatAt || 0;
  return last > 0 && (now - last) <= 2 * interval;
}

/**
 * [BUG-R9-01] 双系统豁免判定：共享同一激活码的设备清单是否属于合法双系统对。
 *
 * 背景：sea1 与 sea2 机器码不同源（同一物理机双系统 = 服务端两台设备），双系统开启后
 *       两台设备共用同一激活码 → code_shared（同码 ≥N 台有效心跳）会误报。
 *
 * 豁免条件（二选一）：
 *  1. pair 精确覆盖：全部共享设备恰好是某个「已登记且 enabled」的 devicePair 主/副设备
 *     （redundancy.listPairs，开启双系统时登记 primary+secondary）；
 *  2. 全量 dual-enabled（pair 未登记/数据缺失时兜底，见 team-lead 简化建议）：
 *     全部共享设备都在 redundancy 双系统开启登记中（listEnabled）。
 *
 * 安全边界：仅当 共享设备 ≥2 且**全部**设备均为合法 dual 登记才豁免；
 * 任一设备非 dual（或 pair 未启用）→ 照常触发，防恶意借 dual 名义规避共享检测。
 * @param {string[]} mids 同码共享设备 machineId 列表
 * @returns {boolean} true=豁免（不标记 code_shared 异常）
 */
function isDualPairExempt(mids) {
  const distinct = Array.from(new Set(mids || [])).map((m) => String(m));
  if (distinct.length < 2) return false;
  // 条件1：pair 精确覆盖（所有共享设备都在同一 enabled pair 内）
  const pairs = redundancy.listPairs().filter((p) => p && p.enabled !== false);
  const pairMatched = pairs.some((p) =>
    distinct.every((m) => String(p.primary) === m || String(p.secondary) === m)
  );
  if (pairMatched) return true;
  // 条件2：全部共享设备均为 dual-enabled（兜底）
  const enabled = redundancy.listEnabled().map((e) => String(e.machineId));
  return distinct.every((m) => enabled.indexOf(m) >= 0);
}

/** 规则1：同码多机 */
function ruleCodeShared(store, cfg, now) {
  const minN = cfg.fleetCodeSharedMin || 2;
  const byCode = new Map(); // code -> [machineId...]
  for (const [mid, rec] of fleetStore.getInstance().clients) {
    const code = rec.snapshot.code;
    if (!code) continue;
    if (!isRecent(rec, cfg, now)) continue;
    const h0 = rec.history[0];
    if (!h0 || !h0.valid) continue; // 仅统计有效近期心跳
    const arr = byCode.get(code) || [];
    arr.push(mid);
    byCode.set(code, arr);
  }
  const out = [];
  for (const [code, mids] of byCode) {
    const distinct = Array.from(new Set(mids));
    if (distinct.length >= minN) {
      // [BUG-R9-01] 双系统对（同一物理机主/副框架）共用码 → 豁免，不误报
      if (isDualPairExempt(distinct)) continue;
      for (const mid of distinct) {
        out.push({
          id: fleetStore.anomalyId('code_shared', mid),
          rule: 'code_shared',
          machineId: mid,
          code,
          severity: 'high',
          detail: `激活码 ${code} 在 ${distinct.length} 台设备共用（阈值 ${minN}）`,
        });
      }
    }
  }
  return out;
}

/** 规则2：过期在线 */
function ruleExpiredOnline(rec, store, cfg, now) {
  const code = rec.snapshot.code;
  if (!code) return null;
  const licRec = store.getLicense(code);
  const codeRec = store.getCode(code);
  // [T1-P1-4] expires_at 单位统一：存量毫秒值（>1e12）换算秒后再判过期
  const expiresAt = codes.normalizeExpiresAt(
    (codeRec && codeRec.expires_at)
      || (licRec && licRec.license && licRec.license.expires_at) || 0
  );
  if (!expiresAt) return null;
  const graceDays = cfg.graceDays || 7;
  const graceSec = graceDays * 86400;
  if (now <= expiresAt + graceSec) return null; // 未过期（宽限内）
  if (!isRecent(rec, cfg, now)) return null;
  const h0 = rec.history[0];
  if (!h0 || !h0.valid) return null;
  const overDays = Math.floor((now - expiresAt) / 86400);
  return {
    id: fleetStore.anomalyId('expired_online', rec.machineId),
    rule: 'expired_online',
    machineId: rec.machineId,
    code,
    severity: 'high',
    detail: `许可证已过期 ${overDays} 天（宽限 ${graceDays} 天）但仍在活跃心跳`,
  };
}

/** 规则3：机器码篡改 */
function ruleMachineMismatch(rec) {
  const h0 = rec.history[0];
  if (h0 && h0.reason === 'machine-mismatch') {
    return {
      id: fleetStore.anomalyId('machine_mismatch', rec.machineId),
      rule: 'machine_mismatch',
      machineId: rec.machineId,
      code: rec.snapshot.code,
      severity: 'high',
      detail: '机器码与激活绑定不一致（疑似换机/篡改）',
    };
  }
  return null;
}

/** 规则4：长期离线 */
function ruleLongOffline(rec, cfg, now) {
  const last = rec.snapshot.lastHeartbeatAt || 0;
  if (!last) return null;
  const offlineSec = (cfg.fleetOfflineDays || 7) * 86400;
  if (now - last > offlineSec) {
    const days = Math.floor((now - last) / 86400);
    return {
      id: fleetStore.anomalyId('long_offline', rec.machineId),
      rule: 'long_offline',
      machineId: rec.machineId,
      code: rec.snapshot.code,
      severity: 'low',
      detail: `已离线 ${days} 天（阈值 ${cfg.fleetOfflineDays || 7} 天）`,
    };
  }
  return null;
}

/** 规则5：频率异常（连续 3 次间隔 <0.5× 或 >2× interval） */
function ruleFreqAnomaly(rec, cfg) {
  const interval = cfg.fleetHeartbeatInterval || 60;
  const minI = interval * (cfg.fleetFreqMinMul != null ? cfg.fleetFreqMinMul : 0.5);
  const maxI = interval * (cfg.fleetFreqMaxMul != null ? cfg.fleetFreqMaxMul : 2);
  const h = rec.history || [];
  if (h.length < 4) return false; // 需要 ≥4 个时间点（3 个间隔）
  let streak = 0;
  for (let i = 0; i < h.length - 1; i++) {
    const dt = h[i].at - h[i + 1].at;
    const anomalous = dt < minI || dt > maxI;
    if (anomalous) {
      streak++;
      if (streak >= 3) return true;
    } else {
      break; // 需连续
    }
  }
  return false;
}

/**
 * 执行一次扫描：聚合 5 规则结果，写入 fleetStore 异常缓存。
 * @param {object} store 激活服务 Store
 * @param {object} fsInst fleetStore 实例
 * @param {object} cfg 服务器配置（需含 graceDays / fleet* 阈值）
 * @returns {Array} 当前检测到的异常数组
 */
function scan(store, fsInst, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const out = [];

  // 跨机规则：同码多机
  out.push(...ruleCodeShared(store, cfg, now));

  // 单机规则
  for (const [mid, rec] of fsInst.clients) {
    let a;
    a = ruleExpiredOnline(rec, store, cfg, now); if (a) out.push(a);
    a = ruleMachineMismatch(rec); if (a) out.push(a);
    a = ruleLongOffline(rec, cfg, now); if (a) out.push(a);
    if (ruleFreqAnomaly(rec, cfg)) {
      out.push({
        id: fleetStore.anomalyId('freq_anomaly', mid),
        rule: 'freq_anomaly',
        machineId: mid,
        code: rec.snapshot.code,
        severity: 'medium',
        detail: '心跳频率持续异常（过快/过慢，连续 3 次）',
      });
    }
  }

  fsInst.setAnomalies(out);
  return out;
}

module.exports = { scan, ruleCodeShared, ruleExpiredOnline, ruleMachineMismatch, ruleLongOffline, ruleFreqAnomaly, isDualPairExempt };
