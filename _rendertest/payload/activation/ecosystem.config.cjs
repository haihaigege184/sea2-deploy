module.exports = {
  apps: [{
    name: 'sea1-activation',
    script: 'server.js',
    cwd: '/root/sea1-activation-server',
    autorestart: true,
    env: {
      PORT: '3457',
      HOST: '0.0.0.0',
      DATA_DIR: '/root/sea1-activation-server/data',
      // ⚠️ 以下为敏感项，必须由环境变量注入，严禁硬编码入库！
      // 部署端用 apply_alipay_keys.js 或 export 注入；分发仓库只保留占位，不含真实值。
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'CHANGE_ME_ADMIN_TOKEN',
      GRACE_DAYS: process.env.GRACE_DAYS || '7',
      ALIPAY_APP_ID: process.env.ALIPAY_APP_ID || '',
      ALIPAY_PRIVATE_KEY: process.env.ALIPAY_PRIVATE_KEY || '',
      ALIPAY_PUBLIC_KEY: process.env.ALIPAY_PUBLIC_KEY || ''
    }
  }]
};
