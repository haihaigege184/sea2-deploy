'use strict';
/**
 * public/config-order.js — 配置中心分组排序纯函数（R4/R5）
 *
 * 双端（浏览器 + Node）UMD 风格：
 *  - 浏览器：<script src="/config-order.js"> 后挂到 window.ConfigOrder；
 *  - Node：   require('../public/config-order.js') 返回同名对象（r5-config-order.test.js 使用）。
 *
 * 设计依据（增量系统设计 R4/R5）：
 *  - localStorage['config_group_order'] = JSON.stringify(["服务基础","支付与套餐",...])；
 *  - 拖拽释放写 localStorage 并重渲染；非法/过期条目过滤、缺失分组回退 SCHEMA 顺序。
 *
 * 零新增 npm 依赖、零外部状态：函数式纯函数，便于单测与前端复用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node / CommonJS
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    // AMD（保守支持）
    define([], factory);
  } else {
    // 浏览器全局
    root.ConfigOrder = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 数组去重（保持首次出现顺序） */
  function dedupe(arr) {
    const seen = {};
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v != null && !Object.prototype.hasOwnProperty.call(seen, v)) {
        seen[v] = true;
        out.push(v);
      }
    }
    return out;
  }

  /**
   * 依据用户保存顺序对分组名排序（核心纯函数）。
   *  - saved 中不存在于 groups 的条目过滤（防脏数据）；
   *  - 去重（防重复保存）；
   *  - groups 中未被 saved 覆盖的分组回退到原顺序（缺失回退）。
   *
   * @param {string[]} groups 当前全部可见分组（SCHEMA 顺序，已过滤 hidden）
   * @param {string[]|null|undefined} saved localStorage 解析出的保存顺序（可 null）
   * @returns {string[]} 排序后的分组名数组
   */
  function buildGroupOrder(groups, saved) {
    const base = Array.isArray(groups) ? groups.slice() : [];
    const savedArr = Array.isArray(saved) ? saved : [];
    const seen = {};
    const out = [];
    for (let i = 0; i < savedArr.length; i++) {
      const g = savedArr[i];
      if (base.indexOf(g) >= 0 && !seen[g]) {
        out.push(g);
        seen[g] = true;
      }
    }
    for (let i = 0; i < base.length; i++) {
      const g = base[i];
      if (!seen[g]) {
        out.push(g);
        seen[g] = true;
      }
    }
    return out;
  }

  /**
   * 合并两套顺序（基础顺序 + 用户保存顺序），语义与 buildGroupOrder 相同，
   * 便于前端在「仅重排基础顺序」时复用同一算法；保留为独立函数以满足双轨调用。
   *
   * @param {string[]} baseOrder 基础顺序（如 SCHEMA 分组）
   * @param {string[]|null} savedOrder 用户保存顺序
   * @returns {string[]} 合并去重后的顺序
   */
  function mergeOrder(baseOrder, savedOrder) {
    return buildGroupOrder(baseOrder, savedOrder);
  }

  /**
   * [R6 R2] 相邻交换纯函数：将 arr[idx] 与相邻元素（dir='up' → idx-1；dir='down' → idx+1）交换。
   * 越界 / 非法入参返回原数组副本（不抛错）。
   * @param {string[]} arr 当前顺序
   * @param {number} idx 被移动元素下标
   * @param {'up'|'down'} dir 移动方向
   * @returns {string[]} 新顺序（新数组；越界时与原数组等值）
   */
  function moveInOrder(arr, idx, dir) {
    if (!Array.isArray(arr)) return [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) return arr.slice();
    const target = dir === 'up' ? idx - 1 : dir === 'down' ? idx + 1 : -1;
    if (target < 0 || target >= arr.length) return arr.slice();
    const out = arr.slice();
    const tmp = out[idx];
    out[idx] = out[target];
    out[target] = tmp;
    return out;
  }

  /**
   * 校验并归一化 localStorage 保存值。
   *  - 非数组 / 解析失败 → 返回 null（调用方回退 SCHEMA 顺序）；
   *  - 合法 → 返回仅含 base 中分组的去重数组（可能为空数组）。
   *
   * @param {*} saved 原始 localStorage 值（字符串或已解析值）
   * @param {string[]} base 当前可见分组
   * @returns {string[]|null}
   */
  function validateSaved(saved, base) {
    let arr = saved;
    if (typeof saved === 'string') {
      try { arr = JSON.parse(saved); } catch (e) { return null; }
    }
    if (!Array.isArray(arr)) return null;
    return dedupe(arr.filter((g) => base.indexOf(g) >= 0));
  }

  return {
    buildGroupOrder,
    mergeOrder,
    validateSaved,
    dedupe,
    // [R6 R2] 相邻交换（↑/↓ 编辑排序用）
    moveInOrder,
  };
});
