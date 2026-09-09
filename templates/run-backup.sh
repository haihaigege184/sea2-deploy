#!/bin/bash
# 原生 napcat 启动器（副号实例：与主号共用同一 QQ 二进制，靠 HOME + NAPCAT_HOME 隔离）
# 隔离关键：HOME=/root/sea1napcat 独立 QQ 登录会话（与主号 /root/sea2/napcat 互不可见，防互踢），
#          NAPCAT_HOME=/app/napcat2 选择副号 NapCat Shell 实例（独立 webui/onebot 网络配置）。
# 副号 OneBot :3000 · WebUI :6099（与生产 docker 方案端口一致，sea1/sea2 适配器无感）
export HOME=/root/sea1napcat
export NAPCAT_HOME=/app/napcat2
export DISPLAY=:2
Xvfb :2 -screen 0 1080x760x16 +extension GLX +render >/dev/null 2>&1 &
sleep 2
export FFMPEG_PATH=/usr/bin/ffmpeg
cd "$NAPCAT_HOME"
exec /root/sea2/napcat/QQ/qq --no-sandbox --user-data-dir=/root/sea1napcat/.config >> /root/sea1napcat/napcat.log 2>&1
