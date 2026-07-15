import { expect, test } from 'playwright/test';

test('loads platform logos below the GitHub Pages project path', async ({ page }) => {
  await page.goto('/#/');

  const drawerButton = page.getByRole('button', { name: '平台与账本' });
  await expect(drawerButton).toHaveCount(1);
  await drawerButton.click();

  const logos = page.locator('aside.ledger-drawer img');
  await expect(logos).toHaveCount(8);
  const state = await logos.evaluateAll((images) => images.map((image) => {
    const logo = image as HTMLImageElement;
    return { src: logo.getAttribute('src'), complete: logo.complete, width: logo.naturalWidth };
  }));
  expect(state.every((image) => image.src?.startsWith('./platform_') && image.complete && image.width > 0)).toBe(true);
});

test('keeps statement passwords in settings in the production Pages preview', async ({ page }) => {
  await page.goto('/#/data/imports');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByText('加密结单会自动使用设置中为当前平台保存的密码')).toBeVisible();
});
