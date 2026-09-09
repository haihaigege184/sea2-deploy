'use strict';
/**
 * lib/console/printers.js — CUPS 集成（child_process 直调同机 CUPS 命令）
 *
 * 安全：所有外部输入（name / deviceUri）经白名单校验；命令经 spawnSync 数组参数执行
 * （不经过 shell），从根本上杜绝命令注入。name 仅允许 [A-Za-z0-9_-]；deviceUri 仅允许
 * http/https/ipp/ipps/socket/lpd/usb/dnssd/mdns/smb/cifs 等安全 scheme。
 */

const child_process = require('node:child_process');

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const URI_RE = /^(https?|ipps?|socket|lpd|usb|dnssd|mdns|smb|cifs):/i;

/**
 * [SEA2 运维] 打印机档案扩展字段（型号/驱动/URI/队列）
 * 由 lib/ops/crud.js 的 printers 实体读写，持久化于 data/printer-profiles.json（DATA_DIR 内）。
 */
const PROFILE_FIELDS = ['model', 'driver', 'uri', 'queue'];

/**
 * [SEA2 运维] 把档案扩展字段合并进打印机列表项（CRUD 引擎 / 前端展示用）。
 * @param {Array<object>} items printers.list 输出的 printers[]
 * @param {object} profiles { name: profile } 档案表
 * @returns {Array<object>}
 */
function extendWithProfiles(items, profiles) {
  profiles = profiles || {};
  return (items || []).map((item) => {
    const p = profiles[item.name] || {};
    return Object.assign({}, item, {
      model: p.model || '',
      driver: p.driver || '',
      uri: p.uri || item.device || '',
      queue: p.queue || '',
      profileDeleted: p.deleted === true,
      profileUpdatedAt: p.updatedAt || 0,
    });
  });
}

/**
 * 同步执行命令（数组参数，不经过 shell）。返回 { ok, stdout, stderr, code }。
 */
function exec(cmd, args) {
  try {
    const out = child_process.spawnSync(cmd, args || [], { encoding: 'utf8', timeout: 8000 });
    if (out.error) return { ok: false, error: String(out.error.message || out.error) };
    return { ok: true, stdout: out.stdout || '', stderr: out.stderr || '', code: out.status };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function list() {
  try {
    const a = exec('lpstat', ['-a']);
    const p = exec('lpstat', ['-p']);
    const d = exec('lpstat', ['-d']);

    const accepting = new Map();
    if (a.ok) {
      (a.stdout || '').split(/\r?\n/).forEach((line) => {
        const m = line.match(/^(\S+)\s+accepting\s+(\w+)/);
        if (m) accepting.set(m[1], m[2] === 'enabled');
      });
    }
    const states = new Map();
    if (p.ok) {
      (p.stdout || '').split(/\r?\n/).forEach((line) => {
        const m = line.match(/^printer\s+(\S+)\s+(is idle|disabled|now printing|paused|unknown)/i)
          || line.match(/^printer\s+(\S+)\s+(.+)$/);
        if (m) {
          const name = m[1];
          const rest = (m[2] || '').toLowerCase();
          const enabled = !/(disabled|paused|stopped)/.test(rest);
          const state = rest.indexOf('printing') >= 0 ? 'printing' : (enabled ? 'idle' : 'stopped');
          states.set(name, { enabled, state });
        }
      });
    }

    const names = new Set([...accepting.keys(), ...states.keys()]);
    let isDefault = '';
    if (d.ok) {
      const m = (d.stdout || '').match(/destination:?\s+(\S+)/i);
      if (m) isDefault = m[1];
    }

    const printers = [];
    for (const name of names) {
      const acc = accepting.has(name) ? accepting.get(name) : true;
      const st = states.get(name) || { enabled: true, state: 'unknown' };
      printers.push({ name, accepting: acc, enabled: st.enabled, state: st.state, device: '', isDefault: name === isDefault });
    }
    const cupsRunning = a.ok || p.ok;
    return { ok: true, printers, cupsRunning };
  } catch (e) {
    return { ok: true, printers: [], cupsRunning: false, error: String(e && e.message || e) };
  }
}

function add(name, deviceUri) {
  if (!NAME_RE.test(name)) return { ok: false, error: '打印机名称非法（仅允许字母数字 _ -）', status: 400 };
  if (!URI_RE.test(deviceUri)) return { ok: false, error: '设备 URI 非法（scheme 须为 http/ipp/socket/lpd/usb 等安全协议）', status: 400 };
  const r = exec('lpadmin', ['-p', name, '-E', '-v', deviceUri]);
  if (!r.ok) return { ok: false, error: r.error, status: 500 };
  if (r.code !== 0) return { ok: false, error: '添加失败: ' + (r.stderr || r.stdout || 'unknown'), status: 500 };
  return { ok: true, name };
}

function remove(name) {
  if (!NAME_RE.test(name)) return { ok: false, error: '打印机名称非法', status: 400 };
  const r = exec('lpadmin', ['-x', name]);
  if (!r.ok) return { ok: false, error: r.error, status: 500 };
  return { ok: true, name };
}

function enable(name) {
  if (!NAME_RE.test(name)) return { ok: false, error: '打印机名称非法', status: 400 };
  const r = exec('cupsenable', [name]);
  if (!r.ok) return { ok: false, error: r.error, status: 500 };
  return { ok: true, name, action: 'enable' };
}

function disable(name) {
  if (!NAME_RE.test(name)) return { ok: false, error: '打印机名称非法', status: 400 };
  const r = exec('cupsdisable', [name]);
  if (!r.ok) return { ok: false, error: r.error, status: 500 };
  return { ok: true, name, action: 'disable' };
}

function setDefault(name) {
  if (!NAME_RE.test(name)) return { ok: false, error: '打印机名称非法', status: 400 };
  const r = exec('lpadmin', ['-d', name]);
  if (!r.ok) return { ok: false, error: r.error, status: 500 };
  return { ok: true, name, action: 'default' };
}

function test(name) {
  if (!NAME_RE.test(name)) return { ok: false, error: '打印机名称非法', status: 400 };
  const r = exec('lp', ['-d', name, '-o', 'fit-to-page', '/dev/null']);
  if (!r.ok) return { ok: false, error: r.error, status: 500 };
  return { ok: true, name, action: 'test' };
}

function printerAction(name, action) {
  switch (action) {
    case 'enable': return enable(name);
    case 'disable': return disable(name);
    case 'default': return setDefault(name);
    case 'delete': return remove(name);
    case 'test': return test(name);
    default: return { ok: false, error: '未知操作: ' + action, status: 400 };
  }
}

module.exports = { list, add, remove, enable, disable, setDefault, test, printerAction, PROFILE_FIELDS, extendWithProfiles };
