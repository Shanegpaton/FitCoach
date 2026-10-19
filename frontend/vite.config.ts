import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const https = process.env.FITCOACH_TLS_CERT && process.env.FITCOACH_TLS_KEY
  ? { cert: readFileSync(process.env.FITCOACH_TLS_CERT), key: readFileSync(process.env.FITCOACH_TLS_KEY) }
  : undefined;

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'production') {
    const apiUrl = loadEnv(mode, process.cwd(), 'VITE_FITCOACH_API_URL').VITE_FITCOACH_API_URL;
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new Error('Set VITE_FITCOACH_API_URL to the deployed API HTTPS origin before building the PWA.');
    }
    const localHost = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') ||
      parsed.hostname.startsWith('127.') || parsed.hostname === '[::1]' || parsed.hostname === '0.0.0.0';
    if (parsed.protocol !== 'https:' || localHost || !parsed.hostname || parsed.pathname !== '/' ||
      parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error('VITE_FITCOACH_API_URL must be the deployed API HTTPS origin, without a path or credentials.');
    }
    const vmUrl = loadEnv(mode, process.cwd(), 'VITE_CHATGPT_VM_URL').VITE_CHATGPT_VM_URL;
    if (vmUrl) {
      let vm: URL;
      try { vm = new URL(vmUrl); } catch { throw new Error('VITE_CHATGPT_VM_URL must be an HTTPS origin.'); }
      if (vm.protocol !== 'https:' || !vm.hostname || vm.pathname !== '/' || vm.search || vm.hash ||
          vm.username || vm.password) throw new Error('VITE_CHATGPT_VM_URL must be an HTTPS origin.');
    }
  }

  return {
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
  };
});
