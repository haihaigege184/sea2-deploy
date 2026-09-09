#!/usr/bin/env bash
# ==========================================================================
# lib/common.sh — 通用日志/颜色/工具函数
# ==========================================================================

C_INFO='\033[1;36m'; C_OK='\033[1;32m'; C_WARN='\033[1;33m'
C_ERR='\033[1;31m'; C_STEP='\033[1;35m'; C_OFF='\033[0m'

log_info() { printf '%b[info]%b %s\n'    "$C_INFO" "$C_OFF" "$*"; }
log_ok()   { printf '%b[ok]%b   %s\n'    "$C_OK"   "$C_OFF" "$*"; }
log_warn() { printf '%b[warn]%b %s\n'    "$C_WARN" "$C_OFF" "$*" >&2; }
log_err()  { printf '%b[err]%b  %s\n'    "$C_ERR"  "$C_OFF" "$*" >&2; }
log_step() { printf '\n%b== %s ==%b\n'   "$C_STEP" "$*"      "$C_OFF"; }

die() { log_err "$*"; exit 1; }

confirm() {
  # confirm 提示文字 [默认y|n]
  local hint="${2:-y}" ans
  if [ "${DEPLOY_YES:-0}" = "1" ] || [ ! -t 0 ]; then
    log_info "自动确认: $1（→ $hint）"; return 0
  fi
  read -r -p "$1 [Y/n] (默认 $hint): " ans || ans=""
  ans="${ans:-$hint}"
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

ask() {
  # ask 变量名 提示文字 默认值  → 结果存入同名变量
  # 若同名变量已预设非空（环境变量传入），跳过提问直接采用 —— 支持非交互部署
  local __var="$1" __prompt="$2" __default="${3:-}" __in
  if [ -n "${!__var:-}" ]; then
    log_info "采用预设 $1=${!__var}"
    return 0
  fi
  if [ -n "$__default" ]; then
    read -r -p "$__prompt [回车=($__default)]: " __in || __in=""
  else
    read -r -p "$__prompt: " __in || __in=""
  fi
  __in="${__in:-$__default}"
  printf -v "$__var" '%s' "$__in"
}

gen_hex() { openssl rand -hex "$(( $1 / 2 ))" 2>/dev/null || head -c 200 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c "$1"; }

http_ok() {
  # http_ok url [期望码片段] → 0/1
  local url="$1" code
  code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 8 "$url" 2>/dev/null || echo 000)"
  [ "$code" != "000" ] && [ "$code" != "502" ] && [ "$code" != "503" ]
}

backup_file() { # backup_file 文件路径 —— 同目录时间戳备份
  local f="$1"
  [ -f "$f" ] || return 0
  cp -a "$f" "$f.bak-$(date +%Y%m%d-%H%M%S)"
}
