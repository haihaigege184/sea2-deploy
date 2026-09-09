#!/usr/bin/env bash
# ==========================================================================
# lib/napcat.sh — NapCat 主副双实例（内存自适应）
#   MEM >= 8G  → 原生主（:4000/:6100）+ docker 副（:3000/:6099，生产同款成熟方案）
#   MEM <  8G  → 双原生（共用 QQ 二进制，NAPCAT_HOME 分流，零 docker，省 ~2.5G）
#   可用 NAPCAT_MODE=force-native / force-docker 强制覆盖
# ==========================================================================

QQ_DEB_BASE="${QQ_DEB_BASE:-https://qqdl.gtimg.cn/qqfile/QQNT/9.9.35/beta/1763096b}"
QQ_VERSION="${QQ_VERSION:-3.2.33-52892}"
QQ_DEB_URL="${QQ_DEB_URL:-}"   # 完整直链覆盖（最高优先级）
QQ_RELEASE_BASE="${QQ_RELEASE_BASE:-https://github.com/haihaigege184/sea2-deploy/releases/download/qq-deb-v1}"  # GIT 基线版本（当前运行版快照，最稳定）
QQ_DOC_PAGE="${QQ_DOC_PAGE:-https://docs.qq.com/doc/DVXNoRlpKaWhEY015}"  # 腾讯官方下载文档页（可动态抓最新直链）
NAPCAT_SHELL_URL="${NAPCAT_SHELL_URL:-https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip}"
NAPCAT_PROXY_URL="${NAPCAT_PROXY_URL:-https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip}"

SEA2_NAPCAT_DIR="/root/sea2/napcat"      # 主号 HOME
SEA1_NAPCAT_DIR="/root/sea1napcat"       # 副号 HOME
APP_NAPCAT2_DIR="/app/napcat2"           # 副号 NapCat Shell

# download_linuxqq <arch> <dest>: 多源回退下载 linuxqq deb（≥50MB 视为有效）
#   优先级：QQ_DEB_URL 直链覆盖 > GIT Release 基线 > 腾讯官方 CDN > 官方文档页动态抓取
download_linuxqq() {
  local arch="$1" tmp="$2"
  local candidates=()
  [ -n "$QQ_DEB_URL" ] && candidates+=("$QQ_DEB_URL")
  # 1) 服务端分发（主通道）：已选定中央服务端(内网) + 隧道池全部公网地址，全部不可达才往下走
  local pool c
  if [ -n "${CENTRAL_SERVER:-}" ]; then
    candidates+=("${CENTRAL_SERVER%/}/downloads/linuxqq_${QQ_VERSION}_${arch}.deb")
    pool=$(curl -fsSL --connect-timeout 5 --max-time 15 "${CENTRAL_SERVER%/}/api/deploy/tunnels" 2>/dev/null || true)
    if [ -n "$pool" ]; then
      while IFS= read -r c; do
        [ -n "$c" ] && candidates+=("${c%/}/downloads/linuxqq_${QQ_VERSION}_${arch}.deb")
      done < <(printf '%s' "$pool" | jq -r '.tunnels[]?.publicAddr, .masterAddress? // empty' 2>/dev/null | grep -v '^$' | sort -u)
    fi
  fi
  # 2) 腾讯官方 CDN（隧道全不可达时迅速切换）
  candidates+=("$QQ_DEB_BASE/linuxqq_${QQ_VERSION}_${arch}.deb")
  # 3) 官方文档页动态抓取
  local dyn
  dyn=$(curl -fsSL --max-time 30 -A "Mozilla/5.0" "$QQ_DOC_PAGE" 2>/dev/null |
    grep -oE "https://qqdl\.gtimg\.cn/qqfile/QQNT/[^\"' ]*linuxqq_[0-9.-]+_${arch}\.deb" | head -1)
  [ -n "$dyn" ] && candidates+=("$dyn")
  # 4) GIT Release 基线（最后兜底，国内直连慢）
  candidates+=("$QQ_RELEASE_BASE/linuxqq_${QQ_VERSION}_${arch}.deb")
  candidates+=("https://ghfast.top/${QQ_RELEASE_BASE}/linuxqq_${QQ_VERSION}_${arch}.deb")
  local u size
  for u in "${candidates[@]}"; do
    log_info "尝试下载: $u"
    if curl -fL --retry 2 --connect-timeout 10 --max-time 1800 -o "$tmp" "$u" 2>/dev/null; then
      size=$(stat -c%s "$tmp" 2>/dev/null || echo 0)
      if [ "$size" -gt 50000000 ]; then
        log_ok "linuxqq 下载成功 ($((size/1024/1024))MB)"
        return 0
      fi
      log_warn "下载文件过小($size B)，视为损坏，换下一个源"
    else
      log_warn "下载失败，换下一个源"
    fi
    rm -f "$tmp"
  done
  return 1
}

# download_napcat_shell <dest_zip>: NapCat Shell zip（GitHub 直连 > 代理回退）
download_napcat_shell() {
  local zip="$1"
  local u pool ok=""
  # 1) 服务端分发（主通道）：内网中央 + 隧道池
  if [ -n "${CENTRAL_SERVER:-}" ]; then
    for u in "${CENTRAL_SERVER%/}/downloads/NapCat.Shell.zip"; do
      if curl -fL --retry 2 --connect-timeout 10 --max-time 300 -o "$zip" "$u" 2>/dev/null && unzip -t "$zip" >/dev/null 2>&1; then
        log_ok "NapCat Shell 下载成功（服务端分发）"; return 0
      fi
    done
    pool=$(curl -fsSL --connect-timeout 5 --max-time 15 "${CENTRAL_SERVER%/}/api/deploy/tunnels" 2>/dev/null || true)
    if [ -n "$pool" ]; then
      while IFS= read -r u; do
        [ -n "$u" ] || continue
        if curl -fL --retry 2 --connect-timeout 10 --max-time 300 -o "$zip" "${u%/}/downloads/NapCat.Shell.zip" 2>/dev/null && unzip -t "$zip" >/dev/null 2>&1; then
          log_ok "NapCat Shell 下载成功（隧道池分发）"; return 0
        fi
      done < <(printf '%s' "$pool" | jq -r '.tunnels[]?.publicAddr' 2>/dev/null | grep -v '^$' | sort -u)
    fi
  fi
  # 2) GitHub 直连 > 代理回退
  curl -fL --retry 3 --connect-timeout 15 --max-time 600 -o "$zip" "$NAPCAT_SHELL_URL" 2>/dev/null \
    && unzip -t "$zip" >/dev/null 2>&1 && return 0
  log_warn "GitHub 直连失败，尝试代理..."
  curl -fL --retry 3 --connect-timeout 15 --max-time 600 -o "$zip" "$NAPCAT_PROXY_URL" 2>/dev/null \
    && unzip -t "$zip" >/dev/null 2>&1 && return 0
  rm -f "$zip"
  return 1
}

# patch_qq_loadnapcat: QQ package.json main → loadNapCat.js（按 NAPCAT_HOME 环境变量选实例）
patch_qq_loadnapcat() {
  local appjson="$SEA2_NAPCAT_DIR/QQ/resources/app/package.json"
  [ -f "$appjson" ] || die "未找到 $appjson（QQ 包结构异常）"
  backup_file "$appjson"
  cat > "$SEA2_NAPCAT_DIR/QQ/resources/app/loadNapCat.js" <<'LOADER'
const p = process.env.NAPCAT_HOME || '/app/napcat';
(async () => { await import('file://' + p + '/napcat.mjs'); })();
LOADER
  jq '.main = "./loadNapCat.js"' "$appjson" > "${appjson}.tmp" && mv "${appjson}.tmp" "$appjson"
}

# install_native_napcat: QQ 二进制 + NapCat Shell（主号 /app/napcat）+ 注入
install_native_napcat() {
  log_step "安装原生 NapCat · 主号（$DEB_ARCH）"

  # 已装且注入完整则跳过
  if [ -x "$SEA2_NAPCAT_DIR/QQ/qq" ] && [ -f "$APP_NAPCAT_DIR/napcat.mjs" ] \
     && grep -q 'loadNapCat' "$SEA2_NAPCAT_DIR/QQ/resources/app/package.json" 2>/dev/null      && grep -q 'NAPCAT_HOME' "$SEA2_NAPCAT_DIR/QQ/resources/app/loadNapCat.js" 2>/dev/null; then
    log_ok "原生 NapCat 主号已安装，跳过下载"
    return 0
  fi

  # ---- 1) QQ NT Linux（dpkg -x 解包，不注册系统包；主副号共用同一份二进制） ----
  if [ ! -x "$SEA2_NAPCAT_DIR/QQ/qq" ]; then
    local deb="linuxqq_${QQ_VERSION}_${DEB_ARCH}.deb"
    local tmp="/tmp/$deb"
    log_info "下载 linuxqq $QQ_VERSION ($DEB_ARCH) ..."
    download_linuxqq "$DEB_ARCH" "$tmp" || die "linuxqq 全部下载源均失败（可设 QQ_DEB_URL 指定直链后重试）"
    mkdir -p "$SEA2_NAPCAT_DIR/_qqx"
    dpkg -x "$tmp" "$SEA2_NAPCAT_DIR/_qqx"
    rm -rf "$SEA2_NAPCAT_DIR/QQ"
    mv "$SEA2_NAPCAT_DIR/_qqx/opt/QQ" "$SEA2_NAPCAT_DIR/QQ"
    rm -rf "$SEA2_NAPCAT_DIR/_qqx" "$tmp"
    chmod 755 "$SEA2_NAPCAT_DIR/QQ/qq" 2>/dev/null || true
    log_ok "QQ NT 就绪: $SEA2_NAPCAT_DIR/QQ/qq"
  fi

  # ---- 2) NapCat Shell（主号）→ /app/napcat ----
  if [ ! -f "$APP_NAPCAT_DIR/napcat.mjs" ]; then
    local zip="/tmp/NapCat.Shell.zip"
    log_info "下载 NapCat Shell ..."
    download_napcat_shell "$zip" || die "NapCat Shell 下载失败（直连与代理均失败）"
    # 不整目录删除（config/ 内有预渲染配置）；排除 zip 内 config 覆盖
    mkdir -p "$APP_NAPCAT_DIR"
    unzip -q -o -d "$APP_NAPCAT_DIR" "$zip" -x "config/*"
    log_ok "NapCat Shell 就绪: $APP_NAPCAT_DIR"
  fi

  # ---- 3) 注入（主副共用同一 QQ 补丁，loadNapCat.js 按 NAPCAT_HOME 分流） ----
  patch_qq_loadnapcat
  log_ok "注入完成（main → loadNapCat.js → \${NAPCAT_HOME:-/app/napcat}/napcat.mjs）"

  # ---- 4) 启动器 + 运行目录 ----
  mkdir -p "$SEA2_NAPCAT_DIR/.config"
  chmod +x "$SEA2_NAPCAT_DIR/run.sh" 2>/dev/null || true
  [ -d "$APP_NAPCAT_DIR" ] || die "$APP_NAPCAT_DIR 缺失"
}

# install_native_napcat_backup: 副号 NapCat Shell 实例（/app/napcat2）+ 独立 HOME
#   与主号共用 QQ 二进制与 loadNapCat 补丁（run-backup.sh 以 NAPCAT_HOME 分流），零 docker、仅 ~50MB
install_native_napcat_backup() {
  log_step "安装原生 NapCat · 副号（与主号共用 QQ，双实例隔离）"
  mkdir -p "$SEA1_NAPCAT_DIR/.config"
  [ -f "$SEA2_NAPCAT_DIR/QQ/resources/app/loadNapCat.js" ] || die "主号补丁未就绪，无法安装副号实例"
  [ -f "$APP_NAPCAT2_DIR/napcat.mjs" ] && { log_ok "NapCat Shell 副号已就绪: $APP_NAPCAT2_DIR"; return 0; }
  local zip="/tmp/NapCat.Shell.zip"
  [ -f "$zip" ] || download_napcat_shell "$zip" || die "NapCat Shell 下载失败（副号实例）"
  # 不整目录删除（config/ 内有预渲染配置）；排除 zip 内 config 覆盖
  mkdir -p "$APP_NAPCAT2_DIR"
  unzip -q -o -d "$APP_NAPCAT2_DIR" "$zip" -x "config/*"
  rm -f "$zip"
  log_ok "NapCat Shell 副号就绪: $APP_NAPCAT2_DIR（OneBot :3000 · WebUI :6099）"
}

# detect_napcat_mode: 依内存决定主副方案（客户端/服务端通用）
detect_napcat_mode() {
  if [ "${NAPCAT_MODE:-}" = "force-native" ]; then NAPCAT_DEPLOY_MODE="native"; return 0; fi
  if [ "${NAPCAT_MODE:-}" = "force-docker" ]; then NAPCAT_DEPLOY_MODE="docker"; return 0; fi
  local mem_kb
  mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "$mem_kb" -ge $((8*1024*1024)) ]; then
    NAPCAT_DEPLOY_MODE="docker"
  else
    NAPCAT_DEPLOY_MODE="native"
  fi
  log_info "内存 $((mem_kb/1024))MB → NapCat 副号方案: $NAPCAT_DEPLOY_MODE"
}

# configure_docker_mirrors: docker.io 直连失败时写入国内镜像加速（幂等；registry-mirrors 必须带 https:// scheme）
DOCKER_MIRRORS="${DOCKER_MIRRORS:-https://docker.1ms.run https://docker.m.daocloud.io https://docker.aityp.com}"
configure_docker_mirrors() {
  local dj=/etc/docker/daemon.json
  if [ -f "$dj" ] && grep -q 'registry-mirrors' "$dj" 2>/dev/null; then
    log_info "daemon.json 已含 registry-mirrors，沿用"
    return 0
  fi
  mkdir -p /etc/docker
  local arr tmp="/tmp/daemon.json.$$"
  arr=$(printf '"%s
"' $DOCKER_MIRRORS | jq -s -c .)
  if [ -f "$dj" ]; then
    backup_file "$dj"
    jq --argjson m "$arr" '. + {"registry-mirrors": $m}' "$dj" > "$tmp" || { rm -f "$tmp"; return 1; }
  else
    printf '{"registry-mirrors": %s}
' "$arr" > "$tmp"
  fi
  mv "$tmp" "$dj"
  systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
  sleep 3
  docker info 2>/dev/null | grep -q 'Registry Mirrors' && log_ok "docker 镜像加速已配置" || log_warn "docker 重启后未见镜像加速（继续尝试）"
}

# install_docker_napcat: 副系统 docker napcat（内存 >=8G 成熟方案；预置网络配置后启动）
install_docker_napcat() {
  log_step "部署副系统 docker napcat"
  command -v docker >/dev/null 2>&1 || install_docker
  mkdir -p /root/napcat/.config /root/napcat/logs /root/napcat/temp /root/napcat/config

  if docker ps -a --format '{{.Names}}' | grep -qx 'napcat'; then
    log_ok "容器 napcat 已存在，跳过创建"
  else
    log_info "拉取镜像 mlikiowa/napcat-docker:latest（多架构）..."
    docker pull mlikiowa/napcat-docker:latest || {
      log_warn "docker.io 直连失败，配置国内镜像加速后重试..."
      configure_docker_mirrors
      docker pull mlikiowa/napcat-docker:latest || die "napcat-docker 镜像拉取失败（含镜像加速）"
    }
    docker run -d --name napcat       --restart=unless-stopped       -e NAPCAT_UID=0 -e NAPCAT_GID=0       -e ACCOUNT="$BACKUP_QQ"       -e TOKEN="$NAPCAT_TOKEN"       -e TZ=Asia/Shanghai       -p 3000:3000 -p 3001:3001 -p 6099:6099       -v /root/napcat/.config:/app/.config/QQ       -v /root/napcat/logs:/app/napcat/logs       -v /root/napcat/temp:/root/napcat/temp       -v /root/napcat/config:/app/napcat/config       mlikiowa/napcat-docker:latest >/dev/null       || die "napcat 容器创建失败"
  fi
  log_ok "docker napcat 就绪（OneBot :3000 · WebUI :6099）"
}

# cleanup_legacy_docker_napcat: 老版 docker 方案残留清理（容器/挂载目录），全新部署机无害
cleanup_legacy_docker_napcat() {
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'napcat'; then
    log_warn "检测到旧版 docker napcat 容器，移除（已改双原生方案）"
    docker rm -f napcat >/dev/null 2>&1 || true
  fi
  [ -d /root/napcat ] && rm -rf /root/napcat
  return 0
}
