# sea2-deploy —— SEA2 双系统一键部署仓库

在全新的 **arm64（aarch64）/ x86_64 Linux**（Debian/Ubuntu/armbian）服务器上，一条命令完成 SEA2 双系统（主系统 sea2-bot + 原生 NapCat、副系统 sea1-bot + docker NapCat、激活授权服务）的**智能交互式部署**；已安装的设备再次执行自动进入**检查/维护**模式。

## 快速开始（目标机执行）

```bash
git clone <本仓库> sea2-deploy
cd sea2-deploy
sudo bash install.sh
```

- 未安装 → 交互向导（主号 / 副号 / 管理员 / 通知群 / 打印机 / 中间页对外地址 / 接入线路，账号全部可留空），密钥全部自动随机生成
- 已安装 → 维护菜单（状态 / 重启 / 日志 / 健康检查 / 更新代码 / 配置说明）
- 演练：`sudo bash install.sh --dry-run`；全自动：`--yes`
- 全程**分步计时**：每个阶段结束打印 `⏱ 阶段名 用时 12.3s`，收尾打印总耗时 —— 长时间无输出时可据此判断是"在跑"还是"卡住"

## 部署日志脱敏（不暴露中央接口）

部署/引导过程中**不会打印任何中央服务端接口地址**，一律显示为 `线路1`、`线路2`……（编号与
`lib/central.sh` 的 `SEA2_SEED_SERVERS` 顺序一一对应，引导阶段与部署阶段同一地址编号一致）：

```
[bootstrap] 测速 线路1 → 5ms
[ok] 最快分发线路: 线路1（5ms）
[ok] 选定接入线路: 线路3（延迟 173ms）
```

- 真实地址仍用于内部通信，只在**输出层**替换，不影响任何请求
- 自己排查问题时需要看真址：`SEA2_SHOW_ENDPOINTS=1 bash install.sh`
- 日志会被截图/贴群，因此 `bootstrap.sh` / `install.sh` / `lib/*.sh` 全链路统一脱敏

## 部署完成后的扫码引导（中间页）

部署收尾会直接给出**中间页入口 + 终端二维码**，手机扫一下即可登录机器人账号：

```
   ▶ 第 1 步（必须）：手机扫码登录机器人账号
 ▄▄▄▄▄▄▄ ▄▄ ▄▄▄▄▄▄ ▄▄▄▄▄▄▄      ← 终端二维码（ANSI 半角块），可用手机直接扫
 █ ▄▄▄ █ ▄ ▄  ▄ ▄▄ █ ▄▄▄ █
 ...
   http://<本机IP>:13011/
     中间页固定二维码（可随时重扫 / 转发他人）: http://<本机IP>:13011/fixed.png
     中间页入口（本机浏览器亦可打开）        : http://<本机IP>:13011/
```

- 中间页 = 扫码中间页（`:13011`），可选择「主号 / 副号」并扫描 QQ 登录二维码
- **云服务器**上本机内网 IP 手机扫不到：向导里的「中间页对外地址」填公网域名/端口映射地址即可
  （如 `https://qr.example.com`），留空则回退本机内网 IP
- 终端二维码渲染失败会自动降级为纯链接，**绝不阻塞部署**（部署此时其实已经完成）

## 集群统一管理（运维中心）

运维中心 `/console` 的集群页新增 **「统一管理」** 按钮：勾选若干设备后，可在一个面板里对这批设备
**集中下发**原本分散在「进程管理 / 打印与 CUPS / 设备管理」三处的操作，免去多视图来回跳转：

| 分区 | 能力 |
|---|---|
| ① 进程 | 进程列表 / 重启 / 停止 / 启动 / 最近 100 行日志（按 `sea2-*`、`sea1-*` 白名单校验） |
| ② 打印 | 启用 / 停用 / 设为默认（下发 `printer.default`）/ 清空队列 / CUPS 状态 |
| ③ 服务与下发 | 推送通知 / 健康检查 / 启用客户端 |

所有动作仍走同一契约通道 `POST /api/admin/fleet/clients/:mid/command`（危险项复用强确认），
客户端执行后经 `ack_results` 回执，**不新增任何绕过服务端门禁的路径**。

## 设备版本自动识别

设备在集群页显示的「系统版本」由安装包内 `payload/sea2/VERSION`（当前 `2.0.0`）驱动，
自动上报为 **`sea2-dual-2.0.0`**（平台标识 `sea2-dual`），不再显示旧的 `sea1`：

- 心跳 v2 额外上报：`pm2_processes`、`cups`、`login_info`、`platform`、`arch`、`hostname`、`heartbeat_proto:2`
- 客户端同时实现完整指令通道（`ack_results` 回执），可在运维中心直接下发 19 类运维指令

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

- **推荐**：部署完成后按收尾提示扫「中间页」二维码（`:13011`），在页面里选主号/副号扫码登录
- 也可直接打开 WebUI 扫码：主号 `:6100`、副号 `:6099`（网络配置已预置，扫码登录即绑定 OneBot 端口，无需重启）
- ⚠ 同一 QQ 号与其他设备在线会互踢；先下线旧设备再扫码
- ⚠ **严禁反复重启 NapCat 容器**：每次启动都是一次登录尝试，连续多次会触发 QQ 风控
  （`ErrType:1 ErrCode:3`）。被风控后须 `docker stop` 静默冷却（可能 12~24h），期间别扫也别重启
- NapCat 网络配置（onebot11_<uin>.json）已按生产模板预置，避免"空壳配置"问题

## 重新打包 payload（构建机）

```bash
ssh-copy-id root@10.0.0.11     # 首次配置免密
bash scripts/pack-from-prod.sh
```

## 目录结构

```
sea2-deploy/
├── bootstrap.sh        # 网络拉取引导器（多源测速选路 + 输出脱敏）
├── install.sh          # 一键入口（新装向导 / 维护菜单 / --dry-run / --yes）
├── lib/                # common platform deps render napcat services verify maintain qrterm central
├── templates/          # 全部配置模板（__占位符__ 由 install.sh 渲染）
├── payload/            # 生产同构干净代码（sea2 / sea1 / activation）
└── scripts/pack-from-prod.sh   # 从生产重新打包 payload
```

## 远程一键部署（全新机器，推荐）

公开分发、全国可用（**推荐先落盘再执行**：向导能正常交互，也可重复运行/加参数）：

```bash
curl -fsSL http://sea1.xsian.top/downloads/bootstrap.sh -o /tmp/sea2.sh \
  || curl -fsSL https://raw.githubusercontent.com/haihaigege184/sea2-deploy/main/bootstrap.sh -o /tmp/sea2.sh
bash /tmp/sea2.sh
```

也可以管道执行（向导会从 `/dev/tty` 读输入，不会去读管道）：

```bash
curl -fsSL http://sea1.xsian.top/downloads/bootstrap.sh | bash
```

**地址自动选路，无需人工区分内网/公网**：脚本内置全部隧道域名 + 内网地址，逐个测速取最快者——
内网机器自然命中 `10.0.0.11:3457`（延迟最低），公网机器命中隧道，全挂才回退 GitHub。
中央服务端地址同样自动测速：先探测任一可达节点拉取 `/api/deploy/tunnels` 完整隧道池，再全池测速。

仓库包与大文件（linuxqq deb / NapCat.Shell.zip）走**服务端分发**（`/downloads/*`），腾讯 CDN 兜底。

> **命令里不要带令牌。** `SEA1_ADMIN_TOKEN` 是运维中心超管令牌，明文写进命令行会留在
> `~/.bash_history`、`ps` 输出和部署日志里，且任何拿到它的人都能签发/换绑授权码。
> 不带也能装完（设备以"试用 14 天"入集群），需要正式授权时用下面任一种方式：
>
> ```bash
> # 方式一（推荐）：部署时传文件，令牌不进命令行
> echo '<TOKEN>' > /root/.sea2-admin-token && chmod 600 /root/.sea2-admin-token
> curl -fsSL http://10.0.0.11:3457/downloads/bootstrap.sh \
>   | SEA2_TARBALL_URL=http://10.0.0.11:3457/downloads/sea2-deploy.tar.gz \
>     SEA1_ADMIN_TOKEN_FILE=/root/.sea2-admin-token bash
>
> # 方式二：装完再补，免重装（client-agent 每 30 分钟自动重试领码）
> echo '<TOKEN>' > /etc/sea1-x86/admin-token && chmod 600 /etc/sea1-x86/admin-token
> pm2 restart sea1-client
>
> # 方式三：在运维中心手工签发激活码后写入（完全不需要令牌）
> echo 'SEA1-XXXX-XXXX-XXXX' > /etc/sea1-x86/client-code && pm2 restart sea1-client
> ```

仓库包与大文件（linuxqq deb / NapCat.Shell.zip）统一走**服务端分发**：内网直连 `10.0.0.11:3457/downloads/*`，
内网不可达时自动测速选隧道，隧道全挂才回退腾讯 CDN —— 不再依赖 GitHub（龟速）。

### 环境变量（免交互）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SEA2_TARBALL_URL` | 空 | 仓库包地址；建议指向中央服务端 `/downloads/sea2-deploy.tar.gz`（内网秒下）。留空走 GitHub |
| `DEPLOY_MODE` | `2`（客户端） | `1` = 服务端全套（含本机激活服务 :3457），`2` = 客户端接入中央 |
| `CENTRAL_SERVER` | `http://10.0.0.11:3457` | 中央地址；置空则自动从隧道池测速选最快 |
| `SEA1_ADMIN_TOKEN` | 空 | 运维中心超管令牌。**不建议写在命令行**（会进 history/ps/日志），优先用下面的文件方式 |
| `SEA1_ADMIN_TOKEN_FILE` | 空 | 从文件读取 `SEA1_ADMIN_TOKEN`（`chmod 600`）。装完后 client-agent 也支持 `/etc/sea1-x86/admin-token` 免重装补给 |
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

### 重置为初始状态（想重跑一遍部署时用）

已安装的机器再次运行 `install.sh` 会进**维护菜单**，菜单第 **7) 恢复初始状态(卸载全部,可重装)**
即可把本机退回"从未装过"，然后重新跑一键部署：

```bash
bash install.sh                 # → 维护菜单 → 选 7
bash install.sh reset           # 等价 CLI 入口（非交互需附 MAINT_RESET_CONFIRM=RESET）
```

**安全门禁**：破坏性操作不接受回车默认值，必须**手工输入 `RESET`**（全大写）；也刻意不吃 `--yes`，
避免顺带清库。无交互终端时**直接拒绝**，除非显式设置 `MAINT_RESET_CONFIRM=RESET`。

| 会清掉 | 会保留 |
|---|---|
| 服务栈（pm2 全部进程 + 开机自启 + `/root/.pm2`） | `node` / `npm` / `pm2` 工具链（重装秒过依赖阶段） |
| `/root/sea2`、`/root/sea1`、`/root/sea1-activation-server` | CUPS 服务与已配置打印机 |
| `/root/sea1napcat`、`/root/napcat`、`/app/napcat`、`/app/napcat2` | docker 引擎与已拉取镜像 |
| docker 容器 `napcat`（副号） | 安装器目录 `/root/sea2-deploy`（脚本正在运行，自删会中断自身） |
| `/etc/sea1-x86`（machine-id / client-code / admin-token）→ 重装按**全新设备**注册 | 老 SEA 项目 `/root/activation-server`（**严禁误删**） |
| NapCat QQ 登录会话（⚠ 重装后需**重新扫码**） | |

- 清理前会自动备份关键配置与设备指纹到 `/root/sea2-reset-backup-<时间戳>.tar.gz`（`chmod 600`；
  可用 `MAINT_RESET_KEEP_BACKUP=0` 关闭）。恢复：`tar -xzf <备份> -C /`。
- 复核阶段会列残留目录/进程、pm2 守护状态、开机自启与端口占用；若有残留进程占端口，提示 `reboot` 后再部署。
- 重置完成后会直接询问"是否立即重新部署"，答 `y` 即无缝续跑全新安装向导。
- ⚠ 本功能面向**客户端/测试机**。生产主机 `10.0.0.11` 请勿使用。

### fleet 心跳状态速查

```bash
pm2 logs sea1-client --lines 20 --nostream
# 全新/无令牌： 首次心跳 status=200 valid=false reason=trial-active   ← 正常（试用中）
# 已授权：     首次心跳 status=200 valid=true  reason=ok              ← 正常（正式）
# reason=machine-mismatch → 机器指纹漂移，核对 /etc/sea1-x86/machine-id 与控制台绑定
# 400 trial-required      → 旧 bug（无 code 却不带 trial:true），升级到本提交后消失
```
