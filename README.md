# JevElements

Chrome extension that turns any section of a website into a ready-to-run Next.js app. Pick a section and you get a zip with the section's assets and two prompts: `PROMPT.md` rebuilds it 1:1, and `REMIX.md` designs a new section inspired by it.

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

1. **Capture a section.** Click the toolbar icon (or press `Alt+Shift+E`), then click a section. When the capture finishes, `<section>.zip` downloads.
2. **Extract it.** Go to your `Downloads` folder, right-click the zip and choose **Extract All**.
3. **Install.** Open the extracted folder in your editor and run `pnpm i`.
4. **Build it.** In your coding agent, tag `@PROMPT.md`, attach a screenshot of the section, and send it. Plan mode is preferred.
   - **Or remix it.** To get your own design instead of a copy, fill in **Your brief** at the top of `REMIX.md` (strength `subtle`, `balanced` or `bold`, plus brand, palette, type and copy; leave a line as it is and the agent decides). Then tag `@REMIX.md` instead. The remix keeps the layout idea, component structure and motion, and replaces every image, font, logo and line of copy from the original.

## More

- [Extension](frontend/jevelements/README.md)
- [Backend](backend/README.md)

## Checks

`pnpm verify` runs typecheck, lint and unit tests. Run it in each of `backend/` and `frontend/jevelements/`.
