# Plan 002: Pin down `buildPrompt` output with characterization tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from `C:\extention`:
> `git diff --stat 0e4e1a3..HEAD -- frontend/jevelements/src/shared/prompt.ts frontend/jevelements/src/shared/types.ts frontend/jevelements/src/shared/kit.ts`
> If any of these changed, compare the excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md (needs `pnpm test` / `tsx --test` and `tsconfig.test.json` in `frontend/jevelements`)
- **Category**: tests
- **Planned at**: commit `0e4e1a3`, 2026-10-07

## Why this matters

JevElements captures a section of a website and turns it into `PROMPT.md`, which a coding agent then follows to rebuild that section. `frontend/jevelements/src/shared/prompt.ts` (about 1,290 lines, around 30 section builders) produces that prompt, and it has no tests. Plan 003 changes how page text is escaped and fenced inside it. Without a baseline, nobody can tell whether such an edit changed only what it meant to. This plan adds characterization tests that record what the prompt looks like today:
- full-output snapshots for two fixtures,
- targeted assertions for the behaviours most likely to regress.

It changes no product code.

## Current state

- `frontend/jevelements/src/shared/prompt.ts:209`: `export function buildPrompt(capture: Capture): string` is the module's only export. Its imports are pure, so it runs under Node:
  ```ts
  import { componentNames, kitBase, projectName, readableName } from './kit'
  import { isWgsl } from './shader'
  import type { Asset, AssetLook, Capture, /* … */ } from './types'
  ```
- Sections are pushed in a fixed order and joined with blank lines (`prompt.ts:232-428`). The headings always present are `# Task: Recreate this UI section 1:1`, `## Source`, `## Stack & output`, `## Structure & exact styles` and `## Acceptance checklist`. Others are conditional: `## SVGs`, `## Canvas source code (from the page's scripts)`, `## Interactions (hover & click, played on the live page)`, `## Animation & motion`, `## Images & video…`, and more.
- Size budgets (`prompt.ts:103-109`):
  ```ts
  const INLINE_SVG_MAX = 40_000 // chars per SVG shown inline
  const INLINE_SVG_BUDGET = 250_000
  const INLINE_DATA_MAX = 2_000
  const INLINE_SHADER_MAX = 24_000
  const INLINE_SHADER_BUDGET = 120_000
  const INLINE_LOTTIE_MAX = 30_000
  const TOO_LARGE = 'too large to paste — match it from the screenshot'
  ```
- The SVG section (`prompt.ts:1276-1288`) inlines markup up to `INLINE_SVG_MAX` inside a ```` ```svg ```` fence; anything larger becomes `<size>, too large to paste …`.
- The `Capture` type is in `frontend/jevelements/src/shared/types.ts:474-512`. Required fields: `id, url, title, capturedAt, selector, viewport {w,h,dpr}, root (CapturedNode), assets, fonts, responsive, keyframes, animations, libraries, embeds, pageMedia, nodeCount, hiddenNodes, truncated, unreadableStylesheets`. Some optional fields used below:
  ```ts
  // types.ts
  export interface CapturedNode { tag: string; id?: string; classes?: string[]; attrs: Record<string, string>; text?: string; box: Box; styles: Record<string, string>; /* …optional… */ children: CapturedNode[] }
  export interface Asset { kind: 'image' | 'background' | 'mask' | 'video' | 'poster' | 'svg' | 'canvas'; src: string; target: string; alt?: string; width: number; height: number; /* … */ }
  export interface Library { name: string; version?: string }
  export interface CodeRef { url: string; file?: string; reasons: string[]; shaders: string[]; excerpt?: string; unreachable?: string[]; size: number; text?: string }
  export interface Interaction { kind: 'hover' | 'click'; target: string; text?: string; similar: number; signal: string; changes: string[]; appeared: string[]; disappeared: string[]; animations: string[]; restored: boolean; /* optional: phases, layers, state */ }
  export interface InteractionReport { tested: { hover: number; click: number }; skipped: string[]; navigates?: string[]; items: Interaction[]; components?: ComponentStates[]; media?: Asset[] }
  export interface SavedFiles { files: Record<string, string>; uploaded: string[]; archive?: string; screenshot?: string; failed: { src: string; reason: string }[]; fonts?: Record<string, string>; fontsFailed?: { src: string; reason: string }[] }
  ```
- Test harness from plan 001: tests live in `frontend/jevelements/test/unit/*.test.ts`, run with `pnpm test` (`tsx --test "test/unit/**/*.test.ts"`), typechecked by `tsconfig.test.json`. Look at `test/unit/kit.test.ts` from plan 001 for the house style: `import { test } from 'node:test'`, `assert` from `node:assert/strict`, no semicolons, single quotes.
- Node 24's `node:test` supports snapshots: `t.assert.snapshot(value)` inside `test('…', (t) => { … })`. Snapshots are written to `<testfile>.snapshot` next to the test when run with `--test-update-snapshots`. This was checked on this machine with tsx 4.23 and Node v24.14.0.

## Commands you will need

Run in `frontend/jevelements/`:

| Purpose | Command | Expected on success |
|---|---|---|
| Write/refresh snapshots | `pnpm exec tsx --test --test-update-snapshots test/unit/prompt.test.ts` | exit 0, creates `test/unit/prompt.test.ts.snapshot` |
| Tests | `pnpm test` | `ℹ fail 0` |
| All gates | `pnpm verify` | exit 0 |

## Scope

**In scope**:
- `frontend/jevelements/test/unit/fixtures.ts` (create): fixture builders
- `frontend/jevelements/test/unit/prompt.test.ts` (create)
- `frontend/jevelements/test/unit/prompt.test.ts.snapshot` (generated)

**Out of scope**:
- `src/shared/prompt.ts` and every other `src/` file. This plan records behaviour and does not change it. Plan 003 changes prompt wording; don't anticipate it.
- Recording a real capture from a live site. The fixtures are hand-built so they stay small and readable.

## Git workflow

- Branch: `advisor/002-prompt-characterization-tests`
- Commit message style: plain imperative sentence, e.g. `Add characterization tests for buildPrompt`.
- Do not push or open a PR unless told to.

## Steps

### Step 1: Fixture builders

Create `test/unit/fixtures.ts`:
```ts
import type { Capture, CapturedNode } from '../../src/shared/types'

export function node(partial: Partial<CapturedNode> & Pick<CapturedNode, 'tag'>): CapturedNode {
  return {
    attrs: {},
    box: { x: 0, y: 0, w: 200, h: 40 },
    styles: {},
    children: [],
    ...partial,
  }
}

// The smallest capture buildPrompt accepts: a <section> with a heading and a button.
export function minimalCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    url: 'https://example.com/',
    title: 'Example',
    capturedAt: '2026-01-01T00:00:00.000Z',
    selector: 'section#hero',
    viewport: { w: 1440, h: 900, dpr: 2 },
    root: node({
      tag: 'section',
      id: 'hero',
      box: { x: 0, y: 0, w: 1440, h: 600 },
      styles: { display: 'flex', 'flex-direction': 'column' },
      children: [
        node({ tag: 'h1', text: 'Ship faster', styles: { 'font-size': '56px' } }),
        node({ tag: 'a', classes: ['cta'], attrs: { href: '/start' }, text: 'Get started' }),
      ],
    }),
    assets: [],
    fonts: [],
    responsive: [],
    keyframes: [],
    animations: [],
    libraries: [],
    embeds: [],
    pageMedia: [],
    nodeCount: 3,
    hiddenNodes: 0,
    truncated: false,
    unreadableStylesheets: 0,
    ...overrides,
  }
}
```
Then add `richCapture()`. It returns `minimalCapture({...})` plus:
- `libraries: [{ name: 'GSAP', version: '3.12.5' }]`
- `assets`:
  - one `svg` asset `{ kind: 'svg', src: '<svg viewBox="0 0 10 10"><circle r="5"/></svg>', target: 'svg.logo', width: 10, height: 10 }`
  - one `image` asset `{ kind: 'image', src: 'https://example.com/hero.png', target: 'img.hero', alt: 'Hero', width: 800, height: 400 }`
- `saved: { files: { 'https://example.com/hero.png': 'hero.png' }, uploaded: ['capture/hero.png'], failed: [] }`
- `interactions` with:
  - `tested: { hover: 1, click: 1 }`, `skipped: []`
  - two items, each with all required fields:
    - a hover on `a.cta` with `text: 'Get started'` and `changes: ['color: rgb(0, 0, 0) → rgb(255, 0, 0)']`
    - a click on `button.tab` with `text: 'Pricing'` and `appeared: ['div.panel "Plans"']`
- `code: [{ url: 'https://example.com/app.js', reasons: ['GLSL shaders'], shaders: ['void main() { gl_FragColor = vec4(1.0); }'], excerpt: 'createCanvas({color:"#f00"})', size: 2048 }]`
- `embeds: [{ kind: 'WebGL canvas', target: 'canvas.bg', box: { x: 0, y: 0, w: 1440, h: 600 }, detail: 'webgl2' }]`

If `tsc` rejects a field, fix the fixture to satisfy the type, and keep the intent (a hover, a click, an SVG, a saved image, a code ref, a library).

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Write `prompt.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt } from '../../src/shared/prompt'
import { minimalCapture, richCapture } from './fixtures'

const headings = (prompt: string) => prompt.split('\n').filter((line) => /^#{1,2} /.test(line))
```
Add the tests listed in **Test plan**. For the heading-order tests, first print `headings(buildPrompt(minimalCapture()))` once (a temporary `console.log`), then paste the actual list into a `deepEqual` assertion and remove the log. This records current behaviour; it does not specify new behaviour.

**Verify**: `pnpm test` → the new tests fail only because the snapshot file is missing. Every non-snapshot assertion passes.

### Step 3: Generate snapshots

Run `pnpm exec tsx --test --test-update-snapshots test/unit/prompt.test.ts`.

Open `test/unit/prompt.test.ts.snapshot` and check by reading it:
1. It contains the `# Task: Recreate this UI section 1:1` heading.
2. It contains `https://example.com/`.
3. It contains no timestamps that would change between runs. A determinism test also covers this.

**Verify**: `pnpm test` → `ℹ fail 0`. Running `pnpm test` a second time → still `ℹ fail 0`.

### Step 4: Full gates

**Verify**: `pnpm verify` → exit 0.

## Test plan

All tests go in `test/unit/prompt.test.ts`:

1. **Deterministic**: `buildPrompt(richCapture()) === buildPrompt(richCapture())`.
2. **Minimal snapshot**: `t.assert.snapshot(buildPrompt(minimalCapture()))`.
3. **Rich snapshot**: `t.assert.snapshot(buildPrompt(richCapture()))`.
4. **Minimal heading order**: `deepEqual(headings(minimal), [...recorded list...])`. It must include, in this relative order: `# Task: Recreate this UI section 1:1`, `## Source`, `## Stack & output`, `## Structure & exact styles`, `## Acceptance checklist`.
5. **Conditional sections appear with data**: the rich prompt contains `## SVGs`, `## Canvas source code (from the page's scripts)` and a line starting with `## Interactions`. The minimal prompt contains none of them.
6. **Source line carries the title**: the minimal prompt contains `- Page: https://example.com/ ("Example")`.
7. **Page text reaches the prompt**: the rich prompt contains `Get started`, `Pricing`, `GSAP` and `3.12.5`. Plan 003 changes how these are wrapped but must keep them present.
8. **Saved files use local paths**: the rich prompt contains `public/capture/hero.png` or `/capture/hero.png` (assert whichever form the current output uses). A copy of the rich capture with `saved` removed does not contain `/capture/hero.png`.
9. **SVG budget**: a capture with one SVG whose `src` is `'<svg>' + 'x'.repeat(41_000) + '</svg>'` produces a prompt that contains `too large to paste` and does not contain `'x'.repeat(41_000)`.
10. **Analysis section is inserted verbatim**: a capture with `analysis` set contains `analysis.promptSection` exactly. Build `analysis` as a full `SectionAnalysis` (`types.ts:520-533`) with `promptSection: '## Section analysis\n- Type: **hero**'`, `nameFromType: true`, `sectionType: { value: 'hero', confidence: 0.9 }`, `scope: { value: 'single-section', confidence: 0.9 }`, other choice fields `{ value: 'other', confidence: null }`, `repeatedGroup: null`, `complexity: 1`, `features: {}`, `componentName: 'HeroSection'`, `model: 'test'`.
11. **Naming follows analysis**: with that analysis, the prompt contains `components/hero-section.tsx` and `HeroSection`.

## Done criteria

- [ ] `cd frontend/jevelements && pnpm verify` exits 0
- [ ] `test/unit/prompt.test.ts`, `test/unit/fixtures.ts` and `test/unit/prompt.test.ts.snapshot` exist
- [ ] `pnpm test` reports at least 11 more passing tests than before this plan
- [ ] `git diff --name-only 0e4e1a3 -- frontend/jevelements/src` → no output (no product code changed by this plan)
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

- `buildPrompt` throws on `minimalCapture()`. That means some "optional" input is effectively required. Report the stack trace; do not change `prompt.ts`.
- The output contains something non-deterministic (a date, a random id) that makes test 1 or the snapshots flaky. Report where it comes from.
- `t.assert.snapshot` or `--test-update-snapshots` is unavailable. Report the Node version (`node --version`) and the error.
- Importing `prompt.ts` under Node fails because of a DOM or `chrome` reference at module load.

## Maintenance notes

- Any intentional prompt change (plan 003, or future wording edits) must refresh the snapshot with `pnpm exec tsx --test --test-update-snapshots test/unit/prompt.test.ts`. Reviewers should read the `.snapshot` diff; it is the human-readable record of what changed in PROMPT.md.
- Deferred: a golden fixture recorded from a real capture of `test/runtime.html`. It would cover runtime/WebGL/GSAP sections that these hand-built fixtures don't. It belongs to a later "golden-capture harness" effort.
- If `prompt.ts` is later split into one module per section, these tests are the safety net. Keep them passing without updating snapshots during a pure refactor.
