# Plan 001: Give both projects a one-command `verify` (typecheck + lint + unit tests)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root `C:\extention`:
> `git diff --stat 0e4e1a3..HEAD -- backend/package.json backend/src/lib frontend/jevelements/package.json frontend/jevelements/tsconfig.json frontend/jevelements/src/shared/files.ts frontend/jevelements/src/shared/kit.ts frontend/jevelements/src/shared/shader.ts frontend/jevelements/src/shared/runtime.ts frontend/jevelements/src/probe/format.ts`
> If any of these changed, compare the "Current state" excerpts against the
> live code first. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `0e4e1a3`, 2026-10-07

## Why this matters

JevElements is a Chrome extension (`frontend/jevelements`) plus a Next.js backend (`backend`). There is only one automated check: `backend/src/lib/judgment.test.ts`, a plain script with top-level `assert` calls. The extension has no test runner at all, and neither project has a `typecheck` or `verify` script. Every later plan needs a single command that says "the tree is still good", and needs a place to put new unit tests. After this plan:
- Both projects run `node:test` suites via `tsx --test`.
- The first tests cover the pure helpers whose regressions silently break the zip or the prompt (file-type detection, naming, the backend's path validator, the hand-written zip writer).
- `pnpm verify` works in each project.

## Current state

Two independent pnpm projects with no root `package.json` and no CI. Node is v24.14.0.

**`backend/package.json`** (scripts as they are today):
```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "tsx src/lib/judgment.test.ts"
},
```
`tsx` (^4.23.15) is already a backend devDependency. `backend/tsconfig.json` includes `**/*.ts`, so test files in `src/lib/` are typechecked with `@types/node` available.

**`backend/src/lib/judgment.test.ts`** (the existing pattern, top-level asserts, lines 1–17 and the end):
```ts
import assert from 'node:assert/strict'
import { clipOutline } from './capture'
import { choiceConfidence, describeGroup, featureBand, findSiblingGroups, pascalComponent } from './judgment'
import type { CapturedNode } from './capture'

function node(partial: Partial<CapturedNode> & Pick<CapturedNode, 'tag'>): CapturedNode {
  return {
    tag: partial.tag,
    attrs: partial.attrs ?? {},
    box: partial.box ?? { x: 0, y: 0, w: 200, h: 40 },
    styles: partial.styles ?? {},
    children: partial.children ?? [],
    id: partial.id,
    classes: partial.classes,
    text: partial.text,
  }
}
...
console.log('judgment checks passed')
```

**`backend/src/lib/store.ts`**: path validator and chunked writes. Staging lives in `path.join(os.tmpdir(), 'jevelements-captures')`.
```ts
// store.ts:14-31
export const MAX_FILE_BYTES = 250 * 1024 * 1024
export const FOLDERS = ['media', 'frames', 'code', 'fonts'] as const
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,90}$/i
export function isCaptureId(id: string): boolean { return ID_RE.test(id) }
export function filePath(id: string, segments: string[]): string | null {
  if (!isCaptureId(id) || segments.length !== 2) return null
  const [folder, name] = segments
  if (!FOLDERS.includes(folder as Folder) || !NAME_RE.test(name) || name.includes('..')) return null
  return path.join(captureDir(id), folder, name)
}
// store.ts:35-46: saveFile(file, bytes, offset): offset 0 writes; later offsets append only when
// offset === current size and the result stays <= MAX_FILE_BYTES; otherwise returns false.
// store.ts:65-82: isProjectMeta: name/file match /^[a-z][a-z0-9-]{0,62}$/, component matches
// /^[A-Z][A-Za-z0-9]{0,80}$/, prompt is a string of at most MAX_PROMPT_CHARS (5_000_000).
// store.ts:84-89: saveProject(id, meta) writes project.json.
```

**`backend/src/lib/archive.ts`**: `export async function appZip(id)` returns `{ name, zip: Buffer } | null`. It builds a zip by hand: entries are prefixed `<project.name>/`, `PROMPT.md` and text files are deflated (method 8), media is stored (method 0), and the end-of-central-directory record has no comment. Folder mapping (`archive.ts:13`):
```ts
const DIRS: Record<Folder, string> = { media: 'public/capture', frames: 'public/reference', code: 'public/reference/code', fonts: 'public/fonts' }
```

**`frontend/jevelements/package.json`** scripts today:
```json
"build": "tsc -b && vite build && vite build -c vite.content.config.ts && vite build -c vite.probe.config.ts",
"test:build": "vite build -c vite.probe.config.ts && vite build -c test/vite.pipeline.config.ts",
"test:serve": "node test/serve.mjs",
"lint": "eslint ."
```
There is no `tsx` and no test runner. `test/` holds manual HTML pages. Do not confuse those with unit tests, and leave them alone.

**`frontend/jevelements/tsconfig.json`** is a solution file:
```json
{ "files": [], "references": [ { "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" } ] }
```
`tsconfig.app.json` covers `src` with `"types": ["vite/client", "chrome"]` and has no Node types. `tsconfig.node.json` covers only the three root vite configs. Both use `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax` and a `tsBuildInfoFile` under `./node_modules/.tmp/`. The new test config must follow the same shape.

Pure frontend modules to test (none of them touch `chrome`, `window` or `document` at import time):
- `src/shared/files.ts`: `extensionFor(type, src)`, `toBase64(bytes)`, `fromBase64(b64)`.
  ```ts
  export function extensionFor(type: string, src: string): string | null {
    const mime = type.split(';')[0].trim().toLowerCase()
    if (EXTENSIONS[mime]) return EXTENSIONS[mime]            // e.g. 'image/jpeg' → 'jpg'
    if (src.startsWith('data:') || src.startsWith('blob:')) return SCENE_EXTENSIONS[mime] ?? null
    try {
      const url = new URL(src)
      const inner = url.searchParams.get('url') // /_next/image?url=/hero.png
      const ext = (KNOWN_EXT.exec(url.pathname) ?? KNOWN_EXT.exec(inner ?? ''))?.[1].toLowerCase()
      return ext === 'jpeg' ? 'jpg' : (ext ?? SCENE_EXTENSIONS[mime] ?? null)
    } catch { return null }
  }
  ```
- `src/shared/kit.ts`: `readableName(names)` skips utility classes (`flex`, `w-…`, `css-…`) and strips a trailing `section`; it returns `/^[a-z][a-z-]{2,23}$/` or null. `componentNames(kit)` maps `'hero-section'` to `{ file: 'hero-section', component: 'HeroSection' }` and prefixes `Section` when the name starts with a digit.
- `src/shared/shader.ts`: `isWgsl(code)`.
- `src/shared/runtime.ts`: `emulateColorScheme(media, scheme)` and `mentionsColorScheme(media)` (a shared global regex, so call them repeatedly).
- `src/probe/format.ts`: `literal(value, depth)`, `hex(r,g,b)`, `truncateText(s, max)`. `literal` guards `typeof Element !== 'undefined'`, so it runs under Node. It imports `../shared/dom`; that import is safe under Node.

**Conventions**: no semicolons, single quotes, 2-space indent, `node:` prefixed built-ins (see `judgment.test.ts`). Comments explain *why*, in plain sentences.

**Module format gotcha**: `backend/package.json` has no `"type": "module"`, so tsx loads backend test files as CommonJS. **Top-level `await` fails there** with `Top-level await is currently not supported with the "cjs" output format`. Put every `await` inside an `async` `test(...)` callback or hook. Do not add `"type": "module"` to fix it; that would change how Next and the backend load. The frontend has `"type": "module"`, so this does not apply there.

## Commands you will need

| Purpose | Command (run in the named project dir) | Expected on success |
|---|---|---|
| Install (frontend) | `pnpm install` in `frontend/jevelements` | exit 0 |
| Add tsx (frontend) | `pnpm add -D tsx@^4.23.15` in `frontend/jevelements` | exit 0, `tsx` in devDependencies |
| Typecheck backend | `pnpm typecheck` (after step 1) | exit 0 |
| Tests backend | `pnpm test` | `ℹ fail 0` |
| Typecheck frontend | `pnpm typecheck` (after step 4) | exit 0 |
| Tests frontend | `pnpm test` | `ℹ fail 0` |
| Lint either | `pnpm lint` | exit 0, no output |
| All gates | `pnpm verify` | exit 0 |

## Scope

**In scope** (the only files you may create or modify):
- `backend/package.json` (scripts only)
- `backend/src/lib/judgment.test.ts` (convert to `node:test`)
- `backend/src/lib/store.test.ts` (create)
- `backend/src/lib/archive.test.ts` (create)
- `frontend/jevelements/package.json` (scripts and the `tsx` devDependency)
- `frontend/jevelements/pnpm-lock.yaml` (changed by `pnpm add` only)
- `frontend/jevelements/tsconfig.json` (add one reference)
- `frontend/jevelements/tsconfig.test.json` (create)
- `frontend/jevelements/test/unit/*.test.ts` (create)
- `backend/AGENTS.md` and `README.md` (repo root): one short "Verify" note each (step 7)

**Out of scope**:
- Any file under `src/` in either project. This plan adds tests only. If a test exposes a bug, record it (see STOP conditions) and don't fix it.
- `test/*.html`, `test/serve.mjs`, `test/pipeline-entry.ts`, `test/vite.pipeline.config.ts`: the manual test harness.
- Adding vitest or jest. `node:test` via `tsx` is the deliberate choice: it adds no new framework, and tsx is already used here.
- The block at the top of `backend/AGENTS.md`: `next dev` regenerates it. Append below it only.

## Git workflow

- Branch: `advisor/001-verification-baseline`
- Commit per step group. Message style matches the repo: a plain sentence in imperative mood, e.g. `Add node:test harness and verify script to the backend`.
- Do not push or open a PR unless told to.

## Steps

### Step 1: Backend scripts

In `backend/package.json`, set the scripts to:
```json
"dev": "next dev",
"build": "next build",
"start": "next start",
"lint": "eslint",
"typecheck": "tsc --noEmit",
"test": "tsx --test \"src/**/*.test.ts\"",
"verify": "pnpm typecheck && pnpm lint && pnpm test"
```
Node expands the quoted glob itself, which also works on Windows.

**Verify**: `pnpm test` in `backend/` → output contains `judgment checks passed` and `ℹ fail 0`. The old file still runs as a single implicit test.

### Step 2: Convert `judgment.test.ts` to `node:test`

Wrap the existing assertions in named `test()` blocks without changing what they assert:
```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
// …same imports and node() helper…

test('choiceConfidence: a 40% share of 14 options is not a confident name', () => { … })
test('choiceConfidence: an 80% share clears the naming floor', () => { … })
test('featureBand bands', () => { … })
test('pascalComponent', () => { … })
test('findSiblingGroups finds three similar cards', () => { … })
test('findSiblingGroups ignores mixed children', () => { … })
test('clipOutline keeps head and tail', () => { … })
```
Delete the trailing `console.log('judgment checks passed')`.

**Verify**: `pnpm test` → `ℹ tests 7`, `ℹ fail 0`.

### Step 3: Backend `store.test.ts` and `archive.test.ts`

Create `backend/src/lib/store.test.ts`. The cases are listed under **Test plan**. File-system tests use a fresh `crypto.randomUUID()` capture id and remove `captureDir(id)` in an `after()` hook (`import { after, test } from 'node:test'`, `rm(dir, { recursive: true, force: true })`).

Create `backend/src/lib/archive.test.ts`. It saves a project and two files through the public `store.ts` functions, calls `appZip(id)`, and parses the zip back with a small local reader. Put this helper in the test file. Do not export anything new from `archive.ts`.
```ts
import { inflateRawSync } from 'node:zlib'

function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50)
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16) // central directory offset
  const out = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50)
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    assert.equal(buf.readUInt32LE(local), 0x04034b50)
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(dataStart, dataStart + size)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}
```

**Verify**: `pnpm test` → all pass, `ℹ fail 0`, and the test count increased by the number of new cases.

### Step 4: Frontend test toolchain

In `frontend/jevelements`:
1. `pnpm add -D tsx@^4.23.15`
2. Create `tsconfig.test.json`:
   ```json
   {
     "compilerOptions": {
       "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.test.tsbuildinfo",
       "target": "es2023",
       "lib": ["ES2023", "DOM"],
       "module": "esnext",
       "types": ["node"],
       "skipLibCheck": true,
       "moduleResolution": "bundler",
       "allowImportingTsExtensions": true,
       "verbatimModuleSyntax": true,
       "moduleDetection": "force",
       "noEmit": true,
       "noUnusedLocals": true,
       "noUnusedParameters": true,
       "erasableSyntaxOnly": true,
       "noFallthroughCasesInSwitch": true
     },
     "include": ["test/unit"]
   }
   ```
3. Add `{ "path": "./tsconfig.test.json" }` to the `references` array in `tsconfig.json`.
4. Add these scripts and keep the existing ones:
   ```json
   "typecheck": "tsc -b",
   "test": "tsx --test \"test/unit/**/*.test.ts\"",
   "verify": "pnpm typecheck && pnpm lint && pnpm test"
   ```

**Verify**: `pnpm typecheck` → exit 0. `pnpm test` fails here because no tests exist yet; that is expected.

### Step 5: Frontend unit tests

Create these files under `frontend/jevelements/test/unit/` (cases in **Test plan**):
- `files.test.ts`, which imports from `../../src/shared/files`
- `kit.test.ts`
- `shader.test.ts`
- `runtime.test.ts`, which imports from `../../src/shared/runtime`
- `format.test.ts`, which imports from `../../src/probe/format`

Use extensionless relative imports, as `src/` does.

**Verify**: `pnpm test` → `ℹ fail 0`. `pnpm typecheck` → exit 0. `pnpm lint` → exit 0.

### Step 6: Run the full gates

**Verify**: `pnpm verify` in `backend/` → exit 0. `pnpm verify` in `frontend/jevelements/` → exit 0.

### Step 7: Document `verify`

- Append one line to `backend/AGENTS.md`, below the existing block: `Run \`pnpm verify\` (typecheck, lint, unit tests) before finishing any change.`
- In the repo-root `README.md`, add a short `## Checks` section stating that `pnpm verify` runs typecheck, lint and unit tests in each of `backend/` and `frontend/jevelements/`.

**Verify**: `git diff --stat` shows only in-scope files.

## Test plan

Model the structure on the converted `backend/src/lib/judgment.test.ts`: one `test()` per behaviour, `assert` from `node:assert/strict`.

**backend/src/lib/store.test.ts**
- `isCaptureId`: accepts a lowercase and an uppercase UUID; rejects `'abc'`, `''` and a UUID with a trailing `/x`.
- `filePath`:
  - returns a path ending in `media/hero.png` for `(uuid, ['media','hero.png'])`
  - returns null for an unknown folder (`'other'`), a 3-segment array, `'..'`, `'a..b.png'`, a name starting with `.` or `-`, a 92-character name, and a name containing `/` or `\`
- `isProjectMeta`:
  - accepts `{ name: 'hero-section', component: 'HeroSection', file: 'hero-section', prompt: 'x' }`
  - rejects an uppercase `name`, a lowercase `component`, a missing `prompt`, a prompt one character over `MAX_PROMPT_CHARS`, and `null`
- `saveFile`, in OS temp with a fresh UUID:
  - offset 0 writes 3 bytes
  - offset 3 appends and returns true
  - a repeat of offset 3 now returns false (size is 6)
  - offset 0 again overwrites
  - read back with `readCaptureFile` to confirm the bytes

**backend/src/lib/archive.test.ts**
- `appZip(freshUuid)` with nothing saved → `null`.
- Saving `saveProject(id, { name: 'hero-section', component: 'HeroSection', file: 'hero-section', prompt: '# hi' })`, a `media/hero.png` with known bytes, and a `code/app.js` gives a zip whose entries:
  - include `hero-section/PROMPT.md`, with inflated content equal to `'# hi'`
  - include `hero-section/public/capture/hero.png`, with stored bytes equal to the input
  - include `hero-section/public/reference/code/app.js`
  - include at least one scaffold file starting with `hero-section/` (e.g. `hero-section/package.json`)
  - all start with `hero-section/`
  - and the result's `name` is `'hero-section'`

**frontend/jevelements/test/unit/files.test.ts**
- `extensionFor('image/jpeg', 'https://x/a.png')` → `'jpg'`. The MIME type wins.
- `extensionFor('application/octet-stream', 'https://x/m.glb')` → `'glb'`.
- `extensionFor('', 'https://x/_next/image?url=%2Fhero.webp&w=640')` → `'webp'`.
- `extensionFor('application/octet-stream', 'https://x/a.jpeg')` → `'jpg'`.
- `extensionFor('application/json', 'data:application/json,{}')` → `'json'`.
- `extensionFor('text/plain', 'https://x/readme')` → `null`.
- `extensionFor('', 'not a url')` → `null`.
- `fromBase64(toBase64(bytes))` round-trips a 100 000-byte array, which is larger than the 0x8000 chunk.

**kit.test.ts**
- `readableName(['flex', 'pricing'])` → `'pricing'`.
- `readableName(['featureGridSection'])` → `'feature-grid'`.
- `readableName(['css-1x2y', 'w-full'])` → `null`.
- `componentNames('hero-section')` → `{ file: 'hero-section', component: 'HeroSection' }`.
- `componentNames('3d-section').component` → `'Section3dSection'`.

**shader.test.ts**
- `isWgsl('@fragment fn main() -> @location(0) vec4f { … }')` → true.
- A GLSL `void main() { gl_FragColor = vec4(1.0); }` → false.

**runtime.test.ts**
- `emulateColorScheme('(prefers-color-scheme: dark)', 'dark')` → `'(width >= 0px)'`; with `'light'` → `'(width < 0px)'`.
- `mentionsColorScheme('(prefers-color-scheme: dark)')` is true on three consecutive calls (this checks the global-regex `lastIndex` handling).
- `mentionsColorScheme('(min-width: 600px)')` → false.

**format.test.ts**
- `literal({ y: 40, ease: 'power3.out', f: () => 1 })` → `'{ y: 40, ease: "power3.out", f: /* function */ }'`.
- `literal('a'.repeat(400))` has length 300 + 3 (two quote marks plus `…`).
- `literal(Array.from({ length: 20 }, (_, i) => i))` ends with `, …]`.
- `literal({ a: { b: { c: { d: 1 } } } })` contains `{…}`.
- `literal(NaN)` → `'NaN'`.
- `hex(1, 0, 0.5)` → `'#ff0080'`.
- `truncateText('abcdef', 3)` starts with `'abc'` and contains `3 more characters`.

If an expected value above disagrees with what the current code returns, the code is the source of truth for this characterization. Assert the actual value, and add a `// NOTE:` comment saying why it may be surprising. If the actual value looks like a real bug (for example a valid UUID rejected), follow the STOP condition.

## Done criteria

- [ ] `cd backend && pnpm verify` exits 0
- [ ] `cd frontend/jevelements && pnpm verify` exits 0
- [ ] `backend/src/lib/store.test.ts`, `backend/src/lib/archive.test.ts` and 5 files in `frontend/jevelements/test/unit/` exist
- [ ] `grep -n "console.log" backend/src/lib/judgment.test.ts` → no matches
- [ ] `git diff --name-only 0e4e1a3 -- backend/src frontend/jevelements/src` lists only `*.test.ts` files
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

- `tsx --test` does not find or run the tests on this machine (for example the quoted glob doesn't expand). Report the exact output.
- `tsc -b` fails on `tsconfig.test.json` because a `src/shared` file imported by a test needs `chrome` or `vite/client` types. Report which import.
- A test reveals what looks like a real defect, such as a traversal name accepted by `filePath`, a corrupt zip or a wrong extension. Do not fix `src/`. Report the input and the actual output.
- `pnpm add` wants to upgrade or change unrelated dependencies.

## Maintenance notes

- Plans 002 and 003 add tests under `frontend/jevelements/test/unit/` and depend on this harness.
- `tsconfig.test.json` typechecks every `src` file the tests import, under Node types plus DOM. If a shared module later starts using `chrome.*`, tests that import it will fail typecheck. Keep `chrome` usage out of `src/shared/` modules that are meant to be pure.
- Deferred: typechecking `test/pipeline-entry.ts` and `test/vite.pipeline.config.ts`. They import the whole content script and need a browser and `chrome` types config of their own.
