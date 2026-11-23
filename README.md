[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/surya-palo/site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/surya-palo/site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator

A faster drop-in replacement for make.fun's own makefun-site 1.0.0, for the
[Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty. `solve.js` exports `run(input)`, which returns — byte for byte — the
output tree makefun-site 1.0.0's `build` returns for that site: every page's
`index.html`, the index and tag pages, `build-report.txt`, and each static
file. `main.ts` is the driver: it reads every case from `/input/cases.json`,
answers each one alone with `run`, and writes `/output/answers.json`.

## How it is faster

Written from scratch against makefun-site's stated behaviour (front matter,
template dialect, Markdown subset, slug rule, report). No dependency, no I/O,
no clock, no randomness — the output is a function of the input alone, and
every case is answered alone (the per-case caches are created fresh inside
`run()`).

- **Markdown in one pass.** No token objects: lines are classified once by a
  first-character dispatch and rendered straight to HTML. Inline rendering
  finds the next special character with a single regex scan instead of
  walking every character in JS, and closers for strong / emphasis / links
  are found with `indexOf` plus a backslash-parity check.
- **Front matter from slices.** Only the front-matter region is split into
  lines; the body is never split and re-joined.
- **Cached slugs and escapes.** `slugify` has an ASCII fast path (no NFKD /
  `\p{M}` work) and a per-case cache — titles, tag names and headings repeat
  heavily. Short strings that repeat across pages (titles, urls, dates) are
  escaped once per case and cached.
- **Cheap word counts and dates.** Reading minutes are counted by a table
  driven character scan, not by matching and allocating an array of every
  word; long dates are cached.
- **Low-allocation templates.** Templates render into one shared output
  array; one root scope serves the whole case; a `for` reuses one vars /
  loop / scope object per invocation, mutated per element (a re-entrant
  rendering through an include is a fresh invocation with fresh objects).
  A post's card is built once and reused for its page record.

Two optimisation ideas were tried and reverted after measuring no gain:
compiling templates to functions with `new Function` (the compile cost ate
the render saving), and merging HTML escaping into the inline scan (nine
character checks per character cost more than the escape calls saved).

## Correctness

- Practice set: **3/3 cases identical** to the oracle.
- Differential fuzz: **42 fresh cases** drawn from random seeds with the
  kit's own generator: **0 mismatches**.
- Hand-built edge cases: **9/9 identical**, plus a focused test of
  `{% for loop in ... %}` / `{% for __proto__ in ... %}` with `posts` in
  scope: identical.
- Determinism: two runs produce byte-identical `answers.json`.

See `BUILD_LOG.md` for the numbers.

## Layout

- `solve.js` — the entry: `run(input)`.
- `main.ts` — the driver.
- `package.json` — `{"type": "module"}`.
- `BUILD_LOG.md` — approach, profiling, measured speedup, test counts.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file for the agent wallet.
