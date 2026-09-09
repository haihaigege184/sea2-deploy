# sea2-deploy —— SEA2 双系统一键部署仓库

在全新的 **arm64（aarch64）/ x86_64 Linux**（Debian/Ubuntu/armbian）服务器上，一条命令完成 SEA2 双系统（主系统 sea2-bot + 原生 NapCat、副系统 sea1-bot + docker NapCat、激活授权服务）的**智能交互式部署**；已安装的设备再次执行自动进入**检查/维护**模式。

## 快速开始（目标机执行）

```bash
git clone <本仓库> sea2-deploy
cd sea2-deploy
sudo bash install.sh
```

- 未安装 → 交互向导（6 个问题：主号/副号/管理员/通知群/打印机/是否部署激活服务），密钥全部自动随机生成
- 已安装 → 维护菜单（状态 / 重启 / 日志 / 健康检查 / 更新代码 / 配置说明）
- 演练：`sudo bash install.sh --dry-run`；全自动：`--yes`

## 部署结果（与生产 10.0.0.11 双系统同构）

| 组件 | 路径/端口 | 说明 |
|---|---|---|
| sea2-bot 主系统 | /root/sea2 · HTTP :13001 · WS :9093 | pm2，角色 SEA2_ACTIVE |
| 原生 NapCat（主号） | /root/sea2/napcat/QQ + /app/napcat · OneBot :4000 · WebUI :6100 | QQ NT + Shell 注入（amd64/arm64 自动选包） |
| sea1-bot 副系统 | /root/sea1 · HTTP :13000 · WS :9092 | pm2，注册待命（角色互斥由 watchdog 仲裁） |
| docker NapCat（副号） | 容器 napcat · OneBot :3000/:3001 · WebUI :6099 | mlikiowa/napcat-docker 多架构 |
| sea2-watchdog | /root/sea2/sea2-watchdog | 双向仲裁（get_status.online 为准，切换冷却 10min） |
| sea2-print-server | :13012 | 独立本地打印（CUPS） |
| sea2-qr 扫码中间页 | :13011 | 主/副号扫码与切换入口 |
| sea1-activation | /root/sea1-activation-server · :3457 | 激活授权服务 |

## 个人数据红线（payload 保证干净）

仓库内 `payload/` 由 `scripts/pack-from-prod.sh` 从生产打包，**强制剥离**：node_modules、QQ 二进制与登录会话、config.json/license.json/machine-id/client-code、data/database/logs/backups/run/webprint、config.env（支付密钥）、各 ecosystem 真实 token、测试脚本（含口令）、`*.bak*`；并对功能性硬编码（QQ 号/token）做 **`__占位符__` 脱敏**，部署时由向导采集的新值渲染注入。泄漏扫描发现问题即失败退出，绝不入库。

## NapCat 登录提示

- 部署完成后打开 WebUI 扫码：主号 `:6100`、副号 `:6099`（网络配置已预置，扫码登录即绑定 OneBot 端口，无需重启）
- ⚠ 同一 QQ 号与其他设备在线会互踢；先下线旧设备再扫码
- NapCat 网络配置（onebot11_<uin>.json）已按生产模板预置，避免"空壳配置"问题

## 重新打包 payload（构建机）

```bash
ssh-copy-id root@10.0.0.11     # 首次配置免密
bash scripts/pack-from-prod.sh
```

## 目录结构

```
sea2-deploy/
├── install.sh          # 一键入口（新装向导 / 维护菜单 / --dry-run / --yes）
├── lib/                # common platform deps render napcat services verify maintain
├── templates/          # 全部配置模板（__占位符__ 由 install.sh 渲染）
├── payload/            # 生产同构干净代码（sea2 / sea1 / activation）
└── scripts/pack-from-prod.sh   # 从生产重新打包 payload
```
