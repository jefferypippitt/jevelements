# JevElements backend

Next.js app the JevElements extension talks to while it captures a section.

```bash
pnpm install
pnpm dev   # http://localhost:3000, the extension's default backend URL
```

Copy `.env.example` to `.env` and set `TYPESAFE_API_KEY` to turn on classification (`AI_GATEWAY_API_KEY` is the fallback). `JEV_API_TOKEN`, when set, is required as a Bearer token on uploads and analysis. `pnpm test` runs the classifier checks.

`pnpm dev` listens on 127.0.0.1 only. API writes are accepted only from a `chrome-extension://` origin (or from clients that send no origin, such as curl), and only from one extension when `JEV_EXTENSION_ID` is set. JSON routes require `Content-Type: application/json`.

## Routes

- `POST /api/analyze`: classifies a capture with Jev (section type, layout, theme, scope, repeated items, behaviours) for the prompt.
- `PUT /api/captures/:id/files/:folder/:name`: the extension uploads each file it downloaded from the page (`media`), the screenshot (`frames`), and the scripts holding canvas code (`code`). `?offset=N` appends a chunk.
- `GET /api/captures/:id/files/:folder/:name`: one saved file.
- `PUT /api/captures/:id/project`: `{ name, component, file, prompt }` once the capture is classified, so the zip is named after the section (`hero-section`) and includes the prompt.
- `GET /api/captures/:id/zip`: the capture as `<name>.zip`, a ready Next.js app (App Router, TypeScript, Tailwind CSS v4) in one `<name>/` folder: the scaffold, `PROMPT.md`, and the saved files in `public/capture/`, `public/reference/` and `public/reference/code/`. The extension downloads it when a capture finishes. Extract it, open the folder, run `npm install`.

Saved files live in the OS temp directory (`jevelements-captures/`) and are deleted after 7 days. The zip is built in memory per request; nothing is written into this project.
