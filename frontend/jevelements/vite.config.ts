import { defineConfig } from 'vite'

// Builds the background service worker (dist/background.js) and copies public/ (the manifest).
// The content script is built separately by vite.content.config.ts because it must be a single classic script.
export default defineConfig({
  build: {
    rolldownOptions: {
      input: { background: 'src/background/index.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
})
