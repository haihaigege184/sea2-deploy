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
  # fleet 设备指纹（运维中心绑定用）：必须在 sea1-client 启动前确定性落地。
  # 否则 client-agent 走回退分支自造随机指纹 → 重装后 machine_id 漂移 → 心跳 machine-mismatch。
  if [ ! -f /etc/sea1-x86/machine-id ]; then
    mkdir -p /etc/sea1-x86
    gen_hex 32 > /etc/sea1-x86/machine-id
    chmod 600 /etc/sea1-x86/machine-id
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
  # pm2 delete 多名参数遇缺失名会中止整条删除 → 必须逐名删除（实机检验抓到）
  for _n in sea2-bot sea1-bot sea2-watchdog sea2-print-server sea2-qr sea2-napcat sea2-napcat-backup sea1-activation sea1-client; do
    pm2 delete "$_n" >/dev/null 2>&1 || true
  done

  # 激活服务（仅服务端模式；客户端模式连中央服务端，本机不部署）
  if [ "${DEPLOY_MODE:-server}" = "server" ]; then
  pm2 start "$ACT_DIR/server.js" --name sea1-activation --cwd "$ACT_DIR" \
    --time --max-restarts 20 >/dev/null
  fi

  # 主框架（SEA2_ACTIVE）
  pm2 start "$SEA2_DIR/ecosystem.sea2-bot.config.js" >/dev/null
  # 独立打印服务
  pm2 start "$SEA2_DIR/ecosystem.sea2-print-server.config.js" >/dev/null
  # 扫码中间页
  pm2 start "$SEA2_DIR/ecosystem.qr.config.js" >/dev/null
  # 原生 napcat 主号（QQ 进程，OneBot :4000）
  pm2 start "$SEA2_DIR/napcat/run.sh" --name sea2-napcat --interpreter bash --time >/dev/null
  # 副号按内存自适应方案：native=双原生第二实例；docker=容器（无 pm2 进程）
  if [ "${NAPCAT_DEPLOY_MODE:-native}" = "native" ]; then
    pm2 start "$SEA2_DIR/napcat/run-backup.sh" --name sea2-napcat-backup --interpreter bash --time >/dev/null
  fi
  # 双向仲裁 watchdog（客户端默认保留双系统主备切换）
  pm2 start "$SEA2_DIR/sea2-watchdog/ecosystem.watchdog.config.js" >/dev/null
  # 客户端模式：fleet agent 心跳上报运维中心
  if [ "${DEPLOY_MODE:-server}" = "client" ]; then
    SEA1_ACTIVATION_URL="$CENTRAL_SERVER" SEA1_ADMIN_TOKEN="$SEA1_ADMIN_TOKEN" \
      pm2 start "$SEA2_DIR/client-agent/client-agent.js" --name sea1-client \
      --cwd "$SEA2_DIR/client-agent" --time --max-restarts 20 >/dev/null
  fi
  # 副框架：注册但不启动（角色互斥，SEA2_ACTIVE 下保持 STOPPED）
  pm2 start "$SEA1_DIR/sea.js" --name sea1-bot --cwd "$SEA1_DIR" --time >/dev/null
  pm2 stop sea1-bot >/dev/null

  echo "${NAPCAT_DEPLOY_MODE:-native}" > "$SEA2_DIR/napcat/deploy-mode"
  echo "${DEPLOY_MODE:-server}"      > "$SEA2_DIR/deploy-mode"
  pm2 save >/dev/null
  log_ok "pm2 栈已启动并保存（pm2 ls）"
}

pm2_setup_boot() {
  log_step "配置开机自启"
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  systemctl enable pm2-root >/dev/null 2>&1 || true
  [ "${NAPCAT_DEPLOY_MODE:-native}" = "docker" ] && { systemctl enable docker >/dev/null 2>&1 || true; }
  log_ok "pm2 开机自启已配置"
}
