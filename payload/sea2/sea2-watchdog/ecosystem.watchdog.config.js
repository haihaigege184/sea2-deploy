'use strict';
/**
 * sea2-watchdog/ecosystem.watchdog.config.js — [R9 R3-2] watchdog pm2 常驻配置
 * [2026-08-08] 补充完整 SEA2_* env（DEVICE_ID 之前被截断为 16 位导致轮询不消费指令）
 */
module.exports = {
  apps: [
    {
      name: 'sea2-watchdog',
      script: './index.js',
      cwd: __dirname,
      interpreter: 'node',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      min_uptime: 10000,
      watch: false,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        SEA2_SERVER_URL: 'http://127.0.0.1:3457',
        SEA2_DEVICE_ID: '__SEA2_DEVICE_ID__',
        SEA2_OPS_TOKEN: '__SEA2_OPS_TOKEN__',
        SEA2_SERVICE: 'sea2-bot',
        SEA1_SERVICE: 'sea1-bot',
        SEA1_CTRL: 'pm2',
        DOCKER_BACKUP_CONTAINER: 'napcat',
      },
      out_file: '/root/sea2/logs/watchdog.out.log',
      error_file: '/root/sea2/logs/watchdog.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
