/**
 * SEA1 机器人系统 - 适配器基类
 * 职责：定义标准通信接口，统一消息分发与权限注入
 */

class BaseAdapter {
    /**
     * @param {string} platform 平台标识 (如 'qq', 'wx')
     * @param {Object} config 全局配置
     * @param {Object} pluginManager 插件管理器实例
     */
    constructor(platform, config, pluginManager) {
        this.platform = platform;
        this.config = config;
        this.pluginManager = pluginManager;
    }

    /**
     * 连接方法（由子类具体实现）
     */
    async connect() {
        throw new Error('connect() 必须由子类适配器实现');
    }

    /**
     * 断开连接方法（由子类具体实现）
     */
    async disconnect() {
        throw new Error('disconnect() 必须由子类适配器实现');
    }

    /**
     * 统一发送接口（由子类具体实现）
     */
    async send(targetId, content, options = {}) {
        throw new Error('send() 必须由子类适配器实现');
    }

    /**
     * 接收消息的统一分发入口：自动查库注入权限、包装智能回复
     */
    async handleIncomingMessage(raw, userId, groupId, message, db) {
        // 1. 默认权限等级：0 (普通用户)
        let permissionLevel = 0;

        // 2. 校验是否是超级管理员或开发者
        if (this.config.superAdmin && String(userId) === String(this.config.superAdmin)) {
            permissionLevel = 2;
        } else if (this.config.developer && String(userId) === String(this.config.developer)) {
            permissionLevel = 2;
        }

        // 3. 构建规范化的上下文 context
        const context = {
            platform: this.platform,
            userId,
            groupId,
            msg: message,
            permissionLevel,
            raw,
            reply: async (text, options = {}) => {
                if (groupId) {
                    return this.send(userId, text, { groupId, ...options });
                } else {
                    return this.send(userId, text, options);
                }
            }
        };

        // 4. 送入插件管理器，进行链式拦截过滤（🌟 已完美对齐为 dispatchMessage）
        if (this.pluginManager) {
            await this.pluginManager.dispatchMessage(context);
        }
    }
}

module.exports = BaseAdapter;
