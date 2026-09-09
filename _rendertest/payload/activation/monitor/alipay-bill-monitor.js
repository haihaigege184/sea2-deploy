'use strict';
// [状态] 手动确认模式已启用，本自动监控器当前未启用；当面付签约恢复后可启用（见 README §9）。
/**
 * alipay-bill-monitor.js — 支付宝账单监控器（SEAI 会员激活 · 过渡方案）
 * =========================================================================
 *
 * 背景与目的：
 *   会员激活服务的「个人收款码（manual）」路径下，用户扫码付款后发「已支付 <订单号>」，
 *   原实现 confirmManual 直接 markPaid 并发 license，导致【未付款也能白嫖】。
 *   现已解耦为：用户申报 → await_verify（待核验）→ 监控器/商户核验到账 → paid → 发码。
 *
 *   本脚本即「监控器」角色：用无头 Chrome 登录用户支付宝，定时读取账单页，
 *   解析最近交易（金额 + 转账备注里的订单号），与后端 await_verify 订单匹配；
 *   匹配且金额一致 → 调 /api/admin/order/confirm（带管理 token）→ 推进 paid → 触发后续发码。
 *
 * ⚠️ 过渡方案声明：
 *   这是「当面付」签约被风控拦断期间的临时兜底。支付宝 Web 账单页结构可能随时改版，
 *   届时仅需调整下方【账单解析】的选择器/正则（PARSE_DEFAULTS）与管理员可配置项，
 *   无需改主流程。当面付签约恢复后，应切换为官方 alipay.trade.query 主动查询接口（见 README）。
 *
 * 健壮性约定：
 *   - 任何单步异常都不退出进程（降级继续），但会打印日志并「漏单告警」。
 *   - 浏览器启动失败 / 登录失效 / 页面结构异常 → 打日志 + 尝试恢复，不静默吞错。
 *   - 登录态持久化到本地文件，失效时重新走扫码流程。
 *
 * 依赖：仅 puppeteer（与激活服务主进程解耦，单独目录、单独 package.json）。
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 配置加载：环境变量优先，其次 monitor/config.json；敏感值绝不硬编码。
// ---------------------------------------------------------------------------
function loadConfig() {
  const env = process.env;
  let fileCfg = {};
  const configPath = path.join(__dirname, 'config.json');
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    // 无配置文件则用默认值（首次部署可仅用环境变量）
    fileCfg = {};
  }
  const get = (k, def) => {
    const v = env[k];
    if (v !== undefined && v !== '') return v;
    if (fileCfg[k] !== undefined) return fileCfg[k];
    return def;
  };
  const headlessRaw = get('HEADLESS', 'true');
  const headless = !(headlessRaw === 'false' || headlessRaw === false);
  const headfulFirstLogin = get('HEADFUL_FIRST_LOGIN', 'false') === 'true' || get('HEADFUL_FIRST_LOGIN', 'false') === true;
  return {
    activationServer: get('ACTIVATION_SERVER', 'http://127.0.0.1:3457'),
    monitorToken: get('MONITOR_TOKEN', ''), // 专用监控 token（强烈建议设置，勿裸奔）
    adminToken: get('ADMIN_TOKEN', ''), // 兜底：未设 MONITOR_TOKEN 时退回通用 admin token
    billUrl: get('ALIPAY_BILL_URL', 'https://consumeprod.alipay.com/record/advanced.htm'),
    pollIntervalMs: parseInt(get('POLL_INTERVAL_MS', '60000'), 10),
    chromePath: get('CHROME_PATH', ''), // 留空则让 puppeteer 用自带的 Chromium
    headless,
    headfulFirstLogin,
    authFile: get('AUTH_FILE', path.join(__dirname, '.alipay-auth.json')),
    qrImageFile: get('QR_IMAGE_FILE', path.join(__dirname, 'alipay-login-qr.png')),
    orderPattern: get('ORDER_PATTERN', 'SEA1-\\d{8}-[A-Z0-9]{6}'), // 与后端订单号格式一致
    amountTolerance: parseFloat(get('AMOUNT_TOLERANCE', '0.01')),
    loginTimeoutMs: parseInt(get('LOGIN_TIMEOUT_MS', '300000'), 10),
    qrSelector: get('QR_SELECTOR', 'canvas, img.auth-code-img, .qr-img, [class*="qr"]'),
    userAgent: get('USER_AGENT', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'),
  };
}

// ---------------------------------------------------------------------------
// 日志（带级别与时间戳，便于 pm2 日志检索）
// ---------------------------------------------------------------------------
function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = `[alipay-monitor][${level}][${ts}] ${msg}`;
  if (extra !== undefined) console[level === 'error' ? 'error' : 'log'](line, extra);
  else console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// 账单解析（纯函数，可单测）—— 过渡方案核心，选择器集中、易改。
// ===========================================================================
// 所有选择器 / 正则集中在此：支付宝改版时只改这里，主流程不变。
const PARSE_DEFAULTS = {
  // 单条交易「卡片」起始标记（支付宝个人账单页通常包在带 class 的 div 里）
  rowStartRe: /<(div|li|tr)[^>]*\bclass="[^"]*?(?:J-item|record-item|trade-item|transaction-item)[^"]*?"/gi,
  // 时间（兼容 2025-07-30 12:01:05 / 2025-07-30T12:01 / 07-30 12:01）
  timeRe: /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?|\d{2}-\d{2}[ T]\d{2}:\d{2})/,
  // 备注/说明文本（仅匹配「备注/说明/转账说明」标签后的文字；
  // 注意：不要在此放 memo/remark 关键字，否则会误匹配 class="memo" 属性）
  memoRe: /(?:备注|说明|转账说明)\s*[:：]?\s*([^<<\n]{0,64})/i,
  // 备注元素（无「备注/说明」标签时，兜底抓 class 含 memo/remark/note 的元素文本）
  memoClassRe: /class="[^"]*?(?:memo|remark|note)[^"]*"[^>]*>([^<]{0,64})/i,
};

/** 从字符串中提取金额（去掉 ¥ 与千分位逗号），返回 number（解析失败为 NaN） */
function extractAmount(text) {
  const s = String(text || '');
  // 优先：带货币符号的金额（最可靠，避免把年份 2025 / 时间误判为金额）
  const cur = s.match(/(?:¥|￥)\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/);
  if (cur) return parseFloat(cur[1].replace(/,/g, ''));
  // 兜底：带两位小数的金额（如 29.00），排除日期 2025-07-30 / 时间 12:01:05（无小数点）
  const dec = s.match(/(-?\d{1,3}(?:,\d{3})*)\.(\d{2})/);
  if (dec) return parseFloat(`${dec[1].replace(/,/g, '')}.${dec[2]}`);
  return NaN;
}

/** 从文本中提取订单号（按给定正则），返回第一个匹配或 null */
function extractOrderId(text, orderRe) {
  const m = String(text || '').match(orderRe);
  return m ? m[0] : null;
}

/** 把 HTML 按「交易卡片」切成多段；若识别不到卡片标记，整体作为一段兜底 */
function splitRows(html) {
  const re = new RegExp(PARSE_DEFAULTS.rowStartRe.source, 'gi');
  const starts = [];
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  if (starts.length === 0) return [html];
  const rows = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : html.length;
    rows.push(html.slice(starts[i], end));
  }
  return rows;
}

/**
 * 纯函数：从账单页 HTML 提取交易列表 [{ time, amount, memo }]。
 * - 仅依赖传入的 html 字符串与配置，无副作用、无外部 I/O，便于单测（mock HTML）。
 * - memo 优先取订单号（用户在转账备注里填写的），否则取「备注/说明」标签后的文本。
 *
 * @param {string} html   账单页 HTML
 * @param {{orderPattern?:string}} [opts]
 * @returns {Array<{time:string, amount:number, memo:string}>}
 */
function parseBillTransactions(html, opts = {}) {
  const orderRe = opts.orderPattern
    ? new RegExp(opts.orderPattern, 'g')
    : /SEA1-\d{8}-[A-Z0-9]{6}/g;
  const rows = splitRows(html || '');
  const out = [];
  for (const row of rows) {
    const amount = extractAmount(row);
    const timeM = row.match(PARSE_DEFAULTS.timeRe);
    const time = timeM ? timeM[1] : '';
    // memo：优先订单号，否则「备注/说明」标签后的文字，再兜底 class 含 memo 的元素文本
    let memo = extractOrderId(row, orderRe) || '';
    if (!memo) {
      const mm = row.match(PARSE_DEFAULTS.memoRe);
      memo = mm ? String(mm[1] || '').trim() : '';
    }
    if (!memo) {
      const mc = row.match(PARSE_DEFAULTS.memoClassRe);
      memo = mc ? String(mc[1] || '').trim() : '';
    }
    out.push({ time, amount: Number.isNaN(amount) ? 0 : amount, memo });
  }
  return out;
}

// ===========================================================================
// 与激活服务器的通信（http/https 兼容，支持自签证书）
// ===========================================================================
function httpReq(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        timeout: 10000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          const isJson = (res.headers['content-type'] || '').includes('json');
          let json = null;
          try {
            json = isJson ? JSON.parse(buf || '{}') : null;
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, body: json, raw: buf });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (data) req.write(data);
    req.end();
  });
}

/** 核验接口鉴权头：优先专用 MONITOR_TOKEN，否则退回 ADMIN_TOKEN */
function confirmHeaders(cfg) {
  if (cfg.monitorToken) return { 'x-monitor-token': cfg.monitorToken };
  if (cfg.adminToken) return { 'x-admin-token': cfg.adminToken };
  return {};
}

// ===========================================================================
// 浏览器与登录态管理
// ===========================================================================
async function launchBrowser(cfg) {
  const puppeteer = require('puppeteer');
  const launchOpts = {
    headless: cfg.headfulFirstLogin ? false : cfg.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ignoreHTTPSErrors: true,
  };
  if (cfg.chromePath) launchOpts.executablePath = cfg.chromePath;
  try {
    return await puppeteer.launch(launchOpts);
  } catch (e) {
    // 降级：打日志并上抛，由主循环捕获后重试（不静默吞错）
    log('error', '无头浏览器启动失败（检查 Chrome 是否安装 / CHROME_PATH 是否正确 / 依赖是否安装）', e.message);
    throw e;
  }
}

function loadCookies(cfg) {
  try {
    if (fs.existsSync(cfg.authFile)) {
      const arr = JSON.parse(fs.readFileSync(cfg.authFile, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    }
  } catch (e) {
    log('warn', '读取登录态文件失败，将重新登录', e.message);
  }
  return [];
}

/**
 * 登录态判定（集中、易改）。支付宝改版时调整这两个标记数组即可。
 * 策略：若命中「未登录」标记且未同时命中「已登录」标记 → 视为未登录。
 */
const LOGGED_IN_MARKERS = ['退出登录', '我的账单', '交易记录', '记账', '账单详情'];
const NOT_LOGGED_IN_MARKERS = ['快速登录', '扫码登录', '密码登录', '/login', 'login.alipay'];

async function isLoggedIn(page) {
  let content = '';
  try {
    content = await page.content();
  } catch (e) {
    return false;
  }
  const lower = content.toLowerCase();
  if (NOT_LOGGED_IN_MARKERS.some((k) => lower.includes(k.toLowerCase()))) {
    if (LOGGED_IN_MARKERS.some((k) => content.includes(k))) return true; // 以已登录为准，防误判
    return false;
  }
  return LOGGED_IN_MARKERS.some((k) => content.includes(k));
}

/** 扫码登录流程：等待二维码 → 截图保存 + 打印 dataURL → 轮询直到登录成功 */
async function doQrLogin(page, cfg) {
  try {
    await page.waitForSelector(cfg.qrSelector, { timeout: 30000 });
  } catch (e) {
    log('error', '未找到登录二维码元素（QR_SELECTOR 可能需随支付宝改版调整）', e.message);
    throw new Error('QR selector not found');
  }
  const qrEl = await page.$(cfg.qrSelector);
  try {
    await qrEl.screenshot({ path: cfg.qrImageFile });
    const dataUrl = await qrEl.screenshot({ encoding: 'base64' });
    log('info', `请使用支付宝 App 扫描二维码登录（图片已保存：${cfg.qrImageFile}）`);
    log('info', `二维码 dataURL(前80字符): ${String(dataUrl).slice(0, 80)}...`);
  } catch (e) {
    log('warn', '二维码截图失败（仍可尝试在调试页面手动扫码）', e.message);
  }

  const deadline = Date.now() + cfg.loginTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      await page.reload({ waitUntil: 'networkidle2' }).catch(() => {});
    } catch (_) {
      /* ignore */
    }
    if (await isLoggedIn(page)) {
      log('info', '扫码登录成功');
      return;
    }
  }
  throw new Error('扫码登录超时，请重试或检查 QR_SELECTOR');
}

/** 确保已登录：先复用 cookie，失效则走扫码登录并持久化 */
async function ensureLoggedIn(browser, cfg) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(cfg.userAgent);
    const cookies = loadCookies(cfg);
    if (cookies.length) {
      await page.setCookie(...cookies);
      log('info', `已载入已保存登录态（${cookies.length} 条 cookie）`);
    }
    await page
      .goto(cfg.billUrl, { waitUntil: 'networkidle2', timeout: 30000 })
      .catch((e) => log('warn', '跳转账单页超时（继续判断是否已登录）', e.message));

    if (await isLoggedIn(page)) {
      log('info', '复用已保存登录态成功');
      return page;
    }

    log('warn', '未检测到有效登录态，进入扫码登录流程');
    await doQrLogin(page, cfg);
    const cookies2 = await page.cookies();
    fs.writeFileSync(cfg.authFile, JSON.stringify(cookies2, null, 2), { mode: 0o600 });
    log('info', `登录态已持久化到 ${cfg.authFile}`);
    return page;
  } catch (e) {
    log('error', '登录流程异常', e.message);
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

// ===========================================================================
// 核心：解析账单 → 匹配 await_verify 订单 → 核验到账 → 推进 paid
// ===========================================================================
async function processTransactions(txns, cfg) {
  for (const txn of txns) {
    if (!txn.memo) continue; // 无备注的交易（普通消费）跳过
    const orderId = extractOrderId(txn.memo, new RegExp(cfg.orderPattern, 'i'));
    if (!orderId) continue; // 备注里没有我们的订单号，跳过（避免误匹配）

    try {
      const st = await httpReq(
        'GET',
        `${cfg.activationServer}/api/order/status?order_id=${encodeURIComponent(orderId)}`
      );
      if (!st.body || !st.body.ok) {
        // 漏单告警：账单里出现了订单号，但后端查不到（可能已过期/被清）
        log('warn', `账单含订单号但后端查不到（疑似漏单/已清理）：${orderId}`, st.body);
        continue;
      }
      const o = st.body;
      if (o.status === 'paid' || o.status === 'issued') {
        log('info', `订单 ${orderId} 已是 ${o.status}，跳过`);
        continue;
      }
      if (o.status !== 'await_verify') {
        log('info', `订单 ${orderId} 状态为 ${o.status}，非待核验，跳过`);
        continue;
      }
      // 金额一致性校验（防篡改 / 防误标，宁可漏不可错发）
      if (typeof o.amount === 'number' && txn.amount && Math.abs(o.amount - txn.amount) > cfg.amountTolerance) {
        log('warn', `金额不符（疑似异常，跳过确认）：订单 ${orderId}=¥${o.amount}，账单=¥${txn.amount}`, txn);
        continue;
      }
      // 核验通过 → 推进为 paid（触发后续发码）
      const r = await httpReq(
        'POST',
        `${cfg.activationServer}/api/admin/order/confirm`,
        { order_id: orderId },
        confirmHeaders(cfg)
      );
      if (r.body && r.body.ok) {
        log('info', `✅ 订单 ${orderId} 核验到账，已推进为 paid（金额 ¥${txn.amount}）`);
      } else {
        // 漏单告警：调用失败
        log('error', `订单 ${orderId} 确认失败：${r.body && r.body.error}`, r.body);
      }
    } catch (e) {
      log('error', `处理订单 ${orderId} 异常（漏单告警）`, e.message);
    }
  }
}

// ===========================================================================
// 主循环
// ===========================================================================
async function main() {
  const cfg = loadConfig();
  if (!cfg.monitorToken && !cfg.adminToken) {
    log('error', '未配置 MONITOR_TOKEN（也未配置 ADMIN_TOKEN 兜底），监控器拒绝启动以避免裸奔');
    process.exit(1);
  }
  if (!cfg.monitorToken) {
    log('warn', '未配置 MONITOR_TOKEN，将退回使用 ADMIN_TOKEN 调用核验接口（建议为监控器单独配置 MONITOR_TOKEN）');
  }

  let browser = null;
  let page = null;
  let consecutiveErrors = 0;

  const shutdown = async () => {
    log('info', '收到退出信号，正在关闭浏览器...');
    try {
      if (page) await page.close();
    } catch (_) {
      /* ignore */
    }
    try {
      if (browser) await browser.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    try {
      // 浏览器/页面未就绪则（重）启动并登录
      if (!browser || !browser.isConnected()) {
        browser = await launchBrowser(cfg);
        page = await ensureLoggedIn(browser, cfg);
      }

      // 登录态可能中途失效（cookie 过期/被踢），及时检测并重登
      if (!(await isLoggedIn(page))) {
        log('error', '登录态丢失，尝试重新扫码登录（无界面服务器请配合 xvfb-run 或本地首次登录后拷贝 .alipay-auth.json）');
        await doQrLogin(page, cfg);
        const cookies2 = await page.cookies();
        fs.writeFileSync(cfg.authFile, JSON.stringify(cookies2, null, 2), { mode: 0o600 });
      }

      const html = await page.content();
      const txns = parseBillTransactions(html, { orderPattern: cfg.orderPattern });
      if (txns.length === 0) {
        // 页面结构可能已改版，告警但不退出
        log('warn', '本轮未解析到任何交易记录，可能支付宝账单页结构已变更，请检查 PARSE_DEFAULTS / QR_SELECTOR');
      } else {
        log('info', `本轮解析到 ${txns.length} 条交易记录`);
      }
      await processTransactions(txns, cfg);

      consecutiveErrors = 0;
      // 刷新账单页，准备下一轮
      await page
        .goto(cfg.billUrl, { waitUntil: 'networkidle2', timeout: 30000 })
        .catch((e) => log('warn', '刷新账单页超时', e.message));
      await sleep(cfg.pollIntervalMs);
    } catch (e) {
      consecutiveErrors++;
      log('error', `监控循环异常（连续第 ${consecutiveErrors} 次）`, e.message);
      // 降级：不崩，尝试重启浏览器；连续多次失败则打印人工排查告警
      try {
        if (page) await page.close();
      } catch (_) {
        /* ignore */
      }
      try {
        if (browser) await browser.close();
      } catch (_) {
        /* ignore */
      }
      browser = null;
      page = null;
      if (consecutiveErrors >= 5) {
        log('error', '连续多次失败：可能为登录失效或页面结构变更，请人工排查（检查 .alipay-auth.json / 选择器 / 支付宝风控）');
        consecutiveErrors = 0;
      }
      await sleep(Math.min(cfg.pollIntervalMs, 30000));
    }
  }
}

module.exports = {
  loadConfig,
  parseBillTransactions,
  extractAmount,
  extractOrderId,
  splitRows,
  httpReq,
  isLoggedIn,
};

if (require.main === module) {
  main().catch((e) => {
    log('error', '监控器致命错误，退出', e && e.message);
    process.exit(1);
  });
}
