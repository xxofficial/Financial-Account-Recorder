import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './src/e2e',
  fullyParallel: true,
  // Use one baseline across local Windows and GitHub Actions Linux runs.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'mobile', testIgnore: /visual\.spec\.ts/, use: { ...devices['Pixel 5'] } },
    { name: 'desktop', testIgnore: /visual\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'visual', testMatch: /visual\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
