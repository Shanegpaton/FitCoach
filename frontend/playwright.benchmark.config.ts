import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './benchmarks', outputDir: './test-results-benchmark', testMatch: '**/*.spec.ts', workers: 1, timeout: 180000,
  use: { baseURL: 'http://localhost:4176',
    launchOptions: process.env.FITCOACH_CHROMIUM_PATH ? { executablePath: process.env.FITCOACH_CHROMIUM_PATH, args: ['--no-sandbox'] } : {} },
  webServer: { command: 'npx vite --host 127.0.0.1 --port 4176', url: 'http://localhost:4176/benchmarks/runner.html', reuseExistingServer: false },
});
