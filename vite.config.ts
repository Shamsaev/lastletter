import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://localhost:${process.env.PORT ?? 3001}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow cloudflared / ngrok tunnel hostnames when testing inside Discord.
    allowedHosts: true,
    proxy: {
      '/api': api,
      '/avatars': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', target: 'es2020' },
});
