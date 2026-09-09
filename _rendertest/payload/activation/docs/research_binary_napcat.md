# 二进制版 NapCat 可用性调研（Part A）

> 调研人：高见远（Gao）· 架构师 ｜ 日期：2026-08 ｜ 目的：决定 sea2（P0-2）「二进制 napcat 集成（解耦 docker）」方案
> 结论先行：**sea2 双平台（x86_64 + arm64）集成官方二进制 NapCat.Shell 可行；arm32（玩客云）无官方支持，需降级策略。**

---

## 1. 官方 GitHub Releases 发布情况

| 平台 | 官方发布 | 制品形态 | 说明 |
|---|---|---|---|
| Linux x86_64 | ✅ 有 | `LinuxX64 DEB` / `LinuxX64 RPM` | 每个 Release 均发布 |
| Linux arm64 | ✅ 有 | `LinuxArm64 DEB` / `LinuxArm64 RPM` | 每个 Release 均发布 |
| Linux arm32/armv7 | ❌ **无官方支持** | — | 官方主推 amd64 + arm64；armv7 仅早期（v1.3.x~v1.4.x）社区手动交叉编译的非官方包，已不再维护 |
| Windows x64 | ✅ 有 | exe / 一键包 | 与本项目无关 |
| macOS | ✅ 有 | DMG | 与本项目无关 |

- **仓库**：`NapNeko/NapCatQQ`（GitHub Releases）
- **最新版本**：v4.18.x（调研时点 v4.18.13，2026-07 发布），配套 QQ 版本 **9.9.26-44343**；官方推荐 QQ 版本 **40768+**（最低 40768）
- **NapCat.Shell 形态**：`NapCat.Shell.zip`（Linux 独立版，面向"已有 QQ 安装"的无头服务器）；另有 `NapCat.Framework.zip`（作为 Node 库嵌入）、Windows 一键包（内置 QQ + Node，仅 Windows）

## 2. 依赖要求（关键结论：解耦 docker 可行，但非纯静态、仍需 linuxqq + nodejs）

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| Docker | ❌ **不需要** | Shell 模式独立运行，正是本需求"解耦 docker"的目标 |
| linuxqq（官方 QQ Linux 客户端） | ✅ **必需** | NapCat 是基于官方 NTQQ 的 Hook/注入框架，必须有 QQNT ≥ 9.9.27 的内核/客户端在机 |
| Node.js | ✅ **必需** | 要求 Node.js 18+（LTS）；Linux 部署走 NodeLoader/launcher 加载 |
| 桌面环境 | ❌ 不需要 | Shell 模式无头运行（headless），无 GUI 依赖 |

> 注意：NapCat 是"协议侧框架"，不是独立 QQ 实现——它注入到官方 QQNT 进程。因此 **"免 docker" 成立，"免 QQ 客户端/免 Node" 不成立**。安装包必须捆绑/预装 linuxqq 与 nodejs（或安装脚本自动安装）。

## 3. 数据 / 配置目录差异与迁移

**Shell 模式目录结构（官方文档）**：
```
napcat/
├── napcat            # 主可执行
├── config/           # 配置目录
│   ├── napcat.json           # 核心配置
│   └── onebot11.json         # OneBot11 协议配置（多账号时 onebot11_<uin>.json）
├── data/             # 运行时数据（首次运行生成）
├── logs/             # 日志（首次运行生成）
└── temp/             # 临时文件（首次运行生成）
```

**Docker 版目录**：
- NapCat 配置：`/app/napcat/config`（或 `/usr/src/app/napcat/config`）
- QQ 持久化登录数据：`/app/.config/QQ`
- 登录态/设备指纹随容器持久化；**重新创建容器需固定 MAC**（否则 QQ 登录态失效）

**迁移要点（docker → 二进制）**：
1. 复制 `config/` 全目录（napcat.json + onebot11_<uin>.json，含 WebUI 密钥、HTTP/WS 端口、token）
2. 复制 QQ 登录数据目录（容器 `/app/.config/QQ` → 宿主机 `~/.config/QQ` 或 sea2 内指定 `XDG_CONFIG_HOME`）
3. 保留设备指纹（MAC/机器码）：迁移后登录态可能失效，需现场重新扫码一次；`sea2` 以机器码 `machineId` 绑定授权，与 QQ 登录态解耦，不受影响
4. 端口规划：HTTP 3000 / WS 3001 / WebUI 6099 需与既有 `ncqq` 端口规划对齐（sea2 进程由 pm2 托管，进程名建议 `sea2-napcat`）

## 4. 授权 / 合规层面

| 维度 | 结论 |
|---|---|
| NapCat 开源协议 | **MIT**（AUR PKGBUILD `license=('MIT')`）→ 允许随商业安装包分发/二次封装，**无装机数量授权限制** |
| 捆绑分发 | NapCat 本体 MIT 无限制；**linuxqq 为腾讯官方客户端**，捆绑分发需自行评估腾讯客户端使用条款（一般允许安装，但自动化/机器人用途违反 QQ 用户协议，存在封号风险） |
| 账号运营风险 | 1000 台 = 1000 个 QQ 账号同时登录自动化，**存在批量风控/封号风险**，属运营侧风险，需用户知悉并采取账号养号/分组灰度策略；"同一账号不能同时登录 NTQQ 与 NapCatQQ" |
| 合规结论 | 技术上无 NapCat 侧数量限制；风险集中在 QQ 账号风控与 linuxqq 分发条款，建议安装包默认不带 QQ 账号凭据，由现场各自登录 |

## 5. 结论与推荐

### 结论
1. **sea2 x86_64 + arm64 双平台集成官方二进制 NapCat.Shell：可行**。官方 Release 同时提供两架构 DEB/RPM，`解耦 docker` 成立。
2. **arm64 无降级必要**：官方 arm64 与 x86_64 同步发布、同版本同能力；安装脚本按 `uname -m` 分发对应包即可。
3. **arm32（玩客云 10.0.0.198）需降级策略**：无官方二进制（QQ 也无 arm32 官方客户端）。玩客云仅作为**测试沙盒**，用于回归 x86_64/arm64 安装包中**不依赖 napcat 的链路**（安装/心跳/指令/PM2/CUPS）；napcat 登录用例在沙盒上以「二进制解包校验 + 依赖探测」代替，或跳过登录步骤。**sea2 目标平台明确 = x86_64 + arm64，不含 arm32**。
4. 数据迁移：docker→二进制迁移 = `config/` + `~/.config/QQ` 目录搬迁 + 现场重扫一次；sea2 授权（machineId↔code）与 QQ 登录态解耦，不受影响。

### 推荐版本
- **NapCat.Shell v4.18.x（固定小版本，如 v4.18.13）+ linuxqq 9.9.26-44343**，按官方兼容表**锁定配套 QQ 构建号**；升级走"停进程 → 备份 config → 替换 → 重启"流程（官方更新文档），数据目录不随升级覆盖。
- 建议在 sea2 安装脚本中记录 `napcat.version` 与 `qq.build` 到 `/root/sea2/config/version.json`，供运维后台版本展示与灰度比对（P1-7 分布统计按版本）。

### 待办（落 T01/T03 前确认）
- [ ] 主理人确认 linuxqq 随安装包捆绑 vs 安装脚本自动下载（合规与镜像策略）
- [ ] 主理人确认 arm32 沙盒 napcat 用例的验收口径（跳过登录 vs QEMU 模拟）
