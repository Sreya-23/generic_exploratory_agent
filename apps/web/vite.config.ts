import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const API_TARGET = process.env.VITE_API_URL ?? 'http://localhost:3001';

export default defineConfig({
  envDir: resolve(__dirname, '../..'),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
      '/sessions-files': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
