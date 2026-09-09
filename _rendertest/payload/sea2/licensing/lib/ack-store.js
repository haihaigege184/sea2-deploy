'use strict';
/**
 * ack-store.js — 指令回执持久化队列（客户端侧）
 *
 * 解决的问题：
 *   回执此前只存在内存 Map 里。`restart_client` / `restart_bot` / `restart_napcat`
 *   这类指令会在下一次心跳之前把进程干掉，回执随内存一起消失，
 *   服务端只能等到超时才把指令置为 timeout——运维看到的是「重启了但没回执」，
 *   无法区分「重启成功」和「客户端根本没收到」。
 *
 * 解决方式：
 *   落盘。写入采用「临时文件 + rename」保证原子性；重启类指令在**调用重启钩子之前**
 *   先同步落盘（见 index.js 的 _runCommands），进程即使立刻死亡，回执也已在磁盘上，
 *   下次启动后的第一次心跳就能补报。
 *
 * 设计约束：
 *   - 零三方依赖，仅用 Node 内置模块；
 *   - 任何 IO 异常都不得抛出（回执丢失是可接受的降级，拖垮客户端不是）；
 *   - 队列有上限，避免长期离线时无限增长撑爆磁盘。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 队列最多保留的回执条数（超出丢弃最旧的） */
const MAX_ITEMS = 200;
/** 回执最长保留时长（毫秒）：7 天仍未被服务端确认则丢弃 */
const MAX_AGE_MS = 7 * 86400000;
/** 单条 result 序列化后的字节上限，与服务端 64KB 截断对齐，避免白跑一趟网络 */
const RESULT_MAX_BYTES = 64 * 1024;

/**
 * 把 result 压到字节上限内。
 * 服务端也会截断，客户端先截是为了不浪费上行带宽（弱网现场很关键）。
 * @param {*} result 原始结果
 * @returns {{result:*, truncated:boolean}}
 */
function clampResult(result) {
  if (result == null) return { result: null, truncated: false };
  let text;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch (e) {
    // 循环引用等无法序列化的对象，降级为可读描述而不是丢掉
    return { result: '[unserializable result]', truncated: true };
  }
  if (text == null) return { result: null, truncated: false };
  if (Buffer.byteLength(text, 'utf8') <= RESULT_MAX_BYTES) {
    return { result, truncated: false };
  }
  return { result: Buffer.from(text, 'utf8').slice(0, RESULT_MAX_BYTES).toString('utf8'), truncated: true };
}

class AckStore {
  /**
   * @param {string} filePath 持久化文件路径
   * @param {object} [opts]
   * @param {object} [opts.logger] 日志对象（默认静默）
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.logger = opts.logger || null;
    /** @type {Array<{id:string, action:string, ok:boolean, error:string, result:*, truncated:boolean, at:number}>} */
    this.items = [];
    this._load();
  }

  /** 读盘；文件不存在或损坏时以空队列启动（绝不抛错）。 */
  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.items = parsed.filter((x) => x && typeof x.id === 'string');
      }
    } catch (e) {
      // 文件损坏不是致命问题：丢弃这批回执，服务端会走超时逻辑
      this._warn('回执队列读取失败，以空队列启动：' + ((e && e.message) || e));
      this.items = [];
    }
  }

  /** 原子落盘：先写临时文件再 rename，避免断电/被 kill 时留下半截 JSON。 */
  _flushSync() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.items), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      this._warn('回执队列落盘失败：' + ((e && e.message) || e));
    }
  }

  _warn(msg) {
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[fleet] ' + msg);
  }

  /**
   * 写入一条回执（按 id 覆盖）。同步落盘——调用点可能马上就要重启进程。
   * @param {object} entry
   * @param {string} entry.id 指令 id
   * @param {string} entry.action 指令名
   * @param {boolean} entry.ok 是否执行成功
   * @param {string} [entry.error] 失败原因（ok=false 时有意义）
   * @param {*} [entry.result] 结果体（health_check 等指令回传）
   * @returns {void}
   */
  add(entry) {
    if (!entry || !entry.id) return;
    const clamped = clampResult(entry.result);
    const item = {
      id: String(entry.id),
      action: String(entry.action || ''),
      ok: !!entry.ok,
      error: entry.ok ? '' : String(entry.error || 'unknown'),
      result: clamped.result,
      truncated: clamped.truncated,
      at: Date.now(),
    };
    const idx = this.items.findIndex((x) => x.id === item.id);
    if (idx >= 0) this.items[idx] = item;
    else this.items.push(item);
    this._prune();
    this._flushSync();
  }

  /** 按上限与时效裁剪队列（丢最旧的）。 */
  _prune() {
    const cutoff = Date.now() - MAX_AGE_MS;
    this.items = this.items.filter((x) => (x.at || 0) >= cutoff);
    if (this.items.length > MAX_ITEMS) {
      this.items = this.items.slice(this.items.length - MAX_ITEMS);
    }
  }

  /**
   * 取待上报的回执（服务端单次心跳有条数上限）。
   * @param {number} [limit=20] 最多取多少条
   * @returns {Array<{id:string, action:string, ok:boolean, error:string, result:*}>}
   */
  pending(limit = 20) {
    return this.items.slice(0, Math.max(0, limit)).map((x) => ({
      id: x.id,
      action: x.action,
      ok: x.ok,
      error: x.error,
      result: x.result,
    }));
  }

  /**
   * 服务端已收下这批回执 → 从队列移除。
   * 只有在心跳**成功返回**后才调用，否则网络抖动会导致回执静默丢失。
   * @param {Array<string>} ids 已确认的指令 id
   * @returns {void}
   */
  confirm(ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const set = new Set(ids.map(String));
    const before = this.items.length;
    this.items = this.items.filter((x) => !set.has(x.id));
    if (this.items.length !== before) this._flushSync();
  }

  /** @returns {number} 当前待回执条数 */
  size() {
    return this.items.length;
  }

  /**
   * 清空整个回执队列并落盘。
   * 用于「断网超 30 分钟恢复后首心跳清空旧回执」等场景，
   * 避免把离线期间堆积的脏回执误报给服务端。
   * @returns {void}
   */
  clear() {
    this.items = [];
    this._flushSync();
  }
}

module.exports = { AckStore, clampResult, MAX_ITEMS, MAX_AGE_MS, RESULT_MAX_BYTES };
