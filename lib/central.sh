#!/usr/bin/env bash
# ==========================================================================
# lib/central.sh — 客户端模式：中央服务端选路 / 连接验证 / 设备试用激活
# ==========================================================================

# 公网/内网自适应种子（隧道域名属公开信息，可随仓库分发；顺序无关，全部参与测速）
# 内网机器会自然命中 10.0.0.11（延迟最低），公网机器命中隧道，无需人工区分。
SEA2_SEED_SERVERS=(
  "http://10.0.0.11:3457"
  "http://sea1.xsian.top"
  "http://sea2.hk1.sian.one"
  "http://sea3.gost.cloudns.ch"
  "http://sea4.gost.nyc.mn"
  "http://sea1bot888.locvps.sian.one"
)

# select_central_server: 测速选最快可达者（公网/内网自适应）
#   ① 探测种子（用户指定 → 内网 → 公网隧道），任一个可达即拿到服务端维护的完整隧道池
#   ② 候选 = 池内公网地址 + masterAddress + 全部种子（去重）
#   ③ 逐个测速取最快；全不可达才报错
#   输出: CENTRAL_SERVER（全局）
select_central_server() {
  if [ "${DEPLOY_MODE:-server}" = "server" ]; then
    CENTRAL_SERVER="http://127.0.0.1:3457"
    return 0
  fi

  local probe=() u pool_json=""
  [ -n "${CENTRAL_SERVER:-}" ] && probe+=("${CENTRAL_SERVER%/}")
  for u in "${SEA2_SEED_SERVERS[@]}"; do probe+=("${u%/}"); done

  # ① 拿隧道池（内网不可达时自动走公网隧道，无需人工指定）
  for u in "${probe[@]}"; do
    [ -n "$u" ] || continue
    pool_json=$(curl -fsSL --connect-timeout 4 --max-time 10 "${u}/api/deploy/tunnels" 2>/dev/null || true)
    if [ -n "$pool_json" ]; then log_info "隧道池来源: $u"; break; fi
  done

  # ② 扩充候选并去重
  local candidates=()
  if [ -n "$pool_json" ]; then
    while IFS= read -r u; do
      [ -n "$u" ] && candidates+=("${u%/}")
    done < <(printf '%s' "$pool_json" | jq -r '.tunnels[]?.publicAddr, .masterAddress? // empty' 2>/dev/null | grep -v '^$' | sort -u)
  else
    log_warn "隧道池接口不可达，改用内置种子地址"
  fi
  for u in "${probe[@]}"; do [ -n "$u" ] && candidates+=("$u"); done

  # 注意：必须分开声明 —— `local -A seen=() uniq=()` 会把 uniq 也声明成关联数组，
  # 导致后续 for 遍历拿到空串（实机验证抓到：日志全是 "测速  → 0ms"）
  local -A seen=()
  local uniq=()
  for u in "${candidates[@]}"; do
    [ -n "$u" ] || continue
    [ -n "${seen[$u]:-}" ] && continue
    seen[$u]=1; uniq+=("$u")
  done

  # ③ 测速取最快
  local best="" best_ms=999999 ms
  for u in "${uniq[@]}"; do
    ms=$(curl -fsSL --connect-timeout 5 --max-time 12 -o /dev/null -w '%{time_total}' "$u/api/shop/info" 2>/dev/null || echo 999999)
    ms=$(printf '%s' "$ms" | awk '{printf "%d", $1*1000}')
    log_info "测速 $u → ${ms}ms"
    if [ "$ms" -lt "$best_ms" ]; then best="$u"; best_ms="$ms"; fi
  done
  if [ -z "$best" ]; then
    die "中央服务端全部候选地址不可达（内网地址与公网隧道均失败）。请检查网络后重跑"
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
