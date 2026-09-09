'use strict';
/**
 * lib/ops/crud.js — 通用 CRUD 引擎（OpsCrud，sea2 运维引擎）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §3.1 / §3.5 / §7.5
 *
 * 实体（entity）：
 *  - codes   ：激活码记录（store.codes）
 *  - devices ：设备档案（devices.listDevices 派生 + 档案扩展：备注/分组/机型白名单标记）
 *  - printers：打印机档案（printers.list 派生 + 档案扩展：型号/驱动/URI/队列）
 *  - configs ：配置中心（configManager schema + fleetConfig 新键）
 *
 * 统一行为：
 *  - list(page/filter/q)：分页 + 筛选 + 搜索；
 *  - create / update / remove：写操作全部经 OpsAuditStore.logOp（operator/时间/变更前后值）；
 *  - remove 一律软删（标记 deleted:true），不物理删除、不破坏既有数据。
 *
 * 数据隔离：
 *  - 档案扩展存 data/device-profiles.json / data/printer-profiles.json（DATA_DIR 内，测试天然隔离）；
 *  - configs 只允许写 fleetConfig 键（落 data/fleet-config.json），不碰 config.env。
 */

const fs = require('node:fs');
const path = require('node:path');

const auditStore = require('./auditStore');
const codes = require('../codes');
const devices = require('../console/devices');
const printers = require('../console/printers');
const configManager = require('../configManager');
const fleetConfig = require('../fleetConfig');
// [T03 需求5] 设备管理自动纳入集群心跳设备（含试用）：与心跳同一 fleetStore 实例，零迁移
const fleetStore = require('../fleetStore');

const DEFAULT_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

/** 合法实体（防任意文件/表写入） */
const ENTITIES = ['codes', 'devices', 'printers', 'configs'];

/** 档案文件（devices / printers 的扩展字段持久化） */
const PROFILE_FILES = {
  devices: 'device-profiles.json',
  printers: 'printer-profiles.json',
};

class OpsCrud {
  /**
   * @param {object} deps
   * @param {object} deps.store 激活码主 store（store.js 实例）
   * @param {object} [deps.cfg] loadConfig() 结果
   * @param {string} [deps.dataDir] 数据目录（默认 DATA_DIR）
   */
  constructor(deps) {
    deps = deps || {};
    this.store = deps.store || null;
    this.cfg = deps.cfg || null;
    this.dataDir = deps.dataDir || DEFAULT_DATA_DIR;
    this._profileCache = {};
  }

  // ---------------- 档案存储（devices / printers 扩展字段）----------------
  _profileFile(entity) {
    const name = PROFILE_FILES[entity];
    return name ? path.join(this.dataDir, name) : null;
  }

  _loadProfiles(entity) {
    if (this._profileCache[entity]) return this._profileCache[entity];
    let data = { profiles: {} };
    const file = this._profileFile(entity);
    if (file && fs.existsSync(file)) {
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data || typeof data.profiles !== 'object') data = { profiles: {} };
      } catch (e) {
        data = { profiles: {} };
      }
    }
    this._profileCache[entity] = data;
    return data;
  }

  _saveProfiles(entity) {
    const file = this._profileFile(entity);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._loadProfiles(entity), null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      // best-effort
    }
  }

  _getProfile(entity, id) {
    return this._loadProfiles(entity).profiles[id] || null;
  }

  _setProfile(entity, id, patch) {
    const data = this._loadProfiles(entity);
    data.profiles[id] = Object.assign({}, data.profiles[id] || {}, patch || {});
    data.profiles[id].updatedAt = Math.floor(Date.now() / 1000);
    this._saveProfiles(entity);
    return data.profiles[id];
  }

  /**
   * [T1-P0-2] 设备档案 upsert 兜底。
   *
   * 设备列表的项来自 codes / fleet 心跳自动派生，绝大多数在 device-profiles.json
   * 中并无档案。此前 update/remove 一律 404「设备档案不存在」→ 设备管理页编辑/删除
   * 全部失败。此处改为：无档案时用机器码 + 请求体自动建档（默认空值），再继续原操作。
   * @param {string} mid 机器码（列表项 id）
   * @param {object} [body] 请求体（可选，仅提取合法档案字段）
   * @returns {object} 设备档案（保证存在）
   * @private
   */
  _ensureDeviceProfile(mid, body) {
    const existing = this._getProfile('devices', mid);
    if (existing) {
      this._lastDeviceAutoCreated = false;
      return existing;
    }
    body = body || {};
    const profile = {
      machineId: mid,
      remark: String(body.remark || '').slice(0, 500),
      group: String(body.group || '').slice(0, 100),
      model: String(body.model || '').slice(0, 200),
      whitelisted: body.whitelisted === true,
      deleted: false,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this._lastDeviceAutoCreated = true;
    return this._setProfile('devices', mid, profile);
  }

  // ---------------- 实体适配：全量列表 ----------------
  _listAll(entity) {
    switch (entity) {
      case 'codes':
        return (this.store ? this.store.listCodes() : []).map((c) => Object.assign({}, c));
      case 'devices':
        return this._listDevices();
      case 'printers':
        return this._listPrinters();
      case 'configs':
        return this._listConfigs();
      default:
        return [];
    }
  }

  _listDevices() {
    // [T03 需求5] 传入与心跳同实例的 fleetStore（getInstance(deps.dataDir) 复用既有单例，
    // 若 dataDir 与当前不同会自动重绑定 re-hydrate），使设备列表自动纳入集群心跳设备（含试用）。
    const fsInst = fleetStore.getInstance(this.dataDir);
    const base = this.store ? devices.listDevices(this.store, fsInst) : [];
    const profiles = this._loadProfiles('devices').profiles || {};
    const merged = devices.extendWithProfiles(base, profiles);
    // 档案优先：仅有档案（无激活码/试用记录）的设备也要可见
    const seen = new Set(merged.map((x) => x.machine_id || x.id));
    for (const mid of Object.keys(profiles)) {
      if (seen.has(mid)) continue;
      const p = profiles[mid];
      merged.push({
        id: mid,
        machine_id: mid,
        qq: '',
        code: '',
        plan: '',
        planName: '',
        status: 'archived',
        last_heartbeat: null,
        license_expires_at: 0,
        issuedAt: 0,
        remark: p.remark || '',
        group: p.group || '',
        model: p.model || '',
        whitelisted: p.whitelisted === true,
        profileDeleted: p.deleted === true,
        profileUpdatedAt: p.updatedAt || 0,
      });
    }
    return merged;
  }

  _listPrinters() {
    const base = printers.list();
    const baseItems = Array.isArray(base.printers) ? base.printers : [];
    const profiles = this._loadProfiles('printers').profiles || {};
    const merged = printers.extendWithProfiles(baseItems, profiles);
    // 档案优先：本机无 CUPS 时，档案打印机仍可见
    const seen = new Set(merged.map((x) => x.name));
    for (const name of Object.keys(profiles)) {
      if (seen.has(name)) continue;
      const p = profiles[name];
      merged.push({
        name,
        accepting: false,
        enabled: false,
        state: 'archived',
        device: p.uri || '',
        isDefault: false,
        model: p.model || '',
        driver: p.driver || '',
        uri: p.uri || '',
        queue: p.queue || '',
        profileDeleted: p.deleted === true,
        profileUpdatedAt: p.updatedAt || 0,
      });
    }
    return merged;
  }

  _listConfigs() {
    const rc = configManager.readConfig(this.cfg || {}, this.store || {});
    return (rc.schema || []).map((f) => ({
      key: f.key,
      label: f.label,
      group: f.group,
      type: f.type,
      value: rc.values[f.key],
      hot: !!f.hot,
      requiresRestart: !!f.requiresRestart,
      fleet: !!f.fleet,
      secret: !!f.secret || f.type === 'secret',
      help: f.help || '',
    }));
  }

  // ---------------- 实体适配：创建 ----------------
  _createRecord(entity, body) {
    body = body || {};
    switch (entity) {
      case 'codes': {
        const rec = codes.makeCodeRecord(body);
        if (this.store) {
          if (this.store.getCode(rec.code)) {
            return { ok: false, error: `授权码 ${rec.code} 已存在`, status: 409 };
          }
          this.store.createCode(rec);
        }
        return { ok: true, record: rec };
      }
      case 'devices': {
        const mid = String(body.machineId || body.machine_id || '').trim();
        if (!mid) return { ok: false, error: 'machineId 必填', status: 400 };
        const profile = {
          machineId: mid,
          remark: String(body.remark || '').slice(0, 500),
          group: String(body.group || '').slice(0, 100),
          model: String(body.model || '').slice(0, 200),
          whitelisted: body.whitelisted === true,
          deleted: false,
          createdAt: Math.floor(Date.now() / 1000),
        };
        this._setProfile('devices', mid, profile);
        return { ok: true, record: profile };
      }
      case 'printers': {
        const name = String(body.name || '').trim();
        if (!name) return { ok: false, error: 'name 必填', status: 400 };
        const profile = {
          name,
          model: String(body.model || '').slice(0, 256),
          driver: String(body.driver || '').slice(0, 128),
          uri: String(body.uri || '').slice(0, 512),
          queue: String(body.queue || '').slice(0, 64),
          deleted: false,
          createdAt: Math.floor(Date.now() / 1000),
        };
        this._setProfile('printers', name, profile);
        return { ok: true, record: profile };
      }
      case 'configs': {
        // configs 语义为 upsert：create == update（按 key 应用 patch）
        return this._updateConfig(body);
      }
      default:
        return { ok: false, error: '未知实体', status: 400 };
    }
  }

  // ---------------- 实体适配：更新 ----------------
  _updateRecord(entity, id, body) {
    body = body || {};
    switch (entity) {
      case 'codes': {
        if (!this.store) return { ok: false, error: 'store 未注入', status: 500 };
        const rec = this.store.getCode(String(id));
        if (!rec) return { ok: false, error: '授权码不存在', status: 404 };
        const before = Object.assign({}, rec);
        const patch = {};
        for (const k of Object.keys(body)) {
          // 只允许更新安全字段；code / status / bound_machine_id 不得经 CRUD 直接改：
          //   - code 与 status 防破坏授权语义；
          //   - bound_machine_id 的变更必须走 /api/admin/ops/binding（仅 L3，含审计）。
          if (k === 'code' || k === 'status' || k === 'bound_machine_id') continue;
          if (k === 'expires_at') {
            const n = Number(body[k]);
            patch[k] = Number.isFinite(n) ? n : rec[k];
          } else if (k === 'features') {
            patch[k] = Array.isArray(body[k]) ? body[k] : rec[k];
          } else {
            patch[k] = body[k];
          }
        }
        if (Object.keys(patch).length === 0) {
          return { ok: false, error: '无可更新字段（code/status 不可经 CRUD 修改）', status: 400 };
        }
        this.store.updateCode(String(id), patch);
        const after = Object.assign({}, this.store.getCode(String(id)));
        return { ok: true, before, after };
      }
      case 'devices': {
        const mid = String(id);
        // [T1-P0-2] 无档案自动建档（设备必然来自 codes/fleet，不再 404）
        const profile = this._ensureDeviceProfile(mid, body);
        const before = Object.assign({}, profile);
        const next = Object.assign({}, profile, {
          remark: body.remark !== undefined ? String(body.remark).slice(0, 500) : profile.remark,
          group: body.group !== undefined ? String(body.group).slice(0, 100) : profile.group,
          model: body.model !== undefined ? String(body.model).slice(0, 200) : profile.model,
          whitelisted: body.whitelisted !== undefined ? body.whitelisted === true : profile.whitelisted,
        });
        const after = this._setProfile('devices', mid, next);
        return { ok: true, before, after, autoCreated: this._lastDeviceAutoCreated === true };
      }
      case 'printers': {
        const name = String(id);
        const profile = this._getProfile('printers', name);
        if (!profile) return { ok: false, error: '打印机档案不存在', status: 404 };
        const before = Object.assign({}, profile);
        const next = Object.assign({}, profile, {
          model: body.model !== undefined ? String(body.model).slice(0, 256) : profile.model,
          driver: body.driver !== undefined ? String(body.driver).slice(0, 128) : profile.driver,
          uri: body.uri !== undefined ? String(body.uri).slice(0, 512) : profile.uri,
          queue: body.queue !== undefined ? String(body.queue).slice(0, 64) : profile.queue,
        });
        const after = this._setProfile('printers', name, next);
        return { ok: true, before, after };
      }
      case 'configs': {
        return this._updateConfig(Object.assign({}, body, { key: String(id) }));
      }
      default:
        return { ok: false, error: '未知实体', status: 400 };
    }
  }

  /**
   * configs 更新：仅接受 fleetConfig 键（fleet:true），写 data/fleet-config.json。
   * @param {object} body { key, value }
   * @private
   */
  _updateConfig(body) {
    const key = String(body.key || '');
    const schemaField = configManager.SCHEMA.find((f) => f.key === key);
    if (!schemaField || !schemaField.fleet) {
      return { ok: false, error: 'configs 仅支持运维配置键（formatWhitelist/formatLevels/highriskEnabled/cupsDriverRepo/pm2ServerWhitelist/totpSecret）', status: 400 };
    }
    const cur = fleetConfig.load();
    const before = { key, value: cur[key] };
    const raw = body.value !== undefined ? body.value : body.patch;
    if (raw === undefined || raw === null || raw === '') {
      return { ok: false, error: 'value 必填', status: 400 };
    }
    let outVal;
    if (schemaField.type === 'json') {
      try {
        outVal = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        return { ok: false, error: `字段「${schemaField.label}」JSON 解析失败：${e.message}`, status: 400 };
      }
    } else if (schemaField.type === 'boolean') {
      outVal = (raw === true || raw === '1' || raw === 'true');
    } else if (schemaField.type === 'number') {
      outVal = Number(raw);
      if (!Number.isFinite(outVal)) return { ok: false, error: 'value 必须为数字', status: 400 };
    } else {
      outVal = String(raw);
    }
    if (key === 'formatWhitelist' && !Array.isArray(outVal)) return { ok: false, error: 'formatWhitelist 必须为数组', status: 400 };
    if (key === 'pm2ServerWhitelist' && !Array.isArray(outVal)) return { ok: false, error: 'pm2ServerWhitelist 必须为数组', status: 400 };
    if (key === 'formatLevels' && (typeof outVal !== 'object' || outVal === null)) return { ok: false, error: 'formatLevels 必须为对象', status: 400 };

    fleetConfig.save({ [key]: outVal });
    const after = { key, value: fleetConfig.load()[key] };
    return { ok: true, before, after, value: outVal };
  }

  // ---------------- 实体适配：软删 ----------------
  _removeRecord(entity, id) {
    switch (entity) {
      case 'codes': {
        if (!this.store) return { ok: false, error: 'store 未注入', status: 500 };
        const rec = this.store.getCode(String(id));
        if (!rec) return { ok: false, error: '授权码不存在', status: 404 };
        const before = Object.assign({}, rec);
        this.store.updateCode(String(id), { deleted: true, deletedAt: Math.floor(Date.now() / 1000) });
        const after = Object.assign({}, this.store.getCode(String(id)));
        return { ok: true, before, after };
      }
      case 'devices': {
        const mid = String(id);
        // [T1-P0-2] 无档案也允许删除：自动建档并标记 deleted，使列表软删隐藏生效
        const profile = this._ensureDeviceProfile(mid, {});
        const before = Object.assign({}, profile);
        const after = this._setProfile('devices', mid, { deleted: true, deletedAt: Math.floor(Date.now() / 1000) });
        return { ok: true, before, after, autoCreated: this._lastDeviceAutoCreated === true };
      }
      case 'printers': {
        const profile = this._getProfile('printers', String(id));
        if (!profile) return { ok: false, error: '打印机档案不存在', status: 404 };
        const before = Object.assign({}, profile);
        const after = this._setProfile('printers', String(id), { deleted: true });
        return { ok: true, before, after };
      }
      case 'configs': {
        // 重置为默认值（软删语义：回到出厂默认）
        const key = String(id);
        const schemaField = configManager.SCHEMA.find((f) => f.key === key);
        if (!schemaField || !schemaField.fleet) {
          return { ok: false, error: 'configs 仅支持运维配置键', status: 400 };
        }
        const cur = fleetConfig.load();
        const before = { key, value: cur[key] };
        const defaultValue = fleetConfig.DEFAULTS[key];
        fleetConfig.save({ [key]: defaultValue });
        const after = { key, value: fleetConfig.load()[key] };
        return { ok: true, before, after };
      }
      default:
        return { ok: false, error: '未知实体', status: 400 };
    }
  }

  // ---------------- 对外 API ----------------
  /**
   * 列表（分页 / 筛选 / 搜索）。
   * @param {string} entity
   * @param {object} [filter] { page, pageSize, q, filter }
   * @returns {{items:Array, total:number, page:number, pageSize:number}}
   */
  list(entity, filter) {
    if (ENTITIES.indexOf(entity) < 0) {
      return { items: [], total: 0, page: 1, pageSize: 0, error: '未知实体' };
    }
    filter = filter || {};
    let items = this._listAll(entity);

    // 软删默认隐藏（除非显式 filter=all）
    const showDeleted = String(filter.filter || '').toLowerCase() === 'all';
    if (!showDeleted) {
      items = items.filter((x) => x.deleted !== true && x.profileDeleted !== true);
    }

    const q = filter.q != null ? String(filter.q).toLowerCase() : '';
    if (q) {
      items = items.filter((x) =>
        ['code', 'key', 'label', 'name', 'machine_id', 'machineId', 'customer', 'qq', 'group', 'model', 'driver', 'uri', 'status']
          .some((k) => (x[k] != null ? String(x[k]).toLowerCase().includes(q) : false)));
    }
    if (filter.status) items = items.filter((x) => x.status === filter.status);
    if (filter.group) items = items.filter((x) => x.group === filter.group);

    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(filter.pageSize, 10) || 50));
    const total = items.length;
    const startIdx = (page - 1) * pageSize;
    const paged = items.slice(startIdx, startIdx + pageSize);
    return { items: paged, total, page, pageSize };
  }

  /**
   * 创建（写操作，审计 before/after）。
   * @param {string} entity
   * @param {object} body
   * @param {string} [operator]
   * @param {number|string} [operatorLevel]
   * @returns {{ok:boolean, record?:object, error?:string, status?:number}}
   */
  create(entity, body, operator, operatorLevel) {
    if (ENTITIES.indexOf(entity) < 0) return { ok: false, error: '未知实体', status: 400 };
    const r = this._createRecord(entity, body || {});
    if (!r.ok) return r;
    auditStore.logOp({
      operator: operator || 'system', operatorLevel,
      action: 'crud-create', entity, target: this._targetOf(entity, r.record),
      before: null, after: r.record, ok: true,
    });
    return { ok: true, record: r.record };
  }

  /**
   * 更新（写操作，记录变更前后值）。
   * @param {string} entity
   * @param {string} id
   * @param {object} body
   * @param {string} [operator]
   * @param {number|string} [operatorLevel]
   * @returns {{ok:boolean, before?:object, after?:object, error?:string, status?:number}}
   */
  update(entity, id, body, operator, operatorLevel) {
    if (ENTITIES.indexOf(entity) < 0) return { ok: false, error: '未知实体', status: 400 };
    const r = this._updateRecord(entity, id, body || {});
    if (!r.ok) return r;
    auditStore.logOp({
      operator: operator || 'system', operatorLevel,
      action: 'crud-update', entity, target: String(id),
      before: r.before, after: r.after, ok: true,
    });
    return { ok: true, before: r.before, after: r.after, autoCreated: r.autoCreated === true };
  }

  /**
   * 软删（写操作，记录变更前后值）。
   * @param {string} entity
   * @param {string} id
   * @param {string} [operator]
   * @param {number|string} [operatorLevel]
   * @returns {{ok:boolean, before?:object, after?:object, error?:string, status?:number}}
   */
  remove(entity, id, operator, operatorLevel) {
    if (ENTITIES.indexOf(entity) < 0) return { ok: false, error: '未知实体', status: 400 };
    const r = this._removeRecord(entity, id);
    if (!r.ok) return r;
    auditStore.logOp({
      operator: operator || 'system', operatorLevel,
      action: 'crud-remove', entity, target: String(id),
      before: r.before, after: r.after, ok: true,
    });
    return { ok: true, before: r.before, after: r.after, autoCreated: r.autoCreated === true };
  }

  /** 取记录展示目标 id（审计 target 用） */
  _targetOf(entity, record) {
    if (!record) return '';
    if (entity === 'codes') return record.code || '';
    if (entity === 'devices') return record.machineId || record.machine_id || record.id || '';
    if (entity === 'printers') return record.name || '';
    if (entity === 'configs') return record.key || '';
    return '';
  }

  /** 实体是否合法（供路由层快速判断） */
  static isEntity(entity) {
    return ENTITIES.indexOf(entity) >= 0;
  }

  /**
   * [R4] 静态读取设备档案（供 highrisk 白名单联动复用）。
   *
   * 直接读 DATA_DIR/device-profiles.json 中 profiles[machineId]，不依赖实例状态，
   * 避免 crud ↔ highrisk 循环依赖（highrisk require crud 单方向即可）。
   * @param {string} machineId 机器码
   * @param {string} [dataDir] 数据目录（默认 DATA_DIR）
   * @returns {object|null} 档案对象（含 whitelisted 等字段）；不存在或读取失败返回 null
   */
  static getDeviceProfile(machineId, dataDir) {
    if (!machineId) return null;
    const dir = dataDir || process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
    const file = path.join(dir, PROFILE_FILES.devices);
    try {
      if (!fs.existsSync(file)) return null;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const profiles = (data && data.profiles) || {};
      return profiles[String(machineId)] || null;
    } catch (e) {
      return null;
    }
  }
}

module.exports = { OpsCrud, ENTITIES, PROFILE_FILES };
