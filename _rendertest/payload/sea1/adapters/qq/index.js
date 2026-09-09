/**
 * SEA1 模块化机器人系统 - QQ (NapCat OneBot11) 协议适配器
 * 职责：建立反向 WS 监听、标准化通信协议转换、事件上报至优先级拦截链
 */

const fs = require('fs');
const WebSocket = require('ws');
const BaseAdapter = require('../base-adapter');

class NapcatAdapter extends BaseAdapter {
    constructor(config, pluginManager) {
        super('qq', config, pluginManager);
        this.wss = null;
        this.clientWs = null;
        this.seqId = 0;
        this.pending = new Map();
    }

    log(msg, level = 'INFO') {
        const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
        console.log(`[${time}] [${level}] [Adapter-QQ] ${msg}`);
    }

    async connect() {
        const port = this.config.ws_port || 9092;
        const path = this.config.ws_path || '/api/bot/qqws';

        return new Promise((resolve, reject) => {
            try {
            this.wss = new WebSocket.Server({ port, path }, () => {
                this.log(`反向 WS 服务端已在端口 ${port} 成功启动! 监听路径: ${path}`);
                // 暴露适配器实例给插件（主动私聊通道），最小改动（与 global.sea1 兼容）
                global.sea1 = global.sea1 || {};
                global.sea1.adapter = this;
                resolve();
            });

                this.wss.on('connection', (ws, req) => {
                    const remote = req.socket.remoteAddress;
                    this.log(`NapCatQQ 客户端成功连入 (来自: ${remote})`);
                    this.clientWs = ws;

                    setTimeout(() => {
                        this.sendRebootNotification();
                    }, 5000);

                    ws.on('message', async (data) => {
                        try {
                            const rawText = data.toString();
                            const obj = JSON.parse(rawText);

                            if (obj.echo && this.pending.has(obj.echo)) {
                                const { resolve: apiResolve, timer } = this.pending.get(obj.echo);
                                clearTimeout(timer);
                                this.pending.delete(obj.echo);

                                if (obj.status === 'ok' || obj.retcode === 0) {
                                    apiResolve(obj);
                                } else {
                                    this.log(`API执行反馈失败: ${obj.message || '未知'} (echo: ${obj.echo})`, 'WARN');
                                    apiResolve({ status: 'failed', message: obj.message, retcode: obj.retcode });
                                }
                                return;
                            }

                            if (!this.shouldProcess(obj)) return;

                            const normalized = this.normalize(obj);

                            if (this.pluginManager && this.pluginManager.db) {
                                await this.handleIncomingMessage(
                                    obj,
                                    normalized.userId,
                                    normalized.groupId,
                                    normalized.message,
                                    this.pluginManager.db
                                );
                            } else {
                                await this.handleIncomingMessage(obj, normalized.userId, normalized.groupId, normalized.message, null);
                            }

                        } catch (e) {
                            this.log(`处理 NapCat 消息时发生内部错误: ${e.message}`, 'ERROR');
                        }
                    });

                    ws.on('close', (code) => {
                        this.log(`NapCatQQ 客户端断开连接 (状态码: ${code})`, 'WARN');
                        this.clientWs = null;
                        this.clearPendingTimers();
                    });

                    ws.on('error', (err) => {
                        this.log(`WS 客户端连接出错: ${err.message}`, 'ERROR');
                    });
                });

                this.wss.on('error', (err) => {
                    this.log(`反向 WS 服务监听失败: ${err.message}`, 'FATAL');
                    reject(err);
                });

            } catch (e) {
                this.log(`WS 启动逻辑发生致命崩盘: ${e.message}`, 'FATAL');
                reject(e);
            }
        });
    }

    async sendRebootNotification() {
        try {
            const admin = this.config.superAdmin;
            const sys = this.config.sysName || 'SEA1';
            if (!admin) {
                this.log('重启成功通知未下发（未配置 superAdmin）。');
                return;
            }
            // [SWITCH-NOTIFY] 读取「切换框架」发起群标记（sea1/sea2 共用 /root/sea2/run/last-switch-group.json）：
            //   群内指令 → 私发管理员 + 发送到发起群；非群内/过期/无标记 → 仅私发管理员。
            const markerPath = '/root/sea2/run/last-switch-group.json';
            let marker = null;
            try {
                if (fs.existsSync(markerPath)) {
                    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
                }
            } catch (e) { /* 标记文件损坏按无处理 */ }
            const now = Date.now();
            const markerTs = Number(marker && marker.ts || 0);
            const fresh = !!(marker && marker.from === '群内' && marker.groupId && markerTs > 0 &&
                (now - markerTs) <= 10 * 60 * 1000);
            if (fresh) {
                await this.send(admin, '🌊 ' + sys + ' 模块化系统重启成功 (新内核已载入，仅私发管理员)。');
                await this.send(String(marker.groupId), '🌊 ' + sys + ' 模块化系统重启成功，已切换完成，系统恢复正常。', { groupId: String(marker.groupId) });
                try { fs.unlinkSync(markerPath); } catch (e) { /* 删除失败不影响通知 */ }
                this.log(`重启成功通知已下发：管理员 + 发起群 ${marker.groupId}。`);
            } else {
                // 兜底：仅私发管理员（非群内触发 / 标记过期 / 无标记）
                await this.send(admin, '🌊 ' + sys + ' 模块化系统重启成功 (新内核已载入，仅私发管理员)。');
                if (marker && markerTs > 0 && (now - markerTs) > 10 * 60 * 1000) {
                    try { fs.unlinkSync(markerPath); } catch (e) { /* 过期标记清理失败忽略 */ }
                }
                this.log('重启成功通知已成功下发（仅管理员）。');
            }
        } catch (e) {
            this.log(`推送重启通知失败: ${e.message}`, 'WARN');
        }
    }

    async disconnect() {
        if (this.wss) {
            this.wss.close();
            this.log('反向 WS 服务已安全停止并卸载。');
        }
    }

    shouldProcess(raw) {
        if (raw.post_type === 'meta_event') return false;
        if (raw.status === 'ok' && raw.retcode !== undefined && !raw.echo) return false;
        if (raw.self_id && raw.user_id && String(raw.self_id) === String(raw.user_id)) return false;
        if (!raw.message && raw.post_type !== 'message') return false;
        return true;
    }

    normalize(raw) {
        let text = '';
        const attachments = [];
        let message = raw.message || '';

        if (Array.isArray(message)) {
            for (const seg of message) {
                if (seg.type === 'text') {
                    text += seg.data.text;
                } else if (seg.type === 'image') {
                    let cq = `[CQ:image,file=${seg.data.file}`;
                    if (seg.data.url) cq += `,url=${seg.data.url}`;
                    cq += ']';
                    text += cq;
                    attachments.push({ type: 'image', file: seg.data.file, url: seg.data.url || '' });
                } else if (seg.type === 'file') {
                    let cq = `[CQ:file,file=${seg.data.file}`;
                    if (seg.data.url) cq += `,url=${seg.data.url}`;
                    cq += ']';
                    text += cq;
                    attachments.push({ type: 'file', file: seg.data.file, url: seg.data.url || '' });
                } else {
                    text += JSON.stringify(seg);
                }
            }
        } else {
            text = String(message);
            const imgRe = /\[CQ:image,file=([^,\]]+)(?:,url=([^\]]+))?\]/g;
            let m;
            while ((m = imgRe.exec(text)) !== null) {
                attachments.push({ type: 'image', file: m[1], url: m[2] || '' });
            }
        }

        return {
            userId: String(raw.user_id || ''),
            groupId: raw.group_id ? String(raw.group_id) : null,
            message: text,
            attachments
        };
    }

    async send(targetId, content, options = {}) {
        const echo = String(++this.seqId);

        let message;
        if (options.type === 'image') {
            message = [{ type: 'image', data: { file: `base64://${content}` } }];
        } else {
            message = content;
        }

        let params = {};
        if (options.groupId || options.group_id) {
            params.group_id = Number(options.groupId || options.group_id);
            params.message = message;
        } else {
            params.user_id = Number(targetId);
            params.message = message;
        }

        return this.wsSend({
            action: 'send_msg',
            params: params,
            echo: echo
        });
    }

    wsSend(payload) {
        return new Promise((resolve, reject) => {
            if (!this.clientWs || this.clientWs.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket 客户端未连入或连接已断开'));
                return;
            }

            const echo = payload.echo;
            const raw = JSON.stringify(payload);

            const timer = setTimeout(() => {
                if (this.pending.has(echo)) {
                    this.pending.delete(echo);
                    this.log(`API请求超时: ${payload.action} (echo: ${echo})`, 'WARN');
                    resolve({ status: 'timeout', message: 'API响应超时' });
                }
            }, 10000);

            this.pending.set(echo, { resolve, timer });
            this.clientWs.send(raw);
        });
    }

    clearPendingTimers() {
        for (const [echo, { timer }] of this.pending.entries()) {
            clearTimeout(timer);
            this.pending.delete(echo);
        }
    }
}

module.exports = NapcatAdapter;
