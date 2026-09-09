#!/usr/bin/env bash
# ==========================================================================
# scripts/pack-from-prod.sh — 从生产机 10.0.0.11 重新打包干净 payload（构建机执行）
#
# 流程：ssh 生产机 tar 流式拉取（排除个人数据/node_modules/QQ二进制）
#       → 解包到 payload/{sea2,sea1,activation}
#       → 脱敏：真实字面量 → __占位符__
#       → 泄漏扫描（发现即失败）
#
# 需要：ssh 免密（ssh-copy-id root@10.0.0.11）或 SSH_KEY 指定私钥
# ==========================================================================
set -euo pipefail

PROD="${PROD:-root@10.0.0.11}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD="$REPO_DIR/payload"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

EXCLUDES=(
  root/sea2/node_modules root/sea2/napcat/QQ root/sea2/napcat/node_modules
  root/sea2/napcat/.config root/sea2/napcat/napcat.log root/sea2/napcat/qr.err
  root/sea2/napcat/backups root/sea2/napcat/ops.env root/sea2/napcat/napcat-http.env
  root/sea2/config.json root/sea2/config root/sea2/data root/sea2/database
  root/sea2/logs root/sea2/backups root/sea2/run root/sea2/webprint
  root/sea2/license.json root/sea2/client-code root/sea2/scripts
  root/sea2/ecosystem.sea2-bot.config.js root/sea2/ecosystem.sea2-print-server.config.js
  root/sea1/node_modules root/sea1/config.json root/sea1/data root/sea1/database
  root/sea1/logs root/sea1/backups root/sea1/license.json root/sea1/client-code
  root/sea1/main-ops root/sea1/licensing/index.js.bak*
  root/sea1-activation-server/node_modules root/sea1-activation-server/config.env
  root/sea1-activation-server/data root/sea1-activation-server/.cache
  root/sea1-activation-server/backups root/sea1-activation-server/tunnel_domain.txt
  root/sea1-activation-server/test
  '*.bak*' '*.bak.*' '*.log' '.git' '_test*'
)

# 脱敏映射
DEIDENT=(
  's/1224720282/__MAIN_QQ__/g'
  's/3878916785/__BACKUP_QQ__/g'
  's/2223932380/__BACKUP_QQ__/g'
  's/382740461/__ADMIN_QQ__/g'
  's/942202891/__PRINT_GROUP__/g'
  's/jDNZrLJBzNJvYNkg/__NAPCAT_TOKEN__/g'
  's/YizBMG-F9rubDCug/__SEA2_WS_TOKEN__/g'
  's/52f906ddb691718f0b2b7ac4e4fe2890f3e3776d47306fe19c9cd29b776b6460/__SEA2_DEVICE_ID__/g'
  's/1533cb4535c714eaac42216b9e9f69cf/__SEA2_OPS_TOKEN__/g'
  's/9ecd0f9b21c8281a225199a0f6ea8817/__WEB_ADMIN_TOKEN__/g'
  's/d7a0bdc5c34045fa9e084bb9a29fd1d89285dbc43ad5b271031507e7831011f4/__MONITOR_TOKEN__/g'
  's/5f0227f78c17a70be8d2b86b7e2de931f0d0f551b8fbf06a28291ed88962bb96/__LICENSE_ADMIN_TOKEN__/g'
  's/9854bd49396e81070aaf6199e1dcb17e1c0633d9dfffc073038faf75713cfcd1/__BOT_NOTIFY_TOKEN__/g'
)

echo "[1/4] 从 $PROD 拉取（排除 ${#EXCLUDES[@]} 项）..."
ssh "$PROD" "tar -C / -czf - $(printf -- "--exclude='%s' " "${EXCLUDES[@]}") root/sea2 root/sea1 root/sea1-activation-server 2>/dev/null" > "$TMP/payload.tar.gz"
[ "$(stat -c%s "$TMP/payload.tar.gz" 2>/dev/null || echo 0)" -gt 1048576 ] || { echo "tarball 异常小"; exit 1; }

echo "[2/4] 解包..."
mkdir -p "$TMP/x" "$PAYLOAD"
tar -xzf "$TMP/payload.tar.gz" -C "$TMP/x"
rm -rf "$PAYLOAD"
mv "$TMP/x/root/sea2"                  "$PAYLOAD/sea2"
mv "$TMP/x/root/sea1"                  "$PAYLOAD/sea1"
mv "$TMP/x/root/sea1-activation-server" "$PAYLOAD/activation"

echo "[3/4] 脱敏..."
find "$PAYLOAD" -type f \( -name '*.js' -o -name '*.json' -o -name '*.sh' -o -name '*.md' -o -name '*.html' -o -name '*.css' -o -name '*.env*' \) -print0 |
  while IFS= read -r -d '' f; do
    sed -i -e "$(printf '%s; ' "${DEIDENT[@]}")" "$f"
  done

echo "[4/4] 泄漏扫描..."
HITS=0
for pat in 1224720282 3878916785 2223932380 382740461 jDNZrLJBzNJvYNkg YizBMG-F9rubDCug liuhai dad2056 15927534728 942202891; do
  while IFS= read -r f; do
    echo "  !! HIT [$pat] -> $f"; HITS=$((HITS+1))
  done < <(grep -rl "$pat" "$PAYLOAD" 2>/dev/null || true)
done
[ "$HITS" -eq 0 ] || { echo "发现 $HITS 处泄漏，禁止入库！"; exit 2; }
echo "OK payload 干净（$(du -sh "$PAYLOAD" | cut -f1)）"
