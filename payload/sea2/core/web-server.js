/**
 * SEA1 模块化机器人系统 - 控制台 Web 服务端
 * 职责：托管 Web UI 静态资源，提供热插拔控制、设备激活状态、日志审计等核心 API 接口
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

class WebServer {
    /**
     * @param {Object} config 全局配置信息
     * @param {Object} db SQLite 数据库连接实例
     * @param {Object} pluginManager 插件管理器实例
     */
    constructor(config, db, pluginManager) {
        this.config = config;
        this.db = db;
        this.pluginManager = pluginManager;
        this.server = null;
        this.port = config.port || 3000;
        this.staticDir = path.join(__dirname, '../web/dist');
    }

    log(msg, level = 'INFO') {
        const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
        console.log(`[${time}] [${level}] [Web-Server] ${msg}`);
    }

    /**
     * 启动 Web 服务
     */
    async start() {
        return new Promise((resolve) => {
            this.server = http.createServer((req, res) => {
                // 统一设置跨域头 (CORS)，方便前后端分离调试
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }

                // 路由分发
                if (req.url.startsWith('/api/')) {
                    this.handleApiRequest(req, res);
                } else {
                    this.handleStaticRequest(req, res);
                }
            });

            this.server.listen(this.port, '0.0.0.0', () => {
                this.log(`控制台后台已成功运行在 http://0.0.0.0:${this.port}`);
                resolve();
            });
        });
    }

    /**
     * 停止 Web 服务
     */
    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    this.log('Web 服务已安全关闭。');
                    resolve();
                });
            });
        }
    }

    /**
     * 1. 核心 API 路由处理（鉴权、热更新、插件管理等）[span_2](start_span)[span_2](end_span)[span_3](start_span)[span_3](end_span)
     */
    async handleApiRequest(req, res) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        const pathname = parsedUrl.pathname;

        res.setHeader('Content-Type', 'application/json; charset=utf-8');

        try {
            // 🔒 极简的 API 鉴权机制：验证 Query 中的 token 或请求头
            const token = parsedUrl.searchParams.get('token') || req.headers['authorization'];
            const expectedToken = this.config.superAdmin; // 默认使用超级管理员账号作为简单密钥
            
            if (!token || token !== expectedToken) {
                res.writeHead(401);
                res.end(JSON.stringify({ code: 401, message: '未授权或 Token 错误，拒绝访问。' }));
                return;
            }

            // API 路由 1：获取当前所有插件状态[span_4](start_span)[span_4](end_span)[span_5](start_span)[span_5](end_span)
            if (pathname === '/api/plugins' && req.method === 'GET') {
                const list = this.pluginManager.plugins.map(p => ({
                    name: p.name,
                    priority: p.priority || 50,
                    permissionLevel: p.permissionLevel || 0
                }));
                res.writeHead(200);
                res.end(JSON.stringify({ code: 200, plugins: list }));
                return;
            }

            // API 路由 2：热加载 / 重载指定插件[span_6](start_span)[span_6](end_span)[span_7](start_span)[span_7](end_span)
            if (pathname === '/api/plugins/reload' && req.method === 'POST') {
                this.getRequestBody(req, async (body) => {
                    const { name } = body;
                    if (!name) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ code: 400, message: '缺少参数: name' }));
                        return;
                    }

                    try {
                        await this.pluginManager.reloadPlugin(name); // 调用热插拔驱动[span_8](start_span)[span_8](end_span)[span_9](start_span)[span_9](end_span)
                        res.writeHead(200);
                        res.end(JSON.stringify({ code: 200, message: `插件 [${name}] 热重载成功！` }));
                    } catch (err) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ code: 500, message: `热重载失败: ${err.message}` }));
                    }
                });
                return;
            }

            // API 路由 3：热卸载指定插件[span_10](start_span)[span_10](end_span)[span_11](start_span)[span_11](end_span)
            if (pathname === '/api/plugins/unload' && req.method === 'POST') {
                this.getRequestBody(req, async (body) => {
                    const { name } = body;
                    if (!name) {
                        res.writeHead(400);
                        res.end(JSON.stringify({ code: 400, message: '缺少参数: name' }));
                        return;
                    }

                    try {
                        await this.pluginManager.unloadPlugin(name); // 动态注销[span_12](start_span)[span_12](end_span)[span_13](start_span)[span_13](end_span)
                        res.writeHead(200);
                        res.end(JSON.stringify({ code: 200, message: `插件 [${name}] 已成功热拔插卸载！` }));
                    } catch (err) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ code: 500, message: `卸载失败: ${err.message}` }));
                    }
                });
                return;
            }

            // 未匹配到 API
            res.writeHead(404);
            res.end(JSON.stringify({ code: 404, message: 'API 接口不存在' }));

        } catch (error) {
            res.writeHead(500);
            res.end(JSON.stringify({ code: 500, message: `服务器内部错误: ${error.message}` }));
        }
    }

    /**
     * 2. 静态资源托管（提供打包好的前端网页）[span_14](start_span)[span_14](end_span)[span_15](start_span)[span_15](end_span)
     */
    handleStaticRequest(req, res) {
        let filePath = path.join(this.staticDir, req.url === '/' ? 'index.html' : req.url);
        
        // 简单防止路径穿越攻击
        if (!filePath.startsWith(this.staticDir)) {
            res.writeHead(403);
            res.end('Access Denied');
            return;
        }

        const extname = String(path.extname(filePath)).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml'
        };

        const contentType = mimeTypes[extname] || 'application/octet-stream';

        fs.readFile(filePath, (error, content) => {
            if (error) {
                if (error.code === 'ENOENT') {
                    // 如果前端是单页面路由 (SPA)，找不到文件时默认返回 index.html[span_16](start_span)[span_16](end_span)[span_17](start_span)[span_17](end_span)
                    const indexPath = path.join(this.staticDir, 'index.html');
                    if (fs.existsSync(indexPath)) {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(fs.readFileSync(indexPath));
                    } else {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('SEA1 控制台前端页面未编译或为空，请先在 web/ 目录打包编译[span_18](start_span)[span_18](end_span)[span_19](start_span)[span_19](end_span)~');
                    }
                } else {
                    res.writeHead(500);
                    res.end(`Sorry, check with the site admin for error: ${error.code} ..\n`);
                }
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });
    }

    /**
     * 辅助：解析 POST 请求体 (JSON)
     */
    getRequestBody(req, callback) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);
                callback(parsed);
            } catch (e) {
                callback({});
            }
        });
    }
}

module.exports = WebServer;
