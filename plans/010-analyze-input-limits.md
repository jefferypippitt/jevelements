# Plan 010: /api/analyze bounds what one request can cost: body size, capture shape, prompt size and provider time

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root `C:\extention`:
> `git diff --stat 1cceb96..HEAD -- backend/src/lib/http.ts backend/src/lib/capture.ts backend/src/lib/judgment.ts backend/src/lib/analyze.ts backend/src/app/api/analyze/route.ts`
> Plan 007 is expected to have changed `http.ts` (`allowedOrigin()` and an import of `storesLocally`) and `route.ts` (an import of `storesLocally` and the `catch` block). Any other change: compare the excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW. Real captures are far below every limit: the extension caps the tree at 1,200 nodes (`frontend/jevelements/src/content/extract.ts:310`). The limits only reject or trim abnormal input.
- **Depends on**: plans/007-analyze-fail-closed.md (edits the same route; land 007 first)
- **Category**: security
- **Planned at**: commit `1cceb96`, 2026-10-09

## Why this matters

`POST /api/analyze` (`backend/`, a Next.js 16 app) takes a captured web-page section from the JevElements Chrome extension, builds a text "state" from it, and asks a paid LLM (TypeSafe, falling back to Vercel AI Gateway) to classify it. The backend can now be deployed publicly. Today one request can tie up the server and run up cost without limit:

- The body is read with `request.json()`, with **no size limit**.
- `isCapture` checks only `url`, `root.tag` and `root.children`. A malformed tree throws a `TypeError` deep in `captureState`, which the route reports as a 502 "Analysis failed" instead of a 400. A very deep tree overflows the stack in the recursive walks.
- Only the outline has a character budget. The page title, selector, placement lists, library names, interaction targets and sibling-group labels go into the LLM prompt **at any length**.
- The AI Gateway call has **no timeout** of its own (TypeSafe has 15 s).

After this plan:
- Oversized bodies get 413.
- Malformed captures get 400.
- Every free-text field in the LLM state has a length budget.
- The Gateway call stops after 25 s.

## Current state

All paths below are under `backend/`.

**`src/app/api/analyze/route.ts`**, body handling (lines 18–27 at `1cceb96`):
```ts
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400, headers })
  }
  const capture = (body as { capture?: unknown })?.capture
  if (!isCapture(capture)) {
    return Response.json({ error: 'Expected { capture } from the JevElements extension' }, { status: 400, headers })
  }
```
It runs after the origin (403), optional token (401, off in this project because `JEV_API_TOKEN` is not used) and content-type (415) checks. Keep that order.

**`src/lib/capture.ts:48-51`**, the shape check:
```ts
export function isCapture(value: unknown): value is Capture {
  const c = value as Capture | null
  return !!c && typeof c.url === 'string' && typeof c.root?.tag === 'string' && Array.isArray(c.root.children)
}
```
The `Capture` and `CapturedNode` interfaces (lines 4–46 of the same file) list every field the backend reads.

**Fields the backend reads that can throw when missing.** `captureState` (`capture.ts:71-98`) reads:
- `capture.root.box.w/h`, `capture.viewport.w/h`, `capture.assets` (`.filter`), `capture.responsive.length`, `capture.keyframes.length`
- `capture.runtime?.three.length`, which throws if `runtime` exists without `three`; likewise `webgl` and `lottie`
- `capture.runtime?.gsap?.tweens.length`, `physics[].bodies.length`, `interactions.items[].appeared.length`, `interactions.components[].states.length`, `scrollStory.phases` / `.pinned`

`contentOf`/`outlineOf`/`textOf` (same file) read every node's `tag`, `attrs`, `text`, `children`, `box.w/h`, `styles`, `states`, `id`, `classes`, `note`. `findSiblingGroups` (`src/lib/judgment.ts:70-96`) reads `children`, `tag`, `classes`, `box.w`, `text`.

**Unbounded strings in the LLM state**, `capture.ts:71-98`:
```ts
    page: `${capture.url} (${capture.title})`,
    captured: `${capture.selector}, ${capture.root.box.w}x${capture.root.box.h}px in a ...`,
    ...
      `Libraries: ${capture.libraries?.map((library) => library.name).join(', ') || 'none detected'}`,
      ... `${world.engine} (${world.bodies.length} bodies)` ... transition.library ...
      `Interactions played on the page: ${capture.interactions?.items.map((item) => `${item.kind} ${item.target}...`)...
      ...components.map((component) => `${component.target} (${component.states.length} states)`)...
```
and `placementOf` (`capture.ts:114-119`) prints every `placement.before` / `placement.after` entry with `JSON.stringify(band)`.

**`src/lib/judgment.ts:53-58`**, labels with unbounded id and class names:
```ts
function label(node: CapturedNode): string {
  let head = node.tag
  if (node.id) head += `#${node.id}`
  if (node.classes?.length) head += '.' + node.classes.slice(0, 3).join('.')
  return head
}
```

**`src/lib/analyze.ts:365-370`**, the Gateway call with only the caller's signal:
```ts
  const { answers, response } = await evaluate({
    model,
    state: stateRecord(state),
    questions: asked,
    abortSignal,
  })
```
`TYPESAFE_TIMEOUT_MS = 15_000` is at `analyze.ts:25`. The extension gives up after 45 s (`frontend/jevelements/src/background/index.ts:24`, `ANALYZE_TIMEOUT_MS`), so 15 s + 25 s fits inside it.

**`src/lib/analyze.ts:428-432`**, abort detection. Leave it unchanged:
```ts
function aborted(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (err instanceof APIUserAbortError) return true
  return err instanceof Error && err.name === 'AbortError'
}
```
`AbortSignal.timeout()` aborts with a `TimeoutError`, not an `AbortError`, so a Gateway timeout is reported as a failure, not as the caller cancelling.

**Conventions**:
- 2-space indent, single quotes, no semicolons, short "why" comment above each function or constant group. `capture.ts` keeps its constants at the top (`OUTLINE_BUDGET = 14_000`, etc.); add new limits next to them in the same `UPPER_SNAKE = 1_000` style.
- Tests: `node:test` + `node:assert/strict`, next to the source as `*.test.ts`, run with `tsx --test`. Exemplars: `src/lib/http.test.ts` (small pure tests) and `src/lib/routes.test.ts` (calls `POST as analyze` with `new Request(...)` in dev mode, deleting `JEV_API_TOKEN`/`JEV_EXTENSION_ID` in `before()`).
- No Next.js-specific API is involved. Route handlers take a standard `Request`. Don't add `proxy.ts`/`middleware.ts` or route segment config.

## Commands you will need

Run from `C:\extention\backend`:

| Purpose | Command | Expected on success |
|---|---|---|
| Everything | `pnpm verify` | exit 0 |
| Tests only | `pnpm test` | `ℹ fail 0` |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `backend/src/lib/http.ts`: add `readJsonBody`
- `backend/src/lib/http.test.ts`
- `backend/src/lib/capture.ts`: `isCapture`, budgets in `captureState`/`placementOf`
- `backend/src/lib/capture.test.ts` (create)
- `backend/src/lib/judgment.ts`: `label()` only
- `backend/src/lib/analyze.ts`: the Gateway `evaluate` call's `abortSignal` and one new constant only
- `backend/src/app/api/analyze/route.ts`: body reading only
- `backend/src/lib/routes.test.ts`

**Out of scope** (do NOT touch):
- `authorized()`, `allowedOrigin()`, `corsHeaders()` and the route's error handling (plan 007). Don't make `JEV_API_TOKEN` required; the project doesn't use it.
- The upload routes under `src/app/api/captures/` (they have their own limits and are off in production).
- `withFallback` and the TypeSafe call. Keep falling back on any TypeSafe failure; it is documented behaviour.
- `OUTLINE_BUDGET`/`clipOutline` (already bounded).
- Anything under `frontend/`.

## Git workflow

- Branch: `advisor/010-analyze-input-limits`, created from the branch or commit that contains plan 007.
- Commit message style: short imperative sentence, no prefix. Example: "Bound the analyze body, capture shape and prompt fields".
- Do NOT push or open a PR.

## Steps

### Step 1: A size-capped JSON reader in `http.ts`

Add to `src/lib/http.ts`:

```ts
// Reads a JSON body without trusting its size: a declared Content-Length over the cap is refused
// before reading, and a streamed body is counted as it arrives.
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string }> {
  ...
}
```

Behaviour:
- If the `content-length` header parses to a number greater than `maxBytes`, return `{ ok: false, status: 413, error: 'Body too large' }` without reading.
- If `request.body` is null, return `{ ok: false, status: 400, error: 'Body must be JSON' }`.
- Read `request.body.getReader()` in a loop, summing `value.byteLength`. As soon as the sum exceeds `maxBytes`, call `await reader.cancel()` and return the same 413.
- Concatenate the chunks (`Buffer.concat(chunks)`), decode as UTF-8, `JSON.parse`. On a parse error return the 400.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Use it in the route

In `src/app/api/analyze/route.ts`, add a non-exported module constant `const MAX_BODY_BYTES = 8 * 1024 * 1024 // a real capture is well under 1 MB of JSON` (do not `export` it; Next route files may only export handlers and config). Replace the `request.json()` try/catch with:

```ts
  const body = await readJsonBody(request, MAX_BODY_BYTES)
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status, headers })
  const capture = (body.value as { capture?: unknown })?.capture
```

Keep the `isCapture` check and its 400 message as they are.

**Verify**: `pnpm test` → `ℹ fail 0` (the existing `analyze rejects a JSON body that is not a capture` test still gets 400).

> If `typecheck` or `next typegen` complains about a non-handler top-level constant in the route file, move `MAX_BODY_BYTES` into `src/lib/http.ts` as an exported constant `MAX_ANALYZE_BYTES` and import it. Don't use any other workaround.

### Step 3: A real shape check in `isCapture`

Rewrite `isCapture` in `src/lib/capture.ts` so it accepts exactly what `captureState`, `contentOf`, `outlineOf`, `placementOf` and `findSiblingGroups` can read without throwing, and walks the tree **iteratively** (an explicit stack of `[node, depth]`, no recursion) with these limits, added as constants at the top of the file:

```ts
// Limits on what /api/analyze accepts. The extension keeps at most ~1,500 nodes (content/extract.ts).
const MAX_NODES = 5_000
const MAX_DEPTH = 200
```

Rules (return `false` on the first failure):
- Top level: `url`, `title` and `selector` are strings. `viewport` is an object with numeric `w` and `h`. `assets`, `responsive` and `keyframes` are arrays, and every `assets` item is an object with a string `kind`.
- Optional, but when present must have the right shape:
  - `libraries`: an array of objects with a string `name`.
  - `runtime`: `three`, `webgl` and `lottie` are arrays; `gsap`, if present, has an array `tweens`; `physics`, if present, is an array of objects with a string `engine` and an array `bodies`; `transitions`, if present, is an array of objects with a string `library`.
  - `scrollStory`: `phases` is an array of objects with a string `kind`, and `pinned` is an array.
  - `interactions`: `items` is an array of objects with string `kind`, string `target` and array `appeared`; `components`, if present, is an array of objects with a string `target` and an array `states`.
  - `placement`: `pageHeight` is a number; `before` and `after` are arrays of strings.
- Every node, starting at `root`:
  - `tag` is a string.
  - `attrs` is a non-null object.
  - `styles` is a non-null object.
  - `box` is an object whose `x`, `y`, `w` and `h` are numbers.
  - `children` is an array.
  - `text`, `id` and `note` are each `undefined` or a string.
  - `classes` is `undefined` or an array of strings.
  - `states` is `undefined` or an array of objects with a string `state`.
  - The node count across the whole tree never exceeds `MAX_NODES`, and depth never exceeds `MAX_DEPTH`, with root at depth 0.

Write small private helpers (`isObject`, `isStringArray`, …) rather than one giant expression. Keep the `value is Capture` signature.

**Verify**: `pnpm typecheck` → exit 0, `pnpm test` → `ℹ fail 0`.

### Step 4: Length budgets for the LLM state

In `src/lib/capture.ts`, add a helper and constants:

```ts
// Page-controlled strings are trimmed before they reach the classifier, so one capture can't inflate the prompt.
const FIELD_CHARS = 200
const NAME_CHARS = 60
const LIST_ITEMS = 20

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
```

Apply them:
- `page`: ``clip(`${capture.url} (${capture.title})`, FIELD_CHARS * 2)``
- `captured`: clip `capture.selector` to `FIELD_CHARS` inside the template.
- `Libraries`: `.slice(0, LIST_ITEMS)` before mapping, and clip each name to `NAME_CHARS`.
- Physics `engine` and transition `library`: clip each to `NAME_CHARS`, and slice the lists to `LIST_ITEMS`.
- Interaction items and components: `.slice(0, LIST_ITEMS)`, and clip each `target` to `NAME_CHARS * 2`.
- `placementOf`: `before`/`after` → `list.slice(0, 6)`, and clip each band to `NAME_CHARS` before `JSON.stringify`.

In `src/lib/judgment.ts` `label()`: clip `node.id` to 40 characters and each of the (at most 3) class names to 40 characters. `judgment.ts` should get its own local `clip` (don't import from `capture.ts`; `capture.ts` doesn't import `judgment.ts` today, and this keeps it that way).

Ordinary captures must produce identical state: every limit is far above normal values.

**Verify**: `pnpm test` → `ℹ fail 0`. Existing tests in `src/lib/anatomy.test.ts`, `src/lib/judgment.test.ts` and `src/lib/analyze.test.ts` must pass unchanged.

### Step 5: A timeout for the Gateway call

In `src/lib/analyze.ts`, add next to `TYPESAFE_TIMEOUT_MS`:

```ts
const GATEWAY_TIMEOUT_MS = 25_000 // TypeSafe's 15 s plus this stays under the extension's 45 s
```

In `analyzeWithGateway`, change the `evaluate` call's `abortSignal` to:

```ts
    abortSignal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(GATEWAY_TIMEOUT_MS)]) : AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
```

Do not change `aborted()` or `withFallback`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 6: Tests

1. **`src/lib/http.test.ts`**, tests for `readJsonBody`:
   - A valid small JSON body gives `ok: true` with the parsed value.
   - A `content-length` header over the cap gives 413 (`new Request(url, { method: 'POST', headers: { 'content-length': '100' }, body: '{}' })` with `maxBytes` 10).
   - A streamed body over the cap with no `content-length` gives 413. Use `new Request(url, { method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8)); c.enqueue(new Uint8Array(8)); c.close() } }), duplex: 'half' } as RequestInit)` with `maxBytes` 10.
   - Invalid JSON gives 400.
2. **`src/lib/capture.test.ts`** (new):
   - Define a `validCapture()` factory returning:
     ```ts
     {
       url: 'https://example.com', title: 'Example', selector: 'section',
       viewport: { w: 1280, h: 800, dpr: 1 },
       root: { tag: 'section', attrs: {}, box: { x: 0, y: 0, w: 1280, h: 600 }, styles: {}, children: [] },
       assets: [], responsive: [], keyframes: [],
     }
     ```
   - `isCapture` accepts it.
   - `isCapture` rejects each of: root without `box`; a child whose `children` isn't an array; `runtime: {}` (no `three`); `placement: { pageHeight: 1, before: [1], after: [] }`; a chain of 201 nested nodes (build it with a loop, not recursion); a root with 5,001 children.
   - `isCapture` accepts a chain of 150 nested nodes.
   - `captureState` budgets: with a 10,000-character title, 1,000 libraries with 500-character names, and placement lists of 50 entries, `state.page.length <= 401`, `state.signals.length < 5_000`, and `state.placement.length < 1_000`.
3. **`src/lib/routes.test.ts`**: `analyze refuses an oversized body before parsing it`. POST with origin `EXT`, `content-type: application/json` and `content-length: '999999999'`, body `'{}'` → status 413.

**Verify**: `pnpm verify` → exit 0. Note the new test count in your report.

## Test plan

Covered in Step 6. Patterns:
- `src/lib/http.test.ts` for pure helpers.
- `src/lib/routes.test.ts` for route-level status codes.
- `src/lib/local.test.ts` shows production-mode route tests if you need one; this plan doesn't require one.

## Done criteria

- [ ] `pnpm verify` exits 0 in `backend/`
- [ ] `grep -n "request.json()" backend/src/app/api/analyze/route.ts` returns no match
- [ ] `grep -n "AbortSignal.timeout(GATEWAY_TIMEOUT_MS)" backend/src/lib/analyze.ts` returns a match
- [ ] `backend/src/lib/capture.test.ts` exists and passes
- [ ] `isCapture` contains no recursive call (`grep -n "isCapture\|function visitNode" backend/src/lib/capture.ts` shows no self-call; read the function to confirm)
- [ ] `git status` shows changes only in in-scope files (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report back (do not improvise) if:
- Plan 007 has not landed: `grep -n "storesLocally" backend/src/lib/http.ts` returns nothing.
- An existing test's capture fixture fails the new `isCapture`. That means the backend reads a field differently than this plan assumes; report which field. Don't relax the check to make it pass.
- A test in `anatomy.test.ts`, `judgment.test.ts` or `analyze.test.ts` changes output after Step 4. That means the budgets affect normal input; report it.
- `AbortSignal.any` is missing from the installed `@types/node` (`^20`). Report it; don't add a polyfill.

## Maintenance notes

- **The validator and the extension must agree.** If the extension stops sending a field `isCapture` requires (see `frontend/jevelements/src/shared/types.ts` `Capture`/`CapturedNode`), every analysis returns 400 and the extension silently skips classification (it only logs `jev analysis skipped`). When changing the capture shape, change `backend/src/lib/capture.ts` in the same commit.
- If the backend is deployed on Vercel, the platform rejects request bodies over 4.5 MB before this code runs. Very large captures would then fail at the platform. If that shows up, the extension should slim the analysis payload further (`frontend/jevelements/src/shared/analyze.ts`), not raise this cap.
- Not done here: per-client rate limiting. Use the hosting platform's firewall/rate limits for that.
- Reviewer: confirm the order origin → auth → content type → size → shape is preserved, and that no limit is below what a real 1,500-node capture needs.
