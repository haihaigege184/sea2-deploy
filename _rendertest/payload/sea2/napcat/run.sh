#!/bin/bash
# 原生 napcat 启动器（SEA2 专用二进制 QQ + napcat）
# 隔离关键：HOME=/root/sea2/napcat 把 QQ 登录会话与 NapCat 数据重定向到独立目录，
#          绝不与 SEA/sea1 的 docker napcat（/root/napcat/.config）或默认 /root/.config/QQ 共享，
#          否则同账号 __BACKUP_QQ__ 会互踢。注入版 napcat 会忽略 --user-data-dir，故用 HOME 兜底。
export HOME=/root/sea2/napcat
export DISPLAY=:1
Xvfb :1 -screen 0 1080x760x16 +extension GLX +render >/dev/null 2>&1 &
sleep 2
export FFMPEG_PATH=/usr/bin/ffmpeg
cd /app/napcat
exec /root/sea2/napcat/QQ/qq --no-sandbox --user-data-dir=/root/sea2/napcat/.config >> /root/sea2/napcat/napcat.log 2>&1
