# JevElements extension

Chrome extension: pick any section of a website and copy a prompt that rebuilds it 1:1 as a new Next.js app.

```bash
pnpm install
pnpm build   # writes dist/; load it at chrome://extensions → Load unpacked
```

Click the toolbar icon (or Alt+Shift+E), then click a section. The capture records structure, styles, animations (including text that types, counts or scrambles), scroll and hover behaviour, and takes one screenshot of the section's initial look. It downloads the section's real files: images and video (also the ones scrolling or hovering swaps in), canvas snapshots, the textures, models and Lottie files that canvases and WebGL scenes use, and the page scripts holding canvas code that runs in a Web Worker. Those files are uploaded to the backend (`pnpm dev` in `backend/`, which must be running while you capture). When the capture finishes, the extension downloads `<section>.zip` (e.g. `hero-section.zip`): a ready Next.js app with those files in `public/` and the prompt as `PROMPT.md`. Extract it, open the folder in your editor, and paste the prompt; the agent only runs `npm install`.

- `src/content/`: the on-page picker and the capture (`extract.ts`, `media.ts`, `code.ts`, `scroll.ts`, `interactions.ts`, `timeline.ts`)
- `src/background/`: service worker (screenshots, downloads, uploads, backend calls)
- `src/probe/`: page-world script that reads three.js, WebGL, GSAP and Lottie state, and notes Web Workers and offscreen canvases
- `src/shared/prompt.ts`: turns a capture into the prompt
- `test/runtime.html`: a page with three.js, raw WebGL, GSAP, Lottie and Lenis for trying the probe (`pnpm test:build && pnpm test:serve`; add `?late` to load it without the probe). `pnpm test:build` also bundles the capture pipeline as `test/dist/pipeline.js` (`window.JevTest`).
