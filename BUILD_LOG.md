# BUILD_LOG — site-generator (site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0, written from scratch
against its stated behaviour. `solve.js` exports `run(input)`; `main.ts`
drives it over `/input/cases.json`.

## Approach

The reference is a pipeline of plugins over one build: sources → front
matter → permalinks → Markdown → collections → tags → layouts → report.
This entry keeps the pipeline's order and every rule, but reimplements each
stage for speed:

- **Markdown, one pass, no tokens.** Lines are classified once by a
  first-character dispatch (`blockKind`) and rendered straight to HTML.
  Inline rendering finds the next special character with one regex scan
  (`/[\\`*[]/g`, shared, `lastIndex` discipline across recursion) instead
  of walking every character in JS; strong / emphasis / link closers are
  found with `indexOf` plus a backslash-parity check (a match is escaped
  exactly when an odd run of backslashes stands right before it).
- **Front matter from slices.** Only the front-matter region is split into
  lines; the body is never split and re-joined.
- **Cached slugs and escapes.** `slugify` has an ASCII fast path (no NFKD /
  `\p{M}` work) and a per-case cache; short strings that repeat across
  pages (titles, urls, dates) are escaped once per case and cached.
  Template `{{ }}` values that are numbers or booleans skip escaping
  entirely (their text holds no special character).
- **Cheap word counts and dates.** Reading minutes are counted by a
  table-driven character scan, not by matching and allocating an array of
  every word; long dates are cached.
- **Low-allocation templates.** Templates render into one shared output
  array; one root scope serves the whole case; a `for` reuses one vars /
  loop / scope object per invocation, mutated per element (a re-entrant
  rendering through an include is a fresh invocation with fresh objects).
  A post's card is built once and reused for its page record. For-names
  `loop` and `__proto__` take a slow path that builds the scope exactly as
  the reference does, per element.

## Profiling (reference, 3 practice cases, instrumented copy)

| phase | case 1 | case 2 | case 3 |
|---|---|---|---|
| markdown | 168 ms | 130 ms | 244 ms |
| layouts | 30 ms | 113 ms | 40 ms |
| front matter | 6 ms | 5 ms | 7 ms |
| rest | ~5 ms | ~5 ms | ~5 ms |

Markdown was ~70% of the reference's `run()` time, layouts ~24%. The
profile's top costs were `escapeHtml` (called once per character by the
reference's inline renderer), the Markdown lexer/parser, and garbage
collection from token and word arrays.

## Measured speedup

Practice set, `run()` only, 3 cases, 15 interleaved rounds, same machine,
Node 24.22.1 (local dev machine; the grader's numbers will differ, the
ratio is what matters):

| | median | mean | min |
|---|---|---|---|
| reference (makefun-site 1.0.0) | 458.4 ms | 456.4 ms | 431.8 ms |
| this entry | 140.0 ms | 143.5 ms | 135.6 ms |
| **speedup** | **3.27x** | **3.18x** | **3.18x** |

Whole-process wall clock (`node main.ts` on the practice set, 3 runs each):
reference 983–1001 ms, this entry 488–558 ms. The wall gap is smaller than
the `run()` gap because both pay the same JSON parse of the 3 MB input and
stringify of the 7.4 MB answers plus Node startup.

Differential fuzz (fresh instances drawn with the kit's own generator from
random seeds, same-machine in-process timing of `run()` on 3 cases each):

| instance | mine | reference | speedup |
|---|---|---|---|
| 0 | 153.1 ms | 516.0 ms | 3.37x |
| 1 | 155.8 ms | 555.8 ms | 3.57x |
| 2 | 169.9 ms | 568.6 ms | 3.35x |
| 3 | 175.4 ms | 510.0 ms | 2.91x |
| 4 | 208.5 ms | 601.1 ms | 2.88x |
| 5 | 156.8 ms | 505.6 ms | 3.22x |
| 6 | 156.6 ms | 541.2 ms | 3.46x |
| 7 | 168.1 ms | 558.8 ms | 3.32x |

## Speedup round 2 (2026-11-23, after the first submission)

Four further optimisations, each A/B'd on the practice set and re-validated
(practice 3/3, edge cases, differential fuzz):

1. **Inline escaping folded into the regex scan** (`944b3b7`). The inline
   scanner's regex now also matches the five escapable characters, so a
   plain run between matches holds no escapable character and is appended
   raw instead of through `escapeHtml` per run. 144.7 → 126.5 ms median
   (1.144x). (The first regex written for this accidentally matched `]`
   too and produced bogus links; fixed by removing the stray `\]` from the
   character class and verified against the fuzz set.)
2. **CRLF fast path, per-directory link cache, no redundant toc copy**
   (`a8ddfa8`). Sources without a CR skip the line-ending regex; link
   resolutions are cached per (directory, relative target) in a nested
   Map so a lookup builds no key string; the page record reuses the toc
   objects instead of mapping them to fresh ones. A wash on median/mean,
   but the minimums consistently favoured the new version.
3. **slugify via C++ lowercasing and regex folding** (`1cfbe6d`). The JS
   character loop is replaced by `toLowerCase().replace(/[^a-z0-9]+/g,
   '-')` (non-ASCII text is still NFKD-normalised first, exactly as
   before). 1.5x faster per call on a micro-benchmark of real
   titles/tags/headings, 0 diffs; a wash on the full run because most
   slugify calls hit the per-case cache.
4. **Range-based Markdown rendering** (`162a29e`). `renderMarkdown` now
   walks (start, end) ranges in the source with `indexOf('\n')`,
   classifying lines by `charCodeAt` without building a per-line string
   for lines it only classifies; the `split` and the lines array are
   gone. The list-continuation check is a small `charCodeAt` scan (two
   spaces, then a non-whitespace character) instead of a regex test.
   120.9 → 118.7 ms median (1.019x).

Practice set after round 2, 25 interleaved rounds, same machine,
Node 24.22.1:

| | median | mean | min |
|---|---|---|---|
| reference (makefun-site 1.0.0) | 498.3 ms | 523.1 ms | 475.3 ms |
| this entry | 116.6 ms | 123.3 ms | 112.9 ms |
| **speedup** | **4.27x** | **4.24x** | **4.21x** |

Differential fuzz after round 2 (fresh seeds, 42 cases, 0 mismatches):
4.00–4.02x. Practice 3/3 identical, hand-built edge cases identical,
determinism 2x byte-identical.

## Correctness tests

- **Practice set: 3/3 cases identical** to the oracle (`practice/reference/expected.json`).
- **Differential fuzz: 42 fresh cases** (14 instances × 3 cases, drawn with
  the kit generator from random seeds), each compared against the oracle's
  expected answers: **0 mismatches**.
- **Hand-built edge cases: 9/9 identical**, covering: inline escapes,
  unmatched backticks/stars, nested strong/em, links (relative, absolute,
  fragment, scheme, climbing above root, to drafts/refusals/statics),
  fences (four backticks, spaced language, unclosed), headings (7 `#`,
  empty, trailing `##`), thematic breaks, setext underlines, blockquotes
  (tabs, empty lines), lists (10-digit numbers, 9-digit start,
  continuations, tab continuations), front-matter refusals (unclosed/stray
  quotes, bad dates incl. 2023-02-29 vs 2024-02-29, unknown/duplicate keys,
  bad tags/slug/layout/draft, missing title, unclosed front matter, no front
  matter, post without date, sources under `tags/`/`page/`), slugs
  (collisions, unicode NFKD, punctuation-only → `untitled`, 64-char cut,
  reserved words at root), template parse errors, recursive includes
  (depth cap), missing includes, standalone tag lines, static shadowing,
  CRLF sources, empty bodies, no-post index pages, duplicate heading ids,
  reading minutes at exactly 200/201 words.
- **For-name edge cases:** `{% for loop in posts %}` and
  `{% for __proto__ in posts %}` (including nested) with `posts` in scope:
  identical.
- **Determinism:** two runs produce byte-identical `answers.json`.

## Ideas tried and reverted (measured no gain)

- **Compiling templates to functions** (`new Function`, straight-line code
  with hoisted path constants): 1.013x vs the interpreter — the compile
  cost ate the render saving. Reverted to the node-walking renderer.
- **Merging HTML escaping into the inline scan** (nine character checks per
  character, entities written directly): slightly slower than one regex
  escape per plain run. Reverted. (Note: folding escaping into the C++
  regex scan, done in round 2, is different from per-character JS checks
  and did win.)
- **Null-prototype lookup optimisation** (round 2): replacing
  `Object.hasOwn` in `lookup()` with direct property access on
  prototype-free objects. 2–3x faster in an isolated micro-benchmark, but
  0.938x median on the full run — building objects via
  `Object.create(null)` plus sequential assignments costs more (hidden-
  class transitions) than the literal plus `hasOwn` it replaced. Reverted.
- **wordsOf regex variants** (round 2): char scan 332.7 ms vs `/\S+/g`
  exec-loop 638.9 ms vs `.match(/\S+/g)` 556.1 ms per 20 rounds over all
  1,070 practice bodies. The char scan stays.
- **inline() array+join vs `+=`** (round 2): array+join 372.0 ms vs `+=`
  228.7 ms per 10 rounds over 13,390 real paragraphs. `+=` stays (V8 cons
  strings are lazy).
- **resolvePath fast path** (round 2): clean relative targets joined
  directly without split/join. Only 16% of real link targets are clean,
  and the micro-benchmark showed no gain. Not adopted.

## History

- Implementation: single-pass Markdown, slice-based front matter, cached
  slugs, low-allocation template rendering.
- Optimisation 1: fused line classification, per-case escape cache,
  no-escape fast path for numbers/booleans in templates.
- Optimisation 2: regex-scan inline rendering (measured ~11% faster than
  the per-character loop).
- Speedup round 2 (2026-11-23): inline escaping folded into the regex
  scan; CRLF fast path + per-directory link cache + no redundant toc copy;
  slugify via C++ lowercasing and regex folding; range-based Markdown
  rendering. 3.27x → **4.27x** median on the practice set.
