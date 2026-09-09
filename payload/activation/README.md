# sea2-server — sea2 商用客户端·服务端（激活服务 + 运维后台）

> 仓库根目录（独立 Git 私有仓，推送到 `haihaigege184`）。
> 服务端 = 激活码/license 签发核销 + 心跳校验 + 试用管理 + 运维后台（T01~T03）。

## 目录结构

```
sea2-server/
├── server.js                 # 服务端入口（激活/心跳/订单/试用/运维 API）
├── lib/                      # 核心逻辑（license/crypto/trial/orders/consoleApi/fleet/ops…）
│   ├── console/              # 运维后台 API（auth/devices/printers/audit/runtime…）
│   └── ops/                  # 运维引擎（crud/pm2/highrisk/binding/totp…）
├── public/                   # 运维后台前端（console.html/admin.html/config.html + JS/CSS）
│   └── qr/                   # 支付码静态资源
├── test/                     # 自动化测试（含 T01~T03 验收用例）
├── docs/                     # PRD / 系统设计 / 类图 / 时序图
├── monitor/                  # 支付宝账单监控（独立小工具）
├── tools/                    # 运维工具（fleet-simulator 等）
├── ecosystem.config.cjs      # pm2 配置（敏感项占位，真实值由环境注入）
├── package.json              # 依赖清单（npm install 后生成 node_modules）
├── package-lock.json
├── tunnel-wrapper.js / tunnel.sh   # 隧道辅助（可选）
├── PRD_activation_simplify.md
├── deploy.sh                 # 一键部署（备份→推送→重启→健康检查→回滚）
├── push_to_git.sh            # 推私有仓（force push 只留最新版）
└── .gitignore                # 敏感隔离清单（config.env/data/node_modules 等）
```

## 部署（生产）

```bash
# 前置：本机已配置 SSH 密钥可登录生产机（默认 root@10.0.0.11）
bash deploy.sh                    # 完整部署
bash deploy.sh --dry-run          # 演练
SSH_HOST=root@10.0.0.11 bash deploy.sh   # 指定主机
```

动作链：远端备份 → rsync 推送（**排除 config.env/data/node_modules/.git**）→
pm2 restart sea1-activation → 健康检查（curl :3457/api/shop/info）→ 异常自动回滚。

> 注：服务端没有 `/api/status` 路由（那是中间页的）；服务端公开 200 端点为 `/api/shop/info`。

## 推送私有仓

```bash
# 实际推哪个仓由主理人/用户最后确定（需 GitHub 凭据）
REMOTE_URL=git@github.com:haihaigege184/sea2-server.git bash push_to_git.sh
```

force push 只留最新版，删除旧历史。

## ⚠️ 敏感注意（绝不上传）

| 路径 | 原因 |
| --- | --- |
| `config.env` | 含 ADMIN_TOKEN / 支付宝私钥等真实密钥 |
| `data/` | 签名私钥 keys.json + 订单/用户/试用业务数据 |
| `node_modules/` | 体积大、可重建 |
| `*.pem / *.key / server_keys.json / test_license.json` | 密钥/凭据 |
| `*.log / *.bak*` | 日志轨迹 / 历史垃圾 |

真实密钥只在部署机本机，由 `.gitignore` 硬性排除；入库仅允许 `.example` 模板。

## T1 修复部署说明（bot 回调端口 / 激活成功群通知）

> 代码改动已并入本仓库（T1）；以下 2 项涉及**生产敏感文件**，由主理人部署时执行，
> 本仓库仅标注说明，不存放真实 config.env 内容。

1. **P0-1 端口冲突**：sea2-bot 自动发码端点默认端口已由 13007 改为 **13008**
   （13007 被 sea1-bot 占用，详见 `patches/sea2-bot/botNotifyServer.js` 与
   `patches/sea2-bot/README-T1-bot-patch.md`）。部署时需同步把生产
   `config.env` 的 `BOT_NOTIFY_URL` 改为：
   ```
   BOT_NOTIFY_URL="http://127.0.0.1:13008/vip/notify-paid"
   ```
   （若 sea2-bot 用 `BOT_NOTIFY_PORT` 环境变量启动，二者等价，取其一即可。）
2. **P1-7 激活成功群通知**：服务端 `/api/order/issue` 签发成功后会向 `BOT_NOTIFY_URL`
   投递 `{order_id, event:'activated', qq, plan}`；bot 端需按
   `patches/sea2-bot/README-T1-bot-patch.md` 第 2 节在 `vip/index.js` 追加
   `onActivated` 回调，向 `config.notify_groups` 推送「开通成功」群消息。

## 本地 git 身份

脚本已用 local 占位身份提交；如需真实身份（可选）：
```bash
git config --global user.name '你的名字'
git config --global user.email '你的邮箱'
```
