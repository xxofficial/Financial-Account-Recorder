import { defineConfig, devices } from 'playwright/test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/**
 * A local production simulation of GitHub Pages.  The deployment uses a
 * project subpath, so this catches root-relative asset URLs before `main` is
 * pushed and Pages is updated.
 */
export default defineConfig({
  testDir: './src/e2e',
  testMatch: /pages-preview\.spec\.ts/,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4281/Financial-Account-Recorder/',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'pages-preview', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run build:pages --workspace @recoder/web && npm run preview:pages --workspace @recoder/web',
    cwd: repositoryRoot,
    url: 'http://127.0.0.1:4281/Financial-Account-Recorder/',
    reuseExistingServer: false,
  },
});
