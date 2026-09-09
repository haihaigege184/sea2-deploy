'use strict';
// [状态] 手动确认模式已启用，本自动监控器当前未启用；当面付签约恢复后可启用（见 README §9）。
/**
 * poc-cdp-check.js — 最小 PoC：用 Playwright connectOverCDP 接管本机已登录 Chrome，验证「读账单」核心假设。
 * ===========================================================================
 * 背景：原 Puppeteer 无头冷启动登录个人支付宝风控风险高，已冻结待定。
 * 调研推荐路径②：CDP 接管本机【已登录】Chrome（127.0.0.1:9222），在已有登录上下文里操作，
 * 避免冷启动风控。本 PoC 仅验证可行性，不写完整监控器。
 *
 * 验证目标：
 *   A) 在已登录上下文打开支付宝账单页，能否读到最近交易 DOM（尤其「收钱码」转入 + 「备注」字段），
 *      且【不触发】滑块/短信/设备锁风控。
 *   B) （若 A 通过）在同一上下文触发官方「个人对账」导出，下载加密 zip（密码=身份证后6位），
 *      按 hejunjie/alipay-bill-parser 思路解压，确认 CSV 含
 *      「交易订单号 / 商户订单号 / 备注 / 金额」可用于匹配订单号。
 *
 * 观察项：连接后是否弹「接受」确认框、是否触发风控验证、是否要求重新登录。
 *
 * 运行前置（由用户配合）：
 *   1) 关闭 Chrome，用调试端口重启（保留已登录用户数据目录）：
 *      chrome.exe --remote-debugging-port=9222 --user-data-dir="C:/chrome-debug"
 *   2) 安装 playwright：cd activation-server/monitor && npm install playwright
 *   3) （可选，用于 B 解密）set ALIPAY_ID_LAST6=你的身份证后6位
 *   4) node poc-cdp-check.js
 *
 * 本脚本只做验证，不删除/不改写任何现有文件（含已冻结的 alipay-bill-monitor.js）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// ---------------------------------------------------------------------------
// 0) 前置依赖检查（优雅处理：缺什么明确提示什么，不崩）
// ---------------------------------------------------------------------------
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('[PoC] 未检测到 playwright。请先安装：');
  console.error('      cd activation-server/monitor && npm install playwright');
  console.error('[PoC] （仅 PoC 需要，不影响已冻结的 alipay-bill-monitor.js）');
  process.exit(2);
}

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const BILL_URL = process.env.ALIPAY_BILL_URL || 'https://consumeprod.alipay.com/record/advanced.htm';
const ID_LAST6 = process.env.ALIPAY_ID_LAST6 || '';

// 观察记录（最终汇总）
const observations = {
  dialogs: [], // 出现的对话框（含「接受」确认框）
  riskControl: { triggered: false, kinds: [] }, // 触发了哪些风控
  reLoginRequired: false, // 打开账单页是否被重定向到登录
  transactions: { count: 0, hasShouQian: false, hasBeiZhu: false, samples: [] },
  export: { attempted: false, downloaded: false, zipPath: '', decrypted: false, csvColumns: [], csvFirstRow: [] },
};

// ---------------------------------------------------------------------------
// 工具：风控探测
// ---------------------------------------------------------------------------
const RISK_KEYWORDS = ['滑块', '拖动', 'drag', 'slider', 'captcha', '验证码', '短信验证', '设备锁', '安全验证', '刷脸', '指纹'];

async function detectRiskControl(page) {
  let info = { triggered: false, kinds: [] };
  try {
    const txt = await page.evaluate(() => document.body.innerText || '');
    const lower = txt.toLowerCase();
    for (const k of RISK_KEYWORDS) {
      if (txt.includes(k) || lower.includes(k.toLowerCase())) {
        info.triggered = true;
        info.kinds.push(k);
      }
    }
    // 若被重定向到登录/验证页，也视为需要重新登录（风控或会话失效）
    const url = page.url();
    if (/login|verify|auth|sso\.alipay/i.test(url)) {
      info.triggered = true;
      info.kinds.push('重定向到登录/验证页:' + url);
      observations.reLoginRequired = true;
    }
  } catch (e) {
    /* 忽略探测异常 */
  }
  return info;
}

// 给任意 page 挂载对话框监听（捕获「接受」确认框等，自动接受以免卡死）
function attachPage(page) {
  page.on('dialog', async (dialog) => {
    const entry = { type: dialog.type(), message: String(dialog.message()).slice(0, 120) };
    observations.dialogs.push(entry);
    console.log(`[PoC][观察] 出现对话框 type=${entry.type} message=${entry.message} → 自动接受`);
    await dialog.accept().catch(() => {});
  });
}

// 按文本尝试点击（导出/确认按钮，结构未知，多候选兜底）
async function clickByText(page, texts) {
  for (const t of texts) {
    try {
      const el = await page.$(`text=${t}`);
      if (el) {
        await el.click({ timeout: 5000 }).catch(() => {});
        return t;
      }
    } catch (e) {
      /* 试下一个 */
    }
  }
  return null;
}

// 用 python3 解压加密 zip 并读取 CSV 表头 + 首行（hejunjie/alipay-bill-parser 思路）
function decryptAndParseCsv(zipPath, pwd) {
  return new Promise((resolve) => {
    const outDir = path.join(__dirname, 'poc-csv-extract');
    const py = [
      "import zipfile, csv, os, sys",
      `z = zipfile.ZipFile(r'${zipPath}')`,
      `z.extractall(r'${outDir}', pwd='${pwd}'.encode('utf-8'))`,
      "for f in z.namelist():",
      "    if f.lower().endswith('.csv'):",
      "        with open(os.path.join(r'" + outDir + "', f), encoding='utf-8-sig', errors='ignore') as fh:",
      "            rows = list(csv.reader(fh))",
      "            print('CSV_FILE=' + f)",
      "            print('HEADER=' + ','.join(rows[0] if rows else []))",
      "            print('FIRST_ROW=' + ','.join(rows[1] if len(rows) > 1 else []))",
    ].join('\n');
    execFile('python3', ['-c', py], { timeout: 25000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message || '').slice(0, 300) });
        return;
      }
      const lines = stdout.split('\n');
      const get = (p) => {
        const l = lines.find((x) => x.startsWith(p));
        return l ? l.slice(p.length) : '';
      };
      resolve({
        ok: true,
        csvFile: get('CSV_FILE='),
        header: get('HEADER=').split(','),
        firstRow: get('FIRST_ROW=').split(','),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  // 1) 连接 CDP（接管已登录 Chrome）
  let browser;
  try {
    console.log(`[PoC] 连接 CDP: ${CDP_URL}`);
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error(`[PoC] 无法连接 CDP (${CDP_URL})：${e.message}`);
    console.error('[PoC] 请确认本机 Chrome 已用调试端口启动，例如：');
    console.error('       chrome.exe --remote-debugging-port=9222 --user-data-dir="C:/chrome-debug"');
    console.error('[PoC] （保留已登录的用户数据目录，CDP 才能复用登录态，避开冷启动风控）');
    process.exit(3);
  }
  console.log('[PoC] CDP 连接成功');

  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) {
    console.error('[PoC] 未找到已存在的浏览器上下文（CDP 未包含已登录会话？）');
    await browser.close().catch(() => {});
    process.exit(4);
  }
  console.log(`[PoC] 复用已登录上下文（上下文数=${contexts.length}），登录态应已存在`);
  // 上下文级对话框监听（覆盖后续新开页面）
  context.on('dialog', async (dialog) => {
    const entry = { type: dialog.type(), message: String(dialog.message()).slice(0, 120) };
    observations.dialogs.push(entry);
    console.log(`[PoC][观察] 上下文级对话框 type=${entry.type} message=${entry.message} → 自动接受`);
    await dialog.accept().catch(() => {});
  });
  context.on('page', (page) => attachPage(page));

  // 2) 验证 A：打开账单页，读 DOM，探测风控
  const page = context.pages()[0] || (await context.newPage());
  attachPage(page);
  console.log(`[PoC][A] 打开账单页：${BILL_URL}`);
  try {
    await page.goto(BILL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.error(`[PoC][A] 账单页打开失败：${e.message}`);
  }
  await page.waitForTimeout(3500); // 等待交易记录异步加载

  const risk = await detectRiskControl(page);
  observations.riskControl = risk;
  console.log(`[PoC][A] 风控触发：${risk.triggered ? '是 -> ' + risk.kinds.join('/') : '否（未触发滑块/短信/设备锁）'}`);
  console.log(`[PoC][A] 是否被重定向到登录（需重登）：${observations.reLoginRequired ? '是' : '否'}`);

  const sample = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText || '' : '';
    const hasShouQian = /收钱码|二维码收款|收款/.test(txt);
    const hasBeiZhu = /备注|说明|转账说明/.test(txt);
    const rows = Array.from(
      document.querySelectorAll('.J-item, .record-item, [class*="trade-item"], [class*="transaction"]')
    )
      .slice(0, 5)
      .map((el) => String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200));
    return { hasShouQian, hasBeiZhu, rowCount: rows.length, rows };
  });
  observations.transactions = {
    count: sample.rowCount,
    hasShouQian: sample.hasShouQian,
    hasBeiZhu: sample.hasBeiZhu,
    samples: sample.rows,
  };
  console.log(`[PoC][A] 页面含「收钱码/收款」字样：${sample.hasShouQian ? '是' : '否'}`);
  console.log(`[PoC][A] 页面含「备注/说明」字样：${sample.hasBeiZhu ? '是' : '否'}`);
  console.log(`[PoC][A] 解析到交易行数：${sample.rowCount}`);
  sample.rows.forEach((r, i) => console.log(`[PoC][A]   样本${i + 1}: ${r || '(空)'}`));

  const verdictA = !risk.triggered && sample.rowCount > 0;
  console.log(`[PoC][A] 结论：可读到账单 DOM 且不触发风控 = ${verdictA ? '通过 ✅' : '未通过/需进一步确认 ⚠️'}`);

  // 3) 验证 B（条件于 A 通过且未被风控拦截）
  if (verdictA) {
    observations.export.attempted = true;
    console.log('[PoC][B] 尝试在同一上下文触发官方「个人对账」导出…');
    const clicked = await clickByText(page, ['下载', '导出', '个人对账', '下载账单', '导出账单']);
    console.log(`[PoC][B] 点击导出相关按钮：${clicked || '未找到（账单页结构可能与预期不同）'}`);

    if (clicked) {
      // 导出可能先弹「选择日期范围/确认」子对话框，再出下载；最多两轮尝试
      let downloaded = null;
      for (let i = 0; i < 2 && !downloaded; i++) {
        const dl = await page
          .waitForEvent('download', { timeout: 15000 })
          .catch(() => null);
        if (dl) {
          const zipPath = path.join(__dirname, 'poc-export-download.zip');
          await dl.saveAs(zipPath).catch((e) => console.error('[PoC][B] 保存下载失败：' + e.message));
          observations.export.downloaded = true;
          observations.export.zipPath = zipPath;
          console.log(`[PoC][B] 已下载加密 zip：${zipPath}（文件名：${dl.suggestedFilename() || '未知'}）`);

          if (ID_LAST6) {
            console.log(`[PoC][B] 用身份证后6位解密并读取 CSV…`);
            const csv = await decryptAndParseCsv(zipPath, ID_LAST6);
            if (csv.ok) {
              observations.export.decrypted = true;
              observations.export.csvColumns = csv.header;
              observations.export.csvFirstRow = csv.firstRow;
              console.log(`[PoC][B] CSV 文件：${csv.csvFile}`);
              console.log(`[PoC][B] CSV 表头：${csv.header.join(' | ')}`);
              console.log(`[PoC][B] CSV 首行：${csv.firstRow.join(' | ')}`);
              const need = ['交易订单号', '商户订单号', '备注', '金额'];
              const has = need.filter((c) =>
                csv.header.some((h) => h.includes(c))
              );
              console.log(`[PoC][B] 关键字段命中：${has.join('、') || '无'}（期望含：交易订单号/商户订单号/备注/金额）`);
            } else {
              console.error(`[PoC][B] 解密/解析失败：${csv.error}`);
            }
          } else {
            console.log('[PoC][B] 未设置 ALIPAY_ID_LAST6，跳过解密（解密密码=身份证后6位）。');
            console.log('[PoC][B] 设置后重跑即可验证 CSV 字段：set ALIPAY_ID_LAST6=xxxxxx');
          }
          downloaded = dl;
        } else {
          // 没等到下载，可能弹了子对话框，尝试点「确定/导出/保存」
          const ok = await clickByText(page, ['确定', '导出', '保存', '开始下载', '确认']);
          if (!ok) {
            console.log('[PoC][B] 未出现下载，也未找到确认按钮，B 终止（账单页导出入口结构可能不同）');
            break;
          }
        }
      }
    }
  } else {
    console.log('[PoC][B] A 未通过（触发风控或无交易记录），跳过 B');
  }

  // 4) 汇总观察
  console.log('\n==================== PoC 观察汇总 ====================');
  console.log('对话框（含「接受」确认框）：', JSON.stringify(observations.dialogs));
  console.log('风控触发：', observations.riskControl.triggered, observations.riskControl.kinds);
  console.log('需重新登录：', observations.reLoginRequired);
  console.log('账单读取：', `行数=${observations.transactions.count}, 收钱码=${observations.transactions.hasShouQian}, 备注=${observations.transactions.hasBeiZhu}`);
  console.log('导出：', JSON.stringify({ attempted: observations.export.attempted, downloaded: observations.export.downloaded, decrypted: observations.export.decrypted, columns: observations.export.csvColumns }));
  console.log('======================================================');

  await browser.close().catch(() => {});
  console.log('[PoC] 完成（已断开 CDP 连接，本机 Chrome 不受影响）');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[PoC] 运行异常：', e && e.message);
    process.exit(1);
  });
}

module.exports = { detectRiskControl, decryptAndParseCsv };
