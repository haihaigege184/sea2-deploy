/**
 * SEA1 模块化机器人系统 - 插件基类 (Base Class)
 * 职责：定义标准插件生命周期、默认优先级与权限标识，提供插件层核心辅助 API
 */

class BasePlugin {
    /**
     * @param {string} name 插件唯一名称
     * @param {Object} config 全局配置信息
     */
    constructor(name, config = {}) {
        this.name = name;
        this.config = config;

        // 1. 优先级系统（数值越小越优先，1为最高，默认业务级为 50）[span_2](start_span)[span_2](end_span)[span_3](start_span)[span_3](end_span)
        this.priority = 50; 

        // 2. 所需权限级别要求[span_4](start_span)[span_4](end_span)[span_5](start_span)[span_5](end_span)
        // 0: 普通用户 (Default)
        // 1: 管理员 (Admin)
        // 2: 超级管理员 (SuperAdmin)[span_6](start_span)[span_6](end_span)
        // 3: 开发者 (Developer)[span_7](start_span)[span_7](end_span)
        this.permissionLevel = 0; 
    }

    /**
     * 插件启用生命周期钩子（当插件被 PluginManager 成功载入时触发）[span_8](start_span)[span_8](end_span)
     * @param {Object} db SQLite 数据库连接实例[span_9](start_span)[span_9](end_span)
     */
    async onEnable(db) {
        // 子类可重写，用于初始化插件特有的数据库表或异步读取本地缓存
    }

    /**
     * 插件禁用生命周期钩子（当插件被卸载/重载时触发）[span_10](start_span)[span_10](end_span)
     * @param {Object} db SQLite 数据库连接实例[span_11](start_span)[span_11](end_span)
     */
    async onDisable(db) {
        // 子类可重写，用于释放定时器、断开外部长连接等清理工作
    }

    /**
     * 核心事件：当机器人接收到群聊或私聊消息时触发[span_12](start_span)[span_12](end_span)
     * @param {Object} context 消息上下文
     * @param {string} context.msg 接收到的消息文本
     * @param {string} context.userId 发送者账号/ID
     * @param {number} context.userPermission 发送者当前权限级别
     * @param {function} context.reply 便捷回复函数，例如：await context.reply("内容")
     * @returns {Promise<boolean>} 如果返回 true，代表消息在此处被【强制拦截】，阻断后续低优先级插件接收此消息[span_13](start_span)[span_13](end_span)[span_14](start_span)[span_14](end_span)
     */
    async onMessage(context) {
        return false; // 默认不拦截消息，继续向下流转[span_15](start_span)[span_15](end_span)
    }

    /**
     * 授权门禁拒绝本插件功能时触发（默认实现）。
     * 仅当 LicenseGate 开启且某一 feature 被拦截时，由 PluginManager 调用；
     * 子类可重写以定制话术（vip 插件已重写）。默认行为：友好提示用户去开通会员解锁，
     * 避免「命令石沉大海」造成困惑。只读白名单(menu/help/queue/status/ping/vip)永不被拦，故不触发。
     * @param {Object} context 消息上下文（含 context.reply）
     * @param {string} reason 'feature-disabled' | 'read-only-mode'
     */
    async onFeatureDenied(context, reason) {
        try {
            const text = [
                '🔒 该功能当前不可用',
                '您的免费试用已结束或授权未激活，机器人已进入只读模式。',
                '发送「开通会员」→ 扫码付款 → 发「已支付 <订单号>」即可自动解锁全部功能。',
            ].join('\n');
            if (context && typeof context.reply === 'function') {
                await context.reply(text);
            }
        } catch (e) { /* 兜底：提醒失败不影响主流程与分发链 */ }
    }

    /**
     * 【安全辅助方法】便捷检查用户是否拥有指定权限
     * @param {Object} context 消息上下文
     * @param {number} targetLevel 期望达到的目标权限等级[span_16](start_span)[span_16](end_span)[span_17](start_span)[span_17](end_span)
     * @returns {boolean}
     */
    hasPermission(context, targetLevel) {
        const userLevel = context.userPermission || 0;
        return userLevel >= targetLevel;
    }
}

module.exports = BasePlugin;
