import { expect, test } from 'playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const schwabStatementSample = resolve(process.cwd(), '../../samples/Statements/Schwab/Brokerage Account_06_30_2026.pdf');

test('opens the Android-style portfolio shell and navigates with hash routes', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: '持仓' })).toBeVisible();
  await expect(page.getByRole('link', { name: '分析' })).toBeVisible();
  await expect(page.getByRole('link', { name: '数据' })).toBeVisible();
  await expect(page.getByRole('link', { name: '流水' })).toBeVisible();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
});

test('keeps a visited primary tab mounted while switching tabs', async ({ page }) => {
  await page.goto('/#/transactions');
  const search = page.getByPlaceholder('搜索证券名称或代码');
  await search.fill('AAPL');
  await page.getByRole('link', { name: '分析' }).click();
  await expect(page).toHaveURL(/#\/analysis$/);
  await page.getByRole('link', { name: '流水' }).click();
  await expect(search).toHaveValue('AAPL');
});

test('extracts a local text PDF statement through the browser importer', async ({ page }) => {
  test.skip(!existsSync(schwabStatementSample), 'Local statement samples are intentionally excluded from Git.');
  await page.goto('/#/data/imports');
  await page.getByLabel('选择 PDF 结单').setInputFiles(schwabStatementSample);
  await expect(page.getByText(/SCHWAB ·/).first()).toBeVisible({ timeout: 20_000 });
});

test('removes legacy data routes instead of preserving aliases', async ({ page }) => {
  await page.goto('/#/import-export');
  await expect(page).toHaveURL(/#\/$/);
  await page.goto('/#/market-cache');
  await expect(page).toHaveURL(/#\/$/);
});

test('keeps global synchronization outside platform configuration', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: '自动同步', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '交易日历自动同步' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '平台配置' })).toBeVisible();
});
