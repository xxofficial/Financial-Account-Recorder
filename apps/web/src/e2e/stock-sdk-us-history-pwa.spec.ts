import { test, expect } from 'playwright/test';

test('PWA stock-sdk US history resolves raw tickers through Eastmoney catalog', async ({ page }) => {
  await page.goto('/');
  const pwaRuntime = await page.evaluate(() => ({
    manifest: Boolean(document.querySelector('link[rel="manifest"]')),
  }));

  expect(pwaRuntime.manifest).toBe(true);
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state || 'none';
  }), { timeout: 30_000 }).toBe('activated');
  await expect.poll(async () => page.evaluate(() => typeof window.__RECORDER_STOCK_SDK_PWA_PROBE__)).toBe('function');

  const report = await page.evaluate(() => window.__RECORDER_STOCK_SDK_PWA_PROBE__!(['history.us']));
  expect(Object.keys(report.capabilities)).toEqual(['history.us']);
  expect(report.capabilities['history.us']?.ok).toBe(true);
  expect(report.capabilities['history.us']?.details?.every((detail) => detail.status === 'success')).toBe(true);
});
