# Plan 013: ✕, Esc or a swipe during a capture stops it within seconds, restores the page, and closes the drawer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root:
> `git diff --stat 1cceb96..HEAD -- frontend/jevelements/src/content/inspector.ts frontend/jevelements/src/content/interactions.ts frontend/jevelements/src/content/states.ts frontend/jevelements/src/content/scroll.ts frontend/jevelements/src/content/sweep.ts frontend/jevelements/src/content/media.ts`
> If any of these changed, compare the "Current state" excerpts with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED. It touches the capture orchestrator and five stage modules. Every change is additive: an optional `signal` that, when aborted, takes the stage's existing "out of time" exit. With no abort, behaviour is identical.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1cceb96`, 2026-10-09

## Why this matters

JevElements is a Chrome extension (`frontend/jevelements/`). When the user picks a section, `Inspector.runCapture` (`src/content/inspector.ts`) runs a pipeline that drives the live page for a minute or more:
- it scrolls the section;
- it hovers and clicks controls;
- it explores component states;
- it sweeps the pointer and clicks over canvases;
- it compares light and dark mode, then downloads files.

A status drawer shows the progress.

**Today nothing can stop it.** The drawer's ✕, Esc and a swipe all call `dismissDrawer`, which only removes the drawer. The capture keeps clicking and scrolling, and the drawer slides back in at the next progress update, because `showPanel` reopens a drawer whenever none is open. The user's Escape also reaches the page and can close a menu the capture opened, which corrupts what is being recorded. In the end the capture still downloads a zip the user tried to cancel.

After this plan:
- While a capture runs, ✕, Esc or a swipe **stops it**.
- The drawer shows "Stopping the capture…".
- Each stage leaves through its existing "out of time" path, which already restores the page (scroll position, hover state, blocked navigation and writes).
- The drawer then closes: no result, no zip, no "Capture failed".
- That Escape is not passed on to the page.

## Current state

All paths below are under `frontend/jevelements/src/content/`.

### `inspector.ts`, the orchestrator

- Class fields (line 217–222): `private active = false`, `private drawers: HTMLDivElement[] = []`, `private capturing = false`, and others.
- `capture()` (lines 427–437):
  ```ts
  private async capture(target: Element) {
    if (this.capturing) return // one capture at a time: a second one would fight the first over the page
    this.capturing = true
    await this.markCapturing(true)
    try {
      await this.runCapture(target)
    } finally {
      this.capturing = false
      void this.markCapturing(false)
    }
  }
  ```
- `showStatus` (line 421): `this.showPanel([el('div', { className: 'markers' }, steps.map(statusMarker))])`. `StatusStep` is `{ label: string; state: 'active' | 'done' | 'error' }` (see its use in `interrupted()` at line 460).
- `runCapture(target)` (lines 469–695). Before the `try` it takes a screenshot (`await this.screenshot(target)`). Inside the `try`, these awaited stages run in order:
  1. `Promise.all([captureElement(...), inspectRuntime(target)])` (line 483)
  2. `await addSnapshots(...)` (line 503)
  3. `await recordScroll({ runtime, onProgress })` (line 510, inside `if (wantsScrollRecording(...))`)
  4. `await recordInteractions({ onProgress, onExplore, onFocus }).finally(...)` (line 536)
  5. `await sweepHover(target, { shoot, drawerEdge, onProgress, onFocus }).finally(...)` (line 566)
  6. `await sweepClicks(target, { ... }).finally(...)` (line 590)
  7. `await compareSchemes(...)` (line 611)
  8. `capture.code = await findCanvasCode(target, capture)` (line 624)
  9. `capture.fullScreenshot = await captureFullSection(...)` (line 637)
  10. `await saveMedia(capture, shot, (done, total) => progress(...))` (line 650)
  11. `const res = await this.analyze(capture)` (line 669)
  12. `packaged = await this.packageApp(capture, capture.saved.archive)` (line 678). It clicks a link that downloads the zip.
  13. `this.renderResult(capture, packaged, shot)` (line 683)

  The `catch (err)` (lines 684–687) shows `Capture failed: …`. The `finally` (lines 688–694) stops the text log and calls `endSweep()` and `endClickSweep(target)`.
- Drawers:
  - `showPanel` (lines 822–830) opens a drawer if `this.drawers` is empty.
  - `openDrawer` (line 837): ✕ → `this.dismissDrawer(this.drawers[0])`.
  - `enableSwipe` (line 880): a long enough swipe → `this.dismissDrawer(panel)`, else `panel.style.transform = ''`.
  - `dismissDrawer` (lines 888–896):
    ```ts
    private dismissDrawer(panel: HTMLDivElement) {
      const index = this.drawers.indexOf(panel)
      if (index < 0) return
      const closing = this.drawers.splice(index)
      ...
    }
    ```
  - `closePanel()` (lines 899–903) removes every drawer immediately.
  - `onPanelKey` (lines 911–915), a window capture-phase keydown listener:
    ```ts
    private onPanelKey = (e: KeyboardEvent) => {
      const top = this.drawers.at(-1)
      // A synthetic Escape is the capture closing a menu it opened (play.ts), not the user.
      if (e.isTrusted && e.key === 'Escape' && !this.active && top) this.dismissDrawer(top)
    }
    ```
    It does not call `preventDefault`/`stopImmediatePropagation`, so the page also sees the Escape.

### The stages and their existing "out of time" exits

Each long stage already has a time budget, checked at loop boundaries, and a `finally` that restores the page. This plan adds "or the capture was stopped" to those same checks.

- **`scroll.ts`**:
  - `ScrollOptions` (lines 133–136) is `{ runtime?: RuntimeData; onProgress?: (done: number, total: number) => void }`.
  - `recordScrollMotion(root, visible, { runtime, onProgress }: ScrollOptions = {})` (line 138).
  - Main loop at line 213: `for (let i = 0; i < positions.length; i++) {`.
  - Its `finally` (line 256) disconnects the observer and restores `window.scrollTo({ top: startY, behavior: 'instant' })`.
  - `extract.ts:1714` passes options straight through: `recordScroll: (options) => recordScrollMotion(root, ctx.visible, options)`.
- **`interactions.ts`**:
  - `InteractionOptions` (lines 53–57) is `{ onProgress?, onExplore?, onFocus? }`.
  - `recordInteractions(..., { onProgress, onExplore, onFocus }: InteractionOptions = {}, moved)` (line 182).
  - Flat loop at line 205: `for (const [n, c] of list.entries()) { if (performance.now() - started > BUDGET_MS) break; onProgress?.(n, list.length) ...`.
  - Components loop at line 302: `for (const [i, component] of found.components.entries()) {`. It calls `exploreComponent(component, { section: root, layers, media, deadline, autoplay, moved, onState: ..., onFocus })` at line 312.
  - `finally` at line 323 restores the guard, write blocking, forced hovers and scroll.
  - `extract.ts:1717` passes `options` through.
- **`states.ts`**:
  - `ExploreContext` (lines 373–385) has `deadline: number` and others.
  - The explore loop at line 610: `for (let next = nextItem(); next && clicks < MAX_CLICKS && performance.now() < x.deadline; next = nextItem()) {`.
  - `exploreComponent` (lines 400–412+) loops `for (let grown = 0; ; grown++) { const explored = await explore(component, x); clicks += explored.clicks; if (!explored.grow || explored.blocked || grown >= MAX_GROW) return { ...explored, clicks }; ... }` inside a `try/finally`.
- **`sweep.ts`**:
  - `SweepOptions` (line 77) has `shoot?`, `drawerEdge?`, `onProgress?`, `onFocus?`.
  - `sweepHover` (line 1665) loops `for (const [i, el] of list.entries()) { if (now() > until || !el.isConnected) continue ...` with a `finally` that unblocks the real pointer and restores scroll.
  - `sweepClicks` (line 2282) has the same loop shape and a `finally` that also restores the guard and write blocking.
  - Per-target functions:
    - `sweepOne(el, root, { shoot, onProgress, onFocus, drawerEdge }: SweepOptions, deadline, step)` at line 1074, with deadline checks at lines 1269 (`if (now() > deadline) {` → `outOfTime = true; break`), 1397 (same) and 1429 (`if (reacted && now() < deadline + 5000) {`).
    - `clickOne(el, root, { shoot, onProgress, onFocus, drawerEdge }: SweepOptions, deadline, step)` at line 1871, with checks at lines 1999 (`if (now() > deadline) { stoppedBy = 'time'; break }`) and 2053 (`if (canvas && now() < deadline + 5000) {`).
  - Budgets: up to 35 s per hover-sweep target and 25 s per click-sweep target. Without these inner checks a stop would wait that long.
- **`media.ts`**:
  - `saveMedia(capture, shot, onProgress?)` (line 95) calls `save(capture, shot, saved, onProgress)` (line 104).
  - Download queue worker at lines 199–205:
    ```ts
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        await next()
        onProgress?.(++finished, total)
      }
    }
    ```

### Conventions

- 2-space indent, single quotes, no semicolons.
- A short "why" comment above non-obvious code; option fields carry trailing `//` comments (see `InteractionOptions`).
- The codebase has no `AbortController` use yet. Use the standard DOM `AbortController`/`AbortSignal` (`lib: ["ES2023", "DOM"]` in `tsconfig.app.json`).

## Commands you will need

Run from `frontend/jevelements`:

| Purpose | Command | Expected on success |
|---|---|---|
| Install (fresh worktree) | `pnpm install` | exit 0, `pnpm-lock.yaml` unchanged |
| Everything | `pnpm verify` | exit 0 (typecheck, lint, 42 unit tests) |
| Build | `pnpm build` | exit 0 (bundles the content script that contains all of this) |

## Scope

**In scope** (the only files you should modify):
- `frontend/jevelements/src/content/inspector.ts`
- `frontend/jevelements/src/content/scroll.ts`: `ScrollOptions`, `recordScrollMotion`'s destructure and main loop only
- `frontend/jevelements/src/content/interactions.ts`: `InteractionOptions`, the destructure, the two loops, and the `exploreComponent(...)` call only
- `frontend/jevelements/src/content/states.ts`: `ExploreContext`, the loop at line 610, and the `exploreComponent` grow loop only
- `frontend/jevelements/src/content/sweep.ts`: `SweepOptions`, the loops in `sweepHover`/`sweepClicks`, and the five deadline checks in `sweepOne`/`clickOne` only
- `frontend/jevelements/src/content/media.ts`: `saveMedia`/`save` signatures and the queue worker only

**Out of scope** (do NOT touch):
- Any stage's restore/cleanup code (`finally` blocks). The point is to reuse it unchanged.
- `captureElement`, `inspectRuntime`, `compareSchemes`, `findCanvasCode`, `captureFullSection` and `analyze`. They are short or bounded; the orchestrator checks for a stop after each.
- The picker's own Esc handling (`onKey`, which exits the picker while `this.active`).
- `src/background/`, `src/shared/`, `src/probe/`.
- The known leak in `clickOne`'s `follow()` (observer/pointer not in `finally`). It is a separate finding; don't fix it here.

## Git workflow

- Branch: `advisor/013-stop-capture`
- Commit message style: short imperative sentence, no prefix (e.g. "Only screenshot the tab that is being captured"). Example: "Stop a running capture from the drawer's close, Esc or swipe".
- Do NOT push or open a PR.

## Steps

### Step 1: Let each stage take its "out of time" exit on a stop

Add an optional `signal?: AbortSignal` to each stage. When `signal.aborted` is true, the stage behaves exactly as if its time budget had run out.

1. **`scroll.ts`**:
   - Add `signal?: AbortSignal // the capture was stopped: stop scrolling, restore the page` to `ScrollOptions`.
   - Destructure `signal` in `recordScrollMotion`.
   - Add `if (signal?.aborted) break` as the first statement inside the `for (let i = 0; i < positions.length; i++) {` loop at line 213.
2. **`interactions.ts`**:
   - Add `signal?: AbortSignal // the capture was stopped: no more hovers or clicks` to `InteractionOptions`.
   - Destructure it.
   - Change the flat loop's first line to `if (performance.now() - started > BUDGET_MS || signal?.aborted) break`.
   - Add `if (signal?.aborted) break` as the first statement of the components loop.
   - Pass `signal` in the `exploreComponent(component, { ... })` object.
3. **`states.ts`**:
   - Add `signal?: AbortSignal // the capture was stopped: explore no further` to `ExploreContext`.
   - Change the loop at line 610 to `... && performance.now() < x.deadline && !x.signal?.aborted; ...`.
   - In `exploreComponent`'s grow loop, add `|| x.signal?.aborted` to the `return` condition (`if (!explored.grow || explored.blocked || grown >= MAX_GROW || x.signal?.aborted) return ...`).
4. **`sweep.ts`**:
   - Add `signal?: AbortSignal // the capture was stopped: end the sweep as if out of time` to `SweepOptions`.
   - In `sweepHover` and `sweepClicks`, add `if (options.signal?.aborted) break` as the first statement of the `for (const [i, el] of list.entries())` loop.
   - In `sweepOne` and `clickOne`, add `signal` to the destructured options. Then change:
     - the checks at lines 1269, 1397 and 1999 from `now() > deadline` to `now() > deadline || !!signal?.aborted`;
     - the checks at lines 1429 and 2053 from `now() < deadline + 5000` to `now() < deadline + 5000 && !signal?.aborted`.
5. **`media.ts`**:
   - Add a last parameter `signal?: AbortSignal` to `saveMedia` and `save`, and pass it through.
   - Change the worker loop to `for (let next = queue.shift(); next && !signal?.aborted; next = queue.shift()) {`.

**Verify**: `pnpm verify` → exit 0 (nothing passes a signal yet, so behaviour is unchanged). Run `git diff --stat`: only the five stage files changed so far.

### Step 2: Own the stop in the inspector

In `inspector.ts`:

1. Add a field next to `capturing`: `private stopping: AbortController | null = null // the running capture's stop switch`.
2. Add, near the other capture helpers:
   ```ts
   // The user closed the drawer while a capture runs: every stage ends as if out of time (restoring the
   // page as it always does), then runCapture closes the drawer instead of showing a result.
   private stopCapture() {
     if (!this.stopping || this.stopping.signal.aborted) return
     this.stopping.abort()
     this.showPanel([el('div', { className: 'markers' }, [statusMarker({ label: 'Stopping the capture…', state: 'active' })])])
   }
   ```
3. In `capture()`, create the controller right after `this.capturing = true` (`this.stopping = new AbortController()`), and set `this.stopping = null` in the `finally`.
4. In `showStatus`, return early when a stop was requested, so progress from stages winding down can't overwrite "Stopping…": `if (this.stopping?.signal.aborted) return`.
5. In `dismissDrawer`, as the first statement:
   ```ts
   // While a capture runs, closing its drawer (✕, Esc, swipe) stops the capture; the drawer closes when it has.
   if (this.capturing) {
     panel.style.transform = '' // a swipe left it part-way out
     return this.stopCapture()
   }
   ```
6. In `onPanelKey`, when the condition matches, stop the event before acting, so the page never sees the user's Escape:
   ```ts
   if (e.isTrusted && e.key === 'Escape' && !this.active && top) {
     e.preventDefault()
     e.stopImmediatePropagation()
     this.dismissDrawer(top)
   }
   ```
   Keep the existing comment.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Wire the signal through `runCapture` and check between stages

In `runCapture`:

1. At the top: `const signal = this.stopping?.signal`.
2. Define a local helper:
   ```ts
   // Between stages: a stopped capture goes no further (the catch below closes the drawer).
   const stopIfAsked = () => {
     if (signal?.aborted) throw new Error('capture stopped')
   }
   ```
3. Pass `signal` to the stages: `recordScroll({ runtime, signal, onProgress: ... })`, `recordInteractions({ signal, onProgress, onExplore, onFocus })`, `sweepHover(target, { signal, shoot, ... })`, `sweepClicks(target, { signal, shoot, ... })`, and `saveMedia(capture, shot, (done, total) => ..., signal)`.
4. Call `stopIfAsked()` right after each of these awaits:
   - the `Promise.all` (stage 1);
   - `addSnapshots`;
   - `recordScroll`, inside its `if`;
   - `recordInteractions`;
   - `sweepHover`, inside its `if`;
   - `sweepClicks`, inside its `if`;
   - `compareSchemes`;
   - `findCanvasCode`, inside its `if`;
   - the full-section screenshot block (after its `try/finally`, inside its `if`);
   - `saveMedia`;
   - `this.analyze(capture)`.

   The last check, after `analyze`, must come **before** the `if (capture.saved?.archive)` packaging block, so a stopped capture never downloads a zip.

   Also call it once **before** the `try`, right after `const screenshot = await this.screenshot(target)`. Since that's outside the `try`, handle it directly: `if (signal?.aborted) { this.closePanel(); return }`.
5. At the start of the `catch (err)` block:
   ```ts
   if (signal?.aborted) {
     this.closePanel() // stopped by the user: no result, no error
     return
   }
   ```
   The existing `finally` (text log, `endSweep`, `endClickSweep`) still runs; don't change it.

**Verify**:
- `pnpm verify` → exit 0, 42 tests.
- `pnpm build` → exit 0.
- `grep -c "stopIfAsked()" src/content/inspector.ts` prints at least `11`.
- `grep -n "signal" src/content/inspector.ts`: the signal is passed to `recordScroll`, `recordInteractions`, `sweepHover`, `sweepClicks` and `saveMedia`.

### Step 4 (only if Chrome is available): manual check

1. `pnpm build`, then load or reload `dist/` at `chrome://extensions`.
2. With `pnpm dev` running in `backend/`, open a page with interactive content, e.g. `pnpm test:build && pnpm test:serve` and open the served `test/hover.html` or `test/click.html`.
3. Pick a section. While "Playing hover & click" or "Sweeping the pointer" runs, press **Esc**. Expect:
   - "Stopping the capture…" appears;
   - within about 5 s the drawer closes;
   - the page is scrolled back to where it was;
   - no zip downloads.

   Then pick a section again; a new capture starts normally.
4. Repeat with the drawer's **✕**, and with a swipe right on the drawer.
5. Let one capture run to the end without stopping. Expect the normal result drawer and zip.

If no browser is available, say so in the report.

## Test plan

- The changed code is content-script code that drives a live DOM, and the repo has no harness for it. Unit tests can't cover it without a browser.
- Verification is:
  - `pnpm verify` and `pnpm build`, proving types and bundling and that the 42 existing tests are unaffected;
  - the grep checks;
  - the manual check in Step 4.
- Do not add tests that mock the DOM or `chrome.*` for this plan.

## Done criteria

- [ ] `pnpm verify` exits 0 (42 tests) and `pnpm build` exits 0 in `frontend/jevelements/`
- [ ] `grep -c "signal?.aborted" src/content/sweep.ts` prints at least `7` (2 outer loops + 5 deadline checks)
- [ ] `grep -n "signal" src/content/scroll.ts src/content/interactions.ts src/content/states.ts src/content/media.ts` shows the option and a check in each file
- [ ] `grep -n "stopImmediatePropagation" src/content/inspector.ts` shows a match inside `onPanelKey`
- [ ] In `runCapture`, the `stopIfAsked()` after `this.analyze(capture)` comes before `if (capture.saved?.archive)` (read it)
- [ ] `git diff --stat` lists only the six in-scope files (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 013 updated, saying whether the manual check ran

## STOP conditions

Stop and report back (do not improvise) if:
- Any loop or deadline check quoted in "Current state" isn't there, or has a different shape. In particular, if a deadline check in `sweepOne`/`clickOne` exits *without* going through its function's normal wrap-up (e.g. it `return`s from the middle of a pointer press), report it rather than adding the signal there.
- `recordScroll` or `recordInteractions` in `extract.ts` don't pass their `options` argument straight through (you'd have to edit `extract.ts`).
- Making it work seems to require changing a `finally`/cleanup block.
- After Step 1, `pnpm verify` fails in a way that suggests behaviour changed without a signal.

## Maintenance notes

- **The rule for any new long-running stage:** take an optional `signal`, treat `signal.aborted` as "out of time" at the same loop boundaries as its budget, and let the existing `finally` restore the page. Then add a `stopIfAsked()` after it in `runCapture`.
- Not instantly interruptible: the initial "Watching motion" watch, the light/dark comparison, the full-section stitch, files already downloading (up to 4 in flight), and the backend classification call (up to 45 s). The UI shows "Stopping…" until the current one finishes. If that proves annoying, thread the signal into `askExtension`/`fetch` next.
- Deferred plan 011 also edits `media.ts` `save()` and the inspector's save-label block. If it is ever executed after this one, its drift check will flag these changes; they don't conflict logically.
- Reviewer: check that no `finally` changed, that a stopped capture can't reach `packageApp` or `renderResult`, and that `dismissDrawer` behaves exactly as before when no capture is running (result drawers, nested screenshot drawers).
