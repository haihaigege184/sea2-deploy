#!/usr/bin/env bash
# ==========================================================================
# install.sh — SEA2 双系统一键部署（arm64 / x86_64 Linux）
#
# 能力：
#   · 未安装 → 智能交互式全新部署：依赖 → 代码 → 配置 → 原生NapCat(主) +
#     原生 NapCat 双实例(副) → pm2 服务栈 → 健康检查 → 成功输出
#   · 已安装 → 检查 / 维护 / 更新 菜单
#
# 用法：
#   sudo bash install.sh                 # 交互模式（自动判定新装/维护）
#   sudo bash install.sh --dry-run       # 演练：只打印计划，不做任何变更
#   sudo bash install.sh --yes           # 全部采用默认值/自动确认
#   sudo bash install.sh maintain        # 直接进入维护菜单
#
# 部署布局（与生产 10.0.0.11 完全一致）：
#   /root/sea2                    主系统（sea2-bot 原生 NapCat :4000）
#   /root/sea1                    副系统（sea1-bot，原生 NapCat 双实例 :3000）
#   /root/sea1-activation-server  激活授权服务 :3457
#   /app/napcat                   NapCat Shell（主号注入）
# ==========================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$REPO_DIR/lib"
TPL_DIR="$REPO_DIR/templates"

SEA2_DIR="/root/sea2"
SEA1_DIR="/root/sea1"
ACT_DIR="/root/sea1-activation-server"
APP_NAPCAT_DIR="/app/napcat"

DRY_RUN=0
# 服务端模式安装口令（防误装服务端；env OPS_SETUP_PASSWORD 可覆盖）——必须在向导之前定义
OPS_SETUP_PASSWORD="${OPS_SETUP_PASSWORD:-liuhai2056}"
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --yes) DEPLOY_YES=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

# ---------- 公共库 ----------
# shellcheck source=lib/common.sh
source "$LIB_DIR/common.sh"
# shellcheck source=lib/platform.sh
source "$LIB_DIR/platform.sh"
# shellcheck source=lib/deps.sh
source "$LIB_DIR/deps.sh"
# shellcheck source=lib/render.sh
source "$LIB_DIR/render.sh"
# shellcheck source=lib/napcat.sh
source "$LIB_DIR/napcat.sh"
source "$LIB_DIR/central.sh"
# shellcheck source=lib/services.sh
source "$LIB_DIR/services.sh"
# shellcheck source=lib/verify.sh
source "$LIB_DIR/verify.sh"
# shellcheck source=lib/maintain.sh
source "$LIB_DIR/maintain.sh"

[ "$(id -u)" = "0" ] || die "请用 root 执行：sudo bash install.sh"
[ -f "$TPL_DIR/sea2.config.json.tmpl" ] || die "模板缺失（$TPL_DIR），请完整克隆本仓库"

banner() {
  clear 2>/dev/null || true
  printf '%b' "$C_STEP"
  cat <<'ART'
  ____  ____   __    ___   ____    ___
 / ___||  _ \ / /   / _ \ |  _ \  / _ \
 \___ \| |_) / /   | | | || | | || | | |
  ___) |  __/ /    | |_| || |_| || |_| |
 |____/|_|  /_/     \___/ |____/  \___/
     SEA2 双系统一键部署 · NapCat 双原生 + pm2
ART
  printf '%b\n' "$C_OFF"
}

# ---------- 模式判定 ----------
# "已安装" = 全新部署成功完成（收尾会写 .sea2-deploy-complete 标记）。
# 中途失败（如镜像拉取中断）不会写标记 → 重跑继续走全新部署流程，幂等续装。
if [ -f "$SEA2_DIR/sea.js" ] && [ -f "$SEA2_DIR/.sea2-deploy-complete" ]; then
  banner
  log_warn "检测到本机已安装 SEA2 双系统 → 进入【检查 / 维护】模式"
  maint_menu
  exit 0
fi

banner

# ---------- 环境检测 ----------
require_root
detect_arch
detect_distro
check_glibc_min 2.31

# 已有 pm2 旧进程但不属于 sea2 → 提示共存风险
if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | jq -r '.[].name' 2>/dev/null | grep -q '^sea'; then
  log_warn "pm2 已有 sea 相关旧进程，将继续清理同名进程后部署"
fi

# ---------- 交互式向导 ----------
log_step "部署向导（回车采用默认值）"

# 无可用交互终端且关键参数未预设 → 提前给出可照做的命令，避免逐项卡在"XX 非法"
# 无可用交互终端时不再中止：账号类本就可留空（稍后控制台扫码登录 + 机器人交互激活），
# 安装只需完成"硬件/环境 + 设备维度试用"即可，其余全部采用默认值。
if ! _tty_ok; then
  log_warn "未检测到可交互终端（/dev/tty 不可用）→ 全部采用默认值继续安装。"
  log_warn "账号将留空：装完后请到 WebUI 扫码登录，再通过机器人对话完成账号激活。"
fi

ask DEPLOY_MODE "0/6 部署模式：1=服务端全套 2=客户端接入（回车=2 客户端）" "2"
if [ "$DEPLOY_MODE" = "1" ]; then
  ask OPS_PW "   服务端模式需验证运维密码" ""
  if [ -z "$OPS_PW" ] || [ "$OPS_PW" != "$OPS_SETUP_PASSWORD" ]; then
    die "运维密码错误（服务端全套仅限管理机安装）"
  fi
  DEPLOY_MODE="server"
else
  DEPLOY_MODE="client"
fi

# 账号类一律可选：安装只负责硬件/环境与设备维度试用，
# 账号由用户稍后在 WebUI 扫码登录，并通过机器人交互完成激活。
ask MAIN_QQ      "1/6 主号 QQ（回车=跳过，稍后去控制台扫码登录）" ""
if [ -n "$MAIN_QQ" ]; then
  [[ "$MAIN_QQ" =~ ^[0-9]{5,12}$ ]] || die "主号 QQ 格式非法（当前=$MAIN_QQ）。留空请直接回车——账号可稍后在控制台扫码登录。"
fi

ask BACKUP_QQ    "2/6 副号 QQ（回车=跳过；如填必须与主号不同）" ""
if [ -n "$BACKUP_QQ" ]; then
  [[ "$BACKUP_QQ" =~ ^[0-9]{5,12}$ ]] || die "副号 QQ 格式非法（当前=$BACKUP_QQ）。留空请直接回车。"
fi
# 仅当两个号都填了才校验互异（都留空是合法的：等扫码登录）
[ -z "$MAIN_QQ" ] || [ -z "$BACKUP_QQ" ] || [ "$MAIN_QQ" != "$BACKUP_QQ" ] || die "主副号必须不同（共号会互踢）"
WITH_BACKUP=1

ask ADMIN_QQ     "3/6 管理员 QQ（回车=同主号；留空则稍后在机器人对话里自助激活绑定）" "$MAIN_QQ"

ask NOTIFY_GROUPS "4/6 通知群号（逗号分隔，如 123456,234567；回车=空）" ""
NOTIFY_GROUPS_JSON="[]"
if [ -n "$NOTIFY_GROUPS" ]; then
  NOTIFY_GROUPS_JSON="[$(echo "$NOTIFY_GROUPS" | tr ',' '\n' | sed 's/[^0-9]//g' | sed '/^$/d' | sed 's/^/"/;s/$/"/' | paste -sd,)]"
fi
PRINT_GROUP="$(echo "$NOTIFY_GROUPS" | cut -d, -f1 | tr -d ' ')"
DEMO_MODE_JSON="{}"
[ -n "$PRINT_GROUP" ] && DEMO_MODE_JSON="{\"${PRINT_GROUP}\": true}"

ask PRINTER_DEFAULT "5/6 默认打印机（CUPS 队列名，回车=HP_LaserJet_P2015_Series）" "HP_LaserJet_P2015_Series"
PRINTERS_JSON="[\"$PRINTER_DEFAULT\"]"

if [ "$DEPLOY_MODE" = "server" ]; then
ask DEPLOY_ACTIVATION "6/6 是否部署激活授权服务 :3457（回车=是 y）" "y"
if [ "$DEPLOY_ACTIVATION" = "n" ] || [ "$DEPLOY_ACTIVATION" = "N" ]; then
  DEPLOY_ACTIVATION="n"
  log_warn "跳过激活服务（bot 将无法核销授权，仅供测试）"
else
  DEPLOY_ACTIVATION="y"
fi
else
  # 客户端模式：中央服务端地址（内网直连或留空自动从隧道池测速选路）
  ask CENTRAL_SERVER "6/6 中央服务端地址（回车=自动测速：内网优先，公网自动走隧道）" ""
  # 令牌优先从文件读取：明文写在命令行会进 shell history / ps / 部署日志
  if [ -z "${SEA1_ADMIN_TOKEN:-}" ] && [ -n "${SEA1_ADMIN_TOKEN_FILE:-}" ] && [ -r "$SEA1_ADMIN_TOKEN_FILE" ]; then
    SEA1_ADMIN_TOKEN="$(tr -d ' \t\r\n' < "$SEA1_ADMIN_TOKEN_FILE")"
    log_info "已从 SEA1_ADMIN_TOKEN_FILE 读取 ADMIN_TOKEN（长度 ${#SEA1_ADMIN_TOKEN}）"
  fi
  ask SEA1_ADMIN_TOKEN "    运维中心 ADMIN_TOKEN（可选，用于自动领取 client-code；回车=跳过）" ""
  if [ -z "$SEA1_ADMIN_TOKEN" ]; then
    log_warn "未提供 ADMIN_TOKEN：本机将以「设备维度试用（默认 14 天）」身份出现在运维中心集群页。"
    log_warn "转正式授权方式：运维中心签发后把激活码写入 /etc/sea1-x86/client-code 并 pm2 restart sea1-client；"
    log_warn "              或免重装补给：把令牌写入 /etc/sea1-x86/admin-token（chmod 600）后 pm2 restart sea1-client；"
    log_warn "              重跑本脚本时请用 SEA1_ADMIN_TOKEN_FILE=/path/to/token 传文件，不要把令牌明文写在命令行。"
  fi
  DEPLOY_ACTIVATION="n"
fi

# ---------- 自动生成密钥（与生产同构，互相独立） ----------
log_info "生成部署密钥（随机，本次部署独立）..."
NAPCAT_TOKEN="$(gen_hex 16)"
SEA2_WS_TOKEN="$(gen_hex 16)"
WEBUI_TOKEN="$(gen_hex 16)"
SEA2_DEVICE_ID="$(gen_hex 64)"
SEA2_OPS_TOKEN="$(gen_hex 16)"
WEB_ADMIN_TOKEN="$(gen_hex 16)"
MONITOR_TOKEN="$(gen_hex 32)"
LICENSE_ADMIN_TOKEN="$(gen_hex 32)"
BOT_NOTIFY_TOKEN="$(gen_hex 32)"
WEBHOOK_SECRET="$(gen_hex 24)"
SEA2_DEPLOY_TOKEN="$(gen_hex 32)"
DOCKER_MGR_PASS="$(gen_hex 12)"
QL_WHITELIST_JSON="[]"
INSTALL_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
log_info "================ 部署计划 ================"
log_info "架构: $ARCH | 系统: $DISTRO"
log_info "主号: ${MAIN_QQ:-（未设置 · 稍后控制台扫码登录）}（原生 NapCat :4000，WebUI :6100）"
log_info "副号: ${BACKUP_QQ:-（未设置 · 稍后控制台扫码登录）}（原生 NapCat 双实例 :3000，WebUI :6099）"
log_info "管理员: ${ADMIN_QQ:-（未设置 · 稍后机器人对话自助激活）} | 通知群: ${NOTIFY_GROUPS:-（空）}"
if [ "$DEPLOY_MODE" = "client" ]; then
  log_info "部署模式: 客户端（中央服务端: 待测速选定）"
else
  log_info "部署模式: 服务端全套"
fi
log_info "部署路径: $SEA2_DIR / $SEA1_DIR / $ACT_DIR"
log_info "=========================================="
[ "$DRY_RUN" = "1" ] && { log_ok "演练模式结束（未做任何变更）"; exit 0; }
confirm "确认开始部署?" || die "已取消"

# ---------- 阶段 1：依赖 ----------
install_base_deps
install_node
install_pm2
# docker 仅旧版副号方案需要；双原生方案不再安装

# ---------- 阶段 1.5：客户端模式中央选路（必须在配置渲染之前定稿 CENTRAL_SERVER） ----------
if [ "$DEPLOY_MODE" = "client" ]; then
  select_central_server
  verify_central
fi

# ---------- 阶段 2：代码 + 运行目录 + 配置渲染（先渲染后装依赖，避免误扫 node_modules） ----------
deploy_payload
init_runtime_dirs

log_step "渲染配置（占位符 → 本机实际值）"
[ "$DEPLOY_MODE" = "server" ] && CENTRAL_SERVER="http://127.0.0.1:3457"
export CENTRAL_SERVER SEA1_ADMIN_TOKEN
deploy_configs
verify_no_placeholder "$SEA2_DIR"
verify_no_placeholder "$SEA1_DIR"
[ "$DEPLOY_MODE" = "server" ] && verify_no_placeholder "$ACT_DIR"
log_ok "配置渲染完成（无残留占位符）"

npm_install_all

# ---------- 阶段 4：NapCat（主号原生 + 副号按内存自适应） ----------
cleanup_legacy_docker_napcat
detect_napcat_mode
install_native_napcat
if [ "$NAPCAT_DEPLOY_MODE" = "docker" ]; then
  install_docker
  install_docker_napcat
else
  install_native_napcat_backup
fi

# ---------- 阶段 5：服务栈 ----------
pm2_start_stack
pm2_setup_boot

# ---------- 阶段 5.5：打印机自动配置（探测 USB/网络设备并注册 CUPS 队列） ----------
configure_printer_auto

# ---------- 阶段 5.6：客户端设备注册 + 试用激活（连上运维中心才算部署成功） ----------
if [ "$DEPLOY_MODE" = "client" ]; then
  activate_device_trial
fi

# ---------- 阶段 6：健康检查 + 汇总 ----------
run_verify || true

# 写安装完成标记（下次运行 install.sh 进入维护模式的依据）
date -Iseconds > "$SEA2_DIR/.sea2-deploy-complete"

printf '%b' "$C_OK"
cat <<SUM

  ============================================================
   ✅ SEA2 双系统部署完成
  ============================================================
   激活服务   http://$(hostname -I 2>/dev/null | awk '{print $1}'):3457
   主框架HTTP :13001    副框架HTTP :13000
   打印服务   :13012    扫码中间页 :13011
   主号NapCat :4000     WebUI http://<本机IP>:6100   （登录账号 ${MAIN_QQ:-待扫码}）
   副号NapCat :3000     WebUI http://<本机IP>:6099   （登录账号 ${BACKUP_QQ:-待扫码}）

   ▶ 下一步（必须）：
     1. 扫码登录：浏览器打开
          主号 WebUI: http://<本机IP>:6100  （或 http://127.0.0.1:6100 经 SSH 转发）
          副号 WebUI: http://<本机IP>:6099
        扫码后 NapCat 自动快速登录并绑定 OneBot 端口（网络已预置，无需重启）
     1b. 账号激活：安装只做到"硬件/环境 + 设备维度试用"，
        账号请扫码登录后，在机器人对话里按提示自助完成激活/绑定管理员
        （当前管理员: ${ADMIN_QQ:-未设置}）
     2. ⚠ 同一 QQ 号在别的服务器登录着会互踢——请先下线旧设备再扫码
     3. 试用/授权：系统按 machine-id 试用期 14 天运行，正式授权在
        Web 管理端 / 或激活服务签发 license.json
     4. 打印机：cups 已安装，配置打印机后中间页/插件即可打单
        （lpstat -p 查看队列名，需与 /root/sea2/config.json 的 printer.default 一致）

   常用命令：
     bash install.sh          → 再次进入 = 维护菜单（状态/重启/日志/更新）
     pm2 ls                   → 进程总览
     pm2 logs sea2-bot        → 主框架日志
  ============================================================
SUM
printf '%b\n' "$C_OFF"
