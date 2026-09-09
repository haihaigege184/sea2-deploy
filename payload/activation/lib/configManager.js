'use strict';
/**
 * configManager.js — 配置中心数据层
 *
 * 职责：
 *  - SCHEMA：描述全部可配置项（分组 / 类型 / 是否热更 / 是否需重启 / 帮助文本）。
 *  - readConfig(cfg, store)：把"当前生效配置"整理成 UI 友好的结构。
 *      · 普通字段 → 字符串值（JSON 字段美化）。
 *      · secret 字段 → { secret:true, set:bool }，绝不返回明文。
 *  - writeConfig({cfg, store, patch, envPath})：把改动落盘。
 *      · 试用热字段(months/disabled) → 写 store + 回写 config.env（复用 trial.rewriteConfigEnv）。
 *      · 其余字段 → 序列化后回写 config.env（rewriteEnvKeys，逐行原地改写）。
 *      · 空值(patch[key]===''/null) → 跳过，避免误清空或泄露。
 *
 * 安全约束：config.env 仅原地改写匹配行，绝不整文件重建；文件不存在时拒绝新建。
 */

const fs = require('node:fs');
const path = require('node:path');
const trial = require('./trial');
// [FLEET] 集群管理分组的阈值委托 fleetConfig 读写（落 data/fleet-config.json，热更）
const fleetConfig = require('./fleetConfig');
// [R4] 一键部署分组的穿透地址/主地址委托 deployConfig 读写（落 data/deploy-config.json，热更）
const deployConfig = require('./deployConfig');

/** 默认 config.env 路径：activation-server/config.env */
const DEFAULT_ENV_PATH = path.join(__dirname, '..', 'config.env');

/**
 * SCHEMA：全部配置项的字段描述。
 * 字段说明：
 *  - key   : 内部标识（与 cfg / store 对应）
 *  - env   : 写入 config.env 的环境变量名
 *  - label : 展示名
 *  - group : 分组（页面按 group 渲染卡片）
 *  - type  : text | number | select | boolean | json | secret
 *  - requiresRestart : 修改后需重启服务生效（非热更项）
 *  - hot   : 热更新项（保存后立即生效，无需重启）
 *  - secret: 即使 type 非 'secret'（如 alipayAppId）也按密文处理（不回显明文）
 *  - options / help : select 选项 / 帮助文本
 *  - hidden: [R5] 前端主表单不渲染该字段（分组内全 hidden 则不渲染整卡）；后端逻辑与
 *            /api/admin/config 原始接口不受影响（totpSecret/deployMasterAddress 使用）
 *  - helpDetail: [R5] 五段详细帮助 {meaning,howToFill,example,impact,wrongConsequence}，
 *            与 help 双轨：help 保留简短文案（兼容旧渲染），helpDetail 供「?」图标 tooltip
 */
const SCHEMA = [
  // 服务基础
  { key: 'port', env: 'PORT', label: '监听端口', group: '服务基础', type: 'number', requiresRestart: true, help: 'HTTP 监听端口，默认 3457' },
  { key: 'host', env: 'HOST', label: '监听地址', group: '服务基础', type: 'text', requiresRestart: true },
  { key: 'dataDir', env: 'DATA_DIR', label: '数据目录', group: '服务基础', type: 'text', requiresRestart: true },
  { key: 'graceDays', env: 'GRACE_DAYS', label: '授权宽限期(天)', group: '服务基础', type: 'number', requiresRestart: true, help: '许可证到期后仍可正常使用的宽限天数' },
  { key: 'adminToken', env: 'ADMIN_TOKEN', label: '管理令牌', group: '服务基础', type: 'secret', requiresRestart: true, help: '后台鉴权令牌；若 pm2 已注入则优先级更高' },
  { key: 'monitorToken', env: 'MONITOR_TOKEN', label: '核验专用令牌', group: '服务基础', type: 'secret', requiresRestart: true, help: '商户/监控器核验接口专用；为空则该接口停用' },

  // 新用户试用
  { key: 'trialMonths', env: 'TRIAL_MONTHS', label: '试用期(月)', group: '新用户试用', type: 'number', hot: true, help: '新用户首触自动授予的月数' },
  { key: 'trialDisabled', env: 'TRIAL_DISABLED', label: '关闭新用户试用', group: '新用户试用', type: 'boolean', hot: true, help: '开启后不再自动授予试用' },
  { key: 'trialNearDays', env: 'TRIAL_NEAR_DAYS', label: '临期提醒阈值(天)', group: '新用户试用', type: 'text', hot: true, help: '逗号分隔，如 7,3' },
  { key: 'trialMaxReminders', env: 'TRIAL_MAX_REMINDERS', label: '最大提醒次数', group: '新用户试用', type: 'number', hot: true },
  { key: 'trialDays', env: 'TRIAL_DAYS', label: '机器维度试用(天)', group: '新用户试用', type: 'number', requiresRestart: true, help: 'legacy 机器维度试用天数（客户端倒计时展示用，与用户维度试用相互独立）' },

  // 支付与套餐
  { key: 'paymentMode', env: 'PAYMENT_MODE', label: '支付模式', group: '支付与套餐', type: 'select', options: ['manual', 'webhook'], requiresRestart: true },
  { key: 'plans', env: 'PLANS_JSON', label: '套餐表(JSON)', group: '支付与套餐', type: 'json', requiresRestart: true, help: '月5/季12/年48/永久128' },
  { key: 'paymentQr', env: 'PAYMENT_QR_JSON', label: '收款码(JSON)', group: '支付与套餐', type: 'json', requiresRestart: true, help: '{"alipay":"url","wechat":"url"}' },
  { key: 'alipayAppId', env: 'ALIPAY_APP_ID', label: '支付宝 AppId', group: '支付与套餐', type: 'text', secret: true, requiresRestart: true },
  { key: 'alipayPrivateKey', env: 'ALIPAY_PRIVATE_KEY', label: '支付宝私钥', group: '支付与套餐', type: 'secret', requiresRestart: true, help: '多行 PEM 建议经 pm2 env 注入' },
  { key: 'alipayPublicKey', env: 'ALIPAY_PUBLIC_KEY', label: '支付宝公钥', group: '支付与套餐', type: 'secret', requiresRestart: true },
  { key: 'alipayGateway', env: 'ALIPAY_GATEWAY', label: '支付宝网关', group: '支付与套餐', type: 'text', requiresRestart: true },

  // 收款回调与 Webhook
  { key: 'wechatApiKey', env: 'WECHAT_API_KEY', label: '微信支付 ApiKey', group: '收款回调与 Webhook', type: 'secret', requiresRestart: true },
  { key: 'webhookSecret', env: 'WEBHOOK_SECRET', label: '微信收款 Webhook 密钥', group: '收款回调与 Webhook', type: 'secret', requiresRestart: true, help: 'SmsForwarder 微信收款通知验签密钥' },
  { key: 'botNotifyUrl', env: 'BOT_NOTIFY_URL', label: 'Bot 回调地址', group: '收款回调与 Webhook', type: 'text', requiresRestart: true },
  { key: 'botNotifyToken', env: 'BOT_NOTIFY_TOKEN', label: 'Bot 回调令牌', group: '收款回调与 Webhook', type: 'secret', requiresRestart: true },
  { key: 'publicBaseUrl', env: 'PUBLIC_BASE_URL', label: '公网基址', group: '收款回调与 Webhook', type: 'text', requiresRestart: true, help: '用于拼接支付宝 notify_url' },

  // [FLEET] 集群管理（外网客户端）：12 项阈值，落 data/fleet-config.json，热更（不需重启）
  { key: 'externalEndpoint', env: 'EXTERNAL_ENDPOINT', label: '外网/穿透基址', group: '集群管理', type: 'text', hot: true, fleet: true, help: '部署物料展示给客户端抄写的公网地址（cloudflared 隧道或自有域名）；为空时前端提示「尚未配置穿透」' },
  { key: 'internalEndpoint', env: 'INTERNAL_ENDPOINT', label: '内网基址', group: '集群管理', type: 'text', hot: true, fleet: true, help: '内网访问基址，externalEndpoint 为空时前端回退展示' },
  { key: 'fleetHeartbeatInterval', env: 'FLEET_HB_INTERVAL', label: '心跳间隔(秒)', group: '集群管理', type: 'number', hot: true, fleet: true, help: '外网客户端心跳间隔；2×该值内有心跳判定为「在线」，同时用于指令超时(2×)' },
  { key: 'fleetStaleMinutes', env: 'FLEET_STALE_MINUTES', label: '掉线阈值(分钟)', group: '集群管理', type: 'number', hot: true, fleet: true, help: '超过 2×心跳间隔但未超过该分钟数 → 判定「掉线」；超过则判定「离线」。改完立即生效，无需重启' },
  { key: 'fleetOfflineDays', env: 'FLEET_OFFLINE_DAYS', label: '长期离线告警(天)', group: '集群管理', type: 'number', hot: true, fleet: true, help: '仅用于 long_offline 异常告警阈值；列表的在线/掉线/离线判定请改「掉线阈值(分钟)」' },
  { key: 'fleetCpuWarn', env: 'FLEET_CPU_WARN', label: 'CPU 告警阈值(%)', group: '集群管理', type: 'number', hot: true, fleet: true, help: '集群表 CPU 超过该百分比时标橙提示' },
  { key: 'fleetMemWarn', env: 'FLEET_MEM_WARN', label: '内存告警阈值(%)', group: '集群管理', type: 'number', hot: true, fleet: true, help: '集群表内存超过该百分比时标橙提示' },
  { key: 'fleetCodeSharedMin', env: 'FLEET_CODE_SHARED_MIN', label: '同码多机阈值', group: '集群管理', type: 'number', hot: true, fleet: true, help: '同一激活码在 ≥N 台不同机器出现有效心跳 → code_shared 异常' },
  { key: 'fleetScanInterval', env: 'FLEET_SCAN_INTERVAL', label: '异常扫描周期(秒)', group: '集群管理', type: 'number', hot: true, fleet: true, help: '异常扫描定时器周期' },
  { key: 'fleetFreqMinMul', env: 'FLEET_FREQ_MIN_MUL', label: '频率下限系数', group: '集群管理', type: 'number', hot: true, fleet: true, help: '心跳间隔 < 下限系数×interval 视为过快(freq_anomaly)' },
  { key: 'fleetFreqMaxMul', env: 'FLEET_FREQ_MAX_MUL', label: '频率上限系数', group: '集群管理', type: 'number', hot: true, fleet: true, help: '心跳间隔 > 上限系数×interval 视为过慢(freq_anomaly)' },
  { key: 'fleetFlushMs', env: 'FLEET_FLUSH_MS', label: '落盘节流(ms)', group: '集群管理', type: 'number', hot: true, fleet: true, help: 'fleet.json 落盘 debounce 间隔（心跳高频写内存，定时批量落盘）' },

  // [SEA2 商用运维] 高危/格式化/PM2/CUPS/TOTP 配置（§3.6 配置中心扩展，落 data/fleet-config.json，热更）
  { key: 'formatWhitelist', env: 'FORMAT_WHITELIST', label: '格式化白名单机型(前缀数组)', group: '高危与格式化', type: 'json', hot: true, fleet: true, help: '机器码前缀白名单（如 ["SEA2-","SEA1-8GA4"]）；仅命中前缀的设备可进入格式化强门禁。' },
  { key: 'formatLevels', env: 'FORMAT_LEVELS', label: '格式化三档参数(JSON)', group: '高危与格式化', type: 'json', hot: true, fleet: true, help: 'data/factory/disk 三档的 countdownSec 与 confirmWord（例：{"data":{"countdownSec":15,"confirmWord":"FORMAT-DATA"},...}）。' },
  { key: 'highriskEnabled', env: 'HIGHRISK_ENABLED', label: '高危专区总开关', group: '高危与格式化', type: 'boolean', hot: true, fleet: true, help: 'false = 全区拒绝格式化签发（强门禁直接关闭）。' },
  { key: 'totpSecret', env: 'TOTP_SECRET', label: 'TOTP 共享密钥', group: '高危与格式化', type: 'secret', hot: true, fleet: true, hidden: true, help: '管理员二次验证码共享密钥（首次生成，不回显明文；留空=保持不变）。[R2] 不再参与格式化签发门禁，仅兼容保留；需改密可经「运维配置键」面板操作。' },
  { key: 'cupsDriverRepo', env: 'CUPS_DRIVER_REPO', label: 'CUPS 驱动仓库', group: '打印与CUPS', type: 'text', hot: true, fleet: true, help: '驱动包在线仓库 URL（空 = 仅内置型号库）。' },
  { key: 'pm2ServerWhitelist', env: 'PM2_SERVER_WHITELIST', label: '服务端 PM2 白名单(数组)', group: '高危与格式化', type: 'json', hot: true, fleet: true, help: 'sea1-* 与 sea2-server-* 进程名白名单（服务端 pm2 直控名单，名单外一律拒绝）。' },
  { key: 'formatDiskTarget', env: 'FORMAT_DISK_TARGET', label: 'disk 档目标盘', group: '高危与格式化', type: 'text', hot: true, fleet: true, help: '整盘擦除目标设备（如 /dev/sda）；空 = 拒绝签发 disk 档（客户端无 target 同样拒绝）。' },

  // [R4] 一键部署（穿透地址清单 + 主通信地址；热更，落 data/deploy-config.json）
  // [R5] hidden=true：该分组整卡不渲染在配置中心主表单，改由 console.deploy.js「一键部署」面板承载
  { key: 'deployMasterAddress', env: 'DEPLOY_MASTER_ADDRESS', label: '一键部署脚本主通信地址',
    group: '一键部署', type: 'text', hot: true, deploy: true, hidden: true,
    help: '部署脚本引导阶段据此调用配置中心获取穿透地址清单（经 git 推送到私有仓 deploy-config.json）' },

  // [R6 R4] 容器管理（FastOSDocker 反代：dockerMgrProxy 预登录/转发用；非热更，回写 config.env）
  { key: 'dockerMgrUrl', env: 'DOCKER_MGR_URL', label: '容器管理地址', group: '容器管理', type: 'text', requiresRestart: true,
    help: 'FastOSDocker 上游地址（默认 http://127.0.0.1:8081）；反代 /docker-mgr/* 与 /ws 时转发目标' },
  { key: 'dockerMgrUser', env: 'DOCKER_MGR_USER', label: '容器管理用户名', group: '容器管理', type: 'secret', requiresRestart: true,
    help: 'FastOSDocker 登录用户名（预登录 POST /login {username,password}；默认 root）' },
  { key: 'dockerMgrPass', env: 'DOCKER_MGR_PASS', label: '容器管理密码', group: '容器管理', type: 'secret', requiresRestart: true,
    help: 'FastOSDocker 登录密码（默认 root）；用于预登录与 401 自动重登' },

  // [R9 R2] 机器人防互激发（botGuard 热更：服务端 fleetConfig → 运维下发 /root/sea2/run/botguard-cfg.json）
  { key: 'botRateLimitPer5s', env: 'BOT_RATE_LIMIT_PER_5S', label: '群/QQ 限频(条/5s)', group: '机器人防互激发', type: 'number', hot: true, fleet: true,
    help: 'botGuard 每群/每 QQ 每 5 秒最多允许回复条数，超限丢弃（防刷屏）。' },
  { key: 'botBurstPer10s', env: 'BOT_BURST_PER_10S', label: '群熔断阈值(条/10s)', group: '机器人防互激发', type: 'number', hot: true, fleet: true,
    help: 'botGuard 某群 10 秒内消息条数超过该值 → 触发群熔断暂停回复（防互激发刷屏）。' },
  { key: 'botCircuitBreakSec', env: 'BOT_CIRCUIT_BREAK_SEC', label: '群熔断暂停(秒)', group: '机器人防互激发', type: 'number', hot: true, fleet: true,
    help: '群熔断触发后暂停回复的秒数，到期自动恢复。' },
];

// ================= [R5] helpDetail 双轨帮助体系 =================
// help 保留现有简短文案（兼容旧渲染）；helpDetail 提供五段详细帮助（含义/如何填写/示例/影响/填错后果）。
// P0 高频分组（服务基础/支付与套餐/高危与格式化/集群管理/一键部署）逐项人工撰写；
// 其余分组（新用户试用/收款回调与 Webhook/打印与CUPS）按模板生成，保证全量覆盖。

const HELP_DETAIL_CURATED = {
  // ---- 服务基础 ----
  port: {
    meaning: '含义：服务对外 HTTP 监听端口（控制台 / API / 客户端心跳共用）。',
    howToFill: '如何填写：填 1-65535 之间的整数。',
    example: '示例：3457',
    impact: '影响：需重启生效；改动后访问控制台与客户端连接需使用新端口。',
    wrongConsequence: '填错后果：端口被占用或非法值时服务可能无法启动，运维台短暂不可达。',
  },
  host: {
    meaning: '含义：服务监听地址（本机网卡绑定 IP）。',
    howToFill: '如何填写：填 0.0.0.0（全部网卡）或本机内网 IP。',
    example: '示例：0.0.0.0',
    impact: '影响：需重启生效；决定控制台 / 客户端从哪个地址可达本服务。',
    wrongConsequence: '填错后果：绑定错误网段会导致外部无法访问服务。',
  },
  dataDir: {
    meaning: '含义：数据目录（store.json / fleet.json / 审计 JSONL 等落盘位置）。',
    howToFill: '如何填写：填服务端绝对路径（须可写）。',
    example: '示例：/root/sea2-server/data',
    impact: '影响：需重启生效；改动后旧数据不会被自动迁移。',
    wrongConsequence: '填错后果：目录不存在或不可写时服务读写数据失败，授权/订单可能丢失可见性。',
  },
  graceDays: {
    meaning: '含义：许可证到期后的授权宽限天数。',
    howToFill: '如何填写：非负整数。',
    example: '示例：3',
    impact: '影响：需重启生效；宽限期内到期设备仍可正常使用。',
    wrongConsequence: '填错后果：过小导致到期立即失效，过大削弱授权约束。',
  },
  adminToken: {
    meaning: '含义：后台超管鉴权令牌（控制台登录与写接口鉴权）。',
    howToFill: '如何填写：粘贴任意字符串（建议 ≥16 位随机串）；已设置后留空保持不变。',
    example: '示例：sea1-admin-xxxxxxxxxxxx（密文，不回显）',
    impact: '影响：需重启生效；控制台登录、/api/admin/* 写接口均依赖。',
    wrongConsequence: '填错后果：与客户端/部署配置不一致将无法登录后台，需通过服务器环境修复。',
  },
  monitorToken: {
    meaning: '含义：核验专用令牌（商户/监控器核验到账接口鉴权，x-monitor-token）。',
    howToFill: '如何填写：粘贴任意字符串；留空则该接口停用。',
    example: '示例：monitor-secret',
    impact: '影响：需重启生效；手动确认订单 / 自动核验推进依赖。',
    wrongConsequence: '填错后果：与监控器配置不匹配时核验接口返回 401，订单无法自动发码。',
  },
  // ---- 支付与套餐 ----
  paymentMode: {
    meaning: '含义：支付到账核验模式。',
    howToFill: '如何填写：下拉选择 manual（手动确认）或 webhook（推送自动核验）。',
    example: '示例：manual',
    impact: '影响：需重启生效；决定到账核验方式与前端展示。',
    wrongConsequence: '填错后果：模式与收款通道不匹配时订单无法自动核销，需人工确认。',
  },
  plans: {
    meaning: '含义：套餐表（JSON），决定下单金额与菜单展示。',
    howToFill: '如何填写：按「套餐标识:{name,price,months}」结构填写合法 JSON。',
    example: '示例：{"month":{"name":"月卡","price":5,"months":1},"year":{"name":"年卡","price":48,"months":12},"lifetime":{"name":"永久会员","price":128,"months":0}}',
    impact: '影响：需重启生效；开通会员菜单 / 下单金额均取自本字段。',
    wrongConsequence: '填错后果：JSON 非法或字段缺失导致下单失败，坏 JSON 会在保存时被拦截。',
  },
  paymentQr: {
    meaning: '含义：收款码图片 URL（JSON）。',
    howToFill: '如何填写：按 {"alipay":"url","wechat":"url"} 结构填写。',
    example: '示例：{"alipay":"https://…/alipay.png","wechat":"https://…/wechat.png"}',
    impact: '影响：需重启生效；下单回执展示收款码供用户扫码。',
    wrongConsequence: '填错后果：URL 不可达时用户无法扫码付款。',
  },
  alipayAppId: {
    meaning: '含义：支付宝开放平台应用 AppId（当面付对接）。',
    howToFill: '如何填写：粘贴应用 AppId；按密文处理，不回显明文。',
    example: '示例：202100…（密文）',
    impact: '影响：需重启生效；支付宝支付下单鉴权。',
    wrongConsequence: '填错后果：AppId 错误导致支付下单失败。',
  },
  alipayPrivateKey: {
    meaning: '含义：支付宝应用私钥（PEM，用于请求签名）。',
    howToFill: '如何填写：粘贴完整 PEM 多行内容；建议经 pm2 env 注入。',
    example: '示例：-----BEGIN PRIVATE KEY-----…-----END PRIVATE KEY-----',
    impact: '影响：需重启生效；支付请求签名。',
    wrongConsequence: '填错后果：私钥错误或格式不完整导致签名失败、支付不可用。',
  },
  alipayPublicKey: {
    meaning: '含义：支付宝平台公钥（回调验签）。',
    howToFill: '如何填写：粘贴支付宝公钥 PEM。',
    example: '示例：-----BEGIN PUBLIC KEY-----…-----END PUBLIC KEY-----',
    impact: '影响：需重启生效；支付宝异步回调验签。',
    wrongConsequence: '填错后果：公钥错误导致回调被拒，到账无法自动确认。',
  },
  alipayGateway: {
    meaning: '含义：支付宝网关地址。',
    howToFill: '如何填写：填支付宝官方网关。',
    example: '示例：https://openapi.alipay.com/gateway.do',
    impact: '影响：需重启生效；支付请求发送目标。',
    wrongConsequence: '填错后果：网关错误导致支付请求失败。',
  },
  // ---- 高危与格式化 ----
  formatWhitelist: {
    meaning: '含义：格式化白名单机型前缀数组（JSON），仅命中前缀的设备可进入格式化强门禁。',
    howToFill: '如何填写：填机器码前缀字符串数组。',
    example: '示例：["SEA2-","SEA1-8GA4"]',
    impact: '影响：即时生效（热更，落 fleet-config.json）。',
    wrongConsequence: '填错后果：白名单过宽会放行未授权设备，过窄会误拒合法设备。',
  },
  formatLevels: {
    meaning: '含义：三档格式化参数（data/factory/disk 的本地倒计时与确认词）。',
    howToFill: '如何填写：按 {"档位":{"countdownSec":秒数,"confirmWord":"词"}} 结构填写。',
    example: '示例：{"data":{"countdownSec":15,"confirmWord":"FORMAT-DATA"},"factory":{"countdownSec":20,"confirmWord":"FORMAT-FACTORY"},"disk":{"countdownSec":30,"confirmWord":"FORMAT-DISK"}}',
    impact: '影响：即时生效；决定门禁倒计时与手输确认词。',
    wrongConsequence: '填错后果：确认词缺失会导致对应档位无法签发（fail-closed）。',
  },
  highriskEnabled: {
    meaning: '含义：高危专区总开关。',
    howToFill: '如何填写：1=开启，0=关闭。',
    example: '示例：1',
    impact: '影响：即时生效；关闭后全区拒绝格式化签发。',
    wrongConsequence: '填错后果：误关闭会导致所有格式化操作被拒，运维需紧急处理。',
  },
  totpSecret: {
    meaning: '含义：TOTP 共享密钥（管理员二次验证码，R2 去 TOTP 后不再参与格式化签发门禁，仅兼容保留）。',
    howToFill: '如何填写：首次生成后粘贴 base32 密钥；留空保持不变；不回显明文。',
    example: '示例：JBSWY3DPEHPK3PXP（base32，密文）',
    impact: '影响：即时生效；仅供兼容/他处引用，格式化签发链不再校验。',
    wrongConsequence: '填错后果：不影响格式化签发链；如需改密建议在「高危操作 → TOTP 状态」处重置。',
  },
  pm2ServerWhitelist: {
    meaning: '含义：服务端 PM2 进程名白名单（数组）。',
    howToFill: '如何填写：填进程名前缀数组。',
    example: '示例：["sea1-*","sea2-server-*"]',
    impact: '影响：即时生效；服务端 pm2 直控名单，名单外拒绝操作。',
    wrongConsequence: '填错后果：名单过窄无法操作合法进程，过宽可能误控其他进程。',
  },
  formatDiskTarget: {
    meaning: '含义：disk 档整盘擦除目标设备路径。',
    howToFill: '如何填写：填块设备路径（须与目标机磁盘一致）。',
    example: '示例：/dev/sda',
    impact: '影响：即时生效；disk 档签发前必须预填，为空则拒绝签发。',
    wrongConsequence: '填错后果：设备路径错误将擦错磁盘，属毁灭性错误，务必与现场核对。',
  },
  // ---- 集群管理 ----
  externalEndpoint: {
    meaning: '含义：外网/穿透基址（部署物料展示给客户端抄写的公网地址）。',
    howToFill: '如何填写：填公网可达地址（cloudflared 隧道或自有域名）。',
    example: '示例：https://xxx.trycloudflare.com',
    impact: '影响：即时生效；为空时前端提示「尚未配置穿透」。',
    wrongConsequence: '填错后果：地址不可达时外网客户端无法连接服务。',
  },
  internalEndpoint: {
    meaning: '含义：内网基址。',
    howToFill: '如何填写：填内网访问地址。',
    example: '示例：http://10.0.0.11:3457',
    impact: '影响：即时生效；externalEndpoint 为空时前端回退展示。',
    wrongConsequence: '填错后果：地址错误导致内网客户端连接失败。',
  },
  fleetHeartbeatInterval: {
    meaning: '含义：外网客户端心跳间隔（秒）。',
    howToFill: '如何填写：正整数秒。',
    example: '示例：60',
    impact: '影响：即时生效；2×该值内有心跳判定为「在线」，同时用于指令超时(2×)。',
    wrongConsequence: '填错后果：过小导致误判掉线/负载升高，过大延迟发现掉线。',
  },
  fleetStaleMinutes: {
    meaning: '含义：掉线阈值（分钟）。',
    howToFill: '如何填写：正整数分钟。',
    example: '示例：5',
    impact: '影响：即时生效；超过 2×心跳间隔但未超过该分钟数 → 判定「掉线」。',
    wrongConsequence: '填错后果：过小导致网络瞬时抖动被误判掉线。',
  },
  fleetOfflineDays: {
    meaning: '含义：长期离线告警阈值（天）。',
    howToFill: '如何填写：正整数天数。',
    example: '示例：7',
    impact: '影响：即时生效；仅用于 long_offline 异常告警阈值。',
    wrongConsequence: '填错后果：过小导致正常离线设备频繁告警。',
  },
  fleetCpuWarn: {
    meaning: '含义：集群表 CPU 告警阈值（%）。',
    howToFill: '如何填写：0-100 数字。',
    example: '示例：85',
    impact: '影响：即时生效；CPU 超过该百分比时标橙提示。',
    wrongConsequence: '填错后果：过低导致大量设备标橙干扰判断。',
  },
  fleetMemWarn: {
    meaning: '含义：集群表内存告警阈值（%）。',
    howToFill: '如何填写：0-100 数字。',
    example: '示例：85',
    impact: '影响：即时生效；内存超过该百分比时标橙提示。',
    wrongConsequence: '填错后果：过低导致大量设备标橙干扰判断。',
  },
  fleetCodeSharedMin: {
    meaning: '含义：同码多机阈值（同一激活码出现有效心跳的机器数下限）。',
    howToFill: '如何填写：正整数 N。',
    example: '示例：2',
    impact: '影响：即时生效；≥N 台不同机器出现有效心跳 → code_shared 异常。',
    wrongConsequence: '填错后果：过小误报共享，过大漏报风险。',
  },
  fleetScanInterval: {
    meaning: '含义：异常扫描周期（秒）。',
    howToFill: '如何填写：正整数秒。',
    example: '示例：60',
    impact: '影响：即时生效；异常扫描定时器周期。',
    wrongConsequence: '填错后果：过小增加负载，过大延迟发现异常。',
  },
  fleetFreqMinMul: {
    meaning: '含义：心跳频率下限系数。',
    howToFill: '如何填写：数字（乘心跳间隔得下限）。',
    example: '示例：0.5',
    impact: '影响：即时生效；心跳间隔 < 下限系数×interval 视为过快(freq_anomaly)。',
    wrongConsequence: '填错后果：过大导致正常心跳被误判过快。',
  },
  fleetFreqMaxMul: {
    meaning: '含义：心跳频率上限系数。',
    howToFill: '如何填写：数字（乘心跳间隔得上限）。',
    example: '示例：2',
    impact: '影响：即时生效；心跳间隔 > 上限系数×interval 视为过慢(freq_anomaly)。',
    wrongConsequence: '填错后果：过小导致正常心跳被误判过慢。',
  },
  fleetFlushMs: {
    meaning: '含义：fleet.json 落盘节流间隔（毫秒）。',
    howToFill: '如何填写：正整数毫秒。',
    example: '示例：2000',
    impact: '影响：即时生效；心跳高频写内存，定时批量落盘。',
    wrongConsequence: '填错后果：过小频繁写盘，过大可能丢失少量内存态。',
  },
  // ---- 一键部署 ----
  deployMasterAddress: {
    meaning: '含义：一键部署脚本主通信地址（部署脚本引导阶段调用配置中心的入口）。',
    howToFill: '如何填写：填配置中心服务端可达地址（含协议与端口）。',
    example: '示例：http://10.0.0.11:3457',
    impact: '影响：即时生效（落 data/deploy-config.json）；经「一键推送」发布到私有仓后部署脚本据此拉取穿透地址清单。',
    wrongConsequence: '填错后果：地址错误导致部署脚本无法获取穿透地址清单，一键部署失败。',
  },
  // ---- 容器管理（[R6 R4]）----
  dockerMgrUrl: {
    meaning: '含义：FastOSDocker 容器管理服务地址（dockerMgrProxy 反代转发目标，含协议与端口）。',
    howToFill: '如何填写：填 http://<IP>:<端口>，默认 http://127.0.0.1:8081。',
    example: '示例：http://127.0.0.1:8081',
    impact: '影响：保存后需重启服务生效；控制台「容器管理」Tab 经 /docker-mgr/* 反代到该地址。',
    wrongConsequence: '填错后果：容器管理视图降级为不可用提示（iframe 内不白屏），不影响其余功能。',
  },
  dockerMgrUser: {
    meaning: '含义：FastOSDocker 登录用户名（预登录与 401 自动重登使用）。',
    howToFill: '如何填写：填 FastOSDocker 的登录用户名（默认 root）。',
    example: '示例：root',
    impact: '影响：保存后需重启服务生效；以密文存储，不回显明文。',
    wrongConsequence: '填错后果：预登录失败，容器管理视图显示降级提示（登录失败）。',
  },
  dockerMgrPass: {
    meaning: '含义：FastOSDocker 登录密码（预登录与 401 自动重登使用）。',
    howToFill: '如何填写：填 FastOSDocker 的登录密码（默认 root）。',
    example: '示例：root',
    impact: '影响：保存后需重启服务生效；以密文存储，不回显明文。',
    wrongConsequence: '填错后果：预登录失败，容器管理视图显示降级提示（登录失败）。',
  },
};

/** P1 模板：为未人工撰写的字段按类型生成五段帮助（保证全量覆盖） */
function buildHelpDetail(f) {
  const group = f.group || '';
  const label = f.label || f.key;
  const env = f.env || f.key;
  const typeCn = {
    text: '文本', number: '数字', boolean: '开关（1=开启 / 0=关闭）',
    select: '下拉选项', json: 'JSON 对象', secret: '密钥（不回显明文）',
  }[f.type] || '文本';
  const hotCn = f.hot ? '即时生效（热更），保存后无需重启' : (f.requiresRestart ? '保存后需重启服务生效' : '保存后生效');
  return {
    meaning: '含义：' + label + '（环境变量 ' + env + '，分组「' + group + '」）。',
    howToFill: '如何填写：' + typeCn + '。' + (f.help ? '说明：' + f.help : ''),
    example: '示例：' + (f.type === 'number' ? '如 3457' : f.type === 'boolean' ? '如 1（开启）或 0（关闭）' : f.type === 'select' ? '如 ' + (Array.isArray(f.options) ? f.options.join(' / ') : '') : f.type === 'json' ? '如 {}（合法 JSON）' : f.type === 'secret' ? '粘贴完整密钥/令牌（留空保持不变）' : '按实际需求填写'),
    impact: '影响：' + hotCn + '；改动作用于本服务运行时配置。',
    wrongConsequence: '填错后果：可能导致「' + label + '」相关功能异常；保存前请核对，必要时可在「配置历史」回滚。',
  };
}

// 全量补全 helpDetail（已人工撰写的保留，其余模板生成 → 五段齐全）
for (const f of SCHEMA) {
  if (!f.helpDetail) {
    f.helpDetail = HELP_DETAIL_CURATED[f.key] || buildHelpDetail(f);
  }
}

/** 该字段是否按密文处理（不回显明文） */
function isSecretField(f) {
  return f.type === 'secret' || f.secret === true;
}

/**
 * 解析字段原始值（从 cfg 或 trial 配置或 process.env 兜底）。
 * @returns {*}
 */
function resolveRawValue(f, cfg, trialCfg) {
  switch (f.key) {
    case 'trialMonths': return trialCfg.months;
    case 'trialDisabled': return trialCfg.disabled;
    case 'trialNearDays': return trialCfg.nearDays;
    case 'trialMaxReminders': return trialCfg.maxReminders;
    default:
      // [FLEET] 集群管理分组字段委托 fleetConfig 实时读取（热更）
      if (f.fleet) return fleetConfig.load()[f.key];
      // [R4] 一键部署分组字段委托 deployConfig 实时读取（热更）
      if (f.deploy) return deployConfig.load().masterAddress;
      // loadConfig 未包含 monitorToken 等少数项 → 从 process.env 兜底
      if (Object.prototype.hasOwnProperty.call(cfg, f.key)) return cfg[f.key];
      return process.env[f.env];
  }
}

/**
 * 把原始值格式化为 UI 展示字符串。
 *  - json 字段：美化 JSON（对象直接 stringify；字符串先 parse 再美化）。
 *  - boolean 字段：'1'/'0'（与 writeConfig 解析一致）。
 *  - 其余：String(值)，空值返回 ''。
 */
function formatDisplayValue(f, val) {
  if (f.type === 'json') {
    let obj = val;
    if (typeof val === 'string') {
      try { obj = JSON.parse(val); } catch (e) { obj = {}; }
    }
    try { return JSON.stringify(obj == null ? {} : obj, null, 2); } catch (e) { return '{}'; }
  }
  if (f.type === 'boolean') return val ? '1' : '0';
  if (val == null) return '';
  return String(val);
}

/**
 * 读取当前生效配置（UI 友好）。
 * @param {object} cfg 来自 loadConfig() 的配置（运行中固化）
 * @param {object} store 数据存储（用于读取试用热配置）
 * @returns {{schema:Array, values:object, effectiveNote:object}}
 */
function readConfig(cfg, store) {
  const trialCfg = trial.getTrialConfig(store, cfg);
  const values = {};
  for (const f of SCHEMA) {
    const raw = resolveRawValue(f, cfg, trialCfg);
    if (isSecretField(f)) {
      // 绝不返回明文：仅告知是否已设置
      const set = !!(raw && String(raw).length > 0);
      values[f.key] = { secret: true, set };
    } else {
      values[f.key] = formatDisplayValue(f, raw);
    }
  }
  const effectiveNote = {
    restart: SCHEMA.filter((f) => f.requiresRestart && !f.hot).map((f) => f.key),
    hot: SCHEMA.filter((f) => f.hot).map((f) => f.key),
    note: '标记「需重启」的字段保存后需重启服务才能生效；标记「即时生效」的字段（新用户试用）保存后立即生效。',
  };
  return { schema: SCHEMA, values, effectiveNote };
}

/**
 * 应用配置改动并落盘。
 * @param {object} opts
 * @param {object} opts.cfg 来自 loadConfig() 的配置
 * @param {object} opts.store 数据存储
 * @param {object} opts.patch key→字符串值（secret 字段留空表示保持不变）
 * @param {string} [opts.envPath] config.env 绝对路径（默认 activation-server/config.env）
 * @returns {{ok:boolean, restartRequired:boolean, changed:string[], applied:object, error?:string}}
 */
function writeConfig(opts) {
  const { cfg, store, patch } = opts;
  const envPath = opts.envPath || DEFAULT_ENV_PATH;
  const patchMap = patch || {};

  const changed = [];
  const applied = {};
  let restartRequired = false;
  // [SEA2] 历史回滚：记录每个被改键的 before/after（fleet 键与 env 键）
  const historyKeys = {};

  // 试用热字段(months/disabled)需回写 config.env 的内容
  const trialRewrite = {};
  // 其余字段（含 trialNearDays/trialMaxReminders 及所有非热字段）累加进 envPatch
  const envPatch = {};

  const trialCfg = trial.getTrialConfig(store, cfg);

  for (const f of SCHEMA) {
    const raw = patchMap[f.key];
    // 空值：跳过（secret 留空=保持不变；普通字段留空=避免误清空）
    if (raw === '' || raw == null) continue;
    const val = String(raw);

    if (f.hot) {
      // ---- [FLEET] 集群管理字段：热写 fleet-config.json（不重启）----
      if (f.fleet) {
        const before = fleetConfig.load()[f.key];
        let outVal;
        if (f.type === 'json') {
          try { outVal = JSON.parse(val); } catch (e) {
            throw new Error(`字段「${f.label}」JSON 解析失败：${e.message}`);
          }
        } else if (f.type === 'boolean') {
          outVal = (val === '1' || val === 'true');
        } else if (f.type === 'number') {
          outVal = Number(val);
          if (!Number.isFinite(outVal)) throw new Error(`字段「${f.label}」必须为数字`);
        } else {
          outVal = val;
        }
        fleetConfig.save({ [f.key]: outVal });
        changed.push(f.env);
        applied[f.key] = isSecretField(f) ? '***' : val;
        historyKeys[f.key] = { before, after: fleetConfig.load()[f.key] };
        continue;
      }
      // ---- [R4] 一键部署字段：热写 deploy-config.json（不重启，不回写 config.env）----
      if (f.deploy) {
        const before = deployConfig.load().masterAddress;
        deployConfig.save({ masterAddress: val });
        changed.push(f.env);
        applied[f.key] = val;
        historyKeys[f.key] = { before, after: deployConfig.load().masterAddress };
        continue;
      }
      // ---- 试用热字段 ----
      if (f.key === 'trialMonths') {
        const m = parseInt(val, 10);
        const r = trial.updateTrialConfig(store, cfg, { months: m });
        if (!r.ok) throw new Error(r.error || '更新试用期月数失败');
        trialRewrite.months = m;
        changed.push(f.env);
        applied[f.key] = String(m);
        historyKeys[f.key] = { before: trialCfg.months, after: m };
      } else if (f.key === 'trialDisabled') {
        const b = val === '1' || val === 'true';
        const r = trial.updateTrialConfig(store, cfg, { disabled: b });
        if (!r.ok) throw new Error(r.error || '更新关闭试用失败');
        trialRewrite.disabled = b;
        changed.push(f.env);
        applied[f.key] = b ? '1' : '0';
        historyKeys[f.key] = { before: trialCfg.disabled, after: b };
      } else if (f.key === 'trialNearDays') {
        // 仅回写 config.env（store 不存 nearDays 单值，保持简单）
        envPatch[f.env] = val;
        changed.push(f.env);
        applied[f.key] = val;
        historyKeys[f.key] = { before: cfg.trialNearDays, after: val };
      } else if (f.key === 'trialMaxReminders') {
        envPatch[f.env] = val;
        changed.push(f.env);
        applied[f.key] = val;
        historyKeys[f.key] = { before: cfg.trialMaxReminders, after: val };
      }
      // 热字段不触发 restartRequired
      continue;
    }

    // ---- 非热字段：序列化后回写 config.env ----
    let outVal;
    if (f.type === 'json') {
      let parsed;
      try { parsed = JSON.parse(val); } catch (e) {
        throw new Error(`字段「${f.label}」JSON 解析失败：${e.message}`);
      }
      outVal = JSON.stringify(parsed);
    } else if (f.type === 'boolean') {
      // 本 schema 无 boolean 非热项；即便出现也按字符串原样
      outVal = val;
    } else {
      outVal = val; // 字符串原样
    }
    const beforeEnvVal = resolveRawValue(f, cfg, trialCfg);
    envPatch[f.env] = outVal;
    changed.push(f.env);
    // 摘要中不回显明文
    applied[f.key] = isSecretField(f) ? '***' : val;
    historyKeys[f.key] = { before: beforeEnvVal, after: outVal };
    if (f.requiresRestart) restartRequired = true;
  }

  // 试用热字段(months/disabled)回写 config.env（复用 trial.rewriteConfigEnv）
  if (Object.keys(trialRewrite).length > 0) {
    try { trial.rewriteConfigEnv(envPath, trialRewrite); } catch (e) { /* 失败不影响 store（已更新） */ }
  }
  // 其余字段回写 config.env
  if (Object.keys(envPatch).length > 0) {
    rewriteEnvKeys(envPath, envPatch);
  }

  // [SEA2] 历史回滚：变更入账（best-effort）
  if (Object.keys(historyKeys).length > 0) {
    try { appendHistory({ operator: opts.operator || 'system', keys: historyKeys }); } catch (e) { /* ignore */ }
  }

  return { ok: true, restartRequired, changed, applied };
}

/**
 * 泛化版 config.env 原地改写（与 trial.rewriteConfigEnv 同策略，但不限制键集合）。
 *  - 文件不存在 → 抛错（绝不新建，避免生成残缺 config.env 清空既有密钥）。
 *  - 逐行读取；匹配 `^\s*([A-Za-z_][A-Za-z0-9_]*)\s*="([^"]*)"\s*$` 的行若键在 patchMap → 替换为 KEY="value"。
 *  - 其余行（注释/空行/多行 PEM 等）原样保留，严禁整文件重建。
 *  - patchMap 中文件里不存在的键 → 追加到末尾。
 *  - 写回时保留原结尾换行。
 * @param {string} envPath 绝对路径
 * @param {object} patchMap { ENV_NAME: value }
 */
function rewriteEnvKeys(envPath, patchMap) {
  if (!fs.existsSync(envPath)) {
    throw new Error('config.env 不存在，拒绝新建以免清空既有密钥');
  }
  const text = fs.readFileSync(envPath, 'utf8');
  const lines = text.split(/\r?\n/);
  // 去掉 split 产生的末尾空串（它代表原结尾换行、并非内容行），
  // 避免每次改写都额外追加空行导致文件尾部空行不断累积。
  if (lines.length && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  const kvRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/;
  const touched = {};
  const out = lines.map((line) => {
    const mm = line.match(kvRe);
    if (mm && Object.prototype.hasOwnProperty.call(patchMap, mm[1])) {
      touched[mm[1]] = true;
      const v = String(patchMap[mm[1]]).replace(/"/g, '\\"');
      return `${mm[1]}="${v}"`;
    }
    return line; // 非目标键：原样保留（注释/空行/多行 PEM 不被破坏）
  });
  // 文件中不存在的被 patch 键，追加到末尾
  for (const k of Object.keys(patchMap)) {
    if (!touched[k]) out.push(`${k}="${String(patchMap[k]).replace(/"/g, '\\"')}"`);
  }
  fs.writeFileSync(envPath, out.join('\n') + '\n');
}

// ================= [SEA2 运维] 配置历史回滚 =================
function historyFile() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'config-history.jsonl');
}

/** 追加一条配置变更历史（best-effort） */
function appendHistory(entry) {
  try {
    const file = historyFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tsSec = Math.floor(Date.now() / 1000);
    const rec = {
      id: `cfg-${tsSec}-${Math.random().toString(16).slice(2, 8)}`,
      ts: new Date().toISOString(),
      tsSec,
      operator: (entry && entry.operator) || 'system',
      keys: (entry && entry.keys) || {},
    };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (e) {
    // best-effort
  }
}

/**
 * 读取配置变更历史（倒序）。
 * @param {number} [limit=50]
 * @returns {Array<object>}
 */
function readHistory(limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  try {
    const file = historyFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch (e) { /* skip */ }
    }
    rows.reverse();
    return rows.slice(0, n);
  } catch (e) {
    return [];
  }
}

/**
 * 回滚一次配置变更（把该次改动的每个键恢复为 before 值）。
 *  - fleet 键：fleetConfig.save({key: before})（热生效）；
 *  - env 键：rewriteEnvKeys(envPath, {ENV: before})（需重启后生效，接口如实标注）。
 * @param {string} id 历史记录 id
 * @param {string} [envPath] config.env 绝对路径
 * @returns {{ok:boolean, restored:string[], error?:string}}
 */
function rollbackHistory(id, envPath) {
  const file = historyFile();
  if (!file || !fs.existsSync(file)) return { ok: false, error: '无配置历史' };
  let entry = null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      if (o.id === String(id)) { entry = o; break; }
    } catch (e) { /* skip */ }
  }
  if (!entry) return { ok: false, error: '历史记录不存在' };

  const envPathActual = envPath || DEFAULT_ENV_PATH;
  const envPatch = {};
  const restored = [];
  for (const key of Object.keys(entry.keys || {})) {
    const before = (entry.keys[key] || {}).before;
    const field = SCHEMA.find((f) => f.key === key);
    if (field && field.fleet) {
      fleetConfig.save({ [key]: before });
      restored.push(key);
    } else if (field && field.deploy) {
      // [R4] 一键部署字段回滚：写回 deploy-config.json（热生效）
      deployConfig.save({ masterAddress: before });
      restored.push(key);
    } else if (field) {
      envPatch[field.env] = before;
      restored.push(key);
    }
  }
  if (Object.keys(envPatch).length > 0) {
    rewriteEnvKeys(envPathActual, envPatch);
  }
  return { ok: true, restored };
}

module.exports = {
  SCHEMA,
  readConfig,
  writeConfig,
  rewriteEnvKeys,
  DEFAULT_ENV_PATH,
  readHistory,
  rollbackHistory,
  historyFile,
};
