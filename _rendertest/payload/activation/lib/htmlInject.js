'use strict';
/**
 * lib/htmlInject.js — [R9 R1] 容器管理 HTML 自动登录注入（白名单校验 + 注入脚本构造）
 *
 * 职责（架构师 R9 设计 T01）：
 *  - validateToken(tok)：hex/base64 白名单正则 `^[A-Za-z0-9+/=_-]+$`，长度 ≤4096；
 *    校验通过才允许写入 HTML（防 HTML/JS 注入逃逸）。
 *  - buildInjectScript(token)：返回内联
 *      `<script>window.__DOCKER_MGR_TOKEN__="..."</script>`
 *    并附带自动登录逻辑：
 *      1) localStorage 无 token → 读 window.__DOCKER_MGR_TOKEN__ → 写入 localStorage('token')
 *         → 打 TTL 标记（5 分钟，防死循环）→ reload 一次；
 *      2) localStorage 已有 token（用户手动登录过）→ 不动，静默返回；
 *      3) 写入失败 / 注入缺失（token 为空）→ 显示登录异常提示 + 保留手动登录入口。
 *  - injectIntoHtml(html, token)：在 `</head>` 前插入脚本（仅当 token 合法且存在 `</head>`）。
 *
 * 安全约束：
 *  - token 只允许 [A-Za-z0-9+/=_-]（JWT/base64url/hex 均覆盖），杜绝 `"` `\` `<` 等逃逸字符；
 *  - 脚本内 token 经 JSON.stringify 转义，二次防逃逸；
 *  - 不落日志（调用方负责不在日志打印 token）。
 *
 * 零新增 npm 依赖：纯字符串/正则。
 */

/**
 * token 白名单校验：hex/base64/base64url/JWT 安全字符集，长度上限防放大。
 * 设计原文正则 `^[A-Za-z0-9+/=_-]+$`；实测 FastOSDocker 预登录 token 为 JWT（含 `.` 分隔符），
 * 若严格拒绝 `.` 将导致真实 token 无法注入（R1 失效）。`.` 在 HTML/JS 字符串上下文无法逃逸，
 * 属安全字符，故在保持白名单防逃逸意图的前提下扩展允许 `.`（实现偏离，已记录）。
 */
function validateToken(tok) {
  if (typeof tok !== 'string' || tok.length === 0) return false;
  if (tok.length > 4096) return false;
  return /^[A-Za-z0-9+/=_.-]+$/.test(tok);
}

/**
 * 构造注入脚本（内联 <script>）。
 * token 非法 → 返回 ''（调用方安全跳过，不注入）。
 * 返回的脚本同时写入 window.__DOCKER_MGR_TOKEN__ 并执行自动登录逻辑。
 * @param {string} token 服务端内存预登录 SESSION.token
 * @returns {string} 内联 script 片段；token 非法返回 ''
 */
function buildInjectScript(token) {
  if (!validateToken(token)) return '';
  const tokJson = JSON.stringify(token); // 双引号包裹 + 转义（token 已白名单，实际无转义字符）
  const script =
    '<script>(function(){try{' +
    'var K="__sea2_dm_done",T="token",TTL=5*60*1000,now=Date.now();' +
    'window.__DOCKER_MGR_TOKEN__=' + tokJson + ';' +
    'function markDone(){try{localStorage.setItem(K,String(Date.now()));}catch(e){}}' +
    'function showAnomaly(){try{' +
    'if(document.getElementById("__sea2_dm_anomaly"))return;' +
    'function render(){' +
    'if(document.getElementById("__sea2_dm_anomaly"))return;' +
    'var b=document.createElement("div");b.id="__sea2_dm_anomaly";' +
    'b.style.cssText="position:fixed;left:12px;bottom:12px;z-index:99999;max-width:340px;padding:10px 14px;border-radius:10px;background:#fff7e6;border:1px solid #ffd591;color:#ad6800;font-size:13px;line-height:1.6;box-shadow:0 4px 16px rgba(0,0,0,.18);font-family:-apple-system,Segoe UI,sans-serif";' +
    'b.innerHTML="<b>自动登录异常</b><br>无法自动写入登录凭据，请在下方登录框手动输入账号密码登录，或刷新页面重试。";' +
    '(document.body||document.documentElement).appendChild(b);}' +
    'if(document.body)render();else document.addEventListener("DOMContentLoaded",render);' + // [ENG-8] body 未解析时等 DOMContentLoaded
    '}catch(e){}}' +
    'try{var done=localStorage.getItem(K);' +
    'if(done){var dt=parseInt(done,10);if(!isNaN(dt)&&now-dt<TTL)return;}' +
    'var tok=window.__DOCKER_MGR_TOKEN__;' +
    'if(!tok){showAnomaly();return;}' +
    'var cur=localStorage.getItem(T);' +
    'if(cur&&cur===tok){markDone();return;}' +
    'if(cur){markDone();return;}' +          // 已有其他 token（手动登录）：不动，静默
    'localStorage.setItem(T,tok);markDone();location.reload();' +
    '}catch(e){showAnomaly();}' +
    '}catch(e){}})();</script>';
  return script;
}

/**
 * 向 HTML 文本中注入自动登录脚本（`</head>` 前）。
 *  - html 非字符串 / token 非法 / 无 `</head>` → 原样返回（安全降级）。
 * @param {string} html 上游响应体（utf8 文本）
 * @param {string} token 预登录 token
 * @returns {string} 注入后的 HTML
 */
function injectIntoHtml(html, token) {
  if (typeof html !== 'string') return html;
  const script = buildInjectScript(token);
  if (!script) return html;
  const idx = html.toLowerCase().lastIndexOf('</head>');
  if (idx < 0) return html;
  return html.slice(0, idx) + script + html.slice(idx);
}

module.exports = {
  validateToken,
  buildInjectScript,
  injectIntoHtml,
};
