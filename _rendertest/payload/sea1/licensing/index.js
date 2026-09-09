'use strict';
/**
 * index.js — sea1 授权门禁 LicenseGate
 *
 * 设计目标（见 ACTIVATION_SYSTEM_DESIGN.md）：
 * - 默认关闭（enabled=false）→ 完全无感，开源版零行为变化。
 * - 开启后：读取持久化机器码 → 加载并验签 license → 按 features 放行命令。
 * - 心跳失败超过宽限期 → 进入只读降级模式（不丢数据）。
 * - 单文件集成：sea1 在启动时 require 本模块，调用 init()/checkFeature()/middleware()。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getMachineId, hostFingerprint } = require('./lib/machineId');
const { verifyLicense } = require('./lib/verify');
const { sendHeartbeat } = require('./lib/heartbeat');

// 降级/演示模式下仅允许只读类命令；vip（开通/付费/激活）必须始终可用，否则用户无法解锁
const READONLY_FEATURES = ['menu', 'help', 'queue', 'status', 'ping', 'vip'];

class LicenseGate {
  /**
   * @param {object} cfg
   * @param {boolean} [cfg.enabled=false]
   * @param {string}  [cfg.licensePath]
   * @param {string}  [cfg.machineIdPath]
   * @param {string}  [cfg.activationServer]
   * @param {string}  [cfg.publicKey]  PEM 字符串（优先）
   * @param {string}  [cfg.publicKeyPath]  PEM 文件路径
   * @param {number}  [cfg.graceDays=7]
   */
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      enabled: false,
      graceDays: 7,
      trialDays: 0,            // 默认 0 = 不启用试用（保持「无 license → 只读」安全网）；商用部署显式开启
    }, cfg);
    this.enabled = !!this.cfg.enabled;
    this.active = false;        // license 是否有效（或试用期内为真）
    this.degraded = false;      // 是否进入降级/只读
    this.license = null;
    this.machine = null;
    this.publicKey = null;
    this.status = this.enabled ? 'PENDING' : 'OPENSOURCE';
    this.lastHeartbeat = null;  // {at, valid, reason}
    this.trialExpired = false;  // 试用是否已到期（用于触发提醒）
    this.trialActive = false;   // 是否处于试用窗口（全功能放开）
    this._hbTimer = null;
  }

  /**
   * 试用状态（本地持久化起点，离线也可 Enforcement）。
   * 返回 { active, expired, remaining_ms, end, start }。
   */
  _trialStatus() {
    const trialDays = this.cfg.trialDays || 0;
    if (trialDays <= 0) {
      // 未配置试用 → 永久视为已过期（即无 license 保持只读安全网）
      return { active: false, expired: true, remaining_ms: 0, end: 0, start: 0, path: null };
    }
    let trialPath = this.cfg.trialPath;
    if (!trialPath) {
      const base = this.cfg.machineIdPath
        ? path.dirname(this.cfg.machineIdPath)
        : (this.cfg.licensePath ? path.dirname(this.cfg.licensePath) : os.tmpdir());
      trialPath = path.join(base, 'trial.json');
    }
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(trialPath, 'utf8')); } catch (e) { /* 无记录 */ }
    if (!rec || typeof rec.start !== 'number') {
      rec = { start: Date.now() };
      try { fs.mkdirSync(path.dirname(trialPath), { recursive: true }); fs.writeFileSync(trialPath, JSON.stringify(rec)); } catch (e) { /* 忽略 */ }
    }
    const end = rec.start + trialDays * 86400000;
    const now = Date.now();
    const expired = now >= end;
    return { active: !expired, expired, remaining_ms: Math.max(0, end - now), end, start: rec.start, path: trialPath };
  }

  _loadPublicKey() {
    if (this.cfg.publicKey) return this.cfg.publicKey;
    if (this.cfg.publicKeyPath) {
      return fs.readFileSync(this.cfg.publicKeyPath, 'utf8');
    }
    throw new Error('未配置 publicKey 或 publicKeyPath');
  }

  /**
   * 初始化。关闭状态下直接返回无感门禁。
   */
  init() {
    if (!this.enabled) {
      this.status = 'OPENSOURCE';
      return this._openSourceApi();
    }
    try {
      this.machine = getMachineId(this.cfg.machineIdPath);

      // 无 license → 试用窗口判定（试用不需要公钥，先于公钥加载）
      if (!this.cfg.licensePath || !fs.existsSync(this.cfg.licensePath)) {
        const tr = this._trialStatus();
        const trialOn = (this.cfg.trialDays || 0) > 0;
        if (tr.active) {
          // 试用期内：全功能放开（但不标记为正式 ACTIVE）
          this.active = true;
          this.trialActive = true;
          this.degraded = false;
          this.trialExpired = false;
          this.status = 'TRIAL_ACTIVE';
          this._trial = tr;
          return this._api();
        }
        // 无 license 且非试用中：只读降级
        this.active = false;
        this.trialActive = false;
        this.degraded = true;
        this.trialExpired = trialOn && tr.expired; // 仅真的试用到期才触发提醒
        this.status = trialOn ? 'TRIAL_EXPIRED' : 'DEMO_NO_LICENSE';
        this._trial = tr;
        return this._api();
      }

      // 有 license 文件 → 加载公钥并验签
      this.publicKey = this._loadPublicKey();
      const fp = hostFingerprint(); // 仅审计/异常检测，不绑定授权
      this._hostFp = fp;

      const lic = JSON.parse(fs.readFileSync(this.cfg.licensePath, 'utf8'));
      if (this.machine.machineId !== lic.machine_id) {
        // 机器码不符 → 可能是移植/文件被挪；进入只读并提示重新激活
        this.active = false;
        this.degraded = true;
        this.status = 'MACHINE_MISMATCH';
        return this._api();
      }
      const v = verifyLicense(this.publicKey, lic);
      if (!v.ok) {
        this.active = false;
        this.degraded = true;
        this.status = 'LICENSE_INVALID:' + v.reason;
        return this._api();
      }
      this.active = true;
      this.degraded = false;
      this.license = lic;
      this.status = 'ACTIVE';
      return this._api();
    } catch (e) {
      // 任何异常都不应让 bot 崩溃；降级为只读并上报
      this.active = false;
      this.degraded = true;
      this.status = 'INIT_ERROR:' + (e && e.message || e);
      return this._api();
    }
  }

  _allow(feature) {
    if (!this.enabled) return true;                 // 开源：全放行
    if (this.trialActive) return true;              // 试用期内全放开（无 license，不可读 features）
    if (this.active && this.license) {
      if (this.license.features.includes('*')) return true; // 通配：授权全部模块
      return this.license.features.includes(feature);
    }
    return READONLY_FEATURES.includes(feature);     // 降级/演示：仅只读
  }

  _openSourceApi() {
    return {
      enabled: false,
      status: this.status,
      active: true,
      degraded: false,
      checkFeature: (f) => true,
      isDegraded: () => false,
      middleware: () => ({ allow: true }),
      getStatus: () => ({ enabled: false, status: 'OPENSOURCE', active: true, degraded: false }),
      startHeartbeat: () => {},
      stopHeartbeat: () => {},
    };
  }

  _api() {
    const self = this;
    return {
      enabled: self.enabled,
      status: self.status,
      active: self.active,
      degraded: self.degraded,
      checkFeature: (f) => self._allow(f),
      isDegraded: () => self.degraded,
      middleware: (f) => {
        const allow = self._allow(f);
        return { allow, reason: allow ? null : (self.active ? 'feature-disabled' : 'read-only-mode') };
      },
      getStatus: () => self.getStatus(),
      startHeartbeat: (ms) => self.startHeartbeat(ms),
      stopHeartbeat: () => self.stopHeartbeat(),
    };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      status: this.status,
      active: this.active,
      degraded: this.degraded,
      trial_expired: this.trialExpired,
      trial: this._trial ? {
        expired: this._trial.expired,
        remaining_ms: this._trial.remaining_ms,
        end: this._trial.end,
      } : null,
      machine_id: this.machine ? this.machine.machineId : null,
      code: this.license ? this.license.code : null,
      features: this.license ? this.license.features : null,
      expires_at: this.license ? this.license.expires_at : null,
      lastHeartbeat: this.lastHeartbeat,
      host_fingerprint: this._hostFp || null,
    };
  }

  /** 给机器人用的试用状态快照 */
  getTrialStatus() {
    const tr = this._trial || (this.enabled ? this._trialStatus() : null);
    if (!tr) return null;
    return {
      enabled: this.enabled,
      trial_expired: this.trialExpired,
      expired: tr.expired,
      remaining_ms: tr.remaining_ms,
      remaining_days: Math.ceil(tr.remaining_ms / 86400000),
      end: tr.end,
      status: this.status,
    };
  }

  /**
   * 启动周期心跳。仅在 enabled 且有 license 时联网。
   * @param {number} [intervalMs] 默认 24h
   */
  startHeartbeat(intervalMs) {
    if (!this.enabled || !this.active) return;
    const interval = intervalMs || 24 * 3600 * 1000;
    const tick = async () => {
      if (!this.cfg.activationServer || !this.license) return;
      const res = await sendHeartbeat(this.cfg.activationServer, {
        machine_id: this.machine.machineId,
        code: this.license.code,
      });
      this.lastHeartbeat = { at: Math.floor(Date.now() / 1000), ...res };
      if (!res.valid) {
        // 被吊销/过期/机器不符 → 立即降级
        this.active = false;
        this.degraded = true;
        this.status = 'HEARTBEAT_INVALID:' + res.reason;
      }
    };
    this._hbTimer = setInterval(tick, interval);
    if (this._hbTimer.unref) this._hbTimer.unref();
    tick(); // 立即先跳一次
  }

  stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }
}

module.exports = { LicenseGate, READONLY_FEATURES };
