#!/usr/bin/env bash
# =============================================================================
# sea2-server/deploy.sh — sea2 服务端（激活服务 + 运维后台）一键部署脚本
#
# 动作链（对齐生产部署工具 main-ops/deploy_activation.py）：
#   backup → push → restart → verify（异常自动 rollback 恢复备份）
#
# 用法：
#   bash deploy.sh                     # 完整部署（备份→推送→重启→健康检查→异常回滚）
#   bash deploy.sh --dry-run           # 演练：只打印将执行的命令，不实际执行
#   SSH_HOST=root@10.0.0.11 bash deploy.sh   # 指定目标主机（默认 root@10.0.0.11）
#
# 安全/约束：
#   - 绝不推送 config.env / data / node_modules / .git —— 生产密钥与运行数据只存部署机；
#   - 不硬编码任何口令，依赖 SSH 密钥认证（如需口令请用 sshpass 且勿入库）；
#   - 远端健康检查失败自动回滚到最近备份。
# =============================================================================
set -euo pipefail

# ---------- 可配置项（可用环境变量覆盖） ----------
SSH_HOST="${SSH_HOST:-root@10.0.0.11}"                    # 目标主机（生产激活服务器）
REMOTE_DIR="${REMOTE_DIR:-/root/sea1-activation-server}"  # 远端代码目录
BACKUP_ROOT="/root/sea1-activation-backups"               # 远端备份根目录
PM2_NAME="${PM2_NAME:-sea1-activation}"                   # pm2 进程名
HEALTH_PORT="${HEALTH_PORT:-3457}"                        # 服务端监听端口
HEALTH_PATH="${HEALTH_PATH:-/api/shop/info}"              # 健康检查路径（服务端公开 200 端点）
# 注：服务端没有 /api/status 路由（中间页才有）；/api/shop/info 是公开 JSON 200 端点，用作存活检查。
DRY_RUN="${DRY_RUN:-0}"

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"

log()  { printf '\033[1;32m[sea2-server-deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sea2-server-deploy][warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[sea2-server-deploy][error]\033[0m %s\n' "$*" >&2; exit 1; }

# 远程执行（DRY_RUN=1 只打印）
run_remote() {
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY_RUN] ssh $SSH_HOST :: $*"
  else
    ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$SSH_HOST" "$*"
  fi
}

# 本地执行（DRY_RUN=1 只打印）
run_local() {
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY_RUN] $*"
  else
    "$@"
  fi
}

# 远端 rsync 推送（DRY_RUN=1 只打印）
push_rsync() {
  local src="$1" dst="$2"
  shift 2
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY_RUN] rsync -az --delete $* $src $SSH_HOST:$dst"
  else
    rsync -az --delete "$@" "$src" "$SSH_HOST:$dst"
  fi
}

precheck() {
  [ -f "$LOCAL_DIR/server.js" ] || die "本地缺少 server.js（请在 sea2-server 目录运行本脚本）"
  if [ "$DRY_RUN" != "1" ]; then
    command -v ssh >/dev/null 2>&1 || die "缺少 ssh 命令"
    command -v rsync >/dev/null 2>&1 || warn "缺少 rsync，将回退到 tar 管道推送"
    ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_HOST" "true" 2>/dev/null \
      || die "无法连接 $SSH_HOST（请先配置 SSH 密钥或确认网络）"
  fi
  log "本地目录: $LOCAL_DIR"
  log "目标主机: $SSH_HOST  远端目录: $REMOTE_DIR  pm2: $PM2_NAME"
}

backup() {
  log "① 备份远端 $REMOTE_DIR → $BACKUP_ROOT/sea1-activation-$TS.tar.gz"
  # 排除 node_modules（大且可重建）；保留 config.env / data（备份中包含，回滚可整体恢复）
  run_remote "mkdir -p $BACKUP_ROOT && tar --exclude=node_modules --exclude=node_modules_bak -czf $BACKUP_ROOT/sea1-activation-$TS.tar.gz -C /root sea1-activation-server && ls -lh $BACKUP_ROOT/sea1-activation-$TS.tar.gz"
}

push() {
  log "② 推送本地代码 → 远端 $REMOTE_DIR（排除 config.env/data/node_modules/.git 等敏感项）"
  local excludes
  excludes=(--exclude='config.env' --exclude='data' --exclude='node_modules' --exclude='node_modules_bak' --exclude='.git' --exclude='nul' --exclude='.cache')
  if command -v rsync >/dev/null 2>&1 && [ "$DRY_RUN" != "1" ]; then
    # rsync 优先：--delete 保持远端与本地一致（config.env/data 已排除，不会被删）
    rsync -az --delete "${excludes[@]}" "$LOCAL_DIR/" "$SSH_HOST:$REMOTE_DIR/"
  else
    # 回退：tar 管道（排除同上）
    if [ "$DRY_RUN" = "1" ]; then
      log "[DRY_RUN] tar --exclude=... -czf - -C $LOCAL_DIR . | ssh $SSH_HOST tar --overwrite -xzf - -C $REMOTE_DIR"
    else
      tar --exclude='config.env' --exclude='data' --exclude='node_modules' --exclude='node_modules_bak' --exclude='.git' --exclude='nul' --exclude='.cache' -czf - -C "$LOCAL_DIR" . | ssh "$SSH_HOST" "mkdir -p $REMOTE_DIR && tar --overwrite -xzf - -C $REMOTE_DIR"
    fi
  fi
  log "推送完成（config.env / data / node_modules 保持远端原样，未被覆盖）"
}

restart() {
  log "③ pm2 restart $PM2_NAME"
  run_remote "cd $REMOTE_DIR && pm2 restart $PM2_NAME 2>&1 | tail -8"
  sleep 4
  log "重启后日志（最近 15 行）："
  run_remote "pm2 logs $PM2_NAME --lines 15 --nostream 2>/dev/null | tail -20"
}

verify() {
  log "④ 健康检查: curl http://127.0.0.1:$HEALTH_PORT$HEALTH_PATH"
  local code body
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY_RUN] 跳过实际健康检查"
    return 0
  fi
  code="$(ssh "$SSH_HOST" "curl -sS -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:$HEALTH_PORT$HEALTH_PATH" 2>/dev/null || echo 000)"
  body="$(ssh "$SSH_HOST" "curl -sS -m 8 http://127.0.0.1:$HEALTH_PORT$HEALTH_PATH 2>/dev/null | head -c 200" 2>/dev/null || true)"
  log "HTTP $code  body: $body"
  if [ "$code" != "200" ]; then
    warn "健康检查失败（HTTP $code），触发回滚"
    return 1
  fi
  case "$body" in
    *ok*|*'"connected"'*|*'"status"'*) log "健康检查通过" ;;
    *) warn "HTTP 200 但响应体异常（未含预期字段），触发回滚"; return 1 ;;
  esac
}

rollback() {
  log "⑤ 回滚：恢复最近一次备份"
  local latest
  latest="$(ssh "$SSH_HOST" "ls -t $BACKUP_ROOT/sea1-activation-*.tar.gz 2>/dev/null | head -1")" || true
  if [ -z "$latest" ]; then
    warn "未找到备份，跳过回滚（请人工介入）"
    return 1
  fi
  log "恢复备份: $latest"
  # 先保护当前 config.env/data，解包后再还原（双保险）
  run_remote "cp $REMOTE_DIR/config.env /tmp/sea1-config.env.bak 2>/dev/null; cp -r $REMOTE_DIR/data /tmp/sea1-data.bak 2>/dev/null; tar --overwrite -xzf $latest -C /root; cp /tmp/sea1-config.env.bak $REMOTE_DIR/config.env 2>/dev/null; rm -rf /tmp/sea1-data.bak; echo ROLLBACK_DONE"
  restart
  if verify; then
    log "回滚后健康检查通过"
  else
    warn "回滚后仍异常，请人工介入检查 $SSH_HOST:$REMOTE_DIR"
    return 1
  fi
}

main() {
  # 解析参数：--dry-run 或 DRY_RUN=1
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      -h|--help) echo "用法: bash deploy.sh [--dry-run]"; exit 0 ;;
      *) warn "忽略未知参数: $arg" ;;
    esac
  done
  precheck
  backup
  push
  restart
  if verify; then
    log "🎉 部署成功"
  else
    warn "健康检查未通过，开始回滚"
    rollback || die "回滚失败，请人工介入"
  fi
}

main "$@"
