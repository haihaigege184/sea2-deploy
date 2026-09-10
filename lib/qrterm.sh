#!/usr/bin/env bash
# ==========================================================================
# lib/qrterm.sh — 在终端直接渲染可扫二维码（部署完成页引导用户扫码登录）
#
# 设计：
#   · 复用中间页(qr-server)已安装的 `qrcode` 依赖，不额外引入任何软件包；
#   · 优先用 qrcode 的 type:'terminal'（ANSI 半角块码，深浅色终端均可扫）；
#   · 任何环节失败都静默降级，由调用方打印链接兜底 —— 绝不因二维码渲染失败
#     而中断部署（部署已完成，这只影响引导体验）。
# ==========================================================================

# _find_qrcode_module → 打印含 qrcode 的 node_modules 目录（找不到则返回 1）
_find_qrcode_module() {
  local d
  for d in \
    "${SEA2_DIR:-/root/sea2}/napcat/node_modules" \
    "${SEA2_DIR:-/root/sea2}/node_modules" \
    /app/napcat/node_modules \
    /usr/lib/node_modules \
    /usr/local/lib/node_modules ; do
    if [ -d "$d/qrcode" ]; then printf '%s' "$d"; return 0; fi
  done
  return 1
}

# print_terminal_qr <内容> → 0=已打印 / 1=不可用（调用方降级为链接）
print_terminal_qr() {
  local text="$1" node_bin mod
  [ -n "$text" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node_bin="$(command -v node)"
  mod="$(_find_qrcode_module)" || return 1

  NODE_PATH="$mod" "$node_bin" -e '
    const QRCode = require("qrcode");
    QRCode.toString(process.argv[1], { type: "terminal", small: true, errorCorrectionLevel: "M" },
      (e, s) => { if (e) { process.exit(1); } process.stdout.write(s); });
  ' "$text" 2>/dev/null
}

# qr_or_link <标题> <二维码内容> [展示链接]
#   能渲染则打印二维码 + 链接；不能则只打印链接。始终返回 0。
qr_or_link() {
  local title="$1" payload="$2" link="${3:-$2}"
  printf '\n   %s\n' "$title"
  if print_terminal_qr "$payload"; then
    printf '   %s\n' "$link"
  else
    printf '     %s\n' "$link"
    printf '     %b（终端二维码渲染不可用，请用手机浏览器直接打开上面的链接；\n' "$C_DIM"
    printf '      或在本机浏览器访问该链接，页面上的固定二维码同样可扫）%b\n' "$C_OFF"
  fi
}
