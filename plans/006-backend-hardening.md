# Plan 006: Accept requests only from the extension, bind dev to loopback, harden served files

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from `C:\extention`:
> `git diff --stat 0e4e1a3..HEAD -- backend/src/lib/http.ts backend/src/app/api backend/package.json backend/.env.example backend/README.md`
> Plan 001 changes `backend/package.json` scripts (adds `typecheck`, `test`, `verify`). That is expected. Any other change: compare the excerpts below with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md (test harness and `pnpm verify` in `backend/`)
- **Category**: security
- **Planned at**: commit `0e4e1a3`, 2026-10-07

## Why this matters

The JevElements backend is a Next.js app the Chrome extension talks to while it captures a page (default `http://localhost:3000`). Five issues:
- **No auth by default.** When `JEV_API_TOKEN` is unset (the default; `.env.example` doesn't even list it), every route accepts any caller.
- **Cross-site requests reach the paid classifier.** `POST /api/analyze` parses the body as JSON whatever the `Content-Type`. Any website the user visits can therefore send a "simple" `text/plain` cross-site POST to it, with no CORS preflight. A valid-looking capture then triggers a paid TypeSafe / AI Gateway call on the developer's key. This was confirmed during planning: a `text/plain` request with `Origin: https://evil.example` is parsed and processed (it returned 400 only because the probe payload was empty).
- **The dev server is reachable from the network.** `next dev` binds `0.0.0.0` by default (per `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`), so other machines on the LAN can reach every route.
- **Saved files are served raw.** The file GET route serves site-supplied SVG and JS from the backend's origin without `nosniff` or a CSP.
- **`next@16.3.6` has published advisories** that are fixed in 16.3.8.

Next's `allowedDevOrigins` protection covers only dev-only assets and endpoints, not app route handlers, so it does not cover any of this.

## Current state

All paths under `backend/`.

**`src/lib/http.ts`** (the whole file):
```ts
// The extension calls the backend from its service worker (origin chrome-extension://<id>).
export function corsHeaders(request: Request, methods = 'POST, OPTIONS'): HeadersInit {
  const origin = request.headers.get('origin') ?? ''
  if (!origin.startsWith('chrome-extension://')) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  }
}

// Optional shared secret so a deployed backend can't be used by anyone who finds the URL.
export function authorized(request: Request): boolean {
  const token = process.env.JEV_API_TOKEN
  return !token || request.headers.get('authorization') === `Bearer ${token}`
}
```

**`src/app/api/analyze/route.ts`** (`POST`, lines 9–35):
```ts
export async function POST(request: Request) {
  const headers = corsHeaders(request)
  if (!authorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400, headers })
  }
  // …isCapture check → 400; analyzeCapture(capture, { abortSignal: request.signal }) → paid API call
}
```

**`src/app/api/captures/[id]/project/route.ts`** `PUT`: same shape. It checks `authorized`, then `isCaptureId(id)`, then `await request.json()`, then `isProjectMeta`, then `saveProject`.

**`src/app/api/captures/[id]/files/[folder]/[name]/route.ts`**:
- `PUT` (lines 35–53): checks `authorized`, `filePath(...)`, `content-length`, then reads `request.arrayBuffer()` and saves. The extension sends a raw body with no JSON content type, so do **not** add a content-type check here.
- `GET` (lines 56–65), unauthenticated, used only for manual previews. The extension never calls it (confirmed: the extension's only backend calls are `POST /api/analyze`, the three `PUT`s, and the zip link):
  ```ts
  export async function GET(_request: Request, { params }: Context) {
    const { id, folder, name } = await params
    const file = filePath(id, [folder, name])
    const body = file && (await readCaptureFile(file))
    if (!body) return new Response('Not found', { status: 404 })
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    return new Response(new Uint8Array(body), {
      headers: { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Content-Length': String(body.length) },
    })
  }
  ```

**What the extension sends** (`frontend/jevelements/src/background/index.ts`, for reference only; do not edit it):
- All requests come from the extension's service worker, so they carry `Origin: chrome-extension://<extension id>`.
- `POST /api/analyze` and `PUT …/project` send `'Content-Type': 'application/json'`.
- File `PUT`s send a raw `Blob`/`Uint8Array` body.
- All send `Authorization: Bearer <token>` when the user configured one.
- The extension id differs per install. An unpacked extension gets an id derived from its folder path. That's why exact-id pinning must be opt-in (an env var), not hard-coded.

**`package.json`** scripts after plan 001: `"dev": "next dev"`, `"build": "next build"`, `"start": "next start"`, `"lint": "eslint"`, `"typecheck": "tsc --noEmit"`, `"test": "tsx --test \"src/**/*.test.ts\""`, `"verify": …`. Dependencies: `"next": "16.3.6"`; devDependencies: `"eslint-config-next": "16.3.6"`.

**`.env.example`** (whole file):
```
# Jev API token from the TypeSafe dashboard. Primary classifier.
# https://docs.typesafe.ai/introduction/quickstart
TYPESAFE_API_KEY=

# Optional: Vercel AI Gateway key, used when the TypeSafe request fails.
AI_GATEWAY_API_KEY=
```
`.env` exists locally and is gitignored. **Never read, print or edit `.env`.**

**Test conventions** (from plan 001): `node:test` + `node:assert/strict`. Backend tests live in `src/lib/*.test.ts` and run as **CommonJS**, so don't use top-level `await`; put awaits inside `async` test callbacks. Route handlers can be imported and called directly in tests. The `@/…` path alias resolves under tsx. For example:
```ts
import { POST } from '@/app/api/analyze/route'
test('…', async () => {
  const res = await POST(new Request('http://localhost/api/analyze', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}' }))
  assert.equal(res.status, 403)
})
```
Node's `Request` lets tests set the `origin` header.

**Next.js caveat**: `backend/AGENTS.md` warns that this Next version differs from older ones. Before changing anything Next-specific (the CLI flag in step 4), read `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`. Its table documents `-H` / `--hostname` with default `0.0.0.0`.

**Conventions**: no semicolons, single quotes, 2-space indent. Error bodies are `Response.json({ error: '<Sentence>' }, { status, headers })` with the CORS `headers` passed through. Comments are one plain sentence about *why*.

## Commands you will need

Run in `backend/`:

| Purpose | Command | Expected |
|---|---|---|
| Bump Next | `pnpm add next@16.3.8 && pnpm add -D eslint-config-next@16.3.8` | exit 0 |
| Audit | `pnpm audit --prod` | no `next` advisories with `<16.3.8` vulnerable range |
| Tests | `pnpm test` | `ℹ fail 0` |
| All gates | `pnpm verify` | exit 0 |
| Build | `pnpm build` | exit 0 (`.next/` is gitignored) |

## Scope

**In scope**:
- `backend/src/lib/http.ts`
- `backend/src/lib/http.test.ts` (create)
- `backend/src/lib/routes.test.ts` (create)
- `backend/src/app/api/analyze/route.ts`
- `backend/src/app/api/captures/[id]/project/route.ts`
- `backend/src/app/api/captures/[id]/files/[folder]/[name]/route.ts`
- `backend/package.json` (the `dev` script and the next / eslint-config-next versions), `backend/pnpm-lock.yaml`
- `backend/.env.example`, `backend/README.md`

**Out of scope**:
- `backend/.env`: never read or modify it.
- `frontend/jevelements/**`: no extension changes. The extension already sends `Origin`, `Content-Type` and an optional token. A settings UI for the token is a separate direction item.
- Making `JEV_API_TOKEN` mandatory or generating one automatically. That would break the zero-config local setup the README promises.
- `next start` / production hostname: deployments legitimately listen on all interfaces.
- `src/app/api/captures/[id]/zip/route.ts`: GET only, downloaded by the browser as a plain link with an unguessable UUID; leave it.
- Request-body size caps on `/api/analyze`: once cross-site and LAN callers are refused, they're no longer needed. Not in this plan.

## Git workflow

- Branch: `advisor/006-backend-hardening`
- Commit per step. Message style: plain imperative sentence, e.g. `Refuse API requests from origins other than the extension`.
- Do not push or open a PR unless told to.

## Steps

### Step 1: Origin and content-type helpers in `http.ts`

Add these to `src/lib/http.ts`, and rewrite `corsHeaders` to use `extensionOrigin`:
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

// A JSON body must say so: a text/plain POST is the one kind a web page can send cross-site without a preflight.
export function sentJson(request: Request): boolean {
  return /^application\/json\b/i.test(request.headers.get('content-type') ?? '')
}
```
`corsHeaders` returns `{}` unless `extensionOrigin(origin)`. The rest of `corsHeaders` stays unchanged.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Enforce them in the three write routes

In each of `analyze/route.ts` `POST`, `project/route.ts` `PUT` and `files/…/route.ts` `PUT`, right after `const headers = corsHeaders(…)` and **before** the `authorized` check, add:
```ts
if (!allowedOrigin(request)) return Response.json({ error: 'Forbidden origin' }, { status: 403, headers })
```
In `analyze` `POST` and `project` `PUT` only, right after the `authorized` check, add:
```ts
if (!sentJson(request)) return Response.json({ error: 'Content-Type must be application/json' }, { status: 415, headers })
```
Do not add `sentJson` to the file `PUT`.

**Verify**: `pnpm typecheck` → exit 0. `grep -rn "allowedOrigin(request)" src/app/api | wc -l` → `3`. `grep -rn "sentJson(request)" src/app/api | wc -l` → `2`.

### Step 3: Harden the file GET response

In `files/…/route.ts` `GET`, add two headers to the response:
```ts
'X-Content-Type-Options': 'nosniff',
// Files come from arbitrary sites; an SVG opened here must not run script on the backend's origin.
'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; media-src 'self'; sandbox",
```
Keep `Content-Type` and `Content-Length` as they are.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Bind the dev server to loopback

Read `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md` and confirm `next dev` documents `-H`/`--hostname`. Then change the script to `"dev": "next dev -H 127.0.0.1"`. Leave `start` unchanged.

**Verify**: start `pnpm dev` in the background. Then:
- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/captures/00000000-0000-4000-8000-000000000000/zip` → `404` (server reachable on loopback, no such capture)
- `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/captures/00000000-0000-4000-8000-000000000000/zip` → `404`

Stop the dev server afterwards. If the `localhost` request fails while `127.0.0.1` works, that's a STOP condition: the extension's default URL is `http://localhost:3000`.

### Step 5: Bump Next to the patched release

`pnpm add next@16.3.8 && pnpm add -D eslint-config-next@16.3.8`

**Verify**:
- `pnpm audit --prod` → no advisory whose module is `next`.
- `pnpm verify` → exit 0.
- `pnpm build` → exit 0.

`sharp` / `source-map-js` advisories may remain; they come in transitively through next's image optimization, which this app doesn't use. Note them in your report; don't chase them.

### Step 6: Tests

Create `src/lib/http.test.ts` and `src/lib/routes.test.ts` with the cases in **Test plan**. In tests that set `process.env.JEV_EXTENSION_ID` or `JEV_API_TOKEN`, save the previous value and restore it in a `finally` (or `afterEach`), so test order doesn't matter.

**Verify**: `pnpm test` → `ℹ fail 0`, with the new tests counted.

### Step 7: Document

1. Append to `.env.example`:
   ```
   # Optional: shared secret. When set, the extension must send it (its backendToken setting).
   # Set it whenever the backend is reachable from anywhere but this machine.
   JEV_API_TOKEN=

   # Optional: pin requests to one extension install (the id shown at chrome://extensions).
   JEV_EXTENSION_ID=
   ```
2. In `backend/README.md`, after the paragraph mentioning `JEV_API_TOKEN`, add 2–3 sentences:
   - `pnpm dev` listens on 127.0.0.1 only;
   - API writes are accepted only from a `chrome-extension://` origin (or from no-origin clients such as curl), and only one extension when `JEV_EXTENSION_ID` is set;
   - JSON routes require `Content-Type: application/json`.

**Verify**: `git diff --stat` lists only in-scope files.

## Test plan

**`src/lib/http.test.ts`**, using `new Request('http://localhost/x', { headers: {...} })`:
- `allowedOrigin`:
  - true with no `origin` header
  - true for `chrome-extension://abc`
  - false for `https://evil.example`
  - false for `null` as a string (`origin: 'null'`, which is what sandboxed iframes send)
- With `JEV_EXTENSION_ID=abc`: true for `chrome-extension://abc`, false for `chrome-extension://xyz`.
- `sentJson`:
  - true for `application/json` and for `application/json; charset=utf-8`
  - false for `text/plain`, for missing, and for `application/jsonp`
- `corsHeaders`: returns `{}` for `https://evil.example`, and returns an object with `Access-Control-Allow-Origin: chrome-extension://abc` for that origin.

**`src/lib/routes.test.ts`**, calling the handlers directly (`import { POST } from '@/app/api/analyze/route'` etc.). Route context for dynamic routes is `{ params: Promise.resolve({ id, folder, name }) }`:
- analyze `POST` with `origin: https://evil.example`, `content-type: text/plain`, body `'{}'` → 403.
- analyze `POST` with `origin: chrome-extension://abc`, `content-type: text/plain`, body `'{}'` → 415.
- analyze `POST` with `origin: chrome-extension://abc`, `content-type: application/json`, body `'{}'` → 400 (`Expected { capture }…`). This proves the order of checks without calling the paid API.
- project `PUT` with an evil origin → 403; with an extension origin and `text/plain` → 415.
- files `PUT` with an evil origin → 403. With an extension origin, a fresh `crypto.randomUUID()` id, folder `media`, name `t.png` and body `new Uint8Array([1,2,3])` → 200. Clean up `captureDir(id)` from `@/lib/store` afterwards.
- files `GET` for that saved file → 200, with `x-content-type-options: nosniff` and a `content-security-policy` containing `sandbox`.

Keep `JEV_API_TOKEN` unset in these tests: save it, `delete process.env.JEV_API_TOKEN`, and restore it after.

## Done criteria

- [ ] `cd backend && pnpm verify` exits 0
- [ ] `pnpm build` exits 0
- [ ] `node -e "console.log(require('next/package.json').version)"` → `16.3.8`
- [ ] `grep -n '"dev": "next dev -H 127.0.0.1"' package.json` → 1 match
- [ ] `grep -c "JEV_API_TOKEN\|JEV_EXTENSION_ID" .env.example` → `2`
- [ ] `src/lib/http.test.ts` and `src/lib/routes.test.ts` exist and pass
- [ ] `git diff --name-only` contains no `frontend/` path and no `.env`
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

- Any step seems to require reading or changing `backend/.env`.
- `http://localhost:3000` is unreachable after binding to `127.0.0.1` (step 4). The extension's default backend URL would break. Report it; don't switch to `::1` or `0.0.0.0` on your own judgment.
- `pnpm add next@16.3.8` resolves to a different version, or forces a React or other major upgrade.
- `pnpm build` fails after the bump with an error that isn't about your changes.
- A route test shows the analyze handler reaching `analyzeCapture` (for example a network error or a missing-API-key error) for a request that should have been refused. Report it. Never let a test call the real classifier.

## Maintenance notes

- Any new state-changing route must call `allowedOrigin` (and `sentJson` if it reads JSON) before doing work. Reviewers should check new route files for it.
- The no-Origin pass-through exists for curl and scripts. If the backend is ever deployed publicly, `JEV_API_TOKEN` is the real gate. The README now says so; a future settings page in the extension (the `backendToken` setting exists but has no UI) would make that practical.
- Chrome's Local Network Access checks already ask the user before a public site can reach localhost. This plan makes that defence unnecessary for these routes rather than relying on it.
- Deferred: limiting `PUT` writes per capture id (disk-filling by an authorized client). Low value for a local tool.
