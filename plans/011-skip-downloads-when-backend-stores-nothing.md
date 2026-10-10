# Plan 011: Don't download a section's files when the backend won't store them, and say so when it refuses them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root `C:\extention`:
> `git diff --stat 1cceb96..HEAD -- frontend/jevelements/src/content/media.ts frontend/jevelements/src/content/inspector.ts frontend/jevelements/src/shared/types.ts frontend/jevelements/src/background/index.ts`
> Plan 009 is expected to have changed `download`/`saveMedia` in `background/index.ts`. Any other change in these files: compare the excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/009-worker-media-fetch-policy.md (edits the same file, `src/background/index.ts`; land 009 first to avoid conflicts. There is no logical dependency.)
- **Category**: perf / bug
- **Planned at**: commit `1cceb96`, 2026-10-09

## Why this matters

JevElements is a Chrome extension (`frontend/jevelements/`). When it captures a section, `saveMedia` (`src/content/media.ts`) does three things:
- It asks the service worker to download every image, video, font and scene file.
- It uploads each file to the backend, and the backend builds an app zip from them.
- It uploads the canvas snapshots, sweep frames and the screenshot.

A **deployed** backend (`NODE_ENV=production`) stores nothing and answers 404 to uploads. The extension then shows "Images and video linked from the live site", and the prompt points at the live URLs.

The extension already stops *uploading* after the first 404, but it keeps *downloading* every file. That means:
- Videos of tens of MB are downloaded, with a 90 s timeout each, and then thrown away.
- A failed worker download triggers a second download in the page.
- The capture's "Saving images, video & canvas" step slows down for nothing.

Separately, a 403 (the backend's `JEV_EXTENSION_ID` names another extension) or a 401 (the optional `JEV_API_TOKEN` is set on the backend, which this project normally doesn't use) is not treated as a stop at all. Every file is downloaded **and** re-uploaded in 8 MB chunks only to be refused, and the UI still shows the green neutral label, so a broken setup looks like normal deployed behaviour.

After this plan:
- The extension learns whether the backend stores files *before* the downloads start, by uploading the screenshot first.
- It skips every remaining download once the backend has said no.
- A 401/403 shows an error step in the drawer.

## Current state

All paths below are under `frontend/jevelements/`.

**`src/shared/types.ts:576-577`**:
```ts
// `archive` is where the rebuild downloads every uploaded file; `unreachable` means stop uploading: the backend isn't running, or it doesn't store files.
export type UploadResult = { archive: string } | { error: string; unreachable?: boolean }
```
**`src/shared/types.ts:450-458`**, `SavedFiles` (stored on `capture.saved`):
```ts
export interface SavedFiles {
  files: Record<string, string> // http(s) source URL → file name in public/capture/ ...
  uploaded: string[]
  archive?: string // backend URL of the app zip; missing when nothing could be uploaded (...)
  screenshot?: string
  failed: { src: string; reason: string }[]
  fonts?: Record<string, string>
  fontsFailed?: { src: string; reason: string }[]
}
```

**`src/background/index.ts`**, in `put()` (lines ~171–191 at `1cceb96`). This is the only producer of `unreachable`:
```ts
  } catch {
    return { error: `backend not reachable at ${backendUrl}`, unreachable: true }
  }
  if (!res.ok) {
    const reason = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
    // 404: a deployed backend keeps no capture files (backend/src/lib/local.ts), so stop uploading.
    return { error: `backend upload failed: ${reason ?? `HTTP ${res.status}`}`, unreachable: res.status === 404 || undefined }
  }
  return { archive:new URL(`/api/captures/${captureId}/zip`, backendUrl).href }
```

**`src/content/media.ts`**, inside `save()`:
- Line 151: `let uploading = true // cleared once the backend turns out not to be running`
- Lines 152–161, `record`, the only consumer of `unreachable`:
  ```ts
  const record = (path: string, result: UploadResult | undefined) => {
    if (!result) return
    if ('archive' in result) {
      saved.uploaded.push(path)
      saved.archive = result.archive
    } else {
      if (result.unreachable) uploading = false
      console.info('[jevelements] not uploaded:', path, result.error)
    }
  }
  ```
- `saveOne` (around line 182) and `saveFont` (around line 188) each call `fetchOne`, which downloads in the worker (`jev:save-media`) and falls back to `fetchInPage`, whatever the value of `uploading`.
- The download queue runs at lines ~195–204 (`const queue = [...]`, `await Promise.all(...)`).
- Canvas snapshots, code files, sweep frames and scheme shots are then uploaded only `if (uploading)`.
- The **last** statement of `save()` uploads the screenshot:
  ```ts
  // The screenshot, so the agent can open it from public/reference/ as well as from the message.
  if (shot && uploading) record(`reference/${shot.file}`, await upload(capture.id, 'frames', shot.file, dataUrlBlob(shot.dataUrl)))
  ```

**`src/content/inspector.ts:650-663`**, the drawer step after saving:
```ts
        const saved = capture.saved
        const failed = saved?.failed.length ?? 0
        const files = saved?.uploaded.filter((p) => p.startsWith('capture/')).length ?? 0
        const named = new Set([...Object.values(saved?.files ?? {}), ...capture.assets.map((a) => a.file)].filter(Boolean)).size
        // No zip is expected from a deployed backend (it stores nothing), so this is not an error: the
        // prompt points at the files on the live site instead. Locally, the console says why.
        const unsaved = !saved?.archive && (named > 0 || failed > 0)
        const savedLabel = saved?.archive
          ? `Zipped ${files} file${files === 1 ? '' : 's'} for public/${failed ? `, ${failed} failed` : ''}`
          : unsaved
            ? 'Images and video linked from the live site'
            : 'No images or video'
        steps = [...before, { label: savedLabel, state: 'done' }]
```
`named` depends on files having been downloaded and named. Once downloads are skipped it would be 0, and the label would wrongly say "No images or video". Step 4 fixes that.

**Why skipping is safe for the prompt**: `src/shared/prompt.ts` only uses saved file names when the app zip exists. `planMedia` keeps names only `if (capture.project && saved?.archive)`, font paths need `capture.project`, and canvas snapshots need `plan.archived`. Without a zip the prompt uses the original URLs, so nothing is lost by not downloading.

**Conventions**: 2-space indent, single quotes, no semicolons, a short "why" comment above non-obvious code. String-literal union types are used for small enums in `types.ts` (e.g. `folder: 'media' | 'frames' | 'code' | 'fonts'`).

## Commands you will need

Run from `C:\extention\frontend\jevelements`:

| Purpose | Command | Expected on success |
|---|---|---|
| Everything | `pnpm verify` | exit 0 |
| Build (for the manual check) | `pnpm build` | exit 0, writes `dist/` |

## Scope

**In scope** (the only files you should modify):
- `frontend/jevelements/src/shared/types.ts`: `UploadResult`, `SavedFiles`, and a new `BackendStop` type
- `frontend/jevelements/src/background/index.ts`: `put()` only
- `frontend/jevelements/src/content/media.ts`: `save()` only
- `frontend/jevelements/src/content/inspector.ts`: the label block quoted above only

**Out of scope** (do NOT touch):
- `src/shared/prompt.ts` (another plan handles the no-zip wording).
- `download`/`saveMedia` in the worker (plan 009).
- `analyze()` and its "start it with pnpm dev" message (a separate options-page plan).
- The backend.
- `fetchInPage` and `upload()` in `media.ts`.

## Git workflow

- Branch: `advisor/011-skip-downloads-when-backend-stores-nothing`, created from the commit that contains plan 009.
- Commit message style: short imperative sentence, no prefix. Example: "Skip downloads once the backend won't store them; flag refused uploads".
- Do NOT push or open a PR.

## Steps

### Step 1: Say why uploads stopped

In `src/shared/types.ts`:
```ts
// Why the backend took no more files: not running, a deployed backend that stores nothing (404), or a
// refused extension ID or token (403/401).
export type BackendStop = 'offline' | 'not-stored' | 'refused'
// `archive` is where the rebuild downloads every uploaded file; `stop` means stop uploading (see BackendStop).
export type UploadResult = { archive: string } | { error: string; stop?: BackendStop }
```
Add `backend?: BackendStop // set when the backend took no more files` to `SavedFiles`.

In `src/background/index.ts` `put()`:
- catch branch → `stop: 'offline'`
- `!res.ok` branch → `stop: res.status === 404 ? 'not-stored' : res.status === 401 || res.status === 403 ? 'refused' : undefined`
- Update the 404 comment so it also mentions 401/403.
- While there, fix the missing space in `{ archive:new URL(` → `{ archive: new URL(`.

**Verify**: `pnpm typecheck` → fails only in `src/content/media.ts` on `result.unreachable` (expected; fixed in the next step). Any other error is a STOP condition.

### Step 2: Record the stop

In `media.ts` `record`: replace `if (result.unreachable) uploading = false` with:
```ts
      if (result.stop) {
        uploading = false
        saved.backend ??= result.stop
      }
```
Update the comment on `let uploading` to: `// cleared once the backend won't take files (saved.backend says why)`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Ask the backend first, then skip downloads it won't keep

In `save()` in `media.ts`:
1. **Move** the screenshot upload (the final statement quoted above, with its comment) to just **before** `const queue = ...`, and change its comment to: `// The screenshot goes first: besides public/reference/, its answer tells us whether the backend keeps files at all, before anything is downloaded.` The screenshot is in hand already, so this costs nothing extra.
2. In `saveOne` and `saveFont`, return immediately at the top when the backend won't take files: `if (!uploading) return`. Skipped jobs are **not** added to `saved.failed` / `saved.fontsFailed`, because nothing failed.
3. Leave the rest (canvases, code, sweeps, schemes) as is; those are already gated on `uploading`.

The progress callback still counts every queue item, so skipped items finish instantly and the counter reaches `total`.

**Verify**: `pnpm verify` → exit 0.

### Step 4: Fix the drawer label

In `inspector.ts` (the block quoted above):
- Replace `named` with a count that doesn't depend on downloads:
  `const media = capture.assets.filter((a) => a.kind !== 'svg' && a.kind !== 'canvas').length`
  and use `media > 0 || failed > 0` in `unsaved`. Remove `named`.
- Add a refused case before the others:
  ```ts
        const refused = saved?.backend === 'refused'
        const savedLabel = refused
          ? 'Backend refused the files: check JEV_EXTENSION_ID on the backend'
          : saved?.archive
            ? ...existing...
  ```
  and use `state: refused ? 'error' : 'done'`.
- Keep the existing comment about deployed backends; add one line: `// A refused extension ID is a setup error, so that one is shown as such.`

**Verify**:
- `pnpm verify` → exit 0.
- `grep -rn "unreachable" src/shared/types.ts src/content/media.ts src/background/index.ts` matches only the unrelated `CodeRef.unreachable` field at `types.ts:185`.

### Step 5 (only if Chrome is available): manual check

1. `pnpm build`, then load `dist/` at `chrome://extensions` (Load unpacked).
2. **Deployed mode.** In `backend/`, run `pnpm build && pnpm start` (production; stores nothing). The default extension settings point at `http://localhost:3000`. Don't set `JEV_API_TOKEN` (the project doesn't use it). Capture a section with a background video. Expect:
   - the "Saving images, video & canvas" step finishes within a few seconds,
   - no `jev:save-media` downloads in the worker's Network panel after the first upload 404,
   - the label "Images and video linked from the live site".
3. **Refused.** Stop the production server, start `pnpm dev` in `backend/` with `JEV_EXTENSION_ID=wrong` in `backend/.env`, and capture again. Expect the red step "Backend refused the files…". Remove the line afterwards.
4. **Local mode.** Stop the production server, run `pnpm dev` in `backend/`, and capture again. Expect "Zipped N files…" and a zip download, exactly as before.

If no browser is available, say so in the report.

## Test plan

- The logic lives in content-script code that uses `chrome.runtime` messaging and the DOM, and there is no unit harness for `media.ts` or `inspector.ts`. The type change is checked by `pnpm typecheck`; the behaviour by the manual check in Step 5.
- Do not add tests that mock `chrome.*` for this plan.
- `pnpm verify` must stay green, with the same test count as before.

## Done criteria

- [ ] `pnpm verify` exits 0 in `frontend/jevelements/`
- [ ] `grep -n "unreachable?: boolean" src/shared/types.ts` returns no match
- [ ] `grep -n "BackendStop" src/shared/types.ts` returns a match
- [ ] In `src/content/media.ts`, the screenshot `upload(` call comes before `const queue` (check with `grep -n "shot.file\|const queue" src/content/media.ts`: the `shot.file` line number is lower)
- [ ] `git status` shows changes only in the four in-scope files (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 011 updated, saying whether the manual check ran

## STOP conditions

Stop and report back (do not improvise) if:
- `unreachable` (the upload one) is consumed anywhere other than `media.ts` `record`.
- The screenshot upload is not the last statement of `save()`, or `shot` is not available before the queue.
- Typecheck after Step 1 fails anywhere other than `media.ts`.
- The manual check in local mode (Step 5.4) no longer produces a zip.

## Maintenance notes

- `saved.backend` is the one place that says why files weren't kept. If a future backend can partially store (quotas), add a value to `BackendStop` rather than overloading the error text.
- When there is no screenshot (`shot` undefined), the first media upload is still what discovers the stop, so up to 4 downloads (the queue's concurrency) may still happen. That is acceptable.
- On a deployed backend, uploads get 404 before the origin check runs, so "refused" normally only appears locally with a mismatched `JEV_EXTENSION_ID`.
- Reviewer: check that skipped jobs don't end up in `saved.failed` (which would add a misleading caveat to the prompt), and that local mode still uploads everything.
