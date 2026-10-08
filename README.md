# JevElements

Chrome extension that turns any section of a website into a ready-to-run Next.js app. Pick a section and you get a zip with the section's assets and a prompt that rebuilds it 1:1.

## Tech stack

| Part | Powered by |
| --- | --- |
| Extension | Vite, TypeScript, Chrome Manifest V3 |
| Backend | Next.js, TypeScript |
| AI | Jev by TypeSafe, with Vercel AI Gateway as fallback |

## Setup

```bash
# 1. Backend (keep it running while you capture)
cd backend
pnpm install
cp .env.example .env   # add TYPESAFE_API_KEY
pnpm dev

# 2. Extension
cd frontend/jevelements
pnpm install
pnpm build
```

Load `frontend/jevelements/dist` at `chrome://extensions` → **Load unpacked**.

## Usage

Click the toolbar icon (or press `Alt+Shift+E`), then click a section. When the capture finishes, `<section>.zip` downloads. Extract it, open the folder in your editor, and paste `PROMPT.md` into your coding agent.

## More

- [Extension](frontend/jevelements/README.md)
- [Backend](backend/README.md)

## Checks

`pnpm verify` runs typecheck, lint and unit tests. Run it in each of `backend/` and `frontend/jevelements/`.
