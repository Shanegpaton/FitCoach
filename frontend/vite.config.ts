import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const https = process.env.FITCOACH_TLS_CERT && process.env.FITCOACH_TLS_KEY
  ? { cert: readFileSync(process.env.FITCOACH_TLS_CERT), key: readFileSync(process.env.FITCOACH_TLS_KEY) }
  : undefined;

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    includeAssets: ['icon.svg', 'icons/*.png'],
    manifest: {
      name: 'FitCoachGPT', short_name: 'FitCoach', description: 'Your training, in motion.',
      theme_color: '#101211', background_color: '#101211', display: 'standalone',
      start_url: '/', scope: '/', orientation: 'portrait-primary',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], navigateFallback: '/index.html' },
  })],
  server: { port: 5173, strictPort: true, https },
  preview: { port: 4173, strictPort: true, https },
  build: { rollupOptions: { output: { manualChunks(id) {
    if (id.includes('node_modules/dexie/') || id.includes('node_modules/dexie-react-hooks/')) return 'storage';
  } } } },
});
