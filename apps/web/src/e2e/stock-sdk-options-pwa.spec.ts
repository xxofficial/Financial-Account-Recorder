import { test, expect } from 'playwright/test';

test('PWA stock-sdk domestic option capability probe', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  expect(await page.evaluate(() => Boolean(document.querySelector('link[rel="manifest"]')))).toBe(true);
  await expect.poll(async () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state || 'none';
  }), { timeout: 30_000 }).toBe('activated');
  await expect.poll(async () => page.evaluate(() => typeof window.__RECORDER_STOCK_SDK_OPTIONS_PWA_PROBE__)).toBe('function');

  const report = await page.evaluate(() => window.__RECORDER_STOCK_SDK_OPTIONS_PWA_PROBE__!());
  expect(report.runtime).toBe('pwa');
  expect(Object.keys(report.capabilities)).toEqual([
    'option.cn.etf', 'option.cn.index', 'option.cn.commodity', 'option.cn.cffex', 'option.cn.lhb',
  ]);
  expect(report.capabilities['option.cn.etf']?.ok).toBe(true);
  expect(report.capabilities['option.cn.index']?.ok).toBe(true);
  expect(report.capabilities['option.cn.cffex']?.ok).toBe(true);
  expect(report.capabilities['option.cn.lhb']?.ok).toBe(true);
  expect(report.capabilities['option.cn.commodity']?.status).toBe('empty_data');
});
