'use strict';

(() => {
  const view = window.r7View;
  const state = new WeakMap();
  const motions = new Set();
  // True while a live patch adds rows to a card that already exists; new lines grow in once.
  let rowIn = false;
  // One observer holds the loops of running cards that are scrolled out of view.
  const away = new IntersectionObserver(entries => {
    for (const entry of entries) entry.target.classList.toggle('c-away', !entry.isIntersecting);
  }, { rootMargin: '120px' });
  function watch(el, running) {
    if (running === !!el._cardWatched) return;
    el._cardWatched = running;
    if (running) away.observe(el);
    else {
      away.unobserve(el);
      el.classList.remove('c-away');
    }
  }
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, Number(n) || 0));
  // Pictures load when they come near the screen, not when their card is built: a folded or far-off
  // picture costs no decode. A tile inside a hidden (folded) stretch never intersects, so it never loads.
  const picturesNear = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      picturesNear.unobserve(img);
      const src = img._lazySrc;
      if (src && img.getAttribute('src') !== src) img.src = src;
    }
  }, { rootMargin: '600px' });
  function lazyImage(img, url) {
    img._lazySrc = url;
    if (img.getAttribute('src') === url) return;
    picturesNear.observe(img);
  }
  // Pixel-exact drawing: a picture shown at 2x or more of its natural size keeps hard pixels; anything
  // else uses the browser's filtered downscale at device resolution (devicePixelRatio aware).
  function crisp(img) {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const box = img.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight) * devicePixelRatio;
    img.dataset.crisp = scale >= 2 ? 'pixels' : 'smooth';
  }
  // Moving between monitors or zooming changes the ratio; only pictures already drawn are checked again.
  function watchRatio() {
    const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    query.addEventListener('change', () => {
      for (const img of view.root.querySelectorAll('img[data-crisp]')) crisp(img);
      watchRatio();
    }, { once: true });
  }
  watchRatio();
  const count = n => Number(n).toLocaleString('en-US');
  const base = p => String(p || '').replace(/\\/g, '/').split('/').pop();
  const finished = row => row.state === 'done' || row.state === 'error';
  const node = (key, cls, children = [], tag = 'span', attrs = {}) => ({ key, cls, children: Array.isArray(children) ? children : [children], tag, attrs });
  const text = (key, cls, value) => node(key, cls, String(value ?? ''));
  const line = (key, left, right = []) => node(key, 'c-line', [node('left', 'c-left', left), node('right', 'c-right', right)], 'div');

  // Patch individual keyed nodes; unchanged text, selection and hovered links stay put.
  function patch(parent, specs) {
    const old = new Map(Array.from(parent.childNodes, (el, i) => [el._cardKey ?? `text-${i}`, el]));
    let next = parent.firstChild;
    specs.forEach((spec, i) => {
      const plain = typeof spec === 'string';
      const key = plain ? `text-${i}` : spec.key;
      let el = old.get(key);
      if (el && (plain ? el.nodeType !== 3 : el.nodeType !== 1 || el.localName !== spec.tag)) {
        if (next === el) next = el.nextSibling;
        el.remove();
        el = null;
      }
      const created = !el;
      if (created) el = plain ? document.createTextNode(spec) : document.createElement(spec.tag);
      el._cardKey = key;
      old.delete(key);
      if (el !== next) parent.insertBefore(el, next);
      next = el.nextSibling;
      if (plain) {
        if (el.data !== spec) el.data = spec;
        return;
      }
      if (created && rowIn && spec.cls.split(' ').includes('c-line')) el.classList.add('c-new');
      for (const cls of el._cardClasses || []) if (!spec.cls.split(' ').includes(cls)) el.classList.remove(cls);
      const classes = spec.cls.split(' ').filter(Boolean);
      for (const cls of classes) if (!el.classList.contains(cls)) el.classList.add(cls);
      el._cardClasses = classes;
      const attrs = spec.attrs || {};
      for (const name of el._cardAttrs || []) if (!(name in attrs)) el.removeAttribute(name);
      for (const [name, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) el.removeAttribute(name);
        else if (el.getAttribute(name) !== String(value)) el.setAttribute(name, String(value));
      }
      el._cardAttrs = Object.keys(attrs);
      patch(el, spec.children);
    });
    for (const el of old.values()) el.remove();
  }

  // A running compaction counts its seconds; one timer serves every clock and stops with the last.
  let clockTimer = 0;
  function sinceText(at) {
    const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
    return ` · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`}`;
  }
  function tickClocks() {
    clockTimer = 0;
    const clocks = document.querySelectorAll('#view .c-compact-clock');
    for (const el of clocks) el.textContent = sinceText(Number(el.dataset.since));
    if (clocks.length) clockTimer = setTimeout(tickClocks, 1000);
  }

  function elapsed(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms < 10000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  }

  function once(s, kind, run) {
    const status = kind === 'enter' ? '' : s.ev.step?.state || s.ev.state || '';
    const key = `${s.ev.sid || ''}:${s.ev.id}:${kind}:${status}`;
    if (motions.has(key)) return false;
    motions.add(key);
    while (motions.size > 16000) motions.delete(motions.values().next().value);
    if (s.instant || document.hidden || view.root.hidden || s.body.closest('.c-offscreen, .c-folded, .c-auto-fold') || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return s.ctx.animateOnce(kind, run);
  }

  function fileUrl(path) {
    let p = String(path).replace(/\\/g, '/');
    if (/^file:\/\//i.test(p)) return p;
    const drive = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
    if (drive) p = `${drive[1].toUpperCase()}:/${drive[2]}`;
    else if (p.startsWith('//')) {
      const [host, ...parts] = p.slice(2).split('/');
      return `file://${host}/` + parts.map(encodeURIComponent).join('/');
    } else if (p.startsWith('/')) {
      return `file://wsl.localhost/${encodeURIComponent(cfg.distro)}` + p.split('/').map(encodeURIComponent).join('/');
    }
    const parts = p.split('/');
    return 'file:///' + [parts[0], ...parts.slice(1).map(encodeURIComponent)].join('/');
  }

  function words(value, key = 'words') {
    const valueText = String(value ?? '');
    const tokens = /"[^"\n]*"|'[^'\n]*'|\b(?:no errors|\d[\d,]* passed|\d[\d,]* failed|exit -?\d+)\b|(?:[\w@~.*+-]+[\\/])*[\w@~.*+-]+\.[A-Za-z][\w.-]*(?::\d+(?:[-+,]\d+)*)?|(?:[\w@~.*+-]+[\\/])+/g;
    const out = [];
    let from = 0;
    for (const match of valueText.matchAll(tokens)) {
      out.push(valueText.slice(from, match.index));
      const token = match[0];
      const cls = /^["']/.test(token) ? 'c-gold' : /^(?:no errors|[\d,]+ passed|exit 0)$/.test(token) ? 'c-success' : /^(?:[\d,]+ failed|exit -?\d+)$/.test(token) ? 'c-error-text' : 'c-link';
      out.push(node(`${key}-${match.index}`, cls, token, 'span'));
      from = match.index + token.length;
    }
    out.push(valueText.slice(from));
    return out;
  }

  function pathText(path, key = 'path') {
    const name = base(path);
    return node(key, 'c-path', [text('dir', 'c-dim', String(path).slice(0, -name.length)), text('name', 'c-link', name)], 'span', { 'data-path': path, title: path });
  }

  function glyph(row, group = false) {
    const label = row.active || row.done || '';
    if (row.risk) return '▲';
    if (/in the background/.test(`${label} ${row.detail?.text || ''}`)) return '⚙';
    if (/^Wait/.test(label)) return '◷';
    if (/^(?:Build|Built)/.test(label)) return '⬡';
    if (/^Test/.test(label)) return '▶';
    if (/^Install/.test(row.active || '')) return '⤓';
    if (/^Cropp/.test(row.active || '')) return '✂';
    return { read: '≡', edit: '✎', search: '⌕', check: row.testKey !== undefined ? '▶' : '◇', web: group ? '⌕' : '◈', image: group ? '▣' : '◉', app: '◆', risky: '▲', other: '•' }[row.kind] || '•';
  }

  function liveKind(row) {
    if (/^Wait/.test(row.active || '')) return 'wait';
    if (row.kind === 'web') return row.web?.page ? 'read' : 'search';
    return row.kind === 'check' || /^Build/.test(row.active || '') ? 'check' : row.kind;
  }

  function badge(app) {
    return node('badge', 'c-badge', app.letter, 'span', { title: app.name, 'data-app': app.name });
  }

  function spinner(key = 'spinner', dot = false) {
    return node(key, `c-spinner${dot ? ' c-dot-spin' : ''}`, [], 'span', { 'aria-hidden': 'true' });
  }

  function progress(row) {
    const page = row.web?.page;
    if (page?.totalBytes > 0 && Number.isFinite(page.bytes)) return clamp(page.bytes / page.totalBytes);
    const value = row.liveText || '';
    const pair = /(?:\[)?(\d[\d,]*)\s*(?:of|\/)\s*(\d[\d,]*)/.exec(value);
    return pair && Number(pair[2].replace(/,/g, '')) > 0 ? clamp(Number(pair[1].replace(/,/g, '')) / Number(pair[2].replace(/,/g, ''))) : null;
  }

  function effect(row) {
    const kind = liveKind(row);
    if (kind === 'search' || kind === 'wait') return node('dots', 'c-dots', [0, 1, 2].map(i => text(`dot-${i}`, 'c-dot', '•')));
    if (kind === 'edit') return node('cursor', 'c-edit-cursor');
    if (kind === 'check') {
      const p = progress(row);
      return node('pip', `c-pip${p === null ? ' c-indeterminate' : ''}`, [node('fill', '', [], 'i', { style: `width:${p === null ? 35 : p * 100}%` })]);
    }
    return null;
  }

  function delta(value) {
    const out = [];
    if (value?.added) out.push(text('added', 'c-success', `+${count(value.added)}`));
    if (value?.removed) out.push(text('removed', 'c-error-text', `−${count(value.removed)}`));
    return out;
  }

  function stepLine(row, live) {
    const left = [];
    const mark = live ? row.state === 'pending' ? text('icon', 'c-icon c-dim', '○') : spinner('icon') : text('icon', `c-icon${row.state === 'error' ? ' c-error-text' : row.risk ? ' c-warn' : ''}`, row.state === 'error' ? '✗' : glyph(row));
    left.push(node('standalone-icon', 'c-standalone-icon', [mark]));
    left.push(node('child-icon', 'c-child-icon', [live && row.state === 'running' ? spinner('dot', true) : text('dot', `c-icon ${row.state === 'error' ? 'c-error-text' : live ? 'c-dim' : 'c-accent'}`, live ? '○' : row.state === 'error' ? '✗' : '●')]));
    if (row.app) left.push(badge(row.app));
    if (row.risk) left.push(text('tag', 'c-risk-tag', row.risk.tag));
    const label = words(live ? row.active : row.done);
    if (row.riskText) label.push(text('risk-result', 'c-muted', ' · '), ...words(row.riskText, 'risk'));
    if (row.detail && !(live && row.liveText === row.detail.text)) label.push(text('separator', 'c-dim', ' · '), node('detail', `c-${row.detail.tone === 'error' ? 'error-text' : row.detail.tone}`, words(row.detail.text, 'detail')));
    if (row.fixed && !live) label.push(text('fixed', 'c-success', ' · fixed'));
    left.push(node('label', 'c-label', label));
    const fx = live && row.state === 'running' && effect(row);
    if (fx) left.push(fx);
    const right = delta(row.delta);
    if (row.pane) {
      const layout = paneLayout(row.pane);
      if (layout.lens) right.push(text('range', 'c-dim', `lines ${layout.lens[0]}–${layout.lens[1]}`));
    } else if (live && row.liveText) {
      const p = progress(row);
      if (row.web?.page && p !== null) right.push(node('download', 'c-download', [node('fill', '', [], 'i', { style: `width:${p * 100}%` })]));
      right.push(text('live-text', row.risk ? 'c-warn' : 'c-accent', row.liveText));
    } else if (!live) right.push(text('time', 'c-dim', row.rightText || elapsed(row.elapsedMs)));
    return line(live ? 'live-line' : 'done-line', left, right);
  }

  function paneLayout(pane) {
    const lines = pane.source.lines || [];
    let head = lines.length - 1;
    for (let i = head; i >= 0; i--) if (lines[i].marker !== ' ') { head = i; break; }
    const from = Math.max(0, Math.min(Math.max(0, lines.length - 14), head - Math.floor(14 * .62)));
    const shown = lines.slice(from, from + 14);
    const nums = shown.map(l => l.num).filter(Number.isFinite);
    const total = lines.reduce((n, l) => Math.max(n, l.num || 0), pane.fileLines?.length || pane.source.wholeFile?.length || 0);
    return { shown, from, total, lens: nums.length ? [Math.min(...nums), Math.max(...nums)] : null };
  }

  function codeWords(raw, removed) {
    const value = String(raw).replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (removed) return [value];
    if (/^\s*(?:\/\/|#)/.test(value)) return [text('comment', 'c-comment', value)];
    return value.split(/(\b(?:const|let|return|for|if|else|new|false|true|function|await|async|export|class|def|import)\b|\b\d+(?:\.\d+)?\b)/).map((part, i) => i % 2 ? text(`token-${i}`, /^\d/.test(part) ? 'c-gold' : 'c-accent', part) : part);
  }

  function codePane(pane, row, live) {
    const source = pane.source;
    const layout = paneLayout(pane);
    const whole = pane.fileLines || source.wholeFile;
    const total = Math.max(1, layout.total);
    const ranges = source.changed || [];
    const fileLines = whole || source.lines.map(l => l.text);
    const bars = [];
    const buckets = Math.min(2048, fileLines.length);
    for (let i = 0; i < buckets; i++) {
      const start = Math.floor(i * fileLines.length / buckets);
      const end = Math.max(start + 1, Math.floor((i + 1) * fileLines.length / buckets));
      let length = 0;
      for (let j = start; j < end; j++) length = Math.max(length, fileLines[j].length);
      const lo = whole ? start + 1 : source.lines[start]?.num;
      const hi = whole ? end : source.lines[end - 1]?.num;
      if (!Number.isFinite(lo)) continue;
      const lit = ranges.some(([a, b]) => a <= (hi || lo) && b >= lo);
      bars.push(node(`bar-${i}`, `c-code-bar${lit ? ' c-lit' : ''}`, [], 'i', { style: `left:${(lo - .5) / total * 100}%;width:${Math.max(.03, (end - start) / total * 60)}%;height:${lit ? 44 : length ? 3 + Math.min(length, 100) / 100 * 36 : 0}px` }));
    }
    const marks = [];
    for (const name of source.funcs || []) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`);
      const i = whole ? whole.findIndex(l => re.test(l)) : source.lines.findIndex(l => l.marker !== '-' && re.test(l.text));
      const num = i < 0 ? null : whole ? i + 1 : source.lines[i].num;
      if (num) marks.push(node(`mark-${name}`, '', `▾${name}`, 'span', { style: `left:clamp(0px, ${num / total * 100}% - 3px, calc(100% - ${name.length + 1}ch))` }));
    }
    const a = layout.lens ? clamp((layout.lens[0] - 1) / total) : 0;
    const b = layout.lens ? clamp(layout.lens[1] / total, a) : 1;
    const band = node('band', 'c-band', [node('marks', 'c-band-labels', marks, 'div'), node('bars', 'c-band-bars', bars, 'div'), node('shade-a', 'c-band-shade', [], 'div', { style: `left:0;width:${a * 100}%` }), node('shade-b', 'c-band-shade', [], 'div', { style: `left:${b * 100}%;right:0` }), node('lens', 'c-band-lens', [], 'div', { style: `left:${a * 100}%;width:${Math.max(.4, (b - a) * 100)}%` }), node('fan', 'c-band-fan', [], 'div', { style: `clip-path:polygon(${a * 100}% 0,${b * 100}% 0,100% 100%,0 100%)` })], 'div');
    const current = layout.lens?.[1];
    const hunkIndex = Math.max(0, ranges.findLastIndex(([a]) => a <= current));
    const hunk = ranges[hunkIndex];
    const title = [live ? spinner() : text('status', 'c-success', '✓'), ' ', live ? 'Editing ' : 'Edited ', pathText(source.file), text('function', 'c-dim', `  @@ ${source.funcs?.[hunkIndex] || source.funcs?.[0] || (hunk ? `${hunk[0]}–${hunk[1]}` : '')}`)];
    const numbers = [text('hunk', 'c-dim', ranges.length ? `hunk ${hunkIndex + 1}/${ranges.length}` : ''), ...delta(row.delta), text('range', 'c-dim', layout.lens ? `lines ${layout.lens[0]}–${layout.lens[1]}` : '')];
    const shown = row._expanded ? source.lines : layout.shown;
    const offset = row._expanded ? 0 : layout.from;
    const rows = shown.map((l, i) => node(`line-${offset + i}`, `c-code-row${l.marker === '+' ? ' c-added' : l.marker === '-' ? ' c-removed' : ''}`, [text('num', 'c-code-num', l.num ?? ''), text('marker', 'c-code-marker', l.marker === '-' ? '−' : l.marker), node('text', `c-code-text${live && i === shown.length - 1 ? ' c-writing' : ''}`, codeWords(l.text, l.marker === '-'))], 'div', { 'data-code-key': `${source.file}:${offset + i}` }));
    return node('code', 'c-code-wrap', [node('card', 'c-code-card', [0, 1, 2, 3].map(i => node(`corner-${i}`, `c-corner c-corner-${i}`, [], 'i')).concat([node('header', 'c-code-header', [node('left', 'c-left', title), node('right', 'c-right', numbers)], 'div'), node('body', 'c-code-body', [band, node('pane', 'c-code-pane', rows, 'div')], 'div')]), 'div')], 'div');
  }

  function failureBlocks(row) {
    return (row.fails || []).map((fail, i) => {
      const title = String(fail.title || '').replace(/^Test failed\s*·\s*/, '');
      const lines = [line('title', [text('icon', 'c-icon c-error-text', '✗'), text('title', 'c-bright', 'Test failed'), text('name', 'c-muted', title ? ` · ${title}` : '')], fail.at ? [node('at', 'c-link', fail.at, 'span', { 'data-path': fail.at, title: fail.at })] : [])];
      const fields = [];
      if (fail.message) fields.push(node('message', 'c-error-text', fail.message));
      if (fail.expected !== undefined) fields.push(node('expected', '', [text('label', 'c-muted', 'Expected: '), text('value', 'c-success', fail.expected)]));
      if (fail.received !== undefined) fields.push(node('received', '', [text('label', 'c-muted', 'Received: '), text('value', 'c-error-text', fail.received)]));
      if (row.fixed) fields.push(text('fixed', 'c-success', 'fixed · rerun passed'));
      fields.forEach((field, j) => lines.push(line(`field-${field.key}`, [text('rail', 'c-fail-rail', j === fields.length - 1 ? '└─' : '├─'), field])));
      return node(`failure-${i}`, 'c-failure', lines, 'div');
    });
  }

  function searchBlock(search) {
    const children = [];
    if (search.mode === 'names') {
      (search.names || []).forEach((path, i, all) => children.push(line(`name-${path}`, [text('rail', 'c-tree', i === all.length - 1 && all.length === search.total ? '└─' : '├─'), text('dot', 'c-icon c-accent', '●'), pathText(path)])));
      if (search.total > search.names.length) children.push(line('more', [text('rail', 'c-tree', '└─'), text('more', 'c-muted', `+${count(search.total - search.names.length)} more`)]));
    } else {
      const max = Math.max(1, ...search.files.map(f => f.count));
      search.files.forEach((file, i, all) => {
        children.push(line(`file-${file.path}`, [text('rail', 'c-tree', i === all.length - 1 ? '└─' : '├─'), text('dot', 'c-icon c-accent', '●'), node('path', 'c-search-path', [pathText(file.path)]), text('count', 'c-hit-count', count(file.count)), node('bar', 'c-hit-bar', [node('fill', '', [], 'i', { style: `width:${file.count / max * 100}%` })])]));
        search.hits.filter(h => h.path === file.path).forEach((hit, j) => {
          const body = hit.match ? [hit.text.slice(0, hit.match[0]), text('hit', 'c-hit', hit.text.slice(...hit.match)), hit.text.slice(hit.match[1])] : [hit.text];
          children.push(line(`hit-${file.path}-${hit.line}-${j}`, [text('rail', 'c-tree c-hit-rail', i === all.length - 1 ? ' ' : '│'), text('num', 'c-hit-num', hit.line), node('text', 'c-preview', body)]));
        });
      });
      if (search.fileCount > search.files.length) children.push(line('more', [text('rail', 'c-tree', '└─'), text('more', 'c-muted', `+${count(search.fileCount - search.files.length)} more files`)]));
    }
    return node('search', 'c-search c-fold-shell', [node('inner', 'c-fold-inner', children, 'div')], 'div');
  }

  const normalizeUrl = url => String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  function webBlock(web, pages) {
    const rows = (web.results || []).map((result, i) => {
      const page = pages.get(normalizeUrl(result.url));
      const dot = page?.state === 'running' ? spinner('dot', true) : text('dot', `c-icon${page ? ' c-accent' : ' c-dim'}`, page ? page.state === 'error' ? '✗' : page.state === 'pending' ? '○' : '●' : '·');
      return line(`result-${i}`, [text('rail', 'c-tree', '│'), dot, text('chip', `c-site-chip${page ? ' c-open' : ''}`, result.site.charAt(0).toUpperCase()), node('result', `c-web-result${page ? ' c-open' : ''}`, [text('site', '', result.site), text('sep', 'c-dim', ' · '), result.title], 'a', { href: /^https?:\/\//i.test(result.url) ? result.url : null, title: result.url })]);
    });
    if (web.page?.found) rows.push(line('found', [text('rail', 'c-tree', ''), text('found', 'c-gold', 'found: '), text('quote', 'c-found', web.page.found)]));
    return node('web', 'c-web c-fold-shell', [node('inner', 'c-fold-inner', rows, 'div')], 'div');
  }

  function readMap(map) {
    const total = Math.max(1, map.total);
    const lo = clamp((map.from - 1) / total), hi = clamp(map.to / total, lo);
    const bars = Array.from({ length: 252 }, (_, i) => node(`bar-${i}`, i / 252 < hi && (i + 1) / 252 > lo ? 'c-lit' : '', [], 'i', { style: `height:${6 + ((i * 37 + (i * i % 11) * 13) % 11)}px` }));
    return node('map', 'c-map', [text('label', 'c-map-label', `lines ${count(map.from)}–${count(map.to)} · read ${count(map.to - map.from + 1)} of ${count(total)} lines`), node('bars', 'c-map-bars', bars, 'div'), node('lens', 'c-map-lens', [], 'div', { style: `left:${lo * 100}%;width:${Math.max(.5, (hi - lo) * 100)}%` }), node('ticks', 'c-map-ticks', [text('start', '', '1'), text('end', '', count(total))], 'div')], 'div');
  }

  function size(bytes) {
    if (!Number.isFinite(bytes)) return '';
    return bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
  }

  function film(items, pair = false) {
    const unique = [...new Map(items.filter(i => i?.path).map(i => [i.path, i])).values()];
    if (!unique.length) return null;
    const tiles = [];
    unique.forEach((item, i) => {
      if (pair && i) tiles.push(text(`arrow-${i}`, 'c-pair-arrow', '→'));
      const name = item.name || base(item.path);
      const crop = item.crop;
      const content = [node('image', '', [], 'img', { 'data-path': item.path, alt: name, decoding: 'async', draggable: 'false' })];
      if (Array.isArray(crop) && crop.length === 4) content.push(node('crop', 'c-crop', [0, 1, 2, 3].map(j => node(`handle-${j}`, `c-handle c-handle-${j}`, [], 'i')), 'div'));
      const tile = node(`tile-${item.path}`, `c-picture${i === unique.length - 1 ? ' c-active' : ''}`, [node('clip', 'c-picture-clip', content, 'div'), node('ring', 'c-picture-ring', [], 'i'), text('error', 'c-picture-error', 'Image unavailable')], 'div', { style: `--picture-aspect:${item.width > 0 && item.height > 0 ? item.width / item.height : 16 / 9}`, 'data-picture': item.path, title: name });
      tiles.push(tile);
    });
    const item = unique.at(-1);
    const dims = item.width && item.height ? `${item.width}×${item.height}` : '';
    const details = [dims, size(item.bytes)].filter(Boolean).join(' · ');
    return node('film', `c-film${pair ? ' c-pair' : ''}`, [node('strip', 'c-film-strip', tiles, 'div'), node('readout', 'c-readout', [node('name', 'c-picture-name c-bright', item.name || base(item.path), 'button', { type: 'button', 'data-picture-name': item.path, title: item.path }), text('detail', 'c-dim', details)], 'div')], 'div');
  }

  function bindImages(el, items, ctx, instant) {
    const owner = state.get(el.closest('.view-card'));
    const byPath = new Map(items.map(item => [item.path, item]));
    el.querySelectorAll('img[data-path]').forEach(img => {
      const item = byPath.get(img.dataset.path);
      if (!item) return;
      const tile = img.closest('.c-picture');
      const crop = () => {
        const box = tile.querySelector('.c-crop');
        if (!box || !item.crop) return;
        const fractional = item.crop.every(n => n >= 0 && n <= 1);
        const w = fractional ? 1 : img.naturalWidth || item.width;
        const h = fractional ? 1 : img.naturalHeight || item.height;
        if (!w || !h) return;
        const [x, y, cw, ch] = item.crop;
        box.style.left = `${clamp(x / w) * 100}%`;
        box.style.top = `${clamp(y / h) * 100}%`;
        box.style.width = `${clamp(cw / w, 0, 1 - clamp(x / w)) * 100}%`;
        box.style.height = `${clamp(ch / h, 0, 1 - clamp(y / h)) * 100}%`;
        if (!box.dataset.cropBound) {
          box.dataset.cropBound = '1';
          if (owner) once(owner, `crop:${item.path}`, () => box.classList.add('c-crop-enter'));
        }
      };
      img._cardLoaded = () => {
        const first = !tile.classList.contains('c-loaded');
        tile.classList.add('c-loaded');
        tile.classList.remove('c-image-failed');
        if (first && owner) once(owner, `picture:${item.path}`, () => tile.classList.add('c-picture-enter'));
        if (!item.width || !item.height) tile.style.setProperty('--picture-aspect', img.naturalWidth / Math.max(1, img.naturalHeight));
        crisp(img);
        const readout = tile.closest('.c-film')?.querySelector('.c-readout');
        if (readout?.querySelector('[data-picture-name]')?.dataset.pictureName === item.path) {
          const dims = `${item.width || img.naturalWidth}×${item.height || img.naturalHeight}`;
          readout.querySelector('.c-dim').textContent = [dims, size(item.bytes)].filter(Boolean).join(' · ');
        }
        crop();
      };
      if (!img._cardBound) {
        img._cardBound = true;
        tile.classList.toggle('c-picture-instant', instant);
        tile.addEventListener('click', event => {
          if (event.target === img) return;
          event.stopPropagation();
          img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: event.clientX, clientY: event.clientY }));
        });
        img.addEventListener('load', () => img._cardLoaded());
        img.addEventListener('error', () => {
          tile.classList.add('c-image-failed');
          ctx.log('cards.image_error', { path: item.path });
        });
        try {
          const url = fileUrl(item.path);
          // The file's version keeps a path that was written again from showing the browser's cached copy.
          const version = r7.fileVersion ? r7.fileVersion(item.path) : Promise.resolve(0);
          version.catch(() => 0).then((n) => lazyImage(img, url + (n ? `?v=${n}` : '')));
        }
        catch (error) { tile.classList.add('c-image-failed'); ctx.log('cards.path_error', { path: item.path, error: String(error) }); }
      }
      if (img.complete && img.naturalWidth) img._cardLoaded();
      else crop();
    });
    el.querySelectorAll('[data-picture-name]').forEach(button => {
      if (button._cardBound) return;
      button._cardBound = true;
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const img = Array.from(button.closest('.c-film').querySelectorAll('img[data-path]')).find(img => img.dataset.path === button.dataset.pictureName);
        img?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: event.clientX, clientY: event.clientY }));
      });
    });
  }

  function riskFolders(row) {
    const folders = row.riskFolders || [];
    const max = Math.max(1, ...folders.map(f => f.bytes));
    const rows = folders.slice(0, 3).map((folder, i) => line(`folder-${folder.path}`, [text('rail', 'c-risk-rail', i === folders.length - 1 ? '└─' : '├─'), node('name', 'c-folder-name', [pathText(folder.path)]), node('bar', 'c-folder-bar', [node('fill', '', [], 'i', { style: `width:${clamp(folder.bytes / max) * 100}%` })]), text('size', 'c-folder-size', folder.size), text('files', 'c-folder-files', folder.files === undefined ? '' : `${count(folder.files)} files`)]));
    if (folders.length > 3) rows.push(line('more', [text('rail', 'c-risk-rail', '└─'), text('more', 'c-dim', `+ ${folders.length - 3} more folders`)]));
    return node('folders', 'c-risk-fold c-fold-shell', [node('inner', 'c-fold-inner', rows, 'div')], 'div');
  }

  function completion(item, key) {
    return line(key, [node('mark', 'c-completion-icon', [text('icon', `c-icon ${item.ok ? 'c-success' : 'c-error-text'}`, item.ok ? '✓' : '✗')]), text('name', item.helper ? 'c-link' : 'c-dim', item.name), node('result', 'c-muted', item.text ? [' · ', ...words(item.text)] : [])], [text('time', 'c-dim', elapsed(item.elapsedMs))]);
  }

  function message(ev) {
    const lines = String(ev.text || '').split(/\r?\n/);
    const head = node('head', 'c-irc-head', [
      text('envelope', 'c-irc-envelope', '✉'),
      text('from', 'c-irc-party c-link', ev.from),
      text('arrow', 'c-irc-arrow', '➤'),
      text('to', 'c-irc-party c-gold', ev.to),
      text('preview', 'c-irc-preview', lines.shift() || ''),
    ], 'div');
    return [head, ...(lines.length ? [text('quote', 'c-irc-quote', lines.join('\n'))] : [])];
  }

  function finishEntries(root) {
    for (const el of root.querySelectorAll('.c-arrive, .c-new, .c-code-enter, .c-picture-enter, .c-crop-enter')) {
      el.classList.remove('c-arrive', 'c-new', 'c-code-enter', 'c-picture-enter', 'c-crop-enter');
    }
  }

  function finishMotion(el) {
    finishEntries(el);
    el.classList.remove('c-arrive', 'c-state-change', 'c-settling');
    if (el.classList.contains('c-auto-fold')) {
      el.classList.replace('c-auto-fold', 'c-folded');
      el.querySelector('.c-group-header')?.setAttribute('aria-expanded', 'false');
    }
    if (el.classList.contains('c-code-folding')) el.classList.replace('c-code-folding', 'c-code-folded');
    if (el.classList.contains('c-risk-auto')) el.classList.replace('c-risk-auto', 'c-risk-folded');
    if (el.classList.contains('c-excerpt-folding')) el.classList.replace('c-excerpt-folding', 'c-excerpt-folded');
  }

  function finalHunks(row, saved) {
    return row.hunks.filter(hunk => hunk.lines.length).map((hunk, i) => {
      const changed = [];
      for (const l of hunk.lines) {
        if (l.marker === ' ' || !Number.isFinite(l.num)) continue;
        const last = changed.at(-1);
        if (last && l.num <= last[1] + 1) last[1] = Math.max(last[1], l.num);
        else changed.push([l.num, l.num]);
      }
      const retained = saved?.source.file === hunk.path ? saved : null;
      const pane = { fileLines: retained?.fileLines, source: { file: hunk.path, lines: hunk.lines, changed, funcs: retained?.source.funcs || [], wholeFile: retained?.source.wholeFile } };
      const delta = { added: hunk.lines.filter(l => l.marker === '+').length, removed: hunk.lines.filter(l => l.marker === '-').length };
      const card = codePane(pane, { ...row, delta, _expanded: true }, false);
      card.key = `hunk-${hunk.path}-${i}`;
      if (hunk.total > hunk.lines.length) card.children.push(text('omitted', 'c-dim', `${count(hunk.total - hunk.lines.length)} additional diff lines not retained`));
      return card;
    });
  }

  function create(ev, ctx) {
    const el = document.createElement('div');
    el.className = `view-card c-${ev.kind}`;
    const body = document.createElement('div');
    body.className = 'c-content';
    el.append(body);
    state.set(el, { body, ev, ctx, instant: false, expanded: null, pane: null, row: null });
    el.addEventListener('contentvisibilityautostatechange', event => {
      if (event.target !== el) return;
      el.classList.toggle('c-offscreen', event.skipped);
      if (event.skipped) finishMotion(el);
    });
    el.addEventListener('transitionend', event => {
      if (event.target.classList.contains('c-done-layer') && event.propertyName === 'opacity') el.classList.remove('c-settling');
    });
    el.addEventListener('pointerdown', event => {
      state.get(el).down = { x: event.clientX, y: event.clientY };
    });
    el.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || window.getSelection()?.toString()) return;
      if (event.target.closest('.view-card') !== el || event.target.closest('a, button, [data-path], .c-details, .c-full')) return;
      const s = state.get(el);
      if (s.down && Math.hypot(event.clientX - s.down.x, event.clientY - s.down.y) > 5) return;
      if (!['step', 'done', 'irc', 'compaction', 'notice', 'think'].includes(s.ev.kind)) return;
      view.expand(s.ev.id, !s.expanded);
    });
    el.addEventListener('animationend', event => {
      if (event.target !== el && event.target.closest('.view-card') !== el) return;
      if (event.animationName === 'cards-risk-fold') {
        el.classList.add('c-risk-folded');
        el.classList.remove('c-risk-auto');
      } else if (event.animationName === 'cards-group-fold') {
        el.classList.add('c-folded');
        el.classList.remove('c-auto-fold');
        const header = el.querySelector('.c-group-header');
        header?.setAttribute('aria-expanded', 'false');
      } else if (event.animationName === 'cards-row-in') {
        event.target.classList.remove('c-new');
      } else if (event.animationName.startsWith('cards-arrive')) {
        el.classList.remove('c-arrive');
      } else if (event.animationName === 'cards-state') {
        el.classList.remove('c-state-change');
      } else if (event.animationName === 'cards-code-fold') {
        el.classList.remove('c-code-folding');
        el.classList.add('c-code-folded');
      } else if (event.animationName === 'cards-excerpt-fold') {
        el.classList.replace('c-excerpt-folding', 'c-excerpt-folded');
      } else if (event.animationName === 'cards-code-line') {
        event.target.classList.remove('c-code-enter');
      } else if (event.animationName === 'cards-picture') {
        event.target.classList.add('c-picture-arrived');
      } else if (event.animationName === 'cards-ring') {
        event.target.classList.add('c-ring-done');
      } else if (event.animationName === 'cards-crop') {
        event.target.classList.add('c-crop-drawn');
      } else if (event.animationName === 'cards-handle') {
        event.target.closest('.c-crop')?.classList.remove('c-crop-enter');
      }
    });
    patchCard(el, ev, null, ctx);
    return el;
  }

  function fresh(ev, ctx) {
    // Only a replay or an instant block skips motion.
    return !ctx.instant && !ctx.replay && !document.hidden;
  }

  function patchStep(el, ev, prev, ctx) {
    const s = state.get(el);
    const row = ev.step;
    if (!row || !row.kind) {
      patch(s.body, [line('invalid', [text('error', 'c-error-text', 'Step data unavailable')])]);
      if (!s.invalid) ctx.log('cards.step_invalid', { id: ev.id });
      s.invalid = true;
      return;
    }
    s.row = row;
    if (row.pane || row.finalPane) s.pane = row.pane || row.finalPane;
    el.dataset.stepKind = row.kind;
    el.dataset.liveKind = liveKind(row);
    el.classList.toggle('c-running', row.state === 'running');
    watch(el, row.state === 'running');
    el.classList.toggle('c-pending', row.state === 'pending');
    if (prev?.step && finished(row) && !finished(prev.step)) {
      el.classList.remove('c-arrive');
      once(s, 'settle', () => el.classList.add('c-settling'));
    }
    if (!finished(row)) el.classList.remove('c-settling');
    el.classList.toggle('c-settled', finished(row));
    el.classList.toggle('c-error', row.state === 'error');
    el.classList.toggle('c-risk', !!row.risk);
    el.classList.toggle('c-fixed', !!row.fixed);
    const details = [];
    const excerpts = [];
    if (row.search) excerpts.push(searchBlock(row.search));
    if (row.web) excerpts.push(webBlock(row.web, s.pages || new Map()));
    if (row.map) excerpts.push(readMap(row.map));
    if (excerpts.length) details.push(node('excerpts', 'c-excerpt-fold c-fold-shell', [node('inner', 'c-fold-inner', excerpts, 'div')], 'div'));
    rowIn = !!prev && !s.instant;
    if (finished(row) && !finished(prev?.step || {}) && excerpts.length && !s.expanded) {
      if (!once(s, 'excerpt-fold', () => el.classList.add('c-excerpt-folding'))) el.classList.add('c-excerpt-folded');
    }
    if (!finished(row)) el.classList.remove('c-excerpt-folding', 'c-excerpt-folded');
    if (row.riskFolders?.length) details.push(riskFolders(row));
    if (row.thumbs?.length) details.push(film(row.thumbs, row.capture && row.thumbs.length > 1));
    if (row.errorLine) details.push(node('error', 'c-failure', [line('message', [text('rail', 'c-fail-rail', '└─'), text('message', 'c-error-text', row.errorLine)])], 'div'));
    // Finished edits show their diff when expanded.
    const pane = finished(row) && s.expanded ? s.pane : null;
    if (finished(row) && s.expanded && row.hunks?.length) details.unshift(...finalHunks(row, s.pane));
    else if (pane) details.unshift(codePane(pane, { ...row, _expanded: s.expanded }, !!row.pane && !finished(row)));
    if (finished(row) && s.expanded && row.full !== undefined) details.push(node('full', 'c-full', String(row.full), 'pre'));
    el.classList.toggle('c-has-pane', !!pane);
    const children = [...failureBlocks(row), node('head', 'c-step-head', [node('live', 'c-live-layer', [stepLine(row, true)], 'div', { 'aria-hidden': finished(row) ? 'true' : 'false' }), node('done', 'c-done-layer', [stepLine(row, false)], 'div', { 'aria-hidden': finished(row) ? 'false' : 'true' })], 'div'), node('details', 'c-details', details.filter(Boolean), 'div')];
    for (const [i, item] of (row.settled || []).entries()) children.push(completion(item, `settled-${i}`));
    patch(s.body, children);
    if (finished(row)) for (const code of s.body.querySelectorAll('.c-code-enter')) code.classList.remove('c-code-enter');
    if (pane && !finished(row) && !s.expanded) {
      for (const code of s.body.querySelectorAll('.c-code-row.c-added, .c-code-row.c-removed')) {
        once(s, `code-line:${code.dataset.codeKey}`, () => code.classList.add('c-code-enter'));
      }
    }
    bindImages(s.body, row.thumbs || [], ctx, s.instant);
    if (finished(row) && !finished(prev?.step || {}) && row.riskFolders?.length && s.expanded === null) {
      if (!once(s, 'risk-fold', () => el.classList.add('c-risk-auto'))) el.classList.add('c-risk-folded');
    }
  }

  function groupRows(ev, blocks) {
    const members = new Map((ev.members || []).map((id, i) => [typeof id === 'string' ? id : id.id, i]));
    return blocks.filter(b => b.kind === 'step' && (b.ev.parent === ev.id || members.has(b.id))).sort((a, b) => (members.get(a.id) ?? Infinity) - (members.get(b.id) ?? Infinity)).map(b => b.ev.step).filter(Boolean);
  }

  function summary(rows, kind) {
    const list = (items, n = 3) => {
      const unique = [...new Set(items.filter(Boolean))];
      return unique.slice(0, n).join(', ') + (unique.length > n ? ` +${unique.length - n}` : '');
    };
    if (kind === 'read') return `${rows.length} files · ${list(rows.map(r => r.file || String(r.done || '').replace(/^Read\s+/, '')))}`;
    if (kind === 'edit') {
      const files = [...new Set(rows.map(r => r.file).filter(Boolean))];
      return files.length === 1 ? `${files[0]}${rows.some(r => r.edit) ? ` · ${list(rows.flatMap(r => r.edit?.files.flatMap(f => f.funcs) || []), 4)}` : ''}` : `${files.length} files · ${list(files)}`;
    }
    if (kind === 'search') return `${rows.length} searches · ${count(rows.reduce((n, r) => n + (r.search?.total || 0), 0))} matches`;
    if (kind === 'web') {
      const queries = rows.filter(r => r.web?.query !== undefined).length;
      const pages = rows.filter(r => r.web?.page).length;
      return [`${queries} ${queries === 1 ? 'query' : 'queries'}`, `read ${pages} ${pages === 1 ? 'page' : 'pages'}`, list(rows.flatMap(r => [...(r.web?.results.map(x => x.site) || []), r.web?.page?.site]))].filter(Boolean).join(' · ');
    }
    if (kind === 'check') return list(rows.map(r => r.fold), rows.length);
    if (kind === 'image') return `${rows.length} steps · ${list(rows.map(r => r.file))}`;
    if (kind === 'app') return list(rows.map(r => r.done));
    return `${rows.length} steps`;
  }

  function patchGroup(el, ev, ctx, blocks = view.records(), knownRows) {
    const s = state.get(el);
    if (!s.header) {
      s.header = document.createElement('div');
      s.header.className = 'c-group-header';
      s.header.setAttribute('role', 'button');
      s.header.tabIndex = 0;
      s.media = document.createElement('div');
      s.media.className = 'c-group-media';
      s.fold = document.createElement('div');
      s.fold.className = 'c-group-fold c-fold-shell';
      s.members = document.createElement('div');
      s.members.className = 'c-members c-fold-inner';
      s.members.dataset.viewMembers = '';
      s.fold.append(s.members);
      s.failures = document.createElement('div');
      s.failures.className = 'c-group-failures';
      s.body.append(s.header, s.media, s.fold, s.failures);
      const toggle = () => view.expand(ev.id, el.classList.contains('c-folded') || el.classList.contains('c-auto-fold'));
      s.header.addEventListener('click', event => { if (!event.ctrlKey && !window.getSelection()?.toString()) toggle(); });
      s.header.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        toggle();
      });
    }
    const rows = knownRows || groupRows(ev, blocks);
    if (s.groupEvent === ev && s.groupRows?.length === rows.length && rows.every((row, i) => row === s.groupRows[i])) return;
    rowIn = !!s.groupEvent && !s.instant;
    s.groupEvent = ev;
    s.groupRows = rows;
    const kind = ev.group || rows[0]?.kind || 'other';
    const app = rows[0]?.app;
    const done = rows.filter(finished).length;
    const complete = ev.state === 'done' || ev.state === 'error';
    const failed = rows.some(r => r.state === 'error' && !r.fixed);
    const title = ev.title || app?.name || ({ read: 'Read', edit: 'Edit', search: 'Search', check: 'Check', web: 'Web', image: 'Images', app: 'App' }[kind] || 'Steps');
    el.dataset.groupKind = kind;
    el.classList.toggle('c-running', !complete);
    watch(el, !complete);
    const icon = complete ? text('icon', `c-icon ${failed ? 'c-error-text' : 'c-success'}`, failed ? '✗' : '✓') : spinner('icon');
    const lead = [icon];
    if (app) lead.push(badge(app));
    lead.push(text('title', 'c-gold', title));
    const foldedLead = [text('icon', `c-icon${failed ? ' c-error-text' : ''}`, failed ? '✗' : glyph({ kind, active: '' }, true))];
    if (app) foldedLead.push(badge(app));
    foldedLead.push(text('title', 'c-gold', kind === 'web' ? 'Searched' : title), ' ', node('summary', 'c-muted', words(summary(rows, kind))));
    if (rows.some(r => r.fixed)) foldedLead.push(text('fixed', 'c-success', ' · fixed'));
    const pips = node('pips', 'c-group-pips', rows.map((r, i) => text(`pip-${i}`, r.state === 'error' && !r.fixed ? 'c-error-text' : finished(r) ? 'c-accent' : 'c-dim', finished(r) ? '●' : '○')));
    const totals = rows.reduce((sum, r) => ({ added: sum.added + (r.delta?.added || 0), removed: sum.removed + (r.delta?.removed || 0) }), { added: 0, removed: 0 });
    const foldedLine = rows.length === 1 ? stepLine(rows[0], false) : line('line', foldedLead, [pips, ...delta(totals), text('time', 'c-dim', rows.some(r => Number.isFinite(r.elapsedMs)) ? elapsed(rows.reduce((n, r) => n + (r.elapsedMs || 0), 0)) : '')]);
    patch(s.header, [node('expanded', 'c-group-open-head', [line('line', lead, [text('count', complete ? 'c-success' : 'c-accent', `${done}/${rows.length}`)])], 'div'), node('folded', 'c-group-closed-head', [foldedLine], 'div')]);
    const captures = rows.filter(r => r.capture).flatMap(r => r.thumbs || []);
    // Pictures the members looked at show once, on the group, so they stay in view when its rows fold.
    const shots = rows.flatMap(r => r.thumbs || []);
    const pictures = kind === 'image' ? shots : captures.length > 1 ? [captures[0], captures.at(-1)] : captures.length ? captures : shots;
    patch(s.failures, rows.filter(r => r.fails?.length || r.errorLine).map(r => node(`failure-${r.id}`, '', [...failureBlocks(r), ...(r.errorLine ? [node('error', 'c-failure', [line('line', [text('message', 'c-error-text', r.errorLine)])], 'div')] : [])], 'div')));
    const media = film(pictures, kind !== 'image' && captures.length > 1);
    patch(s.media, media ? [media] : []);
    bindImages(s.media, pictures, ctx, s.instant);
    el.classList.toggle('c-group-pictures', pictures.length > 0);
    if (complete && !s.wasComplete && s.expanded === null) {
      finishMotion(el);
      if (!once(s, 'group-fold', () => el.classList.add('c-auto-fold'))) el.classList.add('c-folded');
    }
    if (!complete && s.expanded === null) el.classList.remove('c-folded', 'c-auto-fold');
    s.wasComplete = complete;
    s.header.setAttribute('aria-expanded', String(!el.classList.contains('c-folded') && !el.classList.contains('c-auto-fold')));
  }

  function patchCard(el, ev, prev, ctx) {
    const s = state.get(el);
    s.ev = ev;
    s.ctx = ctx;
    s.instant = !fresh(ev, ctx);
    el.classList.toggle('c-instant', s.instant);
    rowIn = !!prev && !s.instant;
    if (!prev && !ev.step?.pane && !ev.step?.thumbs?.length && !ev.images?.length) once(s, 'enter', () => el.classList.add('c-arrive'));
    if (ev.kind === 'step') return patchStep(el, ev, prev, ctx);
    if (ev.kind === 'group') return patchGroup(el, ev, ctx);
    if (prev && finished(ev) && !finished(prev)) {
      el.classList.remove('c-arrive');
      once(s, 'settle', () => el.classList.add('c-state-change'));
    }
    if (ev.kind === 'user') {
      patch(s.body, [text('text', 'c-user-text', ev.text), ...(ev.images?.length ? [film(ev.images)] : [])].filter(Boolean));
      bindImages(s.body, ev.images || [], ctx, s.instant);
    } else if (ev.kind === 'think') {
      if (!s.thought) {
        s.thought = document.createElement('span');
        s.thought.className = 'c-thought';
        s.body.append(s.thought);
      }
      el.classList.toggle('c-running', ev.state === 'running' || ev.state === 'pending');
      watch(el, ev.state === 'running' || ev.state === 'pending');
      if (finished(ev)) {
        s.reveal?.finish?.();
        s.reveal?.();
        s.reveal = null;
      }
      const full = String(ev.full || ev.text || '');
      const value = s.expanded || finished(ev) ? full : String(ev.text || '');
      if (value !== s.thoughtText) {
        s.reveal?.();
        if (!s.instant && !s.expanded && ev.state !== 'done' && ev.state !== 'error') s.reveal = view.typeReveal(s.thought, value, { cps: 330, startDelayMs: 0 });
        else s.thought.textContent = value;
        s.thoughtText = value;
      }
    } else if (ev.kind === 'irc') {
      el.dataset.mode = ['incoming', 'autoreply', 'relay', 'workpool'].includes(ev.mode) ? ev.mode : 'incoming';
      patch(s.body, message(ev));
    } else if (ev.kind === 'done') {
      patch(s.body, [completion(ev, 'done'), ...(s.expanded && ev.full !== undefined ? [node('full', 'c-full', String(ev.full), 'pre')] : [])]);
    } else {
      const error = ev.state === 'error';
      const compact = ev.kind === 'compaction';
      const clock = compact && ev.state === 'running' && Number.isFinite(ev.at);
      patch(s.body, [
        line('notice', [text('icon', `c-icon ${error ? 'c-error-text' : compact ? 'c-dim' : 'c-gold'}`, error ? '✗' : compact ? '≋' : '⚙'), node('text', error ? 'c-error-text' : 'c-muted', words(ev.text)),
          ...(clock ? [node('clock', 'c-dim c-compact-clock', sinceText(ev.at), 'span', { 'data-since': String(ev.at) })] : [])]),
        ...(s.expanded ? [node('full', 'c-full', String(ev.full ?? ev.text ?? ''), 'pre')] : []),
      ]);
      if (clock && !clockTimer) clockTimer = setTimeout(tickClocks, 1000);
    }
  }

  function expand(el, ev, on) {
    const s = state.get(el);
    s.expanded = !!on;
    el.dataset.expanded = String(!!on);
    el.classList.toggle('c-expanded', !!on);
    if (ev.kind === 'group') {
      if (!on) finishEntries(s.body);
      el.classList.remove('c-auto-fold');
      el.classList.toggle('c-folded', !on);
      s.header.setAttribute('aria-expanded', String(on));
    } else if (ev.kind === 'step') {
      el.classList.remove('c-risk-auto');
      el.classList.remove('c-code-folding');
      el.classList.remove('c-excerpt-folding');
      el.classList.toggle('c-code-folded', !on && finished(ev.step || {}));
      el.classList.toggle('c-risk-folded', !on && finished(ev.step || {}));
      el.classList.toggle('c-excerpt-folded', !on && finished(ev.step || {}));
      patchStep(el, ev, ev, s.ctx);
    } else if (['think', 'irc', 'done', 'compaction', 'notice'].includes(ev.kind)) patchCard(el, ev, ev, s.ctx);
  }

  function seal(el, ev) {
    const s = state.get(el);
    s.reveal?.finish?.();
    s.reveal?.();
    el.classList.remove('c-running');
    watch(el, false);
    if (ev.kind === 'step') el.classList.add('c-settled');
  }

  for (const kind of ['user', 'think', 'step', 'group', 'done', 'compaction', 'notice', 'irc']) view.registerKind(kind, { create, patch: patchCard, expand, seal });

  // fold.js draws small thumbnails with the same lazy, crisp loading.
  window.r7Cards = { fileUrl, lazyImage, crisp };

  // Cross-row facts change only on events, never on animation frames.
  view.onChange(() => {
    const blocks = view.records();
    const pages = new Map();
    const byId = new Map(blocks.map(block => [block.id, block]));
    const children = new Map();
    for (const block of blocks) {
      if (block.kind === 'step' && block.ev.step?.web?.page) pages.set(normalizeUrl(block.ev.step.web.page.url), block.ev.step);
      if (block.kind === 'step' && block.ev.parent) {
        if (!children.has(block.ev.parent)) children.set(block.ev.parent, []);
        children.get(block.ev.parent).push(block.ev.step);
      }
    }
    for (const block of blocks) {
      if (!block.el) continue;
      const s = state.get(block.el);
      if (!s) continue;
      if (block.kind === 'group') {
        const rows = block.ev.members?.length ? block.ev.members.map(id => byId.get(typeof id === 'string' ? id : id.id)?.ev.step).filter(Boolean) : children.get(block.id) || [];
        patchGroup(block.el, block.ev, s.ctx, blocks, rows);
      }
      else if (block.kind === 'step' && block.ev.step?.web) {
        s.pages = pages;
        const web = block.el.querySelector('.c-web');
        rowIn = !s.instant;
        if (web) patch(web, webBlock(block.ev.step.web, pages).children);
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    view.root.classList.toggle('c-page-hidden', document.hidden);
    if (document.hidden) for (const block of view.blocks()) if (state.has(block.el)) finishMotion(block.el);
  });
  new MutationObserver(() => {
    if (view.root.hidden) for (const block of view.blocks()) if (state.has(block.el)) finishMotion(block.el);
  }).observe(view.root, { attributes: true, attributeFilter: ['hidden'] });
  view.root.classList.toggle('c-page-hidden', document.hidden);
})();
