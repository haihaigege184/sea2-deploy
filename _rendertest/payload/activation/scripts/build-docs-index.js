'use strict';
/**
 * scripts/build-docs-index.js — 帮助中心文档索引生成脚本（零依赖）
 *
 * 职责（设计：HELP_CENTER_SYSTEM_DESIGN.md §3.1/§3.3）：
 *  - 扫描 sea1/sea2 两份说明书 MD → 产出 docs/docs-index.json（含 version/generatedAt/docs/synonyms/entries）
 *  - 锚点规则：anchor = doc + "-c" + chapterNo + "-" + slug(chapterTitle) + "-" + slug(sectionTitle)
 *      （章节级条目 anchor = doc + "-c" + chapterNo + "-" + slug(chapterTitle)）
 *  - slug = 去空白/标点、保留中文与字母数字、截断 48；同 (doc,chapter,title) 冲突追加 -2/-3
 *  - entry 粒度：### 节为最小检索单元；#### 小节并入所属 ### 的 keywords；## 章生成章节级条目
 *  - 构建期把同义词并入 entry.keywords（免运行时重复计算），同义词表写入索引
 *  - 幂等可重跑：两次运行 entries 完全一致（generatedAt 除外）
 *
 * 用法：node scripts/build-docs-index.js
 * 输出：sea2-server/docs/docs-index.json（构建产物，勿手改）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---- 文档路径（sea1 侧零改动：只读 sea1/docs 下的说明书；sea2 侧在 sea2-server/docs/） ----
const SEA1_DOC = path.join(__dirname, '..', '..', 'sea1', 'docs', '说明书_sea1_新手运维指南.md');
const SEA2_DOC = path.join(__dirname, '..', 'docs', '说明书_sea2_新手运维指南.md');
const OUT_INDEX = path.join(__dirname, '..', 'docs', 'docs-index.json');
// /docs/* 仅服务 sea2-server/docs/；sea1 说明书需同步一份到服务根（sea1 源码零改动）
const SEA1_DOC_COPY = path.join(__dirname, '..', 'docs', '说明书_sea1_新手运维指南.md');

/** 同义词表（单一事实来源：构建期并入 entry.keywords + 写入索引供前端运行时扩展） */
const SYNONYMS = {
  授权: ['激活', '许可', 'license', 'vip', '会员', '试用'],
  token: ['令牌', '密钥'],
  部署: ['安装', 'install', 'deploy'],
  集群: ['cluster'],
  设备: ['客户端', 'client'],
  打印: ['printer'],
  推送: ['push', 'git'],
  白名单: ['确认词', '门禁'],
  穿透: ['tunnel'],
  报错: ['错误', '异常', 'error'],
  订单: ['order'],
  审计: ['日志', 'audit'],
  配置: ['config', '设置'],
  容器: ['docker'],
  心跳: ['在线', 'heartbeat'],
  重启: ['restart', 'pm2'],
  激活: ['授权', '许可', 'license', 'vip', '会员', '试用'],
  令牌: ['token', '密钥'],
  安装: ['部署', 'install', 'deploy'],
  客户端: ['设备', 'client'],
  密钥: ['token', '令牌'],
  门禁: ['白名单', '确认词'],
  日志: ['审计', 'audit'],
  设置: ['配置', 'config'],
  会员: ['授权', '激活', 'vip', 'license'],
  试用: ['授权', '激活', '会员'],
};

/** 常见英文词（中文正文分词用 stopword，避免索引爆炸） */
const STOP_EN = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'than', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'you', 'your', 'its', 'his', 'her', 'they', 'them', 'will',
  'can', 'all', 'any', 'one', 'two', 'per', 'via', 'use', 'used', 'using', 'set', 'get', 'run',
]);

/** 常见非配置键的 UPPER 词（避免把 PORT 等无关大写误当 configKey）——按需过滤 */
const NON_CONFIG_UPPER = new Set([
  'HTTP', 'HTTPS', 'JSON', 'HTML', 'CSS', 'JS', 'API', 'URL', 'URI', 'IP', 'TCP', 'UDP', 'WS',
  'WSS', 'SSH', 'QQ', 'ID', 'DB', 'SQL', 'CPU', 'RAM', 'PEM', 'RSA', 'AES', 'TOTP', 'MIME',
  'PNG', 'JPG', 'JPEG', 'SVG', 'GIF', 'WEBP', 'PDF', 'CSV', 'XML', 'YAML', 'TOML', 'ENV',
  'UI', 'UX', 'L3', 'L2', 'L1', 'L0', 'N4', 'R4', 'R5', 'R6', 'T1', 'T2', 'T04', 'T05',
  'MD', 'README', 'FAQ', 'OK', 'NO', 'YES', 'FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG',
]);

/**
 * slug：去空白/标点，保留中文/字母/数字，截断 48
 * @param {string} s
 * @returns {string}
 */
function slugify(s) {
  const cleaned = String(s || '')
    .replace(/[\s\p{P}\p{S}]+/gu, '') // 空白 + 标点 + 符号（含中英文标点、emoji）
    .slice(0, 48);
  return cleaned || 'x';
}

/** 提取中文/英文/数字词元（2-gram 中文 + 英文单词 + 纯数字串如端口号） */
function tokenize(text) {
  const out = [];
  const str = String(text || '').toLowerCase();
  // 英文/数字词元：首字符可为字母或数字，纯数字串（端口号等）不被丢弃
  const enRe = /[a-z0-9][a-z0-9._-]{1,}/g;
  let m;
  while ((m = enRe.exec(str)) !== null) {
    const w = m[0];
    if (!STOP_EN.has(w)) out.push(w);
  }
  // 中文 2-gram
  const zhRe = /[\u4e00-\u9fa5]+/g;
  while ((m = zhRe.exec(str)) !== null) {
    const seg = m[0];
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
  }
  // 去重保序
  return [...new Set(out)];
}

/** 把同义词并入关键词：命中任一同义词组即整组并入 */
function mergeSynonyms(keywords) {
  const set = new Set(keywords);
  for (const [key, group] of Object.entries(SYNONYMS)) {
    const hitKey = set.has(key);
    const hitGroup = group.some((g) => set.has(g));
    if (hitKey || hitGroup) {
      set.add(key);
      group.forEach((g) => set.add(g));
    }
  }
  return [...set];
}

/**
 * 从一段文本提取命令 / API / 配置键
 * @returns {{commands:string[], apis:string[], configKeys:string[]}}
 */
function extractCodeMeta(text) {
  const commands = new Set();
  const apis = new Set();
  const configKeys = new Set();
  const str = String(text || '');
  // API：/api/ 或 /admin/ 前缀路径
  const apiRe = /(?:\/api\/[A-Za-z0-9_\-/{}.:?=&]*|\/admin\/[A-Za-z0-9_\-/{}.:?=&]*)/g;
  let m;
  while ((m = apiRe.exec(str)) !== null) {
    const api = m[0].replace(/[.,;:)\]}>]+$/, '');
    if (api.length >= 5) apis.add(api);
  }
  // 行内命令 / 代码块中的命令：以常见命令动词开头
  const cmdRe = /(?:^|\n)\s*((?:pm2|node|npm|npx|bash|sudo|systemctl|git|curl|cd|ls|cat|tail|grep|mkdir|cp|mv|rm|chmod|chown|docker|docker-compose|ssh|scp|echo|export|source|\.\/|python3?|psql|mysql|systemd|journalctl|df|du|free|top|htop|kill|killall|ps -ef|netstat|ss -t|ip addr|ifconfig|tar|unzip|zip|wget|vi|vim|nano|env|printenv|uptime|date|hostname|whoami|id|sed|awk|tee|rsync|apt|yum|dnf|apk|pacman)[^\n]{1,200})/g;
  while ((m = cmdRe.exec(str)) !== null) {
    const cmd = m[1].trim().replace(/[;|&][^\n]*$/, '').trim(); // 去掉尾随管道
    if (cmd.length >= 4 && cmd.length <= 180) commands.add(cmd);
  }
  // 配置键：config.env 风格 UPPER_SNAKE（如 ADMIN_TOKEN / DATA_DIR / FLEET_HB_INTERVAL）
  const keyRe = /\b([A-Z][A-Z0-9_]{2,})\b/g;
  while ((m = keyRe.exec(str)) !== null) {
    const k = m[1];
    if (NON_CONFIG_UPPER.has(k)) continue;
    // 常见误报：紧跟 '：' 或 中文文本中的英文缩写（如 PORT 单独出现视为配置键）
    const prev = str.slice(Math.max(0, m.index - 8), m.index);
    const next = str.slice(m.index + k.length, m.index + k.length + 8);
    if (/^[：:：]/.test(next) && !/^[：:]\s*$/.test(prev)) {
      // 例如「PORT：」中文冒号前为键——保留
    }
    configKeys.add(k);
  }
  return { commands: [...commands].slice(0, 20), apis: [...apis].slice(0, 20), configKeys: [...configKeys].slice(0, 12) };
}

/** 行内代码片段提取（供 keywords 补充） */
function inlineCodeSpans(text) {
  const out = [];
  const re = /`([^`\n]{1,80})`/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * 解析单份 MD → 章节/条目
 * @param {string} raw MD 原文
 * @param {string} doc doc 标识（sea1/sea2）
 * @returns {{title:string, chapters:Array, entries:Array}}
 */
function parseDoc(raw, doc) {
  const lines = raw.split(/\r?\n/);
  const chapters = [];   // 目录树章节级
  const entries = [];    // 检索条目（章节级 + 节级）
  const anchorUsed = new Map(); // anchor -> count（冲突 -2/-3）
  let docTitle = '';
  let curChapter = null; // {no,label,title,anchor,text}
  let curSection = null; // {title,anchor,text,keywords,commands,apis,configKeys}
  let curSubLevel = 0;

  function allocAnchor(anchor) {
    const n = (anchorUsed.get(anchor) || 0) + 1;
    anchorUsed.set(anchor, n);
    return n > 1 ? `${anchor}-${n}` : anchor;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      if (level === 1) {
        docTitle = title;
        continue;
      }
      if (level === 2) {
        // 章：序号从标题提取（如 01-项目概览 → 1）
        const noMatch = /^(\d{1,2})[\s\-_、.：:]*/.exec(title);
        const no = noMatch ? parseInt(noMatch[1], 10) : (chapters.length + 1);
        const label = title;
        const cleanTitle = title.replace(/^\d{1,2}[\s\-_、.：:]*/, '');
        const anchor = allocAnchor(`${doc}-c${String(no).padStart(2, '0')}-${slugify(cleanTitle)}`);
        if (curSection && curChapter) flushSection();
        curChapter = { no, label, title: cleanTitle, anchor, text: '', sections: [] };
        chapters.push(curChapter);
        curSection = null;
        curSubLevel = 0;
        continue;
      }
      if (level === 3) {
        // 节：FAQ 用 ### Q：/### A： 标题对——Q 开新条目，A 并入所属 Q（同一 FAQ 条目）
        const isA = /^A[：:]/.test(title);
        if (isA && curSection && curSection.faq) {
          // A 标题归入所属 Q 条目，不另立条目（FAQ 计数 = Q 条目数）
          curSection.text += '> ' + title + '\n';
          curSubLevel = 3;
          continue;
        }
        if (curSection && curChapter) flushSection();
        const anchor = allocAnchor(`${doc}-c${String(curChapter ? curChapter.no : 0).padStart(2, '0')}-${slugify(curChapter ? curChapter.title : '')}-${slugify(title)}`);
        curSection = { title, anchor, text: '', keywords: [], commands: [], apis: [], configKeys: [], level: 2, faq: /^Q[：:]/.test(title) };
        if (curChapter) curChapter.sections.push(curSection);
        curSubLevel = 3;
        continue;
      }
      if (level === 4) {
        // #### 小节：并入所属节 keywords（标题词元）
        if (curSection) curSection.keywords.push(...tokenize(title));
        curSubLevel = 4;
        continue;
      }
    }
    // 非标题行
    if (curChapter && curSection) {
      curSection.text += line + '\n';
    } else if (curChapter) {
      curChapter.text += line + '\n';
    }
  }
  if (curSection && curChapter) flushSection();

  function flushSection() {
    const sec = curSection;
    const ch = curChapter;
    const meta = extractCodeMeta(sec.text);
    const titleTokens = tokenize(sec.title);
    let keywords = [...new Set([...titleTokens, ...sec.keywords, ...inlineCodeSpans(sec.text).map((s) => s.toLowerCase()).filter((s) => s.length >= 2)])];
    keywords = mergeSynonyms(keywords);
    const preview = sec.text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`|~\[\]()-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    entries.push({
      id: `${doc}-c${String(ch.no).padStart(2, '0')}-s${String(ch.sections.indexOf(sec) + 1).padStart(2, '0')}`,
      doc,
      chapter: ch.label,
      chapterNo: ch.no,
      level: sec.level,
      anchor: sec.anchor,
      title: sec.title,
      keywords,
      commands: meta.commands,
      apis: meta.apis,
      configKeys: meta.configKeys,
      aliases: [],
      preview: preview || sec.title,
      faq: sec.faq || false,
    });
    curSection = null;
  }

  // 章节级条目（供章标题检索 + 章内文本检索；commands/apis/configKeys 聚合自各节，章节搜索更全）
  for (const ch of chapters) {
    const meta = extractCodeMeta(ch.text);
    const secMeta = ch.sections.map((s) => extractCodeMeta(s.text));
    const secCommands = [...new Set(secMeta.flatMap((m) => m.commands))];
    const secApis = [...new Set(secMeta.flatMap((m) => m.apis))];
    const secKeys = [...new Set(secMeta.flatMap((m) => m.configKeys))];
    const titleTokens = tokenize(ch.title);
    const secTitles = ch.sections.map((s) => s.title).join(' ');
    const keywords = mergeSynonyms([...new Set([...titleTokens, ...tokenize(secTitles)])]);
    const preview = ch.text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`|~\[\]()-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    entries.push({
      id: `${doc}-c${String(ch.no).padStart(2, '0')}-s00`,
      doc,
      chapter: ch.label,
      chapterNo: ch.no,
      level: 1,
      anchor: ch.anchor,
      title: ch.title,
      keywords,
      commands: [...new Set([...meta.commands, ...secCommands])].slice(0, 20),
      apis: [...new Set([...meta.apis, ...secApis])].slice(0, 20),
      configKeys: [...new Set([...meta.configKeys, ...secKeys])].slice(0, 12),
      aliases: [],
      preview: preview || ch.title,
      faq: false,
    });
  }

  return { title: docTitle, chapters, entries };
}

/**
 * 构建 docs-index.json（幂等）
 * @returns {{index:Object, sea1Raw:string, sea2Raw:string}}
 */
function build() {
  const sea1Raw = fs.readFileSync(SEA1_DOC, 'utf8');
  const sea2Raw = fs.readFileSync(SEA2_DOC, 'utf8');
  const p1 = parseDoc(sea1Raw, 'sea1');
  const p2 = parseDoc(sea2Raw, 'sea2');

  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    docs: ['sea1', 'sea2'],
    synonyms: SYNONYMS,
    entries: [...p1.entries, ...p2.entries],
  };

  fs.mkdirSync(path.dirname(OUT_INDEX), { recursive: true });
  fs.writeFileSync(OUT_INDEX, JSON.stringify(index, null, 2), 'utf8');
  // 同步 sea1 说明书到服务根（幂等；sea1 源码零改动，仅此构建产物副本）
  fs.copyFileSync(SEA1_DOC, SEA1_DOC_COPY);
  return { index, sea1Raw, sea2Raw };
}

module.exports = { build, parseDoc, slugify, tokenize, mergeSynonyms, SYNONYMS, SEA1_DOC, SEA2_DOC, SEA1_DOC_COPY, OUT_INDEX };

if (require.main === module) {
  const { index } = build();
  const faqCount = index.entries.filter((e) => e.faq).length;
  console.log(`[docs-index] 生成完成：entries=${index.entries.length}（含 FAQ ${faqCount} 条）`);
  console.log(`[docs-index] 输出：${path.relative(process.cwd(), OUT_INDEX)}`);
  console.log(`[docs-index] 同步 sea1 副本：${path.relative(process.cwd(), SEA1_DOC_COPY)}`);
  console.log(`[docs-index] generatedAt=${index.generatedAt}`);
}
