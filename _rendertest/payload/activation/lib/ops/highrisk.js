'use strict';
/**
 * lib/ops/highrisk.js — 强门禁引擎（OpsHighrisk，sea2 运维引擎 M1）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §3.1 / §3.3 / §4.4 / §7.8
 *
 * 职责：
 *  - checkWhitelist(machineId, level)：高危专区门禁上下文（总开关 + 机型白名单 + 三档参数）；
 *  - verifyConfirmWord(action, confirm)：确认词校验（FORMAT-DATA/FACTORY/DISK）；
 *  - verifyTotp(token, secret)：管理员 TOTP 二次验证（[R2] 保留但不调用，格式化签发链不再校验）；
 *  - issueFormat(mid, level, operator)：签发 format_device 指令（唯一入口，普通下发接口拒绝直发）；
 *  - advance(recordId, outcome)：推进高危记录状态机。
 *
 * 安全铁律（§7.8 / PRD P2-3）：
 *  - 三档分级 data/factory/disk（countdownSec 15/20/30，confirmWord 来自 fleetConfig.formatLevels）；
 *  - format_device 仅由本引擎签发（minLevel:3 + 强门禁上下文），全程经 OpsAuditStore.logHighrisk；
 *  - highriskEnabled=false 时全区拒绝；
 *  - 高危审计记录含前后状态快照（P5）。
 *
 * [R2/R5] 去 TOTP：签发门禁链 = 总开关 → 白名单 → 确认词 → 签发；
 *   checkWhitelist.totpRequired 恒 false（保持字段兼容）；auditStore.logHighrisk 的
 *   totpChecked 固定写 false（签名不变）。
 */

const fleetConfig = require('../fleetConfig');
const fleetCommands = require('../fleetCommands');
const fleetStore = require('../fleetStore');
const fleet = require('../fleet');
const auditStore = require('./auditStore');
const totp = require('./totp');
// [R4] 设备档案白名单联动：crud 静态 getDeviceProfile（单方向 require，无循环依赖）
const crud = require('./crud');

/** 合法格式化级别 */
const LEVELS = ['data', 'factory', 'disk'];

class OpsHighrisk {
  /**
   * @param {object} [deps] 依赖注入（测试用）
   * @param {object} [deps.fsInst] fleetStore 实例（默认全局单例）
   * @param {object} [deps.store] 激活码 store（供快照关联，可空）
   * @param {object} [deps.totp] TOTP 校验器（默认全局单例）
   * @param {function} [deps.profileReader] 设备档案读取器（R4：默认 crud.getDeviceProfile，
   *   读 DATA_DIR/device-profiles.json 按 machineId 取档案；whitelisted===true → 放行）
   */
  constructor(deps) {
    deps = deps || {};
    this._fsInst = deps.fsInst || null;
    this._store = deps.store || null;
    this._totp = deps.totp || totp;
    // [R4] 设备档案白名单联动：默认 crud.OpsCrud.getDeviceProfile（静态函数，无循环依赖）
    const defaultReader = (crud && crud.OpsCrud && typeof crud.OpsCrud.getDeviceProfile === 'function')
      ? crud.OpsCrud.getDeviceProfile
      : null;
    this._profileReader = (typeof deps.profileReader === 'function') ? deps.profileReader : defaultReader;
  }

  _fs() {
    return this._fsInst || fleetStore.getInstance();
  }

  /**
   * 读取三档级别参数（来自 fleetConfig.formatLevels，带默认兜底）。
   * @param {string} level
   * @returns {{countdownSec:number, confirmWord:string}|null}
   * @private
   */
  _levelParams(level) {
    const cfg = fleetConfig.load();
    const levels = (cfg.formatLevels && typeof cfg.formatLevels === 'object') ? cfg.formatLevels : {};
    const p = levels[level];
    if (!p) return null;
    return {
      countdownSec: Number(p.countdownSec) || 15,
      confirmWord: String(p.confirmWord || ''),
    };
  }

  /**
   * 设备档案白名单判定（R4）：档案 whitelisted===true → 放行。
   * fail-closed：档案不存在 / 读取异常 / 非白名单标记一律返回 false。
   * @param {string} machineId
   * @returns {boolean}
   * @private
   */
  _isProfileWhitelisted(machineId) {
    try {
      const reader = this._profileReader;
      if (typeof reader !== 'function') return false;
      const p = reader(machineId);
      return !!(p && p.whitelisted === true);
    } catch (e) {
      return false;
    }
  }

  /**
   * 门禁上下文：总开关 + 机型白名单 + 三档参数。
   * [R2/R5] 返回不再含 TOTP 门禁要求：totpRequired 恒 false（保持字段兼容，前端据此不再提示验证码）。
   * @param {string} machineId
   * @param {string} level 'data' | 'factory' | 'disk'
   * @returns {{allowed:boolean, level?:string, confirmWord?:string, countdownSec?:number,
   *            totpRequired?:boolean, error?:string, status?:number}}
   */
  checkWhitelist(machineId, level) {
    const cfg = fleetConfig.load();
    if (cfg.highriskEnabled === false) {
      return { allowed: false, error: '高危专区已关闭（highriskEnabled=false）', status: 403 };
    }
    if (!machineId) return { allowed: false, error: 'machineId 必填', status: 400 };
    if (LEVELS.indexOf(level) < 0) {
      return { allowed: false, error: '级别非法（data|factory|disk）', status: 400 };
    }
    const params = this._levelParams(level);
    if (!params || !params.confirmWord) {
      return { allowed: false, error: `级别「${level}」未配置（fleetConfig.formatLevels）`, status: 500 };
    }

    // 机型白名单：机器码前缀匹配（formatWhitelist）或设备档案 whitelisted===true（R4 联动）
    const wl = Array.isArray(cfg.formatWhitelist) ? cfg.formatWhitelist : [];
    const hit = wl.some((prefix) => String(prefix) && String(machineId).startsWith(String(prefix)));
    const profileHit = this._isProfileWhitelisted(machineId);
    if (!hit && !profileHit) {
      return {
        allowed: false,
        error: `机器码 ${machineId} 不在白名单内（格式白名单未命中且设备档案未标记白名单）`,
        status: 403,
      };
    }

    // [R2/R5] 去 TOTP：恒 false（字段保留兼容；签发链不再校验 opts.totp）
    return {
      allowed: true,
      level,
      confirmWord: params.confirmWord,
      countdownSec: params.countdownSec,
      totpRequired: false,
    };
  }

  /**
   * 确认词校验（format_device 三档词）。level 提供时做精确匹配，否则对全量合法词校验。
   * @param {string} action 指令 action（当前支持 format_device）
   * @param {string} confirm 确认词
   * @param {string} [level] 可选：指定级别精确匹配
   * @returns {{ok:boolean, error?:string}}
   */
  verifyConfirmWord(action, confirm, level) {
    if (action !== 'format_device') {
      return { ok: false, error: '确认词校验仅支持 format_device' };
    }
    const spec = fleetCommands.get('format_device');
    const words = Array.isArray(spec && spec.confirmWords) && spec.confirmWords.length
      ? spec.confirmWords
      : ['FORMAT-DATA', 'FORMAT-FACTORY', 'FORMAT-DISK'];
    const text = String(confirm || '');
    if (level && LEVELS.indexOf(level) >= 0) {
      const params = this._levelParams(level);
      if (params && params.confirmWord) {
        if (text === params.confirmWord) return { ok: true };
        return { ok: false, error: `确认词不符：该级别需输入 ${params.confirmWord}` };
      }
    }
    if (words.indexOf(text) >= 0) return { ok: true };
    return { ok: false, error: '确认词非法（应为 FORMAT-DATA / FORMAT-FACTORY / FORMAT-DISK）' };
  }

  /**
   * TOTP 二次验证。
   * @param {string} token 6 位验证码
   * @param {string} secret base32 密钥
   * @returns {{ok:boolean, error?:string}}
   */
  verifyTotp(token, secret) {
    const s = String(secret || '');
    if (!s) return { ok: false, error: '未配置 TOTP 密钥，请先在「TOTP 管理」中生成' };
    if (!this._totp.verify(token, s, 1)) return { ok: false, error: 'TOTP 验证码无效或已过期' };
    return { ok: true };
  }

  /**
   * 签发 format_device 指令（强门禁唯一入口）。
   * [R2/R5] 门禁链：总开关 → 白名单 → 级别参数 → 确认词 → 记录 created → 下发指令 → 记录 issued。
   *   TOTP 不再校验（opts.totp 保留签名但被忽略）；审计 totpChecked 由 auditStore 固定写 false。
   *
   * @param {string} mid 机器码
   * @param {string} level 'data' | 'factory' | 'disk'
   * @param {string} operator 操作人（L3）
   * @param {object} [opts] { confirm, totp, operatorLevel }（totp 兼容保留，不参与校验）
   * @returns {{ok:boolean, recordId?:string, commandId?:string, status?:string, error?:string, statusCode?:number}}
   */
  async issueFormat(mid, level, operator, opts) {
    opts = opts || {};
    const operatorLevel = opts.operatorLevel;

    // 1) 总开关 + 白名单 + 级别参数
    const gate = this.checkWhitelist(mid, level);
    if (!gate.allowed) {
      auditStore.logHighrisk({
        operator, operatorLevel, machineId: mid, level, status: 'rejected',
        whitelistChecked: false, confirmChecked: false, totpChecked: false,
        before: null, after: null, detail: gate.error, ok: false,
      });
      return { ok: false, error: gate.error, statusCode: gate.status || 403 };
    }

    // 2) 确认词
    const cw = this.verifyConfirmWord('format_device', opts.confirm, level);
    if (!cw.ok) {
      auditStore.logHighrisk({
        operator, operatorLevel, machineId: mid, level, status: 'rejected',
        whitelistChecked: true, confirmChecked: false, totpChecked: false,
        confirmWord: gate.confirmWord, countdownSec: gate.countdownSec,
        before: null, after: null, detail: cw.error, ok: false,
      });
      return { ok: false, error: cw.error, statusCode: 400 };
    }

    // 3) disk 档目标盘校验（T05：配置中心 formatDiskTarget 预填；空 = 拒绝签发 disk 档）
    //      客户端无 target 同样拒绝（disk-target-required），双侧 fail-closed。
    let diskTarget = '';
    if (level === 'disk') {
      diskTarget = String(fleetConfig.load().formatDiskTarget || '').trim();
      if (!diskTarget) {
        auditStore.logHighrisk({
          operator, operatorLevel, machineId: mid, level, status: 'rejected',
          whitelistChecked: true, confirmChecked: true, totpChecked: false,
          confirmWord: gate.confirmWord, countdownSec: gate.countdownSec,
          before: null, after: null, detail: 'disk-target-required（配置中心未预填 formatDiskTarget）', ok: false,
        });
        return { ok: false, error: 'disk-target-required（disk 档需先在配置中心配置 formatDiskTarget）', statusCode: 400 };
      }
    }

    // 4) 记录 created（含 before 快照）
    const fs = this._fs();
    const now = Math.floor(Date.now() / 1000);
    const nonce = require('node:crypto').randomBytes(8).toString('hex');
    const snap = fs.getClient(mid);
    const beforeSnapshot = snap ? JSON.parse(JSON.stringify(snap.snapshot || {})) : {};
    const hr = fs.addHighrisk(mid, {
      code: snap && snap.snapshot && snap.snapshot.code ? snap.snapshot.code : '',
      level,
      confirmWord: gate.confirmWord,
      confirmChecked: true,
      totpChecked: false, // [R2/R5] 去 TOTP：不再校验，恒 false
      totpOperator: '',
      whitelistChecked: true,
      status: 'created',
      countdownSec: gate.countdownSec,
      issuedAt: now,
      before: { snapshot: beforeSnapshot },
    });
    if (!hr) return { ok: false, error: '高危记录创建失败', statusCode: 500 };

    // 5) 下发 format_device 指令（fleet.issueCommand，绕过普通下发接口）
    const payload = { level, countdownSec: gate.countdownSec, nonce };
    if (level === 'disk' && diskTarget) payload.diskTarget = diskTarget; // T05：目标盘随下发携带
    const issue = fleet.issueCommand(fs, mid, 'format_device', payload, operator);
    if (!issue.ok) {
      auditStore.logHighrisk({
        operator, operatorLevel, recordId: hr.recordId, machineId: mid, level,
        confirmWord: gate.confirmWord, confirmChecked: true, totpChecked: false,
        totpOperator: '', whitelistChecked: true, status: 'failed',
        countdownSec: gate.countdownSec, issuedAt: now,
        before: hr, after: null, detail: issue.error, ok: false,
      });
      return { ok: false, error: issue.error, statusCode: issue.status || 500 };
    }

    // 6) 推进记录 → issued（含 after 快照）
    fs.advanceHighrisk(hr.recordId, { status: 'issued', commandId: issue.commandId });
    const after = Object.assign({}, hr, { status: 'issued', commandId: issue.commandId });
    auditStore.logHighrisk({
      operator, operatorLevel, recordId: hr.recordId, machineId: mid,
      code: hr.code, level, confirmWord: gate.confirmWord,
      confirmChecked: true, totpChecked: false, totpOperator: '',
      whitelistChecked: true, commandId: issue.commandId, status: 'issued',
      countdownSec: gate.countdownSec, issuedAt: now,
      before: hr, after, ok: true,
    });

    return {
      ok: true,
      recordId: hr.recordId,
      commandId: issue.commandId,
      status: 'issued',
      cmdStatus: issue.cmdStatus,
      level,
      countdownSec: gate.countdownSec,
      confirmWord: gate.confirmWord,
    };
  }

  /**
   * 推进高危记录状态机（回执落库 / 状态推进）。
   * @param {string} recordId 高危记录 id
   * @param {object} outcome { status, ackedAt, result, operator, operatorLevel }
   * @returns {{ok:boolean, record?:object, error?:string, statusCode?:number}}
   */
  advance(recordId, outcome) {
    outcome = outcome || {};
    if (!recordId) return { ok: false, error: 'recordId 必填', statusCode: 400 };
    const fs = this._fs();
    const all = fs.listAllHighrisk({});
    const target = all.find((x) => x.recordId === String(recordId));
    if (!target) return { ok: false, error: '高危记录不存在', statusCode: 404 };

    const before = JSON.parse(JSON.stringify(target));
    const patch = {};
    if (outcome.status) {
      const allowed = ['issued', 'local-confirmed', 'done', 'failed', 'rejected'];
      if (allowed.indexOf(outcome.status) < 0) {
        return { ok: false, error: '状态非法（issued|local-confirmed|done|failed|rejected）', statusCode: 400 };
      }
      patch.status = outcome.status;
    }
    if (outcome.ackedAt !== undefined) patch.ackedAt = Number(outcome.ackedAt) || Math.floor(Date.now() / 1000);
    if (outcome.result !== undefined) patch.result = outcome.result;

    const ok = fs.advanceHighrisk(String(recordId), patch);
    if (!ok) return { ok: false, error: '高危记录无法推进（终态不可改写）', statusCode: 409 };

    const after = fs.listAllHighrisk({}).find((x) => x.recordId === String(recordId)) || Object.assign({}, before, patch);
    auditStore.logHighrisk({
      operator: outcome.operator || 'system',
      operatorLevel: outcome.operatorLevel,
      recordId, machineId: before.machineId, code: before.code, level: before.level,
      confirmWord: before.confirmWord, confirmChecked: before.confirmChecked,
      totpChecked: before.totpChecked, totpOperator: before.totpOperator,
      whitelistChecked: before.whitelistChecked, commandId: before.commandId,
      status: after.status, countdownSec: before.countdownSec,
      issuedAt: before.issuedAt, ackedAt: after.ackedAt, result: after.result,
      before, after, ok: true,
    });
    return { ok: true, record: after };
  }

  /**
   * 高危记录列表（跨客户端）。
   * @param {object} [filter] { mid, status, page, pageSize }
   * @returns {{items:Array, total:number, page:number, pageSize:number}}
   */
  listRecords(filter) {
    filter = filter || {};
    let items = this._fs().listAllHighrisk({});
    if (filter.mid) items = items.filter((x) => x.machineId === filter.mid);
    if (filter.status) items = items.filter((x) => x.status === filter.status);
    items.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(filter.pageSize, 10) || 50));
    const total = items.length;
    const startIdx = (page - 1) * pageSize;
    return { items: items.slice(startIdx, startIdx + pageSize), total, page, pageSize };
  }
}

module.exports = { OpsHighrisk, LEVELS };
