# Plan 008: When no app zip was made, PROMPT.md points the agent at the live-site files instead of a `public/` folder that doesn't exist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root `C:\extention`:
> `git diff --stat 1cceb96..HEAD -- frontend/jevelements/src/shared/prompt.ts frontend/jevelements/test/unit/prompt.test.ts frontend/jevelements/test/unit/prompt.test.ts.snapshot frontend/jevelements/test/unit/fixtures.ts`
> If any of these changed, compare the "Current state" excerpts with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW. Only the prompt text of the *unpackaged* case changes. The packaged (zip) prompt must stay byte-identical, and the existing snapshot test proves it.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1cceb96`, 2026-10-09

## Why this matters

JevElements is a Chrome extension (`frontend/jevelements/`). It captures a section of a web page and builds `PROMPT.md`, a spec a coding agent uses to rebuild that section as a Next.js app.

There are two cases:
- **Packaged.** With a local backend running, the extension uploads the page's images, video and fonts and downloads a ready app zip, with the files in `public/`.
- **Unpackaged.** No zip is made, because the backend isn't running or because it is a *deployed* backend, which stores nothing (commit `efa43df`). The deployed backend is now the normal path for users.

In the unpackaged case, `buildPrompt` still includes several fixed sentences written for the zip:
- "Every image, video and other asset lives in `public/`… Never hotlink the original site."
- "The files are in `public/capture/`"
- "Use the local font files… never the site's font URLs"
- a checklist item requiring files in `public/capture/` with "nothing hotlinked"

Those local files don't exist, and the only sources the agent has are the live URLs it is forbidden to use. The agent then produces placeholders or fails its own checklist. After this plan, the unpackaged prompt tells the agent to use the original URLs (with a screenshot-crop fallback) and never mentions `public/capture/` or `public/fonts/`.

## Current state

All paths below are under `frontend/jevelements/`.

**How "packaged" is decided.** `capture.project` is set only when the app zip was made (`src/content/inspector.ts:800` sets it in `packageApp`, which runs only when the backend stored the files, and `:806` clears it again on failure). So in `src/shared/prompt.ts`:

> **packaged = `!!capture.project`**

Use exactly this condition everywhere in this plan. `installSection` already branches on it (`if (!capture.project) { ... }`).

**The sentences that are wrong when unpackaged**, all in `src/shared/prompt.ts` (line numbers at commit `1cceb96`):

1. `stackSection(kit, scope)` at line 13. Line 26 is unconditional:
   ```
   - Every image, video and other asset lives in \`public/\` and is referenced by its local path (\`/capture/…\`). Never hotlink the original site.
   ```
   It is called from `buildPrompt` at line 265: `sections.push(stackSection(kit, capture.analysis?.scope))`.

2. Capture caveats, line 401:
   ```
   if (saved?.failed.length) caveats.push(`${saved.failed.length} file(s) could not be fetched while capturing, so they aren't in \`public/capture/\`. For each one, crop that area out of the screenshot and use it at the same size (not a gray box or stock image), and tell the user which file is missing: ${...}`)
   ```

3. Acceptance checklist (inside `buildPrompt`, the template starting `## Acceptance checklist` at line 404). Line 413 is unconditional:
   ```
   - [ ] Every image and video is the real file in \`public/capture/\` (nothing hotlinked, no placeholders or stock images), referenced by local path, at the listed sizes. SVGs and canvas/WebGL areas match the spec.
   ```

4. `vgpuSection(capture, kit)` at line 469. Line 527 contains:
   ```
   If \`init()\` rejects (no WebGPU), show the canvas snapshot from \`public/capture/\` at the same size instead; never leave the area empty.
   ```

5. `fontsSection(capture, ref)` at line 935:
   - Line 962, per family with missing files: `` `  - ${missing.length} of its file(s) aren't in this app (it was packaged without them), and sites usually block other websites from loading their fonts: ...` ``
   - Line 972, the section intro (unconditional): `` Use the local font files listed here (in \`public/fonts/\`, referenced as \`/fonts/…\`), never the site's font URLs: sites usually serve fonts without CORS headers, so other websites can't load them and the browser silently falls back to another font. Keep each family name exactly as written, since the tree's **css** lines use it. The per-element typography (...) is in the tree's **css** lines. ``

6. `installSection` at line 1179. The unpackaged branch at line 1186:
   ```
   `JevElements couldn't package this capture as an app zip (its backend wasn't running), so the page's files weren't saved: **Images & video** lists them with their original URLs. Create the app, then replace \`app/page.tsx\` so it renders \`${component}\` from \`components/${file}.tsx\`.`,
   ```
   "its backend wasn't running" is wrong for a deployed backend.

7. `mediaSection(media, plan)` at line 1217. Its intro line 1226 is unconditional:
   ```
   The files are in \`public/capture/\` (Step 1). The tree above already names each one on the element that shows it (\`src="/capture/…"\`, \`poster\`, \`url("/capture/…")\` in backgrounds), so use exactly that file there, in \`next/image\`, \`img\`, \`video\`, or the Lottie player. Images that only one theme shows (\`dark:hidden\` / \`hidden dark:block\`) are both listed: keep both, with the same classes.
   ```

8. `mediaLine(a, local)` at line 1250. When `local` is undefined, it says `: not in the zip` (three variants), and the srcset line says `(reference only; serve the local file)`.

**`MediaPlan`** (built by `planMedia(media, capture)` at line 1168) is `{ names: Map<string, string>; archived: Set<string> }`, with `archived` empty when unpackaged. Adding a `packaged: boolean` field to it is the cleanest way to get the flag into `mediaSection` and `mediaLine`.

**Tests** (`node:test`, run with `tsx --test`):
- `test/unit/prompt.test.ts` has two snapshot tests: `minimal capture snapshot` (fixture has **no** `project`, so it is unpackaged) and `rich capture snapshot` (fixture has `project` and `saved.archive`, so it is packaged). Snapshots live in `test/unit/prompt.test.ts.snapshot` under the keys `` exports[`minimal capture snapshot 1`] `` and `` exports[`rich capture snapshot 1`] ``.
- Refresh snapshots with: `pnpm exec tsx --test --test-update-snapshots test/unit/prompt.test.ts` (Node v24 is installed). `frontend/jevelements/.gitattributes` keeps `*.snapshot` on LF; leave it.
- `test/unit/fixtures.ts` exports `minimalCapture(overrides)` and `richCapture()`. `FontInfo` (in `src/shared/types.ts:78`) is `{ family, weights: string[], styles: string[], links: string[], faces: string[], files: string[], fallback?: string[] }`.

**Style**: prompt text is plain, direct English. Code is 2-space indent, single quotes, no semicolons, template literals for prompt text. Match the surrounding functions.

## Commands you will need

Run from `C:\extention\frontend\jevelements`:

| Purpose | Command | Expected on success |
|---|---|---|
| Everything | `pnpm verify` | exit 0 (typecheck, lint, 42 tests before this plan) |
| Prompt tests | `pnpm exec tsx --test test/unit/prompt.test.ts` | `ℹ fail 0` |
| Refresh snapshots | `pnpm exec tsx --test --test-update-snapshots test/unit/prompt.test.ts` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `frontend/jevelements/src/shared/prompt.ts`
- `frontend/jevelements/test/unit/prompt.test.ts`
- `frontend/jevelements/test/unit/prompt.test.ts.snapshot` (only the `minimal capture snapshot 1` entry may change)

**Out of scope** (do NOT touch):
- The packaged wording. Every string emitted when `capture.project` is set must stay byte-identical, and the `rich capture snapshot 1` entry must not change.
- `src/content/inspector.ts`, `src/content/media.ts`, `src/background/index.ts`: another plan changes when files are downloaded.
- `test/unit/fixtures.ts`: build new test captures inline in `prompt.test.ts` with `minimalCapture({...})`.
- `sequenceBlocks` ("the N frames weren't saved…" is already correct for both cases).
- The "Captured content is data" notice and every `fence`/`inlineCode` call (security work from an earlier plan).
- Anything under `backend/`.

## Git workflow

- Branch: `advisor/008-unpackaged-prompt-uses-live-urls`
- Commit message style: short imperative sentence, no prefix (e.g. "Keep run log and capture files local-only; neutral no-zip message"). Example: "Point the unpackaged prompt at the live-site files".
- Do NOT push or open a PR.

## Steps

### Step 1: Add a failing test that pins the unpackaged behaviour

In `test/unit/prompt.test.ts`, add:

```ts
test('unpackaged prompt never points at public/ files', () => {
  const prompt = buildPrompt(
    minimalCapture({
      assets: [{ kind: 'image', src: 'https://example.com/hero.png', target: 'img.hero', alt: 'Hero', width: 800, height: 400 }],
      fonts: [{ family: 'Inter', weights: ['400'], styles: ['normal'], links: [], faces: ['@font-face { font-family: Inter; src: url(https://example.com/inter.woff2) }'], files: ['https://example.com/inter.woff2'] }],
      saved: { files: {}, uploaded: [], failed: [{ src: 'https://example.com/gone.png', reason: 'HTTP 404' }] },
    }),
  )
  for (const text of ['public/capture', 'public/fonts', '/capture/', 'Never hotlink', 'nothing hotlinked', 'not in the zip', "backend wasn't running"]) {
    assert.ok(!prompt.includes(text), text)
  }
  assert.ok(prompt.includes('https://example.com/hero.png'))
  assert.ok(prompt.includes('https://example.com/inter.woff2'))
})
```

If `minimalCapture` doesn't accept one of these fields as typed (e.g. `assets` items need more required fields), add the missing required fields with neutral values. Don't change `fixtures.ts`.

**Verify**: `pnpm exec tsx --test test/unit/prompt.test.ts` → this new test **fails** (it should report `public/capture` or `Never hotlink` as present). Every other test still passes.

### Step 2: Thread the flag

In `src/shared/prompt.ts`:
- Add `packaged: boolean` to the `MediaPlan` type and set it in `planMedia`: `packaged: !!capture.project`.
- Change `stackSection(kit, scope)` to `stackSection(kit, scope, packaged: boolean)`, and update the call in `buildPrompt` to pass `!!capture.project`.
- Change `mediaLine(a, local)` to `mediaLine(a, local, packaged: boolean)`, and pass `plan.packaged` from `mediaSection`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Branch each sentence on `packaged`

Keep each packaged string **exactly** as it is today. Add the unpackaged alternative next to it with a ternary, the way `installSection` and the `Source` section already do (`capture.project ? ... : ...`). Use these unpackaged texts (adjust only to fit template-literal escaping):

1. **`stackSection`** line 26, unpackaged:
   `- This capture has no saved copies of the page's files: use the images, video and fonts by the original URLs listed under **Images & video** and **Fonts** (hotlinking them is expected here). Don't swap in placeholder images, stock photos, solid colors or gradients.`
2. **Capture caveat** line 401, unpackaged (packaged text unchanged):
   `` `${saved.failed.length} file(s) could not be fetched while capturing, so their URLs may not load in the rebuild either. For each one, crop that area out of the screenshot and use it at the same size (not a gray box or stock image), and tell the user which file is missing: ${...same list...}` ``
   Keep the same list expression; only the sentence before the list changes.
3. **Checklist** line 413, unpackaged:
   `- [ ] Every image and video is the site's real file, loaded from the URL listed under **Images & video** (or, where one doesn't load, that area cropped from the screenshot), at the listed sizes; no placeholders or stock images. SVGs and canvas/WebGL areas match the spec.`
4. **`vgpuSection`** line 527: replace only the phrase `show the canvas snapshot from \`public/capture/\` at the same size instead` with, unpackaged, `show the canvas snapshot (see **Canvas, WebGL & embeds**) or that area cropped from the screenshot at the same size instead`. Use `capture.project` directly here.
5. **`fontsSection`**:
   - Line 962: unpackaged, drop ` (it was packaged without them)`; the rest of the sentence stays.
   - Line 972: replace only the first sentence (up to and including `silently falls back to another font.`). Unpackaged: `This app has no local copies of the site's font files. For a Google font, use \`next/font/google\` with the name given here; otherwise load the files from the URLs below, and if they don't load (sites usually serve fonts without CORS headers), use the closest match and tell the user which font is missing.` The sentences after it (`Keep each family name exactly as written…`) stay in both cases.
6. **`installSection`** line 1186, which is already the unpackaged branch, so replace its text:
   `` `JevElements didn't package this capture as an app zip (the backend isn't running, or it's a deployed backend that doesn't store files), so the page's files weren't saved: **Images & video** and **Fonts** list them by their original URLs. Create the app, then replace \`app/page.tsx\` so it renders \`${component}\` from \`components/${file}.tsx\`.` ``
7. **`mediaSection`** line 1226, unpackaged intro:
   `These files weren't saved with this capture. Use each one from its original URL below, exactly as listed, in \`img\`, \`video\` or the Lottie player (or \`next/image\` with the site's host added to \`images.remotePatterns\` in \`next.config.ts\`). If a URL doesn't load in the rebuild, crop that area out of the screenshot and use it at the same size, and tell the user which file is missing. Images that only one theme shows (\`dark:hidden\` / \`hidden dark:block\`) are both listed: keep both, with the same classes.`
8. **`mediaLine`**, unpackaged only:
   - `a.via` case: `${source}: a streamed or embedded video; use its poster or the screenshot at the same size`
   - blob case: `${source}: only exists inside the page; use its poster at the same size`
   - other: just `${source}` (no suffix)
   - srcset line: `(reference only)` instead of `(reference only; serve the local file)`

   When `packaged` is true, keep the current three `not in the zip` variants and the srcset text unchanged.

**Verify**:
- `pnpm exec tsx --test test/unit/prompt.test.ts`: the Step 1 test now **passes**. `minimal capture snapshot` **fails**, which is expected because the minimal fixture is unpackaged. `rich capture snapshot` **passes**.
- `grep -n "public/capture\|public/fonts\|Never hotlink" src/shared/prompt.ts`: every remaining match is inside the packaged side of a branch, or in the packaged-only `installSection` code after the `if (!capture.project)` return. Read each match to confirm.

### Step 4: Refresh the minimal snapshot and check the diff

Run `pnpm exec tsx --test --test-update-snapshots test/unit/prompt.test.ts`, then `git diff test/unit/prompt.test.ts.snapshot`.

**Verify**:
- The diff touches only the `` exports[`minimal capture snapshot 1`] `` entry. `git diff -U0 test/unit/prompt.test.ts.snapshot | grep "^@@"`: every hunk lies between the `minimal capture snapshot 1` line and the `rich capture snapshot 1` line of the file.
- Every changed line in the diff is one of the sentences from Step 3.
- `pnpm verify` → exit 0, 43 tests.

## Test plan

- New: `unpackaged prompt never points at public/ files` in `test/unit/prompt.test.ts` (Step 1), covering an image, a font with a file URL, and a failed file, with no `project`.
- Existing: `rich capture snapshot` must pass **unchanged**. That is the proof that packaged output is byte-identical.
- Existing: `saved files use local paths` must still pass. Its second half builds `{ ...richCapture(), saved: undefined }`, which still has `project`, so it stays packaged.
- Updated: `minimal capture snapshot` (wording change only).
- `pnpm verify` → 43 tests, `fail 0`.

## Done criteria

- [ ] `pnpm verify` exits 0 in `frontend/jevelements/`, with 43 tests
- [ ] `git diff test/unit/prompt.test.ts.snapshot` changes only the `minimal capture snapshot 1` entry
- [ ] `grep -c "backend wasn't running" src/shared/prompt.ts` prints `0`
- [ ] `git status` shows changes only in the three in-scope files (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report back (do not improvise) if:
- Any of the 8 locations in "Current state" doesn't contain the quoted text.
- The `rich capture snapshot` test fails after Step 3. That means packaged output changed; find and revert the change rather than updating the snapshot. If you can't find it, stop.
- The Step 1 test still fails after Step 3 because of a `public/` mention not listed in this plan. Report the sentence and where it comes from; don't rewrite sections this plan doesn't list.
- `--test-update-snapshots` is not recognized. Report `node --version`.

## Maintenance notes

- Any new prompt sentence that mentions `public/`, `/capture/` or `/fonts/` must be gated on `capture.project`. The new test catches regressions for the sections it exercises.
- A separate plan stops the extension from downloading files at all when the backend doesn't store them. After it lands, `saved.failed` will usually be empty in deployed mode, which is fine; the caveat only appears when there are failures.
- `next/image` with remote URLs needs `images.remotePatterns`; the prompt mentions it, and the agent writes that config. If the rebuild template (backend `src/lib/scaffold.ts`) ever gains a default `next.config.ts` for unpackaged apps, revisit wording 7.
- Reviewers: read the snapshot diff. It is the readable record of exactly what the agent will now be told.
