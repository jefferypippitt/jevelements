# Plan 012: An options page sets the backend URL, shows the extension ID, and tests the connection

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root `C:\extention`:
> `git diff --stat 1cceb96..HEAD -- frontend/jevelements/src/shared/storage.ts frontend/jevelements/src/shared/types.ts frontend/jevelements/src/background/index.ts frontend/jevelements/vite.config.ts frontend/jevelements/public/manifest.json frontend/jevelements/README.md`
> Plans 009 and 011 are expected to have changed `background/index.ts` (`download`, `saveMedia`, `put`) and `types.ts` (`UploadResult`, `SavedFiles`, `BackendStop`). Any other change: compare the excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW. Purely additive UI.
- **Depends on**: plans/009-worker-media-fetch-policy.md and plans/011-skip-downloads-when-backend-stores-nothing.md (both edit `src/background/index.ts`; land them first to avoid conflicts). It pairs with plans/007-analyze-fail-closed.md, which tells deployed-backend operators to set `JEV_EXTENSION_ID`; this page shows the ID to copy.
- **Category**: direction / dx
- **Planned at**: commit `1cceb96`, 2026-10-09 (revised the same day: the project does **not** use `JEV_API_TOKEN`, so there is no token field)

## Why this matters

The JevElements extension (`frontend/jevelements/`, Chrome MV3) sends captures for classification to a backend at `settings.backendUrl`, default `http://localhost:3000`. The backend can now be deployed, but **nothing in the extension writes that setting**:
- There is no options page.
- No code calls `chrome.storage.*.set` for `settings`.

So the only way to point the extension at a deployed backend is a console one-liner in the service worker's devtools. A deployed backend should also set `JEV_EXTENSION_ID` to the extension's ID, which users can only find on `chrome://extensions`.

The backend's only secrets are `TYPESAFE_API_KEY` and the fallback `AI_GATEWAY_API_KEY`, and they live on the backend. **The extension needs no secret, so this page has no token field.**

After this plan, `chrome://extensions` → JevElements → Details → **Extension options** offers:
- a backend URL field;
- the extension ID to copy;
- a **Test connection** button that checks reachability and the extension-ID pin without using any LLM credits.

Also, the "start it with pnpm dev" hint only appears for a local backend.

## Current state

All paths below are under `frontend/jevelements/`.

**`src/shared/storage.ts`** (whole file):
```ts
import { DEFAULT_SETTINGS } from './types'
import type { Settings } from './types'

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.sync.get('settings')
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) }
}
```

**`src/shared/types.ts`** (around lines 547–555). `backendToken` is an unused optional field; leave it as is:
```ts
export interface Settings {
  backendUrl: string
  backendToken: string
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://localhost:3000',
  backendToken: '',
}
```

**`getSettings()` callers**: only `src/background/index.ts`, in `analyze()`, `put()` and `saveProject()`.

**`src/background/index.ts`, `analyze()` network-error message** (~line 132):
```ts
  } catch {
    return { error: `backend not reachable at ${backendUrl} (start it with "pnpm dev" in backend/)` }
  }
```

**Build.** `pnpm build` = `tsc -b && vite build && vite build -c vite.content.config.ts && vite build -c vite.probe.config.ts`.

`vite.config.ts` (whole file):
```ts
import { defineConfig } from 'vite'

// Builds the background service worker (dist/background.js) and copies public/ (the manifest).
// The content script is built separately by vite.content.config.ts because it must be a single classic script.
export default defineConfig({
  build: {
    rolldownOptions: {
      input: { background: 'src/background/index.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
})
```
`dist/` currently contains `background.js`, `content.js`, `probe.js`, `manifest.json` and `icons/`. `public/manifest.json` is copied as-is. It has `permissions: ["activeTab", "scripting", "storage"]` and `host_permissions: ["<all_urls>"]`, so the options page can `fetch` any backend without new permissions.

**TypeScript.** `tsconfig.app.json` includes `src` with `lib: ["ES2023", "DOM"]` and `types: ["vite/client", "chrome"]`, so `src/options/*.ts` typechecks with no config change. Unit tests live in `test/unit/*.test.ts` (`node:test`; exemplar `test/unit/files.test.ts`) and can only test modules without `chrome.*` calls.

**How the backend answers.** This is how "Test connection" can tell outcomes apart **without spending LLM credits**. In `backend/src/app/api/analyze/route.ts` the checks run in this order:
1. Origin (403).
2. Optional token (401; off, because the project doesn't use `JEV_API_TOKEN`).
3. JSON content type (415).
4. Body: a JSON body without a `capture` returns **400** before any model call.

So `POST /api/analyze` with body `{}` and `Content-Type: application/json` returns:
- 400: reachable, and this extension is accepted
- 403: the backend's `JEV_EXTENSION_ID` names a different extension
- 401: the backend has `JEV_API_TOKEN` set (unexpected for this project)
- network error: not reachable

**UI conventions.** The in-page drawer (`src/content/overlay.css`, `theme.css`) is shadcn-like: neutral colours, `system-ui`/Inter, 6–8 px radii, 13–14 px text. The options page should look plain and consistent: one small HTML file, one TS module, inline CSS, no framework. Use `textContent`, never `innerHTML` (the codebase has no `innerHTML`; keep it that way).

**Code style**: 2-space indent, single quotes, no semicolons, a one-line "why" comment above functions.

## Commands you will need

Run from `C:\extention\frontend\jevelements`:

| Purpose | Command | Expected on success |
|---|---|---|
| Everything | `pnpm verify` | exit 0 |
| Build | `pnpm build` | exit 0; `dist/options.html` exists |
| One test | `pnpm exec tsx --test test/unit/settings.test.ts` | `ℹ fail 0` |

## Scope

**In scope** (the only files you should modify or create):
- `frontend/jevelements/src/shared/settings.ts` (create): pure helpers, no `chrome.*`
- `frontend/jevelements/test/unit/settings.test.ts` (create)
- `frontend/jevelements/src/shared/storage.ts`: add `saveBackendUrl`
- `frontend/jevelements/src/options/index.ts` (create)
- `frontend/jevelements/options.html` (create, project root next to `vite.config.ts`)
- `frontend/jevelements/vite.config.ts`
- `frontend/jevelements/public/manifest.json`: add `options_ui` only
- `frontend/jevelements/src/background/index.ts`: the `analyze()` catch message only
- `frontend/jevelements/README.md`: one short section

**Out of scope** (do NOT touch):
- No token field and no token UI. Don't remove the existing `backendToken` plumbing either; it is a dormant optional feature, and removing it is a separate decision.
- Permissions in the manifest. No new permissions are needed.
- The content scripts, the probe, `prompt.ts`.
- The backend.
- `Settings`/`DEFAULT_SETTINGS` in `types.ts`.

## Git workflow

- Branch: `advisor/012-extension-options-page`, created from the commit that contains plans 009 and 011.
- Commit message style: short imperative sentence, no prefix. Example: "Add an options page for the backend URL".
- Do NOT push or open a PR.

## Steps

### Step 1: Pure helpers

Create `src/shared/settings.ts`:

```ts
// The backend's origin from what the user typed: http(s) only, path dropped. Null when unusable.
export function normalizeBackendUrl(input: string): string | null

// A backend on this machine, for messages that suggest running `pnpm dev`.
export function isLoopback(backendUrl: string): boolean
```

Rules:
- `normalizeBackendUrl`:
  1. Trim the input.
  2. If it has no `://`, prefix `http://` when it starts with `localhost` or `127.`, otherwise `https://`.
  3. Parse it with `new URL`. Return `null` on a parse error or when the protocol isn't `http:`/`https:`.
  4. Return `url.origin`, which has no trailing slash and no path.
- `isLoopback`: the hostname is `localhost`, ends in `.localhost`, is an IPv4 address starting with `127.`, or is `[::1]`. Return false when the URL doesn't parse.

Create `test/unit/settings.test.ts` covering:
- `normalizeBackendUrl`: `'localhost:3000'` → `'http://localhost:3000'`; `'https://jev.example.com/api/'` → `'https://jev.example.com'`; `'jev.example.com'` → `'https://jev.example.com'`; `'ftp://x'` → `null`; `''` → `null`.
- `isLoopback`: true for `http://localhost:3000`, `http://127.0.0.1:3000` and `http://[::1]:3000`; false for `https://jev.example.com` and `not a url`.

**Verify**: `pnpm exec tsx --test test/unit/settings.test.ts` → `ℹ fail 0`.

### Step 2: Save the URL

In `src/shared/storage.ts`, add:

```ts
// Keeps any other stored settings fields as they are.
export async function saveBackendUrl(backendUrl: string): Promise<void> {
  const { settings } = await chrome.storage.sync.get('settings')
  await chrome.storage.sync.set({ settings: { ...(settings as Partial<Settings> | undefined), backendUrl } })
}
```

Leave `getSettings()` unchanged.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Local-only hint in the worker

In `src/background/index.ts`, import `isLoopback` from `'../shared/settings'`. In `analyze()`'s catch:
- when `isLoopback(backendUrl)`, keep today's message;
- otherwise return `` `backend not reachable at ${backendUrl}` ``.

**Verify**: `pnpm verify` → exit 0.

### Step 4: The options page

Create `options.html` at the project root: a `<!doctype html>` page with `<meta charset="utf-8">`, `<title>JevElements options</title>`, a small inline `<style>`, and `<script type="module" src="/src/options/index.ts"></script>`. Its body contains:
- `<h1>JevElements</h1>` and one sentence: "Where the extension sends captures for classification."
- A **Backend URL** text input (`id="url"`, placeholder `http://localhost:3000`) with the hint: "Your local backend (pnpm dev in backend/) or a deployed one."
- A read-only **Extension ID** line (`id="extension-id"`) with the hint: "On a deployed backend, set JEV_EXTENSION_ID to this so it only answers this extension."
- Buttons **Save** (`id="save"`) and **Test connection** (`id="test"`), and a status line `<p id="status" role="status">`.

Create `src/options/index.ts`:
- **On load**: `getSettings()`, then fill `#url`. Set `#extension-id` text to `chrome.runtime.id`.
- **Save**: `normalizeBackendUrl(url.value)`. If it returns `null`, set the status "Enter an http(s) URL" and stop. Otherwise call `saveBackendUrl`, put the normalized URL back in the input, and set the status "Saved".
- **Test connection**: normalize the current input value, applying the same validation as Save, then:
  ```ts
  // An empty JSON body is refused with 400 before the backend calls any model, so this costs nothing.
  fetch(new URL('/api/analyze', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  })
  ```
  Map the result to status text:
  - 400 → "Connected. The backend accepts this extension."
  - 403 → "The backend only accepts another extension: set JEV_EXTENSION_ID to the ID above."
  - 401 → "The backend requires JEV_API_TOKEN, which this extension doesn't send. Remove it from the backend's env."
  - any other status → `` `Unexpected answer: HTTP ${status}` ``
  - a thrown error → `` `Not reachable at ${url}` ``, plus ` (start it with "pnpm dev" in backend/)` when `isLoopback(url)`.
- Set all text with `textContent`.

In `vite.config.ts`, add the page to the inputs, `input: { background: 'src/background/index.ts', options: 'options.html' }`, and update the comment to mention the options page.

In `public/manifest.json`, add `"options_ui": { "page": "options.html", "open_in_tab": false }` after `"action"`.

**Verify**:
- `pnpm build` → exit 0.
- `ls dist` shows `options.html`, and the `<script` `src` in `dist/options.html` points at a file that exists in `dist/` (`grep -o 'src="[^"]*"' dist/options.html`, then `ls` that path).
- `pnpm verify` → exit 0.

### Step 5: README

In `frontend/jevelements/README.md`, add a short section **Backend settings** that says:
- Open `chrome://extensions` → JevElements → Details → **Extension options**.
- Set the backend URL (default `http://localhost:3000`).
- **Test connection** checks it without using any credits.
- For a deployed backend, copy the extension ID shown there into the backend's `JEV_EXTENSION_ID`.

**Verify**: `git diff --stat` lists only in-scope files.

### Step 6 (only if Chrome is available): manual check

1. `pnpm build`, then reload the unpacked extension.
2. Open Extension options. The URL shows `http://localhost:3000`, and the ID is shown.
3. Start `pnpm dev` in `backend/` and click **Test connection**. Expect "Connected…".
4. Stop the backend and test again. Expect "Not reachable… pnpm dev".
5. Type `localhost:3000/foo` and click Save. The field becomes `http://localhost:3000`, and the worker uses it on the next capture.

If no browser is available, say so in the report.

## Test plan

- `test/unit/settings.test.ts` (Step 1) covers all URL rules.
- The options page, storage and worker use `chrome.*` and have no harness here, so they are covered by typecheck plus the manual check (Step 6).
- `pnpm verify` → all pass.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `pnpm build` exits 0, and `dist/options.html` exists with a resolvable script `src`
- [ ] `grep -n '"options_ui"' public/manifest.json` returns a match
- [ ] `grep -rn "innerHTML" src/options options.html` returns no match
- [ ] `grep -rni "token" src/options options.html` matches only the 401 message
- [ ] `git status` shows changes only in in-scope files (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 012 updated, saying whether the manual check ran

## STOP conditions

Stop and report back (do not improvise) if:
- Vite doesn't emit `dist/options.html`, or emits it under a sub-path (e.g. `dist/src/...`). Report the produced paths; don't move files around until the build happens to work.
- The backend no longer answers 400 to `POST /api/analyze` with `{}` from the extension origin (check `backend/src/app/api/analyze/route.ts`). The Test mapping would then be wrong.
- Plans 009/011 haven't landed and `background/index.ts` conflicts with their expected shape.

## Maintenance notes

- If the backend's analyze route changes its check order or status codes, update the Test mapping in `src/options/index.ts`.
- `backendToken` remains in `Settings` and is still sent if someone sets it by hand. If the project decides the token feature is gone for good, remove it from the backend (`authorized()` in `backend/src/lib/http.ts`) and the extension in one change.
- Reviewer: check that the Test button can never trigger a paid analysis (it must always send `{}`).
