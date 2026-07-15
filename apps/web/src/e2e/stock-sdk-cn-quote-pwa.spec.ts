import { test, expect } from 'playwright/test';

test('PWA stock-sdk A-share quotes use exchange-prefixed symbols', async ({ page }) => {
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

  const report = await page.evaluate(() => window.__RECORDER_STOCK_SDK_PWA_PROBE__!(['quote.cn']));
  expect(Object.keys(report.capabilities)).toEqual(['quote.cn']);
  expect(report.capabilities['quote.cn']?.ok).toBe(true);
  expect(report.capabilities['quote.cn']?.symbols).toEqual(['600519', '000858']);
});
