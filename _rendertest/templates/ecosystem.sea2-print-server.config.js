// ecosystem.sea2-print-server.config.js — 独立本地打印服务（pm2 常驻，由 install.sh 渲染生成）
module.exports = {
  apps: [{
    name: 'sea2-print-server',
    script: './print-server-standalone.js',
    cwd: '/root/sea2',
    max_restarts: 20,
    restart_delay: 3000,
    env: {
      SEA2_PRINT_SERVER_PORT: '13012',
      SEA2_WEBPRINT_QUEUE: '/root/sea2/webprint/queue.json',
      SEA2_WEBPRINT_UPLOADS: '/root/sea2/webprint/uploads',
      SEA2_SERVER_URL: 'http://127.0.0.1:3457',
      SEA2_DEVICE_ID: '__SEA2_DEVICE_ID__',
      SEA2_OPS_TOKEN: '__SEA2_OPS_TOKEN__',
      WEB_ADMIN_TOKEN: '__WEB_ADMIN_TOKEN__',
      SEA2_MAIN_NAPCAT_URL: 'http://127.0.0.1:4000',
      SEA2_MAIN_NAPCAT_TOKEN: '__NAPCAT_TOKEN__',
      SEA2_BACKUP_NAPCAT_URL: 'http://127.0.0.1:3000',
      SEA2_BACKUP_NAPCAT_TOKEN: '__NAPCAT_TOKEN__',
      SEA2_OWN_QQ: '__MAIN_QQ__'
    }
  }]
};
