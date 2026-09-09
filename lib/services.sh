#!/usr/bin/env bash
# ==========================================================================
# lib/services.sh — 目录初始化 / payload 部署 / pm2 服务编排
# ==========================================================================

SEA2_DIR="/root/sea2"
SEA1_DIR="/root/sea1"
ACT_DIR="/root/sea1-activation-server"
APP_NAPCAT_DIR="/app/napcat"

deploy_payload() {
  log_step "部署代码（payload → 生产路径）"
  local src="$REPO_DIR/payload"
  [ -d "$src/sea2" ] && [ -d "$src/sea1" ] && [ -d "$src/activation" ] \
    || die "payload 不完整（需 payload/{sea2,sea1,activation}）"

  mkdir -p "$SEA2_DIR" "$SEA1_DIR" "$ACT_DIR"
  cp -a "$src/sea2/."      "$SEA2_DIR/"
  cp -a "$src/sea1/."      "$SEA1_DIR/"
  cp -a "$src/activation/." "$ACT_DIR/"
  log_ok "代码已部署到 $SEA2_DIR / $SEA1_DIR / $ACT_DIR"
}

init_runtime_dirs() {
  log_step "初始化运行目录"
  mkdir -p "$SEA2_DIR"/{data,database,logs,backups,run,config,webprint/uploads} \
           "$SEA1_DIR"/{data,database,logs,backups} \
           "$ACT_DIR"/data \
           "$SEA2_DIR/napcat/.config"
  # 全新机器指纹（激活授权绑定用）
  if [ ! -f "$SEA2_DIR/config/machine-id" ]; then
    gen_hex 32 > "$SEA2_DIR/config/machine-id"
    chmod 600 "$SEA2_DIR/config/machine-id"
  fi
  # 客户端识别码
  if [ ! -f "$SEA2_DIR/client-code" ]; then
    gen_hex 16 > "$SEA2_DIR/client-code"
  fi
  # 框架角色：主系统在岗
  if [ ! -f "$SEA2_DIR/run/framework.role" ]; then
    echo 'SEA2_ACTIVE' > "$SEA2_DIR/run/framework.role"
  fi
  chmod 600 "$SEA2_DIR/config/machine-id" 2>/dev/null || true
  log_ok "运行目录就绪（machine-id=$(head -c 8 "$SEA2_DIR/config/machine-id")…）"
}

npm_install_all() {
  log_step "安装 npm 依赖（production）"
  local d
  for d in "$SEA2_DIR" "$SEA1_DIR" "$ACT_DIR" "$SEA2_DIR/napcat"; do
    if [ -f "$d/package.json" ]; then
      log_info "npm install --omit=dev ($d)"
      (cd "$d" && npm install --omit=dev --no-audit --no-fund --loglevel=error) \
        || die "npm install 失败: $d"
    fi
  done
  log_ok "npm 依赖就绪"
}

pm2_start_stack() {
  log_step "启动 pm2 服务栈"

  # 清理同名旧进程
  pm2 delete sea2-bot sea1-bot sea2-watchdog sea2-print-server sea2-qr sea2-napcat sea1-activation >/dev/null 2>&1 || true

  # 激活服务
  pm2 start "$ACT_DIR/server.js" --name sea1-activation --cwd "$ACT_DIR" \
    --time --max-restarts 20 >/dev/null

  # 主框架（SEA2_ACTIVE）
  pm2 start "$SEA2_DIR/ecosystem.sea2-bot.config.js" >/dev/null
  # 独立打印服务
  pm2 start "$SEA2_DIR/ecosystem.sea2-print-server.config.js" >/dev/null
  # 扫码中间页
  pm2 start "$SEA2_DIR/ecosystem.qr.config.js" >/dev/null
  # 原生 napcat（QQ 进程）
  pm2 start "$SEA2_DIR/napcat/run.sh" --name sea2-napcat --interpreter bash --time >/dev/null
  # 双向仲裁 watchdog
  pm2 start "$SEA2_DIR/sea2-watchdog/ecosystem.watchdog.config.js" >/dev/null
  # 副框架：注册但不启动（角色互斥，SEA2_ACTIVE 下保持 STOPPED）
  pm2 start "$SEA1_DIR/sea.js" --name sea1-bot --cwd "$SEA1_DIR" --time >/dev/null
  pm2 stop sea1-bot >/dev/null

  pm2 save >/dev/null
  log_ok "pm2 栈已启动并保存（pm2 ls）"
}

pm2_setup_boot() {
  log_step "配置开机自启"
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  systemctl enable pm2-root >/dev/null 2>&1 || true
  systemctl enable docker >/dev/null 2>&1 || true
  log_ok "pm2 + docker 开机自启已配置"
}
