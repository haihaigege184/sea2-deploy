'use strict';
/**
 * index.js — sea2 授权门禁 LicenseGate（sea1/licensing 基准 clone + sea2 扩展）
 *
 * 相对 sea1 版本（T03 sea2 客户端能力扩展，§2.3 / §3.1 / §4.2）：
 *  - _fleetCtx 新增 sea2 钩子接线：onPm2Ops / onCupsOps / onFormat；
 *  - 登录中间页启动：cfg.fleet.loginGate 配置存在时启动本地 localhost 服务；
 *  - 心跳 v2：startHeartbeat 注入 pm2_processes / cups / login_info 真实采集，
 *    采集失败按「脏数据降级」如实上报空值，绝不伪造；
 *  - 试用心跳（T03 §9.4.3）：tick 去掉 license 门槛，无 license 时 code='' 并携带
 *    trial:true + trial_info；响应 valid=false 且试用中不降级（试用到期由 active 门槛自然停跳）。
 *  - 热重载 + 自愈重激活（T06）：startLicenseWatch 周期巡检 licensePath——
 *    文件出现/内容变化 → 重新验签应用转正式（trialActive=false），心跳自然带 code；
 *    license 缺失但有 client-code（cfg.code / cfg.license.code / 独立文件）→ 周期
 *    POST /api/activate 自愈（失败 5 分钟退避，不阻塞主流程）；无 code 不联网。
 *
 * 设计目标（见 ACTIVATION_SYSTEM_DESIGN.md）：
 * - 默认关闭（enabled=false）→ 完全无感，开源版零行为变化。
 * - 开启后：读取持久化机器码 → 加载并验签 license → 按 features 放行命令。
 * - 心跳失败超过宽限期 → 进入只读降级模式（不丢数据）。
 * - 单文件集成：宿主在启动时 require 本模块，调用 init()/checkFeature()/middleware()。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getMachineId, hostFingerprint } = require('./lib/machineId');
const { verifyLicense } = require('./lib/verify');
const { sendHeartbeat, buildHeartbeatPayload, ACK_RESULTS_MAX } = require('./lib/heartbeat');
const { handleCommand, killsProcess } = require('./lib/command-handler');
const { AckStore } = require('./lib/ack-store');
// sea2 能力模块（以「存在才调用」注入；未挂载的指令在 command-handler 层如实回 unsupported）
const pm2Ctl = require('./lib/pm2-ctl');
const cupsFull = require('./lib/cups-full');
const formatCtl = require('./lib/format-ctl');
const { LoginGate } = require('./lib/login-gate');

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
   * @param {object}  [cfg.fleet] 宿主注入的 fleet 上下文（sea2 钩子/登录页/采集器）
   */
  constructor(cfg = {}) {
    this.cfg = Object.assign({
      enabled: false,
      graceDays: 7,
      trialDays: 0,            // 默认 0 = 不启用试用（保持「无 license → 只读」安全网）；商用部署显式开启
      licenseWatchIntervalMs: 30000, // T06：热重载/自愈巡检周期（默认 30s）
      activateRetryMs: 300000,       // T06：自愈重激活失败退避（默认 5 分钟）
      activateTimeoutMs: 8000,       // T06：/api/activate 请求超时
      clientCodePath: '',            // T06：独立 client-code 文件路径（缺省自动推导；亦可 cfg.code / cfg.license.code）
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
    // T06：热重载 + 自愈重激活
    this._watchTimer = null;      // 巡检定时器
    this._watchRunning = false;   // 巡检重入保护
    this._licenseMtimeMs = 0;     // license 文件上次 mtime（变化检测）
    this._nextActivateAt = 0;     // 下次允许自愈重激活的时间戳（失败退避）
    // 注入的 PrintPlugin / fleet 上下文（由 host 通过 cfg.fleet 提供）
    const fleetCfg = (cfg && cfg.fleet) || {};
    this._printPlugin = fleetCfg.printPlugin || null;
    this._fleetLogger = fleetCfg.logger || null;
    // 回执队列：必须落盘。重启类指令会在下次心跳前把进程干掉，
    // 内存队列会连同回执一起消失，服务端只能等超时——运维因此看不出重启到底成没成。
    this._ackStore = new AckStore(this._ackStorePath(), { logger: this._fleetLogger });
    // sea2：登录中间页实例（懒加载）
    this._loginGate = null;
    this._loginGateCfg = fleetCfg.loginGate || null;
  }

  /**
   * 回执队列文件路径。默认与 machineId 同目录，便于随客户端数据一起备份/清理。
   * @returns {string}
   */
  _ackStorePath() {
    if (this.cfg.ackStorePath) return this.cfg.ackStorePath;
    const base = this.cfg.machineIdPath
      ? path.dirname(this.cfg.machineIdPath)
      : path.join(os.homedir(), '.sea1');
    return path.join(base, 'fleet-acks.json');
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
          this._ensureLoginGate();
          return this._api();
        }
        // 无 license 且非试用中：只读降级
        this.active = false;
        this.trialActive = false;
        this.degraded = true;
        this.trialExpired = trialOn && tr.expired; // 仅真的试用到期才触发提醒
        this.status = trialOn ? 'TRIAL_EXPIRED' : 'DEMO_NO_LICENSE';
        this._trial = tr;
        this._ensureLoginGate();
        return this._api();
      }

      // 有 license 文件 → 加载公钥并验签（应用语义收敛到 _applyLicense，
      // 热重载/自愈共用同一套逻辑，保证「已有 license 时行为不变」）
      this.publicKey = this._loadPublicKey();
      const fp = hostFingerprint(); // 仅审计/异常检测，不绑定授权
      this._hostFp = fp;

      const lic = JSON.parse(fs.readFileSync(this.cfg.licensePath, 'utf8'));
      this._applyLicense(lic);
      this._ensureLoginGate();
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
      startLicenseWatch: () => {},
      stopLicenseWatch: () => {},
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
      // T06：热重载 + 自愈重激活（宿主可显式调用；startHeartbeat 内部也会自动挂载）
      startLicenseWatch: (ms) => self.startLicenseWatch(ms),
      stopLicenseWatch: () => self.stopLicenseWatch(),
      // sea2 扩展：对外暴露能力模块实例（供宿主取用/审计）
      pm2Ctl: self._pm2Ctl(),
      cupsFull: self._cupsFull(),
      formatCtl: self._formatCtl(),
      loginGate: self._ensureLoginGate(),
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
      pending_acks: this._ackStore ? this._ackStore.size() : 0,
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

  // ================= sea2 能力模块（懒加载单例） =================

  /** @returns {object} pm2-ctl 模块实例（Sea2Pm2Ctl） */
  _pm2Ctl() {
    return pm2Ctl;
  }

  /** @returns {object} cups-full 模块实例（Sea2CupsFull） */
  _cupsFull() {
    return cupsFull;
  }

  /** @returns {object} format-ctl 模块实例（Sea2FormatCtl） */
  _formatCtl() {
    return formatCtl;
  }

  /**
   * 登录中间页（懒加载单例；cfg.fleet.loginGate 配置存在才启动本地服务）。
   * @returns {LoginGate|null}
   */
  _ensureLoginGate() {
    if (this._loginGate) return this._loginGate;
    if (!this._loginGateCfg) return null;
    const opts = Object.assign({}, this._loginGateCfg);
    this._loginGate = new LoginGate(opts);
    // 登录中间页默认启动（autoStart 默认 true）；宿主可显式关闭
    if (opts.autoStart !== false) {
      this._loginGate.start();
    }
    return this._loginGate;
  }

  /**
   * 组装 fleet 指令执行上下文（来自 cfg.fleet + sea2 能力模块）。
   * 钩子全部 optional：没挂的指令会如实回 unsupported，绝不伪造成功。
   * @returns {object}
   */
  _fleetCtx() {
    const f = (this.cfg && this.cfg.fleet) || {};
    return {
      printPlugin: this._printPlugin || f.printPlugin,
      logger: this._fleetLogger || f.logger || console,
      // 钩子全部 optional：没挂的指令会如实回 unsupported，绝不伪造成功
      onHealthCheck: f.onHealthCheck,
      onRestart: f.onRestart,
      onRestartBot: f.onRestartBot,
      onRestartNapcat: f.onRestartNapcat,
      onDisableClient: f.onDisableClient,
      onEnableClient: f.onEnableClient,
      onDisablePrinter: f.onDisablePrinter,
      onEnablePrinter: f.onEnablePrinter,
      onClearPrintQueue: f.onClearPrintQueue,
      onNotice: f.onNotice,
      onConfig: f.onConfig,
      // sea2：能力模块实例（存在才调用；宿主可用 cfg.fleet.onPm2Ops 等覆盖注入）
      onPm2Ops: f.onPm2Ops || this._pm2Ctl(),
      onCupsOps: f.onCupsOps || this._cupsFull(),
      onFormat: f.onFormat || this._formatCtl(),
      onLoginGate: f.onLoginGate || this._ensureLoginGate(),
      // T05：P4 本地确认词 / disk 档目标盘 / 整盘擦除实现（均由宿主经 cfg.fleet 注入，默认缺省）
      localConfirmWord: f.localConfirmWord,
      formatDiskTarget: f.formatDiskTarget,
      formatWipeFn: f.formatWipeFn,
    };
  }

  /**
   * sea2 心跳 v2 富化采集（§3.2）：
   *  - pm2_processes：Sea2Pm2Ctl.list()
   *  - cups：Sea2CupsFull.info()
   *  - login_info：LoginGate.status()
   * 采集失败/未挂载 → 返回空值兜底（脏数据降级），绝不伪造、绝不阻断心跳。
   * @returns {Promise<{pm2Processes:Array, cups:object, loginInfo:object}>}
   */
  async _collectHeartbeatExtras() {
    const out = { pm2Processes: [], cups: null, loginInfo: null };
    const ctx = this._fleetCtx();
    try {
      if (ctx.onPm2Ops && typeof ctx.onPm2Ops.list === 'function') {
        const r = await ctx.onPm2Ops.list();
        if (r && r.ok && Array.isArray(r.processes)) out.pm2Processes = r.processes;
      }
    } catch (e) {
      // 降级：保持空数组
    }
    try {
      if (ctx.onCupsOps && typeof ctx.onCupsOps.info === 'function') {
        const r = await ctx.onCupsOps.info();
        if (r && typeof r === 'object') out.cups = r;
      }
    } catch (e) {
      // 降级：保持 null
    }
    try {
      if (ctx.onLoginGate && typeof ctx.onLoginGate.status === 'function') {
        out.loginInfo = await ctx.onLoginGate.status();
      }
    } catch (e) {
      // 降级：保持 null
    }
    return out;
  }

  /**
   * 执行服务端下发的指令，执行成功的收集 ack id 供下次心跳回执。
   * @param {Array<{id:string, action:string, payload?:object, issued_at?:number}>} commands
   * @returns {Promise<void>}
   */
  async _runCommands(commands) {
    if (!Array.isArray(commands) || !commands.length) return;
    const ctx = this._fleetCtx();
    const warn = (m) => ((ctx.logger && ctx.logger.warn) ? ctx.logger.warn(m) : console.warn(m));

    for (const cmd of commands) {
      if (!cmd || !cmd.id) continue;

      // 重启类指令：先把「已受理」落盘，再执行。
      // 钩子一旦真的重启进程，后面的代码就不会再执行了——
      // 这条预写记录是服务端唯一能拿到的凭据，否则指令会一直挂到超时。
      if (killsProcess(cmd.action)) {
        this._ackStore.add({
          id: cmd.id,
          action: cmd.action,
          ok: true,
          result: { note: 'restart-dispatched' },
        });
      }

      const outcome = await handleCommand(cmd, ctx);

      // 成功与失败都要回执：失败回执才是修复「虚假成功」的关键——
      // 服务端据此把指令落成 failed / unsupported，而不是无声无息地等超时。
      this._ackStore.add({
        id: cmd.id,
        action: cmd.action,
        ok: !!outcome.ok,
        error: outcome.ok ? '' : (outcome.detail || outcome.error || 'unknown'),
        result: outcome.result,
      });

      if (!outcome.ok) {
        warn(`[fleet] 指令未成功 ${cmd.action}: ${outcome.error}${outcome.detail ? '（' + outcome.detail + '）' : ''}`);
      }
    }
  }

  /**
   * 启动周期心跳。仅在 enabled 且 active 时联网。
   * sea2 心跳 v2：注入 pm2_processes / cups / login_info。
   * T03（§9.4.3）：去掉 license 门槛——试用期（active=true、无 license）也发心跳，
   * 携带 code='' + trial:true + trial_info；试用到期后 active=false，本函数门槛自然停跳。
   * @param {number} [intervalMs] 默认 60s（可由 cfg.heartbeatIntervalMs 覆盖）
   */
  startHeartbeat(intervalMs) {
    if (!this.enabled) return;
    // T06：热重载/自愈巡检与心跳同处启动（watch 内部防重入）。
    // active=false（如 DEMO_NO_LICENSE/试用到期）也要启动巡检，否则「无 license 待自愈」场景收不到周期尝试。
    this.startLicenseWatch();
    if (!this.active) return;
    const interval = intervalMs || this.cfg.heartbeatIntervalMs || 60000;
    const tick = async () => {
      // T03（§9.4.3①）：去掉 license 门槛——试用期无 license 也要发心跳（带 trial:true）。
      // 由 startHeartbeat 的 active 门槛兜底：试用到期后 active=false 自然停跳。
      if (!this.cfg.activationServer) return;
      const fleet = (this.cfg && this.cfg.fleet) || {};
      // 取本轮要上报的回执快照：只有心跳成功返回后才把它们从队列里移除，
      // 否则网络抖动会让回执静默丢失（宁可重复上报，服务端有终态保护）。
      const ackResults = this._ackStore.pending(ACK_RESULTS_MAX);
      try {
        // sea2 心跳 v2：采集 pm2/cups/login 能力快照（失败降级为空，绝不阻断）
        const extras = await this._collectHeartbeatExtras();
        // T03（§9.4.3②③）：无 license 时 code 为空串；试用中带 trial:true + 本地 trial_info。
        // trial_info 仅在试用期携带：正式授权心跳不附带「未过期/已过期」的误导性试用记录。
        const trialInfo = this.trialActive ? this._trialStatus() : null;
        const payload = await buildHeartbeatPayload({
          machineId: this.machine.machineId,
          code: this.license ? this.license.code : '',
          trial: this.trialActive,
          trialInfo,
          ackResults,
          pm2Processes: extras.pm2Processes,
          cups: extras.cups,
          loginInfo: extras.loginInfo,
          extra: {
            printPlugin: this._printPlugin || fleet.printPlugin,
            publicIp: fleet.publicIp,
            region: fleet.region,
            online: true,
          },
        });
        const res = await sendHeartbeat(this.cfg.activationServer, payload);
        // 心跳成功 = 服务端已收下这批回执，可以安全出队
        if (res.ok && ackResults.length) {
          this._ackStore.confirm(ackResults.map((r) => r.id));
        }
        // 执行下发的远程指令（结果进队列，随下一次心跳上报）
        if (res.commands && res.commands.length) {
          await this._runCommands(res.commands);
        }
        this.lastHeartbeat = { at: Math.floor(Date.now() / 1000), ...res };
        // T03（§9.4.3④）：试用心跳服务端必然回 valid=false（reason='trial-active'），
        // 试用中不因此降级；非试用（正式授权失效/试用到期）才按原逻辑降级。
        if (!res.valid && !this.trialActive) {
          // 被吊销/过期/机器不符 → 立即降级
          this.active = false;
          this.degraded = true;
          this.status = 'HEARTBEAT_INVALID:' + res.reason;
        }
      } catch (e) {
        // 心跳异常不应影响主流程；仅记录
        if (fleet.logger && fleet.logger.error) fleet.logger.error('[fleet] 心跳异常: ' + (e && e.message || e));
        else console.error('[fleet] 心跳异常: ' + (e && e.message || e));
      }
    };
    this._hbTimer = setInterval(tick, interval);
    if (this._hbTimer.unref) this._hbTimer.unref();
    tick(); // 立即先跳一次
  }

  stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  // ================= T06：热重载 + 自愈重激活 =================

  /**
   * 启动周期巡检（热重载 + 自愈重激活）。
   * 与 startHeartbeat 同处启动（startHeartbeat 内部已自动挂载，也可经 api 显式调用）。
   *  - 每 licenseWatchIntervalMs（默认 30s）巡检一次；
   *  - license 文件出现/变化 → 重新验签应用（trialActive=false），心跳自然转正式（带 code）；
   *  - license 缺失但有 client-code → 周期 POST /api/activate 自愈（失败退避 activateRetryMs，默认 5 分钟）；
   *  - 无 client-code → 不尝试联网；
   *  - 已有 license 且内容未变 → 零动作（行为不变）。
   * @param {number} [watchIntervalMs] 巡检间隔（缺省 cfg.licenseWatchIntervalMs，默认 30s）
   */
  startLicenseWatch(watchIntervalMs) {
    if (!this.enabled) return;
    if (this._watchTimer) return; // 防重复启动
    const interval = watchIntervalMs || this.cfg.licenseWatchIntervalMs || 30000;
    const tick = async () => {
      if (this._watchRunning) return; // 防重入：上一次巡检未结束则跳过本轮
      this._watchRunning = true;
      try {
        await this._licenseWatchTick();
      } catch (e) {
        // 巡检异常绝不阻断主流程，仅记录
        const logger = (this.cfg.fleet && this.cfg.fleet.logger) || null;
        const msg = '[license-watch] 巡检异常: ' + (e && e.message || e);
        if (logger && logger.error) logger.error(msg);
        else console.error(msg);
      } finally {
        this._watchRunning = false;
      }
    };
    this._watchTimer = setInterval(tick, interval);
    if (this._watchTimer.unref) this._watchTimer.unref();
    tick(); // 立即先巡检一次（尽早自愈，不必等满一个周期）
  }

  /** 停止周期巡检。 */
  stopLicenseWatch() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
  }

  /**
   * 单轮巡检：① license 存在 → 变化检测 + 热重载；② license 缺失 → 自愈重激活。
   * @returns {Promise<void>}
   */
  async _licenseWatchTick() {
    // ① license 文件存在 → 热重载（mtime/内容变化才重载；内容一致零动作）
    if (this.cfg.licensePath && fs.existsSync(this.cfg.licensePath)) {
      if (this._licenseFileChanged()) {
        this._applyLicenseFromFile();
      }
      return;
    }

    // ② license 文件缺失 → 自愈
    const code = this._clientCode();
    if (!code) {
      // 无 client-code：若内存仍有 license（文件被删/被挪）→ 从内存恢复落盘，避免重启回退试用/降级
      if (this.license) {
        const ok = this._writeLicenseFile(this.license);
        if (ok) this._logWatch('license 文件缺失且无 client-code，已从内存恢复落盘');
      }
      return; // 无 client-code 不尝试联网
    }
    // 有 client-code：退避窗口内不重复请求（失败默认 5 分钟；成功清零）
    if (this._nextActivateAt && Date.now() < this._nextActivateAt) return;
    const r = await this._selfHealActivate();
    this._nextActivateAt = r.ok ? 0 : (Date.now() + (this.cfg.activateRetryMs || 300000));
  }

  /**
   * license 文件变化检测：mtime 变化 + 内容比对。
   * 仅当 mtime 变了 且 磁盘内容与内存 license 不一致时判定为「变化」，
   * 避免「重写相同内容 / 启动首检」触发无谓重载。
   * @returns {boolean}
   */
  _licenseFileChanged() {
    let st;
    try { st = fs.statSync(this.cfg.licensePath); } catch (e) { return false; }
    if (this._licenseMtimeMs === st.mtimeMs) return false; // mtime 未变 → 无变化
    this._licenseMtimeMs = st.mtimeMs;
    return !this._licenseSameAsDisk();
  }

  /**
   * 磁盘 license 内容与内存 license 是否一致（序列化比对）。
   * @returns {boolean}
   */
  _licenseSameAsDisk() {
    if (!this.license) return false;
    try {
      const disk = JSON.parse(fs.readFileSync(this.cfg.licensePath, 'utf8'));
      return JSON.stringify(disk) === JSON.stringify(this.license);
    } catch (e) {
      return false;
    }
  }

  /**
   * 重新读取 license 文件并应用（热重载入口）。
   * 文件缺失/解析失败 → 如实返回失败，不覆盖当前状态；由下次巡检再试。
   * @returns {{ok:boolean, error?:string, status?:string}}
   */
  _applyLicenseFromFile() {
    if (!this.cfg.licensePath || !fs.existsSync(this.cfg.licensePath)) {
      return { ok: false, error: 'no-license-file' };
    }
    let lic;
    try {
      lic = JSON.parse(fs.readFileSync(this.cfg.licensePath, 'utf8'));
    } catch (e) {
      this._logWatch('license 文件解析失败: ' + (e && e.message || e));
      return { ok: false, error: 'bad-json' };
    }
    const applied = this._applyLicense(lic);
    this._logWatch(applied.ok
      ? ('热重载: license 已应用 → ' + this.status)
      : ('热重载失败: ' + (applied.error || applied.status)));
    return applied;
  }

  /**
   * 应用 license 到内存状态（init / 热重载 / 自愈共用，单点语义）。
   * 与 init()「有 license 文件」分支完全一致：
   *   机器码不符 → MACHINE_MISMATCH；验签失败 → LICENSE_INVALID:<reason>；
   *   成功 → ACTIVE（刷新 license/active/degraded/trialActive/trialExpired）。
   * @param {object} lic 待应用 license（须含 signature）
   * @returns {{ok:boolean, error?:string, status:string}}
   */
  _applyLicense(lic) {
    if (!this.publicKey) {
      // 热重载/自愈路径可能未经过 init() 的公钥加载分支（如试用态起步），此处兜底加载
      try {
        this.publicKey = this._loadPublicKey();
      } catch (e) {
        this.active = false;
        this.degraded = true;
        this.trialActive = false;
        this.status = 'LICENSE_INVALID:' + (e && e.message || e);
        return { ok: false, error: 'no-public-key', status: this.status };
      }
    }
    if (this.machine && lic && this.machine.machineId !== lic.machine_id) {
      // 机器码不符（含 license 缺 machine_id，与 init() 原判定一致）→ 只读并提示重新激活
      this.active = false;
      this.degraded = true;
      this.trialActive = false;
      this.trialExpired = false;
      this.status = 'MACHINE_MISMATCH';
      return { ok: false, error: 'machine-mismatch', status: this.status };
    }
    const v = verifyLicense(this.publicKey, lic);
    if (!v.ok) {
      this.active = false;
      this.degraded = true;
      this.trialActive = false;
      this.trialExpired = false;
      this.status = 'LICENSE_INVALID:' + v.reason;
      return { ok: false, error: v.reason, status: this.status };
    }
    this.active = true;
    this.degraded = false;
    this.trialActive = false;
    this.trialExpired = false;
    this.license = lic;
    this.status = 'ACTIVE';
    return { ok: true, status: 'ACTIVE' };
  }

  /**
   * license 落盘（mkdir -p + 0600）。
   * @param {object} lic
   * @returns {boolean} 是否成功
   */
  _writeLicenseFile(lic) {
    if (!this.cfg.licensePath) return false;
    try {
      fs.mkdirSync(path.dirname(this.cfg.licensePath), { recursive: true });
      fs.writeFileSync(this.cfg.licensePath, JSON.stringify(lic, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      this._logWatch('license 落盘失败: ' + (e && e.message || e));
      return false;
    }
  }

  /**
   * 解析本地持久化激活码（client-code）。
   * 优先级：cfg.code → cfg.license.code → 独立 client-code 文件（cfg.clientCodePath 或自动推导路径）。
   * @returns {string|null}
   */
  _clientCode() {
    if (typeof this.cfg.code === 'string' && this.cfg.code.trim()) return this.cfg.code.trim();
    if (this.cfg.license && typeof this.cfg.license.code === 'string' && this.cfg.license.code.trim()) {
      return this.cfg.license.code.trim();
    }
    const p = this._clientCodePath();
    if (!p) return null;
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      return v || null;
    } catch (e) {
      return null; // 文件不存在/不可读 → 视为无 code
    }
  }

  /**
   * 独立 client-code 文件路径（缺省与 ackStore/trial 同基准：machineIdPath 同目录）。
   * 生产可经 cfg.clientCodePath 显式指定（如 /root/sea2/client-code）。
   * @returns {string}
   */
  _clientCodePath() {
    if (this.cfg.clientCodePath) return this.cfg.clientCodePath;
    const base = this.cfg.machineIdPath
      ? path.dirname(this.cfg.machineIdPath)
      : (this.cfg.licensePath ? path.dirname(this.cfg.licensePath) : path.join(os.homedir(), '.sea1'));
    return path.join(base, 'client-code');
  }

  /**
   * 自愈重激活：POST /api/activate {code, machine_id}。
   * 服务端若 active 会返回 license → 落盘 → 应用转正式（trialActive=false）。
   * 失败（网络/被拒/机器不符）→ 返回 {ok:false, reason}，由调用方退避。
   * 全程异步、不抛异常，绝不阻塞主流程。
   * @returns {Promise<{ok:boolean, reason?:string, license?:object}>}
   */
  async _selfHealActivate() {
    const code = this._clientCode();
    if (!code) return { ok: false, reason: 'no-client-code' };
    const serverUrl = String(this.cfg.activationServer || '').replace(/\/+$/, '');
    if (!serverUrl) return { ok: false, reason: 'no-activation-server' };
    const doFetch = this.cfg.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    if (typeof doFetch !== 'function') return { ok: false, reason: 'no-fetch' };
    const machineId = this.machine
      ? this.machine.machineId
      : getMachineId(this.cfg.machineIdPath).machineId;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.activateTimeoutMs || 8000);
    try {
      const res = await doFetch(serverUrl + '/api/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, machine_id: machineId }),
        signal: ctrl.signal,
      });
      const j = res && typeof res.json === 'function' ? await res.json().catch(() => ({})) : {};
      if (res && res.ok && j && j.ok && j.license) {
        const lic = j.license;
        // 落盘前机器码校验：服务端异常返回他机 license 时拒绝落盘（防污染 license 文件）
        if (lic && lic.machine_id != null && this.machine && lic.machine_id !== this.machine.machineId) {
          this._logWatch('自愈重激活返回 license 机器码不匹配，拒绝落盘');
          return { ok: false, reason: 'machine-mismatch' };
        }
        const written = this._writeLicenseFile(lic);
        // 落盘后立即应用：转正式（trialActive=false），心跳自然带 code 转正式
        const applied = this._applyLicense(lic);
        this._logWatch('自愈重激活成功（written=' + written + '）→ ' + this.status);
        return { ok: true, license: lic, written, applied };
      }
      const reason = (j && j.error) || ('http-' + (res && res.status || 'unknown'));
      this._logWatch('自愈重激活被拒: ' + reason);
      return { ok: false, reason };
    } catch (e) {
      this._logWatch('自愈重激活网络失败: ' + (e && e.message || e));
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(t);
    }
  }

  /** T06 巡检日志（优先 fleet.logger，缺省 console）。 */
  _logWatch(msg) {
    const logger = (this.cfg.fleet && this.cfg.fleet.logger) || null;
    if (logger && typeof logger.info === 'function') logger.info('[license-watch] ' + msg);
    else if (logger && typeof logger.log === 'function') logger.log('[license-watch] ' + msg);
    else console.log('[license-watch] ' + msg);
  }
}

module.exports = { LicenseGate, READONLY_FEATURES };
