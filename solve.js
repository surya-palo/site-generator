// A fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns, for one site's input, exactly the output tree
// makefun-site 1.0.0's build returns for that site: a JSON object of every
// path it writes and that file's text, byte for byte.
//
// Written from scratch against the behaviour stated in makefun-site's README
// (front matter, template dialect, Markdown subset, slug rule, report).
// No dependency, no I/O, no clock, no randomness: the output is a function
// of the input alone. Every case is answered alone: the per-case caches below
// (slug / long-date) are created fresh inside run() and never shared.
//
// Speed strategy, in order of payoff:
//  1. Markdown is one pass over the lines with no token objects, and inline
//     rendering scans plain runs in bulk instead of escaping one character
//     at a time; closers are found with indexOf plus a backslash-parity
//     check instead of a character scan.
//  2. Front matter is parsed from slices of the source, never by splitting
//     and re-joining the whole body.
//  3. slugify has an ASCII fast path (no NFKD / \p{M} work) and a per-case
//     cache; titles, tag names and headings repeat heavily.
//  4. Reading minutes are counted by a character scan, not by matching and
//     allocating an array of every word.
//  5. Templates render into one shared output array (no intermediate strings
//     per node / include / branch) and a post's card is built once and
//     reused for its page record.
//  6. Small helpers avoid regular expressions on hot paths.

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeReplacer = (c) => ESCAPES[c];

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, escapeReplacer);
}

// Set by run() per case: escaped forms of short strings, which repeat
// heavily across pages (titles, urls, dates) while long strings (excerpts,
// code bodies) are unique and bypass the cache.
let escCache = null;

function escapeHtmlCached(text) {
  if (text.length > 128) return escapeHtml(text);
  const hit = escCache.get(text);
  if (hit !== undefined) return hit;
  const out = escapeHtml(text);
  escCache.set(text, out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Set by run() per case: slug cache and long-date cache.
let slugCache = null;
let dateCache = null;

const NONASCII_RE = /[^\x00-\x7F]/;
const NONALNUM_RE = /[^a-z0-9]+/g;

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // The slug is the text lowercased with every run of non-alphanumerics
  // folded to one '-', no leading '-', cut to 64 characters with any
  // trailing '-' trimmed, 'untitled' when nothing is left. Non-ASCII text
  // is NFKD-normalised with its combining marks stripped first (so 'é'
  // folds to 'e'), exactly as the character loop did — the two C++
  // passes (toLowerCase + replace) do the same work faster.
  let out;
  if (NONASCII_RE.test(text)) out = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(NONALNUM_RE, '-');
  else out = text.toLowerCase().replace(NONALNUM_RE, '-');
  if (out.charCodeAt(0) === 45) out = out.slice(1);
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  dateCache.set(date, out);
  return out;
}

// JS \s, tested by code unit: the ASCII members directly, the rest by table.
function isWS(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xA0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200A) ||
    code === 0x2028 || code === 0x2029 || code === 0x202F || code === 0x205F ||
    code === 0x3000 || code === 0xFEFF;
}

const WS8 = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS8[c] = 1;

/** Words: runs of characters other than whitespace, counted, not collected. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // ASCII (the overwhelming case) is one table lookup, no call.
    if (c < 128 ? WS8[c] === 1 : isWS(c)) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        if (tags[i] === '' || !TAG_RE.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankFm(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * Works on slices: the body is never split and re-joined, and only the
 * front-matter region itself is split into lines.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  // Find the closing line: the first line exactly '---' after the first.
  let closeAt = -1; // index of the '\n' just before the closing line
  let bodyStart = -1;
  let search = nl;
  while (true) {
    const cand = text.indexOf('\n---', search);
    if (cand === -1) break;
    const after = cand + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeAt = cand;
      bodyStart = after === text.length ? text.length : after + 1;
      break;
    }
    search = cand + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const fmLines = text.slice(nl + 1, closeAt).split('\n');
  const data = {};
  for (let li = 0; li < fmLines.length; li++) {
    const line = fmLines[li];
    if (isBlankFm(line) || line.charCodeAt(0) === 35) continue; // blank or '#...'
    // key: value — key of [a-z_]+, ':', then either end or ' ' + rest.
    let i = 0;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if ((c >= 97 && c <= 122) || c === 95) i++;
      else break;
    }
    if (i === 0 || line.charCodeAt(i) !== 58) return { error: `line ${li + 2} is not "key: value"` };
    const key = line.slice(0, i);
    let raw;
    if (i + 1 === line.length) raw = '';
    else if (line.charCodeAt(i + 1) !== 32) return { error: `line ${li + 2} is not "key: value"` };
    else {
      raw = line.slice(i + 2);
      let e = raw.length;
      while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
      raw = raw.slice(0, e);
    }
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

// The characters a backslash escapes, by code unit.
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A match is escaped exactly when an odd run of backslashes
 * stands right before it (counted from `from`, where the scan starts).
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let count = 0;
    while (k >= from && s.charCodeAt(k) === 92) { count++; k--; }
    if (count % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let count = 0;
    while (k >= from && s.charCodeAt(k) === 92) { count++; k--; }
    if (count % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

// The characters that can start an inline construct or need HTML
// escaping. One regex, shared by every inline call: each call sets
// lastIndex to 0 on entry and to its resume position after every
// construct, so a recursive call (for a strong, emphasis or link's inner
// text) cannot disturb the caller's scan. A plain run between two
// matches holds no escapable character by construction, so it is
// appended raw — no escapeHtml call per run; the escapable characters
// themselves arrive as matches and are replaced by their entities here.
const SPECIAL_RE = /[\\`*\[&<>"']/g;

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let pos = 0;
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const i = m.index;
    const c = s[i];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (i > pos) out += s.slice(pos, i);
      out += ENTITIES[c];
      pos = i + 1;
      SPECIAL_RE.lastIndex = pos;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
        if (i > pos) out += s.slice(pos, i);
        const e = s[i + 1];
        out += ENTITIES[e] || e;
        pos = i + 2;
      } else {
        // Not an escape: the backslash is plain text, left in the run.
        SPECIAL_RE.lastIndex = i + 1;
        continue;
      }
      SPECIAL_RE.lastIndex = pos;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > pos) out += s.slice(pos, i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        pos = j + 1;
        SPECIAL_RE.lastIndex = pos;
      } else {
        // No closer: the backtick is plain text, left in the run.
        SPECIAL_RE.lastIndex = i + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > pos) out += s.slice(pos, i);
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          pos = j + 2;
          SPECIAL_RE.lastIndex = pos;
        } else {
          // No closer: '**' is plain text, left in the run.
          SPECIAL_RE.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > pos) out += s.slice(pos, i);
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        pos = j + 1;
        SPECIAL_RE.lastIndex = pos;
      } else {
        // No closer: '*' is plain text, left in the run.
        SPECIAL_RE.lastIndex = i + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const t = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = t === -1 ? '' : s.slice(k + 2, t);
    if (target !== '' && !WS_RE.test(target)) {
      if (i > pos) out += s.slice(pos, i);
      out += `<a href="${escapeHtmlCached(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      pos = t + 1;
      SPECIAL_RE.lastIndex = pos;
    } else {
      // Not a link: '[' is plain text, left in the run.
      SPECIAL_RE.lastIndex = i + 1;
    }
  }
  if (pos < n) out += s.slice(pos);
  return out;
}

// --- line classification over ranges (regex-free; mirrors the reference's patterns) ---
// Lines are (start, end) ranges in the source, end exclusive of the '\n'.
// Working on ranges skips the split: no per-line strings are built for
// lines the renderer only classifies, and the source is scanned once.
// Every helper bounds its reads by `b`: past a line's end it reads NaN,
// exactly as charCodeAt past a string's end does.

function isBlankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence line's language end index, or -1 when the line does not open one. */
function fenceLangEnd(src, a, b) {
  if (b - a < 3 || src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return -1;
  let i = a + 3;
  while (i < b) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < b) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return -1;
    i++;
  }
  return langEnd;
}

function isFenceCloseRange(src, a, b) {
  if (b - a < 3 || src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text range, or null (a heading's text is never empty). */
function headingRange(src, a, b) {
  let depth = 0;
  while (depth < 6 && a + depth < b && src.charCodeAt(a + depth) === 35) depth++;
  if (depth === 0) return null;
  let i = a + depth;
  let c = i < b ? src.charCodeAt(i) : NaN;
  if (c !== 32 && c !== 9) return null;
  while (c === 32 || c === 9) { i++; c = i < b ? src.charCodeAt(i) : NaN; }
  let end = b;
  while (end > i && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth, ts: i, te: end };
}

function isHrRange(src, a, b) {
  if (b - a < 3) return false;
  const c = src.charCodeAt(a);
  if (c !== 45 && c !== 42) return false;
  if (src.charCodeAt(a + 1) !== c || src.charCodeAt(a + 2) !== c) return false;
  for (let i = a + 3; i < b; i++) {
    const d = src.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Whether the line ends a paragraph: blank, a fence, a heading or a break. */
function endsPara(src, a, b) {
  const k = lineKind(src, a, b);
  return k === 1 || k === 2 || k === 3 || k === 4;
}

// Block kinds, by a line's first characters: 0 other, 1 blank, 2 fence,
// 3 heading, 4 thematic break, 5 blockquote, 6 bullet list, 7 ordered list.
function lineKind(src, a, b) {
  if (a === b) return 1;
  const c0 = src.charCodeAt(a);
  if (c0 === 96) return fenceLangEnd(src, a, b) !== -1 ? 2 : 0; // `
  if (c0 === 35) return headingRange(src, a, b) !== null ? 3 : 0; // #
  if (c0 === 45 || c0 === 42) { // - *
    if (isHrRange(src, a, b)) return 4;
    return a + 1 < b && src.charCodeAt(a + 1) === 32 ? 6 : 0;
  }
  if (c0 === 62) return 5; // >
  if (c0 >= 48 && c0 <= 57) {
    let d = 0;
    while (d < 9 && a + d < b && src.charCodeAt(a + d) >= 48 && src.charCodeAt(a + d) <= 57) d++;
    return d > 0 && a + d < b && src.charCodeAt(a + d) === 46 && a + d + 1 < b && src.charCodeAt(a + d + 1) === 32 ? 7 : 0;
  }
  if (c0 === 32 || c0 === 9) return isBlankRange(src, a, b) ? 1 : 0;
  return 0;
}

/** A list-start line's marker: { ordered, start, ts, te }, or null. */
function listMarkerRange(src, a, b) {
  const c0 = a < b ? src.charCodeAt(a) : NaN;
  if ((c0 === 45 || c0 === 42) && a + 1 < b && src.charCodeAt(a + 1) === 32) return { ordered: false, start: 1, ts: a + 2, te: b };
  let d = 0;
  while (d < 9 && a + d < b && src.charCodeAt(a + d) >= 48 && src.charCodeAt(a + d) <= 57) d++;
  if (d > 0 && a + d < b && src.charCodeAt(a + d) === 46 && a + d + 1 < b && src.charCodeAt(a + d + 1) === 32) {
    return { ordered: true, start: Number(src.slice(a, a + d)), ts: a + d + 2, te: b };
  }
  return null;
}

/** The range's text trimmed of spaces and tabs at both ends. */
function trimSlice(src, a, b) {
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return src.slice(a, b);
}

/** Whether the line continues a list item: two or more spaces, then a non-whitespace character. */
function continuedRange(src, a, b) {
  if (a + 1 >= b || src.charCodeAt(a) !== 32 || src.charCodeAt(a + 1) !== 32) return false;
  let i = a + 2;
  while (i < b && src.charCodeAt(i) === 32) i++;
  return i < b && !isWS(src.charCodeAt(i));
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (level 2 and 3
 * headings) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const n = src.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i <= n) {
    let e = src.indexOf('\n', i);
    if (e === -1) e = n;
    const kind = lineKind(src, i, e);
    if (kind === 1) { i = e + 1; continue; } // blank
    if (kind === 2) { // fence
      const lang = src.slice(i + 3, fenceLangEnd(src, i, e));
      const body = [];
      i = e + 1;
      while (i <= n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        if (isFenceCloseRange(src, i, e2)) { i = e2 + 1; break; }
        body.push(src.slice(i, e2));
        i = e2 + 1;
      }
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const inner = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${inner}</code></pre>\n`);
      continue;
    }
    if (kind === 3) { // heading
      const heading = headingRange(src, i, e);
      const text = src.slice(heading.ts, heading.te);
      const id = uniqueSlug(slugify(text), ids);
      const html = inline(text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i = e + 1;
      continue;
    }
    if (kind === 4) { blocks.push('<hr>\n'); i = e + 1; continue; } // thematic break
    if (kind === 5) { // blockquote
      const kept = [];
      while (i <= n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        if (i >= e2 || src.charCodeAt(i) !== 62) break;
        let cs = i + 1;
        if (cs < e2 && src.charCodeAt(cs) === 32) cs++;
        const t = trimSlice(src, cs, e2);
        if (t !== '') kept.push(t);
        i = e2 + 1;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    if (kind === 6 || kind === 7) { // a list
      const first = listMarkerRange(src, i, e);
      const isOrdered = first.ordered;
      const start = first.start;
      const items = [[trimSlice(src, first.ts, first.te)]];
      i = e + 1;
      while (i <= n) {
        let e2 = src.indexOf('\n', i);
        if (e2 === -1) e2 = n;
        const m = listMarkerRange(src, i, e2);
        if (m !== null && m.ordered === isOrdered) {
          items.push([trimSlice(src, m.ts, m.te)]);
          i = e2 + 1;
        } else if (continuedRange(src, i, e2)) {
          items[items.length - 1].push(trimSlice(src, i, e2));
          i = e2 + 1;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (let k = 0; k < items.length; k++) inner += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>\n`);
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimSlice(src, i, e)];
    i = e + 1;
    while (i <= n) {
      let e2 = src.indexOf('\n', i);
      if (e2 === -1) e2 = n;
      if (endsPara(src, i, e2)) break;
      body.push(trimSlice(src, i, e2));
      i = e2 + 1;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in `scope` ({ vars, parent }); `ctx` holds the parsed templates and the escape. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') out.push(escapeHtmlCached(v));
        else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
        else out.push(escapeHtml(textOf(v)));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        if (n.name === 'loop' || n.name === '__proto__') {
          // These names cannot take the reuse path: 'loop' would be
          // overwritten by the loop record, and '__proto__' by assignment
          // would set the prototype instead of an own property. Build the
          // scope exactly as the reference does, per element.
          for (let k = 0; k < xs.length; k++) {
            const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
            renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
          }
          break;
        }
        // One vars / loop / scope object per invocation of this for node,
        // mutated per element: iterations are sequential, and a re-entrant
        // rendering of the same template (through an include) is a fresh
        // invocation with fresh objects, so nothing is clobbered.
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const vars = { loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  escCache = new Map();

  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Most sources hold no carriage return at all: one indexOf skips the
    // regex replace for them (a lone \r is still normalised below).
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  // Link targets repeat heavily across the sources of one directory; the
  // resolution of (directory, relative target) is cached per case, in a
  // nested map so a lookup builds no key string. The broken-link report
  // is NOT cached: it names the linking source, so it is still added on
  // every call that finds its target unresolvable.
  const linkCache = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    let dirCache = linkCache.get(dir);
    if (dirCache === undefined) {
      dirCache = new Map();
      linkCache.set(dir, dirCache);
    }
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        if (rel === '') {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        let url = dirCache.get(rel);
        if (url === undefined) {
          const path = resolvePath(dir, rel);
          url = path !== null && bySource.has(path) ? bySource.get(path).url
            : path !== null && staticPaths.has(path) ? `${base}/${path}`
            : null;
          dirCache.set(rel, url);
        }
        if (url === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return `${url}${frag}`;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let k = 0; k < names2.length; k++) {
      const name = names2[k];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = [];
    for (let k = 0; k < names2.length; k++) {
      const name = names2[k];
      const slug = slugify(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = [];
  for (let i = 0; i < tags.length; i++) allTags.push({ name: tags[i].name, slug: tags[i].slug, url: tags[i].url, count: tags[i].posts.length });
  const recent = [];
  const recentN = input.site.recent;
  for (let i = 0; i < posts.length && i < recentN; i++) recent.push(cards.get(posts[i]));
  const ctx = { templates };
  // One root scope for the whole case: rendering is sequential, and a
  // lookup that misses a name reads undefined whether the key is absent or
  // set to undefined, so clearing a render's keys to undefined between
  // renders is exactly the same as a fresh vars object per render.
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: rootVars, parent: null };
  const render = (name, k1, v1, k2, v2) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    rootVars.page = undefined;
    rootVars.posts = undefined;
    rootVars.pager = undefined;
    rootVars.tag = undefined;
    if (k1 !== undefined) rootVars[k1] = v1;
    if (k2 !== undefined) rootVars[k2] = v2;
    const out = [];
    renderNodes(nodes, rootScope, ctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    let card = cards.get(s);
    if (card === undefined) card = cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, 'page', page);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per);
    const pcards = [];
    for (let i = 0; i < slice.length; i++) pcards.push(cards.get(slice[i]));
    const html = render('index', 'posts', pcards, 'pager', { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const tposts = [];
    for (let k = 0; k < t.posts.length; k++) tposts.push(cards.get(t.posts[k]));
    const html = render('tag', 'tag', { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tposts });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags');
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  slugCache = null;
  dateCache = null;
  escCache = null;
  return output;
}
