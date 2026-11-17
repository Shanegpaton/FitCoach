import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', fullyParallel: false, timeout: 45000,
  expect: { timeout: 10000 }, reporter: 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium', ...(process.env.FITCOACH_PLAYWRIGHT_BUNDLED_CHROMIUM ? {} : { channel: 'chrome' }), launchOptions: process.env.FITCOACH_CHROMIUM_PATH ? { executablePath: process.env.FITCOACH_CHROMIUM_PATH, args: ['--no-sandbox'] } : {} } },
    { name: 'phone-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'desktop-chrome', use: { browserName: 'chromium', ...(process.env.FITCOACH_PLAYWRIGHT_BUNDLED_CHROMIUM ? {} : { channel: 'chrome' }), launchOptions: process.env.FITCOACH_CHROMIUM_PATH ? { executablePath: process.env.FITCOACH_CHROMIUM_PATH, args: ['--no-sandbox'] } : {}, viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: { command: 'npm run build && npm run preview', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI, timeout: 120000,
    env: { VITE_CHATGPT_VM_URL: 'https://vm.example.com', VITE_SUPABASE_URL: 'https://fitcoach-e2e.supabase.co', VITE_SUPABASE_ANON_KEY: 'e2e-public-key', VITE_FITCOACH_API_URL: 'https://api.example.com' } },
});
