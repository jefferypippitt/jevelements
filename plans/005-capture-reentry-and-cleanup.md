# Plan 005: One capture at a time, and clean up after every capture, even failed ones

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from `C:\extention`:
> `git diff --stat 0e4e1a3..HEAD -- frontend/jevelements/src/content/inspector.ts frontend/jevelements/src/content/play.ts frontend/jevelements/src/content/states.ts`
> Plan 004 edits `inspector.ts` (only the `screenshot`/`shootRect` methods and a new `whenVisible` helper). That diff is expected. Any other change to these files: compare the excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md (for `pnpm verify`). Land after plans/004-screenshot-only-capturing-tab.md, which touches the same file, to avoid merge conflicts.
- **Category**: bug
- **Planned at**: commit `0e4e1a3`, 2026-10-07

## Why this matters

JevElements' content script (`Inspector`) runs a capture that lasts minutes and drives the page itself: it dispatches synthetic `pointerdown`/`mousedown`/`click`/`mousemove` events, toggles guards, and marks elements with `data-jev-*` attributes. Three defects come from how that capture starts and ends:

1. **A second capture can start inside the first.** Nothing reads `this.capturing` to refuse a new capture. If the user presses the toolbar icon or Alt+Shift+E mid-capture, `start()` re-arms the picker and calls `closePanel()`, which destroys the status drawer. The picker's window-level listeners don't check `e.isTrusted`, so the capture's own synthetic clicks are swallowed by the picker, and one of them triggers `this.capture(...)` on whatever element a synthetic `mousemove` last highlighted. Two captures then fight over the page and corrupt each other's measurements.
2. **The page-wide `TextLog` MutationObserver leaks** when the user opens the picker and presses Esc, or when a capture throws. It observes `document.body` subtree-wide until the picker is opened again.
3. **Failed captures leave `data-jev-*` marks and MutationObservers behind.** The cleanup calls for these run only on the success path.

This plan makes the capture single-flight, makes the picker accept only real user input, and moves cleanup into `finally` blocks. It does **not** add user cancellation; that's a larger change for a later plan.

## Current state

All paths are under `frontend/jevelements/src/content/`.

**`inspector.ts`**: class `Inspector`.
- Fields (lines 220–221):
  ```ts
  private textLog: TextLog | null = null // text the page animates while the picker is open
  private capturing = false
  ```
- `start()` / `stop()` (lines 265–299):
  ```ts
  start() {
    if (this.active) return
    this.active = true
    this.closePanel()
    if (!this.host.isConnected) document.documentElement.appendChild(this.host)
    this.shadow.append(this.toolbar)
    this.textLog?.stop()
    this.textLog = new TextLog()
    this.textLog.start()
    window.addEventListener('mousemove', this.onMove, true)
    window.addEventListener('click', this.onClick, true)
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'])
      window.addEventListener(type, this.swallow, true)
    // …keydown, scroll, resize…
  }

  stop() {
    if (!this.active) return
    this.active = false
    // …removes the same listeners, hides toolbar/highlight…
    this.current = null
    this.childTrail = []
  }
  ```
  Note: `stop()` never touches `this.textLog`.
- Picker listeners (lines 340–347, 373–384). Only `onKey` checks `isTrusted`:
  ```ts
  private onMove = (e: MouseEvent) => {
    let target = e.target as Element | null
    if (target === document.documentElement) target = document.body
    if (!target || this.isOwn(target) || target === this.current) return
    // …
  }
  private swallow = (e: Event) => {
    if (this.isOwn(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  private onClick = (e: MouseEvent) => {
    if (this.isOwn(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (this.current) void this.capture(this.current)
  }
  private onKey = (e: KeyboardEvent) => {
    const handled = ['Escape', 'ArrowUp', 'ArrowDown', 'Enter']
    // Only the user's own keys: the capture's undo step dispatches a synthetic Escape (play.ts).
    if (!e.isTrusted || !handled.includes(e.key)) return
    // …Enter calls void this.capture(this.current)
  }
  ```
- `capture()` (lines 417–426):
  ```ts
  private async capture(target: Element) {
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
- `runCapture(target)` (lines 458–674): it calls `this.stop()` first (so `this.active` is false during a capture), then runs all steps inside one `try { … } catch (err) { … }`. The success path ends with:
  ```ts
      this.textLog?.stop()
      this.textLog = null
      this.renderResult(capture, packaged, shot)
    } catch (err) {
      console.error('[jevelements] capture failed', err)
      const message = err instanceof Error ? err.message : String(err)
      this.showStatus([...steps.filter((step) => step.state !== 'active'), { label: `Capture failed: ${message}`, state: 'error' }])
    }
  }
  ```
  Inside the `try`, the sweep steps call `endSweep()` and `endClickSweep(target)` only in the `else` branch, when there was nothing to sweep (lines 566 and 590). When there *was* something to sweep, `sweepHover`/`sweepClicks` clean up in their own `finally`. If the capture throws *before* reaching the sweeps (for example in `recordInteractions`), neither runs. `endSweep`, `endClickSweep` are already imported from `./sweep`:
  ```ts
  // sweep.ts:1661 and 1762: both are idempotent attribute removals
  export function endSweep() { document.documentElement.removeAttribute(PROBE_POINTER_ATTR) }
  export function endClickSweep(root: Element) {
    document.documentElement.removeAttribute(PROBE_CLICK_ATTR)
    root.querySelectorAll(`[${PROBE_INTERACTIVE_ATTR}]`).forEach((el) => el.removeAttribute(PROBE_INTERACTIVE_ATTR))
    root.removeAttribute(PROBE_INTERACTIVE_ATTR)
  }
  ```
  Those attributes are read only by `interactions.ts`, `play.ts`, `states.ts` and `sweep.ts`, all of which finish before the light/dark step. Removing them again at the very end is safe.
- `interrupted(from, to)` (line 434) reads `if (this.capturing) return`. Keep that behaviour.

**`play.ts`**: `export async function play(c, root, scope, media, forced?)` (lines 437–536). It creates `observer` (a MutationObserver on `root`, shadow roots and `document.body`) and a capture-phase `scroll` listener on `document` (lines 453–481). It removes them on two normal paths: inside the nested `left()` (lines 498–499) and before the final diff (lines 519–520):
```ts
  observer.disconnect()
  document.removeEventListener('scroll', scrolled, true)
```
Nothing removes them if `settle`, `followPhases`, `snapshot` or `left()` throws. `MutationObserver.disconnect()` and `removeEventListener` are safe to call twice.

**`states.ts`**: `async function explore(component, x)` (lines 417–708) creates `changes`, a MutationObserver on `x.section` and `document.body` (lines 435–437). It calls `changes.disconnect()` only at line 646 (the early "grow" return) and line 706 (the normal return). `exploreComponent` (lines 400–415) wraps `explore` and already uses `try/finally` for `holdClock`, which is the pattern to copy.

**Conventions**: TypeScript strict, no semicolons, single quotes, 2-space indent. Comments are one plain sentence saying *why*, e.g. `// Only the user's own keys: the capture's undo step dispatches a synthetic Escape (play.ts).` Console messages are prefixed `[jevelements]`.

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
- `frontend/jevelements/src/content/inspector.ts`: `start`, `stop`, `onMove`, `swallow`, `onClick`, `capture`, `runCapture` (the catch/finally only)
- `frontend/jevelements/src/content/play.ts`: `play` only
- `frontend/jevelements/src/content/states.ts`: `explore` only

**Out of scope**:
- Making ✕/Esc cancel a running capture (AbortController threading). Separate plan; it touches every capture step.
- `sweep.ts`, `interactions.ts`, `timeline.ts`: their cleanup is already correct.
- `shared/reply.ts` / the `jev:capturing` boolean reply quirk. It is a known separate finding; leave it.
- Changing what the capture records, or any step order in `runCapture`.

## Git workflow

- Branch: `advisor/005-capture-reentry-and-cleanup`
- One commit per step is fine. Message style: plain imperative sentence, e.g. `Refuse a second capture while one is running`.
- Do not push or open a PR unless told to.

## Steps

### Step 1: Single-flight capture

1. In `capture()`, add as the first line:
   ```ts
   if (this.capturing) return // one capture at a time: a second one would fight the first over the page
   ```
2. In `start()`, change the guard to:
   ```ts
   if (this.active || this.capturing) return
   ```
   so the toolbar icon or shortcut mid-capture can't re-arm the picker or close the status drawer. `toggle()` needs no change: with `active` false it calls `start()`, which now returns early.

**Verify**: `pnpm typecheck` → exit 0. `grep -n "if (this.capturing) return" src/content/inspector.ts` → 2 matches (the existing one in `interrupted` plus the new one in `capture`). `grep -n "if (this.active || this.capturing) return" src/content/inspector.ts` → 1 match.

### Step 2: The picker listens only to the user

Add `if (!e.isTrusted) return` as the **first** line of `onMove`, `swallow` and `onClick`. Above `swallow`, add one comment covering all three:
```ts
// The picker only reacts to the user: the capture dispatches synthetic pointer events of its own (play.ts, sweep.ts).
```

**Verify**: `pnpm lint` → exit 0. `grep -c "if (!e.isTrusted) return" src/content/inspector.ts` → 3. `onKey` already checks with a different expression, so it isn't counted.

### Step 3: Stop the TextLog on every exit

1. In `stop()`, after `this.active = false`, add:
   ```ts
   // A capture still needs the text log (runCapture stops it); otherwise the picker was dismissed.
   if (!this.capturing) {
     this.textLog?.stop()
     this.textLog = null
   }
   ```
   This works because `capture()` sets `this.capturing = true` before `runCapture` calls `this.stop()`.
2. Turn the `try { … } catch (err) { … }` in `runCapture` into `try { … } catch (err) { … } finally { … }`:
   ```ts
   } finally {
     // Success or failure, leave nothing of the capture on the page.
     this.textLog?.stop()
     this.textLog = null
     endSweep()
     endClickSweep(target)
   }
   ```
   Leave the existing success-path `this.textLog?.stop(); this.textLog = null` before `renderResult` in place. Calling it twice is harmless, and keeping it avoids reordering the success path.

**Verify**: `pnpm typecheck` → exit 0. `grep -n "endClickSweep(target)" src/content/inspector.ts` → 2 matches (the existing `else` branch and the new `finally`).

### Step 4: `play()` always disconnects its observer

In `play.ts`, wrap everything in `play()` from the line after `document.addEventListener('scroll', scrolled, true)` through the final `return { item, changed, … }` in `try { … } finally { … }`:
```ts
  } finally {
    // A step that throws must not leave the observer and scroll listener on the page.
    observer.disconnect()
    document.removeEventListener('scroll', scrolled, true)
  }
```
Keep the existing `observer.disconnect()` / `removeEventListener` calls where they are. They run earlier on purpose (before `history.back()` and before the diff), and repeating them in `finally` is harmless. Only indentation changes inside the block; no statement changes.

**Verify**: `pnpm typecheck` → exit 0. `git diff -w src/content/play.ts` (whitespace ignored) shows only the `try {` line and the `finally` block added.

### Step 5: `explore()` always disconnects `changes`

In `states.ts` `explore()`, do the same: wrap from the line after `changes.observe(document.body, { childList: true })` to the end of the function body in `try { … } finally { changes.disconnect() }`, with a one-line comment like the one in step 4. Keep the existing `changes.disconnect()` calls at the early and normal returns.

**Verify**: `pnpm typecheck` → exit 0. `git diff -w src/content/states.ts` shows only the `try {` line and the `finally` block added.

### Step 6: Full gates and build

**Verify**: `pnpm verify` → exit 0. `pnpm build` → exit 0.

### Step 7: Manual check (for a human with Chrome, optional for the executor)

If you can't run Chrome, write in your report that this step was not run. Load `dist/` unpacked, run the backend (`pnpm dev` in `backend/`), run `pnpm test:build && pnpm test:serve` in `frontend/jevelements`, and open `http://127.0.0.1:5178/test/click.html` (or any page with buttons).
1. Start a capture. While it says "Playing hover & click", press Alt+Shift+E. Expected: no picker toolbar appears, the status drawer stays, and only one capture finishes.
2. Open the picker (Alt+Shift+E), press Esc. In DevTools → Console, run `getEventListeners` / the Performance monitor, or simply confirm no errors appear. The leak isn't easily observable by hand; rely on the code review for it.
3. In DevTools, after any capture finishes (or fails), run `document.querySelectorAll('[data-jev-interactive]').length` → `0`, and `document.documentElement.hasAttribute('data-jev-click')` → `false`.

## Test plan

No new automated tests. These code paths need a live DOM with synthetic events and long-running async steps, which the Node unit harness from plan 001 doesn't provide. Verification is typecheck, lint, build, whitespace-insensitive diffs that show only structural `try/finally` additions, and the manual check. A future browser-driven harness (the existing `test/*.html` pages plus a headless browser) is the right place for regression tests here.

## Done criteria

- [ ] `cd frontend/jevelements && pnpm verify` exits 0
- [ ] `pnpm build` exits 0
- [ ] `grep -c "if (!e.isTrusted) return" src/content/inspector.ts` → `3`
- [ ] `grep -n "if (this.active || this.capturing) return" src/content/inspector.ts` → 1 match
- [ ] `git diff -w 0e4e1a3 -- src/content/play.ts src/content/states.ts` shows only `try {` lines, `finally` blocks and their comments
- [ ] No files outside the three in-scope files changed by this plan
- [ ] `plans/README.md` status row for 005 updated (note whether the manual check ran)

## STOP conditions

- `runCapture` no longer starts with `this.stop()`, or `capture()` no longer sets `capturing = true` before calling it. Step 3's `stop()` logic depends on that order.
- `play()` or `explore()` has a `return` inside a nested callback that you would need to restructure to fit the `try/finally`. Wrapping must not change control flow; if it would, stop and report.
- `pnpm typecheck` reports "used before assigned" or similar after wrapping. A `const` may need to move above the `try`. Report it instead of reshuffling declarations.
- You find another caller of `Inspector.capture` besides `onClick` and `onKey` (`grep -n "this.capture(" src/content/inspector.ts`).

## Maintenance notes

- The single-flight guard makes "cancel" the natural next step. A cancel plan should add an `AbortController` per capture, abort it from `dismissDrawer`/`onPanelKey` while `capturing`, and check `signal.aborted` next to the existing `now() > deadline` checks in `interactions.ts`, `states.ts` and `sweep.ts`.
- Any new capture step that adds observers, listeners or attributes to the host page should clean up in `finally`, as the existing steps (`sweepHover`, `recordInteractions`, `captureFullSection`) do. Reviewers should check that.
- If the picker ever needs to respond to synthetic events (e.g. automated tests that dispatch clicks), the `isTrusted` checks will need a test-only escape hatch. Don't add one preemptively.
