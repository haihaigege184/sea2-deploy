#!/usr/bin/env bash
# ==========================================================================
# lib/central.sh — 客户端模式：中央服务端选路 / 连接验证 / 设备试用激活
# ==========================================================================

# 公网/内网自适应种子：真实地址仅用于内部通信，
# 日志/错误/完成页一律经 endpoint_text 显示为「线路N」（需求：部署日志不得暴露中央接口）。
# 顺序即编号：SEA2_SEED_SERVERS 第 1 项 = 线路1，与 bootstrap.sh 的 SEA2_NODES 保持一致。
SEA2_SEED_SERVERS=(
  "http://10.0.0.11:3457"
  "http://sea1.xsian.top"
  "http://sea2.hk1.sian.one"
  "http://sea3.gost.cloudns.ch"
  "http://sea4.gost.nyc.mn"
  "http://sea1bot888.locvps.sian.one"
)

# select_central_server: 测速选最快可达者（公网/内网自适应）
#   ① 探测种子（用户指定 → 内网 → 公网隧道），任一个可达即拿到服务端维护的完整线路池
#   ② 候选 = 池内线路 + 全部种子（去重）
#   ③ 逐个测速取最快；全不可达才报错
#   输出: CENTRAL_SERVER（全局，真实地址，仅内部使用）
select_central_server() {
  if [ "${DEPLOY_MODE:-server}" = "server" ]; then
    CENTRAL_SERVER="http://127.0.0.1:3457"
    return 0
  fi

  local probe=() u pool_json=""
  # 用户指定的地址先过格式校验：非法（例如误粘整条命令）直接丢弃并回退自动选路
  if [ -n "${CENTRAL_SERVER:-}" ]; then
    if _valid_http_url "$CENTRAL_SERVER"; then
      probe+=("${CENTRAL_SERVER%/}")
    else
      # 不回显用户输入：那多半是误粘的命令（含地址/换行），回显等于把接口地址打进日志
      log_warn "接入线路地址非法（输入不是合法 URL）→ 已忽略，改为自动测速选路"
      CENTRAL_SERVER=""
    fi
  fi
  # 先给全部种子按固定顺序预编号 →「线路N」与具体地址一一对应且跨次运行稳定
  for u in "${SEA2_SEED_SERVERS[@]}"; do probe+=("${u%/}"); done
  for u in "${probe[@]}"; do if [ -n "$u" ]; then line_label "$u" >/dev/null; fi; done

  # ① 拿线路池（内网不可达时自动走公网隧道，无需人工指定）
  local raw=""
  for u in "${probe[@]}"; do
    [ -n "$u" ] || continue
    raw=$(curl -fsSL --connect-timeout 4 --max-time 10 "${u}/api/deploy/tunnels" 2>/dev/null) || raw=""
    # 必须确认是真的线路池 JSON，而不是任意字符串（否则会被当成有效池继续用）
    if [ -n "$raw" ] && printf '%s' "$raw" | jq -e '.tunnels' >/dev/null 2>&1; then
      pool_json="$raw"; log_info "从 $(endpoint_text "$u") 获取线路列表"; break
    fi
  done

  # ② 扩充候选并去重
  local candidates=()
  if [ -n "$pool_json" ]; then
    while IFS= read -r u; do
      [ -n "$u" ] && candidates+=("${u%/}")
    done < <(printf '%s' "$pool_json" | jq -r '.tunnels[]?.publicAddr, .masterAddress? // empty' 2>/dev/null | grep -v '^$' | sort -u)
  else
    log_warn "线路列表接口不可达，改用内置线路"
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
    # 池里新出现的线路也要先编号，否则 endpoint_text 认不出它 → 日志会漏出真实地址
    line_label "$u" >/dev/null
  done

  # ③ 测速取最快
  # ⚠ 兜底绝不能写成 ms=$(curl ... || echo 999999)：curl 失败时 -w 仍输出 "0.000000"，
  #   与兜底值拼成 "0.000000999999"，awk 取首字段得 0ms → 不可达地址被误判为"最快"并选中
  #   （实机踩坑：整条 curl 命令被当成中央地址后，测速显示 0ms 且一举选中）。
  #   正确做法：先判 curl 退出码，失败直接跳过。
  local best="" best_ms=999999 ms t
  for u in "${uniq[@]}"; do
    t=$(curl -fsSL --connect-timeout 5 --max-time 12 -o /dev/null -w '%{time_total}' "$u/api/shop/info" 2>/dev/null) || t=""
    if [ -z "$t" ]; then
      log_info "测速 $(endpoint_text "$u") → 不可达，跳过"
      continue
    fi
    ms=$(printf '%s' "$t" | awk '{printf "%d", $1*1000}')
    case "$ms" in ''|*[!0-9]*) log_info "测速 $(endpoint_text "$u") → 响应异常，跳过"; continue ;; esac
    log_info "测速 $(endpoint_text "$u") → ${ms}ms"
    if [ "$ms" -lt "$best_ms" ]; then best="$u"; best_ms="$ms"; fi
  done
  if [ -z "$best" ]; then
    die "所有接入线路均不可达（内网直连与公网线路全部失败）。请检查网络后重跑"
  fi
  # 最终兜底：只有确定为合法地址才允许写回，防止脏值流入配置渲染
  _valid_http_url "$best" || die "内部错误：选出的接入线路非法"
  CENTRAL_SERVER="$best"
  log_ok "选定接入线路: $(endpoint_text "$CENTRAL_SERVER")（延迟 ${best_ms}ms）"
}

# verify_central: 连接验证（部署硬门禁）
# 不只判 HTTP 可达，还要确认真是激活服务（接口返回 ok=true），避免脏地址/错误站点被判"连通"
verify_central() {
  log_step "验证接入线路连接"
  _valid_http_url "${CENTRAL_SERVER:-}" || die "接入线路地址非法（内部错误）"
  local resp
  resp=$(curl -fsSL --connect-timeout 6 --max-time 15 "${CENTRAL_SERVER%/}/api/shop/info" 2>/dev/null) || resp=""
  if ! printf '%s' "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
    die "接入线路校验失败: $(endpoint_text "$CENTRAL_SERVER")（服务未正常应答，请稍后重跑）"
  fi
  log_ok "接入线路连通正常: $(endpoint_text "$CENTRAL_SERVER")"
  step_done
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
  _valid_http_url "${CENTRAL_SERVER:-}" || die "中央服务端地址非法: ${CENTRAL_SERVER:-<空>}"
  resp=$(curl -fsSL --connect-timeout 8 --max-time 20 -X POST -H 'Content-Type: application/json' \
    -d "{\"machine_id\": \"$mid\"}" "${CENTRAL_SERVER%/}/api/trial/status" 2>/dev/null) || resp=""
  if printf '%s' "$resp" | jq -e '.ok == true' >/dev/null 2>&1; then
    days=$(printf '%s' "$resp" | jq -r '(.remaining_ms // 0) / 86400000 | floor' 2>/dev/null || echo '?')
    log_ok "设备已在中央服务端注册（machine_id=${mid:0:12}…），试用已激活"
  else
    die "设备试用激活失败：$resp（服务端可达但接口异常）"
  fi
  log_ok "设备维度试用就绪 — 首触账号维度试用将由 vip 插件自动识别"
}
