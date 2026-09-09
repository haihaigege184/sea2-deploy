#!/usr/bin/env bash
# ==========================================================================
# lib/deps.sh — 系统依赖安装（Debian/Ubuntu/armbian）
# ==========================================================================

# ensure_apt_mirrors: 官方源连通性探测，失败自动换国内镜像（149 部署实测：官方源 869MB/13min 拉不动）
#   - amd64 → archive.ubuntu.com ; arm64/ports → ports.ubuntu.com
#   - 换源目标：阿里云 mirrors.aliyun.com（USTC/腾讯同样可用；TUNA http 403 不用）
ensure_apt_mirrors() {
  local src=/etc/apt/sources.list
  local probe_host official_host mirror_host suite
  # 识别当前源架构类型（ubuntu-ports = arm64 等；普通 ubuntu = amd64）
  if grep -qs "ports.ubuntu.com\|ubuntu-ports" "$src" /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null; then
    official_host="ports.ubuntu.com"; mirror_host="mirrors.aliyun.com/ubuntu-ports"
  else
    official_host="archive.ubuntu.com"; mirror_host="mirrors.aliyun.com/ubuntu"
  fi
  if curl -sf --connect-timeout 4 --max-time 8 -o /dev/null "http://${official_host}/" \
     || curl -sf --connect-timeout 4 --max-time 8 -o /dev/null "https://${official_host}/"; then
    log_info "apt 官方源连通正常（${official_host}）"
    return 0
  fi
  log_warn "apt 官方源不通（${official_host}），自动切换阿里云镜像..."
  backup_file "$src"
  # debian 系（armbian 常见）换 debian 阿里镜像
  if grep -qs "deb.debian.org\|debian" "$src" 2>/dev/null && ! grep -qs "ubuntu" "$src" 2>/dev/null; then
    sed -i 's|http://deb.debian.org|https://mirrors.aliyun.com|g; s|https://deb.debian.org|https://mirrors.aliyun.com|g' "$src"
  else
    sed -i "s|http://${official_host}|https://${mirror_host}|g; s|https://${official_host}|https://${mirror_host}|g" "$src"
  fi
  # 附加 sources.list.d（armbian 自定义源）一并替换
  local f
  for f in /etc/apt/sources.list.d/*.list; do
    [ -f "$f" ] || continue
    sed -i "s|http://${official_host}|https://${mirror_host}|g; s|https://${official_host}|https://${mirror_host}|g" "$f" 2>/dev/null || true
  done
  if apt-get update -y; then
    log_ok "已切换国内镜像源并完成 apt update"
  else
    log_warn "阿里云镜像 update 仍失败，保留现状继续（后续安装可能较慢）"
  fi
}

apt_install() {
  # 输出保留在安装日志中（失败可定位），不静默
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" || {
    log_warn "apt install 失败，先 update 再重试..."
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  }
}

install_base_deps() {
  log_step "安装系统依赖"
  ensure_apt_mirrors
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
      # NodeSource 兜底（armbian/Ubuntu 自带 libnode-dev 与 nodejs 抢文件，先卸载冲突包 + force-overwrite）
      curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null 2>&1 || true
      apt-get remove -y libnode-dev libnode72 >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-overwrite" nodejs \
        || die "Node.js 安装失败，请手动安装 >= 18"
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

# configure_printer_auto: 自动探测 USB/网络打印机并注册 CUPS 队列（幂等，已有同名队列则跳过）
#   - 用 lpinfo -v 找 usb:// 或 ipp:// 设备；优先匹配 PRINTER_DEFAULT 关键字（如 HP）
#   - 驱动优先 everywhere（IPP 无驱动打印），失败回退 raw
configure_printer_auto() {
  command -v lpadmin >/dev/null 2>&1 || { log_warn "CUPS 未装，跳过打印机配置"; return 0; }
  if lpstat -p 2>/dev/null | grep -q "printer ${PRINTER_DEFAULT}"; then
    log_ok "打印机队列已存在: ${PRINTER_DEFAULT}"
    return 0
  fi
  log_step "自动配置打印机（CUPS）"
  systemctl enable --now cups >/dev/null 2>&1 || service cups start >/dev/null 2>&1 || true
  sleep 2
  local uri want="$PRINTER_DEFAULT"
  # 从 lpinfo -v 抓设备 URI：usb:// 优先，其后 ipp://；关键字匹配（品牌名含于 want，如 HP）
  uri=$(lpinfo -v 2>/dev/null | grep -E '^usb://' | head -1)
  [ -z "$uri" ] && uri=$(lpinfo -v 2>/dev/null | grep -E '^(ipp|ipps|socket)://' | head -1)
  if [ -z "$uri" ]; then
    log_warn "未探测到 USB/网络打印机（lpinfo -v 无设备）。请接好打印机后重跑，或手动:"
    log_warn "  lpadmin -p ${want} -E -v <设备URI> -m everywhere"
    return 0
  fi
  # 关键字筛选：若 want 含品牌词（如 HP）且有匹配设备则用匹配的
  local brand; brand=$(echo "$want" | grep -oE '^[A-Za-z]+' | head -1)
  if [ -n "$brand" ]; then
    local m; m=$(lpinfo -v 2>/dev/null | grep -E '^usb://' | grep -i "$brand" | head -1)
    [ -n "$m" ] && uri="$m"
  fi
  log_info "探测到打印机: $uri → 注册队列 ${want}"
  lpadmin -p "$want" -E -v "$uri" -m everywhere 2>/dev/null     || lpadmin -p "$want" -E -v "$uri" -o printer-is-shared=false 2>/dev/null     || lpadmin -p "$want" -E -v "$uri" -m raw 2>/dev/null     || { log_warn "lpadmin 注册失败（驱动问题），可手动执行: lpadmin -p ${want} -E -v '$uri' -m everywhere"; return 0; }
  cupsenable "$want" 2>/dev/null || true
  cupsaccept "$want" 2>/dev/null || true
  log_ok "打印机队列就绪: ${want} ← $uri"
}
