import { expect, test } from 'playwright/test';

test('local Schwab CSV fixture completes the visible import and sync workflow', async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto('/#/data/imports');
  const loadFixture = page.getByTestId('load-local-schwab-csv');
  await expect(loadFixture).toHaveCount(1);
  await loadFixture.click();

  const confirmImport = page.getByTestId('confirm-statement-import');
  await expect(confirmImport).toBeVisible();
  await expect(confirmImport).toBeEnabled();
  await confirmImport.click();
  await expect(confirmImport).toHaveCount(0, { timeout: 90_000 });

  await page.goto('/#/data/cache');
  const detectMissing = page.getByRole('button', { name: '检测缺失区间' });
  await expect(detectMissing).toHaveCount(1);
  await detectMissing.click();
  await expect(page.getByText('已检测并立即激活', { exact: false })).toBeVisible({ timeout: 90_000 });

  const startSync = page.getByRole('button', { name: '立即同步' });
  await expect(startSync).toBeEnabled();
  await startSync.click();
  await expect(page.getByText('同步状态：', { exact: false })).toBeVisible();
  await expect(page.getByTestId('market-sync-pending-count')).toHaveText('0', { timeout: 180_000 });
  await expect(page.getByText('已停止', { exact: true })).toHaveCount(0);
});
