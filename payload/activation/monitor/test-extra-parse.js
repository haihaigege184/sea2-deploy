'use strict';
/**
 * test-extra-parse.js — 监控器账单解析的边界补充单测（纯函数，直接 `node test-extra-parse.js`）
 * 配合工程师的 test-parse.js，重点覆盖：
 *   - 备注无订单号 → 解析后仍保留原始备注文本，且 extractOrderId 返回 null（监控器据此跳过，不误匹配）；
 *   - 正常匹配 → 返回订单号 + 金额；
 *   - 金额提取边界：千分位、全角 ¥、负数。
 * 说明：监控器「金额不符跳过并告警」「备注无订单号跳过」的最终决策在 processTransactions（需连激活服务器，
 * 属 E2E，建议真实环境由用户配合验证）；本测试覆盖其依赖的纯解析层（可单测部分）。
 */

const { parseBillTransactions, extractAmount, extractOrderId } = require('./alipay-bill-monitor');
const ORDER_RE = /SEA1-\d{8}-[A-Z0-9]{6}/g;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}

console.log('边界：备注无订单号的交易');
{
  const html = `
  <html><body>
    <div class="J-item">
      <span class="time">2025-07-30 09:00:00</span>
      <span class="amount">¥8.80</span>
      <span class="memo">便利店消费</span>
    </div>
  </body></html>`;
  const txns = parseBillTransactions(html, { orderPattern: 'SEA1-\\d{8}-[A-Z0-9]{6}' });
  ok(txns.length === 1, '解析出 1 条交易');
  ok(txns[0].amount === 8.8, `金额正确 ${txns[0].amount}`);
  ok(txns[0].memo === '便利店消费', '无订单号时 memo 保留原始备注文本');
  ok(extractOrderId(txns[0].memo, ORDER_RE) === null, 'extractOrderId(memo) === null → 监控器会跳过该笔（不误匹配）');
}

console.log('正常匹配：备注含订单号 + 金额');
{
  const html = `
  <div class="J-item">
    <span class="amount">¥99.00</span>
    <span class="memo">SEA1-20250730-AA11BB 谢谢老板</span>
  </div>`;
  const txns = parseBillTransactions(html, { orderPattern: 'SEA1-\\d{8}-[A-Z0-9]{6}' });
  ok(txns.length === 1, '解析出 1 条');
  ok(txns[0].memo === 'SEA1-20250730-AA11BB', `提取订单号正确（${txns[0].memo}）`);
  ok(txns[0].amount === 99, `提取金额正确（${txns[0].amount}）`);
  ok(extractOrderId(txns[0].memo, ORDER_RE) === 'SEA1-20250730-AA11BB', 'extractOrderId 命中订单号');
}

console.log('金额提取边界');
{
  ok(extractAmount('¥1,234.56') === 1234.56, '千分位逗号 → 1234.56');
  ok(extractAmount('￥100.00') === 100, '全角 ¥ → 100');
  ok(extractAmount('-9.99') === -9.99, '负数 → -9.99');
  ok(extractAmount('金额 ¥0.50') === 0.5, '小数角分 → 0.5');
  // 不应把日期/时间误判为金额
  ok(Number.isNaN(extractAmount('2025-07-30')) || extractAmount('2025-07-30') === 0, '纯日期不被误判为金额');
}

console.log('订单号提取边界');
{
  ok(extractOrderId('转账备注 SEA1-20250730-ZZ99YY 已付', ORDER_RE) === 'SEA1-20250730-ZZ99YY', '备注中夹带订单号可提取');
  ok(extractOrderId('完全无关的说明文字', ORDER_RE) === null, '无订单号返回 null');
}

console.log(`\n监控器解析补充测试：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
console.log('全部通过 ✅');
