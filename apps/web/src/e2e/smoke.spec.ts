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

test('extracts a local text PDF statement through the browser importer', async ({ page }) => {
  test.skip(!existsSync(schwabStatementSample), 'Local statement samples are intentionally excluded from Git.');
  await page.goto('/#/data/imports');
  await page.getByLabel('选择 PDF 结单').setInputFiles(schwabStatementSample);
  await expect(page.getByText(/SCHWAB ·/).first()).toBeVisible({ timeout: 20_000 });
});
