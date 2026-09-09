/**
 * SEA1 插件：sys-config
 * 职责：提供超级管理员在线重载、载入、卸载其他插件的热插拔管理指令
 */

const BasePlugin = require('../base-plugin');

class SysConfigPlugin extends BasePlugin {
    constructor(name, config) {
        super(name, config);
        // 系统管理级：高优先级，且限超级管理员及以上触发
        this.priority = 10;
        this.permissionLevel = 2;
    }

    async onEnable(db) {
        console.log(`[sea1] [Plugin-SysConfig] 核心控制插件已加载。`);
    }

    async onMessage(context) {
        const text = context.msg;

        // 1. 指令：#重载 [插件名]
        if (text.startsWith('#重载 ')) {
            const pluginName = text.replace('#重载 ', '').trim();
            try {
                await context.reply(`[SEA1] 正在尝试热重载插件 [${pluginName}]...`);
                
                // 从全局对象直接获取 pluginManager 实例进行热重载
                if (global.sea1 && global.sea1.pluginManager) {
                    await global.sea1.pluginManager.reloadPlugin(pluginName);
                    await context.reply(`✅ 插件 [${pluginName}] 已成功重载并重新应用优先级排序！`);
                } else {
                    await context.reply(`❌ 重载失败：无法获取全局插件管理器实例。`);
                }
            } catch (err) {
                await context.reply(`❌ 重载失败：${err.message}`);
            }
            return true; // 拦截此消息，不让后续低优先级业务插件收到
        }

        // 2. 指令：#卸载 [插件名]
        if (text.startsWith('#卸载 ')) {
            const pluginName = text.replace('#卸载 ', '').trim();
            try {
                if (global.sea1 && global.sea1.pluginManager) {
                    await global.sea1.pluginManager.unloadPlugin(pluginName);
                    await context.reply(`✅ 插件 [${pluginName}] 已安全卸载，内存缓存已清理。`);
                } else {
                    await context.reply(`❌ 卸载失败：无法获取全局插件管理器。`);
                }
            } catch (err) {
                await context.reply(`❌ 卸载失败：${err.message}`);
            }
            return true;
        }

        return false;
    }
}

module.exports = SysConfigPlugin;
