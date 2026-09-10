#!/usr/bin/env bash
# ==========================================================================
# lib/render.sh — 占位符全树渲染 + 配置文件部署
# ==========================================================================

# 占位符 → 向导变量名 映射（渲染时取同名变量值注入）
PLACEHOLDER_VARS=(
  "__MAIN_QQ__ MAIN_QQ"
  "__BACKUP_QQ__ BACKUP_QQ"
  "__ADMIN_QQ__ ADMIN_QQ"
  "__PRINT_GROUP__ PRINT_GROUP"
  "__NOTIFY_GROUPS_JSON__ NOTIFY_GROUPS_JSON"
  "__QL_WHITELIST_JSON__ QL_WHITELIST_JSON"
  "__PRINTERS_JSON__ PRINTERS_JSON"
  "__PRINTER_DEFAULT__ PRINTER_DEFAULT"
  "__DEMO_MODE_JSON__ DEMO_MODE_JSON"
  "__NAPCAT_TOKEN__ NAPCAT_TOKEN"
  "__SEA2_WS_TOKEN__ SEA2_WS_TOKEN"
  "__WEBUI_TOKEN__ WEBUI_TOKEN"
  "__SEA2_DEVICE_ID__ SEA2_DEVICE_ID"
  "__SEA2_OPS_TOKEN__ SEA2_OPS_TOKEN"
  "__WEB_ADMIN_TOKEN__ WEB_ADMIN_TOKEN"
  "__WEBHOOK_SECRET__ WEBHOOK_SECRET"
  "__MONITOR_TOKEN__ MONITOR_TOKEN"
  "__LICENSE_ADMIN_TOKEN__ LICENSE_ADMIN_TOKEN"
  "__BOT_NOTIFY_TOKEN__ BOT_NOTIFY_TOKEN"
  "__SEA2_DEPLOY_TOKEN__ SEA2_DEPLOY_TOKEN"
  "__DOCKER_MGR_PASS__ DOCKER_MGR_PASS"
  "__SEA1_ADMIN_TOKEN__ SEA1_ADMIN_TOKEN"
  "__CENTRAL_SERVER__ CENTRAL_SERVER"
  "__INSTALL_TIME__ INSTALL_TIME"
)

# render_file: 替换文件内所有部署占位符（值取自向导同名变量）
render_file() {
  local f="$1" pair ph var val
  for pair in "${PLACEHOLDER_VARS[@]}"; do
    ph="${pair%% *}"; var="${pair##* }"
    val="${!var:-}"
    # 空值也必须替换：账号类允许留空（稍后扫码登录），若跳过替换会让 __MAIN_QQ__ 等
    # 占位符残留在配置里，随后 verify_no_placeholder 直接判失败 → 部署中断。
    local esc
    esc="$(printf '%s' "$val" | sed -e 's/[&|\\]/\\&/g')"
    sed -i "s|${ph}|${esc}|g" "$f"
  done
}

# render_tree: 部署目录内所有含占位符的文件逐一渲染（跳过 node_modules / QQ 二进制目录）
render_tree() {
  local dir="$1" f hits=0
  while IFS= read -r f; do
    render_file "$f"; hits=$((hits+1))
  done < <(grep -rlE '__[A-Z0-9_]+__' "$dir" \
             --exclude-dir=node_modules --exclude-dir=QQ 2>/dev/null || true)
  log_info "已渲染 $hits 个文件（$dir）"
}

# verify_no_placeholder: 精确检查部署占位符清单（避免误伤代码内 __XXX__ 运行时全局变量）
verify_no_placeholder() {
  local dir="$1" ph bad all_bad=""
  for ph in "${PLACEHOLDER_VARS[@]}"; do
    ph="${ph%% *}"
    bad="$(grep -rlF "$ph" "$dir" --exclude-dir=node_modules --exclude-dir=QQ 2>/dev/null || true)"
    [ -n "$bad" ] && all_bad="$all_bad$ph →\n$(echo "$bad" | sed 's/^/    /')\n"
  done
  if [ -n "$all_bad" ]; then
    log_err "以下占位符未渲染:"
    printf '%b' "$all_bad"
    die "渲染不完整，中止"
  fi
}

# deploy_configs: 模板 → 目标位置 + 全树渲染
deploy_configs() {
  local tpl="$TPL_DIR"
  local app2="${APP_NAPCAT2_DIR:-/app/napcat2}"

  # NapCat 配置目录先建好（原生 /app/napcat、/app/napcat2 后续由 napcat 安装步骤落地，但配置先行预置）
  mkdir -p "$APP_NAPCAT_DIR/config" "$app2/config"

  install -m 644 "$tpl/sea2.config.json.tmpl"            "$SEA2_DIR/config.json"
  install -m 644 "$tpl/sea1.config.json.tmpl"            "$SEA1_DIR/config.json"
  install -m 644 "$tpl/ecosystem.sea2-bot.config.js"     "$SEA2_DIR/ecosystem.sea2-bot.config.js"
  install -m 644 "$tpl/ecosystem.sea2-print-server.config.js" "$SEA2_DIR/ecosystem.sea2-print-server.config.js"
  install -m 644 "$tpl/ecosystem.watchdog.config.js"     "$SEA2_DIR/sea2-watchdog/ecosystem.watchdog.config.js"
  install -m 644 "$tpl/ecosystem.qr.config.js"           "$SEA2_DIR/ecosystem.qr.config.js"
  install -m 644 "$tpl/ops.env"                          "$SEA2_DIR/napcat/ops.env"
  install -m 644 "$tpl/napcat-http.env"                  "$SEA2_DIR/napcat/napcat-http.env"
  install -m 755 "$tpl/run-backup.sh"                    "$SEA2_DIR/napcat/run-backup.sh"
  install -m 600 "$tpl/activation.config.env"            "$ACT_DIR/config.env"

  # NapCat 配置（预置网络，免重启绑定端口 —— 首次登录即生效）
  install -m 644 "$tpl/napcat.json"        "$APP_NAPCAT_DIR/config/napcat.json"
  install -m 644 "$tpl/webui.main.json"    "$APP_NAPCAT_DIR/config/webui.json"
  install -m 644 "$tpl/onebot11.main.json" "$APP_NAPCAT_DIR/config/onebot11_${MAIN_QQ}.json"
  if [ "$WITH_BACKUP" = "1" ]; then
    if [ "${NAPCAT_DEPLOY_MODE:-native}" = "docker" ]; then
      mkdir -p /root/napcat/config
      install -m 644 "$tpl/napcat.json"          /root/napcat/config/napcat.json
      install -m 644 "$tpl/webui.docker.json"    /root/napcat/config/webui.json
      install -m 644 "$tpl/onebot11.docker.json" /root/napcat/config/onebot11_${BACKUP_QQ}.json
    else
      install -m 644 "$tpl/napcat.json"          "$app2/config/napcat.json"
      install -m 644 "$tpl/webui.backup.json"    "$app2/config/webui.json"
      install -m 644 "$tpl/onebot11.backup.json" "$app2/config/onebot11_${BACKUP_QQ}.json"
    fi
  fi

  render_tree "$SEA2_DIR"
  render_tree "$SEA1_DIR"
  render_tree "$ACT_DIR"
  render_tree "$APP_NAPCAT_DIR/config"
  if [ "$WITH_BACKUP" = "1" ]; then
    if [ "${NAPCAT_DEPLOY_MODE:-native}" = "docker" ]; then render_tree /root/napcat/config; else render_tree "$app2/config"; fi
  fi
  chmod 600 "$ACT_DIR/config.env" "$SEA2_DIR/napcat/ops.env" "$SEA2_DIR/napcat/napcat-http.env" 2>/dev/null || true
}
