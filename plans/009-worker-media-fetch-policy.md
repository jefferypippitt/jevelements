# Plan 009: The service worker downloads page media without the user's cookies, and never from a private network the page isn't on

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**, from the repo root `C:\extention`:
> `git diff --stat 1cceb96..HEAD -- frontend/jevelements/src/background/index.ts frontend/jevelements/src/shared/files.ts`
> If either changed, compare the "Current state" excerpts with the live code. A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED. A few assets that only load with cookies from *another* origin may now fail in the worker. They still fall back to the existing in-page fetch, and if that fails too they are listed as missing in the prompt's caveats.
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `1cceb96`, 2026-10-09

## Why this matters

JevElements is a Chrome MV3 extension (`frontend/jevelements/`). It has `host_permissions: ["<all_urls>"]`, and its service worker (`src/background/index.ts`) downloads the images, video, fonts and 3D/Lottie files of the section the user captures.

Those URLs come from the page, and the page is untrusted. Some URLs are read from the DOM. Others come from a script that runs in the page's own JavaScript world (`src/probe/`), whose replies the page can forge.

The worker fetches every URL with `credentials: 'include'`. Because of the extension's host permission, CORS doesn't apply, so a hostile page can make the user's browser send **cookie-bearing GET requests to any site**, including intranet and `localhost` addresses. Matching responses are written into the capture's files (in local mode, into the app zip the user hands to an AI agent).

After this plan:
- The worker never sends cookies. Cross-origin public files don't need them, and same-origin cookie-bound files are still fetched by the existing in-page fallback, which runs with the page's own rights.
- The worker refuses private-network and loopback addresses unless the captured page is itself on one (developers capturing their own `localhost` app must keep working).
- A redirect into a private network is discarded.

## Current state

All paths below are under `frontend/jevelements/`.

**`src/background/index.ts`**, message handler (lines 78–92). Note that `sender` is available but not passed to `saveMedia`:
```ts
chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse: (res: Reply) => void) => {
  const reply = (work: Promise<Reply>) => { ... }
  switch (message.type) {
    case 'jev:screenshot':
      return reply(captureCropped(sender.tab, message).then((dataUrl) => ({ dataUrl })))
    case 'jev:analyze':
      return reply(analyze(message))
    case 'jev:save-media':
      return reply(saveMedia(message))
```

**`src/background/index.ts:140-166`**, the download path:
```ts
// ---------- media ----------

async function download(src: string): Promise<{ blob: Blob; ext: string }> {
  // The service worker has host access to every site, so cross-origin media loads without CORS.
  const res = await fetch(src, { credentials: 'include', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (/text\/html/i.test(type)) throw new Error('got an HTML page instead of a file (hotlink protection or login)')
  const blob = await res.blob()
  ...
}

// Downloads one file and hands it straight to the backend: the page never holds the bytes.
async function saveMedia({ src, captureId, name, upload, folder = 'media' }: SaveMediaMessage): Promise<SaveMediaResponse> {
  let file: { blob: Blob; ext: string }
  try {
    file = await download(src)
  } catch (err) {
    return { error: `download failed: ${errorText(err)}` }
  }
  ...
}
```

**The fallback that keeps same-origin cookie-bound files working**: `src/content/media.ts:43-54` (`fetchInPage`). It runs in the content script and does `fetch(src, { credentials: 'include', ... })` under the page's own CORS rules. `fetchOne` (`media.ts:168-180`) calls it whenever the worker returns `{ error }`. Do not change `media.ts`; the fallback is what makes this plan safe.

**Who can send messages to the worker**: only this extension's own content scripts. The manifest (`public/manifest.json`) has no `externally_connectable` and no `web_accessible_resources`. The URLs are page-controlled data, but the message itself is not forged.

**`chrome.runtime.MessageSender`** has `url` (the sending frame's URL) and `tab?.url`. Use `sender.url ?? sender.tab?.url` as "the page being captured".

**Conventions**:
- `src/shared/` holds pure helpers shared by the worker and content scripts. `src/shared/files.ts` is the exemplar: plain exported functions with a one-line "why" comment, no `chrome.*` calls, unit-tested from `test/unit/files.test.ts`.
- Tests use `node:test` + `node:assert/strict` and import from `../../src/shared/<module>` (see `test/unit/files.test.ts`). `tsconfig.test.json` includes `test/unit`.
- Code style: 2-space indent, single quotes, no semicolons.

## Commands you will need

Run from `C:\extention\frontend\jevelements`:

| Purpose | Command | Expected on success |
|---|---|---|
| Everything | `pnpm verify` | exit 0 (typecheck, lint, unit tests; 42 before this plan) |
| One test file | `pnpm exec tsx --test test/unit/fetch-policy.test.ts` | `ℹ fail 0` |
| Build (optional manual check) | `pnpm build` | exit 0, writes `dist/` |

## Scope

**In scope** (the only files you should modify):
- `frontend/jevelements/src/shared/fetch-policy.ts` (create)
- `frontend/jevelements/test/unit/fetch-policy.test.ts` (create)
- `frontend/jevelements/src/background/index.ts`: only `download`, `saveMedia`, and the `'jev:save-media'` case of the message switch

**Out of scope** (do NOT touch):
- `src/content/media.ts`, including `fetchInPage`. It runs with the page's own rights, which is acceptable.
- `src/shared/files.ts` / `extensionFor`.
- `put`, `uploadChunk`, `analyze`, `saveProject` in the worker. Other plans change upload behaviour and settings.
- The `'jev:capturing'` and `'jev:inject-probe'` handlers.
- `public/manifest.json` (no permission changes).
- The probe (`src/probe/`). Its forgeability is a given; this plan makes the worker safe regardless.

## Git workflow

- Branch: `advisor/009-worker-media-fetch-policy`
- Commit message style: short imperative sentence, no prefix (e.g. "Only screenshot the tab that is being captured"). Example: "Download page media without cookies and refuse private-network URLs".
- Do NOT push or open a PR.

## Steps

### Step 1: Create the pure policy module

Create `src/shared/fetch-policy.ts` with two exports:

```ts
// Which page-supplied URLs the service worker may download. The worker has host access to every
// site, so the page must not be able to point it at an intranet or loopback address.

// Loopback, private, link-local and CGNAT addresses, and the names that resolve to them.
// `hostname` is URL.hostname: lowercase, IPv4 normalized to dotted form, IPv6 in [brackets].
export function isPrivateHost(hostname: string): boolean

// Why `src` must not be downloaded for a capture of `pageUrl`, or null when it may be.
export function blockedMediaUrl(src: string, pageUrl: string | undefined): string | null
```

`isPrivateHost` rules (return `true` for any of these):
- `localhost`, or a name ending in `.localhost`
- an IPv4 literal (four dot-separated decimal numbers) in `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (second octet 64–127), `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12` (second octet 16–31), `192.168.0.0/16`
- an IPv6 literal (strip the surrounding `[` `]` first) that is `::` or `::1`, starts with `fc` or `fd` (unique local), starts with `fe8`, `fe9`, `fea` or `feb` (link-local), or starts with `::ffff:` (IPv4-mapped; treat all as private, it's never a normal asset host)

Everything else is `false`, including ordinary names like `example.com`. Do not do DNS lookups.

`blockedMediaUrl(src, pageUrl)` rules, in order:
1. If `new URL(src)` throws, return `'not a valid URL'`.
2. If the protocol is `data:`, return `null`. Inline data makes no network request, and the content script does send `data:` sources to the worker (`media.ts:170` sends everything except `blob:`), so blocking them would push them onto the in-page fetch, which page CSP can block.
3. If the protocol isn't `http:` or `https:`, return `'only http(s) and data: files are downloaded'`.
4. If `isPrivateHost(url.hostname)` is true and the page is *not* itself on a private host, return `'a private-network address'`. The page counts as private only when `pageUrl` parses and its hostname passes `isPrivateHost`; a missing or unparseable `pageUrl` counts as not private.
5. Otherwise return `null`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Unit-test the module

Create `test/unit/fetch-policy.test.ts` in the style of `test/unit/files.test.ts`. Cases:
- `isPrivateHost` is true for: `localhost`, `app.localhost`, `127.0.0.1`, `10.1.2.3`, `172.16.0.1`, `172.31.255.255`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`, `[::1]`, `[fd00::1]`, `[fe80::1]`.
- `isPrivateHost` is false for: `example.com`, `cdn.example.com`, `172.15.0.1`, `172.32.0.1`, `8.8.8.8`, `100.128.0.1`, `[2606:4700::1]`, `localhost.example.com`.
- `blockedMediaUrl` returns `null` for `https://cdn.example.com/a.png` from page `https://example.com/`.
- Non-null for `http://127.0.0.1:8080/a.png` from `https://example.com/`, for `http://192.168.1.1/x.png` from `https://example.com/`, and for `http://localhost/a.png` with page `undefined`.
- `null` for `http://localhost:3000/a.png` from page `http://localhost:3000/`, so capturing your own dev app still works.
- Non-null for `file:///etc/hosts`, `ftp://example.com/a.png`, and `not a url`.
- `null` for `data:image/png;base64,AAAA` from `https://example.com/`.
- The URL parser normalizes alternative IPv4 spellings. Assert that `blockedMediaUrl('http://2130706433/a.png', 'https://example.com/')` is non-null, because it parses to `127.0.0.1`.

**Verify**: `pnpm exec tsx --test test/unit/fetch-policy.test.ts` → `ℹ fail 0`.

### Step 3: Apply the policy in the worker

In `src/background/index.ts`:
1. Import `blockedMediaUrl` from `'../shared/fetch-policy'`.
2. In the switch, change the case to `return reply(saveMedia(message, sender.url ?? sender.tab?.url))`.
3. Change `saveMedia` to take `pageUrl: string | undefined` as a second parameter. Before calling `download`:
   ```ts
   const blocked = blockedMediaUrl(src, pageUrl)
   if (blocked) return { error: `download refused: ${blocked}` }
   ```
   Then call `download(src, pageUrl)`.
4. Change `download(src)` to `download(src, pageUrl)`:
   - Use `credentials: 'omit'` instead of `'include'`.
   - Update the comment to say why: `// No cookies: the URL comes from the page, and the worker's host access would otherwise let it send the user's cookies anywhere. Same-origin files that need them are fetched by the page itself (content/media.ts fetchInPage).`
   - Right after `if (!res.ok) ...`, add a redirect check: `if (res.redirected && blockedMediaUrl(res.url, pageUrl)) throw new Error('redirected to a private-network address')`.

Leave the rest of `download` (HTML check, size check, `extensionFor`) unchanged.

**Verify**:
- `pnpm verify` → exit 0, `fail 0`.
- `grep -n "credentials: 'include'" src/background/index.ts` → no match.
- `grep -n "credentials: 'include'" src/content/media.ts` → still one match (the in-page fallback, intentionally unchanged).

### Step 4 (optional, only if a Chrome is available): manual check

Run `pnpm build`, load `dist/` at `chrome://extensions` → Load unpacked, then capture a section with images on any public site (e.g. a product landing page) with the local backend running (`pnpm dev` in `backend/`). The capture's images should still be saved. If no browser is available, say so in your report; don't skip silently.

## Test plan

- New file `test/unit/fetch-policy.test.ts` (Step 2): private-host table, page-on-localhost exemption, scheme rejection, normalized IPv4 spelling.
- No worker unit test. `background/index.ts` uses `chrome.*` APIs and has no harness; all decision logic lives in the tested pure module.
- `pnpm verify` → all pass, with the new tests added to the 42 existing ones.

## Done criteria

- [ ] `pnpm verify` exits 0 in `frontend/jevelements/`
- [ ] `test/unit/fetch-policy.test.ts` exists and passes
- [ ] `grep -c "credentials: 'include'" src/background/index.ts` prints `0`
- [ ] `grep -n "blockedMediaUrl" src/background/index.ts` shows at least two uses (pre-check and redirect check)
- [ ] `git status` shows changes only in the three in-scope files (plus `plans/README.md`)
- [ ] `plans/README.md` status row for 009 updated, noting whether the manual Chrome check ran

## STOP conditions

Stop and report back (do not improvise) if:
- `download`/`saveMedia` or the `'jev:save-media'` case don't match the excerpts.
- Another place in `src/background/` fetches page-supplied URLs (`grep -n "fetch(" src/background/index.ts` shows a fetch of something other than `src`, `backendUrl`-based URLs, or the analyze/project/upload endpoints). Report it; don't extend scope.
- `sender.url` is not available on the `MessageSender` type in the installed `@types/chrome`. Use `sender.tab?.url` alone only if the type lacks `url`, and say so in the report.
- The manual check (Step 4) shows images from ordinary public CDNs failing that worked before.

## Maintenance notes

- Not covered: a *public* hostname whose DNS resolves to a private address (DNS rebinding). Covering it would need the worker to resolve names, which extensions can't do. With cookies off, the remaining exposure is unauthenticated intranet content.
- If a site's assets genuinely need cookies on a different origin (signed-cookie CDNs), they now fall back to `fetchInPage`, which works only when that CDN sends CORS headers. If users report missing files on such sites, the fix is to allow credentials only for the page's own site, not to restore `'include'` for everything.
- Any new worker code that fetches a page-supplied URL must go through `blockedMediaUrl` and use `credentials: 'omit'`.
- Reviewer: confirm the redirect check runs before the body is read, and that the error strings don't include the token or backend URL.
