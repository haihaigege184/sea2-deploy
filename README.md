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

## 远程一键部署（全新机器，推荐）

```bash
# root 直连（环境变量必须写在管道右侧的 bash 上，否则只作用于 curl）
curl -fsSL http://10.0.0.11:3457/downloads/bootstrap.sh \
  | SEA2_TARBALL_URL=http://10.0.0.11:3457/downloads/sea2-deploy.tar.gz \
    SEA1_ADMIN_TOKEN=<运维中心 ADMIN_TOKEN> \
    bash

# 非 root
export SEA2_TARBALL_URL=http://10.0.0.11:3457/downloads/sea2-deploy.tar.gz
export SEA1_ADMIN_TOKEN=<运维中心 ADMIN_TOKEN>
curl -fsSL http://10.0.0.11:3457/downloads/bootstrap.sh | sudo -E bash
```

仓库包与大文件（linuxqq deb / NapCat.Shell.zip）统一走**服务端分发**：内网直连 `10.0.0.11:3457/downloads/*`，
内网不可达时自动测速选隧道，隧道全挂才回退腾讯 CDN —— 不再依赖 GitHub（龟速）。

### 环境变量（免交互）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SEA2_TARBALL_URL` | 空 | 仓库包地址；建议指向中央服务端 `/downloads/sea2-deploy.tar.gz`（内网秒下）。留空走 GitHub |
| `DEPLOY_MODE` | `2`（客户端） | `1` = 服务端全套（含本机激活服务 :3457），`2` = 客户端接入中央 |
| `CENTRAL_SERVER` | `http://10.0.0.11:3457` | 中央地址；置空则自动从隧道池测速选最快 |
| `SEA1_ADMIN_TOKEN` | 空 | 运维中心令牌。**留空也能装完**：设备以「设备维度试用（14 天）」身份出现在集群页，后续在控制台签发授权码写入 `/etc/sea1-x86/client-code` 并 `pm2 restart sea1-client` 即可转正（client-agent 每 30 分钟也会自动重试领码） |
| `SEA2_RESET_MACHINE_ID` | `0` | `1` = 强制清除 `/etc/sea1-x86/{machine-id,client-code}`，按**全新设备**重新注册。默认保留（重装不换身份，避免授权漂移），只有要模拟真·全新环境时才置 1 |
| `MAIN_QQ` / `BACKUP_QQ` / `ADMIN_QQ` / `NOTIFY_GROUPS` | — | 向导其余项，预设即跳过提问 |
| `SEA2_FLEET_CUSTOMER` | 空 | 客户端模式自动领码所用的**客户号**。默认按机器唯一（`x86-<machine_id 前16位>`）。**不要多台机器设成同一个值**（见下） |

### 领码客户号：为什么必须每机唯一

中央 `orders.js:157 _resolveMachineId(qq)` 在签发时会按客户号反查历史机器，把**新码直接预绑到那台机器**。
若多台机器共用一个客户号（旧实现硬编码 `1000000001`），第二台起拿到的码 `bound_machine_id` 指向别人，
`/api/activate` 必返回 **409「激活码已绑定其他设备」**，此后心跳长期 `machine-mismatch`，设备卡在"未授权"。

- 默认行为已按机器唯一，无需干预；控制台"客户"列显示 `x86-xxxxxxxxxxxxxxxx`（这是机器授权码，不是用户会员）。
- 确需把机器挂到真实客户名下：`SEA2_FLEET_CUSTOMER=<客户QQ>`，但**同一客户号同时只能有一台机器**。
- 已经撞车的机器：`client-agent` 会自动调 `/api/admin/ops/binding` 换绑重试一次；换绑也失败则清除该码、
  回落设备维度试用（不会静默卡死）。排障看 `pm2 logs sea1-client`。

### 全新环境判据（部署前自检）

```bash
ls /etc/sea1-x86 /etc/sea1 /root/sea2 /root/sea1 /root/sea1-activation-server 2>&1 | grep -c 'No such file'   # 期望 5
which node npm pm2 docker                                                                                        # 期望全空
ss -lntp | grep -E ':(3457|4000|3000|6100|6099)'                                                                 # 期望空
```

> 注：旧版 `init_runtime_dirs` 无条件保留 `/etc/sea1-x86/machine-id`，重装后沿用旧指纹。
> 要在"已装过"的机器上复现真·全新环境，请 `rm -rf /etc/sea1-x86` 或部署时带 `SEA2_RESET_MACHINE_ID=1`。

### fleet 心跳状态速查

```bash
pm2 logs sea1-client --lines 20 --nostream
# 全新/无令牌： 首次心跳 status=200 valid=false reason=trial-active   ← 正常（试用中）
# 已授权：     首次心跳 status=200 valid=true  reason=ok              ← 正常（正式）
# reason=machine-mismatch → 机器指纹漂移，核对 /etc/sea1-x86/machine-id 与控制台绑定
# 400 trial-required      → 旧 bug（无 code 却不带 trial:true），升级到本提交后消失
```
