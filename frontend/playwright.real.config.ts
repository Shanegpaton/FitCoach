import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-real', outputDir: './test-results-real', workers: 1, timeout: 90000, expect: { timeout: 25000 },
  use: { baseURL: 'http://localhost:4175', trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.FITCOACH_CHROMIUM_PATH ? { executablePath: process.env.FITCOACH_CHROMIUM_PATH, args: ['--no-sandbox'] } : {} },
  webServer: [
    { command: `${process.env.FITCOACH_TEST_PYTHON ?? 'python'} -m backend.testing.server`, cwd: '..',
      url: 'http://127.0.0.1:8001/health', timeout: 120000, reuseExistingServer: false },
    // Separate build mode permits a local HTTP API without weakening production validation.
    { command: 'npm run icons && npx tsc -b && npx vite build --mode integration --outDir dist-integration && npx vite preview --outDir dist-integration --port 4175',
      url: 'http://localhost:4175', timeout: 120000, reuseExistingServer: false,
      env: { VITE_SUPABASE_URL: 'https://fitcoach-real.supabase.co', VITE_SUPABASE_ANON_KEY: 'test-only',
        VITE_FITCOACH_API_URL: 'http://127.0.0.1:8001', VITE_CHATGPT_VM_URL: '' } },
  ],
});
