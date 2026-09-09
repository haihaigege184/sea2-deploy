/**
 * SEA1 模块化机器人系统 - QQ (NapCat OneBot11) 协议适配器
 * 职责：建立反向 WS 监听、标准化通信协议转换、事件上报至优先级拦截链
 *
 * [DUAL-WS 双冗余改造] sea2-bot 支持多个 NapCat WS 客户端同时连接：
 *   - 单连接 this.clientWs 改为多连接 this.clients(Map<connId, ws>)
 *   - 连接身份识别：NapCat 首条上报含 self_id，用于区分主号/docker 铁柱号
 *   - 按 channelManager 活跃通道选择发送目标：
 *       main   → self_id=__MAIN_QQ__（原生二进制 NapCat 主号）
 *       backup → self_id=__BACKUP_QQ__（docker NapCat 铁柱号）
 *   - 目标连接不可用时回退任意可用连接；全部不可用 reject
 */

const fs = require('fs');
const WebSocket = require('ws');
const BaseAdapter = require('../base-adapter');

class NapcatAdapter extends BaseAdapter {
    constructor(config, pluginManager) {
        super('qq', config, pluginManager);
        this.wss = null;
        // [DUAL-WS] 多连接管理：Map<connId, ws>，connId 为自增连接序号
        this.clients = new Map();
        this.connSeq = 0;
        this.seqId = 0;
        this.pending = new Map();
        // [DUAL-WS] 通道身份常量（可经 config 覆盖，默认主号/铁柱号）
        this.mainSelfId = String((config && config.main_self_id) || '__MAIN_QQ__');
        this.backupSelfId = String((config && config.backup_self_id) || '__BACKUP_QQ__');
        // [DUAL-WS] 重启通知仅触发一次，避免多连接重复推送
        this._rebootNotified = false;
        // [DUAL-WS] 双连接消息去重：Map<self_id:message_id, {ts}>，10s 后过期删除
        this._seenMsgs = new Map();
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
                    // [DUAL-WS] 每个连接独立入 Map，独立记录身份与连接序号
                    const connId = ++this.connSeq;
                    ws.connId = connId;
                    ws.selfId = null;
                    this.clients.set(connId, ws);
                    this.log(`NapCatQQ 客户端成功连入 (来自: ${remote}, 连接ID: ${connId}, 当前连接数: ${this.clients.size})`);

                    // [DUAL-WS] 仅首次连接触发重启通知（进程级一次性）
                    if (!this._rebootNotified) {
                        this._rebootNotified = true;
                        setTimeout(() => {
                            this.sendRebootNotification();
                        }, 5000);
                    }

                    ws.on('message', async (data) => {
                        try {
                            const rawText = data.toString();
                            const obj = JSON.parse(rawText);

                            // [DUAL-WS] 连接身份识别：NapCat 首条上报（meta_event/message）携带 self_id，
                            // 在 shouldProcess 之前记录，保证 meta_event(心跳) 也能建立身份。
                            if (obj && obj.self_id) {
                                ws.selfId = String(obj.self_id);
                                const tag = ws.selfId === this.mainSelfId ? '主号' :
                                    (ws.selfId === this.backupSelfId ? 'docker铁柱号' : '未知');
                                this.log(`连接身份识别: 连接ID=${connId} self_id=${ws.selfId} (${tag})`);
                            }

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

                            // [DEDUP-FIX] 去重 key 改为纯 message_id：主号/铁柱号上报同一群消息 message_id 相同，带 self_id 会造成两个 key 不去重→双响
                            // 仅对 post_type==='message' 且有 message_id 的消息去重；API 响应（含 echo）已在上方 return，不受影响。
                            if (obj && obj.post_type === 'message' && obj.message_id !== undefined && obj.message_id !== null) {
                                const k = String(obj.user_id || '') + ':' + String(obj.group_id || '') + ':' + String(obj.real_seq || obj.message_seq || obj.message_id || ''); // 用实际群内序号 real_seq（主号/铁柱号上报同一消息 real_seq 相同）
                                if (this._seenMsgs.has(k)) { this.log('[DEDUP-HIT] self=' + String(obj.self_id) + ' real_seq=' + String(obj.real_seq)); return; }
                                this._seenMsgs.set(k, { ts: Date.now() });
                                setTimeout(() => { try { this._seenMsgs.delete(k); } catch (e) {} }, 10000);
                                // 极端场景防 Map 无限增长：顺带清理过期项
                                if (this._seenMsgs.size > 5000) {
                                    const now = Date.now();
                                    for (const [key, v] of this._seenMsgs.entries()) {
                                        if (now - v.ts > 10000) this._seenMsgs.delete(key);
                                    }
                                }
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
                        this.log(`NapCatQQ 客户端断开连接 (连接ID: ${connId}, 状态码: ${code})`, 'WARN');
                        // [DUAL-WS] 仅移除当前连接，不影响其他连接
                        this.clients.delete(connId);
                        if (this.clients.size === 0) {
                            // 全部连接断开时才清理 pending，避免误杀其他连接的进行中请求
                            this.clearPendingTimers();
                        }
                    });

                    ws.on('error', (err) => {
                        this.log(`WS 客户端连接出错 (连接ID: ${connId}): ${err.message}`, 'ERROR');
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
        // [DUAL-WS] 关闭所有客户端连接后停止服务
        for (const ws of this.clients.values()) {
            try {
                if (ws.readyState === WebSocket.OPEN) ws.close();
            } catch (e) { /* 忽略单个连接关闭异常 */ }
        }
        this.clients.clear();
        this.clearPendingTimers();
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

    /**
     * [DUAL-WS] 读取当前活跃通道（channelManager 状态机）
     * @returns {string} 'main' | 'backup'；channelManager 不可用时默认 'main'
     */
    getActiveChannel() {
        try {
            const cm = global.sea1 && global.sea1.channelManager;
            if (cm && typeof cm.getChannel === 'function') {
                const ch = cm.getChannel();
                return ch === 'backup' ? 'backup' : 'main';
            }
        } catch (e) { /* 读取失败回退 main */ }
        return 'main';
    }

    /**
     * [DUAL-WS] 按通道选择发送目标连接
     * 选择优先级：
     *   1. self_id 精确匹配（main→主号 __MAIN_QQ__，backup→铁柱号 __BACKUP_QQ__）
     *   2. 身份未知（连接后首条消息前）→ 按连接顺序取最早未知者（main 优先第一连接）
     *   3. 回退任意可用连接
     * @param {string} [channel] 'main' | 'backup'，缺省取 getActiveChannel()
     * @returns {WebSocket|null}
     */
    getClientWs(channel) {
        const ch = channel || this.getActiveChannel();
        const preferId = ch === 'backup' ? this.backupSelfId : this.mainSelfId;
        const openClients = [];

        for (const ws of this.clients.values()) {
            if (ws.readyState === WebSocket.OPEN) {
                openClients.push(ws);
            }
        }

        // 1. self_id 精确匹配（按连接顺序，保持确定性）
        for (const ws of openClients) {
            if (ws.selfId && String(ws.selfId) === preferId) return ws;
        }

        // 2. 身份未知连接（首条上报前）→ 按连接顺序（connId 小者先连入）
        for (const ws of openClients) {
            if (!ws.selfId) return ws;
        }

        // 3. 回退任意可用连接
        return openClients.length > 0 ? openClients[0] : null;
    }

    wsSend(payload) {
        return new Promise((resolve, reject) => {
            // [DUAL-WS] 按活跃通道选择连接；目标不可用自动回退任意连接
            const client = this.getClientWs();
            if (!client || client.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket 客户端未连入'));
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
            try {
                client.send(raw);
            } catch (e) {
                this.pending.delete(echo);
                clearTimeout(timer);
                reject(e);
            }
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
