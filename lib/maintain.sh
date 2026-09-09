#!/usr/bin/env bash
# ==========================================================================
# lib/maintain.sh — 已安装设备的检查 / 维护菜单
# ==========================================================================

maint_status() {
  log_step "系统状态"
  pm2 ls 2>/dev/null || true
  echo
  local role
  role="$(cat "$SEA2_DIR/run/framework.role" 2>/dev/null || echo '未知')"
  log_info "框架角色: $role"
  log_info "主号在线: $(curl -s --max-time 5 -H "Authorization: Bearer ${NAPCAT_TOKEN:-x}" http://127.0.0.1:4000/get_status 2>/dev/null | jq -r '.data.online // "未知"' 2>/dev/null)"
  log_info "副号在线: $(curl -s --max-time 5 -H "Authorization: Bearer ${NAPCAT_TOKEN:-x}" http://127.0.0.1:3000/get_status 2>/dev/null | jq -r '.data.online // "未知"' 2>/dev/null)"
  echo
  log_info "端口: 激活3457 框架13001 副框架13000 打印13012 中间页13011 NapCat主4000/副3000 WebUI主6100/副6099"
}

maint_restart() {
  log_step "重启服务栈"
  local svcs="sea2-bot sea2-print-server sea2-qr sea2-napcat sea2-watchdog"
  [ -f "$SEA2_DIR/sea1-activation-server/server.js" ] && [ "$(cat "$SEA2_DIR/deploy-mode" 2>/dev/null || echo server)" = "server" ] && svcs="sea1-activation $svcs"
  [ "$(cat "$SEA2_DIR/napcat/deploy-mode" 2>/dev/null || echo native)" = "native" ] && svcs="$svcs sea2-napcat-backup"
  pm2 restart $svcs >/dev/null 2>&1
  pm2 save >/dev/null 2>&1 || true
  log_ok "已重启（角色互斥：sea1-bot 由 watchdog 仲裁管理）"
  maint_status
}

maint_logs() {
  echo "1) sea2-bot  2) watchdog  3) qr-server  4) print-server  5) activation"
  local n; read -r -p "选择 [1-5]: " n || n=1
  case "$n" in
    2) pm2 logs sea2-watchdog --lines 100 ;;
    3) pm2 logs sea2-qr --lines 100 ;;
    4) pm2 logs sea2-print-server --lines 100 ;;
    5) pm2 logs sea1-activation --lines 100 ;;
    *) pm2 logs sea2-bot --lines 100 ;;
  esac
}

maint_check() {
  NAPCAT_TOKEN="${NAPCAT_TOKEN:-$(jq -r .napcat_token "$SEA2_DIR/config.json" 2>/dev/null || echo '')}"
  export DEPLOY_MODE="$(cat "$SEA2_DIR/deploy-mode" 2>/dev/null || echo server)"
  export NAPCAT_DEPLOY_MODE="$(cat "$SEA2_DIR/napcat/deploy-mode" 2>/dev/null || echo native)"
  WITH_BACKUP=1 FAILS=0
  run_verify || true
}

maint_update() {
  log_step "更新代码（保留 config.json / license / 数据目录 / NapCat 安装）"
  local keep_s2 keep_s1 keep_a
  keep_s2="$(mktemp)"; keep_s1="$(mktemp)"; keep_a="$(mktemp)"
  [ -f "$SEA2_DIR/config.json" ] && cp "$SEA2_DIR/config.json" "$keep_s2"
  [ -f "$SEA1_DIR/config.json" ] && cp "$SEA1_DIR/config.json" "$keep_s1"
  [ -f "$ACT_DIR/config.env" ]   && cp "$ACT_DIR/config.env"   "$keep_a"

  deploy_payload

  cp "$keep_s2" "$SEA2_DIR/config.json"; cp "$keep_s1" "$SEA1_DIR/config.json"; cp "$keep_a" "$ACT_DIR/config.env"
  rm -f "$keep_s2" "$keep_s1" "$keep_a"
  log_ok "代码已更新（配置保留）。如 npm 依赖有变请手动: cd /root/sea2 && npm install --omit=dev"
  confirm "立即重启服务栈?" && maint_restart
}

maint_config() {
  log_info "配置文件位置："
  echo "  /root/sea2/config.json            主系统配置（群号/管理员/打印/ NapCat 连接）"
  echo "  /root/sea1/config.json            副系统配置"
  echo "  /root/sea1-activation-server/config.env  激活服务配置（支付密钥等）"
  echo "  /root/sea2/napcat/ops.env         中间页/运维 token"
  echo "  /app/napcat/config/               主号 NapCat 网络（onebot11_*.json）"
  echo "  /app/napcat2/config/              副号 NapCat 网络（双原生方案）"
  echo
  log_info "改完配置后执行菜单[2]重启生效"
}

maint_menu() {
  while true; do
    echo
    echo "======== SEA2 维护菜单 ========"
    echo "  1) 状态总览          2) 重启服务栈"
    echo "  3) 查看日志          4) 健康检查"
    echo "  5) 更新代码(保留配置) 6) 配置文件说明"
    echo "  0) 退出"
    local n; read -r -p "选择: " n || return 0
    case "$n" in
      1) maint_status ;;
      2) maint_restart ;;
      3) maint_logs ;;
      4) maint_check ;;
      5) maint_update ;;
      6) maint_config ;;
      0|q|Q) return 0 ;;
      *) log_warn "无效选择" ;;
    esac
  done
}
