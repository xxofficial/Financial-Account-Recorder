import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './src/e2e',
  testMatch: /massive-pwa\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'massive-pwa', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build:market-probe && npm run preview:market-probe -- --host 127.0.0.1 --port 4175',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
  },
});
