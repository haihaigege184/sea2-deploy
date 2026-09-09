'use strict';
/**
 * lib/ops/binding.js — 授权码↔机器码绑定纠正（sea2 运维引擎，修 P0-1）
 *
 * 设计依据：system_design_sea2_ops_v1.0.md §3.1 / §7.10
 *
 * 用途：客户换机 / 迁移 / 误绑后，超管（L3）纠正激活码的 bound_machine_id。
 *
 * 铁律（§1.1 sea1 铁律）：
 *  - 只调既有 store.updateCode(code, {bound_machine_id}) + OpsAuditStore.logOp；
 *  - **不改 store.js 本体、不改验签链路**（license 本体/有效期不动，仅改绑定关系）；
 *  - 仅 L3 超管可调（路由层强制校验）。
 */

const auditStore = require('./auditStore');

/**
 * 纠正授权码绑定机器。
 * @param {object} store 激活码主 store
 * @param {string} code 授权码
 * @param {string} machineId 新的机器码
 * @param {string} [operator] 操作人
 * @param {number|string} [operatorLevel] 操作人等级
 * @returns {{ok:boolean, code?:string, before?:object, after?:object, error?:string, statusCode?:number}}
 */
function correctBinding(store, code, machineId, operator, operatorLevel) {
  const c = String(code || '').trim().toUpperCase();
  const mid = String(machineId || '').trim();
  if (!c) return { ok: false, error: '授权码必填', statusCode: 400 };
  if (!mid) return { ok: false, error: 'machineId 必填', statusCode: 400 };
  if (mid.length > 128) return { ok: false, error: 'machineId 超长（最多 128 字符）', statusCode: 400 };
  if (!store) return { ok: false, error: 'store 未注入', statusCode: 500 };

  const rec = store.getCode(c);
  if (!rec) return { ok: false, error: '授权码不存在', statusCode: 404 };

  const before = {
    code: rec.code,
    bound_machine_id: rec.bound_machine_id || '',
    status: rec.status || '',
    updated_at: rec.updated_at || 0,
  };

  store.updateCode(c, { bound_machine_id: mid, binding_corrected_at: Math.floor(Date.now() / 1000) });

  const afterRec = store.getCode(c);
  const after = {
    code: afterRec.code,
    bound_machine_id: afterRec.bound_machine_id || '',
    status: afterRec.status || '',
    binding_corrected_at: afterRec.binding_corrected_at || 0,
  };

  auditStore.logOp({
    operator: operator || 'system', operatorLevel,
    action: 'binding-correct', entity: 'codes', target: c,
    before, after, ok: true,
    detail: `绑定机器 ${before.bound_machine_id || '(空)'} → ${mid}`,
  });

  return { ok: true, code: c, before, after };
}

/**
 * 查询授权码当前绑定信息（换绑前确认，设计 §9.2.2）。
 * 只读：不产生任何写操作 / 审计记录；供「先查后换」向导展示旧设备绑定信息。
 * @param {object} store 激活码主 store
 * @param {string} code 授权码
 * @returns {{code:string, bound_machine_id:string, status:string, expires_at:number, customer:string}|null}
 *   code 不存在（或未注入 store）返回 null；无绑定时 bound_machine_id 为 ''。
 */
function lookupBinding(store, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c || !store) return null;
  const rec = store.getCode(c);
  if (!rec) return null;
  return {
    code: rec.code,
    bound_machine_id: rec.bound_machine_id || '',
    status: rec.status || '',
    expires_at: rec.expires_at || 0,
    customer: rec.customer || '',
  };
}

module.exports = { correctBinding, lookupBinding };
