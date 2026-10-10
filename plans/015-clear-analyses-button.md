# Plan 015: A "Delete all" button above the Recent Analyses table clears the run log, with a confirm step

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root:
> `git diff --stat 347b544..HEAD -- backend/src/lib/runs.ts backend/src/components/home/runs-table.tsx backend/src/app/page.tsx`
> If any of these changed, compare the "Current state" excerpts with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P3 (requested by the user)
- **Effort**: S
- **Risk**: LOW. It is local-dev only, and in production the action does nothing.
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `347b544`, 2026-10-09

## Why this matters

The backend's status page (`backend/src/app/page.tsx`, at `http://localhost:3000` during `pnpm dev`) shows a **Recent Analyses** table of `/api/analyze` calls. The table reads a JSON log in the OS temp directory (`jevelements-runs.json`, last 200 runs). Today the only way to clear it is to find and delete that file by hand. The user wants a button on the page.

After this plan, the header above the table has a **Delete all** button:
1. Clicking it turns the button into an inline confirmation: "Delete N analyses?" with **Delete** and **Cancel** buttons. Clearing the log can't be undone, so there is a confirm step, but no modal.
2. **Delete** removes the log through a Server Action and refreshes the page, which then shows the existing "No analyses yet" empty state.

In production (`NODE_ENV=production`) the page shows no table at all, and the action does nothing.

## Current state

All paths are under `backend/` (Next.js 16.3.8, App Router, React 19.2, Tailwind v4, shadcn `base-nova` style).

**`src/lib/runs.ts`** keeps the log. Relevant parts:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { storesLocally } from './local'

const FILE = path.join(tmpdir(), 'jevelements-runs.json')
...
let pending: Promise<void> = Promise.resolve()

// Serialized so two analyses finishing together don't overwrite each other's entry.
export function recordRun(run: Run): Promise<void> {
  if (!storesLocally()) return Promise.resolve()
  pending = pending.then(async () => {
    const runs = [run, ...(await readRuns())].slice(0, MAX_RUNS)
    ...
    await rename(tmp, FILE)
  }).catch((err) => console.warn('[runs] could not save run', err))
  return pending
}

// Newest first.
export async function readRuns(): Promise<Run[]> {
  if (!storesLocally()) return []
  try { ... JSON.parse(await readFile(FILE, 'utf8')) ... } catch { return [] }
}
```

`storesLocally()` (`src/lib/local.ts`) returns `process.env.NODE_ENV !== 'production'`. A missing file already reads back as `[]`.

**`src/components/home/runs-table.tsx`** is a Server Component; it has no `'use client'`.
- It renders the `Empty` state when `runs.length === 0`.
- Otherwise it renders:
  ```tsx
  <section className="flex flex-col gap-4">
    <div className="flex flex-col gap-1">
      <h2 className="text-base font-medium tracking-tight">Recent Analyses</h2>
      <p className="text-sm text-muted-foreground">Reload the page to see new analyses.</p>
    </div>
    <div className="rounded-none border">
      <Table ...>
  ```

**`src/app/page.tsx`** renders `<RunsTable runs={runs} />` after `await connection()` and `readRuns()`. In production it returns early and shows no table.

**UI kit.** `src/components/ui/` has only `alert.tsx`, `empty.tsx` and `table.tsx`. There is **no** shadcn `Button` or `AlertDialog`, and no Base UI or Radix package is installed.
- Don't add any. Use a plain `<button>` styled with Tailwind, which keeps this dependency-free.
- Theme tokens exist in `src/app/globals.css`: `bg-muted`, `text-muted-foreground`, `bg-destructive`, `text-destructive`, `border`, `ring`.
- The page uses square corners (`rounded-none border` on the table and the stats grid). Match it.
- Icons come from `lucide-react` (e.g. `import { InboxIcon } from 'lucide-react'`).
- Class merging uses `import { cn } from '@/lib/utils'`.

**Next.js 16 Server Functions** (from `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`, which you should read before writing code):
- Define them in a file whose first line is `'use server'`; Client Components import them from there.
- They are reachable by direct POST requests, so guard inside the function itself.
- After a mutation, call `refresh()` from `next/cache` to re-render the current page with fresh data.
- Pending UI: use React's `useTransition` (`const [pending, startTransition] = useTransition()`) or `useActionState`.

**Code style.** In the files you write, follow `src/components/home/*.tsx` and `src/lib/*.ts`: 2-space indent, single quotes, no semicolons. (`src/components/ui/*` is generated shadcn code with double quotes; don't copy that style.) Add short "why" comments above functions.

**Tests.** They use `node:test` + `node:assert/strict`, run by `tsx --test "src/**/*.test.ts"`, next to the source. `src/lib/local.test.ts` shows how to switch `NODE_ENV` (`const env = process.env as Record<string, string | undefined>`, set in `before`, restore in `after`). The run log path is fixed in the real temp directory, so **any test that writes or clears it must back up the file's contents first and restore them afterwards**, so running tests never wipes the developer's log.

## Commands you will need

Run from `backend/`:

| Purpose | Command | Expected on success |
|---|---|---|
| Install (fresh worktree) | `pnpm install` | exit 0; `pnpm-lock.yaml` unchanged |
| Everything | `pnpm verify` | exit 0 (typecheck, lint, 42 tests before this plan) |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you should modify or create):
- `backend/src/lib/runs.ts`: add `clearRuns`
- `backend/src/lib/runs.test.ts` (create)
- `backend/src/app/actions.ts` (create)
- `backend/src/components/home/clear-runs-button.tsx` (create)
- `backend/src/components/home/runs-table.tsx`: the header block only

**Out of scope** (do NOT touch):
- `src/components/ui/*` and `package.json` / `pnpm-lock.yaml`. Add no dependencies and run no shadcn CLI.
- `src/app/page.tsx`, `src/lib/local.ts`, the API routes, and the capture files in `jevelements-captures/`. This button clears the analyses log only.

## Git workflow

- Branch: `advisor/015-clear-analyses-button`
- Commit message style: short imperative sentence, no prefix. Example: "Add a Delete all button for the recent analyses log".
- Do NOT push or open a PR.

## Steps

### Step 1: `clearRuns()` in `runs.ts`

Add `rm` to the `node:fs/promises` import and export:

```ts
// Empties the log (the status page's Delete all). Queued behind any run still being written, so a
// run that finishes during the clear can't bring the old entries back.
export function clearRuns(): Promise<void> {
  if (!storesLocally()) return Promise.resolve()
  pending = pending.then(() => rm(FILE, { force: true })).catch((err) => console.warn('[runs] could not clear runs', err))
  return pending
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Test it without touching the developer's log

Create `src/lib/runs.test.ts`:
- `before()`:
  - save `NODE_ENV`, set it to `'development'`;
  - save the current log contents: `const file = path.join(tmpdir(), 'jevelements-runs.json')`, then `backup = await readFile(file, 'utf8').catch(() => null)`.
- `after()`:
  - restore the file: if `backup !== null`, `writeFile(file, backup)`; else `rm(file, { force: true })`;
  - restore `NODE_ENV`.

Tests:
1. `clearRuns empties the log`: `recordRun({...})` with a minimal valid `Run`, assert `(await readRuns()).length >= 1`, then `await clearRuns()`, then assert `deepEqual(await readRuns(), [])`. A valid `Run` looks like: `{ at: new Date().toISOString(), provider: 'typesafe', ok: true, url: 'https://example.com', model: null, sectionType: null, durationMs: 1, fallbackReason: null, error: null }`.
2. `clearRuns does nothing in production`: write a run in development mode first, switch `NODE_ENV` to `'production'`, `await clearRuns()`, switch back to `'development'`, then assert `readRuns()` still has the run.

**Verify**: `pnpm test` → `ℹ fail 0`, 44 tests. Also run `ls "$(node -e "process.stdout.write(require('os').tmpdir())")" | grep jevelements-runs`. The log file should be in the same state as before the test (present or absent).

### Step 3: The Server Action

Create `src/app/actions.ts`:

```ts
'use server'

import { refresh } from 'next/cache'
import { storesLocally } from '@/lib/local'
import { clearRuns } from '@/lib/runs'

// The status page's Delete all. Reachable by a direct POST like any Server Action, so it checks
// for itself: a deployed backend keeps no log and has nothing to clear.
export async function clearRunsAction(): Promise<void> {
  if (!storesLocally()) return
  await clearRuns()
  refresh()
}
```

If `refresh` is not exported from `next/cache` in this Next version (check `node_modules/next/cache.d.ts` or the docs), use `revalidatePath('/')` instead and note it in the report.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: The button with an inline confirm

Create `src/components/home/clear-runs-button.tsx`, a Client Component (`'use client'` first line), exporting `ClearRunsButton({ count }: { count: number })`:

- **State**: `const [confirming, setConfirming] = useState(false)` and `const [pending, startTransition] = useTransition()`.
- **Idle**: one outline button containing `<Trash2Icon className="size-4" />` and the label "Delete all". Clicking it sets `confirming` to true.
- **Confirming**:
  - the text `Delete ${count} ${count === 1 ? 'analysis' : 'analyses'}?` in `text-sm text-muted-foreground`;
  - a destructive **Delete** button that calls `startTransition(async () => { await clearRunsAction() })`;
  - an outline **Cancel** button that sets `confirming` to false.

  While `pending`, both buttons are `disabled` and Delete reads "Deleting…".
- **Accessibility**:
  - `type="button"` on every button;
  - when entering the confirm state, move focus to Cancel (a `ref` plus `useEffect`), so Enter doesn't delete by accident;
  - Escape while confirming cancels (`onKeyDown` on the wrapper).
- **Styles** (Tailwind, square corners like the table):
  - Shared: `inline-flex h-8 items-center gap-1.5 rounded-none border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50`.
  - Outline: add `bg-background hover:bg-muted`.
  - Destructive: add `border-destructive bg-destructive text-white hover:bg-destructive/90`.

  Put each variant's classes in a small local helper or constant. Don't create a shared `ui/button.tsx`.

**Verify**: `pnpm typecheck` and `pnpm lint` → exit 0.

### Step 5: Put it above the table

In `runs-table.tsx`, change only the header block of the non-empty branch to place the title and the button side by side:

```tsx
<div className="flex flex-wrap items-end justify-between gap-3">
  <div className="flex flex-col gap-1">
    <h2 className="text-base font-medium tracking-tight">Recent Analyses</h2>
    <p className="text-sm text-muted-foreground">Reload the page to see new analyses.</p>
  </div>
  <ClearRunsButton count={runs.length} />
</div>
```

Import `ClearRunsButton` from `./clear-runs-button`. The empty state gets no button, because there is nothing to delete.

**Verify**: `pnpm verify` → exit 0, 44 tests. `pnpm build` → exit 0.

### Step 6 (optional, only if you can run a dev server and an HTTP client): smoke check

Run `pnpm dev` and `curl -s http://127.0.0.1:3000/`. When the log has entries, the HTML contains `Delete all`. Stop the dev server afterwards. Skip this if it can't be done cleanly, and say so.

## Test plan

- `src/lib/runs.test.ts`: 2 tests (clears in development, no-op in production) that back up and restore the real log.
- The button is UI-only. Typecheck, lint, the build, and the user's manual check in the browser cover it.

## Done criteria

- [ ] `pnpm verify` exits 0 in `backend/`, with 44 tests
- [ ] `pnpm build` exits 0
- [ ] `head -1 src/app/actions.ts` prints `'use server'`
- [ ] `head -1 src/components/home/clear-runs-button.tsx` prints `'use client'`
- [ ] `grep -n "storesLocally" src/app/actions.ts` matches
- [ ] `git diff --stat` shows only the five in-scope files, and `package.json`/`pnpm-lock.yaml` are unchanged
- [ ] `plans/README.md` status row for 015 updated

## STOP conditions

Stop and report back (do not improvise) if:
- `runs.ts` or the header block of `runs-table.tsx` doesn't match the excerpts.
- Neither `refresh` nor `revalidatePath` is exported from `next/cache`.
- The build fails because a Server Component imports the client button in a way Next 16 rejects (report the exact error).
- The test can't be written without risking the developer's real log, e.g. if backup/restore isn't possible.

## Maintenance notes

- If the run log ever moves out of the temp directory or becomes a database, update `clearRuns` and the test's backup/restore.
- If more destructive actions are added to this page, consider adding shadcn's `Button`/`AlertDialog` then, rather than more hand-styled buttons.
- Reviewer: check that the action is a no-op in production, that tests restore the real log file, and that Cancel (not Delete) gets focus in the confirm state.
