#!/bin/bash
# 原生 napcat 启动器（主号实例：SEA2 专用 QQ + napcat）
# 隔离关键：HOME=/root/sea2/napcat 把 QQ 登录会话重定向到独立目录，
#          NAPCAT_HOME=/app/napcat 选择主号 NapCat Shell 实例（loadNapCat.js 按此变量分流）。
export HOME=/root/sea2/napcat
export NAPCAT_HOME=/app/napcat
export DISPLAY=:1
Xvfb :1 -screen 0 1080x760x16 +extension GLX +render >/dev/null 2>&1 &
sleep 2
export FFMPEG_PATH=/usr/bin/ffmpeg
cd "$NAPCAT_HOME"
exec /root/sea2/napcat/QQ/qq --no-sandbox --user-data-dir=/root/sea2/napcat/.config >> /root/sea2/napcat/napcat.log 2>&1
