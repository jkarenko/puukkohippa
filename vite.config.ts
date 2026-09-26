import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: 'localhost', port: 5173, strictPort: true, allowedHosts: ['.up.karenko.fi'] },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
