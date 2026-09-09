'use strict';
/**
 * lib/consoleApi.js — 控制台 API 聚合 + 鉴权分发
 *
 * 导出 handle(req, res, url, cfg, store, keys)，由 server.js 在以下前缀统一转发：
 *   /api/admin/console/*  （控制台自有端点）
 *   /api/admin/devices*    （设备：R0 读 / W2 写，支持 QQ 会话）
 *   /api/admin/printers*   （打印机：R0 读 / W2 写）
 *
 * 约定：
 *  - 成功统一返回 { ok:true, ... }；失败统一返回 { ok:false, error }。
 *  - HTTP 状态：401 未登录 / 403 等级不足 / 400 参数错 / 404 不存在 / 500 意外。
 *  - 所有写操作先 verifyAuth(L2+) 再 audit.logAction。
 *  - secret 不回显明文（复用 configManager 的 {secret,set} 掩码）。
 */

const path = require('node:path');

const auth = require('./console/auth');
const audit = require('./console/audit');
const permissionBridge = require('./console/permissionBridge');
const devices = require('./console/devices');
const printers = require('./console/printers');
const runtime = require('./console/runtime');
const ordersConsole = require('./console/orders');
const ordersLib = require('./orders'); // [T2 P2-11] 订单状态机（markPaid 等）
const configManager = require('./configManager');
// [FLEET] 外网客户端集群管理
const fleet = require('./fleet');
const fleetStore = require('./fleetStore');
const anomaly = require('./anomaly');
const fleetConfig = require('./fleetConfig');
// 指令契约单一事实来源（二次确认词校验用，与 fleet.buildMeta 同源）
const fleetCommands = require('./fleetCommands');
// [SEA2] 运维引擎（T02）：CRUD / PM2 / 强门禁 / 审计 / CUPS meta / 绑定纠正 / TOTP
const opsAuditStore = require('./ops/auditStore');
const opsCrud = require('./ops/crud');
const opsPm2 = require('./ops/pm2');
const opsHighrisk = require('./ops/highrisk');
const opsTotp = require('./ops/totp');
const opsCupsMeta = require('./ops/cupsmeta');
const opsBinding = require('./ops/binding');
// [R4] 一键部署：穿透地址 CRUD + 主地址 + git 推送
const deployConfig = require('./deployConfig');
const gitDeploy = require('./gitDeploy');

/** 复用 server.js 既有响应格式 */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// 超管 QQ（仅用于展示/兜底判断；真正超管判定走 ADMIN_TOKEN）
const ADMIN_QQ = process.env.SUPER_ADMIN_QQ || '';
const ENV_PATH = path.join(__dirname, '..', 'config.env');

/**
 * 主入口。
 * @param {object} req
 * @param {object} res
 * @param {URL} url
 * @param {object} cfg
 * @param {object} store
 * @param {object} keys
 */
async function handle(req, res, url, cfg, store, keys) {
  try {
    const method = req.method;
    const p = url.pathname;
    const sendRes = (code, obj) => send(res, code, obj);

    // ---------- 登录（公开）----------
    if (method === 'POST' && p === '/api/admin/console/login') {
      const body = await readBody(req);
      const r = auth.login(body, cfg);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      return sendRes(200, { ok: true, token: r.token, level: r.level, scope: r.scope, role: r.role });
    }

    // 鉴权辅助（R0 = 登录即可读；W2 = 需 L2+，超管令牌绕过；S3 = 需 L3 超管）
    const authRead = () => auth.verifyAuth(req, cfg, 0);
    const authWrite = () => auth.verifyAuth(req, cfg, 2);
    const authSuper = () => auth.verifyAuth(req, cfg, 3);

    // ---------- 状态（R0）----------
    if (method === 'GET' && p === '/api/admin/console/status') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const status = runtime.getStatus({ cfg, store, keys });
      return sendRes(200, { ok: true, status });
    }

    // ---------- 订单（富，R0）----------
    if (method === 'GET' && p === '/api/admin/console/orders') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const status = url.searchParams.get('status') || '';
      const qq = url.searchParams.get('qq') || '';
      const limit = Number(url.searchParams.get('limit')) || 100;
      return sendRes(200, { ok: true, orders: ordersConsole.richList(store, { status, qq, limit }) });
    }

    // ================= [T2 P2-11] 订单审计操作（L2+，全部写 ops 审计）=================
    // 端点（与 server.js 转发规则对应：/api/admin/orders 非 GET 请求进入本处理器）：
    //   POST   /api/admin/orders/:id/mark-paid   手动改未支付→已支付（非终态校验 + paid_at）
    //   POST   /api/admin/orders/:id/issue       手动开通会员（复用 grantMember → /api/order/issue 同款签发）
    //   POST   /api/admin/orders/:id/revoke      改已支付→未支付并取消会员（吊销已发 code）
    //   DELETE /api/admin/orders/:id             删除任意订单
    const ordAct = p.match(/^\/api\/admin\/orders\/([^/]+)\/(mark-paid|issue|revoke)$/);
    if (method === 'POST' && ordAct) {
      const a = authWrite(); // L2+（超管令牌 / LAN 免登录 L3 均可）
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const orderId = decodeURIComponent(ordAct[1]);
      const op = ordAct[2];
      let r;
      if (op === 'mark-paid') {
        const o = store.getOrder(orderId);
        if (!o) return sendRes(404, { ok: false, error: '订单不存在' });
        // 终态（已签发/已过期/已取消）不可手动标记已支付
        if (o.status === 'issued' || o.status === 'expired' || o.status === 'cancelled') {
          return sendRes(400, { ok: false, error: '订单状态不可标记已支付: ' + o.status });
        }
        const before = Object.assign({}, o);
        const updated = ordersLib.markPaid(store, orderId, { channel: 'manual' });
        r = { ok: true, order_id: orderId, already: before.status === 'paid', before, after: Object.assign({}, updated) };
      } else if (op === 'issue') {
        r = ordersConsole.grantMember(store, keys, cfg, { orderId });
        if (r.ok) r.order_id = orderId;
      } else { // revoke
        r = ordersConsole.revokeMember(store, orderId);
        if (r.ok) r.order_id = orderId;
      }
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'order-' + op, entity: 'orders', target: orderId,
        before: r.before !== undefined ? r.before : null,
        after: r.after !== undefined ? r.after : null,
        detail: r.message || (r.revokedCode ? 'revoked_code=' + r.revokedCode : ''),
        ok: true,
      });
      return sendRes(200, { ok: true, action: op, order_id: orderId, ...r });
    }
    const ordDel = p.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (method === 'DELETE' && ordDel) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const orderId = decodeURIComponent(ordDel[1]);
      const o = store.getOrder(orderId);
      if (!o) return sendRes(404, { ok: false, error: '订单不存在' });
      const before = Object.assign({}, o);
      const deleted = store.deleteOrder(orderId);
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'order-delete', entity: 'orders', target: orderId,
        before, after: null, ok: !!deleted,
      });
      return sendRes(200, { ok: true, action: 'delete', order_id: orderId, deleted: !!deleted });
    }

    // ---------- 开通会员（W2）----------
    if (method === 'POST' && p === '/api/admin/console/grant') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const r = ordersConsole.grantMember(store, keys, cfg, { orderId: body.orderId, qq: body.qq, plan: body.plan });
      if (!r.ok) return sendRes(400, { ok: false, error: r.error });
      audit.logAction({
        operator: a.qq, operatorLevel: a.level, action: 'grant',
        target: String(body.qq || body.orderId || ''),
        detail: 'plan=' + String(body.plan || (body.orderId ? 'order' : '')), ok: true,
      });
      return sendRes(200, {
        ok: true, order_id: r.order_id, code: r.code, license: r.license,
        status: r.status, already: !!r.already, message: r.message || '',
      });
    }

    // ---------- 变量（读，R0）----------
    if (method === 'GET' && p === '/api/admin/console/vars') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const rc = configManager.readConfig(cfg, store);
      const groups = {};
      rc.schema.forEach((f) => {
        (groups[f.group] = groups[f.group] || []).push(Object.assign({}, f, { value: rc.values[f.key] }));
      });
      return sendRes(200, { ok: true, groups, effectiveNote: rc.effectiveNote });
    }

    // ---------- 变量（写，W2）----------
    if (method === 'POST' && p === '/api/admin/console/vars') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const patch = body.patch || body;
      let r;
      try {
        r = configManager.writeConfig({ cfg, store, patch, envPath: ENV_PATH });
      } catch (e) {
        return sendRes(400, { ok: false, error: e.message });
      }
      audit.logAction({
        operator: a.qq, operatorLevel: a.level, action: 'vars', target: 'config',
        detail: (r.changed || []).join(','), ok: true,
      });
      if (!r.ok) return sendRes(400, { ok: false, error: r.error });
      return sendRes(200, { ok: true, restartRequired: r.restartRequired, changed: r.changed });
    }

    // ---------- 管理员列表（R0）----------
    if (method === 'GET' && p === '/api/admin/console/admins') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const snap = permissionBridge.readSnapshot();
      return sendRes(200, {
        ok: true,
        admins: snap.users,
        meta: snap.meta || {},
        fallback: snap.fallback || {},
        bridgeReady: !!snap.available,
      });
    }

    // ---------- 管理员审计（R0）----------
    if (method === 'GET' && p === '/api/admin/console/admins/audit') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const limit = Number(url.searchParams.get('limit')) || 50;
      return sendRes(200, { ok: true, audits: permissionBridge.listAudits(limit) });
    }

    // ---------- 设管理员（W2）----------
    if (method === 'POST' && p === '/api/admin/console/admins') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const qq = String(body.qq || '');
      const level = Number(body.level);
      if (!qq || !(level >= 0 && level <= 3)) {
        return sendRes(400, { ok: false, error: 'qq 与 level(0-3) 必填且合法' });
      }
      const e = permissionBridge.enqueue({ op: 'set', target: qq, level, operator: a.qq });
      audit.logAction({
        operator: a.qq, operatorLevel: a.level, action: 'admin-set', target: qq,
        detail: 'level=' + level, ok: e.enqueued,
      });
      if (!e.enqueued) return sendRes(500, { ok: false, error: e.error || '入队失败' });
      return sendRes(200, { ok: true, enqueued: true, message: '已加入队列，bot 将异步落库（秒级生效）' });
    }

    // ---------- 删管理员（W2）：DELETE /api/admin/console/admins/:qq ----------
    const admDel = p.match(/^\/api\/admin\/console\/admins\/([^/]+)$/);
    if (method === 'DELETE' && admDel) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const qq = decodeURIComponent(admDel[1]);
      const e = permissionBridge.enqueue({ op: 'remove', target: qq, operator: a.qq });
      audit.logAction({
        operator: a.qq, operatorLevel: a.level, action: 'admin-remove', target: qq, ok: e.enqueued,
      });
      if (!e.enqueued) return sendRes(500, { ok: false, error: e.error || '入队失败' });
      return sendRes(200, { ok: true, enqueued: true });
    }

    // ---------- 设备列表（R0）----------
    if (method === 'GET' && p === '/api/admin/devices') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      return sendRes(200, { ok: true, devices: devices.listDevices(store) });
    }

    // ---------- 设备操作（W2）：POST /api/admin/devices/:id/action ----------
    const devAct = p.match(/^\/api\/admin\/devices\/([^/]+)\/action$/);
    if (method === 'POST' && devAct) {
      const a = authWrite(); // disable/reset/restart 均需 L2+（超管令牌绕过）
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const id = decodeURIComponent(devAct[1]);
      const body = await readBody(req);
      const action = body.action;
      let result;
      if (action === 'disable') result = devices.disable(store, id);
      else if (action === 'reset') result = devices.reset(store, id);
      else if (action === 'restart') result = devices.restart();
      else return sendRes(400, { ok: false, error: '未知操作（disable|reset|restart）' });
      if (!result.ok) return sendRes(result.status || 400, { ok: false, error: result.error });
      audit.logAction({
        operator: a.qq, operatorLevel: a.level, action: 'device-' + action, target: id, ok: true,
      });
      return sendRes(200, { ok: true, action, machine_id: id, restarted: !!(result && result.restarted), message: '操作成功' });
    }

    // ---------- 打印机列表（R0）----------
    if (method === 'GET' && p === '/api/admin/printers') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const r = printers.list();
      return sendRes(200, { ok: true, printers: r.printers || [], cupsRunning: !!r.cupsRunning });
    }

    // ---------- 加打印机（W2）----------
    if (method === 'POST' && p === '/api/admin/printers') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const name = String(body.name || '');
      const deviceUri = String(body.deviceUri || '');
      const r = printers.add(name, deviceUri);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      audit.logAction({
        operator: a.qq, operatorLevel: a.level, action: 'printer-add', target: name, ok: true,
      });
      return sendRes(200, { ok: true, name, message: '已添加打印机' });
    }

    // ---------- 打印机操作（W2；test 放宽到 R0）：POST /api/admin/printers/:name/action ----------
    const prAct = p.match(/^\/api\/admin\/printers\/([^/]+)\/action$/);
    if (method === 'POST' && prAct) {
      const name = decodeURIComponent(prAct[1]);
      const body = await readBody(req);
      const action = body.action;
      let operator = 'unknown';
      let operatorLevel = '';
      if (action === 'test') {
        const a0 = authRead();
        if (!a0.ok) return sendRes(a0.status || 401, { ok: false, error: a0.error });
        operator = a0.qq; operatorLevel = a0.level;
      } else {
        const a2 = authWrite();
        if (!a2.ok) return sendRes(a2.status || 403, { ok: false, error: a2.error });
        operator = a2.qq; operatorLevel = a2.level;
      }
      const r = printers.printerAction(name, action);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      audit.logAction({
        operator, operatorLevel, action: 'printer-' + action, target: name, ok: true,
      });
      return sendRes(200, { ok: true, action, name });
    }

    // ---------- 控制台审计（R0）----------
    if (method === 'GET' && p === '/api/admin/console/audit') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const limit = Number(url.searchParams.get('limit')) || 50;
      return sendRes(200, { ok: true, logs: audit.list(limit) });
    }

    // ================= [FLEET] 外网客户端集群管理 =================
    const fsInst = () => fleetStore.getInstance();

    // 契约元数据（R0）：指令白名单 / 分组 / reason 语义表 / 状态枚举 / 阈值 / 限额
    // 前端据此渲染，杜绝在 JS 里硬编码枚举——新增指令或调阈值只需改服务端。
    if (method === 'GET' && p === '/api/admin/fleet/meta') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      return sendRes(200, { ok: true, ...fleet.buildMeta(fleetConfig.load()) });
    }

    // 客户端列表（R0）
    if (method === 'GET' && p === '/api/admin/fleet/clients') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const filter = {
        // status 为兼容维度；connectivity 与 licenseState 是本期的两个正交维度，
        // 三者可叠加，语义为「与」。缺一不可透传，否则前端筛选会静默失效。
        status: url.searchParams.get('status') || '',
        connectivity: url.searchParams.get('connectivity') || '',
        licenseState: url.searchParams.get('licenseState') || '',
        version: url.searchParams.get('version') || '',
        region: url.searchParams.get('region') || '',
        q: url.searchParams.get('q') || '',
        page: url.searchParams.get('page') || '1',
        pageSize: url.searchParams.get('pageSize') || '50',
        // [T03 需求5] 透传 includeProcesses=1 → 列表项附 pm2Processes（进程管理「全部设备」聚合）
        includeProcesses: url.searchParams.get('includeProcesses') || '',
      };
      return sendRes(200, { ok: true, ...fleet.listClients(fsInst(), store, fleetConfig.load(), filter) });
    }

    // 客户端详情（R0）
    const cliDet = p.match(/^\/api\/admin\/fleet\/clients\/([^/]+)$/);
    if (method === 'GET' && cliDet) {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const mid = decodeURIComponent(cliDet[1]);
      const d = fleet.clientDetail(fsInst(), store, fleetConfig.load(), mid);
      if (!d) return sendRes(404, { ok: false, error: '客户端不存在' });
      return sendRes(200, { ok: true, ...d });
    }

    // [T2 P2-12] 机器身份·人工合并（仅 L3）：确认同一设备 / 标记不同设备（强制改绑）
    //   POST /api/admin/fleet/clients/:id/merge-confirm  → decision='same-device'（保留主记录）
    //   POST /api/admin/fleet/clients/:id/merge-ignore   → decision='force-rebind'（强制改绑）
    // 全部写 machine 审计 + op 审计（operator 记录操作人）。
    const mergeAct = p.match(/^\/api\/admin\/fleet\/clients\/([^/]+)\/merge-(confirm|ignore)$/);
    if (method === 'POST' && mergeAct) {
      const a = authSuper(); // 人工合并属高危处置，仅 L3
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const mid = decodeURIComponent(mergeAct[1]);
      const decision = mergeAct[2] === 'confirm' ? 'same-device' : 'force-rebind';
      const inst = fsInst();
      if (!inst.getClient(mid)) return sendRes(404, { ok: false, error: '客户端不存在' });
      const r = inst.resolveIdentityRisks(mid, decision, a.qq);
      const action = 'merge-' + mergeAct[2];
      opsAuditStore.logMachine({
        operator: a.qq, operatorLevel: a.level,
        action, machineId: mid, decision,
        detail: 'resolved=' + (r ? r.resolved : 0), ok: true,
      });
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'machine-' + action, entity: 'fleet', target: mid,
        before: { decision: '' }, after: { decision }, ok: true,
      });
      return sendRes(200, { ok: true, action, machineId: mid, decision, resolved: r ? r.resolved : 0, mergeRisk: r ? r.mergeRisk : false });
    }

    // 跨客户端打印机聚合（R0）
    if (method === 'GET' && p === '/api/admin/fleet/printers') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const filter = {
        status: url.searchParams.get('status') || '',
        client: url.searchParams.get('client') || '',
        q: url.searchParams.get('q') || '',
      };
      return sendRes(200, { ok: true, ...fleet.listAllPrinters(fsInst(), fleetConfig.load(), filter) });
    }

    // 异常列表（R0）
    if (method === 'GET' && p === '/api/admin/fleet/anomalies') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const filter = {
        rule: url.searchParams.get('rule') || '',
        severity: url.searchParams.get('severity') || '',
        status: url.searchParams.get('status') || '',
        q: url.searchParams.get('q') || '',
      };
      const items = fsInst().listAnomalies(filter);
      const rules = fsInst().listRules();
      return sendRes(200, { ok: true, items, rules });
    }

    // 异常处置：吊销（W2）→ 复用 devices.disable 吊销 license
    const anRevoke = p.match(/^\/api\/admin\/fleet\/anomalies\/([^/]+)\/revoke$/);
    if (method === 'POST' && anRevoke) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const id = decodeURIComponent(anRevoke[1]);
      const inst = fsInst();
      const an = inst.getAnomaly(id);
      if (!an) return sendRes(404, { ok: false, error: '异常不存在' });
      const dr = devices.disable(store, an.machineId);
      if (!dr.ok) return sendRes(dr.status || 400, { ok: false, error: dr.error });
      inst.setAnomalyStatus(id, 'resolved', 'revoke');
      audit.logAction({ operator: a.qq, operatorLevel: a.level, action: 'anomaly-revoke', target: an.machineId, detail: id, ok: true });
      return sendRes(200, { ok: true, action: 'revoke', machineId: an.machineId, status: 'resolved' });
    }

    // 异常处置：拉黑（W2）→ 即时生效
    const anBlacklist = p.match(/^\/api\/admin\/fleet\/anomalies\/([^/]+)\/blacklist$/);
    if (method === 'POST' && anBlacklist) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const id = decodeURIComponent(anBlacklist[1]);
      const inst = fsInst();
      const an = inst.getAnomaly(id);
      if (!an) return sendRes(404, { ok: false, error: '异常不存在' });
      inst.addBlacklist(an.machineId, 'anomaly-blacklist:' + (an.rule || ''), a.qq);
      inst.setAnomalyStatus(id, 'resolved', 'blacklist');
      audit.logAction({ operator: a.qq, operatorLevel: a.level, action: 'anomaly-blacklist', target: an.machineId, detail: id, ok: true });
      return sendRes(200, { ok: true, action: 'blacklist', machineId: an.machineId, status: 'resolved' });
    }

    // 异常处置：忽略（W2）
    const anIgnore = p.match(/^\/api\/admin\/fleet\/anomalies\/([^/]+)\/ignore$/);
    if (method === 'POST' && anIgnore) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const id = decodeURIComponent(anIgnore[1]);
      const inst = fsInst();
      if (!inst.getAnomaly(id)) return sendRes(404, { ok: false, error: '异常不存在' });
      inst.ignoreAnomaly(id);
      audit.logAction({ operator: a.qq, operatorLevel: a.level, action: 'anomaly-ignore', target: id, ok: true });
      return sendRes(200, { ok: true, action: 'ignore', status: 'ignored' });
    }

    // 下发指令（W2）
    // 服务端侧效应（与客户端指令解耦，双保险）：
    //   disable_client → 吊销 license，客户端即便离线，下次心跳也会降级
    //   enable_client  → 恢复 license（对称操作，expires_at 沿用原值不重签）
    const cmdIssue = p.match(/^\/api\/admin\/fleet\/clients\/([^/]+)\/command$/);
    if (method === 'POST' && cmdIssue) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const mid = decodeURIComponent(cmdIssue[1]);
      const body = await readBody(req);
      const action = body.action;
      const payload = body.payload || {};
      const inst = fsInst();

      // [SEA2 强门禁] format_device 等 minLevel>2 的指令**仅能由强门禁引擎签发**（lib/ops/highrisk.js）
      // 普通下发接口一律拒绝直发（§3.4 / §7.8），并留审计证据。
      // 放在确认词校验之前：无论是否带 confirm，一律 403，避免误入 400「需确认词」分支造成歧义。
      const spec = fleetCommands.get(action);
      if (spec && spec.minLevel && spec.minLevel > 2) {
        opsAuditStore.logCmd({
          operator: a.qq, operatorLevel: a.level,
          commandId: '', action, target: mid,
          payload, status: 'rejected', error: '普通下发接口拒绝直发高危指令', ok: false,
        });
        return sendRes(403, { ok: false, error: '该指令仅能由强门禁引擎签发（高危专区），普通下发接口拒绝直发' });
      }

      // 二次确认词校验（如 disable_client 需前端回传 confirm='DISABLE'）
      // 放在侧效应之前：确认词不对时，绝不能已经把 license 吊销掉。
      if (spec && spec.confirmWord && String(body.confirm || '') !== spec.confirmWord) {
        return sendRes(400, { ok: false, error: `该操作需二次确认，请回传 confirm="${spec.confirmWord}"` });
      }

      // 服务端侧效应：best-effort，无对应激活码记录也不阻断（客户端仍会按指令本地生效）
      let sideEffect = null;
      if (action === 'disable_client') {
        const dr = devices.disable(store, mid);
        sideEffect = { kind: 'license-revoke', ok: dr.ok, error: dr.ok ? '' : dr.error };
      } else if (action === 'enable_client') {
        const er = devices.enable(store, mid);
        sideEffect = {
          kind: 'license-restore', ok: er.ok, error: er.ok ? '' : er.error,
          expiresAt: er.expiresAt || 0, expired: !!er.expired, alreadyActive: !!er.alreadyActive,
        };
      }

      const r = fleet.issueCommand(inst, mid, action, payload, a.qq);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      audit.logAction({
        operator: a.qq, operatorLevel: a.level,
        action: 'cmd-' + action, target: mid,
        detail: 'cmdId=' + r.commandId + (r.dangerous ? ' [危险]' : '')
          + (sideEffect ? ' side=' + sideEffect.kind + (sideEffect.ok ? '' : '(失败)') : ''),
        ok: true, dangerous: r.dangerous,
      });
      // 注意：cmdStatus 是指令状态机的值（pending/sent/...），
      // 与 HTTP status 是两个概念，故 issueCommand 侧刻意命名为 cmdStatus 以免混淆。
      // [C4 修复] 响应补回 timeoutAt（fleet.issueCommand 已返回，此前 consoleApi 丢弃）——
      // 前端据此跟踪指令超时（2×心跳间隔）。
      return sendRes(200, {
        ok: true, commandId: r.commandId, action: r.action,
        status: r.cmdStatus, cmdStatus: r.cmdStatus,
        dangerous: !!r.dangerous, sideEffect,
        timeoutAt: r.timeoutAt,
      });
    }

    // 指令历史（R0）
    const cmdHist = p.match(/^\/api\/admin\/fleet\/clients\/([^/]+)\/commands$/);
    if (method === 'GET' && cmdHist) {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const mid = decodeURIComponent(cmdHist[1]);
      const items = fsInst().listCommands(mid);
      return sendRes(200, { ok: true, items });
    }

    // ================= [SEA2 OPS] 运维引擎（T02，system_design_sea2_ops_v1.0.md）=================
    // 鉴权：R0 读 / W2 写 / S3 超管（format/binding/totp）
    const opsCrudInst = new opsCrud.OpsCrud({ store, cfg });
    const opsHighriskInst = new opsHighrisk.OpsHighrisk({ store });

    // ---------- 通用 CRUD（§3.5）：GET/POST /api/admin/ops/crud/:entity ----------
    const crudMatch = p.match(/^\/api\/admin\/ops\/crud\/([a-z]+)$/);
    if (method === 'GET' && crudMatch) {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const entity = crudMatch[1];
      if (!opsCrud.ENTITIES.includes(entity)) {
        return sendRes(400, { ok: false, error: '未知实体（codes|devices|printers|configs）' });
      }
      const filter = {
        page: url.searchParams.get('page') || '1',
        pageSize: url.searchParams.get('pageSize') || '50',
        q: url.searchParams.get('q') || '',
        filter: url.searchParams.get('filter') || '',
        status: url.searchParams.get('status') || '',
        group: url.searchParams.get('group') || '',
      };
      return sendRes(200, { ok: true, entity, ...opsCrudInst.list(entity, filter) });
    }
    if (method === 'POST' && crudMatch) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const entity = crudMatch[1];
      if (!opsCrud.ENTITIES.includes(entity)) {
        return sendRes(400, { ok: false, error: '未知实体（codes|devices|printers|configs）' });
      }
      const body = await readBody(req);
      const r = opsCrudInst.create(entity, body, a.qq, a.level);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      return sendRes(200, { ok: true, entity, record: r.record });
    }

    // ---------- 通用 CRUD 单条（§3.5）：PUT/DELETE /api/admin/ops/crud/:entity/:id ----------
    const crudIdMatch = p.match(/^\/api\/admin\/ops\/crud\/([a-z]+)\/([^/]+)$/);
    if (method === 'PUT' && crudIdMatch) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const entity = crudIdMatch[1];
      if (!opsCrud.ENTITIES.includes(entity)) {
        return sendRes(400, { ok: false, error: '未知实体（codes|devices|printers|configs）' });
      }
      const id = decodeURIComponent(crudIdMatch[2]);
      const body = await readBody(req);
      const r = opsCrudInst.update(entity, id, body, a.qq, a.level);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      // [T1-P0-2] autoCreated 透出：设备无档案时服务端自动建档（前端可提示「已自动建档」）
      return sendRes(200, { ok: true, entity, before: r.before, after: r.after, autoCreated: r.autoCreated === true });
    }
    if (method === 'DELETE' && crudIdMatch) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const entity = crudIdMatch[1];
      if (!opsCrud.ENTITIES.includes(entity)) {
        return sendRes(400, { ok: false, error: '未知实体（codes|devices|printers|configs）' });
      }
      const id = decodeURIComponent(crudIdMatch[2]);
      const r = opsCrudInst.remove(entity, id, a.qq, a.level);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      // [T1-P0-2] autoCreated 透出：设备无档案时服务端自动建档后软删
      return sendRes(200, { ok: true, entity, before: r.before, after: r.after, autoCreated: r.autoCreated === true });
    }

    // ---------- PM2 服务端直控（§4.1）：list / action / logs ----------
    if (method === 'GET' && p === '/api/admin/ops/pm2/list') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const r = await opsPm2.default.listLocal();
      return sendRes(200, { ok: r.ok, processes: r.processes || [], error: r.error || '' });
    }
    const pm2Act = p.match(/^\/api\/admin\/ops\/pm2\/([^/]+)\/action$/);
    if (method === 'POST' && pm2Act) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const name = decodeURIComponent(pm2Act[1]);
      const body = await readBody(req);
      const r = await opsPm2.default.action(name, String(body.action || ''), a.qq, a.level);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      return sendRes(200, { ok: true, action: r.action, name: r.name, message: r.message });
    }
    const pm2Logs = p.match(/^\/api\/admin\/ops\/pm2\/([^/]+)\/logs$/);
    if (method === 'GET' && pm2Logs) {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const name = decodeURIComponent(pm2Logs[1]);
      const lines = Number(url.searchParams.get('lines')) || 50;
      const r = await opsPm2.default.logs(name, lines);
      if (!r.ok) return sendRes(r.status || 400, { ok: false, error: r.error });
      return sendRes(200, { ok: true, name: r.name, lines: r.lines, logs: r.logs });
    }

    // ---------- 强门禁（§4.4）：gate / format / records / advance ----------
    if (method === 'GET' && p === '/api/admin/ops/highrisk/gate') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const mid = url.searchParams.get('mid') || '';
      const level = url.searchParams.get('level') || 'data';
      const r = opsHighriskInst.checkWhitelist(mid, level);
      if (!r.allowed) return sendRes(r.status || 403, { ok: false, error: r.error });
      return sendRes(200, {
        ok: true, allowed: true, level: r.level,
        confirmWord: r.confirmWord, countdownSec: r.countdownSec, totpRequired: r.totpRequired,
      });
    }
    if (method === 'POST' && p === '/api/admin/ops/highrisk/format') {
      const a = authSuper(); // 仅 L3 超管（§7.9 / Q9）
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const mid = String(body.mid || '');
      const level = String(body.level || '');
      const r = await opsHighriskInst.issueFormat(mid, level, a.qq, {
        confirm: body.confirm, totp: body.totp, operatorLevel: a.level,
      });
      if (!r.ok) return sendRes(r.statusCode || 400, { ok: false, error: r.error });
      return sendRes(200, {
        ok: true, recordId: r.recordId, commandId: r.commandId,
        status: r.status, cmdStatus: r.cmdStatus, level: r.level,
        countdownSec: r.countdownSec, confirmWord: r.confirmWord,
      });
    }
    if (method === 'GET' && p === '/api/admin/ops/highrisk/records') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const filter = {
        mid: url.searchParams.get('mid') || '',
        status: url.searchParams.get('status') || '',
        page: url.searchParams.get('page') || '1',
        pageSize: url.searchParams.get('pageSize') || '50',
      };
      return sendRes(200, { ok: true, ...opsHighriskInst.listRecords(filter) });
    }
    const hrAdvance = p.match(/^\/api\/admin\/ops\/highrisk\/([^/]+)\/advance$/);
    if (method === 'POST' && hrAdvance) {
      const a = authSuper(); // 记录推进亦属高危管理，仅 L3
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const recordId = decodeURIComponent(hrAdvance[1]);
      const body = await readBody(req);
      const r = opsHighriskInst.advance(recordId, {
        status: body.status, ackedAt: body.ackedAt, result: body.result,
        operator: a.qq, operatorLevel: a.level,
      });
      if (!r.ok) return sendRes(r.statusCode || 400, { ok: false, error: r.error });
      return sendRes(200, { ok: true, record: r.record });
    }

    // ---------- 审计中心（§7.5）：query / export ----------
    // [T2 P2-12] 新增 machine 类型（机器身份审计：ops-audit-machine.jsonl）
    const auditQ = p.match(/^\/api\/admin\/ops\/audit\/(op|cmd|highrisk|machine)$/);
    if (method === 'GET' && auditQ) {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const kind = auditQ[1];
      const filter = {
        page: url.searchParams.get('page') || '1',
        pageSize: url.searchParams.get('pageSize') || '50',
        q: url.searchParams.get('q') || '',
        action: url.searchParams.get('action') || '',
        target: url.searchParams.get('target') || '',
        operator: url.searchParams.get('operator') || '',
        status: url.searchParams.get('status') || '',
        mid: url.searchParams.get('mid') || '',
        fromTs: url.searchParams.get('fromTs') || '',
        toTs: url.searchParams.get('toTs') || '',
      };
      return sendRes(200, { ok: true, kind, ...opsAuditStore.query(kind, filter) });
    }
    const auditExp = p.match(/^\/api\/admin\/ops\/audit\/(op|cmd|highrisk|machine)\/export$/);
    if (method === 'GET' && auditExp) {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const kind = auditExp[1];
      const filter = {
        q: url.searchParams.get('q') || '',
        action: url.searchParams.get('action') || '',
        target: url.searchParams.get('target') || '',
        operator: url.searchParams.get('operator') || '',
        status: url.searchParams.get('status') || '',
        mid: url.searchParams.get('mid') || '',
      };
      const csv = opsAuditStore.exportCsv(kind, filter);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ops-audit-${kind}.csv"`,
      });
      res.end(csv);
      return;
    }

    // ---------- CUPS meta（§4.3）：recommend / drivers ----------
    if (method === 'GET' && p === '/api/admin/ops/cups/recommend') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      const model = url.searchParams.get('model') || '';
      const uri = url.searchParams.get('uri') || '';
      return sendRes(200, { ok: true, ...opsCupsMeta.match(model, uri) });
    }
    if (method === 'GET' && p === '/api/admin/ops/cups/drivers') {
      const a = authRead();
      if (!a.ok) return sendRes(a.status || 401, { ok: false, error: a.error });
      return sendRes(200, { ok: true, drivers: opsCupsMeta.listDrivers() });
    }

    // ---------- 绑定纠正（P0-1，仅 L3，§7.10）----------
    // 换绑前查询（设计 §9.2.2，仅 L3）：只读当前绑定信息，供「先查后换」向导
    if (method === 'GET' && p === '/api/admin/ops/binding/lookup') {
      const a = authSuper();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
      if (!code) return sendRes(400, { ok: false, error: 'code 必填' });
      const info = opsBinding.lookupBinding(store, code);
      if (!info) return sendRes(404, { ok: false, error: '授权码不存在' });
      return sendRes(200, { ok: true, ...info });
    }
    if (method === 'POST' && p === '/api/admin/ops/binding') {
      const a = authSuper();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      // —— sea2 商用运维：换绑二次校验（设计 §9.2.2）——
      // oldMachineId 可选：若传则必须与当前 bound_machine_id 一致，防止误换（400 old-machine-mismatch）
      if (body.oldMachineId !== undefined && body.oldMachineId !== null && String(body.oldMachineId).trim() !== '') {
        const cur = opsBinding.lookupBinding(store, body.code);
        if (!cur) return sendRes(404, { ok: false, error: '授权码不存在' });
        if (String(cur.bound_machine_id) !== String(body.oldMachineId).trim()) {
          return sendRes(400, { ok: false, error: 'old-machine-mismatch' });
        }
      }
      const r = opsBinding.correctBinding(store, body.code, body.machineId, a.qq, a.level);
      if (!r.ok) return sendRes(r.statusCode || 400, { ok: false, error: r.error });
      return sendRes(200, { ok: true, code: r.code, before: r.before, after: r.after });
    }

    // ---------- TOTP 管理（§7.9，仅 L3）----------
    if (method === 'GET' && p === '/api/admin/ops/totp/status') {
      const a = authSuper();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const secret = String(fleetConfig.load().totpSecret || '');
      return sendRes(200, { ok: true, configured: secret.length > 0, secretSet: secret.length > 0 });
    }
    if (method === 'POST' && p === '/api/admin/ops/totp/reset') {
      const a = authSuper();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const secret = opsTotp.generateSecret();
      fleetConfig.save({ totpSecret: secret });
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'totp-reset', entity: 'configs', target: 'totpSecret',
        before: { set: false }, after: { set: true }, ok: true,
      });
      return sendRes(200, { ok: true, secret, secretSet: true, message: 'TOTP 密钥已重置（仅此一次展示明文）' });
    }

    // ================= [R4] 一键部署管理（L2+，design §R4-P0）=================
    // 端点（server.js 转发前缀 /api/admin/deploy*）：
    //   GET    /api/admin/deploy/config                  → 全量（含禁用 tunnels）
    //   POST   /api/admin/deploy/master                  → 设置主通信地址
    //   POST   /api/admin/deploy/tunnels                 → 新增穿透地址
    //   PUT    /api/admin/deploy/tunnels/:id             → 部分更新
    //   DELETE /api/admin/deploy/tunnels/:id             → 删除
    //   POST   /api/admin/deploy/tunnels/:id/toggle      → 启用/禁用 {enabled}
    //   POST   /api/admin/deploy/push-to-git             → 推送 deploy-config.json 到私有仓
    if (method === 'GET' && p === '/api/admin/deploy/config') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const c = deployConfig.load();
      return sendRes(200, { ok: true, masterAddress: c.masterAddress || '', tunnels: c.tunnels || [], updatedAt: c.updatedAt || '' });
    }
    if (method === 'POST' && p === '/api/admin/deploy/master') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const addr = String(body.masterAddress || '').trim();
      if (!addr) return sendRes(400, { ok: false, error: 'masterAddress 必填' });
      const c = deployConfig.setMasterAddress(addr);
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'deploy-master', entity: 'deploy', target: 'masterAddress',
        before: { masterAddress: c.masterAddress }, after: { masterAddress: addr }, ok: true,
      });
      return sendRes(200, { ok: true, masterAddress: c.masterAddress || '' });
    }
    if (method === 'POST' && p === '/api/admin/deploy/tunnels') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const internalAddr = String(body.internalAddr || '').trim();
      const internalPort = Number(body.internalPort) || 0;
      const publicAddr = String(body.publicAddr || '').trim();
      if (!name) return sendRes(400, { ok: false, error: 'name 必填' });
      if (!internalAddr) return sendRes(400, { ok: false, error: 'internalAddr 必填' });
      if (!internalPort) return sendRes(400, { ok: false, error: 'internalPort 必填且为数字' });
      if (!publicAddr) return sendRes(400, { ok: false, error: 'publicAddr 必填' });
      const tunnel = deployConfig.upsertTunnel({ name, internalAddr, internalPort, publicAddr, enabled: body.enabled !== false });
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'deploy-tunnel-create', entity: 'deploy', target: tunnel.id,
        before: null, after: tunnel, ok: true,
      });
      return sendRes(200, { ok: true, tunnel });
    }
    const tunAct = p.match(/^\/api\/admin\/deploy\/tunnels\/([^/]+)(?:\/(toggle))?$/);
    if (method === 'PUT' && tunAct && !tunAct[2]) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const id = decodeURIComponent(tunAct[1]);
      const existing = deployConfig.listTunnels().find((t) => t.id === id);
      if (!existing) return sendRes(404, { ok: false, error: '穿透地址不存在' });
      const tunnel = deployConfig.upsertTunnel(Object.assign({ id }, body || {}));
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'deploy-tunnel-update', entity: 'deploy', target: id,
        before: existing, after: tunnel, ok: true,
      });
      return sendRes(200, { ok: true, tunnel });
    }
    if (method === 'DELETE' && tunAct && !tunAct[2]) {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const id = decodeURIComponent(tunAct[1]);
      const removed = deployConfig.removeTunnel(id);
      if (!removed) return sendRes(404, { ok: false, error: '穿透地址不存在' });
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'deploy-tunnel-delete', entity: 'deploy', target: id,
        before: { id }, after: null, ok: true,
      });
      return sendRes(200, { ok: true, removed: true });
    }
    if (method === 'POST' && tunAct && tunAct[2] === 'toggle') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const body = await readBody(req);
      const id = decodeURIComponent(tunAct[1]);
      const tunnel = deployConfig.toggleTunnel(id, body.enabled === true);
      if (!tunnel) return sendRes(404, { ok: false, error: '穿透地址不存在' });
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'deploy-tunnel-toggle', entity: 'deploy', target: id,
        before: { enabled: !(body.enabled === true) }, after: { enabled: body.enabled === true }, ok: true,
      });
      return sendRes(200, { ok: true, tunnel });
    }
    if (method === 'POST' && p === '/api/admin/deploy/push-to-git') {
      const a = authWrite();
      if (!a.ok) return sendRes(a.status || 403, { ok: false, error: a.error });
      const payload = deployConfig.toRepoPayload();
      const r = await gitDeploy.push(payload);
      if (!r.ok) return sendRes(500, { ok: false, error: r.error });
      opsAuditStore.logOp({
        operator: a.qq, operatorLevel: a.level,
        action: 'deploy-push-git', entity: 'deploy', target: 'deploy-config.json',
        before: null, after: { commitHash: r.commitHash || '', unchanged: !!r.unchanged }, ok: true,
      });
      return sendRes(200, { ok: true, commitHash: r.commitHash || '', remote: r.remote || '', unchanged: !!r.unchanged });
    }

    // 未匹配的 console 路由
    return sendRes(404, { ok: false, error: '未知控制台接口: ' + method + ' ' + p });
  } catch (e) {
    // 兜底：任何意外都不抛出未处理异常（请求已结束）
    try { send(res, 500, { ok: false, error: String(e && e.message || e) }); } catch (_) { /* ignore */ }
  }
}

module.exports = { handle, send, readBody, ADMIN_QQ };
