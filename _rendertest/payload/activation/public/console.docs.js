'use strict';
/**
 * public/console.docs.js — 帮助中心视图模块（[帮助中心] 单 Tab）
 *
 * 设计依据：HELP_CENTER_SYSTEM_DESIGN.md §4 调用流程 / §3.2 MD mini-parser
 *  - 数据源：GET /docs/docs-index.json（索引+同义词）+ GET /docs/说明书_seaX_新手运维指南.md（原文）
 *  - 目录树两级：章（##）→ 节（###），锚点跳转 + 滚动跟随高亮
 *  - 搜索：2-gram 分词 + 同义词扩展 + 加权打分（title 5 > keywords 4 > commands/apis/configKeys 3 > 正文 1）
 *    → ≤20 条 + 高亮；无结果给相近词（编辑距离 ≤1 或同义词相关）+「去 FAQ 搜」
 *  - MD 渲染：白名单 mini-parser，raw HTML 一律转义（XSS 安全）；表格/代码块+复制/警示块
 *  - 快捷卡：常用功能（跳转现有 Tab）+ 常用指令（一键复制）
 *  - i18n：docs.* 键（zh 主，en 兜底）；sea1 顶部红色警示条
 *
 * 依赖 window.ConsoleApp；按序 <script> 引入（console.js 之后）。
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var NS = window.ConsoleApp || {};
  if (!NS.registerView || !NS.$) return;

  var $ = NS.$, esc = NS.esc, toast = NS.toast;
  var i18n = NS.i18n || function (s, k, f) { return f !== undefined ? f : String(k); };
  var T = function (key, fb) { return i18n('docs', key, fb); };
  var debounce = NS.debounce || function (fn, ms) { var t = null; return function () { clearTimeout(t); t = setTimeout(fn, ms || 150); }; };

  var state = {
    index: null,           // docs-index.json 数据
    project: 'sea2',       // 当前项目 sea1/sea2
    md: '',                // 当前 MD 原文
    tree: [],              // 目录树 [{chapter, chapterNo, anchor, sections:[...]}]
    loading: false,
    rendered: false,
    anchorMap: {},         // anchor -> element id（渲染时登记，滚动跟随用）
  };

  // ================= 工具 =================

  /** slug：与构建脚本保持一致（去空白/标点、保留中文与字母数字、截断 48） */
  function slugify(s) {
    return String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 48) || 'x';
  }

  /** 2-gram 分词（中文） + 英文/数字词元（含端口号等纯数字串） */
  function tokenize(text) {
    var out = [];
    var str = String(text || '').toLowerCase();
    // 英文/数字词元：首字符可为字母或数字，纯数字串（端口号等）不被丢弃
    var enRe = /[a-z0-9][a-z0-9._-]{1,}/g;
    var m;
    while ((m = enRe.exec(str)) !== null) out.push(m[0]);
    var zhRe = /[\u4e00-\u9fa5]+/g;
    while ((m = zhRe.exec(str)) !== null) {
      var seg = m[0];
      for (var i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    }
    return Array.from(new Set(out));
  }

  /** 同义词扩展：query 词元 → 命中任一组即整组加入 */
  function expandTokens(tokens, synonyms) {
    var set = new Set(tokens);
    var syn = synonyms || {};
    Object.keys(syn).forEach(function (key) {
      var group = syn[key] || [];
      var hit = set.has(key.toLowerCase()) || group.some(function (g) { return set.has(String(g).toLowerCase()); });
      if (hit) {
        set.add(String(key).toLowerCase());
        group.forEach(function (g) { set.add(String(g).toLowerCase()); });
      }
    });
    return Array.from(set);
  }

  /** 编辑距离（Levenshtein）≤1 判断 */
  function editDistLE1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    var longer = a.length >= b.length ? a : b;
    var shorter = a.length >= b.length ? b : a;
    var diff = 0;
    for (var i = 0, j = 0; i < longer.length && j < shorter.length;) {
      if (longer[i] !== shorter[j]) { diff++; if (diff > 1) return false; i++; }
      else { i++; j++; }
    }
    return true;
  }

  function containsAny(text, tokens) {
    var t = String(text || '').toLowerCase();
    return tokens.some(function (tok) { return t.indexOf(tok) >= 0; });
  }

  /** 高亮：把命中词元包 <mark> */
  function highlight(text, tokens) {
    var t = String(text || '');
    if (!tokens.length) return esc(t);
    var re = new RegExp('(' + tokens.map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'gi');
    return esc(t).replace(re, '<mark>$1</mark>');
  }

  // ================= MD mini-parser（白名单渲染，raw HTML 一律转义） =================

  /** 行内标记：`code` / **bold** / *italic* / [link](url)。输入必须已转义。 */
  function inline(s) {
    var str = String(s || '');
    // 行内码（最优先，避免与粗体冲突）
    str = str.replace(/`([^`\n]{1,120})`/g, function (_, c) { return '<code>' + c + '</code>'; });
    // 粗体
    str = str.replace(/\*\*([^*\n]{1,120})\*\*/g, '<strong>$1</strong>');
    // 斜体
    str = str.replace(/(^|[\s(（])\*([^*\n]{1,120})\*(?=[\s)）。，、：；！？]|$)/g, '$1<em>$2</em>');
    // 链接：仅 http/https/mailto/相对路径；url 转义防注入
    str = str.replace(/\[([^\]\n]{1,120})\]\(([^)\s]{1,300})\)/g, function (_, txt, url) {
      var u = esc(url);
      if (!/^(https?:\/\/|mailto:|\/|#)/i.test(u)) return '[' + txt + '](' + u + ')';
      return '<a href="' + u + '" target="_blank" rel="noopener">' + txt + '</a>';
    });
    return str;
  }

  /** 段落文本转义 + 行内渲染 */
  function para(s) { return '<p>' + inline(esc(s)) + '</p>'; }

  /**
   * 渲染整份 MD（白名单 mini-parser）
   * @param {string} md MD 原文
   * @param {string} doc doc 标识（sea1/sea2）
   * @returns {string} HTML
   */
  function renderMd(md, doc) {
    var lines = String(md || '').split(/\r?\n/);
    var html = '';
    var i = 0;
    var chapterNo = 0;
    var chapterTitle = '';
    var curAnchor = '';

    // sea1 顶部强制红色警示条（生产禁改）
    if (doc === 'sea1') {
      html += '<div class="docs-alert docs-danger"><b>⚠ 生产禁改</b><span>sea1 为生产激活/授权体系，改动必须走审批与测试，严禁裸改。</span></div>';
    }

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块
      if (/^```/.test(line)) {
        var lang = line.replace(/^```/, '').trim();
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 跳过 ``` 闭合
        var codeHtml = esc(buf.join('\n'));
        html += '<div class="docs-codeblock"><div class="docs-codehead"><span>' + esc(lang || 'text')
          + '</span><button class="btn ghost sm docs-copy" data-copy="' + esc(buf.join('\n')) + '">' + esc(T('copy', '复制')) + '</button></div>'
          + '<pre><code>' + codeHtml + '</code></pre></div>';
        continue;
      }

      // 标题 #~####（1=文档标题、2=章、3=节、4=小节）
      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        var lvl = h[1].length;
        var title = h[2].trim();
        if (lvl === 1) {
          html += '<h1 class="docs-doctitle">' + inline(esc(title)) + '</h1>';
          i++;
          continue;
        }
        if (lvl === 2) {
          var noMatch = /^(\d{1,2})[\s\-_、.：:]*/.exec(title);
          chapterNo = noMatch ? parseInt(noMatch[1], 10) : (chapterNo + 1);
          chapterTitle = title.replace(/^\d{1,2}[\s\-_、.：:]*/, '');
          curAnchor = doc + '-c' + String(chapterNo).padStart(2, '0') + '-' + slugify(chapterTitle);
          html += '<h2 class="docs-ch" id="' + esc(curAnchor) + '">' + inline(esc(title)) + '</h2>';
          i++;
          continue;
        }
        if (lvl === 3) {
          var secTitle = title;
          var secAnchor = doc + '-c' + String(chapterNo).padStart(2, '0') + '-' + slugify(chapterTitle) + '-' + slugify(secTitle);
          html += '<h3 class="docs-sec" id="' + esc(secAnchor) + '">' + inline(esc(title)) + '</h3>';
          i++;
          continue;
        }
        // 4 级小节：并入目录但不单列
        var subAnchor = curAnchor + '-' + slugify(title);
        html += '<h4 id="' + esc(subAnchor) + '">' + inline(esc(title)) + '</h4>';
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        html += '<hr class="docs-hr" />';
        i++;
        continue;
      }

      // 表格：| a | b | 且下一行是 |---| 分隔
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|/.test(lines[i + 1])) {
        var headerCells = line.split('|').slice(1, -1).map(function (c) { return c.trim(); });
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].trim() !== '') {
          rows.push(lines[i].split('|').slice(1, -1).map(function (c) { return c.trim(); }));
          i++;
        }
        html += '<div class="docs-tablewrap"><table class="tbl docs-table"><thead><tr>';
        headerCells.forEach(function (c) { html += '<th>' + inline(esc(c)) + '</th>'; });
        html += '</tr></thead><tbody>';
        rows.forEach(function (r) {
          html += '<tr>';
          for (var ci = 0; ci < headerCells.length; ci++) html += '<td>' + inline(esc(r[ci] !== undefined ? r[ci] : '')) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        continue;
      }

      // 引用（含警示块 > [!WARNING] / > [!DANGER]）
      if (/^>\s?/.test(line)) {
        var quotes = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quotes.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        var qText = quotes.join(' ');
        var warnM = /^\[!WARNING\]\s*(.*)$/i.exec(qText);
        var dangerM = /^\[!DANGER\]\s*(.*)$/i.exec(qText);
        if (warnM || dangerM) {
          var cls = dangerM ? 'docs-danger' : 'docs-warning';
          var label = dangerM ? '⚠ 危险' : '⚠ 注意';
          var body = dangerM ? dangerM[1] : warnM[1];
          html += '<div class="docs-alert ' + cls + '"><b>' + label + '</b><span>' + inline(esc(body)) + '</span></div>';
        } else {
          html += '<blockquote>' + inline(esc(qText)) + '</blockquote>';
        }
        continue;
      }

      // 无序/有序列表（仅一层）
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        var isOl = /^\s*\d+[.)]\s+/.test(line);
        var items = [];
        while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim());
          i++;
        }
        var tag = isOl ? 'ol' : 'ul';
        html += '<' + tag + '>';
        items.forEach(function (it) { html += '<li>' + inline(esc(it)) + '</li>'; });
        html += '</' + tag + '>';
        continue;
      }

      // 段落：连续非空非标记行
      if (line.trim() !== '') {
        var paraBuf = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4})\s/.test(lines[i]) && !/^```/.test(lines[i])
          && !/^>\s?/.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
          paraBuf.push(lines[i]);
          i++;
        }
        html += para(paraBuf.join(' '));
        continue;
      }

      i++;
    }
    return html;
  }

  // ================= 目录树 =================

  /** 从索引构建两级目录树（章 → 节） */
  function buildTree(index) {
    var entries = (index && index.entries) || [];
    var chapters = entries.filter(function (e) { return e.level === 1; }).sort(function (a, b) { return a.chapterNo - b.chapterNo; });
    var tree = chapters.map(function (ch) {
      return {
        chapterNo: ch.chapterNo,
        chapter: ch.chapter,
        anchor: ch.anchor,
        sections: entries.filter(function (e) { return e.level === 2 && e.doc === ch.doc && e.chapterNo === ch.chapterNo; })
          .map(function (e) { return { title: e.title, anchor: e.anchor, faq: !!e.faq }; }),
      };
    });
    return tree;
  }

  function renderTree() {
    var box = $('docsTree');
    if (!box) return;
    var tree = state.tree || [];
    if (!tree.length) { box.innerHTML = '<div class="loading">' + esc(T('loading', '加载中…')) + '</div>'; return; }
    var html = '';
    tree.forEach(function (ch) {
      html += '<div class="docs-tree-ch" data-anchor="' + esc(ch.anchor) + '">'
        + '<div class="docs-tree-ch-title">' + esc(ch.chapter) + '</div>';
      if (ch.sections && ch.sections.length) {
        html += '<div class="docs-tree-sections">';
        ch.sections.forEach(function (s) {
          html += '<div class="docs-tree-se' + (s.faq ? ' faq' : '') + '" data-anchor="' + esc(s.anchor) + '">'
            + (s.faq ? '<span class="tag s-trial">FAQ</span> ' : '')
            + esc(s.title) + '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
    box.innerHTML = html;
    box.querySelectorAll('[data-anchor]').forEach(function (el) {
      el.addEventListener('click', function () {
        var anchor = el.getAttribute('data-anchor');
        jumpTo(anchor);
      });
    });
  }

  function jumpTo(anchor) {
    if (!anchor) return;
    var el = document.getElementById(anchor);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // 滚动跟随高亮
      highlightTree(anchor);
    } else {
      // 锚点未找到（可能 index 与 MD 不同步）→ 滚动到文档顶部
      var main = $('docsContent');
      if (main) main.scrollTop = 0;
    }
  }

  function highlightTree(anchor) {
    var box = $('docsTree');
    if (!box) return;
    box.querySelectorAll('.docs-tree-ch, .docs-tree-se').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-anchor') === anchor);
    });
  }

  /** 滚动跟随：主内容滚动时高亮当前章节 */
  function bindScrollFollow() {
    var main = $('docsContent');
    if (!main) return;
    main.addEventListener('scroll', debounce(function () {
      var headings = main.querySelectorAll('h2[id], h3[id]');
      if (!headings.length) return;
      var top = main.scrollTop + 120;
      var cur = null;
      headings.forEach(function (h) {
        if (h.offsetTop <= top) cur = h.id;
      });
      if (cur) highlightTree(cur);
    }, 80));
  }

  // ================= 搜索 =================

  function doSearch(q) {
    var box = $('docsResults');
    if (!box) return;
    var index = state.index;
    q = String(q || '').trim();
    if (!q || !index) {
      box.classList.add('hidden');
      return;
    }
    var tokens = expandTokens(tokenize(q), index.synonyms);
    var entries = index.entries || [];
    var scored = [];
    entries.forEach(function (e) {
      var score = 0;
      if (containsAny(e.title, tokens)) score += 5;
      if (containsAny((e.keywords || []).join(' '), tokens)) score += 4;
      if (containsAny((e.commands || []).join(' '), tokens)) score += 3;
      if (containsAny((e.apis || []).join(' '), tokens)) score += 3;
      if (containsAny((e.configKeys || []).join(' '), tokens)) score += 3;
      if (containsAny(e.preview, tokens)) score += 1;
      if (score > 0) scored.push({ e: e, score: score });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored.slice(0, 20);
    if (!top.length) {
      // 无结果 → 相近词引导 + FAQ 引导
      var allWords = [];
      entries.forEach(function (e) {
        (e.keywords || []).forEach(function (k) { allWords.push(k); });
      });
      var qTokens = tokenize(q);
      var similar = [];
      allWords.forEach(function (w) {
        if (w.length < 2) return;
        if (qTokens.some(function (qt) { return editDistLE1(qt, w.toLowerCase()) || (index.synonyms && index.synonyms[w] ? containsAny(w, qTokens) : false); })) {
          if (similar.indexOf(w) < 0) similar.push(w);
        }
      });
      var faqHits = entries.filter(function (e) { return e.faq && (containsAny(e.title, qTokens) || containsAny(e.preview, qTokens)); });
      box.classList.remove('hidden');
      var html = '<div class="docs-noresult">' + esc(T('noResult', '没有找到匹配内容')) + '「' + esc(q) + '」</div>';
      if (similar.length) {
        html += '<div class="docs-similar">' + esc(T('similar', '相近词')) + '：'
          + similar.slice(0, 6).map(function (w) { return '<button class="btn ghost sm docs-sim" data-q="' + esc(w) + '">' + esc(w) + '</button>'; }).join(' ')
          + '</div>';
      }
      if (faqHits.length) {
        html += '<div class="docs-faqguide"><a href="#docs" data-faq="1">' + esc(T('goFaq', '去 FAQ 搜')) + '</a></div>';
      }
      box.innerHTML = html;
      box.querySelectorAll('.docs-sim').forEach(function (b) {
        b.addEventListener('click', function () {
          var qInput = $('docsSearchInput');
          if (qInput) { qInput.value = b.getAttribute('data-q'); doSearch(qInput.value); }
        });
      });
      box.querySelectorAll('[data-faq]').forEach(function (a) {
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          var qInput = $('docsSearchInput');
          if (qInput) { qInput.value = T('faqWord', 'FAQ'); doSearch(qInput.value); }
        });
      });
      return;
    }
    box.classList.remove('hidden');
    var html2 = top.map(function (s) {
      var e = s.e;
      var kind = e.level === 1 ? esc(T('chapter', '章')) : (e.faq ? esc(T('faqTag', 'FAQ')) : esc(T('section', '节')));
      return '<div class="docs-result" data-anchor="' + esc(e.anchor) + '">'
        + '<div class="docs-result-title"><span class="tag s-normal">' + kind + '</span> '
        + highlight(e.title, tokens) + '</div>'
        + '<div class="docs-result-preview">' + highlight(e.preview, tokens) + '</div>'
        + '<div class="docs-result-meta">' + esc(e.doc) + ' · ' + esc(e.chapter) + '</div>'
        + '</div>';
    }).join('');
    box.innerHTML = html2;
    box.querySelectorAll('.docs-result').forEach(function (el) {
      el.addEventListener('click', function () {
        jumpTo(el.getAttribute('data-anchor'));
      });
    });
  }

  // ================= 快捷卡 =================

  /** 常用功能：跳转现有 Tab（复用 hash 路由） */
  var FUNC_CARDS = [
    { key: 'config', label: '配置中心', view: 'config' },
    { key: 'cluster', label: '集群', view: 'cluster' },
    { key: 'docker', label: '容器管理', view: 'docker' },
    { key: 'device', label: '设备', view: 'device' },
    { key: 'highrisk', label: '高危', view: 'highrisk' },
    { key: 'orders', label: '订单', view: 'orders' },
  ];

  /** 常用指令：一键复制 */
  var CMD_CARDS = [
    'pm2 status',
    'pm2 restart sea1-activation sea2-bot',
    'pm2 logs sea2-bot --lines 50',
    'pm2 logs sea1-activation --lines 50',
    'curl -s http://127.0.0.1:3457/health',
    'bash /root/sea2/scripts/install-sea2.sh',
    'git -c http.proxy= -c https.proxy= ls-remote https://github.com/haihaigege184/sea2-client.git HEAD',
    'node --test "test/**/*.test.js"',
  ];

  function renderQuickCards() {
    var box = $('docsQuick');
    if (!box) return;
    var html = '<div class="docs-quickgrid">';
    html += '<div class="docs-card"><div class="docs-card-title">' + esc(T('quickFn', '常用功能')) + '</div><div class="docs-card-body">';
    FUNC_CARDS.forEach(function (c) {
      html += '<button class="btn ghost sm docs-func" data-view="' + esc(c.view) + '">' + esc(c.label) + '</button>';
    });
    html += '</div></div>';
    html += '<div class="docs-card"><div class="docs-card-title">' + esc(T('quickCmd', '常用指令')) + '</div><div class="docs-card-body">';
    CMD_CARDS.forEach(function (c) {
      html += '<div class="docs-cmdline"><code>' + esc(c) + '</code><button class="btn ghost sm docs-copy" data-copy="' + esc(c) + '">' + esc(T('copy', '复制')) + '</button></div>';
    });
    html += '</div></div>';
    html += '</div>';
    box.innerHTML = html;

    box.querySelectorAll('.docs-func').forEach(function (b) {
      b.addEventListener('click', function () {
        var view = b.getAttribute('data-view');
        // 复用现有 hash 路由切换到目标 Tab
        if (view && view !== 'docs') {
          location.hash = view;
          // 若 hash 已是该值（replaceState 不触发）则手动触发
          if (location.hash === '#' + view) {
            var ev = new Event('hashchange');
            window.dispatchEvent(ev);
          }
        }
      });
    });
  }

  /** 复制事件委托（代码块 + 快捷指令） */
  function bindCopyDelegation() {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.docs-copy') : null;
      if (!btn) return;
      var txt = btn.getAttribute('data-copy') || '';
      NS.copyText(txt);
      var old = btn.textContent;
      btn.textContent = T('copied', '已复制');
      setTimeout(function () { btn.textContent = old; }, 1200);
    });
  }

  // ================= 视图主渲染 =================

  async function loadIndex() {
    if (state.index) return state.index;
    var d = await fetch('/docs/docs-index.json', { method: 'GET' }).then(function (r) { return r.json(); });
    state.index = d;
    return d;
  }

  async function loadMd(doc) {
    var name = doc === 'sea1' ? '说明书_sea1_新手运维指南.md' : '说明书_sea2_新手运维指南.md';
    var r = await fetch('/docs/' + encodeURIComponent(name), { method: 'GET' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  }

  async function renderDocs() {
    var main = $('docsContent');
    if (!main) return;
    main.innerHTML = '<div class="loading">' + esc(T('loading', '加载中…')) + '</div>';
    try {
      var index = await loadIndex();
      state.index = index;
      state.tree = buildTree(index);

      // 项目切换胶囊
      var sw = $('docsProjectSwitch');
      if (sw) {
        sw.innerHTML = ['sea1', 'sea2'].map(function (p) {
          return '<button class="btn ghost sm docs-proj' + (state.project === p ? ' active' : '') + '" data-proj="' + p + '">' + p.toUpperCase() + '</button>';
        }).join('');
        sw.querySelectorAll('.docs-proj').forEach(function (b) {
          b.addEventListener('click', function () {
            state.project = b.getAttribute('data-proj');
            renderDocs();
          });
        });
      }

      // 加载当前项目 MD
      state.md = await loadMd(state.project);
      state.rendered = true;

      // 渲染目录树 + 内容 + 快捷卡
      renderTree();
      main.innerHTML = renderMd(state.md, state.project);
      renderQuickCards();
      bindScrollFollow();

      // 若 hash 是锚点（如 #sea2-c01-...）则跳转
      var h = (location.hash || '').replace(/^#/, '');
      if (h && document.getElementById(h)) jumpTo(h);
    } catch (e) {
      main.innerHTML = '<div class="box"><h3>' + esc(T('loadFailed', '加载失败')) + '</h3><p>' + esc(e.message)
        + '</p><p>' + esc(T('checkIndex', '请确认已运行 npm run docs:build 且 /docs/* 路由可用')) + '</p></div>';
    }
  }

  // ================= 初始化绑定 =================

  function bind() {
    var input = $('docsSearchInput');
    if (input) {
      input.addEventListener('input', debounce(function () { doSearch(input.value); }, 150));
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doSearch(input.value);
      });
    }
    bindCopyDelegation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  NS.registerView('docs', renderDocs);
})();
