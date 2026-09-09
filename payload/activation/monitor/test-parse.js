'use strict';
/**
 * test-parse.js — 账单解析纯函数的最小单测（无需浏览器，直接 `node test-parse.js` 运行）
 * 用 mock HTML 验证 parseBillTransactions / extractAmount / extractOrderId 的提取逻辑，
 * 便于 QA 在支付宝改版后快速回归解析规则。
 */
const { parseBillTransactions, extractAmount, extractOrderId } = require('./alipay-bill-monitor');

// 模拟支付宝账单页 HTML（每条交易包在 <div class="J-item"> 中）
const mockHtml = `
<html><body>
  <div class="J-item">
    <span class="time">2025-07-30 12:01:05</span>
    <span class="amount">¥29.00</span>
    <span class="memo">SEA1-20250730-AB12CD 会员月费</span>
  </div>
  <div class="J-item">
    <span class="time">2025-07-30 12:05:33</span>
    <span class="amount">¥79.00</span>
    <span class="memo">SEA1-20250730-EF34GH</span>
  </div>
  <div class="J-item">
    <span class="time">2025-07-30 13:00:00</span>
    <span class="amount">¥12.50</span>
    <span class="memo">便利店消费</span>
  </div>
</body></html>`;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('  ✗ ' + msg);
    failures++;
  } else {
    console.log('  ✓ ' + msg);
  }
}

console.log('解析 mock 账单 HTML：');
const txns = parseBillTransactions(mockHtml, { orderPattern: 'SEA1-\\d{8}-[A-Z0-9]{6}' });
assert(txns.length === 3, `解析出 3 条交易（实际 ${txns.length}）`);

const t0 = txns[0];
assert(t0.amount === 29, `首条金额=29（实际 ${t0.amount}）`);
assert(t0.memo === 'SEA1-20250730-AB12CD', `首条 memo 提取到订单号（实际 ${t0.memo}）`);
assert(t0.time.includes('2025-07-30 12:01'), `首条时间提取正确（实际 ${t0.time}）`);

const t1 = txns[1];
assert(t1.amount === 79 && t1.memo === 'SEA1-20250730-EF34GH', '第二条订单号+金额正确');

const t2 = txns[2];
assert(t2.amount === 12.5 && t2.memo === '便利店消费', '无订单号的交易保留原始 memo 文本');

console.log('金额/订单号提取边界：');
assert(extractAmount('¥1,234.00') === 1234, 'extractAmount 去千分位逗号');
assert(extractAmount('-12.34') === -12.34, 'extractAmount 处理负数');
assert(
  extractOrderId('备注 SEA1-20250730-ZZ99YY 谢谢', /SEA1-\d{8}-[A-Z0-9]{6}/) === 'SEA1-20250730-ZZ99YY',
  'extractOrderId 从备注文本提取订单号'
);
assert(extractOrderId('没有任何订单号', /SEA1-\d{8}-[A-Z0-9]{6}/) === null, 'extractOrderId 无匹配返回 null');

if (failures) {
  console.error(`\n测试失败：${failures} 项`);
  process.exit(1);
}
console.log('\n全部测试通过 ✅');
