'use strict';

/**
 * lib/fleetCommands.js —— 远程指令契约表（Single Source of Truth）
 *
 * 设计依据：system_design_fleet_ops_v1.0.md §7.3 / §1.1「契约单一事实来源」
 *
 * 本文件是 19 条远程指令的**唯一权威定义**（v1 的 11 条 + sea2 运维的 8 条），同时服务于三方：
 *   1. 服务端：`fleet.js` 的 COMMANDS / DANGEROUS 由此转出，`consoleApi.js` 据此校验载荷；
 *   2. 前端  ：通过 `GET /api/admin/fleet/meta` 下发，指令面板/危险确认/载荷控件全部由 meta 驱动，
 *              前端**零硬编码**（消除 PRD P2-5 指出的 `console.js` danger 硬编码不一致）；
 *   3. 客户端：以本表为规范实现 `VALID_ACTIONS` 与 switch 分支。
 *
 * 铁律：新增任一指令，先改本表；服务端与前端自动同步，只需再改客户端一处。
 */

/**
 * 载荷字段 schema 说明：
 *   type      : 'string' | 'object'
 *   required  : 是否必填
 *   maxLen    : 字符串最大长度（字符数）
 *   pattern   : 字符串正则（源串形式，便于随 meta 下发给前端复用）
 *   label     : 前端控件标题
 *   widget    : 前端控件类型提示 —— 'text' | 'textarea' | 'printer' | 'kv'
 *   help      : 前端控件下方说明
 */

/** @type {Array<Object>} 19 条指令规格（顺序即前端分组内展示顺序） */
const SPECS = [
  {
    action: 'health_check',
    label: '健康检查',
    group: '诊断',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {},
    resultExpected: true,
    minLevel: 2,
    desc: '采集客户端 CPU/内存/开机时长/打印机清单并回传，用于快速判断设备真实状态。',
  },
  {
    action: 'restart_client',
    label: '重启客户端',
    group: '进程',
    dangerous: true,
    confirmWord: null,
    payloadSchema: {},
    resultExpected: false,
    minLevel: 2,
    desc: '重启客户端整栈（sea1-bot + ncqq + sea1-login-gateway）。业务会短暂中断。',
  },
  {
    action: 'restart_bot',
    label: '重启 sea1-bot',
    group: '进程',
    dangerous: true,
    confirmWord: null,
    payloadSchema: {},
    resultExpected: false,
    minLevel: 2,
    desc: '仅重启 sea1-bot 主进程，不影响 napcat 与登录网关。',
  },
  {
    action: 'restart_napcat',
    label: '重启 napcat',
    group: '进程',
    dangerous: true,
    confirmWord: null,
    payloadSchema: {},
    resultExpected: false,
    minLevel: 2,
    desc: '仅重启 QQ 协议端（ncqq）。用于处理掉线、消息不通等协议层故障。',
  },
  {
    action: 'disable_client',
    label: '禁用客户端',
    group: '服务开关',
    dangerous: true,
    confirmWord: 'DISABLE',
    payloadSchema: {},
    resultExpected: false,
    minLevel: 2,
    desc: '吊销服务端授权并停用客户端打印服务。不可静默恢复，需用「启用客户端」对称还原。',
  },
  {
    action: 'enable_client',
    label: '启用客户端',
    group: '服务开关',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {},
    resultExpected: false,
    minLevel: 2,
    desc: '对称恢复被禁用的客户端：服务端授权状态回到 active（沿用原到期时间，不重新签发）。',
  },
  {
    action: 'disable_printer',
    label: '禁用打印机',
    group: '服务开关',
    dangerous: true,
    confirmWord: null,
    payloadSchema: {
      printerName: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '打印机名称',
        widget: 'printer',
        help: '仅允许字母、数字、点、下划线与连字符。',
      },
    },
    resultExpected: false,
    minLevel: 2,
    desc: '在客户端执行 cupsdisable，暂停指定打印机接单。',
  },
  {
    action: 'enable_printer',
    label: '启用打印机',
    group: '服务开关',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {
      printerName: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '打印机名称',
        widget: 'printer',
        help: '仅允许字母、数字、点、下划线与连字符。',
      },
    },
    resultExpected: false,
    minLevel: 2,
    desc: '在客户端执行 cupsenable，恢复指定打印机接单。',
  },
  {
    action: 'clear_print_queue',
    label: '清空打印队列',
    group: '打印',
    dangerous: true,
    confirmWord: null,
    payloadSchema: {
      printerName: {
        type: 'string',
        required: false,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '打印机名称（留空=全部）',
        widget: 'printer',
        help: '留空则清空该设备上所有打印机的待打印任务。',
      },
    },
    resultExpected: true,
    minLevel: 2,
    desc: '取消待打印任务（cancel -a）。已在打印中的任务不受影响，回执返回取消数量。',
  },
  {
    action: 'push_notice',
    label: '推送通知',
    group: '下发',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {
      text: {
        type: 'string',
        required: true,
        maxLen: 500,
        label: '通知内容',
        widget: 'textarea',
        help: '最多 500 字，将由客户端推送到已配置的通知群。',
      },
      target: {
        type: 'string',
        required: false,
        maxLen: 16,
        enum: ['groups', 'admin'],
        label: '推送目标',
        widget: 'select',
        help: 'groups=通知群（默认）；admin=超管私聊。',
      },
    },
    resultExpected: false,
    minLevel: 2,
    desc: '向客户端所在 QQ 群或超管推送一条文本通知。客户端未实现通知钩子时返回「未支持」。',
  },
  {
    action: 'push_config',
    label: '下发配置',
    group: '下发',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {
      config: {
        type: 'object',
        required: true,
        label: '配置项',
        widget: 'kv',
        help: '仅白名单内的键会被客户端接受，其余静默丢弃。',
      },
    },
    resultExpected: true,
    minLevel: 2,
    desc: '下发白名单内的客户端配置。回执返回实际生效的键值（applied）。',
  },
  // ============ sea2 商用运维新增 8 条（system_design_sea2_ops_v1.0.md §3.4）============
  // 铁律：新增指令先改本表 → meta 自动下发 → 服务端/前端自动同步 → 客户端 SPECS 同步一处。
  {
    action: 'pm2_list',
    label: '进程列表',
    group: '进程',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {},
    resultExpected: true,
    minLevel: 2,
    desc: '采集客户端 PM2 进程列表（name/status/restarts/cpu/mem）并回传，用于判断 sea2-* 进程真实状态。',
  },
  {
    action: 'pm2_restart',
    label: '重启进程',
    group: '进程',
    dangerous: true,
    confirmWord: null,
    payloadSchema: {
      processName: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '进程名',
        widget: 'text',
        help: 'PM2 进程名（sea2-*），仅允许字母、数字、点、下划线与连字符。',
      },
    },
    resultExpected: false,
    minLevel: 2,
    desc: '重启客户端指定 PM2 进程（sea2-*）。业务会短暂中断。',
  },
  {
    action: 'pm2_stop',
    label: '停止进程',
    group: '进程',
    dangerous: true,
    confirmWord: 'STOP',
    payloadSchema: {
      processName: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '进程名',
        widget: 'text',
        help: 'PM2 进程名（sea2-*），仅允许字母、数字、点、下划线与连字符。',
      },
    },
    resultExpected: false,
    minLevel: 2,
    desc: '停止客户端指定 PM2 进程（sea2-*）。需回传确认词 STOP。',
  },
  {
    action: 'pm2_start',
    label: '启动进程',
    group: '进程',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {
      processName: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '进程名',
        widget: 'text',
        help: 'PM2 进程名（sea2-*），仅允许字母、数字、点、下划线与连字符。',
      },
    },
    resultExpected: false,
    minLevel: 2,
    desc: '启动客户端指定 PM2 进程（sea2-*，通常用于恢复被停止的进程）。',
  },
  {
    action: 'pm2_logs',
    label: '进程日志',
    group: '进程',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {
      processName: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '进程名',
        widget: 'text',
        help: 'PM2 进程名（sea2-*），仅允许字母、数字、点、下划线与连字符。',
      },
      lines: {
        type: 'int',
        required: true,
        min: 1,
        max: 200,
        label: '日志行数',
        widget: 'text',
        help: '最多 200 行，回传最近 N 行日志。',
      },
    },
    resultExpected: true,
    minLevel: 2,
    desc: '采集客户端指定 PM2 进程最近 N 行日志（≤200 行）并回传。',
  },
  {
    action: 'cups_info',
    label: 'CUPS 状态',
    group: '打印',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {},
    resultExpected: true,
    minLevel: 2,
    desc: '采集客户端 CUPS 服务状态与打印机清单（name/uri/model/driver/state）并回传。',
  },
  {
    action: 'cups_set_printer',
    label: '设置打印机',
    group: '打印',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {
      name: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '打印机名称',
        widget: 'printer',
        help: '仅允许字母、数字、点、下划线与连字符。',
      },
      enabled: {
        type: 'boolean',
        required: false,
        label: '启用',
        widget: 'select',
        help: 'true=启用接单，false=暂停接单。',
      },
      default: {
        type: 'boolean',
        required: false,
        label: '设为默认',
        widget: 'select',
        help: 'true=设为默认打印机。',
      },
      driver: {
        type: 'string',
        required: false,
        maxLen: 128,
        label: '驱动',
        widget: 'text',
        help: 'PPD 驱动标识（可留空=不更换驱动）。',
      },
    },
    resultExpected: true,
    minLevel: 2,
    desc: '在客户端设置打印机（启用/默认/驱动），回执返回生效后的打印机状态。',
  },
  {
    action: 'cups_add_printer',
    label: '添加打印机',
    group: '打印',
    dangerous: false,
    confirmWord: null,
    payloadSchema: {
      name: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '打印机名称',
        widget: 'printer',
        help: '仅允许字母、数字、点、下划线与连字符。',
      },
      uri: {
        type: 'string',
        required: true,
        maxLen: 512,
        label: '设备 URI',
        widget: 'text',
        help: '如 usb://EPSON/L3150?serial=xxx 或 socket://ip:9100。',
      },
      driver: {
        type: 'string',
        required: false,
        maxLen: 128,
        label: '驱动',
        widget: 'text',
        help: 'PPD 驱动标识（可留空=系统自动识别）。',
      },
      options: {
        type: 'object',
        required: false,
        label: '附加选项',
        widget: 'kv',
        help: 'lpadmin 附加选项（键值对，可留空）。',
      },
    },
    resultExpected: true,
    minLevel: 2,
    desc: '在客户端添加一台打印机（name+uri+driver），回执返回添加结果。',
  },
  {
    action: 'format_device',
    label: '格式化设备',
    group: '高危',
    dangerous: true,
    confirmWord: 'FORMAT-DATA/FORMAT-FACTORY/FORMAT-DISK',
    confirmWords: ['FORMAT-DATA', 'FORMAT-FACTORY', 'FORMAT-DISK'],
    payloadSchema: {
      level: {
        type: 'string',
        required: true,
        enum: ['data', 'factory', 'disk'],
        label: '格式化级别',
        widget: 'select',
        help: 'data=数据分区 / factory=恢复出厂（保留系统与授权）/ disk=整盘擦除。',
      },
      countdownSec: {
        type: 'int',
        required: true,
        min: 15,
        max: 600,
        label: '本地倒计时秒数',
        widget: 'text',
        help: '至少 15 秒，客户端本地二次确认后执行。',
      },
      nonce: {
        type: 'string',
        required: true,
        maxLen: 64,
        pattern: '^[A-Za-z0-9._-]{1,64}$',
        label: '一次性随机串',
        widget: 'text',
        help: '由强门禁引擎签发，防止重放。',
      },
      diskTarget: {
        type: 'string',
        required: false,
        maxLen: 128,
        pattern: '^/dev/[A-Za-z0-9._/-]{1,128}$',
        label: '目标整盘设备',
        widget: 'text',
        help: 'disk 档目标盘（如 /dev/sda），由配置中心 formatDiskTarget 预填；data/factory 档可忽略。',
      },
    },
    resultExpected: true,
    minLevel: 3,
    desc: '格式化设备（三档分级）。仅由强门禁引擎签发（L3 + 确认词 + TOTP + 白名单），普通下发接口拒绝直发。',
  },
];

/** 客户端 push_config 可接受的键白名单（与客户端 CONFIG_WHITELIST 保持一致，随 meta 下发给前端做键下拉） */
const CONFIG_WHITELIST = { printer: ['default'] };

/** 分组展示顺序 */
const GROUPS = ['诊断', '进程', '服务开关', '打印', '下发', '高危'];

/** @type {Object<string, Object>} action -> spec 索引 */
const META = Object.create(null);
for (const spec of SPECS) META[spec.action] = spec;

/** @type {string[]} 全部合法 action（保持与 fleet.js 原 COMMANDS 相同的数组形态） */
const COMMANDS = SPECS.map((s) => s.action);

/** @type {string[]} 危险 action 名单 */
const DANGEROUS = SPECS.filter((s) => s.dangerous).map((s) => s.action);

/**
 * 取指令规格。
 * @param {string} action 指令名
 * @returns {Object|null} 规格对象，未收录返回 null
 */
function get(action) {
  if (!action || typeof action !== 'string') return null;
  return META[action] || null;
}

/**
 * 判断指令是否危险。
 * @param {string} action 指令名
 * @returns {boolean}
 */
function isDangerous(action) {
  const spec = get(action);
  return !!(spec && spec.dangerous);
}

/**
 * 判断指令是否期望回传结果体。
 * @param {string} action 指令名
 * @returns {boolean}
 */
function isResultExpected(action) {
  const spec = get(action);
  return !!(spec && spec.resultExpected);
}

/**
 * 校验并净化指令载荷。
 *
 * 规则：
 *   - 未收录的 action 直接失败；
 *   - 只保留 schema 中声明的键（防止越权字段透传到客户端）；
 *   - required 缺失 / 类型不符 / 超长 / 不匹配 pattern / 不在 enum 内 → 失败并返回中文错误；
 *   - 校验通过返回净化后的浅拷贝。
 *
 * @param {string} action 指令名
 * @param {Object} payload 原始载荷
 * @returns {{ok: boolean, error: string, payload: Object}}
 */
function validatePayload(action, payload) {
  const spec = get(action);
  if (!spec) return { ok: false, error: `不支持的指令：${String(action)}`, payload: {} };

  const schema = spec.payloadSchema || {};
  const raw = payload && typeof payload === 'object' ? payload : {};
  const clean = {};

  for (const key of Object.keys(schema)) {
    const field = schema[key];
    const value = raw[key];
    const missing = value === undefined || value === null || value === '';

    if (missing) {
      if (field.required) return { ok: false, error: `缺少必填参数：${field.label || key}`, payload: {} };
      continue;
    }

    if (field.type === 'string') {
      if (typeof value !== 'string') {
        return { ok: false, error: `参数 ${field.label || key} 必须为字符串`, payload: {} };
      }
      const text = value.trim();
      if (!text) {
        if (field.required) return { ok: false, error: `缺少必填参数：${field.label || key}`, payload: {} };
        continue;
      }
      if (field.maxLen && text.length > field.maxLen) {
        return { ok: false, error: `参数 ${field.label || key} 超长（最多 ${field.maxLen} 字）`, payload: {} };
      }
      if (field.pattern && !new RegExp(field.pattern).test(text)) {
        return { ok: false, error: `参数 ${field.label || key} 含非法字符`, payload: {} };
      }
      if (Array.isArray(field.enum) && field.enum.indexOf(text) === -1) {
        return { ok: false, error: `参数 ${field.label || key} 取值非法（可选：${field.enum.join('/')}）`, payload: {} };
      }
      clean[key] = text;
      continue;
    }

    if (field.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: `参数 ${field.label || key} 必须为对象`, payload: {} };
      }
      if (Object.keys(value).length === 0 && field.required) {
        return { ok: false, error: `参数 ${field.label || key} 不能为空`, payload: {} };
      }
      clean[key] = value;
      continue;
    }

    // sea2 新增：整数（支持 min/max 下限上限约束，如 countdownSec≥15、lines≤200）
    if (field.type === 'int') {
      let num = value;
      // 数字字符串（表单输入天然是字符串）允许转换为整数；其余非数字一律拒绝
      if (typeof num === 'string' && num.trim() !== '' && /^-?\d+$/.test(num.trim())) {
        num = parseInt(num.trim(), 10);
      }
      if (typeof num !== 'number' || !Number.isInteger(num)) {
        return { ok: false, error: `参数 ${field.label || key} 必须为整数`, payload: {} };
      }
      if (field.min !== undefined && num < field.min) {
        return { ok: false, error: `参数 ${field.label || key} 不能小于 ${field.min}`, payload: {} };
      }
      if (field.max !== undefined && num > field.max) {
        return { ok: false, error: `参数 ${field.label || key} 不能大于 ${field.max}`, payload: {} };
      }
      clean[key] = num;
      continue;
    }

    // sea2 新增：布尔（如 cups_set_printer 的 enabled/default，false 是合法值）
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        return { ok: false, error: `参数 ${field.label || key} 必须为布尔值`, payload: {} };
      }
      clean[key] = value;
      continue;
    }

    // 未声明类型的字段原样透传（当前 schema 未使用，留作扩展）
    clean[key] = value;
  }

  return { ok: true, error: '', payload: clean };
}

/**
 * 输出可随 API 下发的指令元数据列表（剔除内部字段，当前即全量）。
 * @returns {Array<Object>} 指令规格数组的深拷贝
 */
function list() {
  return SPECS.map((s) => ({
    action: s.action,
    label: s.label,
    group: s.group,
    dangerous: s.dangerous,
    confirmWord: s.confirmWord,
    // sea2：多确认词指令（如 format_device 三档）用数组下发，前端据此渲染选项
    confirmWords: Array.isArray(s.confirmWords) && s.confirmWords.length
      ? s.confirmWords.slice()
      : (s.confirmWord ? [s.confirmWord] : []),
    payloadSchema: JSON.parse(JSON.stringify(s.payloadSchema || {})),
    resultExpected: s.resultExpected,
    minLevel: s.minLevel,
    desc: s.desc,
  }));
}

module.exports = {
  SPECS,
  META,
  COMMANDS,
  DANGEROUS,
  GROUPS,
  CONFIG_WHITELIST,
  get,
  isDangerous,
  isResultExpected,
  validatePayload,
  list,
};
