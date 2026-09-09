'use strict';
/**
 * command-handler.js — sea2 客户端远程指令本地执行器（FLEET pull 模式消费端）
 *
 * 服务端通过心跳响应的 commands[] 下发指令，客户端在本模块本地执行，
 * 执行结果由调用方（LicenseGate）写入持久化回执队列，随下次心跳以 ack_results 上报。
 *
 * ── 本次改造修复的核心缺陷（P0-5「虚假成功」）──
 * 旧实现在**未挂载钩子**时只打一行日志就 `return {ok:true}`，
 * 服务端据此把指令标记为 acked。运维在控制台看到「已确认」，实际客户端什么都没干。
 * 这是最坏的一类 bug：它让监控系统主动说谎。
 *
 * 新契约（与服务端 lib/fleetCommands.js 单一事实来源对齐）：
 *   未挂钩子 且 无安全的内置实现  ⇒  {ok:false, error:'unsupported'}
 *   调用方据此**不得**把它当作成功，服务端会落成 unsupported 状态。
 *
 * ── sea2 新增 9 条指令（§3.4，总指令 11+9=20）──
 *   进程   pm2_list / pm2_restart / pm2_stop / pm2_start / pm2_logs
 *   打印   cups_info / cups_set_printer / cups_add_printer
 *   高危   format_device
 *
 * 实现方式：新指令通过 ctx 注入的钩子对象执行——
 *   ctx.onPm2Ops  （Sea2Pm2Ctl 实例：list/restart/stop/start/logs）
 *   ctx.onCupsOps （Sea2CupsFull 实例：info/listPrinters/addPrinter/setPrinter）
 *   ctx.onFormat  （Sea2FormatCtl 实例：execute）
 * 未挂载对应钩子 ⇒ 如实回 unsupported，绝不伪造成功。
 *
 * 设计原则：不直接耦合机器人业务，副作用一律通过 ctx 回调/实例注入完成；
 * 任何异常都被捕获为 {ok:false}，绝不让指令执行拖垮客户端进程。
 */

const { getSysInfo } = require('./sysinfo');
const { getPrinters } = require('./printer-provider');

/**
 * 指令规格表。与服务端 lib/fleetCommands.js 的 action 集合严格一致。
 *   hook        期望的 ctx 钩子名
 *   killsProcess 该指令可能导致进程立即终止（调用方需在执行前先落盘回执）
 *   resultExpected 是否需要回传结果体
 */
const SPECS = {
  health_check: { hook: 'onHealthCheck', killsProcess: false, resultExpected: true },
  restart_client: { hook: 'onRestart', killsProcess: true, resultExpected: false },
  restart_bot: { hook: 'onRestartBot', killsProcess: true, resultExpected: false },
  restart_napcat: { hook: 'onRestartNapcat', killsProcess: false, resultExpected: false },
  disable_client: { hook: 'onDisableClient', killsProcess: false, resultExpected: false },
  enable_client: { hook: 'onEnableClient', killsProcess: false, resultExpected: false },
  disable_printer: { hook: 'onDisablePrinter', killsProcess: false, resultExpected: false },
  enable_printer: { hook: 'onEnablePrinter', killsProcess: false, resultExpected: false },
  clear_print_queue: { hook: 'onClearPrintQueue', killsProcess: false, resultExpected: true },
  push_notice: { hook: 'onNotice', killsProcess: false, resultExpected: false },
  push_config: { hook: 'onConfig', killsProcess: false, resultExpected: true },
  // ============ sea2 商用运维新增 9 条（system_design_sea2_ops_v1.0.md §3.4）============
  pm2_list: { hook: 'onPm2Ops', killsProcess: false, resultExpected: true },
  pm2_restart: { hook: 'onPm2Ops', killsProcess: true, resultExpected: false },
  pm2_stop: { hook: 'onPm2Ops', killsProcess: true, resultExpected: false },
  pm2_start: { hook: 'onPm2Ops', killsProcess: false, resultExpected: false },
  pm2_logs: { hook: 'onPm2Ops', killsProcess: false, resultExpected: true },
  cups_info: { hook: 'onCupsOps', killsProcess: false, resultExpected: true },
  cups_set_printer: { hook: 'onCupsOps', killsProcess: false, resultExpected: true },
  cups_add_printer: { hook: 'onCupsOps', killsProcess: false, resultExpected: true },
  format_device: { hook: 'onFormat', killsProcess: false, resultExpected: true },
};

/** 服务端约定的合法指令集合 */
const VALID_ACTIONS = Object.keys(SPECS);

/** 进程名校验：与服务端 payloadSchema 一致（字母数字点下划线连字符，≤64） */
const PROCESS_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 格式化级别枚举（与服务端 payloadSchema enum 一致） */
const FORMAT_LEVELS = ['data', 'factory', 'disk'];

/**
 * 配置白名单：push_config 仅允许合并下列顶层键，且限定 printer 子对象的已知字段。
 * 与服务端 fleetCommands.CONFIG_WHITELIST 保持一致，双侧都过滤（纵深防御）。
 */
const CONFIG_WHITELIST = {
  printer: ['default'], // 仅允许修改默认打印机名
};

/**
 * 净化配置补丁（仅保留白名单键）。
 * @param {object} [raw] 原始配置补丁
 * @returns {object} 只含白名单键的补丁
 */
function sanitizeConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.printer && typeof raw.printer === 'object') {
    const printer = {};
    for (const k of CONFIG_WHITELIST.printer) {
      if (typeof raw.printer[k] === 'string') printer[k] = raw.printer[k];
    }
    if (Object.keys(printer).length) out.printer = printer;
  }
  return out;
}

/**
 * 该指令是否可能导致进程立即终止。
 * 调用方据此决定「先落盘回执再执行」，避免重启把回执带走。
 * @param {string} action 指令名
 * @returns {boolean}
 */
function killsProcess(action) {
  const spec = SPECS[action];
  return !!(spec && spec.killsProcess);
}

/** 统一的「未支持」返回，绝不伪装成功 */
function unsupported(id, action, detail) {
  return {
    ok: false,
    id,
    action,
    error: 'unsupported',
    detail: detail || `客户端未实现或未挂载 ${(SPECS[action] || {}).hook || action} 钩子`,
  };
}

/** 统一的「载荷非法」返回 */
function invalidPayload(id, action, detail) {
  return { ok: false, id, action, error: 'invalid-payload', detail: detail || '参数不合法' };
}

/**
 * 采集健康检查结果（内置实现，不依赖任何钩子）。
 * @param {object} ctx 执行上下文
 * @returns {Promise<object>} 健康快照
 */
async function builtinHealthCheck(ctx) {
  const info = await getSysInfo();
  let printers = [];
  try {
    printers = await getPrinters({ printPlugin: ctx.printPlugin });
  } catch (e) {
    printers = [];
  }
  return {
    version: info.version,
    platform: info.platform,
    arch: info.arch,
    hostname: info.hostname,
    cpu_usage: info.cpu_usage,
    mem_usage: info.mem_usage,
    boot_time: info.boot_time,
    uptime_sec: info.boot_time ? Math.max(0, Math.floor(Date.now() / 1000) - info.boot_time) : 0,
    printers,
    checked_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * 调用打印插件上的方法（存在才调用）。
 * @param {object} ctx 执行上下文
 * @param {string} method 方法名
 * @param {Array} args 参数
 * @returns {Promise<{hit:boolean, value:*}>} hit=false 表示插件不具备该能力
 */
async function tryPlugin(ctx, method, args) {
  const p = ctx.printPlugin;
  if (!p || typeof p[method] !== 'function') return { hit: false, value: undefined };
  const value = await p[method](...args);
  return { hit: true, value };
}

/**
 * 执行单条远程指令。
 * @param {{id?:string, action:string, payload?:object}} cmd 指令对象（来自服务端 commands[]）
 * @param {object} [ctx] 执行上下文（由 LicenseGate 从 cfg.fleet 组装）
 * @param {object} [ctx.printPlugin] 可选 PrintPlugin 实例
 * @param {object} [ctx.logger] 日志对象（默认 console）
 * @param {function} [ctx.onHealthCheck] 自定义健康检查（不挂则用内置实现）
 * @param {function} [ctx.onRestart] 重启整栈钩子
 * @param {function} [ctx.onRestartBot] 重启 sea1-bot 钩子
 * @param {function} [ctx.onRestartNapcat] 重启 napcat 钩子
 * @param {function} [ctx.onDisableClient] 停用客户端钩子
 * @param {function} [ctx.onEnableClient] 启用客户端钩子
 * @param {function} [ctx.onDisablePrinter] 停用打印机钩子
 * @param {function} [ctx.onEnablePrinter] 启用打印机钩子
 * @param {function} [ctx.onClearPrintQueue] 清空打印队列钩子
 * @param {function} [ctx.onNotice] 通知钩子
 * @param {function} [ctx.onConfig] 配置钩子
 * @param {object} [ctx.onPm2Ops] sea2 PM2 管控实例（list/restart/stop/start/logs）
 * @param {object} [ctx.onCupsOps] sea2 CUPS 管控实例（info/listPrinters/addPrinter/setPrinter）
 * @param {object} [ctx.onFormat] sea2 格式化执行器（execute）
 * @returns {Promise<{ok:boolean, id?:string, action:string, error?:string, detail?:string, result?:*}>}
 */
async function handleCommand(cmd, ctx = {}) {
  const id = cmd && cmd.id;
  const action = cmd && cmd.action;
  const payload = (cmd && cmd.payload) || {};
  const log = ctx.logger || console;
  const info = (m) => (log.log || console.log).call(log, m);

  if (!VALID_ACTIONS.includes(action)) {
    return { ok: false, id, action: action || 'unknown', error: 'unknown-action' };
  }

  const spec = SPECS[action];
  const hook = typeof ctx[spec.hook] === 'function' ? ctx[spec.hook] : null;

  try {
    switch (action) {
      // ---------- 诊断 ----------
      case 'health_check': {
        // 唯一一条「永远可用」的指令：内置实现不依赖任何宿主钩子，
        // 这样运维在任何客户端上都至少有一个可信的探针。
        const result = hook ? await hook(payload) : await builtinHealthCheck(ctx);
        return { ok: true, id, action, result };
      }

      // ---------- 进程 ----------
      // 重启类一律要求宿主挂钩子：客户端无权假设用什么方式重启（pm2 / systemd / docker），
      // 猜错比不做更危险，所以没钩子就如实回 unsupported。
      case 'restart_client':
      case 'restart_bot':
      case 'restart_napcat': {
        if (!hook) return unsupported(id, action);
        await hook(payload);
        return { ok: true, id, action };
      }

      // ---------- 服务开关 ----------
      case 'disable_client': {
        if (hook) { await hook(payload); return { ok: true, id, action }; }
        const r = await tryPlugin(ctx, 'setEnabled', [false]);
        if (r.hit) { info('[fleet] disable_client：已通过 printPlugin 停用打印能力'); return { ok: true, id, action }; }
        return unsupported(id, action);
      }

      case 'enable_client': {
        if (hook) { await hook(payload); return { ok: true, id, action }; }
        const r = await tryPlugin(ctx, 'setEnabled', [true]);
        if (r.hit) { info('[fleet] enable_client：已通过 printPlugin 恢复打印能力'); return { ok: true, id, action }; }
        return unsupported(id, action);
      }

      case 'disable_printer': {
        const name = payload && payload.printerName;
        if (!name) return invalidPayload(id, action, 'printerName 必填');
        if (hook) { await hook(payload); return { ok: true, id, action }; }
        const r = await tryPlugin(ctx, 'setPrinterEnabled', [name, false]);
        if (r.hit) return { ok: true, id, action };
        return unsupported(id, action);
      }

      case 'enable_printer': {
        const name = payload && payload.printerName;
        if (!name) return invalidPayload(id, action, 'printerName 必填');
        if (hook) { await hook(payload); return { ok: true, id, action }; }
        const r = await tryPlugin(ctx, 'setPrinterEnabled', [name, true]);
        if (r.hit) return { ok: true, id, action };
        return unsupported(id, action);
      }

      // ---------- 打印 ----------
      case 'clear_print_queue': {
        // printerName 可选：留空表示清空该设备上所有打印机的队列
        const name = (payload && payload.printerName) || '';
        if (hook) {
          const result = await hook(payload);
          return { ok: true, id, action, result: result == null ? { cleared: name || 'all' } : result };
        }
        const r = await tryPlugin(ctx, 'clearQueue', [name || undefined]);
        if (r.hit) {
          return { ok: true, id, action, result: r.value == null ? { cleared: name || 'all' } : r.value };
        }
        return unsupported(id, action);
      }

      // ---------- 下发 ----------
      case 'push_notice': {
        const text = payload && payload.text;
        if (!text) return invalidPayload(id, action, 'text 必填');
        // 没有通知通道就没有通知。打日志不等于推送，不能算成功。
        if (!hook) return unsupported(id, action);
        await hook(text, payload);
        return { ok: true, id, action };
      }

      case 'push_config': {
        const patch = sanitizeConfig(payload && payload.config);
        if (!Object.keys(patch).length) {
          return invalidPayload(id, action, '配置为空或全部不在白名单内');
        }
        // 没人接收配置 = 配置没生效，同样不能算成功
        if (!hook) return unsupported(id, action);
        await hook(patch);
        return { ok: true, id, action, result: { applied: patch } };
      }

      // ============ sea2 新增 9 条（§3.4）============
      // ---------- sea2 PM2 客户端进程 ----------
      case 'pm2_list': {
        const ops = ctx.onPm2Ops;
        if (!ops || typeof ops.list !== 'function') return unsupported(id, action);
        const result = await ops.list();
        if (!result || result.ok === false) {
          return { ok: false, id, action, error: (result && result.error) || 'pm2-list-failed', detail: result && result.detail };
        }
        return { ok: true, id, action, result: result.processes || [] };
      }

      case 'pm2_restart':
      case 'pm2_stop':
      case 'pm2_start': {
        const ops = ctx.onPm2Ops;
        if (!ops) return unsupported(id, action);
        const processName = payload && payload.processName;
        if (!processName || !PROCESS_NAME_PATTERN.test(String(processName))) {
          return invalidPayload(id, action, 'processName 必填（字母数字点下划线连字符，≤64）');
        }
        const method = action === 'pm2_restart' ? 'restart' : (action === 'pm2_stop' ? 'stop' : 'start');
        if (typeof ops[method] !== 'function') return unsupported(id, action);
        const result = await ops[method](processName);
        if (!result || result.ok === false) {
          return { ok: false, id, action, error: (result && result.error) || 'pm2-op-failed', detail: result && result.detail };
        }
        return { ok: true, id, action };
      }

      case 'pm2_logs': {
        const ops = ctx.onPm2Ops;
        if (!ops || typeof ops.logs !== 'function') return unsupported(id, action);
        const processName = payload && payload.processName;
        if (!processName || !PROCESS_NAME_PATTERN.test(String(processName))) {
          return invalidPayload(id, action, 'processName 必填（字母数字点下划线连字符，≤64）');
        }
        let lines = payload && payload.lines;
        if (lines === undefined || lines === null || lines === '') lines = 100;
        lines = Number(lines);
        if (!Number.isInteger(lines) || lines < 1 || lines > 200) {
          return invalidPayload(id, action, 'lines 必须为 1~200 的整数');
        }
        const result = await ops.logs(processName, lines);
        if (!result || result.ok === false) {
          return { ok: false, id, action, error: (result && result.error) || 'pm2-logs-failed', detail: result && result.detail };
        }
        return { ok: true, id, action, result: { processName, lines: result.lines || lines, logs: result.logs || '' } };
      }

      // ---------- sea2 CUPS ----------
      case 'cups_info': {
        const ops = ctx.onCupsOps;
        if (!ops || typeof ops.info !== 'function') return unsupported(id, action);
        const result = await ops.info();
        if (!result || result === null || typeof result !== 'object') {
          return { ok: true, id, action, result: { running: false, printers: [] } };
        }
        return { ok: true, id, action, result };
      }

      case 'cups_set_printer': {
        const ops = ctx.onCupsOps;
        if (!ops || typeof ops.setPrinter !== 'function') return unsupported(id, action);
        const name = payload && payload.name;
        if (!name) return invalidPayload(id, action, 'name 必填');
        const patch = {};
        if (typeof payload.enabled === 'boolean') patch.enabled = payload.enabled;
        if (payload.default === true) patch.default = true;
        if (payload.driver) patch.driver = String(payload.driver);
        const result = await ops.setPrinter(name, patch);
        if (!result || result.ok === false) {
          return { ok: false, id, action, error: (result && result.error) || 'cups-set-failed', detail: result && result.detail };
        }
        return { ok: true, id, action, result: { name, applied: result.applied || patch } };
      }

      case 'cups_add_printer': {
        const ops = ctx.onCupsOps;
        if (!ops || typeof ops.addPrinter !== 'function') return unsupported(id, action);
        const name = payload && payload.name;
        const uri = payload && payload.uri;
        if (!name) return invalidPayload(id, action, 'name 必填');
        if (!uri) return invalidPayload(id, action, 'uri 必填');
        const result = await ops.addPrinter(name, uri, payload.driver || undefined, payload.options || undefined);
        if (!result || result.ok === false) {
          return { ok: false, id, action, error: (result && result.error) || 'cups-add-failed', detail: result && result.detail };
        }
        return { ok: true, id, action, result: { name, added: true } };
      }

      // ---------- sea2 格式化强门禁 ----------
      case 'format_device': {
        const ops = ctx.onFormat;
        if (!ops || typeof ops.execute !== 'function') return unsupported(id, action);
        const level = payload && payload.level;
        if (!FORMAT_LEVELS.includes(level)) {
          return invalidPayload(id, action, 'level 必须为 data/factory/disk 之一');
        }
        const countdownSec = Number(payload && payload.countdownSec);
        if (!Number.isInteger(countdownSec) || countdownSec < 15) {
          return invalidPayload(id, action, 'countdownSec 必须为 ≥15 的整数');
        }
        // P4 本地二次确认：服务端指令只带 level/countdownSec/nonce（见 fleetCommands schema），
        // 确认词必须来自**本地**（本地操作员在登录中间页确认，由宿主注入 ctx.localConfirmWord；
        // payload.confirm 仅作兼容通道）。本地无确认 → execute 内部回 local-rejected，绝不擦除。
        const confirm = (payload && payload.confirm) || ctx.localConfirmWord || '';
        const result = await ops.execute(level, confirm, countdownSec, {
          nonce: payload.nonce,
          // T05：目标盘优先级 = 本地宿主配置 > 服务端下发（payload.diskTarget，配置中心预填）
          diskTarget: ctx.formatDiskTarget || (payload && payload.diskTarget) || '',
          wipeFn: ctx.formatWipeFn,
        });
        if (!result || result.ok === false) {
          return { ok: false, id, action, error: (result && result.error) || 'format-failed', detail: result && result.detail };
        }
        return { ok: true, id, action, result: (result && result.result) || { level } };
      }

      default:
        return { ok: false, id, action, error: 'unhandled' };
    }
  } catch (e) {
    return { ok: false, id, action, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  handleCommand,
  VALID_ACTIONS,
  SPECS,
  killsProcess,
  sanitizeConfig,
  CONFIG_WHITELIST,
  PROCESS_NAME_PATTERN,
  FORMAT_LEVELS,
};
