#!/usr/bin/env bash
# ==========================================================================
# lib/platform.sh — 架构 / 发行版 / glibc 检测
# ==========================================================================

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  ARCH="x86_64";  DEB_ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64";   DEB_ARCH="arm64" ;;
    armv7l|armhf)  die "不支持 32 位 arm（armv7），需要 aarch64/x86_64" ;;
    *) die "未知架构: $(uname -m)" ;;
  esac
  log_info "架构: $ARCH ($DEB_ARCH)"
}

detect_distro() {
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    DISTRO="${ID:-unknown} ${VERSION_ID:-}"
  else
    DISTRO="unknown"
  fi
  log_info "系统: $DISTRO"
  case "$DISTRO" in
    debian*|ubuntu*|armbian*|Deepin*|kylin*) : ;;
    *) log_warn "非 Debian/Ubuntu/armbian 系，依赖安装可能失败（将尽力继续）" ;;
  esac
}

require_root() {
  [ "$(id -u)" = "0" ] || die "请用 root 执行（sudo bash install.sh）"
}

check_glibc_min() {
  local need="$1" have
  have="$(ldd --version 2>/dev/null | awk 'NR==1{print $NF}')"
  if [ "$(printf '%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
    die "glibc >= $need 需要（当前 $have）"
  fi
}
