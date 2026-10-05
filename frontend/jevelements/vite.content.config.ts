import { defineConfig } from 'vite'

// Content scripts can't be ES modules, so bundle everything into one IIFE: dist/content.js.
export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/content/index.ts',
      formats: ['iife'],
      name: 'JevElementsContent',
      fileName: () => 'content.js',
    },
  },
})
