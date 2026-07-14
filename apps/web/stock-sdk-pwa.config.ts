import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './src/e2e',
  testMatch: /stock-sdk.*pwa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'pwa-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview:market-probe -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: true,
  },
});
