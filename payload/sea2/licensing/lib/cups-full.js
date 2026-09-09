'use strict';
/**
 * cups-full.js — sea2 CUPS 全功能封装（零三方依赖，execFile 零 shell）
 *
 * 覆盖 sea2 运维指令（§3.4 / §4.3）：
 *   cups_info           → info()
 *   cups_set_printer    → setPrinter(name, patch)
 *   cups_add_printer    → addPrinter(name, uri, driver, options)
 *   驱动识别推荐         → recommendDriver(model, uri)
 *
 * 所有系统调用统一走 node:child_process.execFile（数组传参），绝不拼接 shell，
 * 打印机名/URI 等外部输入因此天然免疫注入。
 *
 * 设计约束：
 *  - 任何异常都降级为 {ok:false, error}，不让调用方崩；
 *  - 所有方法支持 opts.execFile 注入（测试用），签名同 promisify(execFile)。
 */

const { execFile } = require('node:child_process');
const util = require('node:util');

const execFileP = util.promisify(execFile);

/** 打印机名校验：与服务端 payloadSchema 一致（字母数字点下划线连字符，≤64） */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 内置驱动识别库（静态型号 → PPD 驱动映射，零在线依赖） */
const DRIVER_REPO = [
  { model: 'EPSON L3150', driver: 'epson-inkjet-printer-escpr', uriPattern: /usb:\/\/EPSON/i, confidence: 0.92 },
  { model: 'EPSON L3250', driver: 'epson-inkjet-printer-escpr', uriPattern: /usb:\/\/EPSON/i, confidence: 0.90 },
  { model: 'EPSON L3110', driver: 'epson-inkjet-printer-escpr', uriPattern: /usb:\/\/EPSON/i, confidence: 0.90 },
  { model: 'EPSON L3210', driver: 'epson-inkjet-printer-escpr', uriPattern: /usb:\/\/EPSON/i, confidence: 0.90 },
  { model: 'EPSON L4150', driver: 'epson-inkjet-printer-escpr', uriPattern: /usb:\/\/EPSON/i, confidence: 0.88 },
  { model: 'HP LaserJet', driver: 'hpijs', uriPattern: /(usb|socket):\/\/(HP|hplip)/i, confidence: 0.85 },
  { model: 'Canon PIXMA', driver: 'cnijfilter2', uriPattern: /usb:\/\/Canon/i, confidence: 0.84 },
  { model: 'Brother', driver: 'brother-lpr-drivers', uriPattern: /(usb|socket):\/\/Brother/i, confidence: 0.86 },
];

/**
 * 低层 CUPS 命令执行器（execFile 数组传参，零 shell）。
 * @param {string} cmd 可执行文件名（lpstat/lpadmin/cupsenable/cupsdisable/cupsdefault/lpinfo）
 * @param {string[]} args 参数列表
 * @param {object} [opts]
 * @param {function} [opts.execFile] 注入实现（测试用），签名同 promisify(execFile)
 * @param {number} [opts.timeoutMs=10000] 超时（毫秒）
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code?:number, error?:string, detail?:string}>}
 */
async function run(cmd, args, opts = {}) {
  const execFn = typeof opts.execFile === 'function' ? opts.execFile : execFileP;
  try {
    const { stdout } = await execFn(cmd, args, { timeout: opts.timeoutMs || 10000, windowsHide: true });
    return { ok: true, stdout: stdout || '', stderr: '' };
  } catch (e) {
    const stderr = (e && e.stderr) ? e.stderr.toString() : '';
    const stdout = (e && e.stdout) ? e.stdout.toString() : '';
    const code = e && e.code;
    const error = (typeof code === 'number') ? ('exit-' + code) : ((e && e.message) || 'cups-error');
    return { ok: false, stdout, stderr, code: typeof code === 'number' ? code : undefined, error, detail: stderr.slice(0, 500) };
  }
}

/** 解析 `lpstat -p -d` 的 printer 行。形如：printer NAME is idle  enabled since ... */
function parsePrinterLines(out) {
  const printers = [];
  const lines = (out || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^printer\s+([^\s]+)\s+is\s+([^\s]+)/i);
    if (m) {
      printers.push({
        name: m[1],
        state: m[2],
        enabled: m[2] !== 'disabled',
        description: line.trim(),
      });
    }
  }
  return printers;
}

/** 解析 `lpstat -v` 的 device-for 行 → name → uri 映射 */
function parseDeviceFor(out) {
  const map = new Map();
  const re = /^device for\s+([^\s:]+):\s+(\S+)/gim;
  let m;
  while ((m = re.exec(out || '')) !== null) map.set(m[1], m[2]);
  return map;
}

/** 解析 `lpstat -d` 的默认打印机行。形如：system default destination: NAME */
function parseDefaultPrinter(out) {
  const m = (out || '').match(/system default destination:\s*(\S+)/i);
  return m ? m[1] : '';
}

/**
 * CUPS 服务状态 + 打印机清单。
 * @param {object} [opts] 见 run()
 * @returns {Promise<{running:boolean, printers:Array, default:?string, raw?:object}>}
 */
async function info(opts = {}) {
  // lpstat -r：scheduler is running / not running
  const r = await run('lpstat', ['-r'], opts);
  const running = r.ok && /scheduler is running/i.test(r.stdout || '');

  const printers = await listPrinters(opts);

  return {
    running,
    printers,
    default: printers.find((p) => p.default) ? printers.find((p) => p.default).name : null,
  };
}

/**
 * 打印机清单（lpstat -p -d -v 合并）。
 * @param {object} [opts] 见 run()
 * @returns {Promise<Array<{name:string, state:string, enabled:boolean, uri:?string, default:boolean, description:string}>>}
 */
async function listPrinters(opts = {}) {
  const [pRes, vRes, dRes] = await Promise.all([
    run('lpstat', ['-p', '-d'], opts),
    run('lpstat', ['-v'], opts),
    run('lpstat', ['-d'], opts),
  ]);
  const uriMap = parseDeviceFor(vRes.stdout);
  const defaultName = parseDefaultPrinter(dRes.stdout);
  return parsePrinterLines(pRes.stdout).map((p) => ({
    name: p.name,
    state: p.state,
    enabled: p.enabled,
    uri: uriMap.get(p.name) || null,
    default: p.name === defaultName,
    description: p.description,
  }));
}

/**
 * 添加打印机（lpadmin -p name -v uri [-m driver] [-o k=v ...] -E）。
 * @param {string} name 打印机名（必须匹配 NAME_PATTERN）
 * @param {string} uri  设备 URI（如 usb://EPSON/L3150?serial=xxx）
 * @param {string} [driver] PPD 驱动标识（可留空 = 系统自动识别）
 * @param {object} [options] lpadmin 附加选项（键值对，可留空）
 * @param {object} [opts] 见 run()
 * @returns {Promise<{ok:boolean, name:string, error?:string, detail?:string}>}
 */
async function addPrinter(name, uri, driver, options, opts = {}) {
  if (!name || !NAME_PATTERN.test(String(name))) {
    return { ok: false, name: name || '', error: 'invalid-printer-name', detail: '仅允许字母数字点下划线连字符，≤64' };
  }
  if (!uri || typeof uri !== 'string') {
    return { ok: false, name: String(name || ''), error: 'invalid-uri', detail: 'uri 必填' };
  }
  const args = ['-p', String(name), '-v', String(uri)];
  if (driver) args.push('-m', String(driver));
  if (options && typeof options === 'object') {
    for (const [k, v] of Object.entries(options)) {
      args.push('-o', String(k) + '=' + String(v));
    }
  }
  args.push('-E'); // 添加后立即启用
  const r = await run('lpadmin', args, opts);
  if (r.ok) return { ok: true, name: String(name) };
  return { ok: false, name: String(name), error: r.error, detail: r.detail };
}

/**
 * 设置打印机（启用/禁用/默认/驱动）。
 * @param {string} name 打印机名
 * @param {object} patch
 * @param {boolean} [patch.enabled] true=cupsenable / false=cupsdisable
 * @param {boolean} [patch.default] true=cupsdefault
 * @param {string} [patch.driver] 更换 PPD 驱动（lpadmin -m）
 * @param {object} [opts] 见 run()
 * @returns {Promise<{ok:boolean, name:string, applied:object, error?:string, detail?:string}>}
 */
async function setPrinter(name, patch = {}, opts = {}) {
  if (!name || !NAME_PATTERN.test(String(name))) {
    return { ok: false, name: name || '', error: 'invalid-printer-name', detail: '仅允许字母数字点下划线连字符，≤64' };
  }
  const applied = {};
  const steps = [];

  if (typeof patch.enabled === 'boolean') {
    steps.push(run(patch.enabled ? 'cupsenable' : 'cupsdisable', [String(name)], opts));
    applied.enabled = patch.enabled;
  }
  if (patch.default === true) {
    steps.push(run('cupsdefault', [String(name)], opts));
    applied.default = true;
  }
  if (patch.driver) {
    steps.push(run('lpadmin', ['-p', String(name), '-m', String(patch.driver)], opts));
    applied.driver = String(patch.driver);
  }

  if (!steps.length) {
    return { ok: false, name: String(name), applied, error: 'empty-patch', detail: '没有可执行的设置项（enabled/default/driver 至少一项）' };
  }

  const results = await Promise.all(steps);
  const failed = results.find((r) => !r.ok);
  if (failed) {
    return { ok: false, name: String(name), applied, error: failed.error, detail: failed.detail };
  }
  return { ok: true, name: String(name), applied };
}

/**
 * 驱动识别推荐（内置型号库匹配）。
 * @param {string} [model] 打印机型号（如 EPSON L3150）
 * @param {string} [uri] 设备 URI（如 usb://EPSON/L3150）
 * @returns {{driver:?string, confidence:number, matchedBy:string, alternatives:Array}}
 */
function recommendDriver(model, uri) {
  const modelText = String(model || '').toLowerCase();
  const uriText = String(uri || '').toLowerCase();
  const scored = [];

  for (const entry of DRIVER_REPO) {
    let score = 0;
    let matchedBy = '';
    const modelKey = entry.model.toLowerCase();
    if (modelText && modelText.includes(modelKey)) {
      score = Math.max(score, 0.9);
      matchedBy = 'model';
    } else if (modelText && modelKey.includes(modelText) && modelText.length >= 4) {
      score = Math.max(score, 0.7);
      matchedBy = 'model-substr';
    }
    if (uriText && entry.uriPattern.test(uriText)) {
      score = Math.max(score, 0.85);
      matchedBy = matchedBy ? 'model+uri' : 'uri';
    }
    if (score > 0) {
      scored.push({ driver: entry.driver, confidence: Math.min(0.99, score + (entry.confidence - 0.85) / 2), matchedBy });
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  if (!scored.length) {
    return { driver: null, confidence: 0, matchedBy: '', alternatives: [] };
  }
  return {
    driver: scored[0].driver,
    confidence: scored[0].confidence,
    matchedBy: scored[0].matchedBy,
    alternatives: scored.slice(1, 4).map((s) => s.driver),
  };
}

module.exports = {
  run,
  info,
  listPrinters,
  addPrinter,
  setPrinter,
  recommendDriver,
  parsePrinterLines,
  parseDeviceFor,
  parseDefaultPrinter,
  NAME_PATTERN,
  DRIVER_REPO,
};
