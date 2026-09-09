'use strict';
// [状态] 手动确认模式已启用，本自动监控器当前未启用；当面付签约恢复后可启用（见 README §9）。
/**
 * bill-csv-matcher.js — 支付宝官方账单导出 CSV 的「解析 + 订单匹配」模块（可单测、零登录）。
 *
 * 用途（为「方式②官方账单导出 CSV 解析」铺路）：
 *   读取支付宝官方导出的账单（CSV 文件，或加密 zip 包解压后的 CSV），逐行解析，
 *   从「备注 / 商品说明」提取我们的订单号（与现有 monitor 的 extractOrderId 正则一致），
 *   对本地 await_verify 订单清单做匹配与金额一致性校验，输出分类：
 *     ① 匹配成功（订单号 + 金额均一致）→ 返回待确认订单；
 *     ② 金额不符                     → 标记 skip + 告警（防篡改 / 防误标）；
 *     ③ 无订单号                     → 跳过（普通消费）；
 *     ④ 支出记录                     → 跳过。
 *
 * 设计原则：
 *   - 纯函数优先，无外部 I/O 副作用，便于单测（mock 注入订单清单，不连真服务）。
 *   - 不依赖真实登录 / 不下载 Chromium / 不 SSH 主服务器，仅解析本地或样例 CSV。
 *   - 复用现有 monitor 的订单号正则（SEA1-\d{8}-[A-Z0-9]{6}），保持一致。
 *   - zip 解压为可选分支：优先不引重型依赖；未安装解压库时给出明确提示，纯 CSV 路径不受影响。
 *
 * 运行样例（见文件底部 self-test 区块，或手动）：
 *   node bill-csv-matcher.js                 # 内置样例 CSV 跑通解析+匹配+告警
 *   node bill-csv-matcher.js ./bill.csv      # 解析指定 CSV 文件
 *   node bill-csv-matcher.js ./bill.zip      # 解压（需 ALIPAY_ID_LAST6 + 解压库）后解析 CSV
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// ===========================================================================
// 配置（集中、易改；与现有 monitor 的识别规则保持一致）
// ===========================================================================
const DEFAULTS = {
  // 订单号正则：必须与 monitor/alipay-bill-monitor.js 中使用的规则一致
  orderPattern: 'SEA1-\\d{8}-[A-Z0-9]{6}',
  // 金额一致性容差（元）。宁可漏不可错发：超过容差即判为金额不符。
  amountTolerance: 0.01,
};

/**
 * 支付宝官方导出 CSV 表头 → 内部字段名 的映射。
 * 参考 hejunjie/alipay-bill-parser 的列：
 *   交易时间 / 交易分类 / 对方 / 对方账号 / 商品说明 / 收/支 / 金额 / 收付款方式 /
 *   交易状态 / 交易订单号 / 商户订单号 / 备注
 * 说明：支付宝导出 CSV 在真正表头前通常有一行「Excel 导出信息」与一行空行，
 * 真正的列头行以「交易时间」开头，解析时以此定位（见 parseCsvText）。
 */
const FIELD_MAP = {
  交易时间: 'time',
  收付款方式: 'payMethod',
  交易分类: 'category',
  交易状态: 'tradeStatus',
  商品说明: 'goodsTitle', // 商品说明（常含用户填写的订单号）
  对方: 'counterparty',
  对方账号: 'counterpartyAccount',
  收: 'incomeFlag', // 收/支 方向列中的「收」标记值
  支: 'expenseFlag', // 收/支 方向列中的「支」标记值
  金额: 'amount', // 数值（收款为正、付款为负，取决于支付宝版本）
  交易订单号: 'tradeOrderId', // 支付宝交易订单号（非我们的业务订单号）
  商户订单号: 'merchantOrderId', // 商户订单号
  备注: 'remark', // 备注（也常含用户填写的订单号）
};

// 收/支方向列名（不同导出版本可能是「收/支」整体作为一列，或分列）。这里同时兼容：
//   - 单列名「收/支」，其单元格值为「收入」/「支出」/「收」/「支」
//   - 单列名「金额」本身已带正负号
const DIRECTION_COL = '收/支';

// ===========================================================================
// 纯函数：CSV 解析与字段映射
// ===========================================================================

/**
 * 极简 CSV 行解析（支持双引号包裹、字段内逗号、双引号转义 ""）。
 * @param {string} line 单行文本
 * @returns {string[]}
 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++; // 转义引号
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * 把一个 CSV 文本解析为「对象数组」。
 * 支付宝导出 CSV 在正式列头前会有若干行导出信息（如「支付宝交易记录明细查询..."),
 * 真正的列头行以「交易时间」开头。这里自动跳过前置行，定位到以「交易时间」开头的表头。
 *
 * @param {string} text 整个 CSV 文件文本
 * @returns {Array<Record<string,string>>} 每行一个对象，key 为 FIELD_MAP 的内部字段名
 */
function parseCsvText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  // 定位表头行：第一个以「交易时间」开头（或包含该列）的行
  let headerIdx = lines.findIndex((l) => splitCsvLine(l)[0] === '交易时间' || l.includes('交易时间'));
  if (headerIdx < 0) {
    // 没有标准表头：尝试把第一行当表头（兼容非标准导出）
    headerIdx = 0;
  }
  const headerCells = splitCsvLine(lines[headerIdx]);
  const rawKeys = headerCells.map((h) => FIELD_MAP[h] || h); // 已知列映射到内部名，未知列保留原样

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length === 0) continue;
    // 脏行跳过：字段数严重不足（少于表头一半）视为无效行
    if (cells.length < Math.ceil(rawKeys.length / 2)) continue;
    // 补齐到表头长度（真实导出常有空列，如「对方账号」为空，用 '' 占位，避免整行被丢弃）
    while (cells.length < rawKeys.length) cells.push('');
    const obj = {};
    for (let c = 0; c < rawKeys.length; c++) {
      obj[rawKeys[c]] = cells[c];
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * 从一行账单对象中提取订单号（复用与现有 monitor 一致的 extractOrderId 正则）。
 * 优先：备注；其次：商品说明。
 * @param {Record<string,string>} row 单行账单对象
 * @param {RegExp} orderRe
 * @returns {string|null}
 */
function extractOrderId(row, orderRe) {
  const candidates = [row.remark, row.goodsTitle, row.merchantOrderId]
    .filter((v) => typeof v === 'string' && v.length > 0);
  for (const text of candidates) {
    const m = text.match(orderRe);
    if (m) return m[0];
  }
  return null;
}

/**
 * 判断收/支方向，并归一化金额符号。
 * - 若「收/支」列标记为「支出」/「支」，视为支出（amount 取负或标记 expense）。
 * - 若「金额」列本身已带负号，也视为支出。
 * @param {Record<string,string>} row
 * @returns {{direction:'income'|'expense'|'unknown', amount:number}}
 */
function resolveDirectionAndAmount(row) {
  let rawAmount = parseFloat(String(row.amount || '').replace(/[¥￥,\s]/g, ''));
  if (Number.isNaN(rawAmount)) rawAmount = 0;

  const dirCell = row[DIRECTION_COL] || row.direction || '';
  let direction = 'unknown';
  if (dirCell.includes('支出') || dirCell === '支') {
    direction = 'expense';
  } else if (dirCell.includes('收入') || dirCell === '收') {
    direction = 'income';
  } else if (rawAmount < 0) {
    // 金额本身带负号，且无方向列 → 视为支出
    direction = 'expense';
  } else if (rawAmount > 0) {
    direction = 'income';
  }

  // 归一化：收入为正、支出为负（便于后续金额比较一致）
  const amount = direction === 'expense' ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  return { direction, amount };
}

// ===========================================================================
// 匹配核心：解析结果 → 分类（匹配成功 / 金额不符 / 无订单号 / 支出）
// ===========================================================================

/**
 * 把解析后的账单行与本地 await_verify 订单清单做匹配与分类。
 * 纯函数：通过 ordersProvider 注入订单清单（mock 或真实后端都行），不连真服务。
 *
 * @param {Array<Record<string,string>>} rows    parseCsvText 的输出
 * @param {object} [opts]
 * @param {string} [opts.orderPattern]           订单号正则串（默认见 DEFAULTS）
 * @param {number} [opts.amountTolerance]        金额容差（默认 0.01）
 * @param {(orderId:string)=>(Promise<{order_id:string,status:string,amount?:number}>|null|undefined)}
 *   [opts.getOrder]                             注入：按订单号取本地订单；返回 null 表示查不到。
 *                                               不传则仅做「能否提出订单号 + 金额/方向分类」，不做后端匹配。
 * @returns {Promise<object>} 分类结果
 *   {
 *     matched:   [{ orderId, amount, row }],   // ① 匹配成功（订单号+金额一致，且后端为 await_verify）
 *     amountMismatch: [{ orderId, billAmount, orderAmount, row }], // ② 金额不符（含后端存在但金额不一致）
 *     noOrderId: [{ row }],                     // ③ 无订单号（普通消费）
 *     expense:   [{ row }],                     // ④ 支出记录（非收款，跳过）
 *     notFound:  [{ orderId, row }],            // 附加：账单有订单号但后端查不到（疑似漏单/已清理）
 *     summary:   { total, matched, amountMismatch, noOrderId, expense, notFound }
 *   }
 */
async function matchBill(rows, opts = {}) {
  const orderPattern = opts.orderPattern || DEFAULTS.orderPattern;
  const orderRe = new RegExp(orderPattern, 'i');
  const tol = typeof opts.amountTolerance === 'number' ? opts.amountTolerance : DEFAULTS.amountTolerance;
  const getOrder = opts.getOrder || null;

  const result = {
    matched: [],
    amountMismatch: [],
    noOrderId: [],
    expense: [],
    notFound: [],
    summary: { total: rows.length, matched: 0, amountMismatch: 0, noOrderId: 0, expense: 0, notFound: 0 },
  };

  for (const row of rows) {
    const { direction, amount } = resolveDirectionAndAmount(row);

    // ④ 支出记录直接跳过（我们只关心「收款」到账，用于确认用户已付款）
    if (direction === 'expense') {
      result.expense.push({ row });
      result.summary.expense++;
      continue;
    }

    const orderId = extractOrderId(row, orderRe);

    // ③ 无订单号：普通消费，跳过
    if (!orderId) {
      result.noOrderId.push({ row });
      result.summary.noOrderId++;
      continue;
    }

    // 有订单号：需要后端订单信息才能判断金额是否一致 / 是否 await_verify
    if (!getOrder) {
      // 未注入订单清单：仅记录「待确认候选」（无法做金额校验），归入 matched 候选，
      // 但标注 needBackendCheck=true，由调用方后续补查。
      result.matched.push({ orderId, amount, row, needBackendCheck: true });
      result.summary.matched++;
      continue;
    }

    const o = await getOrder(orderId);
    if (!o) {
      // 账单有订单号但后端查不到 → 漏单告警
      result.notFound.push({ orderId, row });
      result.summary.notFound++;
      continue;
    }

    // 后端已终态：paid/issued → 视为已处理（不算本次待确认）
    if (o.status === 'paid' || o.status === 'issued') {
      result.matched.push({ orderId, amount, row, already: o.status });
      result.summary.matched++;
      continue;
    }

    // 金额一致性校验（容差 tol，防篡改 / 防误标，宁可漏不可错发）
    if (typeof o.amount === 'number' && Math.abs(o.amount - amount) > tol) {
      result.amountMismatch.push({
        orderId,
        billAmount: amount,
        orderAmount: o.amount,
        row,
      });
      result.summary.amountMismatch++;
      continue;
    }

    // ① 匹配成功：订单号存在且金额一致（且非终态）→ 待确认
    result.matched.push({ orderId, amount, row });
    result.summary.matched++;
  }

  return result;
}

// ===========================================================================
// 输入读取：CSV 文件 / 加密 zip（可选解压）
// ===========================================================================

/**
 * 读取输入：
 *   - .csv  → 直接读文本；
 *   - .zip  → 需 env ALIPAY_ID_LAST6（身份证后6位）作为密码解压，再读其中 CSV。
 *            解压为可选能力：优先用轻量库（yauzl / jszip）。若未安装且是 zip 输入，
 *            给出明确提示后抛出可读错误（纯 CSV 路径不受影响）。
 *
 * @param {string} inputPath
 * @param {{zipPassword?:string}} [opts]
 * @returns {Promise<string>} CSV 文本
 */
async function readInput(inputPath, opts = {}) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext !== '.zip') {
    return fs.readFileSync(inputPath, 'utf8');
  }

  // zip 分支
  const password = opts.zipPassword || process.env.ALIPAY_ID_LAST6 || '';
  if (!password) {
    throw new Error('zip 输入需要解压密码：请设置环境变量 ALIPAY_ID_LAST6（身份证后6位）');
  }
  // 轻量解压方案：优先 yauzl，其次 jszip；均懒加载，不强制依赖
  let csvText = '';
  try {
    const yauzl = require('yauzl');
    csvText = await new Promise((resolve, reject) => {
      yauzl.open(inputPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (/\.csv$/i.test(entry.fileName)) {
            zipfile.openReadStream(entry, { password }, (e2, stream) => {
              if (e2) return reject(e2);
              let buf = '';
              stream.on('data', (d) => (buf += d.toString('utf8')));
              stream.on('end', () => {
                zipfile.close();
                resolve(buf);
              });
              stream.on('error', reject);
            });
          } else {
            zipfile.readEntry();
          }
        });
        zipfile.on('error', reject);
      });
    });
  } catch (e) {
    // yauzl 未安装 → 尝试 jszip
    try {
      const JSZip = require('jszip');
      const data = fs.readFileSync(inputPath);
      const zip = await JSZip.loadAsync(data, { password });
      const csvEntry = Object.keys(zip.files).find((n) => /\.csv$/i.test(n));
      if (!csvEntry) throw new Error('zip 内未找到 CSV 文件');
      csvText = await zip.files[csvEntry].async('string');
    } catch (e2) {
      throw new Error(
        'zip 解压需要轻量依赖（yauzl 或 jszip）且需设置 ALIPAY_ID_LAST6；' +
          `当前未满足（${e2.message}）。纯 CSV 路径无需依赖，请改用 CSV 文件输入或安装解压库。`
      );
    }
  }
  return csvText;
}

// ===========================================================================
// 对外主入口（供脚本/主循环调用）
// ===========================================================================

/**
 * 解析并匹配一个账单输入（文件或 zip）。
 * @param {string} inputPath
 * @param {object} [opts] 透传给 matchBill + readInput
 * @returns {Promise<object>} matchBill 的分类结果
 */
async function processBillFile(inputPath, opts = {}) {
  const text = await readInput(inputPath, opts);
  const rows = parseCsvText(text);
  return matchBill(rows, opts);
}

// ===========================================================================
// 导出（可单测）
// ===========================================================================
module.exports = {
  DEFAULTS,
  FIELD_MAP,
  DIRECTION_COL,
  splitCsvLine,
  parseCsvText,
  extractOrderId,
  resolveDirectionAndAmount,
  matchBill,
  readInput,
  processBillFile,
};

// ===========================================================================
// 自测（node bill-csv-matcher.js 时执行；被 require 时不运行）
// ===========================================================================
if (require.main === module) {
  (async () => {
    // 样例 CSV：模拟支付宝官方导出格式（含前置导出信息行 + 标准表头 + 数据行）。
    // 覆盖四种情况：
    //   r1 备注有效订单号 + 金额正确           → ① 匹配成功
    //   r2 商品说明有订单号 + 金额不符（篡改）  → ② 金额不符（告警）
    //   r3 无订单号（便利店消费）               → ③ 无订单号（跳过）
    //   r4 一条支出记录                         → ④ 支出（跳过）
    const sampleCsv = [
      '支付宝交易记录明细查询',
      '账号:test@example.com  导出时间:2025-07-30 12:00:00',
      '',
      '交易时间,收/支,金额,收付款方式,交易状态,商品说明,对方,对方账号,交易订单号,商户订单号,备注',
      '2025-07-30 12:01:05,收入,¥29.00,余额,交易成功,SEA1-会员月费,张三,,2025073022001001,OUT20250730001,SEA1-20250730-AB12CD',
      '2025-07-30 12:05:33,收入,¥79.00,余额,交易成功,SEA1-20250730-EF34GH,李四,,2025073022001002,OUT20250730002,SEA1-20250730-EF34GH',
      '2025-07-30 12:09:10,收入,¥19.00,余额,交易成功,SEA1-会员月费(改),张三,,2025073022001003,OUT20250730003,SEA1-20250730-AB12CD',
      '2025-07-30 13:00:00,收入,¥12.50,余额,交易成功,便利店消费,便利店,,2025073022001004,OUT20250730004,',
      '2025-07-30 14:00:00,支出,-¥15.00,银行卡,交易成功,转账给王五,王五,,2025073022001005,OUT20250730005,',
    ].join('\n');

    console.log('=== 样例 CSV 解析 + 匹配 ===');
    const rows = parseCsvText(sampleCsv);
    console.log(`解析出数据行 ${rows.length} 条（预期 4 条数据 + 跳过前置导出信息）\n`);

    // 本地 await_verify 订单清单（mock 注入，不连真服务）
    const mockOrders = {
      'SEA1-20250730-AB12CD': { order_id: 'SEA1-20250730-AB12CD', status: 'await_verify', amount: 29.0 },
      'SEA1-20250730-EF34GH': { order_id: 'SEA1-20250730-EF34GH', status: 'await_verify', amount: 79.0 },
    };
    const getOrder = (id) => mockOrders[id] || null;

    const res = await matchBill(rows, { getOrder });

    const fmt = (r) => JSON.stringify(r.row);
    console.log('① 匹配成功（待确认）：');
    for (const m of res.matched) {
      console.log(`   ✅ ${m.orderId}  金额=${m.amount}  备注=${m.row.remark || m.row.goodsTitle}`);
    }
    console.log('\n② 金额不符（告警，已跳过确认）：');
    for (const a of res.amountMismatch) {
      console.log(`   ⚠️  ${a.orderId}  账单金额=${a.billAmount}  后端金额=${a.orderAmount}（疑似篡改/误标）`);
    }
    console.log('\n③ 无订单号（跳过）：');
    for (const n of res.noOrderId) {
      console.log(`   ⏭  ${n.row.goodsTitle || n.row.remark || '(空)'}`);
    }
    console.log('\n④ 支出记录（跳过）：');
    for (const e of res.expense) {
      console.log(`   ⏭  支出 ${e.row.amount}  ${e.row.goodsTitle || ''}`);
    }
    console.log('\n--- 汇总 ---');
    console.log(JSON.stringify(res.summary, null, 2));

    // 断言关键结论
    const ok =
      res.matched.length === 2 &&
      res.matched.every((m) => m.orderId === 'SEA1-20250730-AB12CD' || m.orderId === 'SEA1-20250730-EF34GH') &&
      res.amountMismatch.length === 1 &&
      res.amountMismatch[0].orderId === 'SEA1-20250730-AB12CD' &&
      res.noOrderId.length === 1 &&
      res.expense.length === 1;
    console.log(`\n自检结论：${ok ? 'PASS ✅' : 'FAIL ❌'}`);
    process.exit(ok ? 0 : 1);
  })().catch((e) => {
    console.error('运行失败：', e.message);
    process.exit(2);
  });
}
