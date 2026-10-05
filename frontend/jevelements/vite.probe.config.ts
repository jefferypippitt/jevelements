import { defineConfig } from 'vite'

// The page probe runs in the page's own JavaScript world, so like the content script it must be one
// classic script: dist/probe.js.
export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/probe/index.ts',
      formats: ['iife'],
      name: 'JevElementsProbe',
      fileName: () => 'probe.js',
    },
  },
})
