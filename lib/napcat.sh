#!/usr/bin/env bash
# ==========================================================================
# lib/napcat.sh — 双原生 NapCat（共用 QQ NT 二进制，双 Shell 实例隔离）
#   主号: HOME=/root/sea2/napcat   NAPCAT_HOME=/app/napcat   OneBot:4000 WebUI:6100
#   副号: HOME=/root/sea1napcat    NAPCAT_HOME=/app/napcat2  OneBot:3000 WebUI:6099
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
  candidates+=("$QQ_RELEASE_BASE/linuxqq_${QQ_VERSION}_${arch}.deb")          # ① GIT 基线直连
  candidates+=("https://ghfast.top/${QQ_RELEASE_BASE}/linuxqq_${QQ_VERSION}_${arch}.deb")  # ② GIT 基线（ghfast 加速）
  candidates+=("$QQ_DEB_BASE/linuxqq_${QQ_VERSION}_${arch}.deb")              # ③ 腾讯官方 CDN
  local dyn
  dyn=$(curl -fsSL --max-time 30 -A "Mozilla/5.0" "$QQ_DOC_PAGE" 2>/dev/null \
    | grep -oE "https://qqdl\.gtimg\.cn/qqfile/QQNT/[^\"' ]*linuxqq_[0-9.-]+_${arch}\.deb" | head -1)
  [ -n "$dyn" ] && candidates+=("$dyn")
  local u size
  for u in "${candidates[@]}"; do
    log_info "尝试下载: $u"
    if curl -fL --retry 3 --connect-timeout 15 --max-time 900 -o "$tmp" "$u" 2>/dev/null; then
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
  curl -fL --retry 3 --connect-timeout 15 --max-time 600 -o "$zip" "$NAPCAT_SHELL_URL" 2>/dev/null \
    && unzip -t "$zip" >/dev/null 2>&1 && return 0
  log_warn "GitHub 直连失败，尝试代理..."
  curl -fL --retry 3 --connect-timeout 15 --max-time 600 -o "$zip" "$NAPCAT_PROXY_URL" 2>/dev/null \
    && unzip -t "$zip" >/dev/null 2>&1 && return 0
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
    unzip -q -o -d "$APP_NAPCAT_DIR" -x "config/*" "$zip"
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
  unzip -q -o -d "$APP_NAPCAT2_DIR" -x "config/*" "$zip"
  rm -f "$zip"
  log_ok "NapCat Shell 副号就绪: $APP_NAPCAT2_DIR（OneBot :3000 · WebUI :6099）"
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
