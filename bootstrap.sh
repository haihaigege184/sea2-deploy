#!/usr/bin/env bash
# ==========================================================================
# bootstrap.sh — SEA2 一键部署引导器（网络拉取版）
#
# 用法（新机器上无需预下载任何文件，一行命令）：
#   curl -fsSL https://raw.githubusercontent.com/<USER>/sea2-deploy/main/bootstrap.sh | bash
#   或: wget -qO- <同上URL> | bash
#   或先下载再执行: bash bootstrap.sh [--mirror ghfast|direct] [--ref main]
#
# 流程：检测架构/系统 → 多源回退下载仓库 tarball → 解压到 /root/sea2-deploy
#       → 校验 → 交给 install.sh（智能交互：新装机向导 / 已装维护菜单）
# ==========================================================================
set -euo pipefail

REPO_REF="${REPO_REF:-main}"
GITHUB_RAW="https://raw.githubusercontent.com/__GITHUB_USER__/sea2-deploy/${REPO_REF}"
GITHUB_TARBALL="https://codeload.github.com/__GITHUB_USER__/sea2-deploy/tar.gz/${REPO_REF}"
PROXY_PREFIX="https://ghfast.top/"   # GitHub 加速前缀（国内直连失败时自动套用）

C_G='\033[1;32m'; C_Y='\033[1;33m'; C_R='\033[1;31m'; C_B='\033[1;35m'; C_0='\033[0m'
log()  { printf "%b[bootstrap]%b %s\n" "$C_B" "$C_0" "$*"; }
ok()   { printf "%b[ok]%b %s\n" "$C_G" "$C_0" "$*"; }
warn() { printf "%b[warn]%b %s\n" "$C_Y" "$C_0" "$*"; }
die()  { printf "%b[err]%b %s\n" "$C_R" "$C_0" "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行（sudo bash 或 sudo -i）"

# ---- 参数 ----
FORCE_MIRROR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) FORCE_MIRROR="$2"; shift 2 ;;
    --ref)    REPO_REF="$2"; shift 2 ;;
    *) warn "未知参数: $1（忽略）"; shift ;;
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
case "$FORCE_MIRROR" in
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
exec bash /root/sea2-deploy/install.sh
