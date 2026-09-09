/**
 * SEA1 模块化机器人系统 - 主程序入口
 * 使用原生 fs.watch 实现自动热插拔
 */

const fs = require('fs');
const path = require('path');

// 统一的日志输出
function log(msg, level = 'INFO') {
    const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${time}] [${level}] [SEA1-Core] ${msg}`);
}

let pluginManager = null;
let config = null;
let db = null;
let watchers = [];

async function bootstrap() {
    log('--- SEA1 机器人系统正在启动 ---');

    try {
        // 1. 读取核心配置文件
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) {
            throw new Error('未找到核心配置文件 config.json');
        }
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        log(`全局配置加载成功。Bot名称: ${config.botName || '未命名'}`);

        // 2. 初始化 SQLite 数据库
        log('正在检测本地 SQLite 数据库健康状态...');
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = path.resolve(__dirname, config.database.path || './database/db.sqlite');
        
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                log(`数据库连接失败: ${err.message}`, 'FATAL');
                process.exit(1);
            }
            log('本地 SQLite 数据库连接成功。');
        });

        const runQuery = (sql) => new Promise((resolve, reject) => {
            db.run(sql, (err) => err ? reject(err) : resolve());
        });

        log('正在初始化/验证系统核心表结构...');
        await runQuery(`
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                activation_code TEXT,
                expire_time INTEGER,
                status INTEGER DEFAULT 1
            )
        `);
        await runQuery(`
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                permission_level INTEGER DEFAULT 0,
                username TEXT
            )
        `);
        log('数据库核心表验证完成。');

        // 2.5 用户权限层级管理系统：初始化权限服务（建 3 表 + 一次性存量迁移）并挂载到 global.sea1
        // 置于 pluginManager.init() 之前，保证插件加载期间即可用 global.sea1.permission。
        // 与 global.sea1.license 同模式；失败仅降级（消息鉴权回落 config 兜底），绝不阻断启动。
        global.sea1 = global.sea1 || { db, config };
        try {
            const { PermissionService } = require('./lib/permission');
            const permission = new PermissionService(config, db);
            const permReport = await permission.init();
            global.sea1.permission = permission;
            const migInfo = (permReport && permReport.skipped)
                ? '（已迁移过，跳过）'
                : `迁移 ${(permReport && permReport.migrated) || 0} 个账号`;
            log(`权限服务初始化完成：${migInfo}。`);

            // 2.6 启动 N4 权限桥接：导出快照 + 监听控制台命令信箱（供 activation-server 控制台读写管理员）
            // bot 始终是唯一写者，控制台仅追加命令到信箱，由本桥接落库，避免 SQLITE_BUSY 并发写竞争。
            try {
                const { startPermissionBridge } = require('./lib/permissionBridge');
                startPermissionBridge({ permission, config }).catch((e) => {
                    log(`权限桥接启动失败（控制台 QQ 登录将不可用，仅超管令牌可用）: ${e.message}`, 'WARN');
                });
                log('权限桥接（控制台 N4 客户端）已启动。');
            } catch (bridgeErr) {
                log(`权限桥接模块加载失败: ${bridgeErr.message}`, 'WARN');
            }
        } catch (permErr) {
            log(`权限服务初始化失败（消息鉴权将回落 config 兜底）: ${permErr.message}`, 'WARN');
        }

        // 3. 载入插件管理器
        log('正在引导插件管理器(支持优先级与热插拔)...');
        const PluginManagerClass = require('./core/plugin-manager');
        pluginManager = new PluginManagerClass(config, db);
        await pluginManager.init();

        // 挂载全局上下文（保留已挂载的 permission，避免覆盖）
        global.sea1 = Object.assign(global.sea1 || {}, { pluginManager, db, config });

        // ---- 授权门禁 LicenseGate（默认关闭，见 config.json → license.enabled）----
        const licCfg = (config.license && config.license.enabled) ? config.license : { enabled: false };
        try {
            const { LicenseGate } = require('./licensing');
            const gate = new LicenseGate(licCfg);
            global.sea1.license = gate.init();
            log('授权门禁初始化: ' + global.sea1.license.status);
        } catch (licErr) {
            log('授权门禁初始化失败，降级为开源放行模式: ' + licErr.message, 'WARN');
            global.sea1.license = {
                enabled: false, status: 'FALLBACK', active: true, degraded: false,
                checkFeature: () => true, isDegraded: () => false,
                middleware: () => ({ allow: true }),
                getStatus: () => ({ enabled: false, status: 'FALLBACK' }),
                startHeartbeat: () => {}, stopHeartbeat: () => {}
            };
        }

        log('插件管理器引导成功。');

        // 4. 启动 Web 服务
        log(`正在启动网页管理面板后台服务...`);
        const WebServerClass = require('./core/web-server');
        const webServer = new WebServerClass(config, db, pluginManager);
        await webServer.start();
        log(`网页端 UI 管理后台已成功挂载。`);

        // 5. 启动 QQ 适配器
        log('正在装载基础协议适配器...');
        const QQAdapterClass = require('./adapters/qq/index');
        const qqAdapter = new QQAdapterClass(config, pluginManager);
        await qqAdapter.connect();
        log('QQ 适配器服务连接成功。');

        // ==========================================
        // 5.5 [R9 R2/R3] 防互激发 botGuard + 双通道 channelManager（本地镜像 sea2-bot 入口）
        // ==========================================
        try {
            const { createBotGuard } = require('./lib/botGuard');
            const { createChannelManager } = require('./lib/channelManager');

            // ---- botGuard：限频/熔断/防互激发/自身消息过滤 ----
            // 配置热更：服务端 fleetConfig（机器人防互激发组）→ 运维下发 /root/sea2/run/botguard-cfg.json；
            // bot 每 30s 重读该文件（本地兜底默认值）。
            const botGuardCfgFile = process.env.SEA2_BOTGUARD_CFG || path.join(process.env.SEA2_RUN_DIR || '/root/sea2/run', 'botguard-cfg.json');
            let botGuardCfg = {};
            try {
                if (fs.existsSync(botGuardCfgFile)) botGuardCfg = JSON.parse(fs.readFileSync(botGuardCfgFile, 'utf8'));
            } catch (e) { botGuardCfg = {}; }
            const botGuard = createBotGuard({
                cfg: Object.assign({
                    botRateLimitPer5s: 3,
                    botBurstPer10s: 20,
                    botCircuitBreakSec: 60,
                    ownQq: process.env.SEA2_OWN_QQ || (config.self_qq || ''),
                }, botGuardCfg),
            });
            global.sea1.botGuard = botGuard;
            const botGuardReload = setInterval(() => {
                try {
                    if (fs.existsSync(botGuardCfgFile)) {
                        const fresh = JSON.parse(fs.readFileSync(botGuardCfgFile, 'utf8'));
                        if (fresh && typeof fresh === 'object') botGuard.setConfig(fresh);
                    }
                } catch (e) { /* 热更失败保持旧配置 */ }
            }, 30 * 1000);
            if (botGuardReload.unref) botGuardReload.unref();

            // ---- channelManager：双通道状态机 + 仲裁锁（进程内单例 + role 文件双保险）----
            const channelMgr = createChannelManager({
                mainUrl: process.env.SEA2_MAIN_NAPCAT_URL || 'http://127.0.0.1:4000',
                mainToken: process.env.SEA2_MAIN_NAPCAT_TOKEN || '',
                backupUrl: process.env.SEA2_BACKUP_NAPCAT_URL || 'http://127.0.0.1:3000',
                backupToken: process.env.SEA2_BACKUP_NAPCAT_TOKEN || '',
                roleFile: process.env.SEA2_ROLE_FILE || path.join(process.env.SEA2_RUN_DIR || '/root/sea2/run', 'framework.role'),
                heartbeatFile: process.env.SEA2_HEARTBEAT_FILE || path.join(process.env.SEA2_RUN_DIR || '/root/sea2/run', 'heartbeat.json'),
                probeIntervalMs: 5000,
                mainDownAfterMs: 30000,
                recoveringMs: 10000,
                recoverConsecutive: 3,
                ownQq: process.env.SEA2_OWN_QQ || (config.self_qq || ''),
            });
            global.sea1.channelManager = channelMgr;
            channelMgr.start();

            // 心跳表定时写入（含 circuitBroken；watchdog 依赖）
            const hbTimer = setInterval(() => {
                try {
                    channelMgr.writeHeartbeat(botGuard.circuitBroken());
                    // 群熔断告警：每群熔断触发一次（发送到通知群）
                    const gs = botGuard.state();
                    if (gs.circuits) {
                        for (const [cid, g] of Object.entries(gs.circuits)) {
                            if (g.broken && !g.alertSent && (config.notify_groups || []).includes(String(cid))) {
                                qqAdapter.send(cid, '⚠️ 群消息过载，已触发熔断，暂停回复 ' + g.brokenForSec + ' 秒', { groupId: cid }).catch(() => {});
                                botGuard.markAlertSent(cid);
                            }
                        }
                    }
                } catch (e) { /* 心跳/告警失败不影响主流程 */ }
            }, 5000);
            if (hbTimer.unref) hbTimer.unref();

            // ---- 发送闸门：插件回复前 botGuard 判断 + channelManager 仲裁锁 ----
            const origSend = qqAdapter.send.bind(qqAdapter);
            qqAdapter.send = async function (targetId, content, options) {
                try {
                    const chatId = (options && (options.groupId || options.group_id)) || targetId;
                    const guard = global.sea1 && global.sea1.botGuard;
                    // [ENG-4] 出站方向不携带发送者 QQ（发送对象是群/好友，非消息来源）：
                    // ownQq 回环过滤已由「适配器 shouldProcess(self_id===user_id)」与
                    // 「handleIncomingMessage 入站包装器（下方 ENG-4 拦截）」双层实现，此处 qq 恒空不参与 ownQq 判定。
                    // 若确有需要可经 options.senderQq 显式传入（如插件主动转发场景）。
                    if (guard && !guard.shouldSend(chatId, (options && options.senderQq) || '', content)) {
                        return { dropped: true, reason: 'botguard' };
                    }
                    const cm = global.sea1 && global.sea1.channelManager;
                    // sea2-bot 自身仅直连主通道（二进制 NapCat）；副通道（docker）激活时由 sea1 接管，本进程待命
                    if (cm && !cm.canSend('main')) {
                        return { dropped: true, reason: 'not-active-channel', channel: cm.getChannel(), role: cm.getRole() };
                    }
                } catch (e) { /* 守卫异常不阻断发送 */ }
                return origSend(targetId, content, options);
            };

            // ---- 框架指令轮询（role=bot）：unblock 熔断解除 + 切换指令回执 ----
            // 需配置 SEA2_SERVER_URL / SEA2_DEVICE_ID / SEA2_OPS_TOKEN 才启用；未配置静默跳过。
            const fwServerUrl = (process.env.SEA2_SERVER_URL || '').replace(/\/+$/, '');
            const fwDeviceId = process.env.SEA2_DEVICE_ID || '';
            const fwOpsToken = process.env.SEA2_OPS_TOKEN || '';
            if (fwServerUrl && fwDeviceId && fwOpsToken) {
                const fwPoll = async () => {
                    try {
                        const r = await fetch(fwServerUrl + '/api/ops/framework-cmd?deviceId=' + encodeURIComponent(fwDeviceId) + '&role=bot', {
                            headers: { 'x-ops-token': fwOpsToken },
                            signal: AbortSignal.timeout(8000),
                        });
                        const j = await r.json();
                        const cmds = (j && j.commands) || [];
                        if (!cmds.length) return;
                        const results = [];
                        for (const c of cmds) {
                            try {
                                if (c.action === 'unblock') {
                                    botGuard.reset();
                                    log('已执行框架指令 unblock（熔断解除）');
                                    results.push({ id: c.id, ok: true, result: 'unblocked' });
                                } else {
                                    results.push({ id: c.id, ok: false, error: 'bot 不处理进程级指令: ' + c.action });
                                }
                            } catch (e) {
                                results.push({ id: c.id, ok: false, error: String(e && e.message || e) });
                            }
                        }
                        await fetch(fwServerUrl + '/api/ops/framework-cmd/ack', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-ops-token': fwOpsToken },
                            body: JSON.stringify({ deviceId: fwDeviceId, results }),
                            signal: AbortSignal.timeout(8000),
                        });
                    } catch (e) { /* 轮询失败下周期重试 */ }
                };
                const fwTimer = setInterval(fwPoll, 10000);
                if (fwTimer.unref) fwTimer.unref();
                setTimeout(fwPoll, 3000);
            }

            // ---- 「切换框架」群命令（管理群/管理员校验 → 调服务端下发）----
            const origHandleIncoming = qqAdapter.handleIncomingMessage.bind(qqAdapter);
            qqAdapter.handleIncomingMessage = async function (raw, userId, groupId, message, db) {
                // [ENG-4] 入站自身消息回环过滤（defense-in-depth）：
                // 适配器 shouldProcess 已滤 self_id===user_id，此处用 botGuard.ownQq 再兜一层，
                // 保证 NapCat 回环自身消息（user_id===ownQq）不进入插件分发链。
                try {
                    const gGuard = global.sea1 && global.sea1.botGuard;
                    const gCfg = gGuard ? gGuard.state().cfg : {};
                    if (gCfg.ownQq && userId && String(userId) === String(gCfg.ownQq)) return;
                } catch (e) { /* 回环过滤失败不阻断分发 */ }
                try {
                    const text = String(message || '').trim();
                    const isSwitchCmd = /^切换(sea1|sea2|主框架|副框架|框架)$/i.test(text);
                    if (isSwitchCmd && groupId) {
                        const isAdmin = (() => {
                            try {
                                const perm = global.sea1 && global.sea1.permission;
                                if (perm && typeof perm.hasLevelSync === 'function') return perm.hasLevelSync(String(userId), 2);
                            } catch (e) { /* 权限库不可用走 config */ }
                            return String(userId) === String(config.superAdmin) || String(userId) === String(config.developer);
                        })();
                        const mgrGroups = (config.notify_groups || []).map((x) => String(x));
                        const SEA2_TEST_GROUP = process.env.SEA2_TEST_GROUP || '__PRINT_GROUP__';
                        if (!mgrGroups.includes(String(groupId)) || String(groupId) !== SEA2_TEST_GROUP) return origHandleIncoming(raw, userId, groupId, message, db);
                        if (!isAdmin) {
                            await origSend(String(config.superAdmin), '权限不足：仅管理员可切换框架（已私聊通知管理员）').catch(() => {});
                            return;
                        }
                        if (!(fwServerUrl && fwDeviceId && fwOpsToken)) {
                            await origSend(String(config.superAdmin), '未配置框架指令通道（SEA2_SERVER_URL/SEA2_DEVICE_ID/SEA2_OPS_TOKEN），无法切换').catch(() => {});
                            return;
                        }
                        let action = /sea1|备用/.test(text) ? 'to_sea1' : (/sea2|主用|主框架/.test(text) ? 'to_sea2' : (() => { try { const r = fs.readFileSync('/root/sea2/run/framework.role', 'utf8').trim(); return r === 'SEA1_ACTIVE' ? 'to_sea2' : 'to_sea1'; } catch (e) { return 'to_sea2'; } })());
                        const rr = await fetch(fwServerUrl + '/api/ops/framework-cmd/request', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-ops-token': fwOpsToken },
                            body: JSON.stringify({ deviceId: fwDeviceId, action }),
                            signal: AbortSignal.timeout(8000),
                        });
                        const jj = await rr.json();
                        // [SWITCH-NOTIFY] 记录发起群（sea1/sea2 共用），供重启通知私发管理员 + 发起群
                        if (jj && jj.ok) {
                            try {
                                fs.mkdirSync('/root/sea2/run', { recursive: true });
                                fs.writeFileSync('/root/sea2/run/last-switch-group.json', JSON.stringify({ groupId: String(groupId), ts: Date.now(), from: '群内' }));
                            } catch (e) { /* 标记写入失败不影响切换下发 */ }
                        }
                        await origSend(String(config.superAdmin), (jj && jj.ok) ? ('✅ 框架切换已下发：' + action + ' （watchdog 将执行，结果发送至管理员私聊）') : ('❌ 切换指令下发失败：' + ((jj && jj.error) || '未知错误')), { userId: String(config.superAdmin) }).catch(() => {});
                        return;
                    }
                } catch (e) { /* 命令解析失败继续分发 */ }
                return origHandleIncoming(raw, userId, groupId, message, db);
            };
            log('botGuard + channelManager 已挂载（role=' + channelMgr.getRole() + '）');
        } catch (guardErr) {
            log('botGuard/channelManager 挂载失败（不影响主流程）: ' + guardErr.message, 'WARN');
        }

        // ==========================================
        // 5.6 [R9 R4/ENG-1] 本地打印任务服务（127.0.0.1:13012，qr-server /api/webprint/tasks 转发目标）
        // 复用 plugins/print.printFile（CUPS）；队列/上传目录默认 /root/sea2/webprint/。
        // [独立化改造 2026-08-08] WEB 打印服务已拆分为 pm2 常驻 sea2-print-server
        // （print-server-standalone.js，SEA1/SEA2 双模式均可用）：
        //   - 若 13012 已有服务监听（独立进程在跑）→ 跳过内嵌启动，静默复用；
        //   - 否则回落原内嵌启动（兼容旧部署 / 独立进程未启动）。
        // ==========================================
        const seaPrintPort = parseInt(process.env.SEA2_PRINT_SERVER_PORT || '13012', 10) || 13012;
        const standalonePrintActive = await (async () => {
            try {
                const net = require('node:net');
                return await new Promise((resolve) => {
                    const sock = net.connect({ host: '127.0.0.1', port: seaPrintPort });
                    const done = (v) => { try { sock.destroy(); } catch (e) { /* ignore */ } resolve(v); };
                    sock.once('connect', () => done(true));
                    sock.once('error', () => done(false));
                    sock.setTimeout(1500, () => done(false));
                });
            } catch (e) {
                return false;
            }
        })();
        if (standalonePrintActive) {
            log('检测到独立本地打印服务(' + seaPrintPort + ')运行中，跳过内嵌启动');
        } else {
            try {
                const { createPrintServer } = require('./lib/printServer');
                const printServer = createPrintServer({
                    port: seaPrintPort,
                    host: '127.0.0.1',
                    queueFile: process.env.SEA2_WEBPRINT_QUEUE || '/root/sea2/webprint/queue.json',
                    uploadDir: process.env.SEA2_WEBPRINT_UPLOADS || '/root/sea2/webprint/uploads',
                    // 复用 print 插件导出（懒加载单例；失败不会阻断启动，worker 会在执行时报 failed）
                    printFile: (opts) => require('./plugins/print').printFile(opts),
                });
                global.sea1.printServer = printServer;
                await printServer.start();
                log('本地打印服务已启动（127.0.0.1:' + (printServer.getServer() ? printServer.getServer().address().port : 13012) + '）');
                // TTL 清理（24h；每小时巡检）
                const wpCleanup = setInterval(() => {
                    try { printServer.cleanupExpired(); } catch (e) { /* best-effort */ }
                }, 60 * 60 * 1000);
                if (wpCleanup.unref) wpCleanup.unref();
            } catch (printErr) {
                log('本地打印服务启动失败（Web 打印暂不可用，不影响主流程）: ' + printErr.message, 'WARN');
            }
        }

        // ---- 试用到期主动提醒（仅门禁状态=TRIAL_EXPIRED 时触发；每小时巡检、只发一次）----
        try {
            const { maybeSendTrialReminder } = require('./licensing/trial-reminder');
            const remindTick = async () => {
                try {
                    await maybeSendTrialReminder({
                        gate: global.sea1.license,
                        send: (id, text, o) => qqAdapter.send(id, text, o),
                        notifyGroups: config.notify_groups || [],
                        superAdmin: config.superAdmin,
                        cfg: licCfg,
                    });
                } catch (e) { /* 提醒失败绝不影响主流程 */ }
            };
            const remindTimer = setInterval(remindTick, 60 * 60 * 1000);
            if (remindTimer.unref) remindTimer.unref();
            setTimeout(remindTick, 8000); // 启动后稍等适配器稳定再巡检一次
            log('试用到期提醒定时器已挂载（每小时巡检，仅到期时推送一次）。');
        } catch (remErr) {
            log('试用提醒定时器挂载失败（不影响主流程）: ' + remErr.message, 'WARN');
        }

        // ==========================================
        // 6. 自动热插拔：使用原生 fs.watch
        // ==========================================
        log('正在启动自动热插拔监听器 (原生 fs.watch)...');
        const pluginsDir = path.join(__dirname, 'plugins');
        
        if (fs.existsSync(pluginsDir)) {
            // 防抖映射
            const debounceTimers = {};
            
            // 递归监听所有子目录
            function watchDirectory(dir) {
                try {
                    const watcher = fs.watch(dir, { recursive: false }, (eventType, filename) => {
                        if (!filename) return;
                        
                        // 只监听 index.js 文件
                        if (filename !== 'index.js') return;
                        
                        const filePath = path.join(dir, filename);
                        if (!fs.existsSync(filePath)) return;
                        
                        const pluginName = path.basename(dir);
                        
                        // 防抖：避免多次触发
                        if (debounceTimers[pluginName]) {
                            clearTimeout(debounceTimers[pluginName]);
                        }
                        
                        debounceTimers[pluginName] = setTimeout(async () => {
                            log(`[热插拔] 检测到插件 [${pluginName}] 文件变化，正在自动重载...`);
                            try {
                                // 清除 require 缓存
                                const resolvedPath = require.resolve(filePath);
                                if (require.cache[resolvedPath]) {
                                    delete require.cache[resolvedPath];
                                }
                                
                                // 重新加载插件
                                await pluginManager.reloadPlugin(pluginName);
                                log(`[热插拔] ✅ 插件 [${pluginName}] 自动重载成功`);
                            } catch (err) {
                                log(`[热插拔] ❌ 插件 [${pluginName}] 重载失败: ${err.message}`, 'ERROR');
                            }
                            delete debounceTimers[pluginName];
                        }, 500);
                    });
                    
                    watchers.push(watcher);
                    
                    // 递归监听子目录
                    const items = fs.readdirSync(dir);
                    for (const item of items) {
                        const itemPath = path.join(dir, item);
                        if (fs.statSync(itemPath).isDirectory()) {
                            watchDirectory(itemPath);
                        }
                    }
                } catch (err) {
                    // 忽略权限错误
                }
            }
            
            watchDirectory(pluginsDir);
            log('自动热插拔监听器已启动 ✅');
            log('?? 修改 plugins/*/index.js 后 0.5 秒自动生效，无需重启');
        }

        log('=== SEA1 系统引导完毕，当前运行状态：[优秀] ===');

    } catch (error) {
        log(`系统引导过程中发生致命错误: ${error.message}`, 'FATAL');
        log('启动失败，触发自愈防护，即将在 3 秒后安全退出...', 'WARN');
        
        try {
            fs.writeFileSync(path.join(__dirname, 'database/crash.log'), `${new Date().toISOString()}: ${error.stack}`);
        } catch (e) {}
        
        setTimeout(() => {
            process.exit(1); 
        }, 3000);
    }
}

// 优雅退出时清理 watcher
process.on('SIGINT', () => {
    log('收到 SIGINT 信号，正在清理...');
    for (const watcher of watchers) {
        try { watcher.close(); } catch (e) {}
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('收到 SIGTERM 信号，正在清理...');
    for (const watcher of watchers) {
        try { watcher.close(); } catch (e) {}
    }
    process.exit(0);
});

// 拦截全局未捕获异常
process.on('uncaughtException', (err) => {
    log(`捕获到未处理的致命异常: ${err.message}`, 'FATAL');
    console.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`捕获到未处理的 Promise 拒绝事件`, 'FATAL');
    console.error(reason);
});

bootstrap();
