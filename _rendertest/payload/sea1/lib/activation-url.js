'use strict';

/**
 * lib/activation-url.js — 激活服务地址解析 + 请求发送（scheme 无关，http/https 均兼容）
 * ------------------------------------------------------------------
 * 这是「玩客云客户机收敛 + 激活服务外置」改造的核心模块：
 *   - 客户机（SEA1_ROLE=client）不再本机部署激活服务，激活地址通过可配置项贯通；
 *   - 主服务器（SEA1_ROLE=server）的激活服务仅在 server 部署并保留。
 *
 * 运行时取值优先级（resolveActivationUrl）：
 *   1) process.env.SEA1_ACTIVATION_URL  —— 需符合 ^https?://（自动去尾斜杠；无 scheme / 非法值则拒绝，回落配置或兜底）
 *   2) cfg.activationServer             —— config.json.license.activationServer
 *   3) 内置兜底 'http://127.0.0.1:3457'
 *
 * 传输层使用 Node 18 全局 fetch（非 http.get），http 与 https 皆可，避免 https 下请求失败。
 *
 * @module activation-url
 */

/** 内置兜底激活地址（兜底仅用于极端缺省场景，正常部署会被 config / env 覆盖） */
const FALLBACK_ACTIVATION_URL = 'http://127.0.0.1:3457';

/** 合法激活地址前缀（scheme 必须显式 http/https） */
const SCHEME_RE = /^https?:\/\//i;

/** 默认请求超时（毫秒），与原实现一致 */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 解析激活服务地址。
 *
 * 优先级：env SEA1_ACTIVATION_URL > cfg.activationServer > 内置兜底。
 * 对 env 值做校验：仅当显式带 http/https scheme 才采用（去除尾斜杠）；
 * 无 scheme（如 "10.0.0.11:3457"）或非法值视为无效，「拒绝」并回落到 cfg / 内置兜底。
 * 该「拒绝回落」语义与 install.sh render_sea1_config 的安装期校验保持一致。
 *
 * @param {Object} [cfg] 配置对象。兼容两种形态：
 *   - 含 license 子对象：{ license: { activationServer } }
 *   - 直接含 activationServer：{ activationServer }
 * @returns {string} 规范化后的激活地址（无尾斜杠）
 */
function resolveActivationUrl(cfg) {
  // 1) 进程环境变量优先，但必须显式带 scheme(http/https)；无 scheme / 非法值一律「拒绝」，
  //    回落到配置文件或内置兜底（与 install.sh 渲染期的校验语义保持一致）。
  const envUrl = process.env.SEA1_ACTIVATION_URL;
  if (typeof envUrl === 'string' && envUrl.trim() !== '') {
    const trimmed = envUrl.trim().replace(/\/+$/, '');
    if (SCHEME_RE.test(trimmed)) {
      return trimmed;
    }
    // 无 scheme（如 "10.0.0.11:3457"）视为非法 → 不采用，继续走下方回退链。
  }

  // 2) 配置文件中的激活地址
  let cfgUrl;
  if (cfg && typeof cfg === 'object') {
    cfgUrl = cfg.activationServer || (cfg.license && cfg.license.activationServer);
  }
  if (typeof cfgUrl === 'string' && cfgUrl.trim() !== '') {
    return cfgUrl.trim().replace(/\/+$/, '');
  }

  // 3) 内置兜底
  return FALLBACK_ACTIVATION_URL;
}

/**
 * 向激活服务发送 HTTP 请求（全局 fetch，http/https 均兼容）。
 *
 * 返回契约（与原 vip_core.req / heartbeat 调用方兼容）：
 *   { ok: boolean, status: number, body: any }
 *   - ok     : 响应状态码在 [200,300) 区间
 *   - status : HTTP 状态码（网络错误时为 0）
 *   - body   : 若响应体为合法 JSON 则解析为对象，否则保留原始文本；
 *              网络/解析异常时为 null（错误文本写入 error 字段）
 *
 * @param {string} method     HTTP 方法，如 'GET' | 'POST'
 * @param {string} urlPath    完整请求 URL（调用方已基于 resolveActivationUrl 拼好）
 * @param {Object|string|undefined} [body] 请求体；对象会被 JSON.stringify
 * @param {Object} [opts]     可选：{ headers?: Object, timeoutMs?: number }
 * @returns {Promise<{ok:boolean, status:number, body:any, error?:string}>}
 */
async function requestActivation(method, urlPath, body, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init = {
      method: String(method || 'GET').toUpperCase(),
      headers,
      signal: controller.signal,
    };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(urlPath, init);
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // 非 JSON → 保留原始文本（不影响 ok/status）
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: (e && e.message) ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  FALLBACK_ACTIVATION_URL,
  resolveActivationUrl,
  requestActivation,
};
