# 说明书：sea1 新手运维指南

> [!DANGER] 生产禁改：sea1 为生产激活/授权体系，任何对 sea1 代码、license、激活码、配置文件的改动必须走审批与测试，严禁直接在生产环境裸改。
> 本说明书面向 sea1 商业化激活体系（激活服务器 sea1-activation + 客户端授权 licensing + 机器人登录网关）。

---

## 01-项目概览与架构

> **适用对象**：首次接手 sea1 激活/授权体系的运维、部署、故障响应人员。
> **前置条件**：具备 sea1 部署机（生产 10.0.0.11）root 权限；熟悉 pm2 基本命令。
> **操作步骤**：对照「ecosystem.config.cjs」确认四类进程（sea1-bot / ncqq / sea1-activation / sea1-login-gateway）的角色与端口。
> **验证方式**：`pm2 status` 四进程全部 online；`curl -s http://127.0.0.1:3457/health` 返回 ok。
> **常见坑**：sea1 激活服务端口为 3457（老 3456 是历史端口）；sea1-login-gateway 端口 13001 与 bot 端口 13000 物理隔离。

### 1.1 进程清单

| 进程 | 角色 | 端口 |
| --- | --- | --- |
| sea1-bot | 机器人主体（sea.js） | 13000 |
| ncqq | 纯 JS 无头 QQ（icqq + 反向 WS） | WS 9092 |
| sea1-activation | 商业化激活服务器（server.js） | 3457 |
| sea1-login-gateway | 登录网关（login-gateway/server.js） | 13001 |

```bash
pm2 status
pm2 describe sea1-activation | grep -E "status|script|restarts"
```

---

## 02-快速部署与安装

> **适用对象**：需要新部署一台 sea1 服务器/客户机的运维人员。
> **前置条件**：目标机已装 Node.js、pm2；服务器角色需 git 与 ssh 密钥；客户机角色用 install.sh 阶段部署。
> **操作步骤**：服务器角色用 `ecosystem.config.cjs` 启动四进程；客户机角色用 `ecosystem.client.config.cjs`（纯客户端 3 进程，不含激活服务）。
> **验证方式**：`pm2 status` 各进程 online；`curl -s http://127.0.0.1:3457/api/shop/info` 返回套餐与公钥。
> **常见坑**：客户机激活地址通过 `SEA1_ACTIVATION_URL` 指向主服务器，勿在本机部署激活服务；阶段部署按进程各自 pm2 托管。

### 2.1 服务器角色部署

```bash
cd /opt/sea1/sea1
pm2 start ecosystem.config.cjs            # 规范模板：sea1-bot / ncqq / sea1-activation / sea1-login-gateway
pm2 start ecosystem.config.cjs --only sea1-login-gateway   # 只启动登录网关
pm2 save
pm2 startup
```

### 2.2 客户机角色部署

```bash
cd /opt/sea1/sea1
pm2 start ecosystem.client.config.cjs     # 纯客户端 3 进程（sea1-bot / ncqq / sea1-login-gateway）
# 激活地址指向主服务器：
# config.json.license.activationServer 或运行时 env SEA1_ACTIVATION_URL
```

---

## 03-激活与授权机制

> **适用对象**：需要理解激活码/授权/换绑机制的运维与客服人员。
> **前置条件**：熟悉激活码格式（SEA2-XXXX 或 SEA1-XXXX）、license 签发流程。
> **操作步骤**：通过控制台「授权管理」新增激活码 → 客户端激活绑定 → 心跳校验。
> **验证方式**：激活成功返回 license（含 machine_id/customer/expires_at/max_groups）；二次激活不同机器返回 409。
> **常见坑**：激活码过期/吊销 → 403；已绑定其他设备 → 409；试用与会员严格互斥（R6）。

### 3.1 激活流程

```bash
# 公开激活接口
curl -s -X POST http://127.0.0.1:3457/api/activate \
  -H 'Content-Type: application/json' \
  -d '{"machine_id":"<机器码>","code":"<激活码>"}'
# 心跳
curl -s -X POST http://127.0.0.1:3457/api/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"machine_id":"<机器码>","code":"<激活码>","nonce":"<随机串>"}'
```

### 3.2 授权七态

| reason | 含义 |
| --- | --- |
| ok | 有效授权 |
| expired | 授权过期（宽限期内仍可用） |
| revoked | 已吊销 |
| machine-mismatch | 机器码不符 |
| code-not-found | 授权码不存在（多为连错服务器） |
| license-not-issued | 授权码在但 license 缺失 |
| blacklisted | 已拉黑 |

---

## 04-登录网关与机器人

> **适用对象**：负责 QQ 机器人登录、二维码、中间页的运维人员。
> **前置条件**：已部署 ncqq 与 sea1-login-gateway；NapCat 或 icqq 可用。
> **操作步骤**：启动 sea1-login-gateway → 访问 `http://<主机IP>:13001/login` → 扫码/固定码登录 → 验证机器人收消息。
> **验证方式**：登录页显示 QQ 状态；`pm2 logs ncqq` 无登录错误；群内消息可达 bot。
> **常见坑**：二维码编码局域网 IP（`http://<lanIp>:13001/login`）勿用 .local；登录网关与 bot 端口物理隔离；中间页登录要 token 时检查 injectAutoLogin 与 TTL。

### 4.1 登录网关端口

```bash
LOGIN_GATEWAY_PORT=13001
LOGIN_GATEWAY_HOST=0.0.0.0
NCQQ_DATA_DIR=/opt/sea1/ncqq/data
# LAN 内不校验；如需防护设 RESET_TOKEN
RESET_TOKEN=
```

---

## 05-许可证与心跳

> **适用对象**：处理许可证过期、心跳异常、宽限期的运维人员。
> **前置条件**：能访问激活服务端日志与数据目录。
> **操作步骤**：观察心跳接口返回 reason → 对照授权七态 → 修正（续期/换绑/补 license）。
> **验证方式**：心跳 `valid:true` 且 `reason:ok`；宽限期内 expired 仍 valid。
> **常见坑**：GRACE_DAYS 宽限期默认 7 天；heartbeat 接口 `code` 为空时必须是 trial:true，否则 400 trial-required（fail-closed）。

### 5.1 宽限期

`GRACE_DAYS` 控制 license 到期后仍可正常使用的天数（默认 7）。过期但未超宽限 → reason=expired 且 valid=true；超宽限 → reason=expired 且 valid=false。

```bash
GRACE_DAYS=7
```

---

## 06-订单与支付

> **适用对象**：处理订单创建、支付确认、发码的运营/客服人员。
> **前置条件**：已配置支付模式（manual 个人码 或 webhook 支付宝当面付）。
> **操作步骤**：用户发「开通会员」→ bot 建单 → 用户支付 → 确认到账 → 签发 license。
> **验证方式**：订单状态流转 pending → await_verify → paid → issued；签发后客户端可用。
> **常见坑**：`/api/order/confirm` 只推进到 await_verify（绝不返回 paid）；admin 核验接口需要 MONITOR_TOKEN（未配置则停用）。

### 6.1 建单与支付接口

```bash
# 建单（机器人指令触发）
curl -s -X POST http://127.0.0.1:3457/api/order/create \
  -H 'Content-Type: application/json' \
  -d '{"qq":"<QQ>","machine_id":"<机器码>","plan":"month","channel":"alipay"}'
# 人工申报支付（仅下单者本人）
curl -s -X POST http://127.0.0.1:3457/api/order/confirm \
  -H 'Content-Type: application/json' \
  -d '{"order_id":"<订单号>","qq":"<QQ>"}'
# 商户/监控核验（需 MONITOR_TOKEN）
curl -s -X POST http://127.0.0.1:3457/api/admin/order/confirm \
  -H 'x-monitor-token: <MONITOR_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"order_id":"<订单号>","trade_no":"<流水号>"}'
# 支付后发码（status 必须 paid）
curl -s -X POST http://127.0.0.1:3457/api/order/issue \
  -H 'Content-Type: application/json' \
  -d '{"order_id":"<订单号>"}'
```

### 6.2 套餐表

| plan | 名称 | 价格 | 时长 |
| --- | --- | --- | --- |
| month | 月度会员 | 5 | 30 天 |
| quarter | 季度会员 | 12 | 90 天 |
| year | 年度会员 | 48 | 365 天 |
| lifetime | 永久授权 | 128 | 永久 |

---

## 07-试用体系

> **适用对象**：管理新用户试用、临期提醒的运营人员。
> **前置条件**：已配置 TRIAL_MONTHS/TRIAL_NEAR_DAYS/TRIAL_MAX_REMINDERS。
> **操作步骤**：控制台「订单·会员」→ 开通会员/查看试用；或调用 trial 接口授予/查询。
> **验证方式**：`/api/trial/user/status?uin=<QQ>` 返回试用状态；临期提醒队列有条目。
> **常见坑**：试用按 uin/QQ 维度（TRIAL_MONTHS 月），机器维度 TRIAL_DAYS 独立；激活成功会自动清除试用记录（双维度幂等）。

### 7.1 试用接口

```bash
# 授予试用（特权，需 MONITOR_TOKEN）
curl -s -X POST http://127.0.0.1:3457/api/trial/grant \
  -H 'x-monitor-token: <MONITOR_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"uin":"<QQ>","months":3}'
# 单用户试用状态
curl -s "http://127.0.0.1:3457/api/trial/user/status?uin=<QQ>"
# 待发提醒队列（特权）
curl -s http://127.0.0.1:3457/api/trial/pending-reminders -H 'x-monitor-token: <MONITOR_TOKEN>'
```

---

## 08-权限与安全

> **适用对象**：管理后台账号权限、白名单、高风险的运维人员。
> **前置条件**：理解 L0-L3 权限等级与 QQ 会话授权。
> **操作步骤**：控制台登录（ADMIN_TOKEN 或 QQ）→ 查看角色/等级 → 按需授权。
> **验证方式**：L2+ 可写（下发指令/处置异常），L0/L1 只读；高危操作走门禁链。
> **常见坑**：ADMIN_TOKEN 弱口令会触发启动安全告警，生产必须强口令；MONITOR_TOKEN 未配置时商户核验接口停用（fail-closed）。

### 8.1 令牌

| 令牌 | 用途 |
| --- | --- |
| ADMIN_TOKEN | 控制台超管 + 管理接口 |
| MONITOR_TOKEN | 商户/监控核验 + 试用授予特权接口 |
| WEBHOOK_SECRET | 微信收款 webhook 验签 |
| BOT_NOTIFY_TOKEN | bot 回调令牌 |

---

## 09-运维与排障命令

> **适用对象**：日常巡检、排障、升级 sea1 的运维人员。
> **前置条件**：root 权限 + pm2 可用。
> **操作步骤**：按下述命令巡检进程/端口/数据；升级走 deploy 流程（备份→推送→重启→回滚）。
> **验证方式**：命令输出与预期一致；升级后健康检查通过。
> **常见坑**：修改 plugins/*/index.js 必须 `pm2 restart sea1-bot`（require 缓存不清）；config.env 只在文件存在时原地改写，绝不整文件重建。

### 9.1 常用巡检命令

```bash
pm2 status
pm2 logs sea1-activation --lines 50
pm2 logs sea1-bot --lines 50
pm2 logs sea1-login-gateway --lines 50
pm2 restart sea1-activation
pm2 restart sea1-bot
# 健康检查
curl -s http://127.0.0.1:3457/health
# 商城信息（公开）
curl -s http://127.0.0.1:3457/api/shop/info
```

### 9.2 测试

```bash
node --test "test/**/*.test.js"   # 开发机全量回归（Windows 目录形式有 bug，用引号）
```

---

## 10-常见问题 FAQ

> **适用对象**：遇到常见 sea1 故障的运维/客服人员。
> **前置条件**：先确认服务端与客户端版本已更新。
> **操作步骤**：对号入座逐条排查；涉及重启的命令确认进程名。
> **验证方式**：现象消失即修复；必要时查审计日志。
> **常见坑**：历史坑素材均来自真实生产故障，同类问题优先参考。

### Q：git 推送失败「Failed to connect to 127.0.0.1 port 7890」？

### A：~/.gitconfig 配了失效代理。一键推送已绕过（git -c http.proxy= 清空），手动 git 操作需清空代理：

```bash
git -c http.proxy= -c https.proxy= ls-remote https://github.com/haihaigege184/sea2-client.git HEAD
```

### Q：激活码显示已绑定其他设备？

### A：激活码首次绑定后 machine_id 锁定；换设备需走「授权管理」绑定纠正（R4 支持），不能直接换机器激活。

### Q：客户端心跳 valid:false 且 reason=code-not-found？

### A：多为客户端连错服务器（激活地址指向了别的实例）。检查 config.json.license.activationServer 或 SEA1_ACTIVATION_URL。

### Q：reason=license-not-issued 怎么处理？

### A：授权码在但 license 记录缺失。重新签发：控制台「授权管理」→ 找到该码 → 重新签发 license（或触发 issue 流程）。

### Q：订单一直停在 await_verify 不自动 paid？

### A：manual 模式需要人工核验：用 MONITOR_TOKEN 调 `/api/admin/order/confirm` 推进 paid；确认 MONITOR_TOKEN 已配置（否则接口停用）。

### Q：支付宝全自动模式没自动发码？

### A：检查 ALIPAY_APP_ID/ALIPAY_PRIVATE_KEY/ALIPAY_PUBLIC_KEY 是否齐备（缺一即降级 manual）；PUBLIC_BASE_URL 用于拼接 notify_url。

### Q：webhook 微信收款没反应？

### A：检查 WEBHOOK_SECRET 与 SmsForwarder 配置一致；带 X-Signature 头时强制 HMAC 校验；日志看 `/api/admin/webhook-logs`。

### Q：试用到期后还能继续用吗？

### A：试用到期 reason=trial-expired，客户端降级；激活成功后自动清除该机器/客户的试用记录（双维度幂等）。

### Q：发「开通会员」只显状态不弹菜单？

### A：R5 分流：已开通用户只显状态不弹菜单；会员/试用严格互斥（R6），已授权设备不发试用。

### Q：管理员 L0/L1 不能下发指令？

### A：L2+ 才可写（下发远程指令/处置异常）；L0/L1 仅只读概览与订单。需要提升权限请联系超管。

### Q：控制台新视图空白？

### A：server.js 静态路由白名单需含新 console.*.js（/console.*.js 通配）。部署后检查 Network 面板 JS 是否 404。

### Q：重启后 pm2 进程没恢复？

### A：pm2 startup 生成损坏 systemd 单元时手动 `systemctl enable pm2-root.service`；重启后 `pm2 resurrect`。

### Q：改了 plugins 不生效？

### A：Node require 缓存不清，必须 `pm2 restart sea1-bot`（或对应进程）。

### Q：config.env 变成非法 JSON？

### A：历史故障已合并为合法单 JSON；后续只原地改写（文件存在时），绝不整文件重建防清空密钥。

### Q：中间页白屏？

### A：frp 需 type=tcp 透传 13011（WS 全透传），HTTP 隧道不透传 WS 导致白屏。检查穿透配置。

### Q：固定码二维码扫出内网 IP？

### A：二维码编码局域网 IP（http://<lanIp>:13001/login），勿用 .local；公网设备配置 EXTERNAL_URL。

### Q：QQ NT 真机发文件不可靠？

### A：CF_HDROP 剪贴板在 QQ NT 真机无效，以单测 + 部署验证为准，不依赖真机发文件验收。

### Q：docker napcat 与原生 napcat 冲突互踢？

### A：docker napcat（3000/6099）与 sea2 原生 napcat 端口/账号冲突（QQ 号 __BACKUP_QQ__ 互踢），同一设备只保留一种。

### Q：LAN_BYPASS 公网也免登录？

### A：LAN_BYPASS 仅内网来源免登录，公网需 token；穿透域名反代回源 127.0.0.1 会被误判内网，用 EXTERNAL_URL 公网入口。

### Q：如何快速看服务端健康？

### A：`curl -s http://127.0.0.1:3457/health`；同时 `pm2 status` 确认 sea1-activation online。

### Q：如何快速看授权/订单数据？

### A：`curl -s http://127.0.0.1:3457/api/admin/orders -H 'x-admin-token: <ADMIN_TOKEN>'`；激活码列表 `/api/admin/codes`。
