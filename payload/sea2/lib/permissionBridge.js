'use strict';
/**
 * lib/permissionBridge.js — bot 侧 N4 桥接（仅被 sea1-bot 使用）
 *
 * 职责：
 *  1. 导出只读快照 data/permission_snapshot.json（含 users / fallback / audit / meta），
 *     启动即导出，并周期性（每 3s）重导，保证 activation-server 侧控制台能读到最新权限。
 *  2. 监听 data/permission_inbox.jsonl（控制台写入的命令信箱），
 *     逐行调用 PermissionService.setLevel / removeLevel 落库（operator = 'system:console'），
 *     成功后重写快照。
 *
 * 设计约束（决策 #2）：
 *  - bot 始终是 N4 数据库（db.sqlite）的唯一写者，避免 SQLITE_BUSY 并发写竞争。
 *  - 控制台侧只追加命令到信箱，不直接写库。
 *  - 仅用 fs / path + 既有 PermissionService（无新增第三方依赖）。
 */

const fs = require('node:fs');
const path = require('node:path');
const permissionAudit = require('./permission-audit');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const POLL_MS = 1000;       // 信箱轮询间隔（秒级生效）
const RESNAPSHOT_MS = 3000; // 快照重导间隔

/**
 * 启动权限桥接。
 * @param {{permission:object, config:object, dataDir?:string}} opts
 * @returns {{stop:function}} 控制句柄
 */
async function startPermissionBridge(opts) {
  const permission = opts && opts.permission;
  const config = opts && opts.config;
  const dataDir = (opts && opts.dataDir) || DEFAULT_DATA_DIR;

  if (!permission || typeof permission.listUsers !== 'function') {
    // 容错：permission 未就绪则跳过（不阻断 bot 启动）
    console.warn('[permissionBridge] permission 未就绪，桥接未启动（控制台 QQ 登录将不可用，仅超管令牌可用）。');
    return { stop: function () {} };
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const snapshotPath = path.join(dataDir, 'permission_snapshot.json');
  const inboxPath = path.join(dataDir, 'permission_inbox.jsonl');

  /** 写出最新快照 */
  async function writeSnapshot() {
    try {
      const users = await permission.listUsers(0, 500);
      let audit = [];
      try {
        if (permission.db) audit = await permissionAudit.listAudit(permission.db, { limit: 50 });
      } catch (e) { /* 审计读取失败不影响主快照 */ }
      const snap = {
        users,
        fallback: {
          superAdmin: (config && config.superAdmin) || null,
          developer: (config && config.developer) || null,
        },
        audit,
        meta: { exportedAt: new Date().toISOString() },
      };
      fs.writeFileSync(snapshotPath, JSON.stringify(snap, null, 2));
    } catch (e) {
      console.warn('[permissionBridge] 写快照失败:', e.message);
    }
  }

  /** 应用一条命令（set / remove）。
   *  控制台在入队前已对操作人做过 L2+ 鉴权；此处解析真实操作人 uin：
   *   - 命令携带的操作人本身是真实 L2+ uin（QQ 登录场景）→ 用之；
   *   - 否则（超管令牌 qq='super' 或非真实 uin）→ 回退到 config 兜底的
   *     developer(L3)/superAdmin(L2)，保证 PermissionService 的 operatorLevel>=2
   *     防提权校验通过；控制台侧审计(console-audit.jsonl)仍记录原始操作人。 */
  async function applyCmd(cmd) {
    try {
      if (!cmd || !cmd.target) return;
      let op = (cmd.operator && String(cmd.operator) !== 'super') ? String(cmd.operator) : null;
      if (op) {
        try { if ((await permission.getLevel(op)) < 2) op = null; } catch (e) { op = null; }
      }
      if (!op) {
        op = (config && (config.developer || config.superAdmin)) || 'system:console';
      }
      if (cmd.op === 'remove') {
        await permission.removeLevel(op, cmd.target);
      } else {
        await permission.setLevel(op, cmd.target, Number(cmd.level) || 0);
      }
    } catch (e) {
      console.warn('[permissionBridge] 应用命令失败:', e.message);
    }
  }

  /** 处理信箱：读取→应用→重写快照（保留处理期间新追加的行） */
  async function drain() {
    if (!fs.existsSync(inboxPath)) return;
    let content;
    try { content = fs.readFileSync(inboxPath, 'utf8'); } catch (e) { return; }
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    for (const line of lines) {
      try { await applyCmd(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
    }
    // 处理期间可能又有新追加：仅剥离已处理行，保留剩余
    try {
      const after = fs.readFileSync(inboxPath, 'utf8').split(/\r?\n/).filter(Boolean);
      const remaining = after.slice(lines.length);
      fs.writeFileSync(inboxPath, remaining.map((l) => l + '\n').join(''));
    } catch (e) { /* 忽略 */ }
    await writeSnapshot();
  }

  // 启动即导出
  await writeSnapshot();

  const pollTimer = setInterval(drain, POLL_MS);
  const snapTimer = setInterval(writeSnapshot, RESNAPSHOT_MS);
  if (pollTimer.unref) pollTimer.unref();
  if (snapTimer.unref) snapTimer.unref();

  // 即时监听信箱（best-effort）
  try {
    fs.watch(inboxPath, () => { drain().catch(() => {}); });
  } catch (e) { /* fs.watch 不可用则依赖轮询 */ }

  return {
    stop() {
      clearInterval(pollTimer);
      clearInterval(snapTimer);
    },
  };
}

module.exports = { startPermissionBridge };
