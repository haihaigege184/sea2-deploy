#!/bin/bash
# 启动 cloudflared 临时隧道，反代本机 3457，并把域名写入 tunnel_domain.txt
# 供激活服务器读取 PUBLIC_BASE_URL 拼接支付宝 notify_url
set -e
TUNNEL_DIR=/root/sea1-activation-server
DOMAIN_FILE=$TUNNEL_DIR/tunnel_domain.txt
LOG=$TUNNEL_DIR/tunnel.log
echo "[$(date)] 启动隧道..." >> $LOG
# 后台运行 cloudflared，输出含域名
/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:3457 --no-autoupdate >> $LOG 2>&1 &
CF_PID=$!
echo $CF_PID > $TUNNEL_DIR/tunnel.pid
# 等待并抓取分配的 trycloudflare 域名
for i in $(seq 1 30); do
  DOMAIN=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' $LOG | head -1)
  if [ -n "$DOMAIN" ]; then break; fi
  sleep 1
done
if [ -z "$DOMAIN" ]; then
  echo "[$(date)] 错误: 未能获取隧道域名" >> $LOG
  exit 1
fi
echo "$DOMAIN" > $DOMAIN_FILE
echo "[$(date)] 隧道域名: $DOMAIN" >> $LOG
# 写入/更新激活服务器环境变量供 notify_url 使用
pm2 set sea1-activation env.PUBLIC_BASE_URL="$DOMAIN" 2>/dev/null || true
pm2 restart sea1-activation 2>/dev/null || true
echo "[$(date)] 已设置 PUBLIC_BASE_URL 并重启激活服务器" >> $LOG
