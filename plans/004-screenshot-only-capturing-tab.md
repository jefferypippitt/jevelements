# Plan 004: Only screenshot the tab that is being captured

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from `C:\extention`:
> `git diff --stat 0e4e1a3..HEAD -- frontend/jevelements/src/background/index.ts frontend/jevelements/src/content/inspector.ts`
> If either file changed, compare the excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md (for `pnpm verify`)
- **Category**: bug (privacy)
- **Planned at**: commit `0e4e1a3`, 2026-10-07

## Why this matters

A JevElements capture runs for minutes: scroll recording, hover/click playing, pointer sweeps, a light/dark comparison and a stitched full-section screenshot. Each step asks the service worker for screenshots, often dozens. The service worker uses `chrome.tabs.captureVisibleTab(windowId)`, which captures **whatever tab is active in that window**. If the user switches to another tab mid-capture (their email, their bank), those pixels are cropped, uploaded to the backend, saved into the zip's `public/reference/`, and described as the visual source of truth in the prompt. Nothing checks for this today. After this plan:
- the service worker refuses to screenshot unless the requesting tab is the active tab of its window, before and after the capture call;
- the content script waits for its page to become visible again (up to a time limit) before asking.

## Current state

**`frontend/jevelements/src/background/index.ts`**: the service worker (MV3, `"type": "module"`).
- The message router (lines 78–85):
  ```ts
  chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse: (res: Reply) => void) => {
    const reply = (work: Promise<Reply>) => {
      work.then(sendResponse, (err) => sendResponse({ error: errorText(err) }))
      return true // keep the channel open for the async response
    }
    switch (message.type) {
      case 'jev:screenshot':
        return reply(captureCropped(sender.tab?.windowId, message).then((dataUrl) => ({ dataUrl })))
  ```
- `captureCropped` (lines 210–230):
  ```ts
  async function captureCropped(windowId: number | undefined, { rect, viewportWidth }: ScreenshotMessage): Promise<string> {
    const full = await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: 'png' })
    const bitmap = await createImageBitmap(await (await fetch(full)).blob())
    // …crop to rect, return a PNG data URL…
  }
  ```
  When `windowId` is undefined it falls back to the *current* window, which may not even be the window of the requesting tab.
- Errors thrown inside `reply(...)` become `{ error: string }` replies. The content script already handles `{ error }` from `jev:screenshot` by logging a warning and continuing without that shot (see below), so throwing is the correct way to refuse.

**`frontend/jevelements/src/content/inspector.ts`**: the on-page picker and capture orchestrator (a class `Inspector`). Every screenshot request goes through one of two private methods:
- `screenshot(target)` (lines 676–694): hides the overlay, waits two frames, sends `{ type: 'jev:screenshot', rect, viewportWidth: window.innerWidth }` via `askExtension`. On `'error' in res` it logs `console.warn('[jevelements] screenshot failed:', res.error)` and returns `undefined`.
- `shootRect(rect)` (lines 726–737): same message, same error handling. `shootUnder(rect)` (lines 701–719) calls `shootRect`. The sweeps (`content/sweep.ts`), the scheme check (`content/scheme.ts`) and the stitched screenshot (`content/frames.ts`) all reach the background through `shootUnder`/`shootRect` callbacks passed in from `inspector.ts`.
- Helper already defined at module level in `inspector.ts:31`: `const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))`. `requestAnimationFrame` does not fire in a hidden tab, which is one more reason to wait for visibility before calling it.

`askExtension` (`src/shared/reply.ts`) returns `T | { error: string }` and never throws.

**Conventions**: TypeScript strict, no semicolons, single quotes, 2-space indent. Comments are short plain sentences explaining *why*, e.g. `// Service workers can't make blob: URLs, so the screenshot is handed over as a data URL.` User-facing error strings are lowercase fragments or short sentences, e.g. `'Element is not visible in the viewport'`.

## Commands you will need

Run in `frontend/jevelements/`:

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| All gates | `pnpm verify` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:
- `frontend/jevelements/src/background/index.ts`
- `frontend/jevelements/src/content/inspector.ts`: only the `screenshot` and `shootRect` methods and one new private helper

**Out of scope**:
- `src/content/sweep.ts`, `scheme.ts`, `frames.ts`: they already tolerate an `undefined` shot.
- `src/shared/types.ts`: the `ScreenshotMessage` shape does not change. The tab comes from `sender.tab`, which the extension runtime fills in and a web page cannot forge.
- Adding an abort/cancel mechanism to the capture. That is a separate, larger change.

## Git workflow

- Branch: `advisor/004-screenshot-only-capturing-tab`
- Commit message style: plain imperative sentence, e.g. `Only screenshot the tab that is being captured`.
- Do not push or open a PR unless told to.

## Steps

### Step 1: Guard `captureCropped` in the service worker

1. In the router, pass the whole tab: `captureCropped(sender.tab, message)`.
2. Rewrite the head of `captureCropped`:
   ```ts
   // captureVisibleTab shoots whatever tab is in front, so a capture keeps going only while its own tab is.
   async function captureCropped(tab: chrome.tabs.Tab | undefined, { rect, viewportWidth }: ScreenshotMessage): Promise<string> {
     if (tab?.id === undefined) throw new Error('screenshots are only taken for a page tab')
     const inFront = async () => {
       const now = await chrome.tabs.get(tab.id!)
       return now.active && now.windowId === tab.windowId
     }
     if (!(await inFront())) throw new Error('the tab is in the background; switch back to it to continue')
     const full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
     if (!(await inFront())) throw new Error('the tab was switched during the screenshot')
     const bitmap = await createImageBitmap(await (await fetch(full)).blob())
     // …rest of the existing function unchanged…
   ```
   Remove the `windowId ?? chrome.windows.WINDOW_ID_CURRENT` fallback. A missing tab is now an error.
   If `tab.id!` trips the lint rule `@typescript-eslint/no-non-null-assertion`, copy the id into a `const tabId = tab.id` after the undefined check and use that.

**Verify**: `pnpm typecheck` → exit 0. `pnpm lint` → exit 0. `grep -n "WINDOW_ID_CURRENT" src/background/index.ts` → no matches.

### Step 2: Wait for visibility in the content script

Add a private helper to `Inspector`, next to `shootRect`:
```ts
// A hidden tab can't be screenshotted (the service worker refuses), so wait a while for the user to come back.
private async whenVisible(timeoutMs = 60_000): Promise<boolean> {
  if (document.visibilityState === 'visible') return true
  return new Promise((resolve) => {
    const done = (visible: boolean) => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onChange)
      resolve(visible)
    }
    const onChange = () => {
      if (document.visibilityState === 'visible') done(true)
    }
    const timer = window.setTimeout(() => done(false), timeoutMs)
    document.addEventListener('visibilitychange', onChange)
  })
}
```
Call it as the **first statement** of both `screenshot()` and `shootRect()`:
```ts
if (!(await this.whenVisible())) {
  console.warn('[jevelements] screenshot skipped: the tab stayed in the background')
  return undefined
}
```
In `screenshot()`, this goes before `const r = target.getBoundingClientRect()` and before the overlay is hidden. The existing `await nextFrame()` calls there must come *after* the wait, because `requestAnimationFrame` never fires while the tab is hidden. Nothing has been hidden yet at that point, so the early return needs no cleanup.
In `shootRect()`, put it before the existing `try`. After it, when the tab was hidden and just came back (i.e. `whenVisible` did not return immediately), wait `await nextFrame()` twice before shooting so the page has painted again. A simple way: `const wasHidden = document.visibilityState !== 'visible'` before the wait, then `if (wasHidden) { await nextFrame(); await nextFrame() }` after it.

**Verify**: `pnpm verify` → exit 0. `pnpm build` → exit 0.

### Step 3: Manual check (for a human with Chrome, optional for the executor)

If you can't run Chrome, write in your report that this step was not run.
1. Load `frontend/jevelements/dist` at `chrome://extensions` → Load unpacked. Start the backend: `pnpm dev` in `backend/`.
2. Open a long page, press Alt+Shift+E, click a large section.
3. While the drawer says "Playing hover & click", switch to another tab for 10 seconds, then come back.
4. Expected:
   - the capture finishes;
   - the service worker console (chrome://extensions → JevElements → "service worker") shows no screenshot of the other tab being taken;
   - the page console shows either nothing or `screenshot skipped` warnings, but no `screenshot failed: the tab was switched…` for shots taken after you returned;
   - the zip's `public/reference/` images show only the captured page.

## Test plan

No automated test. The changed code is a thin layer over `chrome.tabs` and `document.visibilityState`, which the Node unit harness from plan 001 doesn't provide, and a mock would mostly test itself. Verification is the typecheck, lint, build and the manual check in step 3. Do not add a chrome-API mock framework for this plan.

## Done criteria

- [ ] `cd frontend/jevelements && pnpm verify` exits 0
- [ ] `pnpm build` exits 0
- [ ] `grep -n "chrome.tabs.get(" src/background/index.ts` → at least one match inside `captureCropped`
- [ ] `grep -n "WINDOW_ID_CURRENT" src/background/index.ts` → no matches
- [ ] `grep -c "whenVisible" src/content/inspector.ts` → 3 (definition plus two calls)
- [ ] `git diff --name-only` lists only `src/background/index.ts` and `src/content/inspector.ts` in `frontend/jevelements`
- [ ] `plans/README.md` status row for 004 updated (note whether the manual check was run)

## STOP conditions

- `captureCropped` is called from somewhere other than the `jev:screenshot` case. Check with `grep -n "captureCropped" -r src`. Changing its signature would then affect another caller.
- `sender.tab` is `undefined` for screenshot requests in practice (the manual check shows `screenshots are only taken for a page tab`). That would mean requests come from a context other than the content script.
- The typecheck says `chrome.tabs.Tab` has no `active` or `windowId` field. That indicates a different `@types/chrome` than expected (0.3.0 is installed).

## Maintenance notes

- Any new screenshot path must go through `screenshot()`/`shootRect()` in `inspector.ts`, so it gets the visibility wait. The service worker guard is the backstop, not the primary UX.
- A capture that stays in the background past the 60 s wait loses those shots silently, apart from console warnings. A follow-up could surface "paused: switch back to the tab" in the status drawer. Deferred because the drawer's step list is owned by `runCapture`, which a separate plan restructures.
- Reviewers: check that the second `inFront()` check runs *after* `captureVisibleTab`. That check handles a switch that lands between the first check and the capture.
