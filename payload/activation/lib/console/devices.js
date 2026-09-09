'use strict';
/**
 * lib/console/devices.js — 设备聚合与远程操作
 *
 * 设备 = 客户端机器。数据来源：
 *  - codes（激活码，含 customer/qq、bound_machine_id、status、expires_at）
 *  - heartbeats（心跳，按 machine_id）
 *  - orders（反查套餐 plan）
 *  - trials（机器维度 / 用户维度试用）
 *
 * 操作：
 *  - disable：吊销 license（updateCode status='revoked'）→ 客户端下次心跳降级
 *  - reset：吊销 + 清机器试用 + 清用户维度试用 → 回未授权态
 *  - restart：pm2 restart sea1-bot（需调用方先 verifyAuth L2+；模块内 60s 限频）
 */

const child_process = require('node:child_process');

const codes = require('../codes');

const PLAN_NAME = { month: '月度会员', quarter: '季度会员', year: '年度会员', lifetime: '永久授权' };

/**
 * [T1-P0-3] 按最近心跳时间派生连接性（与 fleet.js deriveConnectivity 同口径默认阈值：
 * 2×心跳间隔=120s 在线 / staleMinutes=30min 掉线 / 其余离线 / 从未上报 unreported）。
 * @param {number} lastHbAt Unix 秒
 * @param {number} now Unix 秒
 * @returns {string} online | stale | offline | unreported
 */
function deriveConnFromLastHb(lastHbAt, now) {
  if (!lastHbAt || lastHbAt <= 0) return 'unreported';
  const age = now - lastHbAt;
  if (age <= 120) return 'online';
  if (age <= 1800) return 'stale';
  return 'offline';
}

/**
 * [SEA2 运维] 设备档案扩展字段（备注/分组/机型白名单标记）
 * 由 lib/ops/crud.js 的 devices 实体读写，持久化于 data/device-profiles.json（DATA_DIR 内）。
 */
const PROFILE_FIELDS = ['remark', 'group', 'model', 'whitelisted'];

/**
 * [SEA2 运维] 把档案扩展字段合并进设备列表项（CRUD 引擎 / 前端展示用）。
 * @param {Array<object>} items devices.listDevices 输出
 * @param {object} profiles { machineId: profile } 档案表
 * @returns {Array<object>}
 */
function extendWithProfiles(items, profiles) {
  profiles = profiles || {};
  return (items || []).map((item) => {
    const p = profiles[item.machine_id || item.id] || {};
    return Object.assign({}, item, {
      remark: p.remark || '',
      group: p.group || '',
      model: p.model || '',
      whitelisted: p.whitelisted === true,
      profileDeleted: p.deleted === true,
      profileUpdatedAt: p.updatedAt || 0,
    });
  });
}

let lastRestartTs = 0;
const RESTART_COOLDOWN_MS = 60 * 1000;

function planNameOf(plan) {
  return PLAN_NAME[plan] || (plan ? String(plan) : '');
}

/** 在 store 中按 machine_id / qq / code 解析出 code 记录 */
function resolveCode(store, id) {
  if (!id) return null;
  const sid = String(id);
  let rec = store.getCode(sid);
  if (rec) return rec;
  for (const c of store.listCodes()) {
    if (c.bound_machine_id && String(c.bound_machine_id) === sid) return c;
  }
  for (const c of store.listCodes()) {
    if (c.customer && String(c.customer) === sid) return c;
  }
  return null;
}

/**
 * 列出设备（从 codes + trials + 心跳 + license 派生 + fleet 心跳设备自动纳入）。
 * 每项：{ id, machine_id, qq, code, plan, planName, status, last_heartbeat, license_expires_at, issuedAt }
 *
 * [T03 需求5 方案 B]（设计 §10.5.3）：传入 fsInst（fleetStore 实例，与心跳同实例）后，
 * 追加第三数据源——凡未出现在 seen 的 fleet 心跳设备（含试用 isTrial）自动并入，
 * 标记 source:'fleet'；合并顺序：codes 派生 > store 试用 > fleet 心跳（fleet 仅补漏，避免 seen 冲突）。
 * 档案 overlay（备注/分组/机型/白名单）由 crud.extendWithProfiles 在列表层叠加，档案字段优先于自动字段。
 *
 * @param {Object} store 激活码主 store
 * @param {Object} [fsInst] fleetStore 实例（可选；不传则维持旧行为，仅 codes+试用）
 */
function listDevices(store, fsInst) {
  const now = Math.floor(Date.now() / 1000);
  const heartbeats = store.listHeartbeats(); // { machineId: [ {at,code,valid,reason,...} ] }
  const out = [];
  const seen = new Set();

  // 1) 从激活码派生
  for (const c of store.listCodes()) {
    const mid = c.bound_machine_id || '';
    const qq = c.customer || '';
    const id = mid || qq || c.code;
    if (seen.has(id)) continue;
    seen.add(id);

    let plan = '';
    let planName = '';
    const order = store.listOrders().find((o) => o.code === c.code);
    if (order) { plan = order.plan; planName = planNameOf(order.plan); }

    const hb = mid && heartbeats[mid] ? heartbeats[mid][0] : null;

    // [T1-P0-3] fleet 快照富化：fleet 心跳已改走 fleetStore，store.heartbeats 停更
    // （listDevices 里 store 心跳恒为空），改为从 fleetStore 快照补
    // version/connectivity/isTrial/lastHeartbeatAt/trialInfo。
    let fsnap = null;
    if (mid && fsInst && typeof fsInst.getClient === 'function') {
      const frec = fsInst.getClient(mid);
      fsnap = frec && frec.snapshot ? frec.snapshot : null;
    }
    const fleetHbAt = (fsnap && fsnap.lastHeartbeatAt) || 0;

    // [T1-P1-4] expires_at 单位统一：存量毫秒值（>1e12）换算秒后再判定过期
    const expSec = codes.normalizeExpiresAt(c.expires_at);

    let status;
    if (c.status === 'revoked') status = 'revoked';
    else if (expSec > 0 && now > expSec) status = 'expired';
    // 仅「非试用」的 fleet 无效快照才算 abnormal（试用中 valid=false 属正常，由 isTrial 列单独表达）
    else if ((hb && hb.valid === false) || (fleetHbAt > 0 && fsnap && !fsnap.isTrial && fsnap.valid === false)) status = 'abnormal';
    else status = 'activated';

    out.push({
      id,
      machine_id: mid,
      qq,
      code: c.code,
      plan,
      planName,
      status,
      // 最近心跳：优先 store 心跳（兼容旧数据），缺省回退 fleet 快照（T1-P0-3）
      last_heartbeat: hb
        ? { at: hb.at, valid: hb.valid, reason: hb.reason || '' }
        : (fleetHbAt > 0 ? { at: fleetHbAt, valid: !!(fsnap && fsnap.valid), reason: (fsnap && fsnap.reason) || '' } : null),
      license_expires_at: c.expires_at || 0,
      issuedAt: c.issued_at || 0,
      // [T1-P0-3] fleet 快照富化字段（与 fleet 心跳分支同口径，连接/版本/试用列不再 '—'）
      version: (fsnap && fsnap.version) || '',
      connectivity: fleetHbAt > 0 ? deriveConnFromLastHb(fleetHbAt, now) : '',
      isTrial: !!(fsnap && fsnap.isTrial),
      trialInfo: fsnap && fsnap.trialInfo && typeof fsnap.trialInfo === 'object'
        ? Object.assign({}, fsnap.trialInfo) : null,
    });
  }

  // 2) 机器维度试用（无 code 的）
  try {
    for (const t of store.listTrials()) {
      const mid = t.machine_id;
      if (!mid || seen.has(mid)) continue;
      seen.add(mid);
      const hb = heartbeats[mid] ? heartbeats[mid][0] : null;
      out.push({
        id: mid,
        machine_id: mid,
        qq: '',
        code: '',
        plan: '',
        planName: '试用',
        status: 'trial',
        last_heartbeat: hb ? { at: hb.at, valid: hb.valid, reason: hb.reason || '' } : null,
        license_expires_at: 0,
        issuedAt: 0,
      });
    }
  } catch (e) { /* ignore */ }

  // 3) 用户维度试用（按 uin，无 machine_id）
  try {
    for (const u of store.listTrialUsers()) {
      const qq = String(u.uin || '');
      if (!qq || seen.has(qq)) continue;
      seen.add(qq);
      out.push({
        id: qq,
        machine_id: '',
        qq,
        code: '',
        plan: '',
        planName: '试用',
        status: 'trial',
        last_heartbeat: null,
        license_expires_at: 0,
        issuedAt: 0,
      });
    }
  } catch (e) { /* ignore */ }

  // 4) fleet 心跳设备自动纳入（[T03 需求5 方案 B]；含试用 isTrial；仅补漏，绝不覆盖既有 seen）
  // 字段语义：machine_id / qq（loginInfo.qq 或快照 qq）/ code / planName（试用标记）/
  //   status（isTrial?'trial':connectivity）/ last_heartbeat（快照时间）/ version / connectivity / isTrial / source:'fleet'
  if (fsInst && fsInst.clients && typeof fsInst.clients.values === 'function') {
    for (const rec of fsInst.clients.values()) {
      const snap = rec && rec.snapshot ? rec.snapshot : {};
      const mid = (rec && rec.machineId) || snap.machineId || '';
      if (!mid || seen.has(mid)) continue;
      seen.add(mid);
      const isTrial = !!snap.isTrial;
      const lastHb = snap.lastHeartbeatAt || 0;
      // 连接性只看心跳新鲜度（与 fleet.js deriveConnectivity 同口径默认阈值：
      // 2×心跳间隔=120s 在线 / staleMinutes=30min 掉线 / 其余离线 / 从未上报 unreported）
      const connectivity = deriveConnFromLastHb(lastHb, now);
      out.push({
        id: mid,
        machine_id: mid,
        qq: (snap.loginInfo && snap.loginInfo.qq) || snap.qq || '',
        code: snap.code || '',
        plan: '',
        planName: isTrial ? '试用' : '',
        status: isTrial ? 'trial' : connectivity,
        last_heartbeat: lastHb > 0 ? { at: lastHb, valid: !!snap.valid, reason: snap.reason || '' } : null,
        license_expires_at: 0,
        issuedAt: 0,
        // —— [T03] 自动纳入字段（前端来源徽标/连接/最近心跳/版本列 + 试用徽标）——
        version: snap.version || '',
        connectivity,
        isTrial,
        source: 'fleet',
        trialInfo: snap.trialInfo && typeof snap.trialInfo === 'object' ? Object.assign({}, snap.trialInfo) : null,
      });
    }
  }

  return out;
}

/** 吊销某设备（按 id 解析 code，置 status='revoked'） */
function disable(store, id) {
  const rec = resolveCode(store, id);
  if (!rec) return { ok: false, error: '未找到该设备对应的激活码', status: 404 };
  store.updateCode(rec.code, { status: 'revoked' });
  return { ok: true, code: rec.code, status: 'revoked' };
}

/**
 * 启用某设备（disable 的逆操作，按 id 解析 code，置 status='active'）。
 *
 * 设计约束（对齐 A 决策）：
 *  - **不重新签发 license**：expires_at 沿用原值。吊销只改 status，
 *    license 本体与有效期从未被销毁，恢复即可复用，避免误延长客户付费周期。
 *  - **幂等**：对已是 active 的码重复调用不报错，返回 alreadyActive=true。
 *  - **过期告警**：若沿用的 expires_at 已过期，恢复后客户端心跳仍会判 expired。
 *    此时返回 expired=true 让调用方据实提示，避免运维误以为"启用成功却仍不可用"。
 *
 * @param {Object} store 激活码主 store
 * @param {string} id machine_id / qq / code 任一
 * @returns {{ok:boolean, code?:string, status?:number|string, expiresAt?:number,
 *            expired?:boolean, alreadyActive?:boolean, error?:string}}
 */
function enable(store, id) {
  const rec = resolveCode(store, id);
  if (!rec) return { ok: false, error: '未找到该设备对应的激活码', status: 404 };

  const alreadyActive = rec.status === 'active';
  if (!alreadyActive) store.updateCode(rec.code, { status: 'active' });

  // 沿用原有效期；0 表示永久授权（lifetime），不参与过期判定
  const expiresAt = rec.expires_at || 0;
  const expired = expiresAt > 0 && Math.floor(Date.now() / 1000) > expiresAt;

  return { ok: true, code: rec.code, status: 'active', expiresAt, expired, alreadyActive };
}

/**
 * 重置：吊销 code + 清机器维度试用 + 清用户维度试用 → 回未授权态。
 */
function reset(store, id) {
  const rec = resolveCode(store, id);
  const affected = [];
  if (rec) {
    store.updateCode(rec.code, { status: 'revoked' });
    affected.push(rec.code);
    const mid = rec.bound_machine_id;
    if (mid) {
      const t = store.getTrial(mid);
      if (t) { t.days = 0; t.start = Date.now(); store.saveTrial(t); affected.push('trial:' + mid); }
    }
    const qq = rec.customer;
    if (qq) {
      const tu = store.getTrialUser(qq);
      if (tu) { store.updateTrialUser(qq, { status: 'cleared', clearedAt: Date.now() }); affected.push('trialUser:' + qq); }
    }
  } else {
    // 也许 id 本身就是机器维度试用记录
    const t = store.getTrial(String(id));
    if (t) { t.days = 0; t.start = Date.now(); store.saveTrial(t); affected.push('trial:' + String(id)); }
  }
  return { ok: true, affected };
}

/**
 * 重启 bot 进程（需调用方先 verifyAuth L2+）。模块内 60s 限频。
 * @returns {{ok:boolean, restarted?:boolean, error?:string, status?:number}}
 */
function restart() {
  const now = Date.now();
  if (now - lastRestartTs < RESTART_COOLDOWN_MS) {
    return { ok: false, error: '操作过于频繁，请 60 秒后再试', status: 429 };
  }
  lastRestartTs = now;
  try {
    child_process.exec('pm2 restart sea1-bot', (err) => {
      // best-effort，不阻塞响应
      if (err) console.warn('[console][devices] pm2 restart sea1-bot 失败:', err.message);
    });
    return { ok: true, restarted: true };
  } catch (e) {
    return { ok: false, error: '重启失败: ' + String(e && e.message || e), status: 500 };
  }
}

module.exports = { listDevices, disable, enable, reset, restart, resolveCode, planNameOf, PROFILE_FIELDS, extendWithProfiles };
