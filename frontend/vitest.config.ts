import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'], environment: 'node', env: { VITE_FITCOACH_API_URL: 'https://api.example.com' } } });
