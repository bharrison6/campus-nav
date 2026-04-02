import { expect, test } from '@playwright/test';

test('web app shell loads', async ({ page }) => {
  await page.goto('');
  await expect(
    page.getByText('This application was created by a Google Apps Script user')
  ).toBeVisible();

  await expect(page.locator('iframe')).toHaveCount(1);
  const appFrame = page.frameLocator('iframe').first().frameLocator('iframe').first();

  await expect(appFrame.getByText('Campus Map')).toBeVisible();
  await expect(appFrame.getByText('Map', { exact: true })).toBeVisible();
  await expect(appFrame.getByText('Indoor', { exact: true })).toBeVisible();
  await expect(appFrame.getByText('Schedule', { exact: true })).toBeVisible();
  await expect(appFrame.getByText('Scan', { exact: true })).toBeVisible();
});
