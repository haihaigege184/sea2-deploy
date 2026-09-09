# SEA1 运维控制台（/console）增量 PRD v1.0

> 产品经理：许清楚 ｜ 语言：简体中文 ｜ 基线：activation-server 现网代码实读
> 读码范围：`server.js`(249-309) / `lib/fleet.js`(全文) / `lib/fleetStore.js`(全文) / `lib/fleetConfig.js` / `lib/consoleApi.js`(291-424) / `public/console.js`(500-735) / `public/console.html` / 客户端侧 `sea1/licensing/index.js`(244-338) + `sea1/licensing/lib/command-handler.js` + `heartbeat.js`

---

## 0. 读码后新增的关键发现（超出原始诊断，请架构师重点看）

原始根因（online 与 license 耦合）成立，但**不是唯一原因**。实读后又定位到 4 个同源缺陷，叠加导致"运维页什么都看不出来"：

| # | 发现 | 证据 | 影响 |
|---|---|---|---|
| F1 | **online 与 valid 耦合**（已知） | `fleet.js:42-46` | 连着的设备被判为 `normal`，不计入在线聚合 |
| F2 | **"离线"需要 7 天才成立，中间存在 2 分钟～7 天的状态黑洞** | `fleet.js:47-50`，`offlineSec = fleetOfflineDays(7) × 86400` | 设备 10 分钟前掉线，状态仍是 `normal`（UI 显示"正常"），既不在线也不离线，运维完全无感 |
| F3 | **列表 API 根本不返回 `reason`，但前端在渲染它** | `fleet.js:73-87` 无 reason 字段；`console.js:541` 表头有「原因」列、`console.js:573` 渲染 `x.reason` | 集群表「原因」列**永远显示 —**，是死列 |
| F4 | **快照不存 `reason`，详情页「心跳原因」也永远是 —** | `fleetStore.js:32-49 emptySnapshot` 无 reason 字段，`recordHeartbeat` 只把 reason 写进 `history[0]`；`console.js:624` 读 `s.reason` | 运维无法自助判断"为什么这台没授权" |
| F5 | **心跳成功路径 `reason` 不改写为 `ok`**（已知）+ **无 license 记录直接 valid=false** | `server.js:266` `let reason='no-record'`，成功分支只置 `valid=true` 未改 reason；`server.js:270` `else if (rec && lic)`，`store.getLicense(code)` 为空时直接 `no-record` | X86 客户端 valid=false 的直接原因大概率是**服务端 store 里没有该 code 的 license 记录**，而非验签失败 |
| F6 | **远程指令"虚假成功"——最严重的信任问题** | `command-handler.js:82-142`：未挂钩子时只打日志仍 `return {ok:true}` → `licensing/index.js:272-274` 加入 ackIds → 服务端 `markAcked` 标为 `acked`。而全仓 grep `onRestart\|onDisableClient\|onNotice\|onConfig` **在 sea1 宿主侧零命中** | **现有 6 条指令全部是空转 no-op，但运维页会显示"已执行(acked)"**。运维点了"重启客户端"，页面绿了，实际什么都没发生 |
| F7 | **ack 通道无结果回传能力** | `server.js:259-262` 心跳只接收 `ack_id` 数组；`fleetStore.markAcked(id)` 只改状态，不存结果 | `fetch_logs` / `health_check` / `screenshot` 这类**有返回值**的指令目前**没有任何通道**把结果送回控制台——这是指令集扩展的**前置基础设施** |

可复用事实：设备侧由 **pm2** 托管 4 个进程（`ecosystem.config.cjs`：`sea1-bot` / `ncqq` / `sea1-activation` / `sea1-login-gateway`），因此 `restart_bot` / `restart_napcat` 有现成落地路径（`pm2 restart <name>`），实现成本低。

---

## 1. 产品目标

1. **状态可信**：运维页展示的"在线/离线/授权"必须与设备真实状态一一对应，做到「连接状态」与「授权状态」两个维度正交、各自独立可读，杜绝一个字段掩盖另一个字段。
2. **操作可验证**：任何远程指令从下发到生效全过程可观测（pending → sent → acked/timeout/unsupported/failed），并且**只有真正执行了才报成功**，运维不需要 SSH 上机复核。
3. **能力覆盖运维日常**：远程指令集从"6 条演示级"扩展到覆盖 90% 日常处置场景（重启子进程 / 拉日志 / 探活 / 恢复客户端 / 改配置），把上机运维降为例外路径。

---

## 2. 用户故事（运营/运维视角）

- **US-1** 作为运维，我希望打开集群 Tab 就能看到"当前真实有多少台设备连着"，这样我不用再登服务器 grep 心跳日志来确认设备是否存活。
- **US-2** 作为运维，我希望在同一行同时看到"在线"和"未授权/已过期/机器码不匹配"两个独立标识，这样我能立刻区分"设备挂了"和"授权掉了"这两类完全不同的故障。
- **US-3** 作为运维，我希望某台设备 5 分钟没心跳时页面就变成"掉线"并高亮，而不是等 7 天，这样我能在客户投诉前主动介入。
- **US-4** 作为运维，我希望下发指令后抽屉不关闭、能实时看到回执状态流转，并且未生效的指令明确标红，这样我不会误以为处置已完成。
- **US-5** 作为运维，我希望能一次选中多台设备批量推送通知/下发配置，这样版本公告不用点 50 次。
- **US-6** 作为运维，我希望能远程"重启 sea1-bot"或"重启 napcat"而不是只能整机重启，这样处置粒度更小、对客户影响更低。
- **US-7** 作为运维，我希望能远程拉取客户端最近日志并在控制台查看，这样 80% 的故障排查不用上机。
- **US-8** 作为客服主管，我希望看到按地域/版本的分布统计，这样我能判断某次版本灰度是否有异常聚集。

---

## 3. 需求池

### P0 — 必须做（本期不做则运维页不可用）

#### P0-1｜连接状态与授权状态解耦
- **现状**：`fleet.js:42-46` 中，近期有心跳时还要看 `history[0].valid`，valid=false 就降级成 `normal`；`normal` 不计入 `agg.online`（`fleet.js:105`）。
- **目标**：状态模型拆成两个正交维度并分别下发到前端：
  - `connectivity`（连接）：`online` / `stale`（掉线） / `offline`（长期离线）— **只看心跳新鲜度，不看 license**
  - `licenseState`（授权）：`valid` / `invalid` / `expired` / `mismatch` / `revoked` / `no-record` / `unknown`
  - 保留 `status` 顶层字段用于兼容与置顶告警，建议优先级：`blacklisted > abnormal > connectivity`
- **验收标准**：
  1. 给定一台心跳新鲜、`valid=false` 的设备，`GET /api/admin/fleet/clients` 返回 `connectivity='online'`、`licenseState='no-record'`，且 `agg.online >= 1`。
  2. 聚合卡片「在线」数 == 近期有心跳的设备数，与 `snapshot.online=true && 心跳新鲜` 的集合完全一致。
  3. 现网这台 `af43645e...` 修复后在集群 Tab 显示为「在线」+ 橙色「未授权」徽标。
  4. `blacklisted` / `abnormal` 仍能覆盖显示（拉黑设备不因为在线就丢失拉黑标识）。

#### P0-2｜新增「掉线（stale）」中间态，离线判定分级
- **现状**：`fleet.js:47-50`，只有 `now - last > 7天` 才是 `offline`，之间一律 `normal`（UI 文案"正常"）。
- **目标**：三档判定，阈值全部走 `fleetConfig` 可热更：
  - `now - last <= 2 × fleetHeartbeatInterval`（默认 120s）→ **在线**
  - `120s < now - last <= fleetStaleMinutes`（**新增配置项，默认 30 分钟**）→ **掉线**（黄色）
  - `> fleetStaleMinutes` → **离线**（灰色）；`fleetOfflineDays` 保留给 `long_offline` 异常规则用，不再兼任列表状态判定
  - `lastHeartbeatAt === 0`（从未心跳）→ **未上报**（独立态，不混入 normal）
- **验收标准**：
  1. 停掉一台设备心跳，2×interval 后状态变「掉线」，30 分钟后变「离线」，聚合卡片同步。
  2. 新增 `fleetStaleMinutes` 出现在配置管理「集群管理」分组，改完无需重启即生效（沿用 `fleetConfig.load()` 热读机制）。
  3. `normal` 状态从集群 Tab 状态筛选下拉中移除（或仅保留为"未上报"）。

#### P0-3｜授权状态与 reason 全链路透出
- **现状**：F3/F4 —— 列表 API 不返回 reason（前端死列）、快照不存 reason（详情死字段）。
- **目标**：
  - `fleetStore.emptySnapshot` 增加 `reason` / `valid` / `licenseCheckedAt` 字段，`recordHeartbeat` 同步写入快照（当前只写进了 `history[0]`）。
  - `fleet.listClients` 返回项增加 `reason` / `valid` / `licenseState`；`clientDetail.snapshot` 同理。
  - 前端集群表「原因」列改为**授权徽标**（文案见 UI 章节），详情页「心跳原因」显示真实值 + 中文解释。
- **验收标准**：
  1. 集群表「原因」列不再出现全 `—`（有心跳的设备必有值）。
  2. 详情抽屉「心跳原因」显示如 `no-record（服务端无该授权码的 license 记录）`。
  3. 授权徽标可点击/悬浮，展示处置建议（如 no-record → "请检查该授权码是否在本服务器激活过"）。

#### P0-4｜心跳 reason 语义修正
- **现状**：`server.js:266` 初值 `'no-record'`，校验通过分支（`server.js:277`）只置 `valid=true`，reason 未改写；客户端 `heartbeat.js:92` 的 `j.reason || 'ok'` 兜底不起作用（`'no-record'` 是真值）。
- **目标**：校验通过时 `reason='ok'`；同时把 `rec` 缺失 / `lic` 缺失拆成两个可区分的 reason（`code-not-found` / `license-not-issued`），不再统一吞成 `no-record`。
- **验收标准**：
  1. 一台正常授权设备心跳响应体为 `{ok:true, valid:true, reason:'ok'}`。
  2. 授权码存在但服务端无 license 记录 → `reason='license-not-issued'`；授权码本身不存在 → `reason='code-not-found'`。
  3. 保留 `no-record` 作为向后兼容的别名（旧客户端不因文案变更报错）。

#### P0-5｜远程指令「虚假成功」修复（信任级 Bug）
- **现状**：F6 —— 客户端未挂钩子时 `handleCommand` 仍返回 `ok:true` 并 ack，控制台显示"已执行"，实际零副作用；且 sea1 宿主**当前一个钩子都没挂**，6 条指令全是空转。
- **目标**：
  - 客户端：未挂载对应钩子（且无内置默认实现）时返回 `{ok:false, error:'unsupported'}`，**不进 ackIds**；心跳新增 `ack_results:[{id, ok, error, result?}]` 上报执行结果。
  - 服务端：指令状态机扩展为 `pending / sent / acked / failed / unsupported / timeout`，`markAcked` 升级为 `markResult(id, {ok, error, result})`。
  - 宿主侧（sea1）：本期至少落地 `push_notice` / `push_config` / `restart_client`（走 pm2）三个真实钩子，其余明确标注"客户端未支持"。
  - 控制台：`unsupported` 指令在历史中标灰并提示"该客户端版本不支持此指令"。
- **验收标准**：
  1. 对未挂钩子的客户端下发 `disable_printer`，控制台最终状态为 `unsupported`（**不是 acked**）。
  2. 对已挂钩子的客户端下发 `push_notice`，客户端确实收到并展示，控制台状态为 `acked`。
  3. 指令历史每条可展开查看 `error` / `result` 原文。

### P1 — 应该做（本期强烈建议，运维页可用性核心）

#### P1-1｜集群列表自动刷新 + 刷新态
- **现状**：`console.html:99` 只有手动「刷新」按钮，`console.js` 全文无 `setInterval` 自动刷新。
- **目标**：集群 Tab 默认 30s 自动轮询（可下拉切换 关闭/15s/30s/60s，记忆到 localStorage），仅当该 Tab 可见时轮询；顶部显示"最后更新 xx 秒前"与刷新中态；轮询失败不清空已有表格，仅顶部提示。
- **验收**：切走 Tab 后停止轮询（无后台空请求）；手动刷新按钮与自动刷新互不冲突；刷新时不丢失已展开的抽屉。

#### P1-2｜客户端健康指标展示增强
- **现状**：`recordHeartbeat` 实际已收 `cpuUsage/memUsage/bootTime/publicIp/region/version/clientTs`，但集群表只用了 5 个字段，详情页也只列 12 项；客户端 `heartbeat.js:52-56` 还上报了 `platform/arch/hostname`，服务端**接都没接**。
- **目标**：
  - 服务端补收 `platform` / `arch` / `hostname` 到快照。
  - 集群表新增：CPU%、内存%、最近心跳（相对时间 "12 秒前"）；CPU/内存超阈值（默认 85%）标橙。
  - 详情抽屉「基础信息」补充：平台/架构、主机名、开机时长（由 bootTime 换算为"3天4小时"）、心跳时延（`lastHeartbeatAt - clientTs`，用于发现时钟漂移）、待回执指令数。
- **验收**：一台真实设备详情页 12 项字段无 `—`（除确实未上报的）；开机时长与 `uptime` 一致（±1 分钟）。

#### P1-3｜指令回执实时可见
- **现状**：`console.js:729` 下发成功后立即 `closeModal(); closeClientModal();` 关闭抽屉，运维看不到后续；指令历史无自动刷新。
- **目标**：
  - 下发成功后**保持抽屉打开**，指令历史区顶部插入新指令行并进入"跟踪中"状态，按 5s 轮询 `GET /clients/:mid/commands` 直到终态或 2×interval 超时。
  - 每条指令展示生命周期时间线：`下发 hh:mm:ss → 已下发 → 已执行`（含各阶段耗时）+ 操作人 + 危险标记。
  - 集群表「待执行」徽标区分 pending / sent 两种颜色。
- **验收**：下发 `push_notice` 后无需手动刷新，60s 内状态自动变为 acked；超时的指令自动变红并给出"客户端可能已离线"提示。

#### P1-4｜批量操作
- **目标**：集群表首列加复选框（支持"全选当前筛选结果"），底部出现批量操作条：批量推送通知 / 批量下发配置 / 批量健康检查 / 批量重启（危险，需输入确认词）。批量走前端并发调用现有单机接口（并发上限 5），逐台展示成功/失败明细，**不新增批量后端接口**（降低实现与审计复杂度，审计日志仍逐条记录）。
- **验收**：选中 10 台批量推送通知，结果面板列出 10 条明细；任意一台失败不影响其余；审计日志产生 10 条 `cmd-push_notice` 记录。

#### P1-5｜离线设备视觉降权 + 相对时间
- **目标**：`offline`/`stale` 行整行 60% 灰度；「最近心跳」列显示相对时间（悬浮显示绝对时间）；离线设备的危险指令按钮置灰并提示"设备离线，指令将排队至下次上线"（因为是 pull 模式，指令确实会排队，需明确告知而非隐藏）。
- **验收**：离线设备行视觉上一眼可辨；点击置灰按钮有明确文案解释而非静默失败。

#### P1-6｜地域/版本维度统计
- **目标**：集群 Tab 聚合卡片下方增加一行紧凑分布条：按 `version` 与 `region` 的 Top5 分布（数量 + 占比），点击即作为筛选条件应用到下方表格。聚合在 `listClients` 内一次算完随 `agg` 返回（`agg.byVersion` / `agg.byRegion`），不增加额外请求。
- **验收**：分布数字之和 == 总计；点击"v1.2.3"后表格自动筛选。

#### P1-7｜指令结果回传通道（新指令的前置基础设施）★
- **现状**：F7 —— `ack_id` 只能回传"我执行了"，无法回传"执行结果是什么"。
- **目标**：定义 `ack_results` 协议（与 `ack_id` 并存，向后兼容）：客户端心跳上报 `ack_results:[{id, ok, error?, result?}]`，`result` 为**大小受限**（建议 ≤64KB，超出截断并标记 `truncated:true`）的结构化对象；服务端存入 `command.result` 并在详情抽屉可展开查看/复制/下载。
- **验收**：下发 `health_check` 后，控制台指令历史可展开看到客户端返回的 JSON；超过 64KB 的日志被截断且有明确提示。
- **依赖**：P2 中 `fetch_logs` / `health_check` / `screenshot` 全部依赖本项，**必须先做**。

#### P1-8｜远程指令集扩展 · 第一批
详见第 4 节指令清单中标注 P1 的 5 条：`enable_client`、`restart_bot`、`restart_napcat`、`health_check`、`clear_print_queue`。

### P2 — 可以做（下期或视排期）

- **P2-1｜指令集扩展第二批**：`fetch_logs`、`update_client`、`reregister`、`set_config`、`screenshot`（见第 4 节）。
- **P2-2｜remote_shell（只读诊断）**：**单独立项、本期不做**。即使白名单也等同远程代码执行入口，风险等级与整个控制台的鉴权强度不匹配（当前仅 L2 口令登录）。若必须做，最低要求：命令固定白名单枚举、L3 独占、二次确认 + 操作人 + 全量审计、结果只读回传。
- **P2-3｜集群健康度大盘**：在线率/授权有效率/指令成功率的 24h 趋势曲线（需要新增时序采样存储，成本较高）。
- **P2-4｜指令模板与灰度下发**：常用指令另存为模板；批量下发支持分批（如每批 20 台、间隔 5 分钟），避免全网同时重启。
- **P2-5｜指令二次确认策略可配置**：哪些指令需要输入确认词、哪些需要 L3，改为服务端配置而非前端硬编码（当前 `console.js:661-667` 的 `danger` 标记与 `fleet.js:16 DANGEROUS` 两处硬编码，存在不一致风险）。

---

## 4. 远程指令集清单（评估与收敛）

> **三端改造铁律**：新增任一指令必须同时改 ① `lib/fleet.js` 的 `COMMANDS` + `DANGEROUS` ② `public/console.js` 指令面板选项 + 载荷控件 ③ 客户端 `command-handler.js` 的 `VALID_ACTIONS` + switch 分支（+ 宿主挂钩子）。缺任一端 = 指令空转。

### 4.1 现有 6 条（需补齐宿主钩子，见 P0-5）

| 指令 | 风险 | 客户端现状 | 本期动作 |
|---|---|---|---|
| `restart_client` | 高 | 有分支，**无钩子** | P0：接 pm2 `restart sea1-bot`（或宿主自定义），落地真实实现 |
| `disable_client` | 高 | 有分支，回退 `printPlugin.setEnabled(false)` | P0：确认 printPlugin 是否真注入；否则标 unsupported |
| `disable_printer` | 高 | 有分支，**无钩子** | P0：落地或标 unsupported |
| `enable_printer` | 中 | 有分支，**无钩子** | P0：落地或标 unsupported |
| `push_notice` | 低 | 有分支，**无钩子** | P0：落地（推到 QQ 群/日志） |
| `push_config` | 中 | 有分支 + 白名单（仅 `printer.default`） | P0：落地 onConfig；白名单按需扩展 |

### 4.2 新增候选（已评估收敛）

| 指令 | 用途 | 风险 | 客户端需新增 | 需二次确认 | 需结果回传 | 优先级 | 收敛结论 |
|---|---|---|---|---|---|---|---|
| `enable_client` | 恢复被 `disable_client` 停用的客户端 | 低 | 是（新分支 + `onEnableClient` 钩子；服务端需同时恢复 license，与 `devices.disable` 对称） | 否 | 否 | **P1** | **必做**。当前禁用是单向门，运维误操作后只能上机恢复 |
| `restart_bot` | 重启 `sea1-bot` 进程 | 中 | 是（pm2 restart sea1-bot） | 是 | 否 | **P1** | **必做**。比整机重启粒度小，pm2 已托管，成本低 |
| `restart_napcat` | 重启 `ncqq` 进程（QQ 掉线高频场景） | 中 | 是（pm2 restart ncqq） | 是 | 否 | **P1** | **必做**。运维最高频诉求，同上成本低 |
| `health_check` | 主动探活并即时回传一份完整健康快照 | 低 | 是（复用 `getSysInfo`+`getPrinters` 组装结果） | 否 | **是** | **P1** | **必做**，且是验证 P1-7 结果通道的最佳首个用例 |
| `clear_print_queue` | 清空打印队列 | 中 | 是（`onClearPrintQueue` → CUPS `cancel -a`） | 是 | 否 | **P1** | 建议做。打印是核心业务，堆积是真实故障场景 |
| `fetch_logs` | 拉取客户端最近 N 行日志 | 中（可能含敏感信息） | 是（读取 + 截断 + 回传） | 否 | **是** | **P2** | 做，但**必须在 P1-7 之后**。需限定日志源白名单、行数上限、大小上限 |
| `set_config` | 修改客户端指定配置项 | 中 | 复用 `push_config` 分支即可 | 视键而定 | 否 | **P2** | **不新增指令**，改为扩展 `push_config` 的 `CONFIG_WHITELIST` + 前端键值对表单 |
| `reregister` | 重新注册/重新激活 | 高（可能改变绑定关系） | 是 | 是 | 是 | **P2** | 做，但需先明确业务规则 |
| `update_client` | 客户端自更新 | **极高** | 是（下载+校验+切换+重启+回滚） | 是（+确认词） | 是 | **P2/不做** | **本期不做**（独立项目量级） |
| `screenshot` | 状态快照（非屏幕截图） | 低 | 是 | 否 | **是** | **P2** | **并入 `health_check`** |
| `remote_shell` | 只读诊断命令 | **极高** | 是 | 是（+L3） | 是 | **P2/不做** | **本期明确不做** |

**本期建议落地指令集（6 现有 + 5 新增 = 11 条）**：
`restart_client`、`disable_client`、`enable_client`、`disable_printer`、`enable_printer`、`push_notice`、`push_config`、`restart_bot`、`restart_napcat`、`health_check`、`clear_print_queue`

---

## 5. UI 设计稿

### 5.1 集群 Tab（`#cluster`）整体结构

```
聚合卡片区（4 张）：在线 · 掉线 · 离线 · 异常 ｜ 总计
  ↓
分布条（P1-6）：版本 Top5 ｜ 地域 Top5 · 可点击筛选
  ↓
工具栏：搜索框 ｜ 状态▾ ｜ 授权▾(新增) ｜ 地域▾ ｜ 自动刷新▾(新增) ｜ 手动刷新 ｜ 最后更新 12 秒前
  ↓
客户端表格（新增首列复选框）
  ↓
批量操作条（选中 >0 时浮出）：已选 N 台 ｜ 批量通知 ｜ 批量配置 ｜ 批量探活 ｜ 批量重启(危险)
```

聚合卡片调整：原「在线/离线/异常/总计」→ 改为「在线 / 掉线 / 离线 / 异常」+ 右侧「总计」，并在「在线」卡片下方加一行小字：`其中 N 台授权异常`。

表格列定义（改造后）：

| 列 | 变化 | 说明 |
|---|---|---|
| ☐ | **新增** | 复选框，支持 shift 连选、全选当前筛选结果 |
| 机器码 | 保留 | 截断显示 + 悬浮全文 + 点击复制 |
| QQ / 授权码 / 版本 / 地域 | 保留 | — |
| **连接** | **改造** | 🟢在线 / 🟡掉线 / ⚪离线 / 🔴异常 / ⚫已拉黑 |
| **授权** | **新增（替换死列"原因"）** | ✅已授权 ／ 🟠未授权 ／ 🟠已过期 ／ 🟠机器码不匹配 ／ 🔴已吊销 ／ ⚪未知；悬浮显示 raw reason + 处置建议 |
| **CPU / 内存** | **新增** | `23% / 61%`，超 85% 标橙 |
| 最近心跳 | 改造 | 相对时间"12 秒前"，悬浮绝对时间 |
| 待执行 | 改造 | `pending` 蓝徽标 / `sent` 黄徽标分色 |
| 操作 | 改造 | 详情 ｜ 探活 ｜ 更多▾（重启 bot / 重启 napcat / 禁用 / 重启客户端） |

### 5.2 客户端详情抽屉

① 抽屉顶部新增状态条：
```
┌────────────────────────────────────────────────────────────┐
│ af43645e…  🟢 在线（12 秒前）   🟠 未授权（license-not-issued）│
│ v1.2.3 · linux/x64 · 华东 · 1.2.3.4 · 已运行 3天4小时          │
│ 建议：服务端无该授权码的 license 记录，请检查激活流程 →         │
└────────────────────────────────────────────────────────────┘
```

② 指令面板改造：指令按分组下拉，避免 11 条平铺：

| 分组 | 指令 |
|---|---|
| 诊断 | 健康检查(health_check) · 拉取日志(fetch_logs, P2) |
| 进程 | 重启客户端 ⚠ · 重启 sea1-bot ⚠ · 重启 napcat ⚠ |
| 服务开关 | 禁用客户端 ⚠ · **启用客户端** · 禁用打印机 ⚠ · 启用打印机 |
| 打印 | 清空打印队列 ⚠ |
| 下发 | 推送通知 · 下发配置 |

- 选中指令后，右侧动态渲染载荷控件：无载荷 → 隐藏；选打印机 → 下拉；通知 → 多行文本 + 字数统计；配置 → 键值对表单（白名单键下拉）+ JSON 预览。
- 面板下方常驻提示条："该客户端不支持的指令将显示为『未支持』而非成功"（呼应 P0-5）。
- 离线设备：按钮可点但提示"设备当前离线，指令将排队至下次上线执行（约 N 分钟）"。

③ 指令历史改造（时间线式）：
```
● push_notice        已执行 acked      2026-02-14 10:22:31  by 12345678
  └ 下发 10:22:31 → 已下发 10:22:45(+14s) → 已执行 10:22:47(+2s)
● restart_napcat     未支持 unsupported 2026-02-14 10:20:10  by 12345678
  └ 客户端返回：unsupported（该客户端版本不支持此指令）
● health_check       已执行 acked      2026-02-14 10:18:02  by 12345678
  └ [展开查看返回结果 ▾]  { cpu: 23, mem: 61, printers: 2, … }  [复制]
```

### 5.3 交互流程（下发 → 回执）

```
运维(L2+) → 控制台：选择指令 + 填载荷 → 下发
控制台 → 运维：危险指令弹二次确认
控制台 → 服务端：POST /clients/:mid/command → {commandId, status:'pending'}
控制台：抽屉保持打开，历史插入"跟踪中"行
loop 每 5s，直到终态或超时：
    控制台 → 服务端：GET /clients/:mid/commands
客户端 → 服务端：心跳（携带 ack_results）
服务端：markResult → acked/failed/unsupported
控制台：时间线更新为终态（含结果/错误原文）
```

---

## 6. 待确认问题（主理人已拍板项见文末）

1. **客户端形态是否统一？** `sea1/licensing/lib/command-handler.js`（sea1 内嵌）vs `/opt/sea1-client-x86/client-agent.js`。若为两套独立实现，工作量翻倍 → 架构师优先确认。
2. **是否需要支持 sea2 客户端？** 是否引入 `capabilities` 声明让控制台按能力动态渲染。→ 主理人决定：本期硬编码 11 条，unsupported 状态兜底，capabilities 留作未来增强。
3. **权限分级**：本期维持 L2+ 写权限不变；配置驱动分级留 P2-5。
4. **X86 客户端 valid=false 真实根因**：架构师确认是 `store.getLicense(code)` 无记录（license-not-issued）还是验签失败。
5. **`enable_client` 服务端语义**：是否与 `disable_client`（吊销 license）对称恢复；恢复后 `expires_at` 沿用原值还是重签 → 架构师设计：建议恢复至原 expires_at，不重签。
6. **`fetch_logs` 合规边界**：放 P2，本期不碰。
7. **`update_client` 本期是否做？** → 主理人拍板：**不做**（独立项目量级）。
8. **`fleetStaleMinutes` 默认值**：→ 主理人拍板：**30 分钟**，配置热更。
9. **指令结果保留策略**：架构师设计——建议只保留最近 10 条带 result 的指令，result >64KB 截断标记 truncated。

> 主理人决策汇总：update_client 不做；fetch_logs 留 P2；fleetStaleMinutes=30min；权限与 sea2 capabilities 本期不动；其余 P0/P1 全做。
