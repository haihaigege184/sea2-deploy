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
    # ⚠ 提示必须自己 printf 到 stderr，绝不能用 read -p + 2>/dev/null：
    #   read -p 的提示也走 stderr，一旦给 read 加 2>/dev/null（本意是吃掉 /dev/tty 打不开的报错），
    #   提示会被一并吞掉 → 向导标题之后一片空白、按键无任何反馈，实机表现为"卡死没后续"。
    if [ -n "$__d" ]; then
      printf '%s [回车=(%s)]: ' "$__prompt" "$__d" >&2
    else
      printf '%s: ' "$__prompt" >&2
    fi
    IFS= read -r __in < /dev/tty || __in=""
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
  # 同 _read_input：提示自己 printf 到 stderr，不给 read 加 2>/dev/null（会吞掉提示）
  printf '%s [Y/n] (默认 %s): ' "$1" "$hint" >&2
  IFS= read -r ans < /dev/tty || ans=""
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

# _valid_http_url <字符串> → 0=合法 http(s) 地址 / 1=非法
# 为什么必须有：用户看不到提示时会把整条命令粘进输入框（实机发生过——
# "中央服务端地址"被写成 `curl -fsSL http://... && bash ...`），
# 而未校验的字符串会被直接拿去拼 URL，造成测速误判、连接校验误通过、客户端心跳 Invalid URL。
_valid_http_url() {
  local u="$1"
  [ -n "$u" ] || return 1
  case "$u" in
    http://*|https://*) ;;
    *) return 1 ;;
  esac
  # 拒绝空白与 shell/URL 危险字符（命令粘贴、变量展开、重定向等一律拦下）
  case "$u" in
    *[[:space:]]*) return 1 ;;
    *[\`\"\'\\]*|*[\;\&\|\<\>]*|*'$'*|*'('*|*')'*|*'{'*|*'}'*) return 1 ;;
  esac
  # 必须含 host（http:// 或 https:// 之后不能直接是 / 或空）
  case "$u" in
    http:///*|https:///*|http://|https://) return 1 ;;
  esac
  return 0
}

http_ok() {
  # http_ok url [期望码片段] → 0/1
  # ⚠ 兜底绝不能写成 code="$(curl ... || echo 000)"：curl 失败时 -w 仍会输出 "000"，
  #   与兜底值拼成 "000\n000" ≠ "000"，校验反而"通过"（实机踩坑）。
  #   正确做法是把 || 放在命令替换之外。
  local url="$1" code
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 8 "$url" 2>/dev/null) || code="000"
  [ "$code" != "000" ] && [ "$code" != "502" ] && [ "$code" != "503" ]
}

backup_file() { # backup_file 文件路径 —— 同目录时间戳备份
  local f="$1"
  [ -f "$f" ] || return 0
  cp -a "$f" "$f.bak-$(date +%Y%m%d-%H%M%S)"
}
