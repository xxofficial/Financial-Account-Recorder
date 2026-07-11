import { expect, test } from 'playwright/test';

const phoneWidths = [390, 414, 430] as const;

for (const width of phoneWidths) {
  test(`Android-style shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: '持仓' })).toBeVisible();
    await expect(page).toHaveScreenshot(`portfolio-${width}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });
}
