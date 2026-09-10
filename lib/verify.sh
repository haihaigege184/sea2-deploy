#!/usr/bin/env bash
# ==========================================================================
# lib/verify.sh — 部署后健康检查
# ==========================================================================

check_http() { # check_http 名称 url
  if http_ok "$2"; then
    log_ok "$1 ✓ ($2)"
    return 0
  else
    log_err "$1 ✗ ($2)"
    FAILS=$((FAILS+1))
    return 1
  fi
}

# _pm2_online <进程名> → 该 pm2 进程是否 online
_pm2_online() {
  pm2 jlist 2>/dev/null | jq -r '.[]? | select(.pm2_env.status=="online") | .name' 2>/dev/null | grep -qx "$1"
}

check_napcat() { # check_napcat 名称 port [pm2进程名]
  local name="$1" port="$2" proc="${3:-}" body code
  body=$(curl -s --connect-timeout 4 --max-time 8 -H "Authorization: Bearer ${NAPCAT_TOKEN}" \
    "http://127.0.0.1:${port}/get_login_info" 2>/dev/null) || body=""
  if [ -n "$body" ]; then
    log_ok "$1 OneBot 应答 ✓ (:${port})"
    return 0
  fi
  # token 校验式探测：403 也说明 HTTP 服务在
  # ⚠ 兜底写在命令替换之外：curl 带 -w 时失败仍输出 "000"，写成 $(... || echo 000)
  #   会拼成 "000000"，!= "000" 成立 → NapCat 未监听也会被判"在线"（假阳性）
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 "http://127.0.0.1:${port}/get_login_info" 2>/dev/null) || code="000"
  if [ "$code" != "000" ]; then
    log_ok "$1 OneBot 在线（鉴权拦截 code=$code，正常）✓ (:${port})"
    return 0
  fi
  # NapCat 未扫码登录时不会绑定 OneBot 端口 —— 这是「账号留空、稍后 WebUI 扫码」流程下的
  # 预期状态，进程还在就不算失败，否则每台新装机都会健康检查告警。
  if [ -n "$proc" ] && _pm2_online "$proc"; then
    log_warn "$1 待扫码登录（进程在线，OneBot :${port} 尚未绑定；扫码后自动生效）"
    return 0
  fi
  log_err "$1 OneBot 无应答 ✗ (:${port})"
  FAILS=$((FAILS+1))
  return 1
}

run_verify() {
  FAILS=0
  log_step "健康检查"
  sleep 3

  [ "${DEPLOY_MODE:-server}" = "server" ] && check_http "激活服务 sea1-activation" "http://127.0.0.1:3457/api/shop/info"
  check_http "主框架 sea2-bot HTTP"     "http://127.0.0.1:13001/"
  check_http "打印服务 print-server"    "http://127.0.0.1:13012/"
  check_http "扫码中间页 sea2-qr"       "http://127.0.0.1:13011/"
  check_napcat "主号原生 NapCat" 4000 sea2-napcat

  if [ "$WITH_BACKUP" = "1" ]; then
    check_napcat "副号原生 NapCat" 3000 sea2-napcat-backup
  fi

  # pm2 进程状态
  local online
  online="$(pm2 jlist 2>/dev/null | jq -r '[.[] | select(.pm2_env.status=="online") | .name] | join(",")' 2>/dev/null || echo '')"
  log_info "pm2 在线: ${online:-无}"

  if [ "$FAILS" -gt 0 ]; then
    log_warn "健康检查有 $FAILS 项失败（新部署 NapCat 未扫码属正常）"
    return 1
  fi
  log_ok "健康检查全部通过"
  return 0
}
