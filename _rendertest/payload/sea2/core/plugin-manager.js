/**
 * SEA1 模块化机器人系统 - 插件管理器 (Core Engine)
 * 职责：插件动态扫描、热加载、热卸载、优先级排序、权限验证以及拦截链消息分发
 */

const fs = require('fs');
const path = require('path');

class PluginManager {
    /**
     * @param {Object} config 全局配置信息
     * @param {Object} db SQLite 数据库连接实例
     */
    constructor(config, db) {
        this.config = config;
        this.db = db;
        this.plugins = []; // 存放当前处于激活状态的插件实例队列
        this.pluginsDir = path.join(__dirname, '../plugins');
    }

    // 初始化：自动装载所有默认启用的业务插件
    async init() {
        console.log('[sea1] [PluginManager] 正在扫描 plugins/ 目录进行自动加载...');
        if (!fs.existsSync(this.pluginsDir)) {
            fs.mkdirSync(this.pluginsDir, { recursive: true });
        }

        const files = fs.readdirSync(this.pluginsDir);
        for (const file of files) {
            const pluginPath = path.join(this.pluginsDir, file);
            
            // 过滤：必须是文件夹，且排除了基类 base-plugin.js
            if (fs.statSync(pluginPath).isDirectory()) {
                const indexFile = path.join(pluginPath, 'index.js');
                if (fs.existsSync(indexFile)) {
                    try {
                        await this.loadPlugin(file);
                    } catch (err) {
                        console.error(`[sea1] [PluginManager] 自动加载插件 [${file}] 失败: ${err.message}`);
                    }
                }
            }
        }
        console.log(`[sea1] [PluginManager] 自动加载完成，当前活跃插件数: ${this.plugins.length}`);
    }

    /**
     * 动态加载插件（热插拔的核心实现）
     * @param {string} pluginName 插件目录名称
     */
    async loadPlugin(pluginName) {
        const pluginPath = path.join(this.pluginsDir, pluginName, 'index.js');
        if (!fs.existsSync(pluginPath)) {
            throw new Error(`找不到插件入口文件: ${pluginPath}`);
        }

        // 1. 检查是否已经加载过，防止重复注册
        if (this.plugins.some(p => p.name === pluginName)) {
            throw new Error(`插件 [${pluginName}] 已经处于加载运行状态`);
        }

        try {
            // 2. 动态加载模块（如果是热更新，这里之前要清理缓存）
            const PluginClass = require(pluginPath);
            const instance = new PluginClass(pluginName, this.config);

            // 3. 运行插件内部的初始化/启用钩子
            if (typeof instance.onEnable === 'function') {
                await instance.onEnable(this.db);
            }

            // 4. 将实例注册入内存，并立即启动【优先级重排序机制】
            this.plugins.push(instance);
            this.sortPlugins();

            console.log(`[sea1] [PluginManager] 成功载入插件: [${pluginName}] (优先级: ${instance.priority || 50}, 权限级别: ${instance.permissionLevel || 0})`);
            return true;
        } catch (err) {
            // 容错：加载失败时清理引用，防止内存泄漏
            this.plugins = this.plugins.filter(p => p.name !== pluginName);
            throw err;
        }
    }

    /**
     * 动态卸载插件
     * @param {string} pluginName 插件目录名称
     */
    async unloadPlugin(pluginName) {
        const index = this.plugins.findIndex(p => p.name === pluginName);
        if (index === -1) {
            throw new Error(`插件 [${pluginName}] 当前未处于运行状态`);
        }

        const instance = this.plugins[index];
        try {
            // 1. 执行插件卸载/清理钩子
            if (typeof instance.onDisable === 'function') {
                await instance.onDisable(this.db);
            }

            // 2. 从内存数组中移除
            this.plugins.splice(index, 1);

            // 3. 彻底清除 Node.js 模块 require 缓存，以便下次加载时读入全新代码
            const pluginPath = path.join(this.pluginsDir, pluginName, 'index.js');
            const resolvedPath = require.resolve(pluginPath);
            if (require.cache[resolvedPath]) {
                delete require.cache[resolvedPath];
            }

            console.log(`[sea1] [PluginManager] 成功卸载/热拔插移除插件: [${pluginName}]`);
            return true;
        } catch (err) {
            throw new Error(`卸载插件失败: ${err.message}`);
        }
    }

    /**
     * 重载插件（即热更新，先卸载后重新装载）
     */
    async reloadPlugin(pluginName) {
        console.log(`[sea1] [PluginManager] 正在重载插件 [${pluginName}]...`);
        try {
            await this.unloadPlugin(pluginName);
        } catch (e) {
            // 忽略“插件未运行”的错误，允许直接装载新写的插件
        }
        return await this.loadPlugin(pluginName);
    }

    /**
     * 优先级重排序机制 (升序排序：数值越小，越优先处理)
     */
    sortPlugins() {
        this.plugins.sort((a, b) => {
            const prioA = a.priority !== undefined ? a.priority : 50;
            const prioB = b.priority !== undefined ? b.priority : 50;
            return prioA - prioB;
        });
    }

    /**
     * 核心拦截链消息分发驱动
     * @param {Object} context 适配器接收到的消息上下文（包含消息内容、发送者ID、发送者权限等）
     */
    async dispatchMessage(context) {
        // 遍历已被优先级排序（从高到低）的活跃插件列表
        for (const plugin of this.plugins) {
            try {
                // 1. 拦截级权限过滤（如果用户当前权限等级低于该插件所需限制，跳过）
                const userPermission = context.userPermission || 0;
                const requiredPermission = plugin.permissionLevel || 0;
                if (userPermission < requiredPermission) {
                    continue; 
                }

                // 1.5 授权门禁（LicenseGate）：默认关闭时无感；开启后按 feature 拦截未授权插件
                try {
                    const gate = global.sea1 && global.sea1.license;
                    if (gate && typeof gate.middleware === 'function') {
                        const fr = gate.middleware(plugin.feature || plugin.name);
                        if (!fr.allow) {
                            if (typeof plugin.onFeatureDenied === 'function') {
                                await plugin.onFeatureDenied(context, fr.reason);
                            }
                            continue;
                        }
                    }
                } catch (gateErr) {
                    // 门禁异常绝不影响消息分发
                }

                // 2. 将消息投递给插件的事件接口
                if (typeof plugin.onMessage === 'function') {
                    const isIntercepted = await plugin.onMessage(context);

                    // 3. 优先级拦截机制：如果高优先级插件处理后返回了 true，直接阻断后续低优先级插件的执行
                    if (isIntercepted === true) {
                        console.log(`[sea1] [PluginManager] 消息在 [Priority: ${plugin.priority}] 的插件 [${plugin.name}] 处被强行拦截，阻断后续分发。`);
                        break;
                    }
                }
            } catch (err) {
                console.error(`[sea1] [PluginManager] 插件 [${plugin.name}] 内部执行出错:`, err);
                // 容错隔离：某个插件崩溃，不影响其他高低优先级插件正常运行
            }
        }
    }
}

module.exports = PluginManager;
