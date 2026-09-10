#!/usr/bin/env bash
# ==========================================================================
# bootstrap.sh — SEA2 一键部署引导器（网络拉取版）
#
# 用法（推荐先落盘再执行：这样向导能正常交互，也能重复运行/看参数）：
#   curl -fsSL http://sea1.xsian.top/downloads/bootstrap.sh -o /tmp/sea2.sh && bash /tmp/sea2.sh
#   （隧道域名不可用时兜底 GitHub）
#   curl -fsSL https://raw.githubusercontent.com/haihaigege184/sea2-deploy/main/bootstrap.sh -o /tmp/sea2.sh && bash /tmp/sea2.sh
#
# 也可以管道执行（向导会自动从 /dev/tty 读输入，不会读管道）：
#   curl -fsSL http://sea1.xsian.top/downloads/bootstrap.sh | bash
#
# 分发节点自动选路：对全部隧道域名 + 内网地址测速，取最快者下载大文件，
# 内网机器自然命中 10.0.0.11，公网机器命中隧道，无需人工区分。
#
# 流程：检测架构/系统 → 多源回退下载仓库 tarball → 解压到 /root/sea2-deploy
#       → 校验 → 交给 install.sh（智能交互：新装机向导 / 已装维护菜单）
# ==========================================================================
set -euo pipefail

REPO_REF="${REPO_REF:-main}"
GITHUB_RAW="https://raw.githubusercontent.com/haihaigege184/sea2-deploy/${REPO_REF}"
GITHUB_TARBALL="https://codeload.github.com/haihaigege184/sea2-deploy/tar.gz/${REPO_REF}"
PROXY_PREFIX="https://ghfast.top/"   # GitHub 加速前缀（国内直连失败时自动套用）

C_G='\033[1;32m'; C_Y='\033[1;33m'; C_R='\033[1;31m'; C_B='\033[1;35m'; C_0='\033[0m'
log()  { printf "%b[bootstrap]%b %s\n" "$C_B" "$C_0" "$*"; }
ok()   { printf "%b[ok]%b %s\n" "$C_G" "$C_0" "$*"; }
warn() { printf "%b[warn]%b %s\n" "$C_Y" "$C_0" "$*"; }
die()  { printf "%b[err]%b %s\n" "$C_R" "$C_0" "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行（sudo bash 或 sudo -i）"

# ---- 参数 ----
# 先保存全部参数：下方 while 循环会 shift 掉 $@，不保存则透传给 install.sh 时为空
INSTALL_ARGS=("$@")
FORCE_MIRROR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) FORCE_MIRROR="$2"; shift 2 ;;
    --ref)    REPO_REF="$2"; shift 2 ;;
    # 未识别参数不在此消费：原样保留在 INSTALL_ARGS 中透传给 install.sh
    # （如 --dry-run / --yes），此处静默跳过即可
    *) shift ;;
  esac
done

# ---- 基础依赖（curl/tar 在几乎所有发行版自带；缺则用 apt 装）----
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || {
  warn "缺少 curl/wget，尝试 apt 安装..."
  apt-get update -y && apt-get install -y curl ca-certificates
}
fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 --max-time 600 -o "$2" "$1" 2>/dev/null
  else
    wget -qO "$2" "$1"
  fi
}

# ---- 多源回退下载仓库 tarball ----
DEST="/root/sea2-deploy.tar.gz"
SOURCES=()

# 运维中心分发节点（公网隧道 + 内网直连）：全部公开，全国可用
SEA2_NODES="http://sea1.xsian.top http://sea2.hk1.sian.one http://sea3.gost.cloudns.ch http://sea4.gost.nyc.mn http://sea1bot888.locvps.sian.one http://10.0.0.11:3457"
BEST_NODE=""; BEST_MS=999999
pick_fastest() { # 测速选最快可达节点（内网不可达自动走隧道）
  local u ms
  for u in $SEA2_NODES; do
    ms=$(curl -s -o /dev/null -w '%{time_total}' --connect-timeout 4 --max-time 8 "$u/api/shop/info" 2>/dev/null || echo 999)
    ms=$(printf '%s' "$ms" | awk '{printf "%d", $1*1000}')
    log "测速 $u → ${ms}ms"
    if [ "$ms" -lt "$BEST_MS" ]; then BEST_NODE="$u"; BEST_MS="$ms"; fi
  done
  [ -n "$BEST_NODE" ] && [ "$BEST_MS" -lt 900000 ]
}

# 服务端分发优先（可选）：运维中心 /downloads/sea2-deploy.tar.gz，内网/隧道可达时最快最稳
[ -n "${SEA2_TARBALL_URL:-}" ] && SOURCES+=("$SEA2_TARBALL_URL")

if [ "${FORCE_MIRROR:-}" != "github" ] && pick_fastest; then
  ok "最快分发节点: $BEST_NODE（${BEST_MS}ms）"
  SOURCES+=("$BEST_NODE/downloads/sea2-deploy.tar.gz")
  # 其余节点作同轮兜底（不重复测速，仅换源重试）
  for u in $SEA2_NODES; do
    [ "$u" != "$BEST_NODE" ] && SOURCES+=("$u/downloads/sea2-deploy.tar.gz")
  done
fi

case "$FORCE_MIRROR" in
  github)  SOURCES+=("${GITHUB_TARBALL}" "${PROXY_PREFIX}${GITHUB_TARBALL}") ;;
  ghfast)  SOURCES+=("${PROXY_PREFIX}${GITHUB_TARBALL}") ;;
  direct)  SOURCES+=("${GITHUB_TARBALL}") ;;
  *)       SOURCES+=("${GITHUB_TARBALL}" "${PROXY_PREFIX}${GITHUB_TARBALL}") ;;
esac

mkdir -p /root
downloaded=""
for u in "${SOURCES[@]}"; do
  log "下载仓库: $u"
  if fetch "$u" "$DEST" && [ "$(stat -c%s "$DEST" 2>/dev/null || echo 0)" -gt 100000 ]; then
    downloaded="$u"; break
  fi
  warn "下载失败/文件过小，换下一个源"
  rm -f "$DEST"
done
[ -n "$downloaded" ] || die "全部下载源均失败。可手动指定镜像: bash bootstrap.sh --mirror ghfast"

# ---- 校验 + 解压（保留已有部署机的 deploy 目录？解压到干净目录再合并）----
log "解压仓库..."
rm -rf /root/.sea2-deploy-extract
mkdir -p /root/.sea2-deploy-extract
tar -xzf "$DEST" -C /root/.sea2-deploy-extract
SRC_DIR=$(find /root/.sea2-deploy-extract -maxdepth 1 -type d -name 'sea2-deploy*' | head -1)
[ -n "$SRC_DIR" ] || die "tarball 结构异常（未找到 sea2-deploy 目录）"

# 已存在的 sea2-deploy 目录：保留 payload 之外的本地状态（无），直接用新代码覆盖核心脚本
mkdir -p /root/sea2-deploy
cp -a "$SRC_DIR"/install.sh /root/sea2-deploy/
cp -a "$SRC_DIR"/lib        /root/sea2-deploy/
cp -a "$SRC_DIR"/templates  /root/sea2-deploy/
cp -a "$SRC_DIR"/payload    /root/sea2-deploy/ 2>/dev/null || true
[ -f /root/sea2-deploy/install.sh ] || die "install.sh 未就位"
chmod +x /root/sea2-deploy/install.sh
rm -rf /root/.sea2-deploy-extract "$DEST"
ok "仓库就绪: /root/sea2-deploy"

# ---- 交给主安装脚本（智能判定：新装机=向导，已装=维护菜单）----
log "启动安装向导..."
if [ ${#INSTALL_ARGS[@]} -gt 0 ]; then
  exec bash /root/sea2-deploy/install.sh "${INSTALL_ARGS[@]}"
else
  exec bash /root/sea2-deploy/install.sh
fi
