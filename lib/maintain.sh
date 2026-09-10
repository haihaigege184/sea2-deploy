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
  local n; _read_input "选择 [1-5]" "1"; n="$REPLY"
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

# ==========================================================================
# 恢复初始系统状态（卸载全部 SEA2 组件，便于用户自主重新跑部署）
# ==========================================================================
# 与 install.sh 的重装判定对齐：清掉 $SEA2_DIR（含 .sea2-deploy-complete 标记）后，
# 下次运行 install.sh 必然走"全新部署向导"而不再进维护菜单。
#
# 刻意保留（不影响"全新设备"判定，且重装可省大量时间）：
#   · node / npm / pm2 工具链     —— 重装 install_pm2 秒过
#   · CUPS 服务与已配打印机       —— 属系统硬件配置
#   · docker 引擎与已拉取镜像     —— 拉镜像慢，保留不影响重装
#   · /root/sea2-deploy 安装器目录 —— 本脚本正在运行，删除会导致 bash 读不到后续字节
# 严禁误碰：
#   · /root/activation-server（老 SEA 项目 :3456，与本系统无关）
M_RESET_DIRS="/root/sea2 /root/sea1 /root/sea1-activation-server /root/sea1napcat /root/napcat /app/napcat /app/napcat2"
# 设备指纹独立列出：一并清理才叫"全新设备"（否则重装沿用旧 machine-id / 旧授权码）
M_RESET_FINGERPRINT="/etc/sea1-x86"
M_RESET_FILES="/root/.sea2-deploy-extract /root/sea2-deploy.tar.gz /tmp/sea2.sh /tmp/sea2-boot.sh"
M_RESET_PM2="sea2-bot sea1-bot sea2-watchdog sea2-print-server sea2-qr sea2-napcat sea2-napcat-backup sea1-activation sea1-client"
M_RESET_PORTS="3457 4000 3000 6100 6099 13000 13001 13011 13012"

# 强门禁：破坏性操作不接受回车/默认值，必须显式输入 RESET；
# 也刻意不吃 DEPLOY_YES=1（防止 --yes 顺带触发清库），只认专用变量。
_reset_confirm() {
  if [ "${MAINT_RESET_CONFIRM:-}" = "RESET" ]; then
    log_warn "已通过 MAINT_RESET_CONFIRM=RESET 预设确认（非交互模式）"
    return 0
  fi
  if ! _tty_ok; then
    log_err "无可用交互终端：拒绝执行重置。确需非交互执行请显式设置 MAINT_RESET_CONFIRM=RESET"
    return 1
  fi
  printf '请输入 RESET（全大写）确认卸载；其他任何输入都会取消: ' >&2
  local ans; IFS= read -r ans < /dev/tty || ans=""
  [ "$ans" = "RESET" ]
}

_reset_backup() { # _reset_backup <目标tar.gz>
  local out="$1" p items=()
  for p in "$M_RESET_FINGERPRINT" "$SEA2_DIR/config.json" "$SEA2_DIR/license.json" \
           "$SEA2_DIR/client-code" "$SEA2_DIR/config/machine-id" \
           "$SEA1_DIR/config.json" "$ACT_DIR/config.env"; do
    [ -e "$p" ] && items+=("$p")
  done
  [ ${#items[@]} -gt 0 ] || { log_info "无可备份的配置/指纹，跳过备份"; return 0; }
  tar -czf "$out" "${items[@]}" 2>/dev/null || { log_err "备份失败（继续执行卸载）"; return 0; }
  chmod 600 "$out" 2>/dev/null || true
  log_ok "已备份关键配置与设备指纹 → $out（tar 内为去掉前导 / 的相对路径，恢复用 tar -xzf $out -C /）"
}

maint_reset() {
  log_step "恢复初始系统状态（卸载 SEA2 全部组件）"
  log_warn "⚠ 此操作不可撤销：将停止服务并删除全部 SEA2 程序目录、设备指纹与登录会话。"
  log_warn "⚠ 仅适用于【客户端/测试机】。生产主机 10.0.0.11 请勿使用本功能。"

  local p found=0
  echo
  log_info "卸载清单（仅列出本机实际存在的项）："
  for p in $M_RESET_DIRS $M_RESET_FINGERPRINT $M_RESET_FILES; do
    [ -e "$p" ] && { echo "    · $p"; found=1; }
  done
  echo "    · pm2 服务栈 + 开机自启 + 守护进程（$M_RESET_PM2）"
  echo "    · docker 容器 napcat（若存在）"
  echo "    · NapCat QQ 登录会话（⚠ 重装后需重新扫码）"
  echo "    · /root/.pm2 日志与进程快照"
  echo "    · 释放端口：$M_RESET_PORTS"
  echo
  log_info "刻意保留：node/npm/pm2 工具链、CUPS 打印机服务、docker 引擎与镜像、安装器 /root/sea2-deploy"

  if [ "$found" = "0" ] && ! command -v pm2 >/dev/null 2>&1; then
    log_warn "未发现已安装的 SEA2 组件，无需重置"
    return 0
  fi

  echo
  _reset_confirm || { log_warn "已取消（未做任何变更）"; return 0; }

  # ---- 备份（默认做，可用 MAINT_RESET_KEEP_BACKUP=0 关闭）----
  local bk="/root/sea2-reset-backup-$(date +%Y%m%d-%H%M%S).tar.gz" do_bk=1
  if [ "${MAINT_RESET_KEEP_BACKUP:-1}" = "0" ]; then
    do_bk=0
  elif _tty_ok && [ -z "${MAINT_RESET_CONFIRM:-}" ]; then
    confirm "是否先把配置/设备指纹备份到 $bk ?" "y" || do_bk=0
  fi
  [ "$do_bk" = "1" ] && _reset_backup "$bk"

  # ---- ① 停服务 + 解除开机自启 ----
  log_step "停止服务并解除开机自启"
  if command -v pm2 >/dev/null 2>&1; then
    # pm2 delete 多名字遇缺失会中止整条 → 逐名删除
    for _n in $M_RESET_PM2; do pm2 delete "$_n" >/dev/null 2>&1 || true; done
    pm2 save --force >/dev/null 2>&1 || true          # 清空进程快照，防 resurrect 复活
    pm2 unstartup systemd -u root --hp /root >/dev/null 2>&1 || true
    pm2 kill >/dev/null 2>&1 || true                  # 最后做：kill 之后不再调用 pm2（会重新拉起守护）
  fi
  systemctl disable pm2-root >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/pm2-root.service >/dev/null 2>&1 || true
  systemctl daemon-reload >/dev/null 2>&1 || true
  log_ok "pm2 栈已停止，开机自启已解除"

  # ---- ② docker 副号容器 ----
  if command -v docker >/dev/null 2>&1; then
    docker rm -f napcat >/dev/null 2>&1 || true
  fi

  # ---- ③ 兜底：清游离进程（非 pm2 直接拉起的 node/qq）----
  # 模式尽量精确到具体入口文件：`pkill -f /root/sea2/` 这类宽模式会误伤
  # 命令行里恰好含该路径的无关进程（如运维同学正在执行的 shell）。
  local _pat
  for _pat in "$SEA2_DIR/sea.js" "$SEA2_DIR/napcat/run.sh" "$SEA2_DIR/napcat/run-backup.sh" \
              "$SEA2_DIR/napcat/QQ/qq" "$SEA2_DIR/client-agent/client-agent.js" \
              "$SEA1_DIR/sea.js" "$ACT_DIR/server.js" "/app/napcat/napcat.mjs" "/app/napcat2"; do
    pkill -f "$_pat" >/dev/null 2>&1 || true
  done
  sleep 1

  # ---- ④ 删除目录与文件 ----
  log_step "删除程序目录与设备指纹"
  for p in $M_RESET_DIRS $M_RESET_FINGERPRINT $M_RESET_FILES; do
    [ -e "$p" ] || continue
    if rm -rf "$p" 2>/dev/null; then log_ok "已删除 $p"; else log_err "删除失败 $p（可能被占用）"; fi
  done
  if [ -e /root/.pm2 ]; then
    rm -rf /root/.pm2 2>/dev/null && log_ok "已删除 /root/.pm2（日志与进程快照）" || log_warn "删除 /root/.pm2 失败（可忽略）"
  fi

  # ---- ⑤ 复核 ----
  log_step "复核"
  local left=0
  for p in $M_RESET_DIRS $M_RESET_FINGERPRINT $M_RESET_FILES; do
    [ -e "$p" ] && { log_err "仍存在: $p"; left=1; }
  done
  if pgrep -f 'PM2.*God Daemon' >/dev/null 2>&1; then
    log_err "pm2 守护进程仍在运行"; left=1
  else
    log_ok "pm2 守护进程已停止"
  fi
  local occ="" busy="" _pp
  if command -v ss >/dev/null 2>&1; then
    occ="$(ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ')"
  fi
  for _pp in $M_RESET_PORTS; do
    case " $occ " in *" $_pp "*) busy="$busy $_pp" ;; esac
  done
  if [ -n "$busy" ]; then
    log_warn "以下端口仍被占用:$busy（可能是残留进程或其它服务，建议 reboot 后再部署）"; left=1
  else
    log_ok "端口已全部释放（$M_RESET_PORTS）"
  fi

  echo
  if [ "$left" = "0" ]; then
    log_ok "本机已恢复初始状态，可直接重新部署"
  else
    log_warn "部分条目未清理干净，见上方 err/warn（多为残留进程占用，建议 reboot）"
  fi
  log_info "保留项：node/npm/pm2 工具链、CUPS、docker 引擎与镜像、安装器 /root/sea2-deploy"
  echo
  log_info "重新部署（账号可留空，装完到 WebUI 扫码登录）:"
  echo "    curl -fsSL http://sea1.xsian.top/downloads/bootstrap.sh -o /tmp/sea2.sh && bash /tmp/sea2.sh"

  # 交互模式下可直接续跑全新部署（非交互/--yes 不自动重装，避免意外）
  if _tty_ok && [ -z "${MAINT_RESET_CONFIRM:-}" ] && [ "${DEPLOY_YES:-0}" != "1" ]; then
    echo
    if confirm "现在立即重新部署（重新走全新安装向导）?" "y"; then
      exec bash "${REPO_DIR:-/root/sea2-deploy}/install.sh"
    fi
  fi
  return 0
}

maint_menu() {
  while true; do
    echo
    echo "======== SEA2 维护菜单 ========"
    echo "  1) 状态总览          2) 重启服务栈"
    echo "  3) 查看日志          4) 健康检查"
    echo "  5) 更新代码(保留配置) 6) 配置文件说明"
    echo "  7) 恢复初始状态(卸载全部,可重装)"
    echo "  0) 退出"
    # 无交互终端（curl|bash 管道/后台）时直接退出菜单，避免 read 持续 EOF 导致空转刷屏
    if ! _tty_ok; then
      log_warn "无可用交互终端，退出维护菜单（如需操作请在本地终端重新执行）"
      return 0
    fi
    local n; _read_input "选择" ""; n="$REPLY"
    case "$n" in
      1) maint_status ;;
      2) maint_restart ;;
      3) maint_logs ;;
      4) maint_check ;;
      5) maint_update ;;
      6) maint_config ;;
      7|reset) maint_reset ;;
      0|q|Q|"") return 0 ;;
      *) log_warn "无效选择" ;;
    esac
  done
}
