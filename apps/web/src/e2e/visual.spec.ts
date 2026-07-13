import { expect, test } from 'playwright/test';

const phoneWidths = [390, 414, 430] as const;

for (const width of phoneWidths) {
  test(`Android-style shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: '默认个人账本' })).toBeVisible();
    await expect(page).toHaveScreenshot(`portfolio-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.getByRole('button', { name: '平台与账本' }).click();
    await expect(page.getByRole('heading', { name: '我的账本' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '交易平台' })).toBeVisible();
    await expect(page).toHaveScreenshot(`drawer-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.getByRole('button', { name: /汇丰银行/ }).click();
    await expect(page.locator('.global-top-bar-badge img')).toBeVisible();
    await expect(page).toHaveScreenshot(`topbar-hsbc-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.getByRole('button', { name: '平台与账本' }).click();
    const displaySettings = page.locator('.android-display-settings');
    await displaySettings.scrollIntoViewIfNeeded();
    await displaySettings.getByRole('button', { name: /显示设置/ }).click();
    const visibilityToggles = displaySettings.locator('input[type="checkbox"]');
    await expect(visibilityToggles).toHaveCount(8);
    await visibilityToggles.last().scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot(`drawer-settings-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.locator('.drawer-backdrop').click({ position: { x: 380, y: 700 } });
    await page.goto('/#/analysis');
    await expect(page.getByRole('heading', { name: /收益日历/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '区间盈亏排行' })).toBeVisible();
    await expect(page).toHaveScreenshot(`analysis-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.goto('/#/data');
    await expect(page.getByText('数据备份')).toBeVisible();
    await expect(page.getByText('邮箱手动同步')).toHaveCount(0);
    await expect(page).toHaveScreenshot(`data-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.goto('/#/settings');
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByText('邮箱同步')).toHaveCount(0);
    await expect(page).toHaveScreenshot(`settings-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.goto('/#/transactions');
    await expect(page.getByPlaceholder('搜索证券名称或代码')).toBeVisible();
    await expect(page).toHaveScreenshot(`transactions-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    const dateFilterButton = page.getByRole('button', { name: '日期' });
    await dateFilterButton.click();
    await expect(page.getByRole('heading', { name: '时间筛选' })).toBeVisible();
    const dateConfirmButton = page.getByRole('button', { name: '确定' });
    await expect(dateConfirmButton).toBeVisible();
    await expect(page).toHaveScreenshot(`transactions-date-filter-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    const dateCloseButton = page.locator('.transactions-sheet-header button');
    await expect(dateCloseButton).toHaveCount(1);
    await dateCloseButton.click();
    const categoryFilterButton = page.getByRole('button', { name: '筛选' });
    await categoryFilterButton.click();
    await expect(page.getByRole('heading', { name: '类型筛选' })).toBeVisible();
    await expect(page.getByRole('button', { name: '确定' })).toBeVisible();
    await expect(page).toHaveScreenshot(`transactions-category-filter-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });
}
