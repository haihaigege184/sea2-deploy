'use strict';
/**
 * lib/ops/cupsmeta.js — CUPS 驱动识别库（OpsCupsMeta，sea2 运维引擎）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §3.1 / §7.3（Q3：内置型号库 + 在线仓库可配）
 *
 * 职责：
 *  - match(model, uri)：根据机型文本 / 设备 URI 推断推荐驱动，返回 {driver, confidence, alternatives}；
 *  - listDrivers()：内置驱动清单（静态 PPD 数据）。
 *
 * 说明：
 *  - 内置型号库为静态数据（CUPS 自带 PPD 的常见驱动标识），匹配只做字符串/URI 启发式；
 *  - cupsDriverRepo 可配在线仓库（本模块仅回显配置项，不实际联网下载——下载属 T03 客户端能力）。
 */

const fleetConfig = require('../fleetConfig');

/**
 * 内置型号库：pattern（正则源串）→ 驱动。
 * 字段：
 *  - match: 匹配机型文本的正则（忽略大小写）
 *  - uriHint: 匹配 URI 的附加正则（可选，命中可加分）
 *  - driver: 推荐 PPD 驱动标识
 *  - label: 驱动展示名
 *  - confidence: 基础置信度（0~1）
 *  - alternatives: 备选驱动
 */
const DRIVER_DB = [
  {
    match: /EPSON\s*L3150|L3150\s*Series/i,
    uriHint: /usb:\/\/EPSON/i,
    driver: 'epson-inkjet-printer-escpr',
    label: 'Epson ESC/P-R 驱动',
    confidence: 0.95,
    alternatives: ['epson-inkjet-printer-escpr2', 'generic-text-only'],
  },
  {
    match: /EPSON\s*L31(?:0[0-9]|1[0-9]|2[0-9]|3[0-9]|4[0-9]|5[0-9])|EPSON\s*L3[0-9]{3}/i,
    uriHint: /usb:\/\/EPSON/i,
    driver: 'epson-inkjet-printer-escpr',
    label: 'Epson ESC/P-R 驱动（L 系列）',
    confidence: 0.9,
    alternatives: ['epson-inkjet-printer-escpr2', 'generic-text-only'],
  },
  {
    match: /EPSON/i,
    uriHint: /usb:\/\/EPSON/i,
    driver: 'epson-inkjet-printer-escpr',
    label: 'Epson ESC/P-R 驱动（通用）',
    confidence: 0.85,
    alternatives: ['epson-inkjet-printer-escpr2', 'generic-text-only'],
  },
  {
    match: /HP\s*(Deskjet|DeskJet|DJ)/i,
    uriHint: /(usb|socket|ipp):\/\//i,
    driver: 'hp-deskjet_3520_series',
    label: 'HP Deskjet 系列',
    confidence: 0.8,
    alternatives: ['hpijs', 'generic-postscript'],
  },
  {
    match: /HP\s*(LaserJet|LJ)/i,
    uriHint: /(socket|ipp):\/\//i,
    driver: 'hp-laserjet_p2015_series',
    label: 'HP LaserJet 系列',
    confidence: 0.8,
    alternatives: ['hplip', 'generic-postscript'],
  },
  {
    match: /HP/i,
    uriHint: /(usb|socket|ipp):\/\//i,
    driver: 'hpijs',
    label: 'HP 通用（hpijs）',
    confidence: 0.7,
    alternatives: ['generic-postscript', 'generic-text-only'],
  },
  {
    match: /CANON\s*(PIXMA|G[0-9]{4}|TR[0-9]{4}|MG[0-9]{4})/i,
    uriHint: /usb:\/\/CANON/i,
    driver: 'cnijfilter2',
    label: 'Canon PIXMA / G 系列',
    confidence: 0.85,
    alternatives: ['gutenprint', 'generic-postscript'],
  },
  {
    match: /CANON/i,
    uriHint: /usb:\/\/CANON/i,
    driver: 'gutenprint',
    label: 'Canon 通用（gutenprint）',
    confidence: 0.7,
    alternatives: ['generic-postscript', 'generic-text-only'],
  },
  {
    match: /Brother/i,
    uriHint: /(usb|socket):\/\//i,
    driver: 'brother-lpr',
    label: 'Brother 通用（brother-lpr）',
    confidence: 0.75,
    alternatives: ['brother-cups-wrapper', 'generic-postscript'],
  },
  {
    match: /RICOH|理光/i,
    uriHint: /(socket|ipp):\/\//i,
    driver: 'ricoh-pcl6',
    label: 'RICOH PCL6',
    confidence: 0.75,
    alternatives: ['ricoh-ps', 'generic-postscript'],
  },
  {
    match: /SAMSUNG/i,
    uriHint: /(usb|socket):\/\//i,
    driver: 'splix',
    label: 'Samsung 通用（splix）',
    confidence: 0.7,
    alternatives: ['generic-postscript', 'generic-text-only'],
  },
];

/** 兜底驱动（未命中型号时给出低置信度建议，绝不静默返回「无驱动」） */
const FALLBACK_DRIVERS = [
  { driver: 'generic-postscript', label: '通用 PostScript', confidence: 0.3 },
  { driver: 'generic-text-only', label: '通用纯文本', confidence: 0.2 },
];

/**
 * 机型文本 → 推荐驱动。
 * @param {string} model 机型文本（如 "EPSON L3150 Series"）
 * @param {string} [uri] 设备 URI（如 "usb://EPSON/L3150?serial=xxx"）
 * @returns {{driver:string|null, confidence:number, label:string, alternatives:string[]}}
 */
function match(model, uri) {
  const m = String(model || '');
  const u = String(uri || '');
  const candidates = [];

  for (const d of DRIVER_DB) {
    let score = 0;
    if (m && d.match.test(m)) score += 0.6;
    if (u && d.uriHint && d.uriHint.test(u)) score += 0.3;
    if (score > 0) {
      candidates.push({
        driver: d.driver,
        label: d.label,
        confidence: Math.min(1, d.confidence + (score >= 0.9 ? 0.05 : 0)),
        alternatives: d.alternatives.slice(),
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  if (candidates.length === 0) {
    const alt = FALLBACK_DRIVERS.map((f) => f.driver);
    return {
      driver: FALLBACK_DRIVERS[0].driver,
      confidence: FALLBACK_DRIVERS[0].confidence,
      label: FALLBACK_DRIVERS[0].label,
      alternatives: alt.slice(1),
      fallback: true,
    };
  }

  const top = candidates[0];
  const alternatives = [];
  for (const c of candidates.slice(1)) {
    if (alternatives.indexOf(c.driver) < 0 && alternatives.length < 3) alternatives.push(c.driver);
  }
  for (const a of top.alternatives) {
    if (alternatives.indexOf(a) < 0 && alternatives.length < 5) alternatives.push(a);
  }

  return {
    driver: top.driver,
    confidence: Math.round(top.confidence * 100) / 100,
    label: top.label,
    alternatives,
    repo: String(fleetConfig.load().cupsDriverRepo || ''),
  };
}

/**
 * 内置驱动清单。
 * @returns {Array<{driver:string, label:string, confidence:number, alternatives:string[]}>}
 */
function listDrivers() {
  return DRIVER_DB.map((d) => ({
    driver: d.driver,
    label: d.label,
    confidence: d.confidence,
    alternatives: d.alternatives.slice(),
  }));
}

module.exports = { match, listDrivers, DRIVER_DB, FALLBACK_DRIVERS };
