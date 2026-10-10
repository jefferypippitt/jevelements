# Plan 007: A deployed backend only answers the extension, and stops sending internal errors to callers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root `C:\extention`:
> `git diff --stat 1cceb96..HEAD -- backend/src/lib/http.ts backend/src/lib/http.test.ts backend/src/lib/local.test.ts backend/src/app/api/analyze/route.ts backend/.env.example backend/README.md`
> If any of these files changed, compare the "Current state" excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW. Local development (`pnpm dev`) is unchanged. In production, only requests without an `Origin` header (curl, scripts, scanners) are newly refused; the extension always sends one.
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `1cceb96`, 2026-10-09 (revised the same day: the project does **not** use `JEV_API_TOKEN`)

## Why this matters

The backend (`backend/`, a Next.js 16 app) classifies a captured web-page section by calling paid LLM APIs. It uses TypeSafe with `TYPESAFE_API_KEY`, and falls back to Vercel AI Gateway with `AI_GATEWAY_API_KEY` when TypeSafe fails or runs out of credits. Those two keys are the only secrets this project uses. **The project does not use the optional `JEV_API_TOKEN` shared secret, and this plan must not make it required.**

Commit `efa43df` made the backend deployable (with `NODE_ENV=production` it stores nothing). Its request checks were written for a loopback-only dev server:
- `allowedOrigin()` accepts any request **with no `Origin` header**, which is how curl, scripts and internet scanners call it. The comment says such callers are covered by the token, but no token is used. Anyone who finds a deployed URL can therefore spend the operator's TypeSafe / AI Gateway credits with a plain script.
- On failure the route returns `err.message` verbatim. That message includes raw TypeSafe/AI Gateway error text (quota wording, model IDs) and, when no key is set, the names of the env vars and the `.env` path.

After this plan, on a deployed backend:
- Requests without an `Origin` header get 403, while the Chrome extension, which always sends `Origin: chrome-extension://<id>`, keeps working.
- Error bodies say only "Analysis failed"; full details go to the server log.
- `.env.example` and the README tell the operator to set `JEV_EXTENSION_ID`, and to cap spend at the providers.

**Limits, stated honestly:** the `Origin` header can be set by any non-browser client, so this stops casual and automated abuse, not a determined attacker. Without a secret, the real cost bound is a spend limit on the TypeSafe and AI Gateway accounts plus the hosting platform's rate limiting. The README change in Step 5 says so.

## Current state

All paths below are under `backend/`.

**`src/lib/local.ts`**: the local/deployed switch. Do not change it.
```ts
export function storesLocally(): boolean {
  return process.env.NODE_ENV !== 'production'
}
```

**`src/lib/http.ts:19-30`**, the origin check used by every API route:
```ts
// Browsers attach Origin to cross-site requests, so a web page can't pass for the extension.
// Requests without Origin (curl, scripts) still go through authorized().
export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  return origin === null || extensionOrigin(origin)
}

// Any extension by default; JEV_EXTENSION_ID pins it to one install.
function extensionOrigin(origin: string): boolean {
  const id = process.env.JEV_EXTENSION_ID?.trim()
  return id ? origin === `chrome-extension://${id}` : origin.startsWith('chrome-extension://')
}
```
The file has no imports today. `authorized()` (lines 13–17) is the optional `JEV_API_TOKEN` check. **Leave `authorized()` unchanged**: with no token set it returns `true`, which is the intended setup.

**`src/app/api/analyze/route.ts`**, end of `POST` (lines 29–36):
```ts
  try {
    const analysis = await analyzeCapture(capture, { abortSignal: request.signal })
    return Response.json({ analysis }, { headers })
  } catch (err) {
    console.error('[analyze] jev evaluation failed', err)
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `Analysis failed: ${message}` }, { status: 502, headers })
  }
```
The origin check (`if (!allowedOrigin(request)) return ... 403`) is the first thing `POST` does.

**`src/lib/analyze.ts:281-282`**: with no provider key, the error says `'Set TYPESAFE_API_KEY in backend/.env (AI_GATEWAY_API_KEY is the fallback)'`. Leave it; it is useful in dev, and the route stops forwarding it in production.

**Other routes** (`src/app/api/captures/...`) also call `allowedOrigin()`, but in production they return 404 before reaching it (`if (!storesLocally()) return ...`). The change only affects `/api/analyze` in production. Do not edit those files.

**The extension.** Its service worker (`frontend/jevelements/src/background/index.ts`, `analyze()`) does a cross-origin `fetch` POST to the backend. Chrome sends `Origin: chrome-extension://<id>` on it, so the extension passes. The extension only logs the analysis error (`frontend/jevelements/src/content/inspector.ts:670`, `console.info('[jevelements] jev analysis skipped:', res.error)`), so a generic message changes nothing users see.

**`.env.example`** lists `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY`, each with a comment line above it.

**Test conventions.** Tests use `node:test` + `node:assert/strict`, run by `tsx --test`, and sit next to the source as `*.test.ts`.
- `src/lib/http.test.ts` has `allowedOrigin` tests and a `withExtensionId` helper that sets an env var and restores it in `finally`.
- `src/lib/local.test.ts` sets `NODE_ENV=production` in `before()`, restores it in `after()`, and calls route handlers directly (`await putFile(new Request(url, {...}), { params: ... })`).
- Each test file runs in its own process.

**Style**: 2-space indent, single quotes, no semicolons, short "why" comments above functions. Match `http.ts`.

## Commands you will need

Run from `C:\extention\backend`:

| Purpose | Command | Expected on success |
|---|---|---|
| Everything | `pnpm verify` | exit 0 (typecheck, lint, tests; 42 tests pass before this plan) |
| Tests only | `pnpm test` | `ℹ fail 0` |

## Scope

**In scope** (the only files you should modify):
- `backend/src/lib/http.ts`: `allowedOrigin()` and its comment only
- `backend/src/lib/http.test.ts`
- `backend/src/lib/local.test.ts`
- `backend/src/app/api/analyze/route.ts`: the `catch` block only
- `backend/.env.example`
- `backend/README.md`

**Out of scope** (do NOT touch):
- `authorized()`. Do not make `JEV_API_TOKEN` required, and don't add it to `.env.example`; the project doesn't use it.
- `backend/src/lib/local.ts` and `backend/src/lib/analyze.ts`.
- The captures routes.
- Anything under `frontend/`.
- Rate limiting and body-size limits: a separate plan (010) covers input limits. Don't add a limiter or a `proxy.ts`/`middleware.ts`.

## Git workflow

- Branch: `advisor/007-analyze-fail-closed`
- Commit messages are short imperative sentences with no prefix. Examples from `git log`: "Keep run log and capture files local-only; neutral no-zip message". Example for this plan: "Only answer the extension on a deployed backend; hide provider errors".
- Do NOT push or open a PR.

## Steps

### Step 1: Require an Origin header in production

In `src/lib/http.ts`, import `storesLocally` from `'./local'` and change `allowedOrigin()`:

```ts
// Browsers attach Origin to cross-site requests, so a web page can't pass for the extension.
// Locally, requests without Origin (curl, scripts) are allowed for debugging. A deployed backend
// refuses them: the extension always sends its chrome-extension:// origin.
export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return storesLocally()
  return extensionOrigin(origin)
}
```

Leave `extensionOrigin`, `corsHeaders`, `authorized` and `sentJson` unchanged.

**Verify**: `pnpm typecheck` → exit 0. `pnpm test` → `ℹ fail 0`. The existing `allowedOrigin` tests run in dev mode, so "accepts no origin" still holds.

### Step 2: Unit-test it in production

In `src/lib/http.test.ts`, add a helper like `withExtensionId` that sets `NODE_ENV` and restores it. Cast `process.env` as `local.test.ts` does (`const env = process.env as Record<string, string | undefined>`), because `NODE_ENV` is typed read-only. Add:
1. `allowedOrigin refuses requests without an origin on a deployed backend`: NODE_ENV `production`, no `JEV_EXTENSION_ID` → `allowedOrigin(req())` is `false`, and `allowedOrigin(req({ origin: 'chrome-extension://abc' }))` is `true`.
2. `allowedOrigin pins the extension on a deployed backend`: NODE_ENV `production`, `JEV_EXTENSION_ID=abc` → `true` for `chrome-extension://abc`, `false` for `chrome-extension://xyz` and for no origin.

**Verify**: `pnpm test` → `ℹ fail 0`, 44 tests.

### Step 3: Return a generic error from `/api/analyze` in production

In `src/app/api/analyze/route.ts`, import `storesLocally` from `@/lib/local` and change the `catch` block to:

```ts
  } catch (err) {
    console.error('[analyze] jev evaluation failed', err)
    // Provider errors can name accounts, quotas and this server's env vars: only local development sees them.
    const detail = storesLocally() ? `: ${err instanceof Error ? err.message : String(err)}` : ''
    return Response.json({ error: `Analysis failed${detail}` }, { status: 502, headers })
  }
```

Keep `console.error`, so the operator still sees the full error in the server log.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Route tests in production mode

`src/lib/local.test.ts` already runs in production mode with `JEV_API_TOKEN` and `JEV_EXTENSION_ID` deleted. In it:
- Import `POST as analyze` from `@/app/api/analyze/route`.
- Add `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` to the `saved` object and delete them in `before()`. The existing `after()` loop restores them, and this guarantees no test can reach a paid API.

Add:
1. `production analyze refuses requests without an origin`: POST to `http://localhost/api/analyze` with only `{ 'content-type': 'application/json' }` and body `JSON.stringify({ capture: {} })` → status `403`.
2. `production analyze hides provider errors`: POST with headers `{ origin: EXT, 'content-type': 'application/json' }` and this valid capture as the body:
   ```ts
   const capture = {
     url: 'https://example.com', title: 'Example', selector: 'section',
     viewport: { w: 1280, h: 800, dpr: 1 },
     root: { tag: 'section', attrs: {}, box: { x: 0, y: 0, w: 1280, h: 600 }, styles: {}, children: [] },
     assets: [], responsive: [], keyframes: [],
   }
   ```
   No provider key is set, so `analyzeCapture` throws its "Set TYPESAFE_API_KEY…" error. Assert:
   - the status is `502`;
   - `(await res.json()).error === 'Analysis failed'`;
   - the raw response text contains neither `TYPESAFE` nor `.env`.

**Verify**: `pnpm test` → `ℹ fail 0`, 46 tests. The second test prints the expected `[analyze] jev evaluation failed` line to the console. That is fine.

### Step 5: Document the deployed setup

In `backend/.env.example`, append below the existing entries, in the same comment-then-variable style with an empty value:

```
# Recommended on a deployed backend: only accept calls from this extension
# (chrome://extensions → JevElements → ID).
JEV_EXTENSION_ID=
```

In `backend/README.md`:
- Replace "API writes are accepted only from a `chrome-extension://` origin (or from clients that send no origin, such as curl)" with wording that says:
  - Locally, clients that send no origin (such as curl) are also accepted.
  - A deployed backend accepts only `chrome-extension://` origins.
- Leave the existing sentence about `JEV_API_TOKEN` alone (it stays an optional feature).
- Add a short `## Deploying` section before `## Routes` covering:
  - **What production changes.** With `NODE_ENV=production` (e.g. `next start` or Vercel) the backend stores nothing: the capture routes answer 404 and the run log is off. The extension then links images and video from the live site instead of downloading a zip.
  - **Env vars.** Set `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` (the fallback when TypeSafe fails or runs out of credits), and set `JEV_EXTENSION_ID` to your extension's ID.
  - **What the origin check does not stop.** It stops browsers and casual scripts, but any HTTP client can fake an `Origin` header. To bound cost, set a spend limit in the TypeSafe and Vercel AI Gateway dashboards and a rate limit on the host (e.g. a Vercel Firewall rate-limit rule for `/api/analyze`).
  - **Errors.** Error responses say only "Analysis failed"; details are in the server log.

**Verify**: `git diff --stat` shows only the six in-scope files. `pnpm verify` → exit 0.

## Test plan

- `src/lib/http.test.ts`: 2 new tests (Step 2) for production without an origin, and for pinning the extension ID.
- `src/lib/local.test.ts`: 2 new route tests (Step 4) for the production 403 without an origin, and for the generic 502 body.
- Pattern: `src/lib/http.test.ts` (env helper with restore) and `src/lib/local.test.ts` (route handlers in production mode).
- `pnpm test` → all pass, 46 tests (42 before).

## Done criteria

- [ ] `pnpm verify` exits 0 in `backend/`
- [ ] `pnpm test` reports 46 tests, `fail 0`
- [ ] `grep -n "return origin === null ||" backend/src/lib/http.ts` returns no match
- [ ] `grep -n "JEV_API_TOKEN" backend/.env.example` returns no match
- [ ] `grep -n "JEV_EXTENSION_ID" backend/.env.example` returns a match
- [ ] `authorized()` is unchanged: `git diff backend/src/lib/http.ts` shows no `-` line inside `authorized`
- [ ] `git status` shows changes only in the six in-scope files (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back (do not improvise) if:
- `allowedOrigin()` or the analyze route's `catch` block doesn't match the excerpts above.
- An existing test fails after Step 1. Some test may rely on no-origin requests in production mode; report which one rather than changing it.
- The production test in Step 4 returns something other than 502 because `analyzeCapture` threw for another reason (e.g. a `TypeError` from the capture shape). Report the error text. Don't loosen the capture or the assertion.
- You find any code or doc that depends on `JEV_API_TOKEN` being set. Report it; the project doesn't use the token.

## Maintenance notes

- `allowedOrigin()` is the gate for every API route. Any new route must call it the same way the existing ones do.
- If the backend is ever called from something other than the extension in production (a web app, a CLI), it must send an `Origin` the backend accepts, or this check needs a new rule.
- Abuse protection without a secret is best-effort. If the deployed backend becomes public or shared, the next step is a per-user credential or a platform-level rate/spend limit. Provider spend limits are the backstop either way.
- Reviewer: confirm dev-mode behaviour is unchanged (`storesLocally()` true → no-origin requests allowed, `Analysis failed: <message>`), and that nothing logs or returns API key values.
