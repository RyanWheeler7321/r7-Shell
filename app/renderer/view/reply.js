'use strict';

(() => {
  const view = window.r7View;
  const states = new WeakMap();
  const shortTables = new Set();
  const quiet = window.matchMedia('(prefers-reduced-motion: reduce)');
  // The red-phrase glow (reply.css) runs only in the focused window.
  const markFocus = () => document.documentElement.classList.toggle('r7-window-focused', document.hasFocus());
  window.addEventListener('focus', markFocus);
  window.addEventListener('blur', markFocus);
  markFocus();
  const tableObserver = new ResizeObserver(entries => {
    for (const { target } of entries) {
      const wrapped = [...target.querySelectorAll('tbody > tr')].some(row => row.getBoundingClientRect().height > 22.5 * (view.zoom || 1));
      target.classList.toggle('reply-table-wrapped', wrapped);
    }
  });
  view.onChange(() => {
    for (const table of shortTables) {
      if (table.isConnected) continue;
      tableObserver.unobserve(table);
      shortTables.delete(table);
    }
  });
  const month = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
  const money = /^[-+]?\$\d[\d,]*(?:\.\d+)?(?:\/\w+)?$/;
  const time = /^~?(?:\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*(?:s|sec|secs|seconds?|min|mins|minutes?|h|hrs?|hours?|days?|weeks?|years?)|\d{1,2}:\d{2}(?::\d{2})?\s*\/(?:mi|km)|sub[- ]?\d{1,2}(?::\d{2})?|(?:2[4-9]|[3-9]\d):\d{2}(?::\d{2})?)$/i;
  const date = new RegExp(`^(?:${month}(?:\\s+\\d{1,2})?(?:,?\\s*\\d{4})?|(?:19|20)\\d{2}|\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[ap]m)?)$`, 'i');
  const pathPattern = /^(?:[A-Za-z]:[\\/]|\\\\|~\/|\/|\.{1,2}\/)|^[\w.@+-]+(?:[\\/][\w.@+-]+)+\/?$/;
  const autoLink = /https?:\/\/[^\s<>]+|(?:[A-Za-z]:\\[^\s"'`<>|*?]+|(?:~\/|\/|\.\.?\/)[\w.@+\-/\\:]+|[\w.@+-]+(?:\/[\w.@+-]+)+)/g;

  function error(name, fields) {
    r7.log('error', `reply.${name}`, { session: cfg.session, ...fields });
  }

  function node(tag, cls, children = [], attrs = {}) {
    return { tag, cls, children, attrs };
  }

  function text(value) {
    return { tag: 'span', cls: 'reply-text', text: value, attrs: {} };
  }

  function plain(value) {
    return value.replace(/[`*_]/g, '').trim();
  }

  function link(label, target) {
    if (/^https?:\/\//i.test(target)) return node('a', 'reply-link', label, { href: target, 'data-address': target });
    if (/^file:\/\//i.test(target)) {
      try {
        const url = new URL(target);
        target = decodeURIComponent(url.pathname);
        if (url.hostname) target = `//${url.hostname}${target}`;
        else target = target.replace(/^\/([a-z]:\/)/i, '$1');
      } catch { return node('span', '', label); }
    }
    if (!/^[a-z][\w+.-]*:/i.test(target) || /^[a-z]:[\\/]/i.test(target)) {
      return node('a', 'reply-link reply-path', label, { 'data-path': target, 'data-address': target });
    }
    return node('span', '', label);
  }

  function linkedText(value) {
    const out = [];
    let from = 0;
    autoLink.lastIndex = 0;
    for (const match of value.matchAll(autoLink)) {
      const target = match[0].replace(/[.,:;)\]}'"]+$/, '').replace(/^(?!https?:)(.*?):\d+(?::\d+)?$/i, '$1');
      if (!target || (match.index && /[\w/.:~]/.test(value[match.index - 1]))) continue;
      if (!/^(?:https?:|[a-z]:|~|\/|\.)/i.test(target) && !/\.\w+$/.test(target)) continue;
      if (match.index > from) out.push(text(value.slice(from, match.index)));
      const found = link([text(target)], target);
      // A path or address typed into prose keeps the text colour, like the terminal; titled links wear the link colour.
      if (!/^https?:/i.test(target)) found.cls += ' reply-bare';
      out.push(found);
      from = match.index + target.length;
    }
    if (from < value.length) out.push(text(value.slice(from)));
    return out;
  }

  // Markdown is data: create text nodes, never inject source HTML.
  function inline(value, depth = 0, streaming = false) {
    if (depth > 12) return [text(value)];
    const out = [];
    let i = 0, start = 0;
    const flush = (end) => { if (end > start) out.push(...linkedText(value.slice(start, end))); };
    while (i < value.length) {
      if (value[i] === '\\' && /[\\`*_[\]()+!>#|~-]/.test(value[i + 1] || '')) {
        flush(i); out.push(text(value[i + 1])); i += 2; start = i; continue;
      }
      if (value[i] === '`') {
        const ticks = /^`+/.exec(value.slice(i))[0];
        const closing = value.indexOf(ticks, i + ticks.length);
        const end = closing < 0 && streaming ? value.length : closing;
        if (end >= 0) {
          flush(i);
          const code = value.slice(i + ticks.length, end);
          const cls = money.test(code) ? 'money' : time.test(code) ? 'time' : date.test(code) ? 'date' : 'code';
          const child = text(code);
          out.push(node('code', `reply-${cls}`, pathPattern.test(code) ? [link([child], code)] : [child]));
          i = end + ticks.length; start = i; continue;
        }
      }
      if (value[i] === '[' || (value[i] === '!' && value[i + 1] === '[')) {
        const image = value[i] === '!';
        const labelStart = i + (image ? 2 : 1);
        const labelEnd = value.indexOf('](', labelStart);
        if (labelEnd >= 0) {
          let end = labelEnd + 2, nesting = 1;
          for (; end < value.length; end++) {
            if (value[end] === '\\') { end++; continue; }
            if (value[end] === '(') nesting++;
            if (value[end] === ')' && --nesting === 0) break;
          }
          if (nesting === 0) {
            flush(i);
            const target = value.slice(labelEnd + 2, end).trim().replace(/^<(.+)>$/, '$1').replace(/\s+["'][^"']*["']$/, '');
            const label = inline(value.slice(labelStart, labelEnd), depth + 1);
            out.push(image ? node('span', 'reply-image-caption', label) : link(label, target));
            i = end + 1; start = i; continue;
          }
        }
      }
      const delimiter = value.startsWith('**', i) ? '**' : value.startsWith('__', i) ? '__' : value.startsWith('~~', i) ? '~~' : /[*_]/.test(value[i]) ? value[i] : null;
      if (delimiter && !(delimiter === '_' && /\w/.test(value[i - 1] || ''))) {
        const end = value.indexOf(delimiter, i + delimiter.length);
        if (end > i + delimiter.length) {
          flush(i);
          const tag = delimiter.length === 1 ? 'em' : delimiter === '~~' ? 'del' : 'strong';
          out.push(node(tag, tag === 'strong' ? 'reply-crucial' : '', inline(value.slice(i + delimiter.length, end), depth + 1)));
          i = end + delimiter.length; start = i; continue;
        }
        if (end < 0 && streaming) {
          flush(i);
          const tag = delimiter.length === 1 ? 'em' : delimiter === '~~' ? 'del' : 'strong';
          const content = inline(value.slice(i + delimiter.length), depth + 1, true);
          if (content.length) out.push(node(tag, tag === 'strong' ? 'reply-crucial' : '', content));
          start = i = value.length;
          continue;
        }
      }
      i++;
    }
    flush(value.length);
    return out;
  }

  function line(value, pairs, questionIndex, streaming = false) {
    const content = value => inline(value, 0, streaming);
    let match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(value);
    if (match) {
      const level = match[1].length;
      const option = /^(OPTION \d+:)\s*/.exec(match[2]);
      const body = option ? [node('span', 'reply-option', [text(option[1])]), text(' '), ...content(match[2].slice(option[0].length))] : content(match[2]);
      // Like the terminal: only the ## title is a title; ### and below keep their hashes.
      const children = level > 2 ? [text(`${match[1]} `), ...body] : body;
      return node(`h${level}`, `reply-heading${level === 2 ? ' reply-title' : ''}`, children);
    }
    if (/^(?:\*\*\*)+$|^(?:---+|___+)\s*$/.test(value.trim())) return node('hr', 'reply-rule');
    match = /^(ADJ|TUNE|SET|ADJusted|Tuned):(?:\s|$)/.exec(value);
    // Only the "ADJ:" lead is green; the rest of the line stays plain.
    if (match) return node('div', 'reply-line', [node('span', 'reply-adjust-label', [text(`${match[1]}:`)]), ...content(value.slice(match[0].length - (/\s$/.test(match[0]) ? 1 : 0)))]);
    match = /^(?:\*\*([A-Z][^*:`\n]{0,30}):\*\*|([A-Z][^*:`\n]{0,30}):)\s*$/.exec(value);
    if (match) return node('div', 'reply-line reply-group-label', [text(`${match[1] || match[2]}:`)]);
    match = /^“([^”]+)”\s*$/.exec(value);
    if (match) return node('div', 'reply-line reply-group-label', [text(match[1])]);
    match = /^(\s*)(\d*)\?\s+(.*)$/.exec(value);
    if (match) {
      const number = match[2] || String(questionIndex);
      return node('div', 'reply-line reply-question reply-hang', [node('span', 'reply-marker', [text(`${match[2]}?`)]), text(' '), ...content(match[3])], { 'data-question': number, 'data-answer': `${number}: `, role: 'button', tabindex: '-1', style: `--reply-hang:${match[2].length + 2}ch` });
    }
    match = /^(\s*)(\d+[.)]|[-*])\s+(.*)$/.exec(value);
    // The terminal draws every bullet as "- ".
    if (match) return node('div', `reply-line reply-list ${/^\d/.test(match[2]) ? 'reply-numbered' : 'reply-bullet'}`, [node('span', 'reply-marker', [text(/^\d/.test(match[2]) ? match[2] : '-')]), text(' '), ...content(match[3])], { style: `--reply-indent:${Math.min(12, match[1].length)}ch` });
    match = /^(\\?\+|[−–✓→▶✗◆○▸])\s+(.*)$/.exec(value);
    if (match) {
      const marker = match[1].replace('\\', '');
      const kinds = { '+': 'plus', '−': 'minus', '–': 'minus', '✓': 'done', '→': 'done', '▶': 'action', '✗': 'blocked', '◆': 'key', '○': 'plan', '▸': 'running' };
      const kind = kinds[marker];
      const children = [node('span', 'reply-marker', [text(marker)]), text(' ')];
      const label = /^(?:\*\*([^*:`\n]{1,24}):\*\*|([^*:`\n]{1,24}):)(\s.*|$)$/.exec(match[2]);
      if (label && (marker === '✓' || marker === '○')) {
        children.push(node('span', 'reply-item-label', [text(`${label[1] || label[2]}:`)]), ...content(label[3]));
      } else if (pairs && (kind === 'plus' || kind === 'minus')) {
        children.push(node('span', `reply-${kind === 'plus' ? 'new' : 'old'}`, [text(match[2].replace(/`([^`]+)`/g, '$1'))]));
      } else children.push(...content(match[2]));
      const stepped = marker === '○' && children.some(child => child.cls === 'reply-item-label');
      const result = node('div', `reply-line reply-${kind} reply-hang${stepped ? ' reply-stepped' : ''}`, children, { style: '--reply-hang:2ch' });
      // After a “Place” line, the text of every − / + line (and its indented continuations) keeps one color.
      if (pairs && (kind === 'plus' || kind === 'minus')) result.carry = kind === 'plus' ? 'reply-new' : 'reply-old';
      return result;
    }
    return node('div', 'reply-line', content(value));
  }

  function cells(value) {
    const row = value.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    const out = [];
    let part = '', ticks = '';
    for (let i = 0; i < row.length; i++) {
      if (row[i] === '\\' && row[i + 1] === '|') { part += '|'; i++; continue; }
      if (row[i] === '`') {
        const run = /^`+/.exec(row.slice(i))[0];
        if (!ticks) ticks = run; else if (ticks === run) ticks = '';
        part += run; i += run.length - 1; continue;
      }
      if (row[i] === '|' && !ticks) { out.push(part.trim()); part = ''; }
      else part += row[i];
    }
    out.push(part.trim());
    return out;
  }

  function numeric(raw) {
    const value = plain(raw);
    const clock = /^(?:sub[- ]?)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(\/mi|\/km)?$/i.exec(value);
    if (clock) return { value: clock[3] ? +clock[1] * 3600 + +clock[2] * 60 + +clock[3] : +clock[1] * 60 + +clock[2], unit: clock[4] ? `pace${clock[4].toLowerCase()}` : 'seconds' };
    if (!value || date.test(value)) return null;
    const match = /^[~≈<>≤≥]?\s*([-−+]?)([$€£]?)(\d[\d,]*(?:\.\d+)?)(?:\s*[–-]\s*[$€£]?(\d[\d,]*(?:\.\d+)?))?\s*([kMB]?)\s*(%|°C|°F|ms|s|min|h|KB|MB|GB|fps|RPM|W|x|×|\/yr|\/mo)?$/i.exec(value);
    if (!match) return null;
    let n = Number(match[3].replace(/,/g, ''));
    if (match[4]) n = (n + Number(match[4].replace(/,/g, ''))) / 2;
    if (/[-−]/.test(match[1])) n = -n;
    n *= { k: 1e3, M: 1e6, B: 1e9 }[match[5]] || 1;
    const unit = (match[2] || match[6] || '').toLowerCase();
    if (!unit && n >= 1900 && n <= 2100) return null;
    const scale = { ms: .001, s: 1, min: 60, h: 3600, kb: 1 / 1024, mb: 1, gb: 1024 }[unit];
    return { value: scale ? n * scale : n, unit: scale ? /^(kb|mb|gb)$/.test(unit) ? 'bytes' : 'seconds' : unit };
  }

  function mix(a, b, amount) {
    return `color-mix(in srgb, ${a} ${(100 * (1 - amount)).toFixed(2)}%, ${b})`;
  }

  function table(rows, align, hint, streaming = false) {
    const words = hint.split(/[\s,]+/).filter(Boolean);
    const flags = new Set(words.map(word => word.toLowerCase()));
    // Without `plain`, the first column reads as row labels: colored, with a divider after it (like the terminal).
    if (!flags.has('plain') && Math.max(...rows.map(row => row.length)) >= 2) { flags.add('label'); flags.add('split'); }
    const fills = ['plain', 'rows', 'zebra', 'cols', 'checker', 'fade', 'cross', 'twin', 'stripes', 'fadestripes', 'crossrows'];
    const fill = fills.find(word => flags.has(word)) || (rows.length > 4 ? 'rows' : 'plain');
    const count = Math.max(...rows.map(row => row.length));
    const values = rows.slice(1).map(row => Array.from({ length: count }, (_, c) => numeric(row[c] || '')));
    const columns = Array.from({ length: count }, (_, c) => {
      if (!c) return null;
      const filled = rows.slice(1).filter(row => (row[c] || '').trim() && !/^(—|-|n\/a|\?)$/i.test(row[c].trim()));
      const parsed = values.map(row => row[c]).filter(Boolean);
      if (parsed.length < 2 || parsed.length < Math.ceil(filled.length * .8) || new Set(parsed.map(v => v.unit)).size !== 1) return null;
      return { unit: parsed[0].unit, values: parsed.map(v => v.value) };
    });
    const scales = columns.map(col => {
      if (!col) return null;
      const pool = flags.has('each') ? col.values : columns.filter(other => other?.unit === col.unit).flatMap(other => other.values);
      const min = Math.min(...pool), max = Math.max(...pool);
      return max > min ? { min, max, strength: Math.min(1, (max - min) / (.1 * Math.max(Math.abs(max), 1e-9))) } : null;
    });
    const lastNumeric = columns.reduce((last, col, i) => col ? i : last, -1);
    const heat = flags.has('heat') || flags.has('rowheat');
    const heatBg = heat && (flags.has('bg') || flags.has('rowheat'));
    const bars = words.find(word => /^bars\d*$/i.test(word));
    const barWidth = Math.max(1, Math.min(80, Number(bars?.slice(4)) || 12));
    const heatColor = (r, c) => {
      const scale = scales[c], item = values[r - 1]?.[c];
      if (!heat || !scale || !item) return null;
      let amount = .5 + ((item.value - scale.min) / (scale.max - scale.min) - .5) * scale.strength;
      const direction = words.find(word => /^[+-].+/.test(word) && plain(rows[0][c] || '').toLowerCase().startsWith(word.slice(1).toLowerCase()));
      if (direction) {
        if (direction[0] === '-') amount = 1 - amount;
        return amount < .5 ? mix('var(--reply-minus)', 'var(--text)', amount * 2) : mix('var(--text)', 'var(--reply-plus)', (amount - .5) * 2);
      }
      return amount < .5 ? mix('var(--dim)', 'var(--text)', amount * 2) : mix('var(--text)', '#FF6FB5', (amount - .5) * 2);
    };
    const background = (r, c) => {
      if (!r) return '';
      const heatColumn = flags.has('rowheat') ? lastNumeric : c;
      const scale = scales[heatColumn], item = values[r - 1]?.[heatColumn];
      if (heatBg && flags.has('red') && scale && item) return mix('var(--bg)', 'var(--reply-red)', .55 * (item.value - scale.min) / (scale.max - scale.min));
      const hot = heatBg && heatColor(r, heatColumn);
      if (hot) return mix('var(--bg)', hot, .3);
      // Stripes use the terminal's panel colour (userMessageBg), lifted a little.
      const lift = mix('var(--user)', 'var(--dim)', .1);
      if (flags.has('focus')) return c === count - 1 ? lift : '';
      const down = rows.length > 2 ? (r - 1) / (rows.length - 2) : 0;
      const odd = (r - 1) % 2 === 1;
      if (fill === 'fade') return mix('var(--user)', 'var(--bg)', .15 + .85 * down);
      if (fill === 'cross') return mix('var(--user)', 'var(--bg)', c % 2 ? 1 - down : down);
      if (fill === 'twin') return mix('var(--user)', 'var(--bg)', c % 2 ? .4 + .6 * down : .6 * down);
      if (fill === 'stripes') return !c ? mix(lift, 'var(--bg)', down) : odd ? mix(lift, 'var(--bg)', .35) : '';
      if (fill === 'fadestripes') return !c ? mix(lift, 'var(--bg)', down) : mix(lift, 'var(--bg)', odd ? .55 * down : .7 + .165 * down);
      if (fill === 'crossrows') return mix(mix(lift, 'var(--bg)', c % 2 ? 1 - down : down), odd ? lift : 'var(--bg)', odd ? .5 : .35);
      return ((fill === 'rows' || fill === 'zebra') && odd) || (fill === 'cols' && c % 2) || (fill === 'checker' && (r - 1 + c) % 2) ? 'var(--user)' : '';
    };
    const body = [];
    let header;
    // Bar column: values share one width so every bar starts at the same x, header included.
    const valueChars = bars && lastNumeric >= 0 ? Math.max(...rows.map(row => [...plain(row[lastNumeric] || '')].length)) : 0;
    // Like the terminal: a column whose longest cell is 8 characters or less, or a number column, never wraps.
    const short = Array.from({ length: count }, (_, c) => !!columns[c] || Math.max(0, ...rows.map(row => [...plain(row[c] || '')].length)) <= 8);
    rows.forEach((row, r) => {
      if (!r && row.every(cell => !plain(cell))) return;
      const children = Array.from({ length: count }, (_, c) => {
        const hot = heatColor(r, c), bg = background(r, c);
        const style = [];
        if (bg) style.push(`background:${bg}`);
        if (hot && !heatBg) style.push(`color:${hot}`);
        const center = align[c]?.startsWith(':') && align[c]?.endsWith(':');
        const right = !align[c]?.startsWith(':') && (align[c]?.endsWith(':') || columns[c]);
        const barColumn = !!bars && lastNumeric === c;
        if ((center || right) && !barColumn) style.push(`text-align:${center ? 'center' : 'right'}`);
        // Stretched (full/half) tables keep these cells snug; the bar, else the first column, takes the extra width.
        const snug = barColumn ? 'reply-table-bars' : bars ? 'reply-table-fit' : columns[c] ? 'reply-table-num' : '';
        const cls = [short[c] ? 'reply-table-short' : '', !r ? 'reply-table-header' : '', flags.has('label') && c === 0 ? 'reply-table-label' : '', flags.has('split') && c === 0 ? 'reply-table-split' : '', hot ? 'reply-table-hot' : '', flags.has('focus') && c === count - 1 ? 'reply-table-focus' : '', snug].filter(Boolean).join(' ');
        let content = inline(row[c] || '', 0, streaming && r === rows.length - 1 && c === row.length - 1);
        if (barColumn) {
          const value = values[r - 1]?.[c];
          const top = columns[c].unit === '%' ? 100 : Math.max(...columns[c].values);
          const amount = value && top > 0 ? Math.min(1, Math.max(0, value.value / top)) : 0;
          content = [node('span', 'reply-bar-value', content, { style: `min-width:${valueChars}ch` }), node('span', `reply-bar${!r ? ' reply-bar-empty' : ''}`, [], { 'aria-hidden': 'true', style: `--reply-bar-width:${barWidth}ch;--reply-value-width:${valueChars}ch;--reply-bar-fill:${amount * 100}%;--reply-bar-color:${hot || 'var(--accent)'}` })];
        }
        return node(r ? 'td' : 'th', cls, content, { style: style.join(';'), ...(r ? {} : { scope: 'col' }) });
      });
      const tr = node('tr', '', children);
      if (r) body.push(tr); else header = node('thead', '', [tr]);
    });
    const tableClass = `reply-table${flags.has('rule') ? ' reply-table-rule' : ''}${flags.has('dim') ? ' reply-table-dim' : ''}`;
    const autoStripes = rows.length <= 4 && !fills.some(word => flags.has(word)) && !flags.has('focus') && !heatBg;
    const result = node('div', `reply-table-wrap${flags.has('full') ? ' reply-table-full' : flags.has('half') ? ' reply-table-half' : ''}`, [node('table', tableClass, [...(header ? [header] : []), node('tbody', '', body)], autoStripes ? { 'data-auto-stripes': 'true' } : {})], { 'data-table-hints': hint });
    result.beside = flags.has('beside');
    return result;
  }

  function parse(md, streaming) {
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let hint = '', pairs = false, questionIndex = 0, carry = '';
    for (let i = 0; i < lines.length; i++) {
      const start = i, value = lines[i];
      let item;
      if (!value.trim()) { pairs = false; carry = ''; questionIndex = 0; continue; }
      if (/^\s*\d*\?\s/.test(value)) questionIndex++;
      else questionIndex = 0;
      // The start line the terminal draws where a reply begins after tool rows.
      if (value.trim() === '<!-- reply:start -->') {
        item = node('hr', 'reply-start-line');
        item.key = `line-${start}`;
        item.attrs['data-source-line'] = String(start);
        out.push(item);
        continue;
      }
      const directive = /^\s*<!--\s*table:\s*(.*?)\s*-->\s*$/.exec(value);
      if (directive) { hint = directive[1]; continue; }
      if (/^\s*<!--.*-->\s*$/.test(value)) continue;
      const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(value);
      if (carry && /^\s{2,}\S/.test(value)) {
        // An indented line under a − / + pair line continues its wording, in the same color.
        item = node('div', 'reply-line', [node('span', carry, [text(value.replace(/`([^`\n]+)`/g, '$1'))])]);
        item.carry = carry;
      } else if (fence) {
        const code = [];
        while (++i < lines.length && !(lines[i].trim().startsWith(fence[1]) && new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i].trim()))) code.push(lines[i]);
        item = node('pre', 'reply-pre', [node('code', '', [text(code.join('\n'))])], { 'data-language': fence[2].trim() });
      } else if (/^\s*>/.test(value)) {
        const quote = [value.replace(/^\s*> ?/, '')];
        while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) quote.push(lines[++i].replace(/^\s*> ?/, ''));
        const copy = quote.join('\n');
        // Quoted lines draw their inline markup like the terminal (italic names, code); the copy stays the raw text.
        item = node('blockquote', 'reply-quote', quote.map((part, n) => node('div', 'reply-quote-line', part ? inline(part, 0, streaming && i + 1 >= lines.length && n === quote.length - 1) : [text('\u00a0')])), { 'data-copy': copy });
      } else if (i + 1 < lines.length && value.includes('|') && cells(lines[i + 1]).every(cell => /^:?-{2,}:?$/.test(cell))) {
        const align = cells(lines[++i]), rows = [cells(value)];
        while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].includes('|')) rows.push(cells(lines[++i]));
        item = table(rows, align, hint, streaming && i === lines.length - 1);
      } else {
        const picture = /^!\[([^\]]*)\]\(([^\s]+)\)\s*$/.exec(value);
        if (picture && (start === 0 || !lines[start - 1].trim()) && (i + 1 === lines.length || !lines[i + 1].trim()) && !/^[a-z][\w+.-]*:/i.test(picture[2].replace(/^[a-z]:[\\/]/i, ''))) {
          item = node('figure', 'reply-picture', [node('img', 'reply-picture-image', [], { 'data-path': picture[2], alt: picture[1], loading: 'lazy', decoding: 'async', draggable: 'false' }), node('figcaption', 'reply-picture-caption', inline(picture[1]))]);
        } else item = line(value, pairs, questionIndex, streaming && i === lines.length - 1);
        if (/^“[^”]+”\s*$/.test(value)) pairs = true;
      }
      hint = '';
      carry = item.carry || '';
      item.key = `line-${start}`;
      item.attrs['data-source-line'] = String(start);
      if (start > 0 && !lines[start - 1].trim()) item.cls += ' reply-spaced';
      if (item.beside && out.length && (out[out.length - 1].cls.includes('reply-table-wrap') || out[out.length - 1].cls === 'reply-tables')) {
        const previous = out.pop();
        const group = previous.cls === 'reply-tables' ? previous : node('div', 'reply-tables', [previous]);
        group.key = previous.key;
        group.children.push(item);
        out.push(group);
      } else out.push(item);
    }
    return out;
  }

  // Natural pixels stay crisp at the base device scale; window-fit zoom then scales pictures
  // with the rest of the composition instead of enlarging small images to compensate.
  const pictureSizes = new Map();
  function sizePicture(img) {
    const size = img._replyLoadedPath === img.dataset.path && img.naturalWidth && img.naturalHeight
      ? [img.naturalWidth, img.naturalHeight] : pictureSizes.get(img.dataset.path);
    if (!size) return;
    pictureSizes.set(img.dataset.path, size);
    img.width = size[0];
    img.height = size[1];
    img.style.setProperty('--pw', String(size[0]));
    img.style.setProperty('--ph', String(size[1]));
    img.style.setProperty('--ps', String((cfg.deviceScale || window.devicePixelRatio || 1) * (window.r7Zoom?.get('page') || 1)));
  }

  function sizePictures() {
    for (const img of document.querySelectorAll('#view .reply-picture-image')) sizePicture(img);
  }
  // Moving to another screen or zooming the page changes the device pixels per CSS pixel.
  window.addEventListener('resize', sizePictures);
  window.addEventListener('r7-zoom', sizePictures);

  function fileUrl(win) {
    const path = win.replace(/\\/g, '/');
    if (path.startsWith('//')) return `file://${path.slice(2).split('/').map(encodeURIComponent).join('/')}`;
    return 'file:///' + path.split('/').map((part, index) => index ? encodeURIComponent(part) : part).join('/');
  }

  async function loadPicture(el, path) {
    try {
      const win = await r7.checkPath(path, cfg.cwd, cfg.home);
      if (el.dataset.path !== path) return;
      if (!win) throw new Error('Picture file not found');
      const version = await r7.fileVersion(path);
      if (el.dataset.path !== path) return;
      el.dataset.winPath = win;
      el.src = fileUrl(win) + (version ? `?v=${encodeURIComponent(version)}` : '');
    } catch (err) {
      if (el.dataset.path === path) el.classList.add('reply-picture-error');
      error('image_error', { path, error: String(err) });
    }
  }

  // Each new piece plays one entrance without retiming text on later patches.
  const EASE = 'cubic-bezier(.16,1,.3,1)';

  function playPiece(el, frames, options) {
    const ease = options.easing || 'ease-out';
    const steps = frames.map(frame => ({ easing: ease, ...frame }));
    el.animate(steps, { duration: options.duration, delay: options.delay || 0, easing: 'linear', fill: 'backwards', pseudoElement: options.pseudo });
  }

  function newFresh() {
    return { tops: [], tables: [], rows: [], cells: [], bars: [], markers: [] };
  }

  function setSplit(table) {
    const wrap = table.parentElement;
    const cell = table.querySelector('th, td');
    if (!wrap?.isConnected || !cell) return;
    wrap.style.setProperty('--split-x', `${table.offsetLeft + cell.offsetLeft + cell.offsetWidth - 1}px`);
  }

  function arrive(state) {
    const fresh = state.fresh;
    state.fresh = newFresh();
    const left = Math.max(0, 800 - (performance.now() - state.arrivalAt));
    const play = (el, frames, options) => {
      const end = options.duration + (options.delay || 0);
      if (!left || !end) return;
      const scale = Math.min(1, left / end);
      playPiece(el, frames, { ...options, duration: options.duration * scale, delay: (options.delay || 0) * scale });
    };
    // Top-level pieces rise in with a stagger that never passes 300ms, however many arrive together.
    const step = fresh.tops.length > 1 ? Math.min(60, 300 / (fresh.tops.length - 1)) : 0;
    fresh.tops.forEach((el, i) => {
      const kind = el.classList;
      if (kind.contains('reply-heading')) {
        play(el, [{ clipPath: 'inset(0 100% 0 0)', opacity: .5 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], { duration: 300, easing: EASE });
      } else if (!kind.contains('reply-table-wrap') && !kind.contains('reply-tables') && !kind.contains('reply-picture')) {
        play(el, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 250, delay: step * i, easing: EASE });
      }
    });
    const measure = [];
    for (const table of fresh.tables) {
      if (!table.querySelector('.reply-table-split')) continue;
      for (const cell of table.querySelectorAll('.reply-table-split')) play(cell, [{ borderRightColor: 'transparent', offset: 0 }], { duration: 330 });
      play(table.parentElement, [{ transform: 'scaleY(0)', opacity: 1, offset: 0 }, { transform: 'scaleY(1)', opacity: 1, offset: .6 }, { transform: 'scaleY(1)', opacity: 0, offset: 1 }], { duration: 540, pseudo: '::after' });
      measure.push(table);
    }
    if (measure.length) requestAnimationFrame(() => measure.forEach(setSplit));
    // Table delays scale with the real row and column counts: no cell starts after 500ms.
    const groups = new Map();
    for (const row of fresh.rows) {
      if (row.parentElement?.localName !== 'tbody') continue;
      if (!groups.has(row.parentElement)) groups.set(row.parentElement, []);
      groups.get(row.parentElement).push(row);
    }
    const rowAt = new Map();
    for (const [body, rows] of groups) {
      const lead = fresh.tables.includes(body.parentElement);
      const rowStep = rows.length > 1 ? Math.min(70, 140 / (rows.length - 1)) : 0;
      const cellStep = rows.length > 1 ? Math.min(65, 130 / (rows.length - 1)) : 0;
      rows.forEach((row, i) => {
        play(row, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: (lead ? 200 : 0) + rowStep * i });
        rowAt.set(row, { lead, cellDelay: (lead ? 220 : 40) + cellStep * i });
      });
    }
    const cellAt = new Map();
    for (const cell of fresh.cells) {
      const head = cell.localName === 'th';
      const info = rowAt.get(cell.parentElement);
      const columns = cell.parentElement.children.length;
      const colStep = columns > 1 ? Math.min(75, 150 / (columns - 1)) : 0;
      const delay = head ? 100 : info ? info.cellDelay + colStep * cell.cellIndex : 0;
      cellAt.set(cell, delay);
      for (const child of cell.children) {
        play(child, [{ clipPath: 'inset(0 100% 0 0)', opacity: .3 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], { duration: head ? 240 : 300, delay, easing: head ? 'ease-out' : 'cubic-bezier(.2,.7,.3,1)' });
      }
    }
    for (const bar of fresh.bars) {
      const delay = Math.min(380, Math.round(cellAt.get(bar.parentElement) || 0));
      const scale = Math.min(1, left / (420 + delay));
      bar.style.animationDelay = `${delay * scale}ms`;
      bar.style.animationDuration = `${420 * scale}ms`;
    }
    for (const marker of fresh.markers) {
      const kind = marker.parentElement?.classList;
      if (kind?.contains('reply-done')) {
        play(marker, [{ clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 250, delay: 150 });
      } else if (kind?.contains('reply-key')) {
        play(marker, [{ opacity: 0, transform: 'rotate(-110deg) scale(.3)', offset: 0 }, { opacity: 1, transform: 'rotate(12deg) scale(1.15)', offset: .65 }, { opacity: 1, transform: 'rotate(0deg) scale(1)', offset: 1 }], { duration: 440, delay: 160, easing: EASE });
      } else if (kind?.contains('reply-action')) {
        play(marker, [{ opacity: 0, transform: 'translateX(-20px) scale(.5)', offset: 0 }, { opacity: 1, transform: 'translateX(4px) scale(1.1)', offset: .55 }, { opacity: 1, transform: 'translateX(0) scale(1)', offset: 1 }], { duration: 460, delay: 200, easing: EASE });
      }
    }
  }

  // A picture reveals once when it first loads: a short shutter, brightness and clarity settling,
  // and one soft light pass (a figure pseudo-element sized to the image). Nothing stays applied.
  function revealPicture(img) {
    if (quiet.matches || !img.isConnected) return;
    const settled = 'brightness(1) contrast(1) saturate(1) blur(0px)';
    const round = 'round 10px';
    img.animate([
      { clipPath: `inset(45% 0 45% 0 ${round})`, opacity: .2, filter: 'brightness(1.5) contrast(.85) saturate(.8) blur(2px)' },
      { clipPath: `inset(0px 0px 0px 0px ${round})`, opacity: 1, filter: settled },
    ], { duration: 480, easing: EASE });
    const figure = img.parentElement;
    if (!figure) return;
    figure.style.setProperty('--sheen-x', `${img.offsetLeft}px`);
    figure.style.setProperty('--sheen-y', `${img.offsetTop}px`);
    figure.style.setProperty('--sheen-w', `${img.offsetWidth}px`);
    figure.style.setProperty('--sheen-h', `${img.offsetHeight}px`);
    const clear = () => ['x', 'y', 'w', 'h'].forEach(axis => figure.style.removeProperty(`--sheen-${axis}`));
    const pass = figure.animate([
      { opacity: 0, backgroundPosition: '130% 0', offset: 0 },
      { opacity: 1, offset: .25 },
      { opacity: 1, offset: .7 },
      { opacity: 0, backgroundPosition: '-30% 0', offset: 1 },
    ], { duration: 500, delay: 180, easing: 'ease-in-out', fill: 'backwards', pseudoElement: '::after' });
    pass.onfinish = clear;
    pass.oncancel = clear;
  }

  function patchChildren(parent, desired, state) {
    const old = new Map([...parent.children].map(child => [child._replyKey, child]));
    for (let i = 0; i < desired.length; i++) {
      const spec = desired[i];
      const key = spec.key || String(i);
      const previous = old.get(key);
      let el = previous?.localName === spec.tag && (previous._replyText !== undefined) === (spec.text !== undefined) ? previous : null;
      const created = !el;
      if (created) { el = document.createElement(spec.tag); el._replyKey = key; }
      if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null);
      patchNode(el, spec, state, created, parent === state.root);
    }
    while (parent.children.length > desired.length) {
      parent.lastElementChild.remove();
    }
  }

  function patchNode(el, spec, state, created, top) {
    if (el._replyClass !== spec.cls) {
      for (const cls of (el._replyClass || '').split(' ').filter(Boolean)) el.classList.remove(cls);
      for (const cls of spec.cls.split(' ').filter(Boolean)) el.classList.add(cls);
      el._replyClass = spec.cls;
    }
    const previous = el._replyAttrs || {};
    for (const key of Object.keys(previous)) if (!(key in spec.attrs)) el.removeAttribute(key);
    for (const [key, value] of Object.entries(spec.attrs)) if (previous[key] !== value) el.setAttribute(key, value);
    el._replyAttrs = spec.attrs;
    if (spec.text !== undefined) {
      if (el._replyText !== spec.text) {
        const previousText = el._replyText;
        el._replyText = spec.text;
        if (previousText !== undefined && spec.text.startsWith(previousText) && state.live) {
          // Fade only the new run, never hide or replay the words already on screen.
          const tail = document.createElement('span');
          tail.className = 'reply-stream';
          tail.textContent = spec.text.slice(previousText.length);
          el.append(tail);
          const animation = tail.animate([{ opacity: .3 }, { opacity: 1 }], {
            duration: 120, easing: 'ease-out',
          });
          const settle = () => {
            if (tail.parentNode !== el) return;
            tail.replaceWith(document.createTextNode(tail.textContent));
            el.normalize();
          };
          animation.onfinish = settle;
          animation.oncancel = settle;
        } else {
          el.textContent = spec.text;
          let top = el;
          while (top.parentElement && top.parentElement !== state.root) top = top.parentElement;
          const cell = el.closest('td, th');
          if (created && state.live && !state.fresh.tops.includes(top) && (!cell || cell._replyDrawn)) {
            el.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
          }
        }
      }
      return;
    }
    if (spec.tag === 'img') {
      if (el._replyPath !== spec.attrs['data-path']) {
        el._replyPath = spec.attrs['data-path'];
        sizePicture(el);
        if (created) el._replyReveal = !state.instant;
        el.addEventListener('error', () => { el.classList.add('reply-picture-error'); error('image_error', { path: el.dataset.path }); }, { once: true });
        el.addEventListener('load', () => {
          el._replyLoadedPath = el.dataset.path;
          sizePicture(el);
          if (el._replyReveal) { el._replyReveal = false; revealPicture(el); }
        });
        loadPicture(el, el._replyPath);
      }
      return;
    }
    if (created && !state.instant) {
      if (top) state.fresh.tops.push(el);
      else if (spec.tag === 'table') state.fresh.tables.push(el);
      else if (spec.tag === 'tr') state.fresh.rows.push(el);
      else if (spec.cls === 'reply-marker') state.fresh.markers.push(el);
    }
    // A bar built live grows in from empty, as its cell sweeps in (arrive() sets the delay).
    if (spec.cls.includes('reply-bar') && !el._replyGrown) {
      el._replyGrown = true;
      if (!state.instant) {
        el.classList.add('reply-bar-grow');
        state.fresh.bars.push(el);
      }
    }
    patchChildren(el, spec.children, state);
    // A cell sweeps in once, when its content first appears; later growth never restarts it.
    if ((spec.tag === 'td' || spec.tag === 'th') && !el._replyDrawn && el.children.length) {
      el._replyDrawn = true;
      if (!state.instant) state.fresh.cells.push(el);
    }
    if (spec.tag === 'table') {
      if (spec.attrs['data-auto-stripes'] && !shortTables.has(el)) {
        shortTables.add(el);
        tableObserver.observe(el);
      } else if (!spec.attrs['data-auto-stripes'] && shortTables.delete(el)) {
        tableObserver.unobserve(el);
        el.classList.remove('reply-table-wrapped');
      }
    }
  }

  function render(el, ev, ctx) {
    const state = states.get(el);
    try {
      const before = state.md;
      if (ev.op === 'append') {
        if (typeof ev.text === 'string') state.md = ev.text;
        else if (typeof ev.md === 'string') state.md = ev.md;
        else {
          const offset = ev.offset ?? before.length;
          if (!Number.isInteger(offset) || offset < 0 || offset > before.length) {
            error('append_error', { id: ev.id, offset, length: before.length });
            return;
          }
          const chunk = String(ev.chunk ?? '');
          state.md = before.slice(0, offset) + chunk + before.slice(offset + chunk.length);
        }
      } else state.md = ev.md ?? ev.text ?? state.md;
      if (typeof state.md !== 'string') throw new Error('Reply markdown must be a string');
      const sealed = ev.op === 'seal' || ev.state === 'done' || ev.sealed === true;
      const first = !el.childElementCount;
      // Text shows at once; each newly built piece plays its entrance when it arrives, streaming
      // or complete, and the seal replays nothing. Backlog and hidden windows show instantly.
      state.live = !(ctx?.instant || ctx?.replay || document.hidden || quiet.matches);
      state.instant = !state.live;
      if (!state.instant && state.arrivalAt === null) state.arrivalAt = performance.now();
      if (state.arrivalAt !== null && performance.now() - state.arrivalAt >= 800) state.instant = true;
      if (state.md !== before || sealed !== state.sealed || first) {
        patchChildren(el, parse(state.md, !sealed), state);
        arrive(state);
      }
      state.sealed = sealed;
      el.dataset.sealed = String(sealed);
    } catch (err) {
      // One line per failing reply; later chunks of the same reply stay quiet.
      if (state.failed) return;
      state.failed = true;
      error('render_error', { id: ev.id, error: String(err?.stack || err) });
    }
  }

  view.registerKind('reply', {
    revealSealed: true,
    create(ev, ctx) {
      const el = document.createElement('article');
      el.className = 'reply';
      states.set(el, { md: '', instant: false, root: el, fresh: newFresh(), arrivalAt: null });
      render(el, ev, ctx);
      return el;
    },
    patch(el, ev, prev, ctx) { render(el, ev, ctx); },
    seal(el, ev) { render(el, { ...ev, op: 'seal' }, { instant: true }); },
  });
})();
