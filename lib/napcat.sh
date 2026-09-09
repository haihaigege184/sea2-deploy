#!/usr/bin/env bash
# ==========================================================================
# lib/napcat.sh — 原生 NapCat（QQ NT + NapCat Shell 注入）与 docker napcat 安装
# ==========================================================================

QQ_DEB_BASE="${QQ_DEB_BASE:-https://qqdl.gtimg.cn/qqfile/QQNT/9.9.32/beta/727ce4e5}"
QQ_VERSION="${QQ_VERSION:-3.2.30-50828}"
NAPCAT_SHELL_URL="${NAPCAT_SHELL_URL:-https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip}"
NAPCAT_PROXY_URL="${NAPCAT_PROXY_URL:-https://ghfast.top/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip}"

# install_native_napcat: QQ 二进制 + NapCat Shell + 注入 patch
install_native_napcat() {
  log_step "安装原生 NapCat（主系统 · $DEB_ARCH）"

  # 已装且注入完整则跳过
  if [ -x "$SEA2_DIR/napcat/QQ/qq" ] && [ -f "$APP_NAPCAT_DIR/napcat.mjs" ] \
     && grep -q 'loadNapCat' "$SEA2_DIR/napcat/QQ/resources/app/package.json" 2>/dev/null; then
    log_ok "原生 NapCat 已安装，跳过下载"
    return 0
  fi

  # ---- 1) QQ NT Linux（dpkg -x 解包，不注册系统包） ----
  if [ ! -x "$SEA2_DIR/napcat/QQ/qq" ]; then
    local deb="linuxqq_${QQ_VERSION}_${DEB_ARCH}.deb" tmp="/tmp/$deb"
    log_info "下载 linuxqq $QQ_VERSION ($DEB_ARCH) ..."
    curl -fL --retry 3 -o "$tmp" "$QQ_DEB_BASE/$deb" || die "linuxqq 下载失败: $QQ_DEB_BASE/$deb"
    mkdir -p "$SEA2_DIR/napcat/_qqx"
    dpkg -x "$tmp" "$SEA2_DIR/napcat/_qqx"
    rm -rf "$SEA2_DIR/napcat/QQ"
    mv "$SEA2_DIR/napcat/_qqx/opt/QQ" "$SEA2_DIR/napcat/QQ"
    rm -rf "$SEA2_DIR/napcat/_qqx" "$tmp"
    chmod 755 "$SEA2_DIR/napcat/QQ/qq" 2>/dev/null || true
    log_ok "QQ NT 就绪: $SEA2_DIR/napcat/QQ/qq"
  fi

  # ---- 2) NapCat Shell → /app/napcat ----
  if [ ! -f "$APP_NAPCAT_DIR/napcat.mjs" ]; then
    local zip="/tmp/NapCat.Shell.zip"
    log_info "下载 NapCat Shell ..."
    curl -fL --retry 3 -o "$zip" "$NAPCAT_SHELL_URL" 2>/dev/null \
      || curl -fL --retry 3 -o "$zip" "$NAPCAT_PROXY_URL" \
      || die "NapCat Shell 下载失败（直连与代理均失败）"
    unzip -t "$zip" >/dev/null || die "NapCat.Shell.zip 损坏"
    rm -rf "$APP_NAPCAT_DIR"
    mkdir -p "$APP_NAPCAT_DIR"
    unzip -q -o -d "$APP_NAPCAT_DIR" "$zip"
    rm -f "$zip"
    log_ok "NapCat Shell 就绪: $APP_NAPCAT_DIR"
  fi

  # ---- 3) 注入：package.json main → loadNapCat.js → napcat.mjs ----
  local appjson="$SEA2_DIR/napcat/QQ/resources/app/package.json"
  [ -f "$appjson" ] || die "未找到 $appjson（QQ 包结构异常）"
  backup_file "$appjson"
  printf "(async () => {await import('file://%s/napcat.mjs');})();" "$APP_NAPCAT_DIR" \
    > "$SEA2_DIR/napcat/QQ/resources/app/loadNapCat.js"
  jq '.main = "./loadNapCat.js"' "$appjson" > "${appjson}.tmp" && mv "${appjson}.tmp" "$appjson"
  log_ok "注入完成（main → loadNapCat.js → $APP_NAPCAT_DIR）"

  # ---- 4) 启动器就位 + 运行目录 ----
  mkdir -p "$SEA2_DIR/napcat/.config"
  chmod +x "$SEA2_DIR/napcat/run.sh" 2>/dev/null || true
  # run.sh 里 cd 的 /app/napcat 必须存在
  [ -d "$APP_NAPCAT_DIR" ] || die "$APP_NAPCAT_DIR 缺失"
}

# install_docker_napcat: 副系统 docker napcat（预置网络配置后启动）
install_docker_napcat() {
  log_step "部署副系统 docker napcat"
  mkdir -p /root/napcat/.config /root/napcat/logs /root/napcat/temp /root/napcat/config

  if docker ps -a --format '{{.Names}}' | grep -qx 'napcat'; then
    log_ok "容器 napcat 已存在，跳过创建"
  else
    log_info "拉取镜像 mlikiowa/napcat-docker:latest（多架构）..."
    docker pull mlikiowa/napcat-docker:latest || die "napcat-docker 镜像拉取失败"
    docker run -d --name napcat \
      --restart=unless-stopped \
      -e NAPCAT_UID=0 -e NAPCAT_GID=0 \
      -e ACCOUNT="$BACKUP_QQ" \
      -e TOKEN="$NAPCAT_TOKEN" \
      -e TZ=Asia/Shanghai \
      -p 3000:3000 -p 3001:3001 -p 6099:6099 \
      -v /root/napcat/.config:/app/.config/QQ \
      -v /root/napcat/logs:/app/napcat/logs \
      -v /root/napcat/temp:/root/napcat/temp \
      -v /root/napcat/config:/app/napcat/config \
      mlikiowa/napcat-docker:latest >/dev/null \
      || die "napcat 容器创建失败"
  fi
  log_ok "docker napcat 就绪（OneBot :3000 · WebUI :6099）"
}
