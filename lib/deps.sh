#!/usr/bin/env bash
# ==========================================================================
# lib/deps.sh — 系统依赖安装（Debian/Ubuntu/armbian）
# ==========================================================================

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null 2>&1 || {
    apt-get update -y >/dev/null 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null
  }
}

install_base_deps() {
  log_step "安装系统依赖"
  local need=() c
  for c in curl jq unzip openssl ca-certificates; do
    command -v "$c" >/dev/null 2>&1 || need+=("$c")
  done
  # QQ NT 运行库 + 虚拟显示 + 打印
  local pkgs=(xvfb ffmpeg libgbm1 libnss3 libasound2 libatk-bridge2.0-0 libgtk-3-0 libxss1 libxkbcommon0 libatspi2.0-0 cups cups-client)
  (( ${#need[@]} )) && pkgs=("${need[@]}" "${pkgs[@]}")
  log_info "apt 安装: ${pkgs[*]}"
  apt_install "${pkgs[@]}"
  log_ok "系统依赖就绪"
}

install_node() {
  log_step "安装 Node.js"
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  fi
  if [ "$major" -ge 18 ] 2>/dev/null; then
    log_ok "Node.js $(node -v) 已就绪"
  else
    log_info "安装 Node.js 18.x（apt 默认版本过旧/缺失）"
    apt_install nodejs npm
    if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge 18 ] 2>/dev/null; then
      log_ok "Node.js $(node -v) 就绪"
    else
      # NodeSource 兜底
      curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null 2>&1 \
        && apt_install nodejs
      command -v node >/dev/null 2>&1 || die "Node.js 安装失败，请手动安装 >= 18"
      log_ok "Node.js $(node -v) 就绪（NodeSource）"
    fi
  fi
}

install_pm2() {
  log_step "安装 pm2"
  if command -v pm2 >/dev/null 2>&1; then
    log_ok "pm2 已就绪（$(pm2 -v)）"
  else
    npm install -g pm2@latest >/dev/null 2>&1 || npm install -g pm2 >/dev/null
    command -v pm2 >/dev/null 2>&1 || die "pm2 安装失败"
    log_ok "pm2 $(pm2 -v) 就绪"
  fi
}

install_docker() {
  log_step "安装 Docker（副系统 docker napcat 需要）"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log_ok "Docker 已就绪"
    return 0
  fi
  log_info "使用官方脚本安装 Docker（国内网络可能较慢）..."
  if ! curl -fsSL https://get.docker.com | sh >/dev/null 2>&1; then
    log_warn "官方脚本失败，尝试 apt docker.io"
    apt_install docker.io
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "Docker 安装/启动失败"
  log_ok "Docker 就绪"
}
