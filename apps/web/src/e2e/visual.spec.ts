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
    await expect(page.getByRole('heading', { name: '通用偏好' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '平台配置' })).toBeVisible();
    await expect(page.getByText('邮箱同步')).toHaveCount(0);
    await page.getByRole('button', { name: /涨跌颜色/ }).click();
    const marketPicker = page.getByRole('dialog', { name: '选择涨跌颜色' });
    await expect(marketPicker).toBeVisible();
    await expect(marketPicker.getByRole('button', { name: /红涨绿跌/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /主题色/ }).click();
    const themePicker = page.getByRole('dialog', { name: '选择主题色' });
    await expect(themePicker).toBeVisible();
    await expect(themePicker.getByRole('button', { name: /跟随系统/ })).toBeVisible();
    await themePicker.getByRole('button', { name: /暗色/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: /主题色/ }).click();
    await page.getByRole('dialog', { name: '选择主题色' }).getByRole('button', { name: /跟随系统/ }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveScreenshot(`settings-${width}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.05,
    });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator('.secondary-page-header')).toBeVisible();
    await page.getByRole('button', { name: /卓锐证券/ }).click();
    await expect(page.getByText('费率方案')).toBeVisible();
    await expect(page.getByText('电子结单密码')).toBeVisible();
    await page.getByText('高级与诊断').click();
    await expect(page.getByText('行情 API 与直连优先级配置')).toBeVisible();
    await expect(page).toHaveScreenshot(`settings-platform-advanced-${width}.png`, {
      animations: 'disabled',
      // Chinese fallback fonts differ slightly between Windows and the
      // Linux runner; retain this view while allowing glyph anti-aliasing.
      maxDiffPixelRatio: 0.08,
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
    await page.locator('.transactions-sheet-header button').click();
    await page.goto('/#/transactions/new?type=BUY');
    await expect(page.getByRole('heading', { name: '录入交易' })).toBeVisible();
    await expect(page.locator('.trade-form-page')).toBeVisible();
    await expect(page.locator('.bottom-tab-bar')).toHaveCount(0);
    await expect(page.locator('.sync-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /自动估算/ })).toBeDisabled();
    await expect(page.getByText('自动估算（待实现）')).toBeVisible();
    await expect(page).toHaveScreenshot(`transaction-form-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
    await page.goto('/#/transactions/new?type=DEPOSIT');
    await expect(page.getByText('货币种类')).toBeVisible();
    await expect(page.getByText('入金金额')).toBeVisible();
    await expect(page.getByText('市场')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /自动估算/ })).toHaveCount(0);
    await page.goto('/#/transactions/new?type=BUY');
    await page.getByRole('button', { name: '期权' }).click();
    await expect(page.getByText('正股代码')).toBeVisible();
    await expect(page.getByText('期权类型')).toBeVisible();
  });
}

test('record action sheet stays usable on a short mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/#/');
  await page.getByRole('button', { name: '记一笔' }).click();
  await expect(page.getByRole('dialog', { name: '记一笔' })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(page.getByRole('button', { name: '其他' })).toBeVisible();
  await expect(page).toHaveScreenshot('record-action-sheet-short-390.png', { animations: 'disabled', maxDiffPixelRatio: 0.05 });
  await page.getByRole('button', { name: '其他' }).click();
  await expect(page.getByRole('heading', { name: '录入交易' })).toBeVisible();
});
