// ecosystem.sea2-bot.config.js — sea2-bot 主框架（pm2 常驻，由 install.sh 渲染生成）
module.exports = {
  apps: [{
    name: 'sea2-bot',
    script: './sea.js',
    cwd: '/root/sea2',
    max_restarts: 20,
    restart_delay: 5000,
    env: {
      SEA2_SERVER_URL: 'http://127.0.0.1:3457',
      SEA2_DEVICE_ID: '__SEA2_DEVICE_ID__',
      SEA2_OPS_TOKEN: '__SEA2_OPS_TOKEN__',
      WEB_ADMIN_TOKEN: '__WEB_ADMIN_TOKEN__',
      SEA2_MAIN_NAPCAT_URL: 'http://127.0.0.1:4000',
      SEA2_MAIN_NAPCAT_TOKEN: '__NAPCAT_TOKEN__',
      SEA2_BACKUP_NAPCAT_URL: 'http://127.0.0.1:3000',
      SEA2_BACKUP_NAPCAT_TOKEN: '__NAPCAT_TOKEN__',
      SEA2_OWN_QQ: '__MAIN_QQ__',
      QL_NOTIFY_ADMIN_GROUPS: '__PRINT_GROUP__'
    }
  }]
};
