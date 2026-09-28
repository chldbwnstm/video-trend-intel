import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Static SPA build.
 * - base './' so the build works from any subpath (GitHub Pages `/<repo>/`) and behind apps/server.
 * - HashRouter is used in the app, so no server-side rewrites are needed.
 * - @vti/core is a workspace package that exports TypeScript source; Vite compiles it directly.
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: 'localhost',
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // recharts is large; it lives in lazily-loaded page chunks.
    chunkSizeWarningLimit: 900,
  },
});
