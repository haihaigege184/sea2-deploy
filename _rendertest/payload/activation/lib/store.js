'use strict';
/**
 * store.js — 极简文件存储（JSON）
 * 为可移植与零原生依赖，默认用 JSON 文件落地。
 * 接口抽象清晰，生产可平滑替换为 SQLite（见 README）。
 */
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'store.json');
    this.cache = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const obj = JSON.parse(raw);
      return {
        codes: {}, licenses: {}, heartbeats: {}, trials: {}, orders: {},
        trialUsers: {}, trialConfig: {}, pendingReminders: [], ...obj,
      };
    } catch {
      return {
        codes: {}, licenses: {}, heartbeats: {}, trials: {}, orders: {},
        trialUsers: {}, trialConfig: {}, pendingReminders: [],
      };
    }
  }

  _flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 原子写：先写临时文件再 rename
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---- 激活码 ----
  createCode(record) {
    this.cache.codes[record.code] = record;
    this._flush();
    return record;
  }
  getCode(code) {
    return this.cache.codes[code] || null;
  }
  updateCode(code, patch) {
    const cur = this.cache.codes[code];
    if (!cur) return null;
    Object.assign(cur, patch);
    this._flush();
    return cur;
  }
  listCodes() {
    return Object.values(this.cache.codes);
  }

  // ---- 已下发 license ----
  saveLicense(record) {
    this.cache.licenses[record.code] = record;
    this._flush();
    return record;
  }
  getLicense(code) {
    return this.cache.licenses[code] || null;
  }
  listLicenses() {
    return Object.values(this.cache.licenses);
  }

  // ---- 心跳日志 ----
  recordHeartbeat(machineId, entry) {
    if (!this.cache.heartbeats[machineId]) this.cache.heartbeats[machineId] = [];
    this.cache.heartbeats[machineId].unshift(entry);
    this.cache.heartbeats[machineId] = this.cache.heartbeats[machineId].slice(0, 50);
    this._flush();
  }
  listHeartbeats() {
    return this.cache.heartbeats;
  }

  // ---- 试用（按 machine_id）----
  getTrial(machineId) {
    return this.cache.trials[machineId] || null;
  }
  saveTrial(record) {
    this.cache.trials[record.machine_id] = record;
    this._flush();
    return record;
  }
  listTrials() {
    return Object.values(this.cache.trials);
  }
  // [R6 R1] 幂等删除机器维度试用记录（原子写 tmp+rename；缺失返回 false）
  removeTrial(machineId) {
    if (!this.cache.trials[machineId]) return false;
    delete this.cache.trials[machineId];
    this._flush();
    return true;
  }

  // ---- 订单（支付/激活绑定）----
  getOrder(orderId) {
    return this.cache.orders[orderId] || null;
  }
  saveOrder(record) {
    this.cache.orders[record.order_id] = record;
    this._flush();
    return record;
  }
  updateOrder(orderId, patch) {
    const cur = this.cache.orders[orderId];
    if (!cur) return null;
    Object.assign(cur, patch);
    this._flush();
    return cur;
  }
  listOrders() {
    return Object.values(this.cache.orders);
  }
  // [T2 P2-11] 删除任意订单（订单审计「删除」操作；返回被删记录或 null）
  deleteOrder(orderId) {
    const cur = this.cache.orders[orderId];
    if (!cur) return null;
    delete this.cache.orders[orderId];
    this._flush();
    return cur;
  }

  // ---- 新用户试用期（按 uin / QQ）----
  getTrialUser(uin) {
    return this.cache.trialUsers[uin] || null;
  }
  saveTrialUser(record) {
    this.cache.trialUsers[record.uin] = record;
    this._flush();
    return record;
  }
  updateTrialUser(uin, patch) {
    const cur = this.cache.trialUsers[uin];
    if (!cur) return null;
    Object.assign(cur, patch);
    this._flush();
    return cur;
  }
  listTrialUsers() {
    return Object.values(this.cache.trialUsers);
  }
  // [R6 R1] 幂等删除用户维度试用记录（原子写 tmp+rename；缺失返回 false）
  removeTrialUser(uin) {
    const u = String(uin);
    if (!this.cache.trialUsers[u]) return false;
    delete this.cache.trialUsers[u];
    this._flush();
    return true;
  }

  // ---- 试用配置（单例对象）----
  getTrialConfig() {
    return this.cache.trialConfig || null;
  }
  saveTrialConfig(record) {
    this.cache.trialConfig = record;
    this._flush();
    return record;
  }

  // ---- 待发提醒队列（数组）----
  getPendingReminders() {
    if (!this.cache.pendingReminders) this.cache.pendingReminders = [];
    return this.cache.pendingReminders;
  }
  addPendingReminder(rec) {
    if (!this.cache.pendingReminders) this.cache.pendingReminders = [];
    this.cache.pendingReminders.push(rec);
    this._flush();
    return rec;
  }
  removePendingReminder(pred) {
    if (!this.cache.pendingReminders) return 0;
    const before = this.cache.pendingReminders.length;
    this.cache.pendingReminders = this.cache.pendingReminders.filter((r) => !pred(r));
    if (this.cache.pendingReminders.length !== before) this._flush();
    return before - this.cache.pendingReminders.length;
  }
  clearPendingRemindersForUin(uin) {
    if (!this.cache.pendingReminders) return 0;
    const before = this.cache.pendingReminders.length;
    this.cache.pendingReminders = this.cache.pendingReminders.filter((r) => r.uin !== uin);
    if (this.cache.pendingReminders.length !== before) this._flush();
    return before - this.cache.pendingReminders.length;
  }
}

module.exports = { Store };
