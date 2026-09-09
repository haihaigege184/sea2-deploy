/**
 * SEA1 插件：print - 智能打印服务
 * 移植狂打作业的A3切割算法
 */

const BasePlugin = require('../base-plugin');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const http = require('http');

const execPromise = util.promisify(exec);

class PrintPlugin extends BasePlugin {
    constructor(name, config) {
        super(name, config);
        this.priority = 30;
        this.permissionLevel = 0;
        
        this.printerName = "Default_Printer";
        this.tempDir = "/dev/shm";
        this.sessionTimeout = 5 * 60 * 1000;
        this.allowedGroups = config.notify_groups || [];
        this.recallEnabled = true;
        
        this.napcatHost = config.napcat_host;
        this.napcatPort = config.napcat_port || 3000;
        this.napcatToken = config.napcat_token || "";
        this.superAdmin = config.superAdmin || "";
        this.developer = config.developer || "";
        
        this.demoMode = config.demo_mode || {};
        
        this.AUTO_BLACK_CONFIG = "-lat 15x15-10% -normalize -auto-level";
        
        this.A4_W = 2480;
        this.A4_H = 3508;
        this.GAP = 59;
        this.MAX_COLS = 4;
        this.MAX_ROWS = 4;
        
        this.sessions = new Map();
        this.userModes = new Map();
        this.userMsgCache = new Map();
        this.configPath = path.join(__dirname, '../../config.json');
        
        this.STAGE = {
            DUPLEX: 'duplex',
            BLACK: 'black',
            A3: 'a3',
            STITCH: 'stitch',
            WAITING_CUTS: 'waiting_cuts',
            WAITING_PRINT: 'waiting_print',
            WAITING_LAYOUT: 'waiting_layout',
            COMPLETED: 'completed'
        };
        
        this.cleanupInterval = null;
        this.queueSession = null;
    }

    async onEnable(db) {
        console.log(`[Print] ========================================`);
        console.log(`[Print] 智能打印插件 v5.8 加载中...`);
        
        await this.loadConfig();
        
        console.log(`[Print] 打印机: ${this.printerName}`);
        console.log(`[Print] NapCat: ${this.napcatHost}:${this.napcatPort}`);
        console.log(`[Print] 监听群组: ${this.allowedGroups.join(', ') || '全部'}`);
        console.log(`[Print] 撤回功能: ${this.recallEnabled ? '开启' : '关闭'}`);
        
        try {
            await execPromise('convert -version', 3000);
            console.log(`[Print] ImageMagick: OK`);
        } catch (e) {
            console.log(`[Print] ImageMagick: 未安装`);
        }
        
        try {
            await execPromise('pdftoppm -v', 3000);
            console.log(`[Print] pdftoppm: OK`);
        } catch (e) {
            console.log(`[Print] pdftoppm: 未安装`);
        }
        
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.cleanupInterval = setInterval(this.cleanupSessions.bind(this), 60000);
        
        console.log(`[Print] 加载完成`);
        console.log(`[Print] ========================================`);
    }

    async onDisable(db) {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        console.log(`[Print] 已卸载`);
    }

    cleanupSessions() {
        const now = Date.now();
        if (this.sessions) {
            for (const [userId, session] of this.sessions.entries()) {
                if (now - session.lastActive > this.sessionTimeout) {
                    this.sessions.delete(userId);
                }
            }
        }
        if (this.userModes) {
            for (const [userId, mode] of this.userModes.entries()) {
                if (now - mode.lastActive > this.sessionTimeout) {
                    this.userModes.delete(userId);
                }
            }
        }
    }

    // ==========================================
    // 配置管理
    // ==========================================

    async loadConfig() {
        try {
            const configData = fs.readFileSync(this.configPath, 'utf-8');
            const config = JSON.parse(configData);
            
            if (config.printer && config.printer.default) {
                this.printerName = config.printer.default;
            }
            if (config.notify_groups) {
                this.allowedGroups = config.notify_groups;
            }
            if (config.napcat_host) {
                this.napcatHost = config.napcat_host;
            }
            if (config.napcat_port) {
                this.napcatPort = config.napcat_port;
            }
            if (config.napcat_token) {
                this.napcatToken = config.napcat_token;
            }
            if (config.superAdmin) {
                this.superAdmin = config.superAdmin;
            }
            if (config.developer) {
                this.developer = config.developer;
            }
            if (config.demo_mode) {
                this.demoMode = config.demo_mode;
            }
            if (config.recall_enabled !== undefined) {
                this.recallEnabled = config.recall_enabled;
            }
        } catch (e) {
            console.log(`[Print] 读取配置失败: ${e.message}`);
        }
    }

    async saveConfig() {
        try {
            const configData = fs.readFileSync(this.configPath, 'utf-8');
            const config = JSON.parse(configData);
            
            config.printer = config.printer || {};
            config.printer.default = this.printerName;
            config.notify_groups = this.allowedGroups;
            config.demo_mode = this.demoMode;
            config.napcat_host = this.napcatHost;
            config.napcat_port = this.napcatPort;
            config.napcat_token = this.napcatToken;
            config.recall_enabled = this.recallEnabled;
            
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
            console.log(`[Print] 配置已保存`);
            return true;
        } catch (e) {
            console.log(`[Print] 保存配置失败: ${e.message}`);
            return false;
        }
    }

    // ==========================================
    // 权限检查
    // ==========================================

    isSuperAdmin(userId) {
        return String(userId) === String(this.superAdmin);
    }

    isDeveloper(userId) {
        return String(userId) === String(this.developer) || this.isSuperAdmin(userId);
    }

    // ==========================================
    // 群组管理
    // ==========================================

    isGroupAllowed(groupId) {
        if (!groupId) return true;
        if (this.allowedGroups.length === 0) return true;
        return this.allowedGroups.includes(String(groupId));
    }

    isDemoMode(groupId) {
        return this.demoMode[String(groupId)] === true;
    }

    async addGroup(groupId) {
        const gid = String(groupId);
        if (!this.allowedGroups.includes(gid)) {
            this.allowedGroups.push(gid);
            await this.saveConfig();
            return true;
        }
        return false;
    }

    async removeGroup(groupId) {
        const gid = String(groupId);
        const index = this.allowedGroups.indexOf(gid);
        if (index !== -1) {
            this.allowedGroups.splice(index, 1);
            await this.saveConfig();
            return true;
        }
        return false;
    }

    async enableDemo(groupId) {
        const gid = String(groupId);
        this.demoMode[gid] = true;
        await this.saveConfig();
        return true;
    }

    async disableDemo(groupId) {
        const gid = String(groupId);
        delete this.demoMode[gid];
        await this.saveConfig();
        return true;
    }

    // ==========================================
    // HTTP API
    // ==========================================

    getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.napcatToken) {
            headers['Authorization'] = `Bearer ${this.napcatToken}`;
        }
        return headers;
    }

    sendGroupMessage(groupId, text) {
        return new Promise((resolve) => {
            const postData = JSON.stringify({
                group_id: parseInt(groupId),
                message: text
            });
            const options = {
                hostname: this.napcatHost,
                port: this.napcatPort,
                path: '/send_group_msg',
                method: 'POST',
                headers: this.getHeaders(),
                timeout: 5000
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.status === 'ok' && result.data && result.data.message_id) {
                            resolve(result.data.message_id);
                        } else {
                            resolve(null);
                        }
                    } catch(e) {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.write(postData);
            req.end();
        });
    }

    async recallMessage(messageId) {
        if (!this.recallEnabled) return false;
        if (!messageId) return false;
        try {
            const postData = JSON.stringify({ message_id: parseInt(messageId) });
            const options = {
                hostname: this.napcatHost,
                port: this.napcatPort,
                path: '/delete_msg',
                method: 'POST',
                headers: this.getHeaders(),
                timeout: 5000
            };
            return new Promise((resolve) => {
                const req = http.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const result = JSON.parse(data);
                            resolve(result.retcode === 0);
                        } catch(e) {
                            resolve(false);
                        }
                    });
                });
                req.on('error', () => resolve(false));
                req.on('timeout', () => { req.destroy(); resolve(false); });
                req.write(postData);
                req.end();
            });
        } catch (e) {
            return false;
        }
    }

    getUserMessageId(context) {
        if (context.raw && context.raw.message_id) {
            return context.raw.message_id;
        }
        if (context.message_id) {
            return context.message_id;
        }
        return null;
    }

    recordUserMessage(userId, messageId) {
        if (!messageId) return;
        if (!this.userMsgCache.has(userId)) {
            this.userMsgCache.set(userId, []);
        }
        this.userMsgCache.get(userId).push(messageId);
    }

    async recallUserMessages(userId) {
        if (!this.recallEnabled) return;
        const ids = this.userMsgCache.get(userId) || [];
        for (const id of ids) {
            await this.recallMessage(id);
        }
        this.userMsgCache.delete(userId);
    }

    async sendAndAutoRecall(groupId, text, msgIds, delay = 10000) {
        const msgId = await this.sendGroupMessage(groupId, text);
        if (msgId && msgIds && this.recallEnabled) {
            msgIds.push(msgId);
            setTimeout(() => {
                this.recallMessage(msgId);
            }, delay);
        }
        return msgId;
    }

    async sendPreview(groupId, imageBuffer, text) {
        const cqImage = `[CQ:image,file=base64://${imageBuffer.toString('base64')}]`;
        return await this.sendGroupMessage(groupId, cqImage + '\n' + text);
    }

    // ==========================================
    // 队列功能
    // ==========================================

    async getPrintQueue(printerName) {
        try {
            const result = await execPromise(`lpstat -o "${printerName}" 2>&1`, 15000);
            return result.stdout ? result.stdout : result.toString();
        } catch (e) {
            return '';
        }
    }

    formatQueuePretty(output) {
        if (!output || output.includes('no entries')) return null;
        
        const lines = output.split('\n');
        const jobs = [];
        
        for (const line of lines) {
            const match = line.match(/^(\S+)-(\d+)\s+\S+\s+(\d+)\s+(.+)$/);
            if (match) {
                const jobNum = match[2];
                const sizeBytes = parseInt(match[3]);
                const timeRaw = match[4];
                
                let sizeStr;
                if (sizeBytes >= 1048576) sizeStr = (sizeBytes / 1048576).toFixed(1) + 'MB';
                else if (sizeBytes >= 1024) sizeStr = Math.round(sizeBytes / 1024) + 'KB';
                else sizeStr = sizeBytes + 'B';
                
                let timeStr = timeRaw;
                try {
                    const d = new Date(timeRaw);
                    if (!isNaN(d.getTime())) {
                        timeStr = d.toLocaleTimeString('zh-CN', { hour12: false });
                    }
                } catch(e) {}
                
                jobs.push({ num: jobNum, size: sizeStr, time: timeStr });
            }
        }
        
        if (jobs.length === 0) return null;
        
        return [
            '[打印队列]',
            '-------------------',
            '共 ' + jobs.length + ' 条打印任务',
            '-------------------',
            ...jobs.map(j => '序号 ' + j.num + ' | ' + j.size + ' | ' + j.time),
            '-------------------',
            '[√] 回复数字取消对应任务',
            '[√] 回复 0 取消全部任务',
            '[×] 回复 q 退出'
        ].join('\n');
    }

    async cancelPrintJob(jobId) {
        try {
            await execPromise(`cancel "${jobId}"`, 15000);
            return true;
        } catch (e) {
            return false;
        }
    }

    async cancelAllJobs(printerName) {
        try {
            const out = await this.getPrintQueue(printerName);
            const lines = out.trim().split('\n').filter(l => l && !l.includes('no entries'));
            let cancelled = 0;
            for (const line of lines) {
                const match = line.match(/^(\S+-\d+)/);
                if (match) {
                    try { 
                        await execPromise(`cancel "${match[1]}"`, 15000); 
                        cancelled++; 
                    } catch (e) {}
                }
            }
            return cancelled;
        } catch (e) {
            return 0;
        }
    }

    // ==========================================
    // 狂打A3切割算法（移植）
    // ==========================================

    /**
     * ============================================================
     * A3 中缝智能检测 v2（增强版）
     * 解决：密封区干扰 / 透视失真 / 非标准版面
     * ============================================================
     */
    async findMidGap(filePath, imgW, imgH) {
        try {
            const isWidthLonger = imgW > imgH;
            const longSide = isWidthLonger ? imgW : imgH;
            const shortSide = isWidthLonger ? imgH : imgW;

            // 全高采样：取整条高度的竖线，不再只取中间20%
            const sampleWidth = shortSide;
            const sampleOffset = 0;

            const densities = [];

            for (let pct = 25; pct <= 75; pct++) {
                const pos = Math.floor(longSide * pct / 100);
                let cropGeom;
                if (isWidthLonger) {
                    cropGeom = `1x${sampleWidth}+${pos}+${sampleOffset}`;
                } else {
                    cropGeom = `${sampleWidth}x1+${sampleOffset}+${pos}`;
                }
                try {
                    const cmd = `convert "${filePath}" -crop ${cropGeom} +repage -threshold 50% -negate -format "%[fx:mean*w*h]" info:`;
                    const result = await execPromise(cmd, 30000);
                    const outStr = (typeof result === 'string') ? result : (result.stdout || '');
                    const blackPixels = parseFloat(outStr.trim());
                    if (!isNaN(blackPixels)) {
                        densities.push({ pct, density: blackPixels });
                    }
                } catch (e) {}
            }
            if (densities.length === 0) return { positions: [], confidence: 0 };
            let valleys = [];
            for (let i = 2; i < densities.length - 2; i++) {
                if (densities[i].density === 0) valleys.push({ pct: densities[i].pct, density: 0 });
            }
            // 保留全部空白竖线（不再只取最中间一条），供二开/三开判断
            const filtered = [];
            for (const v of valleys) {
                if (filtered.length === 0 || v.pct - filtered[filtered.length - 1].pct >= 10) {
                    filtered.push(v);
                }
            }
            const positions = filtered.map(v => v.pct / 100);
            const confidence = positions.length > 0 ? 1.0 : 0;
            console.log('[Print] 中缝检测(全高): 候选' + filtered.length + '个 pos=' + positions.map(function (p) { return (p*100).toFixed(1)+'%'; }).join(',') + ' conf=' + confidence.toFixed(2));
            return { positions, confidence };
        } catch (e) {
            console.log('[Print] findMidGap错误: ' + e.message);
            return { positions: [], confidence: 0 };
        }
    }



    async _fallbackSeamDetection(filePath, imgW, imgH) {
        try {
            const isWidthLonger = imgW > imgH;
            const LONG = isWidthLonger ? imgW : imgH;
            const SHORT = isWidthLonger ? imgH : imgW;
            const rows = [Math.floor(SHORT * 0.20), Math.floor(SHORT * 0.50), Math.floor(SHORT * 0.80)];
            const allDens = [];
            for (const r of rows) {
                const sw = Math.floor(SHORT * 0.2); const so = Math.floor(SHORT * 0.4);
                const rd = [];
                for (let pct = 20; pct <= 80; pct++) {
                    const pos = Math.floor(LONG * pct / 100);
                    const gm = isWidthLonger ? '1x' + sw + '+' + pos + '+' + so : sw + 'x1+' + so + '+' + pos;
                    try {
                        const rr = await execPromise('convert "' + filePath + '" -crop ' + gm + ' +repage -threshold 50% -negate -format "%[fx:mean*w*h]" info:', 30000);
                        const v = parseFloat((rr.stdout || '').trim());
                        rd.push({ pct, density: isNaN(v) ? 1 : v });
                    } catch(e) { rd.push({ pct, density: 1 }); }
                }
                allDens.push(rd);
            }
            const scores = [];
            if (allDens[0].length > 0) {
                for (let i = 0; i < allDens[0].length; i++) {
                    const avg = allDens.reduce((s, r) => s + (r[i] ? r[i].density : 1), 0) / allDens.length;
                    if (avg < 0.15) {
                        const lv = i > 0 ? allDens.reduce((s, r) => s + (r[i-1] ? r[i-1].density : 1), 0) / allDens.length : 1;
                        const rv = i < allDens[0].length-1 ? allDens.reduce((s, r) => s + (r[i+1] ? r[i+1].density : 1), 0) / allDens.length : 1;
                        scores.push({ pct: allDens[0][i].pct, avg, grad: Math.min(lv-avg, rv-avg) });
                    }
                }
            }
            if (scores.length === 0) return { positions: [0.5], confidence: 0.3 };
            scores.sort((a, b) => a.pct - b.pct);
            const cls = [];
            for (const s of scores) {
                if (cls.length === 0 || s.pct - cls[cls.length-1].pct >= 3) {
                    cls.push({ pcts: [s.pct], minAvg: s.avg, maxGrad: s.grad });
                } else { cls[cls.length-1].pcts.push(s.pct); cls[cls.length-1].minAvg = Math.min(cls[cls.length-1].minAvg, s.avg); cls[cls.length-1].maxGrad = Math.max(cls[cls.length-1].maxGrad, s.grad); }
            }
            const best = cls.reduce((a, b) => {
                const ma = a.pcts[Math.floor(a.pcts.length/2)]; const mb = b.pcts[Math.floor(b.pcts.length/2)];
                return Math.abs(ma - 50) < Math.abs(mb - 50) ? a : b;
            });
            const mid = best.pcts[Math.floor(best.pcts.length / 2)];
            const conf = (1 - best.minAvg) * 0.6 + Math.min(best.maxGrad, 0.5) * 0.4;
            console.log('[Print] 回退检测: pos=' + mid.toFixed(1) + '% conf=' + (conf||0).toFixed(2));
            return { positions: [mid / 100], confidence: Math.min(conf || 0, 1) };
        } catch (e) {
            console.log('[Print] _fallbackSeamDetection错误: ' + e.message);
            return { positions: [0.5], confidence: 0.3 };
        }
    }


    /**
     * 回退中缝检测（单行梯度法，处理极端情况）
     * 在顶部行、中间行、底部行各取一条，求共同低密度列
     */
    async _fallbackSeamDetection(filePath, imgW, imgH) {
        try {
            const isWidthLonger = imgW > imgH;
            const LONG = isWidthLonger ? imgW : imgH;
            const SHORT = isWidthLonger ? imgH : imgW;

            // 顶部行（跳过密封区）、中间行、底部行
            const rows = [
                Math.floor(SHORT * 0.20),  // 跳过密封区
                Math.floor(SHORT * 0.50),  // 中间
                Math.floor(SHORT * 0.80)  // 底部
            ];

            const densities = [];
            for (const row of rows) {
                const rowDens = [];
                for (let pct = 20; pct <= 80; pct++) {
                    const pos = Math.floor(LONG * pct / 100);
                    let cropGeom = isWidthLonger
                        ? `1x${Math.floor(SHORT * 0.2)}+${pos}+${Math.floor(SHORT * 0.4)}`
                        : `${Math.floor(SHORT * 0.2)}x1+${Math.floor(SHORT * 0.4)}+${pos}`;
                    try {
                        const cmd = `convert "${filePath}" -crop ${cropGeom} +repage -threshold 50% -negate -format "%[fx:mean*w*h]" info:`;
                        const r = await execPromise(cmd, 30000);
                        const v = parseFloat((r.stdout || '').trim());
                        rowDens.push({ pct, density: isNaN(v) ? 1 : v });
                    } catch(e) { rowDens.push({ pct, density: 1 }); }
                }
                densities.push(rowDens);
            }

            // 对每列计算跨行一致性（所有行密度都很低的列）
            const scores = [];
            for (let i = 0; i < densities[0].length; i++) {
                const avg = densities.reduce((s, r) => s + (r[i]?.density || 1), 0) / densities.length;
                if (avg < 0.15) {
                    // 计算梯度（与相邻列的差值）
                    const left = i > 0 ? densities.reduce((s, r) => s + (r[i-1]?.density || 1), 0) / densities.length : 1;
                    const right = i < densities[0].length-1 ? densities.reduce((s, r) => s + (r[i+1]?.density || 1), 0) / densities.length : 1;
                    scores.push({ pct: densities[0][i].pct, avg, gradient: Math.min(left - avg, right - avg) });
                }
            }

            if (scores.length === 0) return { positions: [], confidence: 0 };

            // 合并相邻列（聚类）
            scores.sort((a, b) => a.pct - b.pct);
            const clusters = [];
            for (const s of scores) {
                if (clusters.length === 0 || s.pct - clusters[clusters.length-1].pct >= 3) {
                    clusters.push({ pcts: [s.pct], minAvg: s.avg, maxGrad: s.gradient });
                } else {
                    clusters[clusters.length-1].pcts.push(s.pct);
                    clusters[clusters.length-1].minAvg = Math.min(clusters[clusters.length-1].minAvg, s.avg);
                    clusters[clusters.length-1].maxGrad = Math.max(clusters[clusters.length-1].maxGrad, s.gradient);
                }
            }

            // 取密度最低的代表
            const candidates = clusters.map(cl => {
                const bestPct = cl.pcts[Math.floor(cl.pcts.length / 2)];
                return { pct: bestPct / 100, density: cl.minAvg, gradient: cl.maxGrad };
            });

            // 过滤密封区（只在顶部有差异）
            const valid = candidates.filter(c => {
                // 检查这列是否在各行都空白
                for (const rowDens of densities) {
                    const item = rowDens.find(d => Math.abs(d.pct - c.pct * 100) < 2);
                    if (item && item.density > 0.25) return false;
                }
                return true;
            });

            const final = valid.length > 0 ? valid : candidates;
            const best = final.reduce((a, b) => Math.abs(a.pct - 0.5) < Math.abs(b.pct - 0.5) ? a : b);
            const confidence = (1 - best.density) * 0.6 + Math.min(best.gradient, 0.5) * 0.4;

            console.log(`[Print] 回退检测: pos=${(best.pct*100).toFixed(1)}% conf=${(confidence||0).toFixed(2)}`);
            return { positions: [best.pct], confidence: Math.min(confidence || 0, 1) };
        } catch (e) {
            console.log(`[Print] _fallbackSeamDetection错误: ${e.message}`);
            return { positions: [0.5], confidence: 0.5 };
        }
    }

    /**
     * 按中缝位置智能切割（支持透视校正）
     * 若中缝倾斜（透视失真），先做斜线裁切再等宽切割
     */
    async splitImageByPosition(filePath, direction, positions) {
        const outputFiles = [];
        let imgW = 0, imgH = 0;
        try {
            const sizeOut = await execPromise('identify -format "%w %h" "' + filePath + '"', 15000);
            let dims = (sizeOut.stdout || '').trim();
            if (!dims) dims = (sizeOut.stderr || '').trim();
            if (!dims) dims = sizeOut.toString().trim();
            const parts = dims.split(/\s+/).map(Number);
            imgW = parts[0]; imgH = parts[1];
        } catch (e) {
            console.log('[Print] identify失败: ' + e.message);
        }
        if (!imgW || !imgH || isNaN(imgW) || isNaN(imgH)) {
            throw new Error('无法获取图片尺寸: ' + filePath);
        }
        const cuts = [0].concat(positions, [1]);
        for (let i = 0; i < cuts.length - 1; i++) {
            let outFile;
            if (/\.\w+$/.test(filePath)) outFile = filePath.replace(/\.\w+$/, '_part' + i + '.jpg');
            else outFile = filePath + '_part' + i + '.jpg';
            const startPct = cuts[i], endPct = cuts[i + 1];
            if (direction === 'vertical') {
                const x = Math.round(startPct * imgW);
                const w = Math.round((endPct - startPct) * imgW);
                await execPromise('convert "' + filePath + '" -crop ' + w + 'x' + imgH + '+' + x + '+0 +repage "' + outFile + '"', 30000);
            } else {
                const y = Math.round(startPct * imgH);
                const h = Math.round((endPct - startPct) * imgH);
                await execPromise('convert "' + filePath + '" -crop ' + imgW + 'x' + h + '+0+' + y + ' +repage "' + outFile + '"', 30000);
            }
            outputFiles.push(outFile);
        }
        return outputFiles;
    }



    /**
     * 智能判断两开/三开（增强版）
     * 综合：位置比例 + 密度对比 + 边缘分布
     */
    async detectParts(filePath, imgW, imgH) {
        const gap = await this.findMidGap(filePath, imgW, imgH);
        if (gap.positions.length === 0) return { parts: 0, positions: [], confidence: 0 };
        const sorted = gap.positions.slice().sort(function (a, b) { return a - b; });
        // 三开：2条缝分别在 33%/67% 附近
        if (sorted.length >= 2) {
            const p1 = sorted[0], p2 = sorted[sorted.length - 1];
            if (Math.abs(p1 - 0.333) < 0.12 && Math.abs(p2 - 0.667) < 0.12) {
                console.log('[Print] 判断三开: ' + (p1*100).toFixed(1) + '%, ' + (p2*100).toFixed(1) + '%');
                return { parts: 3, positions: [p1, p2], confidence: gap.confidence * 0.9 };
            }
        }
        // 二开：恰好1条缝且靠近中间
        if (sorted.length === 1 && Math.abs(sorted[0] - 0.5) < 0.15) {
            return { parts: 2, positions: [sorted[0]], confidence: gap.confidence * 0.85 };
        }
        // 多缝但不符三开 / 单缝偏边 → 手动指定
        console.log('[Print] 中缝不符合二开/三开，转手动: ' + sorted.map(function (p) { return (p*100).toFixed(1)+'%'; }).join(','));
        return { parts: 0, positions: [], confidence: 0 };
    }



    // ==========================================
    // PDF 渲染
    // ==========================================

    async renderPdfToImage(pdfBuffer, pageNum = 1) {
        const pdfPath = path.join(this.tempDir, `pdf_${Date.now()}.pdf`);
        const outPrefix = path.join(this.tempDir, `pdf_page_${Date.now()}`);
        
        try {
            fs.writeFileSync(pdfPath, pdfBuffer);
            const cmd = `pdftoppm -png -r 200 -f ${pageNum} -l ${pageNum} "${pdfPath}" "${outPrefix}"`;
            console.log(`[Print] 渲染PDF: ${cmd}`);
            await execPromise(cmd, 60000);
            
            const files = fs.readdirSync(this.tempDir);
            const pattern = new RegExp(path.basename(outPrefix) + '.*\\.png$');
            const matched = files.find(f => pattern.test(f));
            
            if (matched) {
                return path.join(this.tempDir, matched);
            } else {
                throw new Error('未找到渲染后的图片');
            }
        } catch (e) {
            console.log(`[Print] PDF渲染失败: ${e.message}`);
            throw e;
        } finally {
            try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch(e) {}
        }
    }

    async renderPdfToImages(pdfBuffer) {
        const pdfPath = path.join(this.tempDir, `pdf_${Date.now()}.pdf`);
        const outPrefix = path.join(this.tempDir, `pdf_pages_${Date.now()}`);
        try {
            fs.writeFileSync(pdfPath, pdfBuffer);
            const cmd = `pdftoppm -png -r 200 "${pdfPath}" "${outPrefix}"`;
            console.log(`[Print] 渲染PDF(多页): ${cmd}`);
            await execPromise(cmd, 120000);
            const base = path.basename(outPrefix);
            const matched = fs.readdirSync(this.tempDir)
                .filter(f => f.startsWith(base) && f.endsWith('.png'))
                .sort((a, b) => {
                    const na = parseInt((a.match(/-(\d+)\.png$/) || [])[1] || '0', 10);
                    const nb = parseInt((b.match(/-(\d+)\.png$/) || [])[1] || '0', 10);
                    return na - nb;
                })
                .map(f => path.join(this.tempDir, f));
            return matched;
        } catch (e) {
            console.log(`[Print] PDF多页渲染失败: ${e.message}`);
            throw e;
        } finally {
            try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch(e) {}
        }
    }

    // ==========================================
    // 工具函数
    // ==========================================

    async downloadFile(message) {
        const imageMatch = message.match(/\[CQ:image,file=([^,\]]+)(?:,url=([^\]]+))?\]/);
        const fileMatch = message.match(/\[CQ:file,file=([^,\]]+)(?:,url=([^\]]+))?\]/);
        
        let fileUrl = null;
        let fileName = null;
        let isPdf = false;
        
        if (imageMatch) {
            fileName = imageMatch[1];
            fileUrl = imageMatch[2] || null;
            isPdf = false;
        } else if (fileMatch) {
            fileName = fileMatch[1];
            fileUrl = fileMatch[2] || null;
            isPdf = fileName && fileName.toLowerCase().endsWith('.pdf');
        } else {
            throw new Error('无法解析文件信息');
        }
        
        if (fileUrl) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            let response;
            try {
                response = await fetch(fileUrl, { signal: controller.signal });
            } catch(fetchErr) {
                clearTimeout(timer);
                if (fetchErr.name === 'AbortError') throw new Error('下载超时 (30s)');
                throw fetchErr;
            }
            clearTimeout(timer);
            if (!response.ok) {
                throw new Error(`下载失败: HTTP ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            return { buffer: Buffer.from(arrayBuffer), isPdf, fileName };
        }
        
        throw new Error('无法获取文件下载链接');
    }

    async removeDarkBackground(inputBuffer) {
        const tempInput = path.join(this.tempDir, `black_in_${Date.now()}.jpg`);
        const tempProcessed = path.join(this.tempDir, `black_out_${Date.now()}.jpg`);
        
        try {
            fs.writeFileSync(tempInput, inputBuffer);
            const cmd = `convert "${tempInput}" -colorspace Gray ${this.AUTO_BLACK_CONFIG} "${tempProcessed}"`;
            await execPromise(cmd, 60000);
            if (fs.existsSync(tempProcessed) && fs.statSync(tempProcessed).size > 1024) {
                return fs.readFileSync(tempProcessed);
            } else {
                throw new Error('处理失败');
            }
        } catch (error) {
            console.log(`[Print] 去黑底失败: ${error.message}`);
            const sharp = require('sharp');
            return await sharp(inputBuffer).threshold(180).toBuffer();
        } finally {
            try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch(e) {}
            try { if (fs.existsSync(tempProcessed)) fs.unlinkSync(tempProcessed); } catch(e) {}
        }
    }

    async doPrintImage(buffer) {
        const tempInput = path.join(this.tempDir, `print_${Date.now()}.jpg`);
        const tempPdf = path.join(this.tempDir, `print_${Date.now()}.pdf`);
        try {
            fs.writeFileSync(tempInput, buffer);
            await execPromise(`img2pdf --rotation=ifvalid "${tempInput}" -o "${tempPdf}"`, 30000);
            if (!fs.existsSync(tempPdf) || fs.statSync(tempPdf).size < 1024) {
                throw new Error('PDF生成失败');
            }
            await execPromise(`lp -d "${this.printerName}" -o fit-to-page -o position=center "${tempPdf}"`, 30000);
            return true;
        } finally {
            try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch(e) {}
            try { if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf); } catch(e) {}
        }
    }

    async doPrintPdf(buffer) {
        const tempPdf = path.join(this.tempDir, `pdf_${Date.now()}.pdf`);
        try {
            fs.writeFileSync(tempPdf, buffer);
            if (!fs.existsSync(tempPdf) || fs.statSync(tempPdf).size < 1024) {
                throw new Error('PDF无效');
            }
            await execPromise(`lp -d "${this.printerName}" -o fit-to-page -o position=center "${tempPdf}"`, 30000);
            return true;
        } finally {
            try { if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf); } catch(e) {}
        }
    }

    async doPrintDoubleSided(buf1, buf2) {
        const f1 = path.join(this.tempDir, `d1_${Date.now()}.jpg`);
        const f2 = path.join(this.tempDir, `d2_${Date.now()}.jpg`);
        const tempPdf = path.join(this.tempDir, `duplex_${Date.now()}.pdf`);
        try {
            fs.writeFileSync(f1, buf1);
            fs.writeFileSync(f2, buf2);
            await execPromise(`img2pdf "${f1}" "${f2}" --rotation=ifvalid -o "${tempPdf}"`, 30000);
            await execPromise(`lp -d "${this.printerName}" -o fit-to-page -o position=center -o sides=two-sided-long-edge "${tempPdf}"`, 30000);
            return true;
        } finally {
            [f1, f2, tempPdf].forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {} });
        }
    }

    // 统一打印入口
    async printImage(groupId, buffer, session, isDemo) {
        if (isDemo) {
            await this.sendAndAutoRecall(groupId, '[演示] 模拟打印', session.msgIds, 10000);
            return true;
        }
        return await this.doPrintImage(buffer);
    }

    async printPdf(groupId, buffer, session, isDemo) {
        if (isDemo) {
            await this.sendAndAutoRecall(groupId, '[演示] 模拟打印PDF', session.msgIds, 10000);
            return true;
        }
        return await this.doPrintPdf(buffer);
    }

    async printDoubleSided(groupId, buf1, buf2, session, isDemo) {
        if (isDemo) {
            await this.sendAndAutoRecall(groupId, '[演示] 模拟双面打印', session.msgIds, 10000);
            return true;
        }
        return await this.doPrintDoubleSided(buf1, buf2);
    }

    getLayouts(n) {
        const results = [];
        const seen = new Set();
        const add = (cols, rows) => {
            if (cols > this.MAX_COLS || rows > this.MAX_ROWS) return;
            const key = `${cols}x${rows}`;
            if (!seen.has(key) && cols * rows >= n) {
                seen.add(key);
                results.push({ rows, cols });
            }
        };
        if (n <= 1) return [{ rows: 1, cols: 1 }];
        if (n === 2) { add(1, 2); add(2, 1); }
        else if (n <= 4) { add(2, 2); }
        else {
            for (let cols = 1; cols <= this.MAX_COLS; cols++) {
                for (let rows = 1; rows <= this.MAX_ROWS; rows++) {
                    if (cols * rows >= n && cols * rows <= n + 3) add(cols, rows);
                }
            }
            if (results.length === 0) {
                const sq = Math.ceil(Math.sqrt(n));
                add(Math.min(sq, this.MAX_COLS), Math.min(sq, this.MAX_ROWS));
            }
        }
        results.sort((a, b) => (a.rows * a.cols) - (b.rows * b.cols));
        return results;
    }

    async stitchImages(buffers, rows, cols, startIdx, count) {
        const workDir = path.join(this.tempDir, `stitch_${Date.now()}`);
        fs.mkdirSync(workDir, { recursive: true });
        try {
            const totalCells = rows * cols;
            const halfGap = Math.floor(this.GAP / 2);
            const cellW = Math.floor((this.A4_W - this.GAP * 2 - this.GAP * (cols - 1)) / cols);
            const cellH = Math.floor((this.A4_H - this.GAP * 2 - this.GAP * (rows - 1)) / rows);
            
            const cellFiles = [];
            for (let i = 0; i < count; i++) {
                const tempImg = path.join(workDir, `in_${i}.jpg`);
                const outImg = path.join(workDir, `out_${i}.jpg`);
                fs.writeFileSync(tempImg, buffers[startIdx + i]);
                await execPromise(
                    `convert "${tempImg}" -fuzz 5% -trim +repage -resize ${cellW}x${cellH} -background white -gravity center -extent ${cellW}x${cellH} -bordercolor white -border ${halfGap}x${halfGap} "${outImg}"`,
                    30000
                );
                cellFiles.push(outImg);
                try { fs.unlinkSync(tempImg); } catch(e) {}
            }
            while (cellFiles.length < totalCells) {
                const blank = path.join(workDir, `blank_${cellFiles.length}.jpg`);
                await execPromise(`convert -size ${cellW}x${cellH} xc:white -bordercolor white -border ${halfGap}x${halfGap} "${blank}"`, 5000);
                cellFiles.push(blank);
            }
            
            const rowFiles = [];
            for (let r = 0; r < rows; r++) {
                const rowFile = path.join(workDir, `row_${r}.jpg`);
                await execPromise(`convert ${cellFiles.slice(r*cols, (r+1)*cols).map(f=>`"${f}"`).join(' ')} +append "${rowFile}"`, 30000);
                rowFiles.push(rowFile);
            }
            
            const gridFile = path.join(workDir, 'grid.jpg');
            await execPromise(`convert ${rowFiles.map(f=>`"${f}"`).join(' ')} -append "${gridFile}"`, 30000);
            
            const infoResult = await execPromise(`identify -format "%w %h" "${gridFile}"`, 10000);
            const infoStr = infoResult.stdout ? infoResult.stdout.trim() : infoResult.toString().trim();
            const [gridW, gridH] = infoStr.split(' ').map(Number);
            const offsetX = Math.floor((this.A4_W - gridW) / 2);
            const offsetY = Math.floor((this.A4_H - gridH) / 2);
            
            const outFile = path.join(workDir, 'output.jpg');
            await execPromise(`convert -size ${this.A4_W}x${this.A4_H} xc:white "${gridFile}" -geometry +${offsetX}+${offsetY} -composite "${outFile}"`, 30000);
            return fs.readFileSync(outFile);
        } finally {
            try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
        }
    }

    bufferToCqImage(buffer) {
        return `[CQ:image,file=base64://${buffer.toString('base64')}]`;
    }

    // ==========================================
    // 菜单命令
    // ==========================================

    async showMenu(context) {
        const isSuper = this.isSuperAdmin(context.userId);
        const isDev = this.isDeveloper(context.userId);
        const isDemo = this.isDemoMode(context.groupId);
        const recallStatus = this.recallEnabled ? '开启' : '关闭';
        
        let menu = '[打印菜单]\n';
        menu += '-------------------\n';
        menu += '[打印命令]\n';
        menu += '  直接发图/PDF  极速打印\n';
        menu += '  去黑           去黑底打印\n';
        menu += '  双面           双面打印\n';
        menu += '  a3             A3切割（自动检测中缝）\n';
        menu += '  拼图           多图拼图\n';
        menu += '  队列           查看打印队列\n';
        menu += '  取消           退出当前模式\n';
        menu += '-------------------\n';
        menu += '[系统状态]\n';
        menu += '  撤回功能: ' + recallStatus + '\n';
        if (isDemo) {
            menu += '  演示模式: 已开启\n';
        }
        menu += '-------------------\n';
        menu += '[管理命令]\n';
        menu += '  菜单           显示此菜单\n';
        menu += '  开启撤回       开启自动撤回\n';
        menu += '  关闭撤回       关闭自动撤回\n';
        if (isSuper || isDev) {
            menu += '  监听此群       添加到白名单\n';
            menu += '  不监听此群     移出白名单\n';
            menu += '  开启演示       演示模式\n';
            menu += '  关闭演示       恢复打印\n';
        }
        menu += '-------------------\n';
        menu += '[√] 发送「帮助」查看详细说明';
        
        await context.reply(menu);
    }

    // ==========================================
    // 消息处理
    // ==========================================

    async onMessage(context) {
    // ===== QA内部测试入口 =====
    if (context.msg === 'QAtest') {
        console.log('[QAtest] 测试触发成功!');
        try {
            await context.reply('[QAtest] 插件正常运行! 时间: ' + new Date().toISOString());
        } catch(e) { console.log('[QAtest] reply错误: ' + e.message); }
        return true;
    }
    // ===== 测试入口结束 =====

        const userId = context.userId;
        const groupId = context.groupId;
        const msg = context.msg.trim();

        console.log(`[Print] 收到: ${msg.substring(0, 30)}`);

        if (!groupId) {
            return false;
        }

        const userMsgId = this.getUserMessageId(context);
        if (userMsgId) {
            this.recordUserMessage(userId, userMsgId);
        }

        let session = this.sessions.get(userId);
        if (!session) {
            session = { msgIds: [], lastActive: Date.now() };
            this.sessions.set(userId, session);
        }
        session.lastActive = Date.now();

        const userMode = this.userModes.get(userId);
        const isSuper = this.isSuperAdmin(userId);
        const isDev = this.isDeveloper(userId);
        const isDemo = this.isDemoMode(groupId);
        const isAllowed = this.isGroupAllowed(groupId);

        // ==========================================
        // 菜单命令
        // ==========================================
        if (msg === '菜单') {
            await this.showMenu(context);
            return true;
        }

        // ==========================================
        // 撤回开关
        // ==========================================
        if (msg === '开启撤回' || msg === '关闭撤回') {
            if (!isSuper && !isDev) {
                await context.reply('[×] 权限不足');
                return true;
            }
            this.recallEnabled = msg === '开启撤回';
            await this.saveConfig();
            await context.reply('[√] 已' + (this.recallEnabled ? '开启' : '关闭') + '撤回');
            return true;
        }

        // ==========================================
        // 管理命令
        // ==========================================

        if (msg === '监听此群' && (isSuper || isDev)) {
            if (this.isGroupAllowed(groupId)) {
                await context.reply('[!] 已在监听列表');
            } else {
                await this.addGroup(groupId);
                await context.reply('[√] 已添加此群');
            }
            return true;
        }

        if (msg === '不监听此群' && (isSuper || isDev)) {
            if (!this.isGroupAllowed(groupId)) {
                await context.reply('[!] 不在监听列表');
            } else {
                await this.removeGroup(groupId);
                await context.reply('[√] 已移除监听');
            }
            return true;
        }

        if (msg === '开启演示' && (isSuper || isDev)) {
            if (this.isDemoMode(groupId)) {
                await context.reply('[!] 已是演示模式');
            } else {
                await this.enableDemo(groupId);
                await context.reply('[√] 已开启演示');
            }
            return true;
        }

        if (msg === '关闭演示' && (isSuper || isDev)) {
            if (!this.isDemoMode(groupId)) {
                await context.reply('[!] 不是演示模式');
            } else {
                await this.disableDemo(groupId);
                await context.reply('[√] 已关闭演示');
            }
            return true;
        }

        // ==========================================
        // 群组白名单检查
        // ==========================================

        if (!isAllowed) {
            return false;
        }

        // ==========================================
        // 队列命令
        // ==========================================
        if (msg === '队列') {
            const queueOut = await this.getPrintQueue(this.printerName);
            const queueStr = this.formatQueuePretty(queueOut);
            
            if (!queueStr) {
                await this.sendAndAutoRecall(groupId, '打印队列为空', session.msgIds, 10000);
                return true;
            }
            
            this.queueSession = {
                userId: userId,
                groupId: groupId,
                msgIds: session.msgIds
            };
            
            await this.sendAndAutoRecall(groupId, queueStr, session.msgIds, 60000);
            return true;
        }

        if (this.queueSession && this.queueSession.userId === userId && /^\d+$/.test(msg)) {
            const num = parseInt(msg);
            
            if (num === 0) {
                const cancelled = await this.cancelAllJobs(this.printerName);
                await this.sendAndAutoRecall(groupId, '已取消 ' + cancelled + ' 个任务', session.msgIds, 10000);
            } else {
                const jobId = `${this.printerName}-${num}`;
                const success = await this.cancelPrintJob(jobId);
                if (success) {
                    await this.sendAndAutoRecall(groupId, '已取消任务 ' + num, session.msgIds, 10000);
                } else {
                    await this.sendAndAutoRecall(groupId, '任务 ' + num + ' 不存在', session.msgIds, 10000);
                }
            }
            
            const queueOut = await this.getPrintQueue(this.printerName);
            const queueStr = this.formatQueuePretty(queueOut);
            if (queueStr) {
                await this.sendAndAutoRecall(groupId, queueStr, session.msgIds, 60000);
            } else {
                await this.sendAndAutoRecall(groupId, '打印队列已清空', session.msgIds, 10000);
                this.queueSession = null;
            }
            return true;
        }

        if (this.queueSession && this.queueSession.userId === userId && msg === 'q') {
            this.queueSession = null;
            await this.sendAndAutoRecall(groupId, '已退出队列', session.msgIds, 5000);
            return true;
        }

        // ==========================================
        // 帮助
        // ==========================================
        if (msg === '帮助') {
            let help = '[智能打印]\n';
            help += '-------------------\n';
            help += '直接发图/PDF  极速打印\n';
            help += '去黑           去黑底打印\n';
            help += '双面           双面打印\n';
            help += 'a3             A3切割\n';
            help += '拼图           多图拼图\n';
            help += '队列           查看打印队列\n';
            help += '菜单           显示所有命令\n';
            help += '取消           退出当前模式\n';
            help += '-------------------\n';
            help += '[管理命令]\n';
            help += '开启撤回/关闭撤回  控制自动撤回\n';
            if (isSuper || isDev) {
                help += '监听此群/不监听此群  群组白名单\n';
                help += '开启演示/关闭演示  演示模式\n';
            }
            await context.reply(help);
            return true;
        }

        // ==========================================
        // 取消
        // ==========================================
        if (msg === '取消' || msg === '退出') {
            this.queueSession = null;
            if (session.msgIds && session.msgIds.length > 0) {
                for (const id of session.msgIds) {
                    await this.recallMessage(id);
                }
                session.msgIds = [];
            }
            await this.recallUserMessages(userId);
            this.sessions.delete(userId);
            this.userModes.delete(userId);
            await this.sendAndAutoRecall(groupId, '[OK] 已取消', session.msgIds, 10000);
            return true;
        }

        // ==========================================
        // 状态
        // ==========================================
        if (msg === '#打印状态') {
            try {
                const result = await execPromise(`lpstat -p -d 2>/dev/null`);
                const out = result.stdout ? result.stdout : result.toString();
                let status = '[打印机状态]\n';
                status += '-------------------\n';
                status += '当前: ' + this.printerName + '\n';
                status += out.split('\n').filter(l => l.trim()).slice(0, 3).join('\n');
                if (isDemo) {
                    status += '\n[演示模式]';
                }
                await this.sendAndAutoRecall(groupId, status, session.msgIds, 10000);
            } catch (e) {
                await this.sendAndAutoRecall(groupId, '错误: ' + e.message, session.msgIds, 10000);
            }
            return true;
        }

        // ==========================================
        // 双面模式
        // ==========================================
        if (msg === '双面' || msg === '双面打印') {
            this.sessions.set(userId, {
                stage: this.STAGE.DUPLEX,
                queue: [],
                msgIds: [],
                lastActive: Date.now()
            });
            this.userModes.delete(userId);
            const newSession = this.sessions.get(userId);
            let tip = '[双面打印]\n';
            tip += '-------------------\n';
            tip += '发送图片，每2张自动双面\n';
            tip += '剩余单张发「完成」收尾\n';
            tip += '发「取消」退出';
            if (isDemo) {
                tip += '\n[演示模式]';
            }
            await this.sendAndAutoRecall(groupId, tip, newSession.msgIds, 10000);
            return true;
        }

        // 双面模式 - 完成
        if (session && session.stage === this.STAGE.DUPLEX && msg === '完成') {
            if (session.queue && session.queue.length === 1) {
                await this.sendAndAutoRecall(groupId, '剩余1张，单面打印...', session.msgIds, 5000);
                await this.printImage(groupId, session.queue[0], session, isDemo);
                await this.sendAndAutoRecall(groupId, '单面打印完成', session.msgIds, 10000);
            } else if (session.queue && session.queue.length > 1) {
                await this.sendAndAutoRecall(groupId, '剩余' + session.queue.length + '张，单面打印...', session.msgIds, 5000);
                for (const buf of session.queue) {
                    await this.printImage(groupId, buf, session, isDemo);
                }
                await this.sendAndAutoRecall(groupId, '单面打印完成', session.msgIds, 10000);
            } else {
                await this.sendAndAutoRecall(groupId, '已完成', session.msgIds, 10000);
            }
            if (session.msgIds && session.msgIds.length > 0) {
                for (const id of session.msgIds) {
                    await this.recallMessage(id);
                }
                session.msgIds = [];
            }
            this.sessions.delete(userId);
            return true;
        }

        // 双面模式 - 处理图片
        if (session && session.stage === this.STAGE.DUPLEX &&
            (msg.includes('[CQ:image') || msg.includes('[CQ:file'))) {
            
            try {
                const result = await this.downloadFile(msg);
                
                if (result.isPdf) {
                    await this.sendAndAutoRecall(groupId, 'PDF双面打印...', session.msgIds, 5000);
                    await this.printPdf(groupId, result.buffer, session, isDemo);
                    await this.sendAndAutoRecall(groupId, 'PDF双面完成', session.msgIds, 10000);
                    if (session.msgIds && session.msgIds.length > 0) {
                        for (const id of session.msgIds) {
                            await this.recallMessage(id);
                        }
                        session.msgIds = [];
                    }
                    this.sessions.delete(userId);
                    return true;
                }
                
                session.queue.push(result.buffer);
                session.lastActive = Date.now();
                
                if (session.queue.length === 1) {
                    await this.sendAndAutoRecall(groupId, '已收第1张，请发背面', session.msgIds, 10000);
                } else if (session.queue.length === 2) {
                    const pairNum = (session.pairCount || 0) + 1;
                    session.pairCount = pairNum;
                    const buf1 = session.queue[0];
                    const buf2 = session.queue[1];
                    session.queue = [];
                    
                    await this.sendAndAutoRecall(groupId, '双面打印第' + pairNum + '组...', session.msgIds, 5000);
                    await this.printDoubleSided(groupId, buf1, buf2, session, isDemo);
                    await this.sendAndAutoRecall(groupId, '第' + pairNum + '组完成', session.msgIds, 10000);
                }
                
            } catch (error) {
                await this.sendAndAutoRecall(groupId, '错误: ' + error.message, session.msgIds, 10000);
                console.error(`[Print]`, error);
            }
            return true;
        }

        // ==========================================
        // 去黑模式
        // ==========================================
        if (msg === '去黑' || msg === '去黑底') {
            this.userModes.set(userId, { mode: 'black', lastActive: Date.now() });
            this.sessions.delete(userId);
            const newSession = { msgIds: [], lastActive: Date.now() };
            this.sessions.set(userId, newSession);
            let tip = '[去黑底]\n';
            tip += '-------------------\n';
            tip += '发图自动去黑底\n';
            tip += '发预览后打印\n';
            tip += '发「取消」退出';
            if (isDemo) {
                tip += '\n[演示模式]';
            }
            await this.sendAndAutoRecall(groupId, tip, newSession.msgIds, 10000);
            return true;
        }

        // 去黑 - 处理图片
        if (userMode && userMode.mode === 'black' &&
            (msg.includes('[CQ:image') || msg.includes('[CQ:file'))) {
            
            const session2 = this.sessions.get(userId) || { msgIds: [], lastActive: Date.now() };
            this.sessions.set(userId, session2);
            
            try {
                const result = await this.downloadFile(msg);
                await this.sendAndAutoRecall(groupId, '去黑处理...', session2.msgIds, 5000);
                
                const processed = await this.removeDarkBackground(result.buffer);
                await this.sendPreview(groupId, processed, '[预览]');
                await this.recallUserMessages(userId);
                
                await this.sendAndAutoRecall(groupId, '打印...', session2.msgIds, 5000);
                await this.printImage(groupId, processed, session2, isDemo);
                
                await this.sendAndAutoRecall(groupId, '打印完成', session2.msgIds, 10000);
                
            } catch (error) {
                await this.sendAndAutoRecall(groupId, '错误: ' + error.message, session2.msgIds, 10000);
                console.error(`[Print]`, error);
            }
            return true;
        }

        // ==========================================
        // A3模式（移植狂打算法）
        // ==========================================
        if (msg === 'a3' || msg === 'A3') {
            this.userModes.set(userId, { mode: 'a3', lastActive: Date.now() });
            this.sessions.delete(userId);
            const newSession = { msgIds: [], lastActive: Date.now(), cutJobs: [] };
            this.sessions.set(userId, newSession);
            let tip = '[A3切割]\n';
            tip += '-------------------\n';
            tip += '发A3图片或PDF（可多张）\n';
            tip += '自动检测中缝切割\n';
            tip += '发「完成」选打印方式\n';
            tip += '发「取消」退出'
            if (isDemo) {
                tip += '\n[演示模式]';
            }
            await this.sendAndAutoRecall(groupId, tip, newSession.msgIds, 10000);
            return true;
        }

        // A3 - 完成 / 取消（统一收尾）
        if (userMode && userMode.mode === 'a3' && (msg === '完成' || msg === '退出' || msg === '取消')) {
            const s = this.sessions.get(userId) || { msgIds: [] };
            if (msg === '完成') {
                if (s.stage === this.STAGE.WAITING_CUTS) {
                    await this.sendAndAutoRecall(groupId, '请先回复切割份数', s.msgIds, 10000);
                    return true;
                }
                if (!s.cutJobs || s.cutJobs.length === 0) {
                    await this.sendAndAutoRecall(groupId, '还没有图', s.msgIds, 10000);
                    return true;
                }
                const total = s.cutJobs.reduce(function (a, j) { return a + j.buffers.length; }, 0);
                s.stage = this.STAGE.WAITING_PRINT;
                await this.sendAndAutoRecall(groupId,
                    '共 ' + total + ' 张，选打印方式:\n' +
                    '1. 单面打印\n' +
                    '2. 双面打印\n' +
                    '取消退出',
                    s.msgIds, 15000
                );
            } else {
                this.sessions.delete(userId);
                this.userModes.delete(userId);
                await this.sendAndAutoRecall(groupId, '已退出A3', s.msgIds, 10000);
            }
            return true;
        }

        // A3 - 接收文件（仅在收图阶段接收，避免与子状态冲突）
        const a3Session = this.sessions.get(userId);
        if (userMode && userMode.mode === 'a3' && (!a3Session || !a3Session.stage) &&
            (msg.includes('[CQ:image') || msg.includes('[CQ:file'))) {
            const session2 = a3Session || { msgIds: [], lastActive: Date.now(), cutJobs: [] };
            this.sessions.set(userId, session2);

            try {
                const result = await this.downloadFile(msg);

                // 组装待处理页：图片=1页；PDF=逐页渲染
                let sheets = [];
                if (result.isPdf) {
                    await this.sendAndAutoRecall(groupId, 'PDF逐页渲染...', session2.msgIds, 5000);
                    const pdfImgs = await this.renderPdfToImages(result.buffer);
                    if (!pdfImgs || pdfImgs.length === 0) {
                        await this.sendAndAutoRecall(groupId, 'PDF无页面', session2.msgIds, 10000);
                        return true;
                    }
                    for (const p of pdfImgs) sheets.push({ imagePath: p, preview: false });
                } else {
                    const imagePath = path.join(this.tempDir, `a3_${Date.now()}.jpg`);
                    fs.writeFileSync(imagePath, result.buffer);
                    sheets.push({ imagePath: imagePath, preview: true });
                }

                for (let si = 0; si < sheets.length; si++) {
                    const sh = sheets[si];
                    const sizeOut = await execPromise(`identify -format "%w %h" "${sh.imagePath}"`, 15000);
                    const sizeStr = sizeOut.stdout ? sizeOut.stdout.trim() : sizeOut.toString().trim();
                    const [w, h] = sizeStr.split(/\s+/).map(Number);
                    const dir = w > h ? 'vertical' : 'horizontal';
                    const dirLabel = dir === 'vertical' ? '竖版(左右切)' : '横版(上下切)';
                    if (sheets.length > 1) {
                        await this.sendAndAutoRecall(groupId, '第 ' + (si + 1) + '/' + sheets.length + ' 页: ' + dirLabel + ' | ' + w + 'x' + h, session2.msgIds, 5000);
                    } else {
                        await this.sendAndAutoRecall(groupId, '方向: ' + dirLabel + ' | ' + w + 'x' + h, session2.msgIds, 5000);
                    }

                    const detectResult = await this.detectParts(sh.imagePath, w, h);
                    const parts = detectResult.parts;
                    const positions = detectResult.positions;

                    if (parts === 0) {
                        session2.stage = this.STAGE.WAITING_CUTS;
                        session2.imagePath = sh.imagePath;
                        session2.direction = dir;
                        await this.sendAndAutoRecall(groupId, '未检测到中缝\n请回复切割份数 (2-9)', session2.msgIds, 10000);
                        return true;
                    }

                    await this.sendAndAutoRecall(groupId, '检测到 ' + parts + ' 开，中缝位置: ' + positions.map(p => (p * 100).toFixed(0) + '%').join(', '), session2.msgIds, 5000);
                    await this.sendAndAutoRecall(groupId, '正在切割...', session2.msgIds, 5000);

                    const cutFiles = await this.splitImageByPosition(sh.imagePath, dir, positions);

                    const buffers = [];
                    for (const f of cutFiles) {
                        const buf = fs.readFileSync(f);
                        buffers.push(buf);
                        if (sh.preview) {
                            const preview = path.join(this.tempDir, `prev_${Date.now()}.jpg`);
                            await execPromise(`convert "${f}" "${preview}"`, 5000);
                            const previewBuf = fs.readFileSync(preview);
                            await this.sendPreview(groupId, previewBuf, '预览');
                            try { fs.unlinkSync(preview); } catch(e) {}
                        }
                        try { fs.unlinkSync(f); } catch(e) {}
                    }
                    try { if (fs.existsSync(sh.imagePath)) fs.unlinkSync(sh.imagePath); } catch(e) {}

                    if (!session2.cutJobs) session2.cutJobs = [];
                    session2.cutJobs.push({ buffers: buffers });

                    if (sheets.length > 1) {
                        const acc = session2.cutJobs.reduce(function (a, j) { return a + j.buffers.length; }, 0);
                        await this.sendAndAutoRecall(groupId, '第 ' + (si + 1) + ' 页已切 ' + buffers.length + ' 张（累计 ' + acc + ' 张）', session2.msgIds, 8000);
                    }
                }

                if (sheets.length === 1) {
                    const total = session2.cutJobs.reduce(function (a, j) { return a + j.buffers.length; }, 0);
                    await this.sendAndAutoRecall(groupId,
                        '已切割 ' + total + ' 张（累计 ' + total + ' 张）\n' +
                        '继续发图，或发「完成」选打印方式',
                        session2.msgIds, 8000
                    );
                } else {
                    const total = session2.cutJobs.reduce(function (a, j) { return a + j.buffers.length; }, 0);
                    await this.sendAndAutoRecall(groupId,
                        '共 ' + sheets.length + ' 页已切完，累计 ' + total + ' 张\n继续发图，或发「完成」选打印方式',
                        session2.msgIds, 8000
                    );
                }

            } catch (error) {
                await this.sendAndAutoRecall(groupId, '错误: ' + error.message, session2.msgIds, 10000);
                console.error(`[Print] A3错误:`, error);
            }
            return true;
        }

        // A3 - 手动切割份数
        if (session && session.stage === this.STAGE.WAITING_CUTS && /^\d+$/.test(msg)) {
            const num = parseInt(msg);
            if (num < 2 || num > 9) {
                await this.sendAndAutoRecall(groupId, '请输入2-9', session.msgIds, 10000);
                return true;
            }

            try {
            const imgPath = session.imagePath;
            const dir = session.direction;
            
            await this.sendAndAutoRecall(groupId, '切割为 ' + num + ' 份...', session.msgIds, 5000);
            
            const positions = [];
            for (let i = 1; i < num; i++) positions.push(i / num);
            const cutFiles = await this.splitImageByPosition(imgPath, dir, positions);
            
            const buffers = [];
            for (const f of cutFiles) {
                const buf = fs.readFileSync(f);
                buffers.push(buf);
                const preview = path.join(this.tempDir, `prev_${Date.now()}.jpg`);
                await execPromise(`convert "${f}" "${preview}"`, 5000);
                const previewBuf = fs.readFileSync(preview);
                await this.sendPreview(groupId, previewBuf, '预览');
                try { fs.unlinkSync(preview); } catch(e) {}
                try { fs.unlinkSync(f); } catch(e) {}
            }
            try { if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath); } catch(e) {}

            if (!session.cutJobs) session.cutJobs = [];
            session.cutJobs.push({ buffers: buffers });
            const total = session.cutJobs.reduce(function (a, j) { return a + j.buffers.length; }, 0);
            session.stage = null;
            await this.sendAndAutoRecall(groupId,
                '已切割 ' + buffers.length + ' 张（累计 ' + total + ' 张）\n' +
                '继续发图，或发「完成」选打印方式',
                session.msgIds, 8000
            );
            } catch (error) {
                await this.sendAndAutoRecall(groupId, '切割错误: ' + error.message, session.msgIds, 10000);
                console.error('[Print] 手动切割错误:', error);
            }
            return true;
        }

        // A3 - 打印选择
        if (session && session.stage === this.STAGE.WAITING_PRINT && (msg === '1' || msg === '2')) {
            try {
            const isDouble = msg === '2';
            const allBuffers = [];
            if (session.cutJobs) {
                for (const job of session.cutJobs) {
                    for (const b of job.buffers) allBuffers.push(b);
                }
            }
            if (allBuffers.length === 0 && session.cutBuffers) {
                for (const b of session.cutBuffers) allBuffers.push(b);
            }

            await this.sendAndAutoRecall(groupId, (isDouble ? '双面' : '单面') + '打印... (共' + allBuffers.length + '张)', session.msgIds, 5000);

            if (isDouble) {
                for (let i = 0; i < allBuffers.length; i += 2) {
                    if (i + 1 < allBuffers.length) {
                        await this.printDoubleSided(groupId, allBuffers[i], allBuffers[i + 1], session, isDemo);
                    } else {
                        await this.printImage(groupId, allBuffers[i], session, isDemo);
                    }
                }
            } else {
                for (const buf of allBuffers) {
                    await this.printImage(groupId, buf, session, isDemo);
                }
            }

            if (session.msgIds && session.msgIds.length > 0) {
                for (const id of session.msgIds) {
                    await this.recallMessage(id);
                }
                session.msgIds = [];
            }
            await this.recallUserMessages(userId);
            await this.sendAndAutoRecall(groupId, '打印完成', session.msgIds, 10000);
            this.sessions.delete(userId);
            this.userModes.delete(userId);
            } catch (error) {
                await this.sendAndAutoRecall(groupId, '打印错误: ' + error.message, session.msgIds, 10000);
                console.error('[Print] 打印错误:', error);
            }
            return true;
        }

        // ==========================================
        // 拼图模式
        // ==========================================
        if (msg === '拼图') {
            this.userModes.set(userId, {
                mode: 'stitch',
                images: [],
                lastActive: Date.now()
            });
            this.sessions.delete(userId);
            const newSession = { msgIds: [], lastActive: Date.now() };
            this.sessions.set(userId, newSession);
            let tip = '[拼图]\n';
            tip += '-------------------\n';
            tip += '发图，发「完成」开始拼\n';
            tip += '发「取消」退出';
            if (isDemo) {
                tip += '\n[演示模式]';
            }
            await this.sendAndAutoRecall(groupId, tip, newSession.msgIds, 10000);
            return true;
        }

        if (userMode && userMode.mode === 'stitch' &&
            (msg.includes('[CQ:image') || msg.includes('[CQ:file'))) {
            userMode.lastActive = Date.now();
            if (!userMode.images) userMode.images = [];
            userMode.images.push(msg);
            const session2 = this.sessions.get(userId) || { msgIds: [], lastActive: Date.now() };
            this.sessions.set(userId, session2);
            await this.sendAndAutoRecall(groupId, '已收 ' + userMode.images.length + ' 张', session2.msgIds, 10000);
            return true;
        }

        if (userMode && userMode.mode === 'stitch' && msg === '完成') {
            const images = userMode.images || [];
            const session2 = this.sessions.get(userId) || { msgIds: [], lastActive: Date.now() };
            this.sessions.set(userId, session2);
            
            if (images.length === 0) {
                await this.sendAndAutoRecall(groupId, '还没有图片', session2.msgIds, 10000);
                return true;
            }

            const buffers = [];
            for (const img of images) {
                try {
                    const result = await this.downloadFile(img);
                    if (result.buffer && !result.isPdf) {
                        buffers.push(result.buffer);
                    }
                } catch (e) {}
            }

            if (buffers.length === 0) {
                await this.sendAndAutoRecall(groupId, '没有可用图片', session2.msgIds, 10000);
                this.userModes.delete(userId);
                return true;
            }

            const layouts = this.getLayouts(buffers.length);
            let replyMsg = '[选择排版]\n';
            replyMsg += '-------------------\n';
            const previewMsgIds = [];
            
            for (let i = 0; i < layouts.length; i++) {
                const pp = layouts[i].rows * layouts[i].cols;
                const pages = Math.ceil(buffers.length / pp);
                replyMsg += (i+1) + '. ' + layouts[i].cols + 'x' + layouts[i].rows + '（' + pages + '页）\n';
                
                try {
                    const preview = await this.stitchImages(
                        buffers, layouts[i].rows, layouts[i].cols, 0, Math.min(pp, buffers.length)
                    );
                    const previewMsgId = await this.sendPreview(groupId, preview, '方案' + (i+1) + '预览');
                    if (previewMsgId) {
                        previewMsgIds.push(previewMsgId);
                    }
                } catch (e) {
                    await this.sendAndAutoRecall(groupId, '方案' + (i+1) + '预览失败', session2.msgIds, 5000);
                }
            }
            replyMsg += '-------------------\n';
            replyMsg += '回复序号打印';

            session2.stage = this.STAGE.WAITING_LAYOUT;
            session2.buffers = buffers;
            session2.layouts = layouts;
            session2.previewMsgIds = previewMsgIds;
            session2.lastActive = Date.now();
            
            await this.recallUserMessages(userId);
            this.userModes.delete(userId);
            await this.sendAndAutoRecall(groupId, replyMsg, session2.msgIds, 15000);
            return true;
        }

        // 拼图 - 选择布局
        if (session && session.stage === this.STAGE.WAITING_LAYOUT && /^\d+$/.test(msg)) {
            const idx = parseInt(msg) - 1;
            if (idx < 0 || idx >= session.layouts.length) {
                await this.sendAndAutoRecall(groupId, '无效序号', session.msgIds, 10000);
                return true;
            }

            if (session.previewMsgIds) {
                for (let i = 0; i < session.previewMsgIds.length; i++) {
                    if (i !== idx) {
                        await this.recallMessage(session.previewMsgIds[i]);
                    }
                }
            }

            if (session.msgIds && session.msgIds.length > 0) {
                for (const id of session.msgIds) {
                    await this.recallMessage(id);
                }
                session.msgIds = [];
            }
            await this.recallUserMessages(userId);

            const layout = session.layouts[idx];
            const pp = layout.rows * layout.cols;
            const pages = Math.ceil(session.buffers.length / pp);

            await this.sendAndAutoRecall(groupId, '打印... (' + layout.cols + 'x' + layout.rows + ')', session.msgIds, 5000);
            
            for (let p = 0; p < pages; p++) {
                const cnt = Math.min(pp, session.buffers.length - p * pp);
                const pageBuf = await this.stitchImages(
                    session.buffers, layout.rows, layout.cols, p * pp, cnt
                );
                await this.printImage(groupId, pageBuf, session, isDemo);
            }

            session.stage = this.STAGE.COMPLETED;
            await this.sendAndAutoRecall(groupId, '拼图完成，共' + pages + '页', session.msgIds, 10000);
            this.sessions.delete(userId);
            this.userModes.delete(userId);
            return true;
        }

        // ==========================================
        // 极速模式
        // ==========================================
        if (msg.includes('[CQ:image') || msg.includes('[CQ:file')) {
            if (userMode && (userMode.mode === 'black' || userMode.mode === 'a3' || userMode.mode === 'stitch')) {
                return false;
            }
            if (session && session.stage === this.STAGE.DUPLEX) {
                return false;
            }
            
            try {
                const result = await this.downloadFile(msg);
                await this.sendAndAutoRecall(groupId, '打印...', session.msgIds, 5000);
                
                if (result.isPdf) {
                    await this.printPdf(groupId, result.buffer, session, isDemo);
                } else {
                    await this.printImage(groupId, result.buffer, session, isDemo);
                }
                await this.sendAndAutoRecall(groupId, '打印完成', session.msgIds, 10000);
                
            } catch (error) {
                await this.sendAndAutoRecall(groupId, '错误: ' + error.message, session.msgIds, 10000);
                console.error(`[Print]`, error);
            }
            return true;
        }

        // ==========================================
        // 无关消息
        // ==========================================
        if (!userMode && !session?.stage) {
            await this.sendGroupMessage(groupId, 
                '[!] 无活跃任务\n' +
                '发「去黑」「双面」「a3」「拼图」\n' +
                '直接发图极速打印\n' +
                '发「菜单」查看所有命令'
            );
            return true;
        }

        return false;
    }
}

module.exports = PrintPlugin;
