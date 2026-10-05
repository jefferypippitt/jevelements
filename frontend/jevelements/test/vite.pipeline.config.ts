// Builds test/pipeline-entry.ts into test/dist/pipeline.js (window.JevTest): pnpm test:build
import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'test/dist',
    emptyOutDir: true,
    lib: { entry: 'test/pipeline-entry.ts', formats: ['iife'], name: 'JevTest', fileName: () => 'pipeline.js' },
  },
})
