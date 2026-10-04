import { expect, test } from '@playwright/test';

// Live smoke test against the deployed static site (config: tests/smoke/playwright.config.ts, base URL = APP_URL
// or build.config.json). Three facts: the page loads, data/campus.json is fetched, and a floor plan renders.

test('the deployed site loads, fetches the campus data and draws a floor plan', async ({ page }) => {
  const campus = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/data/campus.json'));
  const plan = page.waitForResponse((r) => /\/floors\/[^/]+\.svg$/.test(new URL(r.url()).pathname));
  await page.goto('./');

  const res = await campus;
  expect(res.status(), 'data/campus.json status').toBe(200);
  const data = await res.json();
  expect(Array.isArray(data.buildings) && data.buildings.length, 'buildings in campus.json').toBeGreaterThan(0);
  expect(Array.isArray(data.floors) && data.floors.length, 'floors in campus.json').toBeGreaterThan(0);

  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 30_000 });
  for (const name of ['Map', 'Indoor', 'Schedule', 'Scan']) await expect(page.getByRole('tab', { name })).toBeVisible();

  await page.getByRole('tab', { name: 'Indoor' }).click();
  expect((await plan).status(), 'floor plan SVG status').toBe(200);
  await expect(page.locator('#viewer svg.fv-svg')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#viewer [data-mscn-room]').first()).toBeAttached();
});
