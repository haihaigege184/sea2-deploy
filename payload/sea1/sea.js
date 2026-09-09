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

        // ---- [2026-08-08] 「切换框架」群指令（sea1 副框架版：仅 Sea print 群响应 + 结果私发管理员）----
        try {
            // sea1 无 pm2 env 注入 SEA2_* ，读 /root/sea2/napcat/ops.env 兑底
            const _fwEnv = (() => {
                const get = (k, d) => process.env[k] || d;
                let url = get('SEA2_SERVER_URL', '');
                let did = get('SEA2_DEVICE_ID', '');
                let tok = get('SEA2_OPS_TOKEN', '');
                if (!(url && did && tok)) {
                    try {
                        const raw = fs.readFileSync('/root/sea2/napcat/ops.env', 'utf8');
                        for (const line of raw.split(String.fromCharCode(10))) {
                            const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
                            if (!m) continue;
                            if (m[1] === 'SEA2_SERVER_URL' && !url) url = m[2].trim();
                            if (m[1] === 'SEA2_DEVICE_ID' && !did) did = m[2].trim();
                            if (m[1] === 'SEA2_OPS_TOKEN' && !tok) tok = m[2].trim();
                        }
                    } catch (e) { /* ops.env 缺失无扩展 */ }
                }
                return { url: url.replace(/\/+$/, ''), did, tok };
            })();
            const SEA2_TEST_GROUP = process.env.SEA2_TEST_GROUP || '__PRINT_GROUP__';
            const _origHandle = qqAdapter.handleIncomingMessage.bind(qqAdapter);
            qqAdapter.handleIncomingMessage = async function (raw, userId, groupId, message, db) {
                try {
                    const text = String(message || '').trim();
                    const isSwitchCmd = /^切换(sea1|sea2|主框架|副框架|框架)$/i.test(text);
                    if (isSwitchCmd && groupId) {
                        const isAdmin = String(userId) === String(config.superAdmin) || String(userId) === String(config.developer);
                        if (String(groupId) !== SEA2_TEST_GROUP || !isAdmin) return _origHandle(raw, userId, groupId, message, db);
                        if (!(_fwEnv.url && _fwEnv.did && _fwEnv.tok)) {
                            await qqAdapter.send(String(config.superAdmin), '未配置框架指令通道（SEA2_SERVER_URL/SEA2_DEVICE_ID/SEA2_OPS_TOKEN），无法切换').catch(() => {});
                            return;
                        }
                        let action = /sea1|备用/.test(text) ? 'to_sea1' : (/sea2|主用|主框架/.test(text) ? 'to_sea2' : (() => { try { const r = fs.readFileSync('/root/sea2/run/framework.role', 'utf8').trim(); return r === 'SEA1_ACTIVE' ? 'to_sea2' : 'to_sea1'; } catch (e) { return 'to_sea2'; } })());
                        try {
                            const rr = await fetch(_fwEnv.url + '/api/ops/framework-cmd/request', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-ops-token': _fwEnv.tok },
                                body: JSON.stringify({ deviceId: _fwEnv.did, action }),
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
                            await qqAdapter.send(String(config.superAdmin), (jj && jj.ok) ? ('✅ 框架切换已下发：' + action + ' （watchdog 将执行）') : ('❌ 切换指令下发失败：' + ((jj && jj.error) || '未知错误')), { userId: String(config.superAdmin) }).catch(() => {});
                        } catch (e) {
                            await qqAdapter.send(String(config.superAdmin), '❌ 切换指令下发失败：' + (e && e.message || e)).catch(() => {});
                        }
                        return;
                    }
                } catch (e) { /* 解析失败继续分发 */ }
                return _origHandle(raw, userId, groupId, message, db);
            };
            log('sea1 切换框架指令已挂载（仅 Sea print 群）');
        } catch (fwErr) {
            log('sea1 切换指令挂载失败（不影响主流程）: ' + fwErr.message, 'WARN');
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
