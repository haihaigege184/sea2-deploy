#!/usr/bin/env bash
# ==========================================================================
# lib/central.sh — 客户端模式：中央服务端选路 / 连接验证 / 设备试用激活
# ==========================================================================

# select_central_server: 从候选地址中测速选最快可达者
#   候选 = 用户输入内网地址(直接优先测) + 服务端 /api/deploy/tunnels 池
#   输出: CENTRAL_SERVER（全局）
select_central_server() {
  local candidates=()
  [ -n "$CENTRAL_SERVER" ] && candidates+=("$CENTRAL_SERVER")
  # 服务端模式兜底：本机
  if [ "${DEPLOY_MODE:-server}" = "server" ]; then
    CENTRAL_SERVER="http://127.0.0.1:3457"
    return 0
  fi
  # 从隧道池拉候选（公开端点，免 token；masterAddress 也可作候选）
  local pool_json pool
  pool_json=$(curl -fsSL --connect-timeout 8 --max-time 20 "${CENTRAL_SERVER%/}/api/deploy/tunnels" 2>/dev/null || true)
  if [ -n "$pool_json" ]; then
    while IFS= read -r pool; do
      [ -n "$pool" ] && candidates+=("$pool")
    done < <(printf '%s' "$pool_json" | jq -r '.tunnels[]?.publicAddr, .masterAddress? // empty' 2>/dev/null | grep -v '^$' | sort -u)
  fi
  # 测速：GET /api/shop/info 计时，取最快成功者
  local best="" best_ms=999999 u ms
  for u in "${candidates[@]}"; do
    [ -n "$u" ] || continue
    u="${u%/}"
    ms=$(curl -fsSL --connect-timeout 5 --max-time 12 -o /dev/null -w '%{time_total}' "$u/api/shop/info" 2>/dev/null || echo 999999)
    ms=$(printf '%s' "$ms" | awk '{printf "%d", $1*1000}')
    log_info "测速 $u → ${ms}ms"
    if [ "$ms" -lt "$best_ms" ]; then best="$u"; best_ms="$ms"; fi
  done
  if [ -z "$best" ]; then
    die "中央服务端全部候选地址不可达（内网地址与隧道池均失败）。请检查网络或主地址后重跑"
  fi
  CENTRAL_SERVER="$best"
  log_ok "选定中央服务端: $CENTRAL_SERVER (${best_ms}ms)"
}

# verify_central: 连接验证（部署硬门禁）
verify_central() {
  log_step "验证中央服务端连接"
  if ! http_ok "${CENTRAL_SERVER%/}/api/shop/info"; then
    die "中央服务端不可达: $CENTRAL_SERVER（客户端模式必须先连通服务端）"
  fi
  log_ok "中央服务端连通: $CENTRAL_SERVER"
}

# activate_device_trial: 设备维度试用激活（查询即授予）+ 上线确认
activate_device_trial() {
  log_step "设备注册与试用激活"
  local mid resp days
  mid="$("$SEA2_DIR/licensing/machineId" 2>/dev/null || true)"
  if [ -z "$mid" ]; then
    # 与 bot licensing 同源：HMAC(machine-id 文件, seed)；此处直接复用 client-agent 的派生逻辑
    mid=$(node -e "const c=require('crypto'),fs=require('fs');let p='/etc/sea1-x86/machine-id';let v=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim():'';if(!v){v=require('crypto').randomUUID();fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,v,{mode:0o600})}const seed='sea1-machine-seed-v1-replace-in-obfuscated-build';const h=/^[0-9a-f]{64}$/i.test(v)?v.toLowerCase():c.createHmac('sha256',seed).update(v,'utf8').digest('hex');process.stdout.write(h)" 2>/dev/null || true)
  fi
  [ -n "$mid" ] || die "machine_id 派生失败"
  echo "$mid" > /tmp/.sea2-machine-id
  resp=$(curl -fsSL --connect-timeout 8 --max-time 20 -X POST -H 'Content-Type: application/json' \
    -d "{\"machine_id\": \"$mid\"}" "${CENTRAL_SERVER%/}/api/trial/status" 2>/dev/null || true)
  if printf '%s' "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
    days=$(printf '%s' "$resp" | jq -r '(.remaining_ms // 0) / 86400000 | floor' 2>/dev/null || echo '?')
    log_ok "设备已在中央服务端注册（machine_id=${mid:0:12}…），试用已激活"
  else
    die "设备试用激活失败：$resp（服务端可达但接口异常）"
  fi
  log_ok "设备维度试用就绪 — 首触账号维度试用将由 vip 插件自动识别"
}
