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

check_napcat() { # check_napcat 名称 port —— get_login_info 应答（403/未登录均算服务在）
  local name="$1" port="$2" body
  body="$(curl -s --connect-timeout 4 --max-time 8 -H "Authorization: Bearer ${NAPCAT_TOKEN}" \
    "http://127.0.0.1:${port}/get_login_info" 2>/dev/null || echo '')"
  if [ -n "$body" ]; then
    log_ok "$1 OneBot 应答 ✓ (:${port})"
    return 0
  fi
  # token 校验式探测：403 也说明 HTTP 服务在
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 "http://127.0.0.1:${port}/get_login_info" 2>/dev/null || echo 000)"
  if [ "$code" != "000" ]; then
    log_ok "$1 OneBot 在线（鉴权拦截 code=$code，正常）✓ (:${port})"
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

  check_http "激活服务 sea1-activation" "http://127.0.0.1:3457/api/shop/info"
  check_http "主框架 sea2-bot HTTP"     "http://127.0.0.1:13001/"
  check_http "打印服务 print-server"    "http://127.0.0.1:13012/"
  check_http "扫码中间页 sea2-qr"       "http://127.0.0.1:13011/"
  check_napcat "主号原生 NapCat" 4000

  if [ "$WITH_BACKUP" = "1" ]; then
    check_napcat "副号原生 NapCat" 3000
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
