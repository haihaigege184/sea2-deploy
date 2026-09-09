'use strict';
/**
 * lib/botGuard.js — [R9 R2] 防互激发：限频 / 群熔断 / 防互激发 / 自身消息过滤
 *
 * 职责（架构师 R9 设计 T02）：
 *  - 限频：Map<key, ts[]>（key = 群/QQ），3 条 / 5s 超限丢弃（丢回复，不丢主流程）；
 *  - 群熔断：Map<chatId, counts>，10s 内 >20 条 → 触发熔断暂停 60s + 告警标记；
 *  - 防互激发：同文本 5s 内往返 ≥2 次丢弃（防止 botA/botB 互相触发刷屏）；
 *  - 自身消息识别：NapCat 若回环自身消息则忽略（基于自身 QQ 号过滤，双保险：
 *    适配器 shouldProcess 已过滤 self_id===user_id，此处再兜一层 defense-in-depth）。
 *  - 配置热更：setConfig() / getConfig()，生产由 sea.js 定时从 /root/sea2/run/botguard-cfg.json
 *    重读（服务端 fleetConfig 热更 → 运维下发落盘该文件），本地兜底默认值。
 *
 * 零新增 npm 依赖：纯 Map/时间戳。
 */

const DEFAULT_CFG = {
  botRateLimitPer5s: 3,     // 群/QQ 每 5s 最多允许回复条数
  botBurstPer10s: 20,       // 群每 10s 消息条数上限（超过触发熔断）
  botCircuitBreakSec: 60,   // 熔断暂停秒数
  ownQq: '',                // 自身 QQ 号（回环过滤）
  echoWindowMs: 5000,       // 同文本往返窗口
  echoDropAfter: 2,         // 窗口内同文本出现次数 ≥2 → 丢弃
};

/**
 * 创建 botGuard 实例。
 * @param {object} [opts]
 * @param {object} [opts.cfg] 初始配置（键见 DEFAULT_CFG）
 * @param {Function} [opts.getConfig] 可选：每次 shouldSend 前调用的配置读取器（热更）；返回覆盖配置
 * @returns {{
 *   shouldSend(chatId: string, qq: string, text: string): boolean,
 *   state(): object,
 *   reset(): void,
 *   setConfig(cfg: object): void,
 *   circuitBroken(): boolean,
 * }}
 */
function createBotGuard(opts) {
  opts = opts || {};
  const cfg = Object.assign({}, DEFAULT_CFG, opts.cfg || {});

  // key → 发送时间戳数组（限频）
  const rateMap = new Map();
  // chatId → {counts:number[], brokenUntil:number, alertSent:boolean}
  const circuitMap = new Map();
  // textKey → {lastAt:number, count:number}
  const echoMap = new Map();

  const now = () => Date.now();

  function getCfg() {
    if (typeof opts.getConfig === 'function') {
      try {
        const extra = opts.getConfig() || {};
        return Object.assign({}, cfg, extra);
      } catch (e) {
        return cfg;
      }
    }
    return cfg;
  }

  /** 剪掉超出窗口的旧时间戳 */
  function prune(arr, windowMs) {
    const t = now();
    while (arr.length && t - arr[0] > windowMs) arr.shift();
    return arr;
  }

  /**
   * 是否允许发送（插件回复前调用）。
   * @param {string} chatId 群号（私聊可为 ''）
   * @param {string} qq 发送者 QQ（可为 ''）
   * @param {string} text 回复文本
   * @returns {boolean} true=允许发送；false=丢弃
   */
  function shouldSend(chatId, qq, text) {
    const c = getCfg();
    const cid = String(chatId || '');
    const uid = String(qq || '');
    const msg = String(text || '').trim();

    // 1) 自身消息回环过滤（defense-in-depth；适配器已过滤，这里再兜一层）
    if (c.ownQq && uid && uid === String(c.ownQq)) return false;

    // 2) 防互激发：同文本 5s 内往返 ≥2 次 → 丢弃
    if (msg) {
      const ekey = (cid ? 'g:' + cid : 'u:' + uid) + '|' + msg;
      const prev = echoMap.get(ekey);
      const t = now();
      if (prev && t - prev.lastAt <= c.echoWindowMs) {
        prev.count += 1;
        if (prev.count >= c.echoDropAfter) {
          echoMap.delete(ekey); // 丢弃后重置，避免永久锁死该文本
          return false;
        }
        prev.lastAt = t;
      } else {
        echoMap.set(ekey, { lastAt: t, count: 1 });
      }
    }

    // 3) 群熔断：10s 窗口 > burst → 熔断暂停 circuitBreakSec
    if (cid) {
      let g = circuitMap.get(cid);
      if (!g) {
        g = { counts: [], brokenUntil: 0, alertSent: false };
        circuitMap.set(cid, g);
      }
      if (g.brokenUntil > now()) return false; // 熔断中，丢弃
      g.counts.push(now());
      prune(g.counts, 10000);
      if (g.counts.length > c.botBurstPer10s) {
        g.brokenUntil = now() + c.botCircuitBreakSec * 1000;
        g.alertSent = false; // 触发时告警标记复位，state() 可见
        return false;
      }
    }

    // 4) 限频：群/QQ 每 5s 最多 rateLimit 条
    const rkey = cid ? 'g:' + cid : (uid ? 'u:' + uid : 'g:' + cid);
    let arr = rateMap.get(rkey);
    if (!arr) {
      arr = [];
      rateMap.set(rkey, arr);
    }
    prune(arr, 5000);
    if (arr.length >= c.botRateLimitPer5s) return false; // 超限丢弃
    arr.push(now());
    return true;
  }

  /** 是否当前处于群熔断（任一群） */
  function circuitBroken() {
    const t = now();
    for (const g of circuitMap.values()) {
      if (g.brokenUntil > t) return true;
    }
    return false;
  }

  /** 标记某群熔断告警已发送（sea.js 定期扫描后调用，防重复告警） */
  function markAlertSent(chatId) {
    const g = circuitMap.get(String(chatId || ''));
    if (g) g.alertSent = true;
  }

  /** 运行时状态快照（供心跳上报/运维查看） */
  function state() {
    const t = now();
    const circuits = {};
    for (const [cid, g] of circuitMap.entries()) {
      circuits[cid] = {
        broken: g.brokenUntil > t,
        brokenUntil: g.brokenUntil,
        brokenForSec: g.brokenUntil > t ? Math.ceil((g.brokenUntil - t) / 1000) : 0,
        counts10s: prune(g.counts.slice(), 10000).length,
        alertSent: g.alertSent,
      };
    }
    return {
      cfg: getCfg(),
      rateMapSize: rateMap.size,
      circuits,
      circuitBroken: circuitBroken(),
      ts: t,
    };
  }

  /** 清空全部状态（熔断/限频/互激发） */
  function reset() {
    rateMap.clear();
    circuitMap.clear();
    echoMap.clear();
  }

  /** 配置热更（合并覆盖） */
  function setConfig(patch) {
    Object.assign(cfg, patch || {});
  }

  return { shouldSend, state, reset, setConfig, circuitBroken, markAlertSent };
}

module.exports = { createBotGuard, DEFAULT_CFG };
