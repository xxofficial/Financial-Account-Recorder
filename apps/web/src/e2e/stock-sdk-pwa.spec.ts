import { test, expect } from 'playwright/test';

test('PWA stock-sdk capability probe returns an auditable matrix', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const pwaRuntime = await page.evaluate(() => ({
    manifest: Boolean(document.querySelector('link[rel="manifest"]')),
  }));
  console.log(`PWA_RUNTIME ${JSON.stringify(pwaRuntime)}`);
  expect(pwaRuntime.manifest).toBe(true);
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state || 'none';
  }), { timeout: 30_000 }).toBe('activated');
  await expect.poll(async () => page.evaluate(() => typeof window.__RECORDER_STOCK_SDK_PWA_PROBE__)).toBe('function');
  const report = await page.evaluate(() => window.__RECORDER_STOCK_SDK_PWA_PROBE__!());
  console.log(`STOCK_SDK_PWA_REPORT ${JSON.stringify(report)}`);
  await testInfo.attach('stock-sdk-pwa-capability-report.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.runtime).toBe('pwa');
  expect(Object.keys(report.capabilities)).toEqual([
    'quote.cn', 'quote.hk', 'quote.us', 'history.cn', 'history.hk', 'history.us', 'option.us',
  ]);
});
