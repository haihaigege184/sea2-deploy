'use strict';

/**
 * lib/fleetReason.js —— 授权 reason 语义映射表（Single Source of Truth）
 *
 * 设计依据：system_design_fleet_ops_v1.0.md §7.2
 *
 * 心跳端点产出的 `reason` 是**原始机器可读值**（如 `machine-mismatch`），
 * 本表负责把它映射为三样东西：
 *   1. `licenseState` —— 正交状态模型中的授权维度（与 connectivity 互不干扰）；
 *   2. `label` / `badge` —— 控制台徽标文案与配色；
 *   3. `advice` —— 运维处置建议（前端零硬编码，全部随 `/fleet/meta` 与详情接口下发）。
 *
 * 铁律：任何未收录的 reason **一律不吞掉**，fallback 为 invalid + 「授权异常」，
 *       并把 raw reason 原样透出到 UI 悬浮，避免出现"看不出为什么"的黑洞。
 */

/** licenseState 枚举（唯一权威，见设计 §7.1） */
const LICENSE_STATE = ['valid', 'invalid', 'expired', 'mismatch', 'revoked', 'no-record', 'unknown'];

/**
 * licenseState -> 展示语义。
 * 与 REASON_MAP 分层：REASON_MAP 描述「为什么」（细粒度 reason），
 * 本表描述「是什么」（粗粒度授权态），前端筛选下拉与徽标配色直接用本表，
 * 不再在 JS 里硬编码中文与颜色。badge 取值同 REASON_MAP。
 * @type {Array<{key: string, label: string, badge: string}>}
 */
const LICENSE_STATE_META = [
  { key: 'valid', label: '有效', badge: 'ok' },
  { key: 'invalid', label: '无效', badge: 'bad' },
  { key: 'expired', label: '已过期', badge: 'warn' },
  { key: 'mismatch', label: '机器码不符', badge: 'warn' },
  { key: 'revoked', label: '已吊销', badge: 'bad' },
  { key: 'no-record', label: '无授权记录', badge: 'warn' },
  { key: 'unknown', label: '未知', badge: 'unknown' },
];

/**
 * reason -> 描述。
 * badge 取值：ok(绿) / warn(橙) / bad(红) / black(黑) / unknown(灰)
 * @type {Object<string, {licenseState: string, label: string, badge: string, advice: string}>}
 */
const REASON_MAP = {
  ok: {
    licenseState: 'valid',
    label: '已授权',
    badge: 'ok',
    advice: '',
  },
  'code-not-found': {
    licenseState: 'no-record',
    label: '授权码不存在',
    badge: 'warn',
    advice: '服务端 codes 表无此授权码。请核对客户端 config.json 的 activationServer 是否指向本服务器，或该授权码是否在本服务器激活过。',
  },
  'license-not-issued': {
    licenseState: 'no-record',
    label: '未签发许可',
    badge: 'warn',
    advice: '授权码存在但服务端未保存 license 记录。请在「订单/授权」页对该授权码重新签发一次。',
  },
  // legacy 别名：旧数据里可能残留，服务端不再产生
  'no-record': {
    licenseState: 'no-record',
    label: '无授权记录',
    badge: 'warn',
    advice: '旧版兼容值。请检查授权码是否存在于本服务器，以及是否已签发 license。',
  },
  revoked: {
    licenseState: 'revoked',
    label: '已吊销',
    badge: 'bad',
    advice: '运维主动吊销。若为误操作，用「服务开关 ▸ 启用客户端」对称恢复（沿用原到期时间，不重新签发）。',
  },
  expired: {
    licenseState: 'expired',
    label: '已过期',
    badge: 'warn',
    advice: '授权到期。续费后在「订单/授权」页重新签发 license。',
  },
  'machine-mismatch': {
    licenseState: 'mismatch',
    label: '机器码不匹配',
    badge: 'warn',
    advice: '心跳上报的机器码与授权绑定的机器码不符（换机 / 搬迁 / 篡改）。核实后走解绑重新激活，或为该设备签发独立授权码。',
  },
  blacklisted: {
    licenseState: 'unknown',
    label: '已拉黑',
    badge: 'black',
    advice: '设备已拉黑，服务端不再进行授权校验。如需恢复请先将其移出黑名单。',
  },
  'bad-signature': {
    licenseState: 'invalid',
    label: '签名无效',
    badge: 'bad',
    advice: '服务端 keys.json 可能已轮换，license 与当前公钥不匹配，需重新签发。',
  },
  empty: {
    licenseState: 'invalid',
    label: '许可证为空',
    badge: 'bad',
    advice: 'license 内容为空，结构已损坏，请重新签发。',
  },
  'not-yet-valid': {
    licenseState: 'invalid',
    label: '许可证未生效',
    badge: 'bad',
    advice: 'license 生效时间晚于当前时间。请检查服务端与设备时钟，必要时重新签发。',
  },
  network: {
    licenseState: 'unknown',
    label: '网络异常',
    badge: 'unknown',
    advice: '客户端本地网络异常导致校验未完成。此值仅由客户端产生，服务端不会写入。',
  },
  unknown: {
    licenseState: 'unknown',
    label: '未知',
    badge: 'unknown',
    advice: '设备尚未上报心跳，或服务端未完成过一次授权校验。',
  },
  // —— sea2 商用运维：格式化（format_device）相关 reason（设计 §3.4 / 任务 T01）——
  // 注意：以下 reason 不是授权校验结果，而是高危操作的状态语义，统一映射到 licenseState 'unknown'
  // （不污染授权七态），随 meta.reasons 下发供前端高危专区展示。
  'format-pending': {
    licenseState: 'unknown',
    label: '格式化待确认',
    badge: 'warn',
    advice: '格式化指令已签发，等待设备本地倒计时 + 二次确认。',
  },
  'format-done': {
    licenseState: 'unknown',
    label: '格式化已完成',
    badge: 'ok',
    advice: '设备已完成格式化并回传成功结果。',
  },
  'format-rejected': {
    licenseState: 'unknown',
    label: '格式化已拒绝',
    badge: 'unknown',
    advice: '设备本地拒绝了格式化（本地确认未通过或已取消），未执行任何擦除。',
  },
  'format-failed': {
    licenseState: 'unknown',
    label: '格式化执行失败',
    badge: 'bad',
    advice: '设备执行格式化时出错，请结合 result 排查（权限/介质/磁盘占用等）。',
  },
  // —— sea2 商用运维：试用设备（trial）相关 reason（设计 §9.4）——
  // 注意：以下 reason 不是授权校验结果，而是「试用模式」的状态语义。
  // 试用设备心跳 code='' + trial:true，无正式授权码，统一映射 licenseState 'unknown'
  // （不污染授权七态），以独立 isTrial 布尔表达；前端用 trialBadge 徽标展示。
  'trial-active': {
    licenseState: 'unknown',
    label: '试用中',
    badge: 'warn',
    advice: '设备处于试用期，未绑定正式授权码。到期后需购买并激活。',
  },
  'trial-expired': {
    licenseState: 'unknown',
    label: '试用已到期',
    badge: 'warn',
    advice: '试用已结束，请为设备签发正式授权。',
  },
};

/** 未收录 reason 的兜底描述模板 */
const FALLBACK = {
  licenseState: 'invalid',
  label: '授权异常',
  badge: 'bad',
  advice: '出现未收录的校验结果，请结合原始 reason 排查（可能为新版客户端或 license 结构变更）。',
};

/** `missing:<key>` 形态的动态 reason 前缀（来自 lib/license.js:verifyLicenseObject） */
const MISSING_PREFIX = 'missing:';

/**
 * 归一化 reason：去空白，空值视为 unknown。
 * @param {string} reason 原始 reason
 * @returns {string}
 */
function normalize(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  return text || 'unknown';
}

/**
 * 描述一个 reason。
 * @param {string} reason 原始 reason（可为空 / 可为 `missing:<key>`）
 * @returns {{reason: string, licenseState: string, label: string, badge: string, advice: string}}
 */
function describe(reason) {
  const raw = normalize(reason);

  const hit = REASON_MAP[raw];
  if (hit) return { reason: raw, ...hit };

  // 动态 reason：missing:<key>
  if (raw.indexOf(MISSING_PREFIX) === 0) {
    const key = raw.slice(MISSING_PREFIX.length) || '未知字段';
    return {
      reason: raw,
      licenseState: 'invalid',
      label: '许可证字段缺失',
      badge: 'bad',
      advice: `license 缺少必要字段「${key}」，结构已损坏，请重新签发。`,
    };
  }

  // 永不吞掉未知值
  return { reason: raw, ...FALLBACK };
}

/**
 * reason -> licenseState。
 * @param {string} reason 原始 reason
 * @returns {string} licenseState 枚举值之一
 */
function toLicenseState(reason) {
  return describe(reason).licenseState;
}

/**
 * 输出全表，供 `GET /fleet/meta` 下发给前端（前端零硬编码）。
 * 动态 reason（missing:<key>）不在列表内，由前端 fallback 到 raw 展示。
 * @returns {Array<{reason: string, licenseState: string, label: string, badge: string, advice: string}>}
 */
function list() {
  return Object.keys(REASON_MAP).map((reason) => ({ reason, ...REASON_MAP[reason] }));
}

/**
 * 输出 licenseState 展示语义表（含兜底：枚举里有但表里漏配的一律给 unknown 徽标）。
 * @returns {Array<{key: string, label: string, badge: string}>}
 */
function listLicenseStates() {
  return LICENSE_STATE.map((key) => {
    const hit = LICENSE_STATE_META.find((m) => m.key === key);
    return hit ? { ...hit } : { key, label: key, badge: 'unknown' };
  });
}

module.exports = {
  LICENSE_STATE,
  LICENSE_STATE_META,
  REASON_MAP,
  FALLBACK,
  describe,
  toLicenseState,
  list,
  listLicenseStates,
};
