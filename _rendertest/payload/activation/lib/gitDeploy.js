'use strict';
/**
 * lib/gitDeploy.js — 本地 git 工作副本：一键部署配置推送（R4，sea2 第 4 批增量）
 *
 * 职责（设计 §R4-P0-4）：
 *  - _ensureRepo()：data/deploy-repo 已存在 → git pull --rebase；否则 git clone --depth 1
 *    私有仓（默认 https://x-access-token:${SEA2_GIT_TOKEN}@github.com/haihaigege184/sea2-client.git）；
 *  - 写 deploy-config.json（原子写 tmp+rename）→ 无变化返回 unchanged:true → 否则
 *    git add/commit -m "deploy config update <ts>" → git push（超时 60s）→ 返回 commit hash；
 *  - 幂等可重跑：内容未变不产生新 commit；
 *  - 凭据铁律：SEA2_GIT_TOKEN 仅从环境变量读取，URL 仅在进程内拼接并作为 git 命令参数传递，
 *    绝不以任何形式落盘（clone 完成后立即用 `git remote set-url` 清除 .git/config 中的带凭据 URL）。
 *
 * 调用方：consoleApi /api/admin/deploy/push-to-git（L2+）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_REMOTE = 'https://github.com/haihaigege184/sea2-client.git';
const DEFAULT_BRANCH = 'main';
const GIT_TIMEOUT_MS = 60 * 1000; // push 超时 60s

function repoDir() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'deploy-repo');
}

function cleanRemote() {
  return process.env.SEA2_GIT_REMOTE || DEFAULT_REMOTE;
}

function authedRemote(token) {
  // 进程内拼接带凭据 URL；仅作 git 命令参数，绝不写盘
  const url = cleanRemote();
  try {
    const u = new URL(url);
    // 仅对 http(s) 远程注入凭据；本地路径/其它协议（file://、Windows 路径等）原样返回
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      u.username = 'x-access-token';
      u.password = token;
      return u.href;
    }
    return url;
  } catch (e) {
    return url;
  }
}

// 需从子进程 env 中清除的代理变量（大小写双份；git 走 -c 显式空代理，env 兜底防残留）
const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];

/**
 * 构造 git 子进程环境：克隆 process.env 后清除全部代理变量。
 * 不改全局 ~/.gitconfig、不改父进程 env；仅影响本次 git 调用。
 * @returns {object} 清理后的 env 对象
 */
function buildGitEnv() {
  const env = Object.assign({}, process.env);
  for (const k of PROXY_ENV_KEYS) delete env[k];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = 'echo';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/**
 * [R6 R3] 单一 choke point：所有 git 调用统一注入 `-c http.proxy= -c https.proxy=`
 * （显式空代理，直连绕过生产 ~/.gitconfig 中可能存在的 7890 代理），并清除子进程 env 代理变量。
 * @param {string[]} args git 参数（会被前置 -c 注入）
 * @param {object} [opts] { timeout, cwd }
 */
function _git(args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    execFile('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...args], {
      timeout: opts.timeout || GIT_TIMEOUT_MS,
      cwd: opts.cwd,
      env: buildGitEnv(),
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = err ? (err.code === undefined ? 1 : err.code) : 0;
      resolve({ ok: code === 0, code, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

/**
 * [R6 R3] 分类 git 失败错误：proxy | credential | network | other。
 * @param {string} stderr git 命令 stderr（可空）
 * @param {number|string} [code] 退出码（可空）
 * @returns {{type:'proxy'|'credential'|'network'|'other', hint:string}}
 */
function classifyGitError(stderr, code) {
  const s = String(stderr || '');
  // 代理：显式提及 proxy/407/tunnel，或「连接 127.0.0.1/localhost 被拒/超时」（典型死代理，如 ~/.gitconfig 7890 未监听）
  const isProxyMention = /proxy|407|tunnel/i.test(s);
  const isLocalConnFail = /(127\.0\.0\.1|localhost).*(refused|timed\s*out|connect|tunnel)/i.test(s) || /(refused|timed\s*out).*(127\.0\.0\.1|localhost)/i.test(s);
  if (isProxyMention || isLocalConnFail) {
    return { type: 'proxy', hint: '检测到代理相关错误：本机 ~/.gitconfig 可能配置了代理（如 7890）；推送已注入 -c http.proxy=/-c https.proxy= 直连，仍失败请检查网络环境' };
  }
  if (/authentication\s*failed|invalid\s*username|invalid\s*password|could\s*not\s*read\s*username|terminal\s*prompts\s*disabled|403|401|access\s*denied|permission\s*denied/i.test(s)) {
    return { type: 'credential', hint: '检测到凭据错误：SEA2_GIT_TOKEN 无效或无权访问该仓库，请检查 token 与仓库权限' };
  }
  if (/could\s*not\s*resolve\s*host|name\s*or\s*service\s*not\s*known|network\s*is\s*unreachable|connection\s*refused|connection\s*timed\s*out|temporary\s*failure|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|getaddrinfo|unable\s*to\s*access/i.test(s)) {
    return { type: 'network', hint: '检测到网络错误：无法连接 git 远程仓库，请检查本机网络/防火墙/远程可达性' };
  }
  if (/failed\s*to\s*push|rejected|non-fast-forward|fetch\s*first/i.test(s)) {
    return { type: 'other', hint: '推送被拒绝：远程可能有他人提交，请先拉取合并（git pull --rebase）后重试' };
  }
  return { type: 'other', hint: '' };
}

/** 给错误信息附上分类提示（有 hint 才追加，避免噪音） */
function withClassifiedHint(error, stderr, code) {
  const c = classifyGitError(stderr, code);
  if (!c.hint) return error;
  return error + '（' + c.hint + '）';
}

function _isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch (e) {
    return false;
  }
}

/**
 * 确保本地工作副本存在且为最新。
 * @param {string} token git 凭据（进程内）
 * @returns {Promise<{ok:boolean, dir:string, remote:string, branch:string, error?:string, code?:number}>}
 * @private
 */
async function _ensureRepo(token) {
  const dir = repoDir();
  const remote = cleanRemote();
  let branch = DEFAULT_BRANCH;

  if (_isGitRepo(dir)) {
    // 已有工作副本：拉取最新（带凭据 URL 仅本次命令参数，不写盘）
    const fetch = await _git(['-c', 'credential.helper=', 'fetch', authedRemote(token), branch], { cwd: dir });
    if (!fetch.ok) {
      return { ok: false, dir, remote, branch, error: 'git fetch 失败: ' + (fetch.stderr || fetch.stdout || '').trim(), code: fetch.code };
    }
    const rebase = await _git(['rebase', 'FETCH_HEAD'], { cwd: dir });
    if (!rebase.ok) {
      // rebase 失败（冲突或工作副本脏）：abort 保持工作副本可用，明确报错
      await _git(['rebase', '--abort'], { cwd: dir });
      const reason = (rebase.stderr || rebase.stdout || '').trim().split('\n')[0] || '未知原因';
      return { ok: false, dir, remote, branch, error: 'git rebase 失败（' + reason + '），请检查 data/deploy-repo 工作副本', code: rebase.code };
    }
    return { ok: true, dir, remote, branch };
  }

  // 全新 clone（--depth 1；带凭据 URL 仅本次命令参数）
  try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch (e) { /* ignore */ }
  const clone = await _git(['clone', '--depth', '1', '--branch', branch, authedRemote(token), dir]);
  if (!clone.ok) {
    return { ok: false, dir, remote, branch, error: 'git clone 失败: ' + (clone.stderr || clone.stdout || '').trim(), code: clone.code };
  }
  // 清除 .git/config 中的带凭据 URL（凭据绝不落盘）
  await _git(['remote', 'set-url', 'origin', remote], { cwd: dir });
  // 确保本地分支名统一为 branch
  const cur = await _git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  if (cur.ok) {
    const curName = String(cur.stdout || '').trim();
    if (curName && curName !== branch) {
      await _git(['checkout', '-B', branch], { cwd: dir });
    } else {
      await _git(['checkout', '-B', branch], { cwd: dir });
    }
  }
  return { ok: true, dir, remote, branch };
}

/**
 * 比较两份 deploy-config.json 内容是否一致（忽略 updatedAt 时间戳）。
 * 幂等判定依据：masterAddress + tunnels（启用）相同即视为无变化，不产生新 commit。
 * @param {string} prevRaw
 * @param {string} nextRaw
 * @returns {boolean}
 */
function _sameContentIgnoreUpdatedAt(prevRaw, nextRaw) {
  try {
    const a = JSON.parse(prevRaw);
    const b = JSON.parse(nextRaw);
    a.updatedAt = '';
    b.updatedAt = '';
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) {
    return String(prevRaw) === String(nextRaw);
  }
}

/**
 * 推送一键部署配置到私有仓。
 * @param {object} payload 仓库内 deploy-config.json 内容（含 masterAddress / tunnels）
 * @returns {Promise<{ok:boolean, commitHash?:string, remote?:string, unchanged?:boolean, error?:string}>}
 */
async function push(payload) {
  const token = String(process.env.SEA2_GIT_TOKEN || '').trim();
  if (!token) {
    return { ok: false, error: 'SEA2_GIT_TOKEN 未注入：无法推送（凭据仅环境变量注入，绝不落盘），请先在部署机配置该环境变量' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload 必填（deployConfig.toRepoPayload() 产物）' };
  }

  const repo = await _ensureRepo(token);
  if (!repo.ok) return { ok: false, error: repo.error };

  const cfgFile = path.join(repo.dir, 'deploy-config.json');
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nextContent = JSON.stringify(Object.assign({}, payload, { updatedAt: ts }), null, 2) + '\n';

  // 无变化（masterAddress/tunnels 相同，忽略 updatedAt）→ unchanged（幂等可重跑）
  let prev = '';
  try { prev = fs.readFileSync(cfgFile, 'utf8'); } catch (e) { prev = ''; }
  if (prev && _sameContentIgnoreUpdatedAt(prev, nextContent)) {
    return { ok: true, unchanged: true, remote: repo.remote };
  }

  // 原子写
  try {
    const tmp = cfgFile + '.tmp';
    fs.writeFileSync(tmp, nextContent);
    fs.renameSync(tmp, cfgFile);
  } catch (e) {
    return { ok: false, error: 'deploy-config.json 写入失败: ' + (e && e.message || e) };
  }

  const add = await _git(['add', 'deploy-config.json'], { cwd: repo.dir });
  if (!add.ok) return { ok: false, error: 'git add 失败: ' + (add.stderr || '').trim() };

  const commitMsg = 'deploy config update ' + ts;
  // 提交身份仅在进程内以 -c 注入（不写全局/本地配置；无 git 身份的部署机也能提交）
  const commit = await _git(['-c', 'user.name=sea2-deploy', '-c', 'user.email=sea2-deploy@localhost', 'commit', '-m', commitMsg], { cwd: repo.dir });
  if (!commit.ok) {
    // 无变更（内容与 HEAD 相同）：视为 unchanged
    if (/nothing to commit|no changes added/i.test(commit.stderr + commit.stdout)) {
      return { ok: true, unchanged: true, remote: repo.remote };
    }
    return { ok: false, error: 'git commit 失败: ' + (commit.stderr || commit.stdout || '').trim() };
  }

  const push = await _git(['-c', 'credential.helper=', 'push', authedRemote(token), 'HEAD:' + repo.branch], { cwd: repo.dir });
  if (!push.ok) {
    // [R6 R3] 推送失败带分类提示（proxy/credential/network/other）
    const rawErr = 'git push 失败: ' + (push.stderr || push.stdout || '').trim();
    return { ok: false, error: withClassifiedHint(rawErr, push.stderr, push.code) };
  }

  const rev = await _git(['rev-parse', 'HEAD'], { cwd: repo.dir });
  const commitHash = rev.ok ? String(rev.stdout || '').trim() : '';
  return { ok: true, commitHash, remote: repo.remote, unchanged: false };
}

module.exports = { push, repoDir, cleanRemote, authedRemote, DEFAULT_REMOTE, GIT_TIMEOUT_MS, classifyGitError, buildGitEnv, PROXY_ENV_KEYS, _git };
