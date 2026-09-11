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
    return 0
  fi
  # [修复] dpkg 认为已注册但二进制缺失（半卸载/手删文件）→ reinstall 直接补齐
  if dpkg -s nodejs >/dev/null 2>&1; then
    log_info "nodejs 包已注册但二进制缺失 → reinstall 补齐"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall -o Dpkg::Options::="--force-overwrite" nodejs >/dev/null 2>&1 || true
    if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge 18 ] 2>/dev/null; then
      log_ok "Node.js $(node -v) 就绪（reinstall 补齐）"
      return 0
    fi
    # 包状态冲突（如 nodesource nodejs 与发行版 npm 抢依赖）→ 连 npm 一起清干净重装
    log_warn "nodejs 包状态异常（冲突/半装），清除后重装..."
    DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge nodejs npm libnode-dev libnode72 >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get autoremove -y >/dev/null 2>&1 || true
  fi
  # 注意：不要 apt_install "nodejs npm" —— 发行版 npm 与 nodesource nodejs 冲突；nodesource nodejs 自带 npm
  apt_install nodejs
  if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -ge 18 ] 2>/dev/null; then
    log_ok "Node.js $(node -v) 就绪"
    return 0
  fi
  # NodeSource 兜底（armbian/Ubuntu 自带 libnode-dev 与 nodejs 抢文件，先卸载冲突包 + force-overwrite）
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null 2>&1 || true
  apt-get remove -y libnode-dev libnode72 >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-overwrite" nodejs \
    || die "Node.js 安装失败，请手动安装 >= 18"
  log_ok "Node.js $(node -v) 就绪（NodeSource）"
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

# ---- 打印机探测辅助（内部）----------------------------------------------------
# 注意：lpinfo -v 每行形如 `direct usb://HP/LaserJet%20P2015%20Series?serial=xxx`
#        或 `network ipp` / `network https`（行首是 backend 名，不是 URI）。
#        所以历史实现里的 grep -E '^usb://' 永远命中 0 行 → 部署时"未识别到打印机"。
#        URI 必须从行内提取。

# 取某 URI 的 make-and-model（CUPS 已算好的干净品牌型号）
_prn_make_of() {
  lpinfo -l -v 2>/dev/null | grep -F "uri = $1" -A 8 \
    | sed -n 's/^[[:space:]]*make-and-model[[:space:]]*=[[:space:]]*//p' | head -1
}

# 从 lpinfo -v 里按优先级挑 URI：usb:// → hp:/usb/ → 网络类。
# $2 非空时只接受 make-and-model 含该品牌词的设备（如 HP）。
_prn_pick_uri() {
  local list="$1" brand="${2:-}" t line cand mk
  for t in 'usb://' 'hp:/usb/' 'ipp://' 'ipps://' 'socket://' 'dnssd://' 'lpd://' 'http://' 'https://'; do
    while IFS= read -r line; do
      case "$line" in
        *"$t"*) ;;
        *) continue ;;
      esac
      cand=$(printf '%s' "$line" | sed -n "s|.*\($t[^ ]*\).*|\1|p" | head -1)
      [ -z "$cand" ] && continue
      if [ -n "$brand" ]; then
        mk=$(_prn_make_of "$cand") || mk=""
        printf '%s' "$mk" | grep -qi "$brand" || continue
      fi
      printf '%s' "$cand"
      return 0
    done <<EOF
$list
EOF
  done
  return 1
}

# 按型号特征词从 lpinfo -m 里挑 PPD：先找 PostScript，再退任意匹配
_prn_pick_ppd() {
  local model="$1" tok hit
  [ -z "$model" ] && return 1
  for tok in $(printf '%s' "$model" | tr 'A-Z' 'a-z' | grep -oE '[a-z]*[0-9][a-z0-9]*' | sort -u); do
    [ ${#tok} -lt 3 ] && continue
    hit=$(lpinfo -m 2>/dev/null | grep -i -- "$tok" | grep -iE 'postscript|ps\.ppd' | head -1 | awk '{print $1}')
    [ -z "$hit" ] && hit=$(lpinfo -m 2>/dev/null | grep -i -- "$tok" | head -1 | awk '{print $1}')
    [ -n "$hit" ] && { printf '%s' "$hit"; return 0; }
  done
  return 1
}

# configure_printer_auto: 自动探测 USB/网络打印机并注册 CUPS 队列（幂等，已有同名队列则跳过）
#   - URI 从 lpinfo -v 行内提取（usb:// 优先，hp:/usb/ 次之，网络类再次），按 PRINTER_DEFAULT 品牌筛选
#   - 驱动优先 everywhere（IPP 无驱动打印），失败按型号挑 PPD，再退 raw
configure_printer_auto() {
  command -v lpadmin >/dev/null 2>&1 || { log_warn "CUPS 未装，跳过打印机配置"; return 0; }
  command -v lpinfo  >/dev/null 2>&1 || { log_warn "CUPS 客户端(lpinfo)缺失，跳过打印机配置"; return 0; }
  if lpstat -p 2>/dev/null | grep -q "printer ${PRINTER_DEFAULT}"; then
    log_ok "打印机队列已存在: ${PRINTER_DEFAULT}"
    return 0
  fi
  log_step "自动配置打印机（CUPS）"
  systemctl enable --now cups >/dev/null 2>&1 || service cups start >/dev/null 2>&1 || true
  sleep 2

  local want="$PRINTER_DEFAULT"
  local devlist; devlist=$(lpinfo -v 2>/dev/null || true)
  if [ -z "$devlist" ]; then
    log_warn "未探测到任何打印设备（lpinfo -v 无输出）。请接好打印机后重跑，或稍后在中间页【识别打印机】里添加。"
    return 0
  fi

  local brand; brand=$(printf '%s' "$want" | grep -oE '^[A-Za-z]+' | head -1 || true)
  local uri; uri=$(_prn_pick_uri "$devlist" "$brand") || uri=""
  if [ -z "$uri" ]; then uri=$(_prn_pick_uri "$devlist" "") || uri=""; fi
  if [ -z "$uri" ]; then
    log_warn "探测到设备但未解析出可用 URI；稍后请在中间页【识别打印机】里手动添加。"
    return 0
  fi

  local model; model=$(_prn_make_of "$uri") || model=""
  log_info "探测到打印机: ${model:-未知型号}  ←  $uri"

  local ppd; ppd=$(_prn_pick_ppd "$model") || ppd=""
  if lpadmin -p "$want" -E -v "$uri" -m everywhere 2>/dev/null; then
    log_ok "打印机队列就绪(驱动 everywhere): ${want}"
  elif [ -n "$ppd" ] && lpadmin -p "$want" -E -v "$uri" -m "$ppd" 2>/dev/null; then
    log_ok "打印机队列就绪(驱动 ${ppd}): ${want}"
  elif lpadmin -p "$want" -E -v "$uri" -m raw 2>/dev/null; then
    log_warn "打印机队列就绪(驱动 raw)。若打印乱码/不出纸，请在中间页【识别打印机】里改选驱动。"
  else
    log_warn "lpadmin 注册失败（驱动问题）。请在中间页【识别打印机】里选择驱动，或手动:"
    log_warn "  lpadmin -p ${want} -E -v '$uri' -m everywhere"
    return 0
  fi
  cupsenable "$want" 2>/dev/null || true
  cupsaccept "$want" 2>/dev/null || true
  return 0
}
