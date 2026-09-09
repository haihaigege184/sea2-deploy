# 支付宝账单监控器（过渡方案）

> 路径：`activation-server/monitor/`
> 作用：在「当面付」签约被风控拦断期间，作为个人收款码（manual）路径的**到账核验**兜底，
> 把 `await_verify`（待核验）订单推进为 `paid`，从而触发后续发码。

> 🟡 **当前模式：手动确认（bot 管理员命令）**。自动监控器（无头 Chrome / CDP / CSV）已冻结为可选过渡，**当前未启用**。
> 订单的 `await_verify → paid` 推进改由 bot 管理员发送「确认订单 SEA1-xxx」命令完成（见 bot 插件 `plugins/vip/vip_core.js` 的 `cmdAdminConfirmOrder`）。
> 当面付签约恢复、官方 `alipay.trade.query` 上线后，可重新启用本目录监控器（见第 7 / 9 节）。

---

## 1. 为什么需要它

个人码场景下，用户扫码付款后发「已支付 <订单号>」。原实现 `confirmManual` 直接 `markPaid`
并发 license，导致**未付款也能白嫖**。修复后：

```
用户申报(已支付) → await_verify(待核验)  --[本监控器/商户核验到账]-->  paid  --[bot 轮询]-->  issue(发码)
```

本脚本即「监控器」：无头 Chrome 登录用户支付宝 → 定时读账单 → 解析金额+备注里的订单号 →
匹配后端 `await_verify` 订单，金额一致则调 `/api/admin/order/confirm` 推进 `paid`。

⚠️ **这是过渡方案**。支付宝 Web 账单页结构可能随时改版；官方「当面付」签约恢复后请切换为
`alipay.trade.query` 主动查询（见第 6 节）。

---

## 2. 安装

```bash
cd activation-server/monitor
npm install          # 仅安装 puppeteer（与激活服务主进程解耦，不影响其依赖）
node test-parse.js   # 可选：跑一遍解析纯函数单测，确认解析逻辑可用
```

> 服务器需有可用的 Chrome（puppeteer 自带 Chromium，或用 `CHROME_PATH` 指定系统已装 Chrome）。
> 无界面服务器建议预装 `xvfb` 以便首次扫码登录（见第 3 节）。

---

## 3. 首次登录（扫码）

1. 配置好 `MONITOR_TOKEN`（见第 4 节）与 `config.json` / 环境变量。
2. 启动脚本：
   ```bash
   # 有图形界面（或本地笔记本）直接跑：
   node alipay-bill-monitor.js
   # 无界面服务器，用 xvfb 提供虚拟显示以便扫码：
   xvfb-run -a node alipay-bill-monitor.js
   ```
3. 脚本检测到未登录时，会：
   - 把登录二维码截图保存到 `monitor/alipay-login-qr.png`；
   - 在日志打印二维码 dataURL（前 80 字符）便于排查；
   - **请你用支付宝 App 扫描该二维码完成登录**（把 `alipay-login-qr.png` 拷到本地扫，或本地直接跑）。
4. 登录成功后，cookie 持久化到 `monitor/.alipay-auth.json`（权限 0600）。**之后自动复用，无需重复扫码。**
5. cookie 失效（被踢/过期）时，脚本会重新走扫码流程 —— 此时需再次人工扫码（日志会告警）。

> 推荐做法：在**有界面的机器**首次登录拿到 `.alipay-auth.json`，再拷贝到生产服务器，
> 之后以 `headless: true` 常驻运行。

---

## 4. 管理 Token（务必配置，勿裸奔）

> ⚠️ **安全加固（2025-07-30）**：激活服务的 `/api/admin/order/confirm` 已改为
> **强制专用 `MONITOR_TOKEN`**——服务端**未配置** `MONITOR_TOKEN` 时该接口直接停用（始终 401），
> **不再**退回默认 admin 口令。若 `ADMIN_TOKEN` 仍为默认弱口令 `changeme-admin-token` 或
> `MONITOR_TOKEN` 缺失，启动时会打印安全告警。

两端（服务端与监控器）鉴权规则：
- 监控器调用 `/api/admin/order/confirm` 必须带专用 `MONITOR_TOKEN`：请求头 `x-monitor-token: <token>`；
- 服务端未设 `MONITOR_TOKEN` → 接口停用（401），无论带什么 token（含默认 admin 口令）都不放行。

两端（服务端与监控器）必须使用**同一个** `MONITOR_TOKEN` 值。

生成 token（服务端环境变量与监控器配置填同一个）：
```bash
openssl rand -hex 32
# 例：export MONITOR_TOKEN="a1b2c3...（32字节十六进制）"
```

服务端（激活服务）下发：在 `activation-server` 的启动环境里设 `MONITOR_TOKEN=...`。
监控器：在 `monitor/config.json` 设 `"monitorToken"` 或环境变量 `MONITOR_TOKEN=...`。

> 若服务端未配置 `MONITOR_TOKEN`，监控器调用确认接口会收到 401——此时 `await_verify` 订单
> 无法自动核验到账，需先补齐强 `MONITOR_TOKEN` 并重启激活服务。

---

## 5. pm2 守护（常驻）

```bash
cd activation-server/monitor
pm2 start alipay-bill-monitor.js --name alipay-monitor --output monitor.out.log --error monitor.err.log
pm2 save
# 查看日志：pm2 logs alipay-monitor
# 重启：pm2 restart alipay-monitor
# 停止：pm2 stop alipay-monitor
```

> 若服务器无图形界面，用 `xvfb` 包一层启动脚本，或在有界面机器首次登录后拷贝 `.alipay-auth.json` 再 `pm2 start`。

---

## 6. 配置项（环境变量优先，其次 `config.json`）

| 配置键(env)            | 说明 |
|------------------------|------|
| `ACTIVATION_SERVER`    | 激活服务地址，如 `http://127.0.0.1:3457` |
| `MONITOR_TOKEN`        | 专用监控 token（强烈建议设置） |
| `ADMIN_TOKEN`          | 兜底 token（未设 MONITOR_TOKEN 时使用） |
| `ALIPAY_BILL_URL`      | 支付宝账单页 URL（默认个人账单页） |
| `POLL_INTERVAL_MS`     | 轮询间隔，默认 `60000`（60s） |
| `CHROME_PATH`          | 系统 Chrome 路径，留空用 puppeteer 自带 |
| `HEADLESS`             | `true` 无头运行；`false` 显示界面 |
| `HEADFUL_FIRST_LOGIN`  | `true` 首次登录用有界面（配合 xvfb-run） |
| `AUTH_FILE`            | cookie 持久化文件，默认 `.alipay-auth.json` |
| `QR_IMAGE_FILE`        | 登录二维码截图路径 |
| `ORDER_PATTERN`        | 订单号正则（须与后端订单号格式一致） |
| `AMOUNT_TOLERANCE`     | 金额容差，默认 `0.01` |
| `LOGIN_TIMEOUT_MS`     | 扫码登录超时，默认 `300000`（5 分钟） |
| `QR_SELECTOR`          | 登录二维码元素选择器（支付宝改版时调整） |
| `USER_AGENT`           | 浏览器 UA |

> **支付宝改版应对**：账单解析的所有选择器/正则集中在 `alipay-bill-monitor.js` 的
> `PARSE_DEFAULTS` 与 `QR_SELECTOR`。若某轮解析到 0 条记录，脚本会打印告警，
> 此时多半是页面结构变了 —— 调整上述选择器即可，主流程无需改动。

---

## 7. 迁移到官方「当面付」`alipay.trade.query`（签约恢复后）

当面付签约恢复、风控解除后，应**弃用本过渡监控器**，改回全自动官方路径：

1. 在激活服务配置 `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY`，
   使其进入 `webhook` 模式（动态码 `alipay.trade.precreate` + 异步通知验签）。
2. 用户付款后，支付宝异步通知 `/api/pay/notify`，服务端 `handleWebhook` 验签后直接 `markPaid`。
3. 可选：保留一个轻量 `alipay.trade.query` 定时对账任务，作为异步通知的补充兜底。
4. 停用并卸载本监控器：`pm2 stop alipay-monitor && pm2 delete alipay-monitor`，
   删除 `monitor/` 目录与 `.alipay-auth.json`（含用户登录态，注意隐私清理）。

> `await_verify` 状态机保留无妨：webhook 路径不会进入该状态；它仅服务于个人码场景。

---

## 9. CSV 解析匹配模块（bill-csv-matcher.js）

> 路径：`activation-server/monitor/bill-csv-matcher.js`
> 作用：为「**方式②官方账单导出 CSV 解析**」铺路的可单测模块。零登录、零浏览器依赖，
> 仅解析本地/样例 CSV（或加密 zip 解压后的 CSV），与本地 `await_verify` 订单清单做匹配与金额校验。
> 用户一拿到真实支付宝导出 CSV，即可直接跑它验证「字段是否够用、订单号/金额能否对上」。

### 为什么单独拆出这个模块
- 方式②（官方导出 CSV）是最稳、零风控的核验路径，但依赖真实 CSV 字段格式；
- 该模块把「解析 + 提取订单号 + 金额校验 + 匹配分类」做成纯函数，可单测、可离线验证；
- 不依赖真实登录 / 不下载 Chromium / 不 SSH 主服务器，拿到样例即可跑。

### 运行

```bash
cd activation-server/monitor

# 1) 内置样例 CSV 自测（覆盖 4 类情况：匹配成功/金额不符/无订单号/支出）
node bill-csv-matcher.js
#   退出码 0 = 自检 PASS；非 0 = FAIL

# 2) 解析你自己的导出 CSV（推荐先用 sample-bill.csv 对比字段）
node bill-csv-matcher.js ./sample-bill.csv

# 3) 解析官方加密 zip 导出（密码 = 身份证后6位，需轻量解压库 yauzl 或 jszip）
#    ALIPAY_ID_LAST6=123456 node bill-csv-matcher.js ./bill.zip
#    纯 CSV 路径无需任何依赖；zip 分支缺失库时会打印明确的安装提示。
```

### 字段映射（以支付宝官方导出 CSV 表头为准）

| 支付宝官方表头 | 内部字段名 | 用途 |
|----------------|-----------|------|
| 交易时间       | `time`      | 交易时间 |
| 收/支          | `direction` | 收入/支出方向（决定跳过还是核验） |
| 金额           | `amount`    | 金额（带 ¥/千分位/正负号均归一化） |
| 收付款方式     | `payMethod` | 收付款方式 |
| 交易状态       | `tradeStatus` | 交易状态 |
| 商品说明       | `goodsTitle` | 商品说明（常含用户填写的订单号） |
| 对方           | `counterparty` | 对方 |
| 对方账号       | `counterpartyAccount` | 对方账号（常为空） |
| 交易订单号     | `tradeOrderId` | 支付宝交易订单号（非业务订单号） |
| 商户订单号     | `merchantOrderId` | 商户订单号 |
| 备注           | `remark`    | 备注（常含用户填写的订单号） |

订单号提取正则与现有 `alipay-bill-monitor.js` **保持一致**：`SEA1-\d{8}-[A-Z0-9]{6}`，
依次从 `备注` → `商品说明` → `商户订单号` 提取。

### 匹配分类输出

`matchBill(rows, { getOrder, orderPattern, tolerance })` 返回：

| 分类 | 触发条件 | 含义 |
|------|---------|------|
| `matched`        | ① 订单号存在 + 金额一致（容差 0.01）+ 后端为 `await_verify` | 待确认（推进 paid 的候选） |
| `amountMismatch` | ② 订单号存在但金额不符 | 跳过 + 告警（防篡改/误标，宁可漏不可错发） |
| `noOrderId`      | ③ 备注/商品说明无订单号 | 普通消费，跳过 |
| `expense`        | ④ 收/支 = 支出 | 非收款，跳过 |
| `orderNotFound`  | （辅助）账单有订单号但本地查不到 | 疑似漏单/已清理/已过期，告警 |

> `getOrder(orderId)` 为注入函数（mock 或真实后端都行），本模块**不直接连真服务**。

### 导出函数（可单测）

`splitCsvLine` / `parseCsvText` / `extractOrderId` / `resolveDirectionAndAmount` /
`matchBill` / `readInput` / `processBillFile` / `DEFAULTS` / `FIELD_MAP`。



## 8. 已知风险

- **支付宝风控 / 页面改版**：无头浏览器登录可能被风控挑战（滑块/设备验证），导致登录失败；
  账单页结构变更会使解析为 0 条。二者均有日志告警，但需人工介入（换 UA / 调选择器 / 人工扫码）。
- **漏单告警**：账单里出现订单号但后端查不到、或金额不符、或确认接口失败，都会打印 `warn/error`
  级告警，便于人工补单；监控器不会静默吞错。
- **cookie 失效需人工**：cookie 过期后必须人工扫码，无法全自动恢复（这是个人号登录的固有限制）。
- **务必让付款用户在转账备注填写订单号**：监控器靠备注里的订单号关联订单；不填则无法自动核验，
  只能走商户后台人工确认（`/api/admin/order/confirm`）。
