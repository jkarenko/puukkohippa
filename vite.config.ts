import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true, allowedHosts: ['.up.karenko.fi'] },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
