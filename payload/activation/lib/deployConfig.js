'use strict';
/**
 * lib/deployConfig.js — 一键部署配置管理（R4，sea2 第 4 批增量）
 *
 * 职责：
 *  - 管理「穿透地址」清单（deployConfig.tunnels[]）+ 部署主通信地址（masterAddress）；
 *  - 落 data/deploy-config.json（DATA_DIR 内，与 fleet-config.json 并列）；
 *  - load() 每次重读文件（热更，改完立即生效，无需重启）；
 *  - save() 原子写（tmp + rename）并幂等生成缺失的默认文件；
 *  - toRepoPayload() 输出仓库内 deploy-config.json 推送产物（tunnels 仅 enabled）。
 *
 * 数据形态（设计 §R4-P0）：
 *   { "version": 1, "masterAddress": "http://10.0.0.11:3457",
 *     "updatedAt": "ISO", "tunnels": [ { id, name, internalAddr,
 *       internalPort, publicAddr, enabled, createdAt, updatedAt } ] }
 *
 * 调用方：
 *  - configManager：SCHEMA.deployMasterAddress 的 hot/deploy 委托（保存走本模块，不回写 config.env）；
 *  - consoleApi：/api/admin/deploy/* 端点（CRUD + toggle + push-to-git）；
 *  - server.js：公开 GET /api/deploy/config（x-deploy-token 校验）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  version: 1,
  masterAddress: '',
  updatedAt: '',
  tunnels: [],
};

/** 穿透地址记录字段白名单（防脏数据注入） */
const TUNNEL_FIELDS = ['id', 'name', 'internalAddr', 'internalPort', 'publicAddr', 'enabled', 'createdAt', 'updatedAt'];

let _cacheFile = null;
let _cache = null;

function file() {
  if (!_cacheFile) {
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    _cacheFile = path.join(dataDir, 'deploy-config.json');
  }
  return _cacheFile;
}

/** 仅测试/特殊场景用：指定文件位置 */
function setFile(p) {
  _cacheFile = p;
  _cache = null;
}

function _readFile() {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const o = JSON.parse(raw);
    return Object.assign({}, DEFAULTS, o, { tunnels: Array.isArray(o.tunnels) ? o.tunnels : [] });
  } catch (e) {
    return Object.assign({}, DEFAULTS, { tunnels: [] });
  }
}

/**
 * 热读：重读文件，返回完整部署配置对象。
 * @returns {{version:number, masterAddress:string, updatedAt:string, tunnels:Array<object>}}
 */
function load() {
  const base = _readFile();
  _cache = base;
  return base;
}

/** 取单字段（懒加载） */
function get(key) {
  const c = _cache || load();
  return c[key];
}

function _normalizeTunnel(t) {
  t = t || {};
  const now = Math.floor(Date.now() / 1000);
  const out = {
    id: String(t.id || ''),
    name: String(t.name || '').slice(0, 100),
    internalAddr: String(t.internalAddr || '').slice(0, 255),
    internalPort: Number(t.internalPort) || 0,
    publicAddr: String(t.publicAddr || '').slice(0, 512),
    enabled: t.enabled === undefined ? true : t.enabled === true,
    createdAt: Number(t.createdAt) || now,
    updatedAt: Number(t.updatedAt) || now,
  };
  return out;
}

/**
 * 合并保存（原子写：tmp + rename）。
 * @param {object} patch 部分字段
 * @returns {object} 全量
 */
function save(patch) {
  const cur = _readFile();
  const next = Object.assign({}, cur, patch || {});
  if (!Array.isArray(next.tunnels)) next.tunnels = [];
  next.tunnels = next.tunnels.map((t) => _normalizeTunnel(t));
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file()); // 原子写
  } catch (e) {
    // best-effort：写盘失败不阻断内存态
  }
  _cache = next;
  return next;
}

/**
 * 列出全部穿透地址（含禁用）。
 * @returns {Array<object>}
 */
function listTunnels() {
  return load().tunnels || [];
}

function _genId() {
  return 'tun_' + Math.random().toString(16).slice(2, 8);
}

/**
 * 新增或更新穿透地址记录（按 id 幂等：无 id 自动生成）。
 * @param {object} t { id?, name, internalAddr, internalPort, publicAddr, enabled? }
 * @returns {object} 落库后的穿透地址记录
 */
function upsertTunnel(t) {
  t = t || {};
  const cur = load();
  const tunnels = cur.tunnels || [];
  const id = t.id ? String(t.id) : _genId();
  const idx = tunnels.findIndex((x) => x.id === id);
  const now = Math.floor(Date.now() / 1000);
  const base = idx >= 0 ? tunnels[idx] : { id, createdAt: now };
  const next = _normalizeTunnel(Object.assign({}, base, t, { id, updatedAt: now }));
  if (idx >= 0) tunnels[idx] = next;
  else tunnels.push(next);
  save({ tunnels, updatedAt: new Date().toISOString() });
  return next;
}

/**
 * 删除穿透地址记录（物理删除）。
 * @param {string} id
 * @returns {boolean} 是否删除了记录
 */
function removeTunnel(id) {
  const cur = load();
  const tunnels = (cur.tunnels || []).filter((x) => x.id !== String(id));
  if (tunnels.length === (cur.tunnels || []).length) return false;
  save({ tunnels, updatedAt: new Date().toISOString() });
  return true;
}

/**
 * 启用/禁用穿透地址。
 * @param {string} id
 * @param {boolean} enabled
 * @returns {object|null} 更新后的记录，不存在返回 null
 */
function toggleTunnel(id, enabled) {
  const cur = load();
  const tunnels = cur.tunnels || [];
  const idx = tunnels.findIndex((x) => x.id === String(id));
  if (idx < 0) return null;
  const next = _normalizeTunnel(Object.assign({}, tunnels[idx], {
    enabled: enabled === true,
    updatedAt: Math.floor(Date.now() / 1000),
  }));
  tunnels[idx] = next;
  save({ tunnels, updatedAt: new Date().toISOString() });
  return next;
}

/**
 * 设置部署主通信地址。
 * @param {string} addr
 * @returns {object} 全量
 */
function setMasterAddress(addr) {
  return save({ masterAddress: String(addr || '').trim(), updatedAt: new Date().toISOString() });
}

/**
 * 生成仓库内 deploy-config.json 推送产物（tunnels 仅 enabled）。
 * @returns {{version:number, masterAddress:string, updatedAt:string, tunnels:Array<object>}}
 */
function toRepoPayload() {
  const cur = load();
  return {
    version: 1,
    masterAddress: String(cur.masterAddress || '').trim(),
    updatedAt: new Date().toISOString(),
    tunnels: (cur.tunnels || [])
      .filter((t) => t.enabled === true)
      .map((t) => ({
        id: t.id,
        name: t.name || '',
        internalAddr: t.internalAddr || '',
        internalPort: Number(t.internalPort) || 0,
        publicAddr: t.publicAddr || '',
        enabled: true,
        createdAt: Number(t.createdAt) || 0,
        updatedAt: Number(t.updatedAt) || 0,
      })),
  };
}

/** 幂等确保默认文件存在（缺失时生成，含默认值） */
function ensureFile() {
  try {
    if (fs.existsSync(file())) return load();
    return save({});
  } catch (e) {
    return load();
  }
}

module.exports = {
  DEFAULTS,
  TUNNEL_FIELDS,
  load,
  get,
  save,
  file,
  setFile,
  listTunnels,
  upsertTunnel,
  removeTunnel,
  toggleTunnel,
  setMasterAddress,
  toRepoPayload,
  ensureFile,
};
