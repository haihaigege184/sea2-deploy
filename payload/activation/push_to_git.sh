#!/usr/bin/env bash
# =============================================================================
# sea2-server/push_to_git.sh — sea2 服务端推送私有仓脚本（force push 只留最新版）
#
# 动作：
#   git init(fresh, 单分支 main) → add → commit(注明版本) → remote add origin
#   → git push -f origin main（删除旧历史，只留最新版）
#
# 用法：
#   REMOTE_URL=git@github.com:haihaigege184/sea2-server.git bash push_to_git.sh
#   REMOTE_URL=https://github.com/haihaigege184/sea2-server.git bash push_to_git.sh
#
# 说明：
#   - REMOTE_URL 必填（实际推哪个仓由主理人/用户最终确定）；
#   - 推送前自动做敏感预检：关键敏感路径必须被 .gitignore 忽略，否则中止；
#   - 未配置全局 git 身份时，脚本设置 local 占位身份（README 有说明，可自行改）；
#   - force push 会删除远端旧历史，仅保留本次提交（符合「只留最新版」要求）。
# =============================================================================
set -euo pipefail

REMOTE_URL="${REMOTE_URL:-}"
COMMIT_MSG="${COMMIT_MSG:-sea2-server: 激活服务 + 运维后台（sea2 商用 x86_64/arm64 客户端服务端）T04 整理}"
GIT_NAME="${GIT_NAME:-sea2-ops}"
GIT_EMAIL="${GIT_EMAIL:-sea2-ops@local.invalid}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

log()  { printf '\033[1;32m[push-to-git]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[push-to-git][error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 参数校验 ----------
[ -n "$REMOTE_URL" ] || die "必须提供 REMOTE_URL（如 REMOTE_URL=git@github.com:haihaigege184/sea2-server.git）"
command -v git >/dev/null 2>&1 || die "缺少 git 命令"

# ---------- 1. 敏感预检（硬性护栏） ----------
log "敏感预检：确认以下路径均被 .gitignore 忽略……"
SENSITIVE_PATHS=(
  "config.env"
  "data/keys.json"
  "node_modules"
  "server_keys.json"
  "test_license.json"
  "nul"
  "*.bak"
)
for p in "${SENSITIVE_PATHS[@]}"; do
  if git check-ignore --quiet "$p" 2>/dev/null; then
    log "  ✔ 已忽略: $p"
  else
    # data/ 目录本身可能不存在；存在但未被忽略才算失败
    if [ -e "$p" ]; then
      die "敏感路径未被忽略: $p —— 请先修正 .gitignore，禁止入库！"
    else
      log "  ✔ 路径不存在（无需忽略）: $p"
    fi
  fi
done
log "敏感预检通过 ✅"

# ---------- 2. fresh init（单分支 main） ----------
log "git init（fresh，单分支 main）"
rm -rf .git
git init -b main
git config user.name "$GIT_NAME"
git config user.email "$GIT_EMAIL"

# ---------- 3. add + commit ----------
git add -A
if git diff --cached --quiet; then
  die "没有可提交内容（暂存区为空），中止"
fi
log "提交: $COMMIT_MSG"
git commit -m "$COMMIT_MSG"

# ---------- 4. remote + force push ----------
log "添加远端: origin = $REMOTE_URL"
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"

log "force push → origin main（删除旧历史，只留最新版）"
git push -f origin main

log "🎉 推送完成。远端 main 已更新为最新版（旧历史已清除）"
log "如需设置全局 git 身份（可选）："
log "  git config --global user.name '你的名字'"
log "  git config --global user.email '你的邮箱'"
