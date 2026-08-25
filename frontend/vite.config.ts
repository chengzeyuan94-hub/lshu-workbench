import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxy =
  (globalThis as { process?: { env?: { VITE_API_PROXY?: string } } }).process?.env?.VITE_API_PROXY
  || 'http://localhost:3456';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiProxy,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
