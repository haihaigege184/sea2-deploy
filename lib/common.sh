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

# _read_input <提示> <默认值> → 结果写入 $REPLY
# 关键点：`curl ... | bash` 时 stdin 是管道，read 会立刻 EOF（还会吃掉脚本后续字节），
# 所以一律从 /dev/tty 读；确实没有可用终端（CI/后台）时才回落默认值。
# 能否真正打开控制终端？
# 注意两点（实机踩坑）：
#  ① 不能用 [ -r /dev/tty ] —— 那测的是权限位，无终端时 /dev/tty 仍显示 crw-rw-rw- 恒为真
#  ② 2>/dev/null 必须写在 < /dev/tty 之前 —— bash 从左到右处理重定向，
#     写在后面就吃不到 "No such device or address" 的报错
_tty_ok() { : 2>/dev/null < /dev/tty; }

_read_input() {
  local __prompt="$1" __d="$2" __in=""
  if _tty_ok; then
    if [ -n "$__d" ]; then
      read -r -p "$__prompt [回车=($__d)]: " __in 2>/dev/null < /dev/tty || __in=""
    else
      read -r -p "$__prompt: " __in 2>/dev/null < /dev/tty || __in=""
    fi
  elif [ -n "$__d" ]; then
    log_info "无可用终端，采用默认值: $__prompt = $__d"
  fi
  REPLY="${__in:-$__d}"
}

confirm() {
  # confirm 提示文字 [默认y|n]
  local hint="${2:-y}" ans
  if [ "${DEPLOY_YES:-0}" = "1" ]; then
    log_info "自动确认: $1（→ $hint）"; return 0
  fi
  if ! _tty_ok; then
    log_info "无可用终端，自动确认: $1（→ $hint）"; return 0
  fi
  read -r -p "$1 [Y/n] (默认 $hint): " ans 2>/dev/null < /dev/tty || ans=""
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
  _read_input "$__prompt" "$__default"
  printf -v "$__var" '%s' "$REPLY"
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
