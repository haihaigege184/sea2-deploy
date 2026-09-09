# 说明书：sea2 新手运维指南

> [!DANGER] 生产环境维护请在低峰期操作，高危操作（格式化/白名单变更）必须走运维后台「高危操作」专区，严禁直接 ssh 乱改客户端。
> 本说明书面向 sea2 商用运维体系：服务端激活服务（sea2-server）+ 客户端授权体系（sea2-client）+ 运维控制台（console）。

---

## 01-项目概览与架构

> **适用对象**：首次接手 sea2 商用运维体系的运维人员、部署人员、故障响应人员。
> **前置条件**：具备一台 Linux 服务器（生产 10.0.0.11，arm64/x86_64 均可）、root 权限、能访问管理后台。
> **操作步骤**：阅读本手册前先对照「一键部署-README.md」确认当前部署拓扑；服务端（sea2-server）与客户端（sea2-client）为两个独立仓库。
> **验证方式**：`curl -s http://127.0.0.1:3457/health` 返回 `{"ok":true,...}`；浏览器访问 `http://<服务器IP>:3457/console` 出现运维控制台登录页。
> **常见坑**：不要把 sea1（老激活服务 3456）与 sea2 激活服务（3457）混为一谈；端口 3457 才是 sea2 主服务。

### 1.1 系统组成

sea2 商用运维体系包含两大仓库：

- **sea2-server**（服务端）：激活服务（端口 3457）、支付宝当面付（全自动发码）、运维控制台（console）、容器管理反代（FastOSDocker）、一键部署配置下发、git 推送、穿透地址管理。
- **sea2-client**（客户端）：授权客户端（含加密核心 `core/*.sea`）、NapCat（QQ 登录）、bot 发码器（sea2-bot）、固定码中间页（sea2-qr，端口 13011）。

机器人侧为**双系统（双框架）架构**，同一时刻仅一个框架在岗（详见「07-双系统架构与框架切换」）：

- **主框架 sea2-bot**：主号 `__MAIN_QQ__`，原生 NapCat（HTTP 4000 / WebUI 6100），部署于 `/root/sea2`。
- **副框架 sea1-bot**：铁柱号 `__BACKUP_QQ__`，docker NapCat（HTTP 3000 / WebUI 6099），部署于 `/root/sea1`。

### 1.2 关键端口

| 端口 | 进程/用途 | 说明 |
| --- | --- | --- |
| 3457 | sea1-activation | sea2 激活服务 + 运维控制台 API（生产） |
| 13011 | sea2-qr | 固定码/二维码中间页（登录引导）+ 管理台（/webui/ 动态代理）+ Web 打印（/webprint） |
| 13012 | sea2-print-server | Web 打印独立服务（队列/上传/离线排队） |
| 13007/13008 | sea2-bot | bot 发码端口（13007 被占自动升 13008） |
| 4000 | 原生 NapCat HTTP | 主号 __MAIN_QQ__（主框架 sea2-bot） |
| 6100 | 原生 NapCat WebUI | 主号 WebUI（sea2-bot 管理台按角色代理） |
| 3000 | docker NapCat HTTP | 铁柱号 __BACKUP_QQ__（副框架 sea1-bot） |
| 6099 | docker NapCat WebUI | 铁柱号 WebUI（sea1-bot 管理台按角色代理） |
| 9092 | sea1/sea2-bot | QQ 反向 WS 服务端（适配器监听） |
| 13000 | sea1-bot | 网页端 UI 管理后台（sea1） |

### 1.3 pm2 进程清单（服务端 + 机器人侧 + 客户端）

```bash
# 服务端（生产 10.0.0.11）
pm2 list | grep -E 'sea1-activation|sea2-watchdog'    # 激活服务 + 运维控制台 + 双系统 watchdog
# 机器人侧（生产机 /root/sea1、/root/sea2）
pm2 list | grep -E 'sea1-bot|sea2-bot'                # sea1-bot（副框架）/ sea2-bot（主框架）
pm2 list | grep -E 'sea2-napcat|sea2-qr|sea2-print-server'  # 原生 NapCat / 中间页 / Web 打印服务
# 客户端（每台被授权设备）
pm2 list | grep sea2-                                 # sea2-napcat / sea2-bot / sea2-client / sea2-qr
```

---

## 02-快速部署与安装

> **适用对象**：需要新部署一台 sea2 服务端或客户端设备的运维/实施人员。
> **前置条件**：目标机已装 Node.js ≥18、pm2；服务端另有 git 与 ssh 密钥；客户端另有 QQ 官方客户端（linuxqq 9.9.x）。
> **操作步骤**：服务端用 `./deploy-all.sh server`；客户端用 `./deploy-all.sh client` 或 `bash /root/sea2/scripts/install-sea2.sh`。
> **验证方式**：部署完成后 `curl -s http://127.0.0.1:3457/health`；客户端设备出现在「集群管理」列表且连接态=在线。
> **常见坑**：客户端首次安装必须注入 `SEA2_MASTER_KEY`（密钥不符则解密失败无法启动）；arm32 无官方 NapCat，仅 x86_64/arm64。

### 2.1 服务端部署（一键）

```bash
cd /root/sea1-activation-server          # 或开发机 F:/ai/开发1/sea2-server
bash deploy.sh --dry-run                 # 演练：只打印将执行的命令
bash deploy.sh                           # 完整部署：备份→推送→重启→健康检查→异常回滚
SSH_HOST=root@10.0.0.11 bash deploy.sh   # 指定目标主机（默认已是 root@10.0.0.11）
```

### 2.2 客户端安装（install-sea2.sh）

```bash
cd /root/sea2
SEA2_MASTER_KEY=<64位hex> bash scripts/install-sea2.sh   # 首次：注入核心密钥
DRY_RUN=1 bash scripts/install-sea2.sh                    # 演练模式（只打印）
bash scripts/install-sea2.sh                              # 幂等重跑（已存在进程跳过）
```

脚本会自动：识别架构 → 安装 Node/linuxqq/NapCat.Shell → 迁目录 → pm2 托管 bot/napcat/client/qr 等进程 → 启动中间页 → 提示扫码。

### 2.3 全量部署编排

```bash
./deploy-all.sh server           # 仅服务端
./deploy-all.sh client           # 仅客户端（交互输入目标 IP）
./deploy-all.sh all --with-encrypt   # 全量 + 重新加密核心
DEPLOY_YES=1 ./deploy-all.sh all     # CI 跳过确认
```

---

## 03-运维控制台（console）使用

> **适用对象**：日常运营 sea2 的运维人员（查看订单、设备、异常、高危操作）。
> **前置条件**：拥有 ADMIN_TOKEN（超管）或已授权 QQ 号（L2+ 可写，L0/L1 只读）。
> **操作步骤**：浏览器打开 `http://<服务器IP>:3457/console`，输入 ADMIN_TOKEN 或 QQ 号登录。
> **验证方式**：登录后顶部显示角色与权限等级；左侧 12 个视图菜单可切换。
> **常见坑**：公网访问需要令牌；内网 + LAN_BYPASS=1 时免登录直达（L3 局域网模式）；若新视图空白，检查 server.js 静态路由是否含 `/console.*.js` 通配。

### 3.1 登录与权限

控制台支持两种身份：

- **超管（ADMIN_TOKEN）**：所有权限，环境变量 `ADMIN_TOKEN` 注入。
- **QQ 会话（N4 授权）**：等级 L0-L3；L2+ 可下发远程指令/处置异常，L0/L1 仅只读。

```bash
# 登录接口（运维后台专用）
curl -s -X POST http://127.0.0.1:3457/api/admin/console/login \
  -H 'Content-Type: application/json' \
  -d '{"token":"<ADMIN_TOKEN>"}'
```

### 3.2 视图总览

| 视图 | 用途 |
| --- | --- |
| 总览 | 运行状态 / CPU / 内存 / 设备集群摘要 |
| 集群管理 | 设备在线/授权态分布、批量下发指令 |
| 订单审计 | 订单全生命周期对账 + 手动标记支付/开通/取消 |
| 授权管理 | 激活码 CRUD、绑定纠正 |
| 进程管理 | 服务端 pm2 直控 + 客户端进程自报快照 |
| 打印与CUPS | 跨设备打印机档案 + 设备 CUPS 详情 |
| 容器管理 | FastOSDocker 反代 iframe（经 /docker-mgr/*） |
| 配置中心 | 全部配置项热更新（含运维键/历史回滚） |
| 设备管理 | 设备档案 CRUD、白名单 |
| 高危操作 | 格式化强门禁专区（无 UI 一键直达） |
| 审计中心 | 操作/指令/高危/机器身份四类审计 |
| 帮助中心 | 本文档站（sea1/sea2 说明书 + 搜索） |

---

## 04-集群管理与设备运维

> **适用对象**：需要查看设备在线状态、授权状态、批量操作客户端的运维人员。
> **前置条件**：设备已装 sea2-client 且心跳可达（HTTP 3457 或穿透域名）。
> **操作步骤**：控制台「集群管理」→ 筛选连接性/授权态 → 勾选设备 → 批量下发指令。
> **验证方式**：设备「连接」列显示 在线/掉线/离线；授权列显示七态之一；下发指令后「指令审计」有记录。
> **常见坑**：心跳间隔默认 30s（FLEET_HB_INTERVAL），2× 间隔内有心跳判定在线；LAN_BYPASS 内网免登录时，穿透域名反代回源 127.0.0.1 会被误判内网。

### 4.1 连接四态与授权七态

- 连接：`online` 在线 / `stale` 掉线 / `offline` 离线 / `unreported` 未上报。
- 授权：`valid` 有效 / `invalid` 无效 / `expired` 已过期 / `mismatch` 机器码不符 / `revoked` 已吊销 / `no-record` 无授权记录 / `unknown` 未知。

### 4.2 常用接口

```bash
# 集群客户端列表（运维后台）
curl -s http://127.0.0.1:3457/api/admin/fleet/clients?limit=50
# 集群 meta（阈值/徽标/指令分组）
curl -s http://127.0.0.1:3457/api/admin/fleet/meta
# 设备档案 CRUD
curl -s http://127.0.0.1:3457/api/admin/devices
```

### 4.3 批量指令

| 指令 action | 说明 |
| --- | --- |
| restart_bot | 重启客户端 bot 进程 |
| restart_client | 重启客户端主进程 |
| restart_napcat | 重启 NapCat |
| push_config | 推送配置（config.json 热更新） |
| push_notice | 推送公告 |
| health_check | 健康检查 |
| cups_info / cups_add_printer / cups_set_printer / cups_clear_print_queue | 打印相关 |
| format_device | 格式化设备（高危，走强门禁） |

---

## 05-设备白名单与绑定

> **适用对象**：需要管理设备档案、白名单、绑定纠正的运维人员。
> **前置条件**：已登录控制台且权限 L2+（写操作）。
> **操作步骤**：「设备管理」→ 新增/编辑档案（备注/分组/机型/白名单）→ 保存；绑定纠正走「授权管理」。
> **验证方式**：设备档案 `whitelisted` 字段生效；白名单外设备下发高危指令被拒。
> **常见坑**：R4 已修复「档案 whitelisted + formatWhitelist 前缀双判定」；老版本只改档案仍会被拒，需确认服务端已部署 R4。

### 5.1 白名单机制

设备是否可执行格式化等危险操作 = 总开关 `HIGHRISK_ENABLED` → 白名单（档案 whitelisted + `FORMAT_WHITELIST` 前缀）→ 确认词 → 签发。**TOTP 二次验证已移除（R5）**，门禁链无 TOTP 输入框。

### 5.2 绑定纠正

```bash
# 授权绑定查询
curl -s "http://127.0.0.1:3457/api/admin/ops/binding/lookup?code=<激活码>"
# 绑定纠正（写审计）
curl -s -X POST http://127.0.0.1:3457/api/admin/ops/binding \
  -H 'x-admin-token: <ADMIN_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"code":"<激活码>","newMachineId":"<新机器码>"}'
```

---

## 06-打印与 CUPS 管理

> **适用对象**：处理客户端打印机故障、添加/禁用打印机的运维人员。
> **前置条件**：客户端已上报 `cups` 快照；服务端已配置 CUPS 驱动仓库（可选）。
> **操作步骤**：控制台「打印与CUPS」→ 跨设备打印机列表/设备 CUPS 详情 → 添加打印机/远程禁用。
> **验证方式**：打印机列表显示各客户端自报聚合；指令下发后设备 CUPS 详情更新。
> **常见坑**：远程添加打印机通过指令下发（cups_add_printer），需要客户端在线；驱动包在线仓库 `CUPS_DRIVER_REPO` 空时仅内置型号库。

### 6.1 打印机档案

```bash
# 新增打印机档案（运维后台）
curl -s -X POST http://127.0.0.1:3457/api/admin/printers \
  -H 'x-admin-token: <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"name":"HP_LaserJet","clientId":"<机器码>"}'
# 设备 CUPS 详情（按设备）
curl -s "http://127.0.0.1:3457/api/admin/fleet/printers?clientId=<机器码>"
# CUPS 驱动推荐
curl -s "http://127.0.0.1:3457/api/admin/ops/cups/recommend?model=<型号>"
```

### 6.2 机器人打印命令

机器人侧（sea1/sea2 的 print 插件）支持以下群内命令：

| 命令 | 说明 |
| --- | --- |
| `直接发图/PDF` | 极速打印（发送图片/PDF 自动入队） |
| `去黑` / `双面` / `a3` / `拼图` | 去黑底 / 双面 / A3 切割 / 多图拼图 |
| `队列` / `队列选` / `队列退` | 查看队列 / 选择任务 / 退出队列 |
| `#打印状态` | 实时打印状态（lpstat 摘要 + 当前打印机） |
| `菜单` / `帮助` | 查看命令菜单 / 详细帮助 |
| `取消` / `退出` | 退出当前模式 / 取消排队选择 |

- **#打印状态**：输出当前打印机与最近 3 行 `lpstat` 状态，快速确认打印机是否在线。
- **取消秒回**：打印类命令的回复默认启用自动撤回（5-10 秒），避免刷屏；`开启撤回/关闭撤回` 可控制。
- **去重机制**：以 `user_id:group_id:real_seq` 为键对入站消息去重，防止双 NapCat 连接（主号+铁柱号）同一消息重复触发打印。

---

## 07-双系统架构与框架切换

> **适用对象**：需要理解 sea2 双框架架构、执行框架切换的运维/管理员。
> **前置条件**：拥有管理员权限；切换指令仅在 Sea print 群（__PRINT_GROUP__）内响应。
> **操作步骤**：群内发送 `切换sea2` / `切换sea1` 等指令 → watchdog 执行 → 重启成功后通知管理员 + 发起群。
> **验证方式**：`cat /root/sea2/run/framework.role` 查看当前角色；`pm2 list` 确认在岗 bot online。
> **常见坑**：切换有互斥与心跳回切保护；不要在非 Sea print 群发送切换指令（不响应）。

### 7.1 双系统组成与角色

sea2 机器人侧为双系统（双框架）架构，同一时刻仅一个框架在岗：

| 框架 | 目录 | QQ 号 | NapCat | 角色文件 |
| --- | --- | --- | --- | --- |
| 主框架 sea2-bot | `/root/sea2` | __MAIN_QQ__ | 原生 NapCat（HTTP 4000 / WebUI 6100） | `SEA2_ACTIVE` |
| 副框架 sea1-bot | `/root/sea1` | __BACKUP_QQ__ | docker NapCat（HTTP 3000 / WebUI 6099） | `SEA1_ACTIVE` |

- 当前角色记录在 `/root/sea2/run/framework.role`（`SEA1_ACTIVE` / `SEA2_ACTIVE`），由 watchdog 维护。
- 两个框架共用同一套打印插件与适配器逻辑，改动需保持同步（print 插件 md5 一致是惯例）。

### 7.2 watchdog 切换与互斥

- `sea2-watchdog` 常驻进程负责：角色仲裁、心跳检测、切换执行、异常回切。
- 切换由服务端 `/api/ops/framework-cmd/request` 下发（设备侧轮询 `/api/ops/framework-cmd/poll` 后执行并 ack）。
- **互斥规则**：同一时刻仅一个框架在岗；切换时先停旧框架再启新框架，避免双号同时在线互踢。
- **心跳回切**：在岗框架心跳异常（如 NapCat 掉线、channelManager 通道不可用）时，watchdog 按策略回切到另一框架；`/root/sea2/run/heartbeat.json` 记录主通道状态与角色。
- 中间页管理端点（如 `/api/dual/switch`）也会触发 watchdog 切换，属于**非群聊发起**，重启通知仅私发管理员。

### 7.3 群内切换指令

Sea print 群（__PRINT_GROUP__）内，管理员发送以下任一指令即可切换：

- `切换sea1`：切换到副框架 sea1-bot（铁柱号）
- `切换sea2`：切换到主框架 sea2-bot（主号）
- `切换主框架`：切换到主框架（sea2-bot）
- `切换副框架`：切换到副框架（sea1-bot）
- `切换框架`：切换到另一框架（按当前角色自动取反）

**权限**：仅管理员（superAdmin/developer 或 L2+）可用；指令仅 Sea print 群响应，其他群不响应。指令下发后结果私发管理员；watchdog 执行切换并重启目标 bot。

### 7.4 重启通知规则

- **群内指令发起**：目标 bot 重启成功后，通知**私聊发送管理员 + 发送到发起群**（Sea print 群），文案注明"已切换完成，系统恢复正常"。
- **非群聊发起**（中间页 `/api/dual/switch` 或其他方式）：仅私发管理员，不向任何群发送。
- 实现：切换指令下发成功时写入 `/root/sea2/run/last-switch-group.json`（`{"groupId":"...","ts":<epoch_ms>,"from":"群内"}`）；重启通知读取该文件，10 分钟窗口内视为群内发起，发完即删；过期/非群内仅私发管理员。
- 无论何种方式，管理员私聊通知必达（兜底语义）。

---

## 08-中间页管理台与 Web 打印

> **适用对象**：使用中间页（13011）扫码登录、打开管理台、使用 Web 打印的运维/用户。
> **前置条件**：浏览器可访问 `http://<服务器IP>:13011`（公网需穿透域名）。
> **操作步骤**：打开中间页 → 扫码登录主/副号 → 使用管理台 / Web 打印 / 副号退出。
> **验证方式**：二维码可扫、登录成功；管理台按角色代理到对应 NapCat WebUI；Web 打印任务状态流转正常。
> **常见坑**：frp 需 `type=tcp` 透传 13011（WS 全透传），HTTP 隧道不透传 WS 会导致白屏。

### 8.1 扫码登录与正在上岗

- 中间页支持扫码登录**主号**与**副号**：页面提供对应二维码，NapCat 扫码后自动登录并注入自动重登（injectAutoLogin，含 Credential 校验 + TTL）。
- 当前在岗框架在中间页显示「正在上岗」标签；非在岗框架显示备用状态。

### 8.2 打开管理台

- 中间页提供「打开管理台」入口：`/webui/` 按当前角色**动态代理**到对应 NapCat WebUI：
  - `SEA2_ACTIVE` → 主号原生 NapCat WebUI（6100）
  - `SEA1_ACTIVE` → 铁柱号 docker NapCat WebUI（6099）

### 8.3 Web 打印页（/webprint）

- 中间页提供 Web 打印入口：上传图片 / PDF，选择**份数、双面、纸张**后提交打印。
- 任务提交到 `sea2-print-server`（13012）队列，可**离线排队**（打印机离线时任务在 CUPS 队列等待，打印机恢复后自动打印）。

### 8.4 副号退出

- 副号退出接口：`/api/account/switch-backup`（中间页/管理端点），用于退出备用框架账号，避免与主号冲突互踢。

### 8.5 sea2-print-server 与队列机制

- **sea2-print-server**（13012）为独立常驻进程（`pm2` 托管，ecosystem：`/root/sea2/ecosystem.sea2-print-server.config.js`），处理 Web 打印任务。
- 队列状态机：`queued → printing → done / failed`；打印机离线时任务在 CUPS 排队，打印机恢复后自动继续打印。
- 任务 **TTL 24 小时**清理：超过 24h 未完成的任务自动清理，防止队列堆积。

---

## 09-容器管理（FastOSDocker）

> **适用对象**：需要远程管理容器/镜像、进入终端、登录 FastOSDocker 的运维人员。
> **前置条件**：上游容器管理服务可达（默认 `http://127.0.0.1:8081`），配置中心已填 `DOCKER_MGR_URL/USER/PASS`。
> **操作步骤**：控制台「容器管理」→ iframe 加载 `/docker-mgr/pc/` → 登录/管理容器/终端。
> **验证方式**：iframe 正常显示容器列表；终端 `/ws` 隧道可交互。
> **常见坑**：**FastOSDocker 登录必须 form 格式**（`username=root&password=root`），JSON 不行（R6 已修复）；frp 需 `type=tcp` 透传 13011（WS 全透传），否则中间页白屏。

### 9.1 路由与鉴权

容器管理经 `dockerMgrProxy` 反代：`/docker-mgr/*` 前缀剥离、根 `/ws` 终端隧道、根 `POST /login` 兜底。鉴权在 proxy 内完成（console token）。

```bash
# 健康检查（如果上游是默认 8081）
curl -s http://127.0.0.1:8081/health || echo "容器管理上游不可达"
```

---

## 10-配置中心

> **适用对象**：需要调整服务端运行参数的运维人员（端口、令牌、支付、集群阈值等）。
> **前置条件**：已登录控制台且为超管（ADMIN_TOKEN）。
> **操作步骤**：控制台「配置中心」→ 分组编辑 → 保存；带「需重启」的项保存后需重启服务。
> **验证方式**：保存后 `config.env` 原地改写（仅文件存在时改写，绝不整文件重建）；热更新项立即生效。
> **常见坑**：`ADMIN_TOKEN`/`MONITOR_TOKEN` 是敏感项，若 pm2 已注入 env 则优先级更高；`TOTP_SECRET` 已不再参与格式化门禁（仅兼容保留）。

### 10.1 常用配置键

| 配置键 | 说明 | 热更新 |
| --- | --- | --- |
| `PORT` | 监听端口（默认 3457） | 需重启 |
| `HOST` | 监听地址 | 需重启 |
| `DATA_DIR` | 数据目录 | 需重启 |
| `ADMIN_TOKEN` | 管理令牌（超管） | 需重启 |
| `MONITOR_TOKEN` | 商户/监控核验专用令牌 | 需重启 |
| `GRACE_DAYS` | 授权宽限期（天） | 需重启 |
| `TRIAL_MONTHS` | 新用户试用月数 | 即时 |
| `PLANS_JSON` | 套餐表 JSON | 需重启 |
| `FLEET_HB_INTERVAL` | 心跳间隔（秒） | 即时 |
| `FLEET_STALE_MINUTES` | 掉线阈值（分钟） | 即时 |
| `FLEET_CPU_WARN` / `FLEET_MEM_WARN` | CPU/内存告警阈值 | 即时 |
| `FORMAT_WHITELIST` | 格式化白名单机型前缀 | 即时 |
| `FORMAT_LEVELS` | 格式化三档参数 | 即时 |
| `HIGHRISK_ENABLED` | 高危专区总开关 | 即时 |
| `DOCKER_MGR_URL` / `DOCKER_MGR_USER` / `DOCKER_MGR_PASS` | 容器管理反代 | 即时 |

### 10.2 配置接口

```bash
# 读取全部配置（超管）
curl -s http://127.0.0.1:3457/api/admin/config -H 'x-admin-token: <ADMIN_TOKEN>'
# 写入配置
curl -s -X POST http://127.0.0.1:3457/api/admin/config \
  -H 'x-admin-token: <ADMIN_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"FLEET_HB_INTERVAL":"30"}'
```

---

## 11-高危操作与强门禁

> **适用对象**：执行格式化/恢复出厂/整盘擦除等高危操作的运维人员。
> **前置条件**：已登录控制台、权限 L2+、设备在白名单、高危总开关开启。
> **操作步骤**：「高危操作」专区 → 选设备 → 选档位（data/factory/disk）→ 输入确认词 → 等待倒计时 → 签发。
> **验证方式**：高危审计（kind=highrisk）出现记录；设备心跳 ack 后状态推进 done/failed。
> **常见坑**：门禁链 = 总开关→白名单→确认词→签发，**无 TOTP**；确认词来自 `FORMAT_LEVELS`（如 FORMAT-DATA）；测试 `applyLicense` 会污染生产，必须带真实机器码（MACHINE_MISMATCH 门禁）。

### 11.1 门禁三档

| 档位 | 说明 | 确认词示例 |
| --- | --- | --- |
| data | 数据分区格式化 | FORMAT-DATA |
| factory | 恢复出厂 | FORMAT-FACTORY |
| disk | 整盘擦除 | FORMAT-DISK |

### 11.2 高危接口

```bash
# 高危门禁状态
curl -s http://127.0.0.1:3457/api/admin/ops/highrisk/gate
# 高危记录列表
curl -s http://127.0.0.1:3457/api/admin/ops/highrisk/records
# 发起格式化（需 L2+ 且过门禁）
curl -s -X POST http://127.0.0.1:3457/api/admin/ops/highrisk/format \
  -H 'x-console-token: <token>' -H 'Content-Type: application/json' \
  -d '{"machineId":"<机器码>","level":"data","confirmWord":"FORMAT-DATA"}'
```

---

## 12-常见问题 FAQ

> **适用对象**：遇到常见故障的运维/实施人员。
> **前置条件**：先确认服务端与客户端版本均已部署最新修复。
> **操作步骤**：按下述条目对号入座；涉及重启的命令确认 pm2 进程名再执行。
> **验证方式**：按条目操作后观察对应现象消失；必要时查看审计与日志。
> **常见坑**：历史坑素材均来自真实生产故障，遇到同类问题优先参考本清单。

### Q：git 推送失败「Failed to connect to 127.0.0.1 port 7890」怎么办？

### A：~/.gitconfig 配置了失效代理。一键推送脚本已绕过（`git -c http.proxy=` 清空），但服务器手动 git 操作仍需清空代理再执行：

```bash
git -c http.proxy= -c https.proxy= ls-remote https://github.com/haihaigege184/sea2-client.git HEAD
```

### Q：高危操作还要求输入 TOTP 二次验证码吗？

### A：不再要求。TOTP 二次验证已移除（R5），高危门禁链 = 总开关 → 白名单 → 确认词 → 签发，无 TOTP 输入框。`TOTP_SECRET` 配置键仅兼容保留，不参与门禁。

### Q：中间页登录后一直要 token，NapCat 重启后不会自动重登？

### A：`injectAutoLogin` 已修复（Credential 校验 + TTL），NapCat 重启后会自动重登。若仍异常，检查中间页 `napcat-http.env` 的 `NAPCAT_HTTP_URL/TOKEN` 是否与 NapCat 实际 HTTP 服务一致。

### Q：集群页显示「试用中」，但客户已激活？

### A：client-code 存了过时错误码。更新 `/root/sea2/client-code` 与 store 绑定一致，LicenseGate 热重载会自愈；必要时在「授权管理」做绑定纠正。

### Q：设备已设白名单，仍提示「不在白名单内」？

### A：R4 已修复：档案 `whitelisted` + `formatWhitelist` 前缀双判定。请确认服务端已部署 R4 且设备档案 `whitelisted=true`，同时机器码前缀命中 `FORMAT_WHITELIST`。

### Q：FastOSDocker 登录失败「登陆信息不能为空」？

### A：登录必须用 form 格式（`username=root&password=root`），JSON 不行（R6 已修复）。检查配置中心 `DOCKER_MGR_USER/PASS`，并确认上游服务可达。

### Q：控制台新视图空白（如进程管理）？

### A：server.js 静态路由白名单需含新 `console.*.js`（`/console.*.js` 通配）。部署后若空白，检查浏览器 Network 面板对应 JS 是否 404。

### Q：sea2-bot 发码端口 13007 被占？

### A：EADDRINUSE 会自动升级到 13008，但全自动发码链会断。先排查占用：`netstat -tlnp | grep 13007`，确认无残留进程后再 `pm2 restart sea2-bot`。

### Q：pm2 startup 生成损坏的 systemd 单元？

### A：手动执行 `systemctl enable pm2-root.service` 替代自动生成；重启后 `pm2 resurrect` 验证进程恢复。

### Q：arm32 设备无法安装客户端？

### A：arm32 无官方 NapCat（仅 x86_64/arm64），且 arm32 原生模块编译需 10-20 分钟。请换 x86_64/arm64 设备或使用预编译包。

### Q：改了 plugins/*/index.js 不生效？

### A：Node require 缓存不清，必须 `pm2 restart sea2-bot`（或对应进程）后生效。

### Q：config.env 是非法 JSON（两个对象拼接）？

### A：已合并为合法单 JSON。后续改动 config.env 只做原地改写（文件存在时），绝不整文件重建，防止清空密钥。

### Q：测试 applyLicense 污染生产授权？

### A：门禁 MACHINE_MISMATCH 会拦截；测试必须带真实机器码，且建议在测试数据目录而非生产 DATA_DIR 执行。

### Q：中间页白屏？

### A：frp 需 `type=tcp` 透传 13011（WS 全透传），HTTP 隧道不透传 WS 导致白屏。检查穿透配置后重启 frp。

### Q：固定码二维码扫出来是内网 IP？

### A：二维码编码的是局域网 IP（`http://<lanIp>:13001/login`），勿用 .local 域名；公网设备请配置 EXTERNAL_URL 使用穿透域名。

### Q：QQ NT 真机发文件不可靠？

### A：CF_HDROP 剪贴板在 QQ NT 真机无效，以单测 + 部署验证为准，不要依赖真机发文件作为验收手段。

### Q：发「开通会员」只显示状态不弹菜单？

### A：R5 分流：已开通用户只显状态不弹菜单；会员/试用严格互斥（R6），已授权设备不发试用。

### Q：docker napcat 与原生 napcat 端口冲突互踢？

### A：docker napcat（3000/6099）与 sea2 原生 napcat 端口/账号冲突（QQ 号 __BACKUP_QQ__ 互踢）。同一设备只保留一种 NapCat。

### Q：LAN_BYPASS 内网免登录，公网访问也免登录？

### A：LAN_BYPASS 仅对内网来源免登录，公网需 token；穿透域名反代回源 127.0.0.1 会被误判内网，请用 EXTERNAL_URL 公网入口。

### Q：config.env 被清空导致服务起不来？

### A：config.env 只在文件存在时原地改写，绝不整文件重建（防清空密钥）。若已损坏，从备份恢复并 `pm2 restart sea1-activation`。

### Q：如何快速看服务端是否健康？

### A：`curl -s http://127.0.0.1:3457/health`；同时 `pm2 status` 确认 sea1-activation 状态 online。

### Q：如何快速看日志？

### A：`pm2 logs sea1-activation --lines 50`；客户端 `pm2 logs sea2-bot --lines 50`；容器 `pm2 logs sea2-napcat --lines 50`。

## 13-一键部署脚本使用说明（v2.1 交互式）

> 本节对应客户端 `scripts/boot-sea2.sh`（引导器）与 `scripts/install-sea2.sh`（主安装脚本）v2.1 能力：纯网络拉取 + 交互式 + 环境检测 + 依赖自动安装 + 多功能方案 + 智能推荐 + 扫码即用。完整版见 `sea2-client/docs/一键部署-使用说明.md`。

### 13.1 快速开始（两条核心命令）

```bash
# ① 交互式安装（零文件准备，推荐首次部署；支持 curl 或 wget）
curl -fsSL https://raw.githubusercontent.com/haihaigege184/sea2-client/main/scripts/boot-sea2.sh | bash
# gitee 镜像：GIT_MIRROR=gitee curl -fsSL <同上> | bash

# ② 非交互/参数驱动（自动化、CI、批量装机）
curl -fsSL <引导URL> | bash -s -- --non-interactive SEA2_PLAN=C SEA2_QR_WAIT=0
```

交互流程：欢迎页 → 环境检测报告（系统/架构/资源/网络/组件/已部署，彩色 ✅⚠️❌）→ 方案菜单（智能推荐高亮）→ 确认执行 → 依赖自动安装 → 部署 + 自检 → **扫码大字提示** → 开箱即用摘要。

### 13.2 部署方案（多功能 + 智能推荐）

| 方案 | 名称 | 适用 | 说明 |
|------|------|------|------|
| A | 完整客户端（推荐） | 全新机器 | node + linuxqq + NapCat + sea2 + pm2 四进程 + 中间页 |
| B | 仅中间页 | 补中间页 | 仅启动 sea2-qr（13011） |
| C | 升级/修复 | /root/sea2 已存在 | 补文件、重启 pm2、不重复安装 |
| D | 离线 | 内网隔离 | SEA2_LOCAL_PKG=<目录> 指定本地包（自动找 napcat.zip/linuxqq.deb） |

智能判断：检测到 /root/sea2 已存在 + pm2 进程在 → 推荐 C；全新机 → 推荐 A；13011 被占 → 提示检查。

### 13.3 关键参数

```bash
SEA2_PLAN=A|B|C|D        # 方案直选（不设则智能推荐）
SEA2_MASTER_KEY=<64hex>  # 部署密钥（交互 read -s 不回显 + 格式校验）
SEA2_SKIP_DEPLOY_FETCH=1 # 跳过穿透地址拉取（离线/内网直连）
SEA2_SERVER_ADDR=<地址>   # 预置服务端地址（设置后不覆盖不拉取）
SEA2_QR_WAIT=0           # 跳过二维码等待直接打印提示
SEA2_LOCAL_PKG=<目录>     # 离线本地包目录
--non-interactive / -y / SEA2_NON_INTERACTIVE=1  # 免交互（stdin 非终端自动启用）
DRY_RUN=1                # 演练模式（只打印不执行，部署前强烈建议跑一遍）
```

### 13.4 扫码即用

部署完成自动等待二维码（轮询 + 交互续等；SEA2_QR_WAIT=0 跳过）：手机 QQ 扫终端/中间页二维码直接登录；固定码地址 `http://<本机IP>:13011/s`；原生管理台 `http://<本机IP>:13011/webui/`（免 token 自动登录）。

### 13.5 脚本 FAQ

### Q：部署前如何先看会执行什么，避免误操作？

### A：`DRY_RUN=1 bash scripts/install-sea2.sh`——只打印步骤清单不执行（18 条 [DRY_RUN] 打印，零副作用）。部署前强烈建议演练一遍。

### Q：安装到一半断网/失败怎么办？

### A：直接重跑脚本（幂等：已装组件/已启动进程自动跳过，不重复下载安装）。

### Q：离线机器（无外网）怎么部署？

### A：方案 D：`SEA2_PLAN=D SEA2_LOCAL_PKG=/data/pkgs bash scripts/install-sea2.sh`（本地包目录含 napcat.zip/linuxqq.deb，脚本自动探测；同时 SEA2_SKIP_DEPLOY_FETCH=1 跳过穿透拉取）。

### Q：非交互模式下如何指定方案？

### A：`bash scripts/install-sea2.sh --non-interactive SEA2_PLAN=C`（或环境变量 SEA2_PLAN=C + stdin 非终端自动切非交互）。注意：管道喂 stdin（如 `echo C | bash ...`）会被视为非终端自动切非交互，选择将被忽略——必须用 SEA2_PLAN/环境变量驱动。

### Q：交互菜单怎么退出？

### A：方案菜单输入 `q` 干净退出（EXIT=0）；确认执行输入 `n` 取消。

### Q：固定二维码/固定码怎么用？

### A：部署完成后浏览器访问 `http://<本机IP>:13011` 打开中间页：扫页面二维码 或 点「固定码」输入 10 位固定码即可登录，无需手动输入账号密码。
