import { expect, test } from '@playwright/test';

// Live smoke test against a deployed web app. Set APP_URL to the /exec URL:
//   APP_URL=https://script.google.com/macros/s/<id>/exec npx playwright test tests/smoke.spec.ts
// Skipped when APP_URL is unset, so the dead v1 deployment URL is never exercised.
const APP_URL = process.env.APP_URL;

test.skip(!APP_URL, 'APP_URL is not set; the live smoke test needs a deployed /exec URL');

test('deployed web app loads campus data and renders the shell', async ({ page }) => {
  await page.goto(APP_URL!);
  // Apps Script serves the page inside nested sandbox iframes.
  await expect(page.locator('iframe')).toHaveCount(1, { timeout: 20_000 });
  const app = page.frameLocator('iframe').first().frameLocator('iframe').first();

  for (const name of ['Map', 'Indoor', 'Schedule', 'Scan']) {
    await expect(app.getByRole('tab', { name })).toBeVisible({ timeout: 20_000 });
  }
  await expect(app.locator('#loading-screen')).toBeHidden({ timeout: 30_000 });
  await expect(app.locator('#search-input')).toBeVisible();

  await app.locator('#search-input').fill('IT');
  await expect(app.locator('#search-results li').first()).toBeVisible();

  await app.getByRole('tab', { name: 'Indoor' }).click();
  await expect(app.locator('#viewer svg.fv-svg')).toBeVisible({ timeout: 30_000 });
  await expect(app.locator('#viewer [data-mscn-room]').first()).toBeAttached();
});
