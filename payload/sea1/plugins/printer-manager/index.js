/**
 * SEA1 插件：printer-manager - 打印机管理（含 USB 发现与一键接入 CUPS）
 */

const BasePlugin = require('../base-plugin');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

class PrinterManagerPlugin extends BasePlugin {
    constructor(name, config) {
        super(name, config);
        this.priority = 15;
        this.permissionLevel = 0; // 临时改为 0，允许所有用户测试
        this.configPath = path.join(__dirname, '../../config.json');
        this.printerConfig = null;
        this.printerCache = [];
        this.lastScanTime = 0;
        this.cacheTTL = 60000;
        // 已装入 CUPS 的打印机缓存（用于「发现」时区分已接入/未接入）
        this.installedCache = [];
        this.installedScanTime = 0;
    }

    async onEnable(db) {
        console.log(`[PrinterManager] ════════════════════════════════════`);
        console.log(`[PrinterManager] 打印机管理插件 v2.2 正在加载...`);
        await this.loadPrinterConfig();
        await this.scanPrinters();
        console.log(`[PrinterManager] 默认打印机: ${this.printerConfig?.default || '未设置'}`);
        console.log(`[PrinterManager] 已配置: ${(this.printerConfig?.printers || []).join(', ') || '无'}`);
        console.log(`[PrinterManager] ════════════════════════════════════`);

        // v2.2：USB 热插拔主动发现 —— 设备插上后主动推群提醒，引导「#打印机接入」
        this._usbKnown = new Set();        // 已扫到的 USB 打印机指纹，避免重复推送
        this._usbNotified = new Set();     // 已推送提醒的设备指纹
        this._usbTimer = null;
        this._usbPollMs = 20000;           // 轮询间隔 20s（足够灵敏又不刷屏）
        try {
            // 启动即建立基线，期间接入的设备才会被当作「新增」
            const base = await this.scanUsbPrinters();
            base.forEach(d => this._usbKnown.add(d.fingerprint));
            this._usbTimer = setInterval(() => this.usbHotplugTick().catch(() => {}), this._usbPollMs);
            if (this._usbTimer.unref) this._usbTimer.unref();
            console.log(`[PrinterManager] 🔌 USB 热插拔监听已启动（每 ${this._usbPollMs / 1000}s 轮询）`);
        } catch (e) {
            // 监听失败绝不影响打印主流程
            console.error(`[PrinterManager] USB 监听启动失败（已降级，不影响打印）: ${e.message}`);
        }
    }

    async onDisable(db) {
        if (this._usbTimer) {
            try { clearInterval(this._usbTimer); } catch (e) {}
            this._usbTimer = null;
        }
        this._usbKnown = null;
        this._usbNotified = null;
        console.log(`[PrinterManager] 打印机管理插件已卸载（USB 监听已停止）`);
    }

    /**
     * USB 热插拔轮询：检测新增的 USB 打印机，并向通知群主动推送接入引导
     */
    async usbHotplugTick() {
        const devices = await this.scanUsbPrinters();
        const nowKnown = new Set();
        const newOnes = [];
        for (const d of devices) {
            nowKnown.add(d.fingerprint);
            // 仅当：从未见过 + 尚未推送过提醒 + 尚未装入 CUPS
            if (!this._usbKnown.has(d.fingerprint) && !this._usbNotified.has(d.fingerprint) && !d.installed) {
                newOnes.push(d);
                this._usbNotified.add(d.fingerprint);
            }
        }
        this._usbKnown = nowKnown;

        if (newOnes.length === 0) return;

        const lines = newOnes.map((d, i) =>
            `${i + 1}. ${d.label}${d.installed ? '（已接入 CUPS）' : ''}\n   URI: ${d.uri}`
        ).join('\n');
        const msg =
            `🔌 检测到 ${newOnes.length} 台新接入的 USB 打印机！\n\n` +
            `${lines}\n\n` +
            `👉 只需回复：\`#打印机接入 auto\`\n` +
            `机器人会自动装入 CUPS、设为默认并打测试页，全程无需手动配置。`;

        // 主动推送到通知群（复用 sea.js 暴露的 qqAdapter；取不到则降级为日志）
        const adapter = global.sea1 && global.sea1.qqAdapter;
        const groups = (this.config && this.config.notify_groups) || (global.sea1 && global.sea1.config && global.sea1.config.notify_groups) || [];
        if (adapter && groups.length) {
            for (const g of groups) {
                try { await adapter.send(g, msg, { groupId: g }); } catch (e) { /* 单群失败不影响其他 */ }
            }
            console.log(`[PrinterManager] 🔔 已向 ${groups.length} 个群推送 USB 打印机接入提醒`);
        } else {
            console.log(`[PrinterManager] 🔔 检测到新 USB 打印机（未配置 qqAdapter/通知群，仅日志提示）:\n${lines}`);
        }
    }

    /**
     * 扫描系统中 USB 直连打印机（lsusb + lpinfo），返回带指纹/是否已装入 CUPS 的设备列表
     */
    async scanUsbPrinters() {
        try {
            // 1) lpinfo 取当前可用 USB 设备 URI（含 usb:// 与 ippusb://）
            const { stdout: lpinfo } = await execPromise('lpinfo -v 2>/dev/null');
            const devices = this.parseUsbDevices(lpinfo);
            // 2) lpstat -v 取已装入 CUPS 的队列→URI 映射
            let installedUris = new Set();
            try {
                const { stdout: lpstatV } = await execPromise('lpstat -v 2>/dev/null');
                const re = /device for\s+([^\s:]+):\s+(\S+)/g;
                let m;
                while ((m = re.exec(lpstatV)) !== null) installedUris.add(m[2]);
            } catch (e) {}

            for (const d of devices) {
                d.installed = installedUris.has(d.uri);
                // 指纹：用设备 URI（稳定且唯一）作为去重键
                d.fingerprint = d.uri;
            }
            return devices;
        } catch (e) {
            console.error(`[PrinterManager] 扫描 USB 打印机失败: ${e.message}`);
            return [];
        }
    }

    async loadPrinterConfig() {
        try {
            const configData = await fs.readFile(this.configPath, 'utf-8');
            const config = JSON.parse(configData);
            if (!config.printer) {
                config.printer = { default: null, printers: [] };
            }
            if (!Array.isArray(config.printer.printers)) {
                config.printer.printers = [];
            }
            this.printerConfig = config.printer;
            return config.printer;
        } catch (error) {
            console.error(`[PrinterManager] 加载配置失败:`, error.message);
            this.printerConfig = { default: null, printers: [] };
            await this.savePrinterConfig();
            return this.printerConfig;
        }
    }

    async savePrinterConfig() {
        try {
            const configData = await fs.readFile(this.configPath, 'utf-8');
            const config = JSON.parse(configData);
            config.printer = this.printerConfig;
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
            console.log(`[PrinterManager] ✅ 配置已保存`);
            return true;
        } catch (error) {
            console.error(`[PrinterManager] 保存配置失败:`, error.message);
            throw error;
        }
    }

    /**
     * 扫描 CUPS 中已存在的打印机（lpstat -p -d）
     */
    async scanPrinters(force = false) {
        const now = Date.now();
        if (!force && this.printerCache.length > 0 && (now - this.lastScanTime) < this.cacheTTL) {
            return this.printerCache;
        }

        try {
            const printers = [];
            console.log(`[PrinterManager] 正在扫描打印机...`);
            const { stdout } = await execPromise('lpstat -p -d 2>/dev/null');
            console.log(`[PrinterManager] lpstat 输出:`, stdout);
            const lines = stdout.split('\n');
            for (const line of lines) {
                const printerMatch = line.match(/^printer\s+([^\s]+)\s+is\s+([^\s]+)/);
                if (printerMatch) {
                    printers.push({
                        name: printerMatch[1],
                        status: printerMatch[2],
                        description: line.trim()
                    });
                }
            }
            this.printerCache = printers;
            this.lastScanTime = now;
            console.log(`[PrinterManager] 扫描完成，找到 ${printers.length} 台打印机`);
            return printers;
        } catch (error) {
            console.error(`[PrinterManager] 扫描打印机失败:`, error.message);
            return [];
        }
    }

    /**
     * 从 lpinfo -v 解析「当前系统中可用的 USB / 直连打印机设备 URI」
     * 仅返回物理/直连后端：usb:// 与 ippusb://（本地 USB 设备）
     * 排除网络后端（socket://, ipp://, http://, lpd://, smb://, dnssd://, mdns://）
     */
    parseUsbDevices(lpinfoOutput) {
        const devices = [];
        const seen = new Set();
        const lines = (lpinfoOutput || '').split('\n');
        for (const raw of lines) {
            const line = raw.trim();
            // lpinfo -v 行形如: "direct usb://HP/...?serial=xxx" 或 "network socket://..."
            const m = line.match(/^(direct|network)\s+(\S+)$/);
            if (!m) continue;
            const backend = m[1];            // direct | network
            const uri = m[2];                 // 完整设备 URI
            // 仅纳入本地直连 USB 设备
            const isUsb = /^usb:\/\//i.test(uri) || /^ippusb:\/\//i.test(uri);
            if (backend !== 'direct' || !isUsb) continue;
            if (seen.has(uri)) continue;
            seen.add(uri);
            // 从 URI 提取可读的设备标签：usb://<厂商>/<型号>...
            const labelMatch = uri.match(/^usb:\/\/([^/?]+)(?:\/([^?]+))?/i);
            let label = 'USB 打印机';
            if (labelMatch) {
                const vendor = (labelMatch[1] || '').replace(/_/g, ' ').trim();
                const model = (labelMatch[2] || '').replace(/_/g, ' ').split('?')[0].trim();
                label = [vendor, model].filter(Boolean).join(' ').trim() || 'USB 打印机';
            }
            devices.push({ uri, label });
        }
        return devices;
    }

    /**
     * 读取 CUPS 当前已安装的打印机队列名集合（用于判断某 USB 设备是否已接入）
     */
    async getInstalledQueueNames(force = false) {
        const now = Date.now();
        if (!force && this.installedCache.length > 0 && (now - this.installedScanTime) < this.cacheTTL) {
            return this.installedCache;
        }
        try {
            const { stdout } = await execPromise('lpstat -p 2>/dev/null');
            const names = [];
            for (const line of stdout.split('\n')) {
                const m = line.match(/^printer\s+([^\s]+)\s+/);
                if (m) names.push(m[1]);
            }
            this.installedCache = names;
            this.installedScanTime = now;
            return names;
        } catch (e) {
            return [];
        }
    }

    /**
     * 读取 CUPS 队列 -> 设备URI 映射（lpstat -v 形如 "device for NAME: usb://..."）
     * 用于精确判断某 USB 设备是否已装入某个队列（比 URI 字符串包含匹配更可靠）
     */
    async getQueueDeviceMap(force = false) {
        const now = Date.now();
        if (!force && this.queueDeviceCache && this.queueDeviceCache.size > 0 && (now - (this.queueDeviceScanTime || 0)) < this.cacheTTL) {
            return this.queueDeviceCache;
        }
        const map = new Map();
        try {
            const { stdout } = await execPromise('lpstat -v 2>/dev/null');
            for (const line of stdout.split('\n')) {
                const m = line.match(/^device for\s+([^\s:]+):\s+(\S+)/i);
                if (m) map.set(m[1], decodeURIComponent(m[2]));
            }
        } catch (e) { /* 忽略 */ }
        this.queueDeviceCache = map;
        this.queueDeviceScanTime = now;
        return map;
    }

    /**
     * 判断某 USB 设备 URI 是否已装入某个 CUPS 队列
     */
    async isDeviceInstalled(uri) {
        const map = await this.getQueueDeviceMap(true);
        const norm = (s) => decodeURIComponent(s || '').toLowerCase().replace(/\/$/, '');
        const target = norm(uri);
        for (const dev of map.values()) {
            if (norm(dev) === target) return true;
        }
        return false;
    }

    /**
     * 把 lpinfo 的 USB 设备 URI 转成合法的 CUPS 队列名
     * 规则：取厂商+型号首词，小写，非字母数字转下，长度裁剪；避免与已有冲突则加序号
     */
    async suggestQueueName(uri, installed) {
        let base = 'usb_printer';
        const m = uri.match(/^usb:\/\/([^/?]+)(?:\/([^?]+))?/i);
        if (m) {
            const vendor = (m[1] || '').replace(/[^a-zA-Z0-9]/g, '');
            const model = ((m[2] || '').split('?')[0]).replace(/[^a-zA-Z0-9]/g, '');
            const parts = [vendor, model].filter(Boolean);
            if (parts.length) {
                base = parts.join('_').toLowerCase().slice(0, 24) || 'usb_printer';
            }
        }
        let name = base;
        let i = 2;
        const cfgPrinters = (this.printerConfig && this.printerConfig.printers) || [];
        const all = new Set([...installed, ...cfgPrinters]);
        while (all.has(name)) {
            name = `${base}_${i++}`;
        }
        return name;
    }

    /**
     * 通过 lpadmin 把 USB 设备接入 CUPS
     * 驱动策略：
     *  - forceDriver='everywhere'（默认）：优先用通用 IPP Everywhere 驱动（免 PPD，最稳）
     *  - forceDriver='raw'：使用 raw 驱动（某些老型号/特殊协议 everywere 不支持时回退）
     *  - 自动回退：everywhere 失败且 nonforced 时，自动重试 raw
     * 返回 { ok, driver, stdout, stderr }
     */
    async installPrinter(queueName, uri, forceDriver = null) {
        const tryOnce = async (driver) => {
            const cmd = `lpadmin -p "${queueName}" -E -v "${uri}" -m ${driver}`;
            const { stdout, stderr } = await execPromise(cmd + ' 2>&1');
            return { stdout, stderr };
        };
        const accept = async () => {
            await execPromise(`cupsaccept "${queueName}" 2>/dev/null; cupsenable "${queueName}" 2>/dev/null`).catch(() => {});
        };
        let driver = forceDriver || 'everywhere';
        let res = await tryOnce(driver);
        // 校验是否真装上了（队列存在）
        const after = await this.getInstalledQueueNames(true);
        if (!after.includes(queueName) && !forceDriver) {
            // everywere 不支持 -> 回退 raw
            driver = 'raw';
            res = await tryOnce(driver);
        }
        await accept();
        return { ok: true, driver, stdout: res.stdout, stderr: res.stderr };
    }

    /**
     * 将队列注册进系统配置（config.json 的 printer 块）并设默认
     */
    async registerToConfig(queueName, { setDefault = true } = {}) {
        if (!this.printerConfig.printers.includes(queueName)) {
            this.printerConfig.printers.push(queueName);
        }
        if (setDefault || !this.printerConfig.default) {
            this.printerConfig.default = queueName;
        }
        await this.savePrinterConfig();
    }

    /**
     * 装好打印机后，热重载 print 插件，让新的默认打印机立即生效（无需重启 bot）
     */
    async hotReloadPrint() {
        try {
            const pm = global.sea1 && global.sea1.pluginManager;
            if (pm && typeof pm.reloadPlugin === 'function') {
                await pm.reloadPlugin('print');
                console.log('[PrinterManager] ✅ print 插件已热重载，新默认打印机生效');
                return true;
            }
        } catch (e) {
            console.warn('[PrinterManager] 热重载 print 失败（不影响 CUPS 配置）:', e.message);
        }
        return false;
    }

    /**
     * 打印一张测试页，验证「队列 -> 物理打印机」整条链路真正可用
     * 默认打 CUPS 自带测试页（/usr/share/cups/data/testprint）；
     * queue 为空则用系统默认队列。返回 { ok, jobId, queue, error }
     */
    async testPrint(queue) {
        try {
            const target = (queue && queue.trim()) || this.printerConfig.default;
            if (!target) {
                return { ok: false, error: '未指定队列且无默认打印机' };
            }
            // 校验队列存在
            const installed = await this.getInstalledQueueNames(true);
            if (!installed.includes(target)) {
                return { ok: false, error: `队列「${target}」不存在于 CUPS` };
            }
            const testPage = '/usr/share/cups/data/testprint';
            const cmd = `lp -d "${target}" ${testPage}`;
            const { stdout, stderr } = await execPromise(cmd + ' 2>&1');
            const jobMatch = stdout.match(/request id is ([^\s]+)/i) || stderr.match(/request id is ([^\s]+)/i);
            const jobId = jobMatch ? jobMatch[1] : null;
            return { ok: true, jobId, queue: target, stdout, stderr };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    async onMessage(context) {
        const text = context.msg.trim();
        console.log(`[PrinterManager] 收到消息: "${text}"`);

        // 检查是否以 #打印机 开头
        if (!text.startsWith('#打印机')) {
            return false;
        }

        console.log(`[PrinterManager] 匹配到打印机命令`);

        // #打印机帮助
        if (text === '#打印机帮助' || text === '#打印机') {
            await context.reply(
                `🖨️ **打印机管理命令**\n\n` +
                `🔍 \`#打印机发现\` - 扫描并列出未接入的 USB 打印机\n` +
                `🔌 \`#打印机接入 [队列名|auto|URI]\` - 把发现的 USB 打印机装入 CUPS 并设默认\n` +
                `🧪 \`#打印机测试 [队列名]\` - 打印测试页，验证装好即能打\n` +
                `📋 \`#打印机列表\` - 查看已配置打印机\n` +
                `➕ \`#打印机添加 [名称]\` - 添加已存在的 CUPS 打印机\n` +
                `➖ \`#打印机删除 [名称]\` - 移除打印机\n` +
                `⭐ \`#打印机设置 [名称]\` - 设为默认\n` +
                `ℹ️ \`#打印机信息\` - 查看详细信息\n` +
                `♻️ \`#打印机重置\` - 重置配置\n\n` +
                `💡 新接一台 USB 打印机：先 \`#打印机发现\` 看设备，再 \`#打印机接入 队列名\` 一键装入系统（接入后自动打印测试页）。\n` +
                `💡 若通用驱动不支持某老型号，可重试 \`#打印机接入 队列名 --raw\` 使用原始驱动。`
            );
            return true;
        }

        // #打印机发现 —— 列出当前未接入 CUPS 的 USB 设备
        if (text === '#打印机发现' || text === '#发现打印机' || text === '#扫描USB') {
            await context.reply('🔍 正在扫描 USB / 直连打印机...');
            try {
                const { stdout: lpinfoOut } = await execPromise('lpinfo -v 2>/dev/null');
                const usbDevices = this.parseUsbDevices(lpinfoOut);
                const installed = await this.getInstalledQueueNames(true);

                if (usbDevices.length === 0) {
                    await context.reply(
                        '⚠️ 未发现任何 USB / 直连打印机设备。\n\n' +
                        '请检查：\n' +
                        '• 打印机 USB 线是否已连接并开机\n' +
                        '• 执行 `lsusb` 确认系统已识别设备\n' +
                        '• CUPS 后端是否包含 usb（需安装 cups / printer-driver）'
                    );
                    return true;
                }

                let reply = `🔌 发现 ${usbDevices.length} 个直连设备：\n\n`;
                for (const d of usbDevices) {
                    const already = await this.isDeviceInstalled(d.uri);
                    const queueMap = await this.getQueueDeviceMap(true);
                    let boundQueue = '';
                    for (const [q, dev] of queueMap.entries()) {
                        const n = (s) => decodeURIComponent(s || '').toLowerCase().replace(/\/$/, '');
                        if (n(dev) === n(d.uri)) { boundQueue = q; break; }
                    }
                    const tag = already ? `（已接入 → ${boundQueue}）` : '';
                    reply += `${usbDevices.indexOf(d) + 1}. ${d.label}${tag}\n   URI: ${d.uri}\n`;
                }
                reply += `\n👉 接入方式：\`#打印机接入 <队列名>\`\n` +
                         `   队列名将自动生成；也可在「发现」结果里任选一个 URI 后手动指定。`;
                await context.reply(reply);
            } catch (error) {
                await context.reply(`❌ 扫描失败: ${error.message}`);
            }
            return true;
        }

        // #打印机接入 <队列名|auto> —— 把发现的 USB 设备装入 CUPS
        const joinMatch = text.match(/^#打印机(?:接入|install|addusb)\s+(.+)$/i);
        if (joinMatch) {
            const rawArg = joinMatch[1].trim();
            // 解析可选驱动开关：--raw / --everywhere
            let forceDriver = null;
            let arg = rawArg;
            if (/\s--raw\b/i.test(rawArg)) { forceDriver = 'raw'; arg = rawArg.replace(/\s--raw\b/i, '').trim(); }
            else if (/\s--everywhere\b/i.test(rawArg)) { forceDriver = 'everywhere'; arg = rawArg.replace(/\s--everywhere\b/i, '').trim(); }
            await context.reply('🔧 正在处理接入请求...');
            try {
                const { stdout: lpinfoOut } = await execPromise('lpinfo -v 2>/dev/null');
                const usbDevices = this.parseUsbDevices(lpinfoOut);
                const installed = await this.getInstalledQueueNames(true);

                if (usbDevices.length === 0) {
                    await context.reply('⚠️ 当前没有可接入的 USB / 直连打印机。请先确认设备已连接并开机。');
                    return true;
                }

                let uri, queueName;
                if (arg === 'auto' || arg === '') {
                    // 默认接入第一个未接入的设备
                    const firstUninstalled = usbDevices.find(d => !installed.some(n => d.uri.toLowerCase().includes(n.toLowerCase())));
                    const target = firstUninstalled || usbDevices[0];
                    uri = target.uri;
                    queueName = await this.suggestQueueName(uri, installed);
                } else if (/^usb:\/\//i.test(arg) || /^ippusb:\/\//i.test(arg)) {
                    // 用户直接给了 URI
                    const found = usbDevices.find(d => d.uri === arg);
                    if (!found) {
                        await context.reply(`❌ 未发现该设备 URI：\n${arg}\n请先用 \`#打印机发现\` 复制正确的 URI。`);
                        return true;
                    }
                    uri = found.uri;
                    queueName = await this.suggestQueueName(uri, installed);
                } else {
                    // 用户给了自定义队列名：校验设备存在（默认取第一个未接入）
                    const firstUninstalled = usbDevices.find(d => !installed.some(n => d.uri.toLowerCase().includes(n.toLowerCase())));
                    const target = firstUninstalled || usbDevices[0];
                    uri = target.uri;
                    // 校验队列名合法性（CUPS 限制：字母数字 _ - .）
                    if (!/^[A-Za-z0-9_.\-]+$/.test(arg)) {
                        await context.reply('❌ 队列名只能包含字母、数字、下划线、减号、点。');
                        return true;
                    }
                    const all = new Set([...installed, ...(this.printerConfig.printers || [])]);
                    if (all.has(arg)) {
                        await context.reply(`⚠️ 队列名 "${arg}" 已存在，请换一个或先用 \`#打印机删除 ${arg}\`。`);
                        return true;
                    }
                    queueName = arg;
                }

                await context.reply(`📥 正在装入 CUPS：\n• 队列：${queueName}\n• 设备：${uri}`);
                const installRes = await this.installPrinter(queueName, uri, forceDriver);

                // 校验是否真装上了
                const afterInstall = await this.getInstalledQueueNames(true);
                if (!afterInstall.includes(queueName)) {
                    await context.reply('❌ 装入 CUPS 失败（设备可能不支持通用驱动，或 USB 权限不足）。\n可尝试带 `--raw` 重试：\n`#打印机接入 ' + queueName + ' --raw`');
                    return true;
                }

                await this.registerToConfig(queueName, { setDefault: true });
                const reloaded = await this.hotReloadPrint();

                // 自动跑一张测试页，验证「装好即能打」闭环
                await context.reply('🧪 正在打印测试页以验证链路...');
                const test = await this.testPrint(queueName);

                let reply = `✅ 打印机「${queueName}」已成功接入系统！\n\n`;
                reply += `• 设备：${uri}\n`;
                reply += `• 驱动：${installRes.driver === 'everywhere' ? '通用 IPP Everywhere（免 PPD）' : 'raw（原始驱动）'}\n`;
                reply += `• 已设为默认打印机${reloaded ? '（已热重载 print 插件，立即生效）' : '（重启 bot 后生效）'}\n`;
                if (test.ok) {
                    reply += `• 测试页：已发送作业 ${test.jobId || '(已提交)'}，请查看打印机出纸 ✅\n`;
                } else {
                    reply += '• ⚠️ 测试页发送失败：' + test.error + '（队列已建好，可手动 `#打印机测试 ' + queueName + '` 重试）\n';
                }
                reply += `\n现在可直接发图片/文件给它打印。`;
                await context.reply(reply);
            } catch (error) {
                await context.reply(`❌ 接入失败: ${error.message}`);
            }
            return true;
        }

        // #打印机测试 <队列名|默认> —— 打印测试页验证闭环
        const testMatch = text.match(/^#打印机(?:测试|test)\s*(.*)$/i);
        if (testMatch) {
            const q = (testMatch[1] || '').trim();
            await context.reply('🧪 正在发送测试页...');
            try {
                const test = await this.testPrint(q);
                if (test.ok) {
                    await context.reply(`✅ 测试页已发送到队列「${test.queue}」（作业号 ${test.jobId || '已提交'}）。\n请查看打印机是否正常出纸，以确认物理连接与驱动均正常。`);
                } else {
                    await context.reply(`❌ 测试打印失败：${test.error}\n\n可用队列请用 \`#打印机列表\` 查看。`);
                }
            } catch (error) {
                await context.reply(`❌ 测试打印异常: ${error.message}`);
            }
            return true;
        }

        // #打印机扫描（原有：扫描 CUPS 中已有打印机）
        if (text === '#打印机扫描' || text === '#扫描打印机') {
            console.log(`[PrinterManager] 执行扫描命令`);
            await context.reply('📡 正在扫描系统打印机...');
            try {
                const printers = await this.scanPrinters(true);
                if (printers.length === 0) {
                    await context.reply(
                        '❌ 未找到任何打印机。\n\n' +
                        '请确保 CUPS 已启动：\n' +
                        '`sudo systemctl start cups`\n\n' +
                        '然后安装 PDF 虚拟打印机：\n' +
                        '`sudo lpadmin -p PDF -E -v cups-pdf:/ -m everywhere`'
                    );
                    return true;
                }
                let reply = `🖨️ 找到 ${printers.length} 台打印机：\n\n`;
                printers.forEach((p, i) => {
                    const configured = this.printerConfig.printers.includes(p.name) ? ' ✅' : '';
                    const isDefault = this.printerConfig.default === p.name ? ' ⭐' : '';
                    reply += `${i+1}. ${p.name}${isDefault}${configured} - ${p.status}\n`;
                });
                reply += `\n💡 使用 \`#打印机添加 [名称]\` 添加打印机`;
                await context.reply(reply);
            } catch (error) {
                await context.reply(`❌ 扫描失败: ${error.message}`);
            }
            return true;
        }

        // #打印机列表
        if (text === '#打印机列表') {
            try {
                const configured = this.printerConfig.printers || [];
                if (configured.length === 0) {
                    await context.reply('⚠️ 尚未配置任何打印机\n\n请先执行 `#打印机扫描` 或 `#打印机发现` 查看可用打印机');
                    return true;
                }
                let reply = `🖨️ 已配置打印机 (${configured.length}台)：\n\n`;
                configured.forEach((name, i) => {
                    const isDefault = this.printerConfig.default === name ? '⭐ ' : '  ';
                    reply += `${isDefault}${i+1}. ${name}\n`;
                });
                reply += `\n💡 当前默认: ${this.printerConfig.default || '未设置'}`;
                await context.reply(reply);
            } catch (error) {
                await context.reply(`❌ 获取列表失败: ${error.message}`);
            }
            return true;
        }

        // #打印机添加 [名称]（原有：把 CUPS 中已存在的打印机录入系统配置）
        const addMatch = text.match(/^#打印机(?:添加|add)\s+(.+)$/i);
        if (addMatch) {
            const name = addMatch[1].trim();
            if (!name) {
                await context.reply('❌ 请指定打印机名称\n用法: `#打印机添加 [名称]`');
                return true;
            }
            try {
                const printers = await this.scanPrinters(true);
                if (!printers.some(p => p.name === name)) {
                    await context.reply(`❌ 打印机 "${name}" 不存在于 CUPS\n请先运行 \`#打印机扫描\` 查看列表，或用 \`#打印机接入\` 接入新设备`);
                    return true;
                }
                if (this.printerConfig.printers.includes(name)) {
                    await context.reply(`⚠️ 打印机 "${name}" 已在配置中`);
                    return true;
                }
                this.printerConfig.printers.push(name);
                if (!this.printerConfig.default) {
                    this.printerConfig.default = name;
                }
                await this.savePrinterConfig();
                await this.hotReloadPrint();
                await context.reply(`✅ 打印机 "${name}" 已添加\n💡 当前默认: ${this.printerConfig.default}`);
            } catch (error) {
                await context.reply(`❌ 添加失败: ${error.message}`);
            }
            return true;
        }

        // #打印机删除 [名称]
        const delMatch = text.match(/^#打印机(?:删除|del)\s+(.+)$/i);
        if (delMatch) {
            const name = delMatch[1].trim();
            if (!name) {
                await context.reply('❌ 请指定打印机名称\n用法: `#打印机删除 [名称]`');
                return true;
            }
            try {
                if (!this.printerConfig.printers.includes(name)) {
                    await context.reply(`❌ 打印机 "${name}" 不在配置中`);
                    return true;
                }
                this.printerConfig.printers = this.printerConfig.printers.filter(p => p !== name);
                if (this.printerConfig.default === name) {
                    this.printerConfig.default = this.printerConfig.printers[0] || null;
                }
                await this.savePrinterConfig();
                await this.hotReloadPrint();
                await context.reply(`✅ 打印机 "${name}" 已移除`);
            } catch (error) {
                await context.reply(`❌ 删除失败: ${error.message}`);
            }
            return true;
        }

        // #打印机设置 [名称]
        const setMatch = text.match(/^#打印机(?:设置|set)\s+(.+)$/i);
        if (setMatch) {
            const name = setMatch[1].trim();
            if (!name) {
                await context.reply('❌ 请指定打印机名称\n用法: `#打印机设置 [名称]`');
                return true;
            }
            try {
                if (!this.printerConfig.printers.includes(name)) {
                    await context.reply(`❌ 打印机 "${name}" 不在配置中\n请先使用 \`#打印机添加 "${name}"\` 或 \`#打印机接入\` 添加`);
                    return true;
                }
                this.printerConfig.default = name;
                await this.savePrinterConfig();
                await this.hotReloadPrint();
                await context.reply(`✅ 默认打印机已切换为: ${name}`);
            } catch (error) {
                await context.reply(`❌ 设置失败: ${error.message}`);
            }
            return true;
        }

        // #打印机信息
        if (text === '#打印机信息') {
            try {
                const printers = await this.scanPrinters(true);
                let reply = `🖨️ **打印机信息**\n\n`;
                reply += `💡 默认打印机: ${this.printerConfig.default || '未设置'}\n`;
                reply += `📦 已配置: ${(this.printerConfig.printers || []).length} 台\n`;
                if (printers.length > 0) {
                    reply += `\n🟢 在线打印机:\n`;
                    printers.forEach(p => {
                        const isDefault = this.printerConfig.default === p.name ? ' ⭐' : '';
                        reply += `  • ${p.name}${isDefault} (${p.status})\n`;
                    });
                }
                await context.reply(reply);
            } catch (error) {
                await context.reply(`❌ 获取信息失败: ${error.message}`);
            }
            return true;
        }

        // #打印机重置
        if (text === '#打印机重置') {
            try {
                const printers = await this.scanPrinters(true);
                if (printers.length === 0) {
                    await context.reply('❌ 未找到任何打印机，无法重置');
                    return true;
                }
                this.printerConfig.printers = printers.map(p => p.name);
                this.printerConfig.default = printers[0]?.name || null;
                await this.savePrinterConfig();
                await this.hotReloadPrint();
                await context.reply(`✅ 已重置，添加 ${printers.length} 台打印机\n💡 默认: ${this.printerConfig.default}`);
            } catch (error) {
                await context.reply(`❌ 重置失败: ${error.message}`);
            }
            return true;
        }

        // 未匹配的命令
        await context.reply(`❌ 未知命令: ${text}\n\n使用 \`#打印机帮助\` 查看所有命令`);
        return true;
    }
}

module.exports = PrinterManagerPlugin;
