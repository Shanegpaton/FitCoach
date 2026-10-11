import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', fullyParallel: false, timeout: 45000,
  expect: { timeout: 10000 }, reporter: 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium', channel: 'chrome' } },
    { name: 'phone-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'desktop-chrome', use: { browserName: 'chromium', channel: 'chrome', viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: { command: 'npm run build && npm run preview', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI, timeout: 120000,
    env: { VITE_SUPABASE_URL: 'https://fitcoach-e2e.supabase.co', VITE_SUPABASE_ANON_KEY: 'e2e-public-key' } },
});
