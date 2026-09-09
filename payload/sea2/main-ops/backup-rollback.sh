#!/usr/bin/env bash
# backup-rollback.sh — 主服务器(X86) 备份优先 / 回滚 (tar 版, 无需 rsync)
# 真实路径: /root/sea1 (bot+gateway) / /root/sea1-activation-server (:3457) / /root/activation-server (:3456 旧)
# 设计: 整树 tar 快照(排除 node_modules 以提速; 回滚后自动 npm install 还原依赖);
#       含 license.json / config.json / licensing/public.key / etc/sea1 关键资产; 含 pm2 快照。
set -uo pipefail
BACKUP_ROOT="/root/sea1-backups"
DIRS=("/root/sea1" "/root/sea1-activation-server" "/root/activation-server")
PM2_APPS=("sea1-bot" "sea1-activation" "activation-server")
log(){ echo "[$(date '+%F %T')] $*"; }
die(){ echo "[FATAL] $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "必须以 root 运行"
command -v tar >/dev/null 2>&1 || die "未找到 tar"
command -v pm2 >/dev/null 2>&1 || die "未找到 pm2"

ts=$(date +%Y%m%d-%H%M%S)
tag="bak-$ts"; out="$BACKUP_ROOT/$tag"; mkdir -p "$out"

backup(){
  log "== 备份 -> $out =="
  for d in "${DIRS[@]}"; do
    if [ -d "$d" ]; then
      # 注意: --exclude 必须放在源路径之前 (GNU tar 位置敏感)
      if tar -czf "$out/$(basename "$d").tar.gz" --exclude=node_modules -C "$(dirname "$d")" "$(basename "$d")"; then
        local n; n=$(tar -tzf "$out/$(basename "$d").tar.gz" 2>/dev/null | wc -l)
        log "已备份 $d ($(basename "$d").tar.gz, 条目数=$n, 排除 node_modules)"
      else
        log "WARN 备份失败: $d"
      fi
    else
      log "跳过(不存在): $d"
    fi
  done
  # 关键小文件(凭证/公钥/机器码)单独打包, 仅打包存在的文件, 缺失不报错
  local exfiles=()
  for f in /root/sea1/licensing/public.key /root/sea1/license.json /root/sea1/config.json /etc/sea1/machine-id /etc/sea1/trial.json; do
    [ -e "$f" ] && exfiles+=("$f")
  done
  if [ ${#exfiles[@]} -gt 0 ]; then
    tar -czf "$out/extras.tar.gz" -C / "${exfiles[@]#/}" \
      && log "已备份 extras(${#exfiles[@]} 个文件: 公钥/license/config/机器码)" \
      || log "WARN extras 打包失败"
  else
    log "WARN 无 extras 文件可备份"
  fi
  # pm2 运行时快照
  pm2 dump >/dev/null 2>&1 || true
  cp -a "$HOME/.pm2/dump.pm2" "$out/pm2-dump.pm2" 2>/dev/null || true
  pm2 jlist > "$out/pm2-jlist.json" 2>/dev/null || true
  echo "$tag" > "$BACKUP_ROOT/latest"; echo "$tag" > "$out/TAG"
  log "备份完成: $tag"
  du -sh "$out" 2>/dev/null
  echo "$tag"
}

restore_deps(){
  for d in "${DIRS[@]}"; do
    if [ -d "$d" ] && [ -f "$d/package.json" ]; then
      ( cd "$d" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 && log "deps ok: $d" ) \
        || log "WARN npm install 跳过/失败: $d (已有 node_modules 可能可用)"
    fi
  done
}

rollback(){
  local t="${1:-$(cat "$BACKUP_ROOT/latest" 2>/dev/null)}"; [ -n "$t" ] || die "无可用备份"
  local o="$BACKUP_ROOT/$t"; [ -d "$o" ] || die "备份不存在: $o"
  log "== 回滚 -> $t =="
  for d in "${DIRS[@]}"; do
    if [ -f "$o/$(basename "$d").tar.gz" ]; then
      tar -xzf "$o/$(basename "$d").tar.gz" -C "$(dirname "$d")" \
        && log "已还原 $d" || log "WARN 还原失败: $d"
    fi
  done
  [ -f "$o/extras.tar.gz" ] && tar -xzf "$o/extras.tar.gz" -C / && log "已还原 extras"
  restore_deps
  for a in "${PM2_APPS[@]}"; do pm2 restart "$a" >/dev/null 2>&1 || true; done
  pm2 save >/dev/null 2>&1 || true
  log "回滚完成: $t"
}

status(){
  pm2 list 2>/dev/null
  echo "--- 关键端口 ---"
  ss -ltnp 2>/dev/null | grep -E '3457|3456|9092|13000' || echo "(无匹配端口)"
  echo "--- 雷① 公钥比对 ---"
  python3 - <<'PY'
import json,os
ks="/root/sea1-activation-server/data/keys.json"
pk="/root/sea1/licensing/public.key"
def norm(p): return "".join(p.split())
if os.path.exists(ks) and os.path.exists(pk):
    srv=norm(json.load(open(ks)).get("publicKey",""))
    cli=norm(open(pk).read())
    print("服务端公钥字节:",len(srv),"| 客户端公钥字节:",len(cli))
    print("匹配:", "YES (雷①未触发)" if srv==cli else "NO (雷①命中, 需同步公钥)")
else:
    print("keys.json 或 public.key 缺失")
PY
}

case "${1:-status}" in
  backup)   backup;;
  rollback) shift; rollback "$@";;
  status)   status;;
  *) die "用法: $0 {backup|rollback [tag]|status}";;
esac
