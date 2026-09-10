// ecosystem.qr.config.js — sea2-qr 扫码中间页服务（pm2 常驻，由 install.sh 渲染生成）
module.exports = {
  apps: [{
    name: 'sea2-qr',
    script: './napcat/qr-server.js',
    cwd: '/root/sea2',
    max_restarts: 20,
    restart_delay: 3000,
    env: {
      PORT: '13011',
      WEBUI_PORT: '6100',
      BACKUP_WEBUI_PORT: '6099',
      // 中间页对外地址（可选）：留空则用本机内网 IP，手机扫码需能访问该地址
      EXTERNAL_URL: '__EXTERNAL_URL__',
      SEA2_OWN_QQ: '__MAIN_QQ__',
      SEA2_BACKUP_QQ: '__BACKUP_QQ__',
      SEA2_MAIN_NAPCAT_URL: 'http://127.0.0.1:4000',
      SEA2_MAIN_NAPCAT_TOKEN: '__NAPCAT_TOKEN__',
      SEA2_BACKUP_NAPCAT_URL: 'http://127.0.0.1:3000',
      SEA2_BACKUP_NAPCAT_TOKEN: '__NAPCAT_TOKEN__'
    }
  }]
};
