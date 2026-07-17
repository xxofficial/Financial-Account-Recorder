import { test, expect } from 'playwright/test';

const apiKey = process.env.MASSIVE_API_KEY;

test('PWA Massive capability probe produces a redacted capability matrix', async ({ page }, testInfo) => {
  test.skip(!apiKey, 'Set MASSIVE_API_KEY locally to run the authenticated Massive probe.');
  test.setTimeout(180_000);
  await page.goto('/');
  await expect.poll(async () => page.evaluate(() => typeof window.__RECORDER_MASSIVE_PWA_PROBE__), { timeout: 30_000 }).toBe('function');
  const report = await page.evaluate((key) => window.__RECORDER_MASSIVE_PWA_PROBE__!(key), apiKey!);
  await testInfo.attach('massive-pwa-capability-report.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.runtime).toBe('pwa');
  expect(report.capabilities['metadata.us']?.status).toBe('success');
  expect(report.capabilities['history.us.raw']?.status).toBe('success');
  expect(report.capabilities['split.us']?.status).toBe('success');
  expect(report.capabilities['dividend.us']?.status).toBe('success');
  expect(report.capabilities['calendar.us']?.status).toBe('success');
  expect(report.capabilities['option.us.contracts']?.status).toBe('success');
  expect(report.capabilities['option.us.history']?.status).toBe('success');
  expect(report.capabilities['quote.us.snapshot']?.status).toBe('unsupported');
  expect(report.capabilities['option.us.snapshot']?.status).toBe('unsupported');
});

test('settings exposes the unified Massive US market-data card', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByText('行情与诊断', { exact: true }).click();
  await expect(page.getByText('Massive 美股行情服务', { exact: true })).toBeVisible();
  await expect(page.getByText('用于美股历史行情和公司行动', { exact: false })).toBeVisible();
});
