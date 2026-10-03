import { expect, test, type Page } from '@playwright/test';

// Fixture facts (dev/fixtures/build-fixtures.mjs): IT floors 1-2 public, IT mezzanine hidden,
// EP floor 1; stairs at the west end, elevator east; no mapsApiKey configured.

async function boot(page: Page, query = '') {
  await page.goto('/' + query);
  await expect(page.locator('#loading-screen')).toBeHidden();
}

async function searchAndOpen(page: Page, q: string, title: string) {
  const input = page.locator('#search-input');
  await input.fill(q);
  await expect(page.locator('#search-results li').first()).toContainText(title);
  await page.locator('#search-results li').first().click();
  await expect(page.locator('#room-sheet-title')).toHaveText(title);
}

const activeRoute = (page: Page) => page.locator('#viewer .fv-route[data-route="active"] .fv-route-line');

test('tabs render and switch', async ({ page }) => {
  await boot(page);
  for (const name of ['Map', 'Indoor', 'Schedule', 'Scan']) {
    await expect(page.getByRole('tab', { name })).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Schedule' }).click();
  await expect(page.locator('#view-schedule')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Schedule' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await expect(page.locator('#viewer svg.fv-svg')).toBeVisible();
  await expect(page.locator('#viewer [data-mscn-room]')).not.toHaveCount(0);
});

test('key-less map fallback lists buildings with walking deep links', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#map-notice')).toContainText('not configured');
  const link = page.locator('#bcard-bld-it a[data-directions]');
  await expect(link).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=36\.6160\d*%2C-88\.325\d*&travelmode=walking$/);
  await expect(page.locator('#bcard-bld-library')).toBeVisible();
  await page.locator('#bcard-bld-ep button[data-inside]').click();
  await expect(page.locator('#building-select')).toHaveValue('bld-ep');
});

test('search finds a room and opens it on its floor', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'IT 241', 'IT 241');
  await expect(page.locator('#view-indoor')).toBeVisible();
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('2');
  await expect(page.locator('[data-mscn-room="room-it-2-0241"]')).toHaveClass(/is-selected/);
  await expect(page.locator('#room-sheet')).toContainText('Computer Lab');
});

test('tapping a room on the plan selects it', async ({ page }) => {
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await expect(page.locator('#viewer-status')).toBeHidden();
  await page.locator('[data-mscn-room="room-it-1-0143"]').click();
  await expect(page.locator('#room-sheet-title')).toHaveText('IT 143');
  await expect(page.locator('[data-mscn-room="room-it-1-0143"]')).toHaveClass(/is-selected/);
});

test('route across floors draws a path, steps switch floors, avoid-stairs uses the elevator', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'IT 141', 'IT 141');
  await page.getByRole('button', { name: 'Set as start' }).click();
  await expect(page.locator('#start-chip')).toContainText('From IT 141');
  await searchAndOpen(page, '241', 'IT 241');
  await page.getByRole('button', { name: 'Navigate here' }).click();

  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('Step 1 of 2');
  await expect(panel).toContainText('Take Stair 1 up to Floor 2');
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('1');
  await expect(activeRoute(page)).toHaveCount(1);
  const pts = await activeRoute(page).getAttribute('points');
  expect((pts || '').trim().split(/\s+/).length).toBeGreaterThan(2);

  await page.locator('#route-next').click();
  await expect(panel).toContainText('Arrive at IT 241');
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('2');
  await expect(activeRoute(page)).toHaveCount(1);
  await expect(page.locator('#viewer .fv-marker--dest')).toHaveCount(1);

  await page.locator('label.switch').click();
  await expect(panel).toContainText('Take the elevator up to Floor 2');

  await page.locator('#route-close').click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#viewer .fv-route')).toHaveCount(0);
});

test('without a start, routes begin at the building entrance', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'robotics', 'IT 143');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.locator('#route-panel')).toContainText('From the building entrance');
  await expect(page.locator('#route-panel')).toContainText('Arrive at IT 143');
  await expect(activeRoute(page)).toHaveCount(1);
});

test('cross-building route adds an outdoor walking leg', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'IT 145', 'IT 145');
  await page.getByRole('button', { name: 'Set as start' }).click();
  await searchAndOpen(page, 'EP 132', 'EP 132');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('Leave by the West Entrance');
  await page.locator('#route-next').click();
  await expect(panel).toContainText('Walk to Engineering & Physics');
  await expect(panel.getByRole('link', { name: 'Open walking directions' })).toHaveAttribute('href', /travelmode=walking/);
  await page.locator('#route-next').click();
  await expect(panel).toContainText('Arrive at EP 132');
  await expect(page.locator('#building-select')).toHaveValue('bld-ep');
});

test('hidden floors stay out of the picker and search', async ({ page }) => {
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await page.locator('#building-select').selectOption('bld-it');
  await expect(page.locator('#floor-picker button')).toHaveCount(2);
  await page.locator('#search-input').fill('mezzanine');
  await expect(page.locator('#search-results')).toContainText('No rooms or buildings match');
});

test('floor plan failure falls back to a simplified plan that still works', async ({ page }) => {
  await boot(page, '?mock_fail=getFloorPlanSvg');
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await expect(page.locator('#viewer-notice')).toContainText('Simplified plan');
  await page.locator('[data-mscn-room="room-it-1-0141"]').click();
  await expect(page.locator('#room-sheet-title')).toHaveText('IT 141');
});

test('offline reload uses cached campus data', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#stale-banner')).toBeHidden();
  await boot(page, '?mock_offline=1');
  await expect(page.locator('#stale-banner')).toBeVisible();
  await expect(page.locator('#bcard-bld-it')).toBeVisible();
});

test('first load with no data and no cache shows a retryable error', async ({ page }) => {
  await page.goto('/?mock_offline=1');
  await expect(page.locator('#loading-screen')).toHaveClass(/is-error/);
  await expect(page.locator('#loading-retry')).toBeVisible();
});

test('a location QR deep link sets the starting point', async ({ page }) => {
  const payload = { type: 'location', building: 'bld-it', floor: 'floor-it-1', nodeId: 'node-it-1-wp-400', permanent: true, expires: '', description: 'IT first-floor lobby' };
  const qr = encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString('base64'));
  await boot(page, '?qr=' + qr);
  await expect(page.locator('#start-chip')).toContainText('From IT first-floor lobby');
  await expect(page.locator('#viewer .fv-marker--you')).toHaveCount(1);
});

test('schedule: add an event and route to it', async ({ page }) => {
  await boot(page);
  await page.getByRole('tab', { name: 'Schedule' }).click();
  await page.locator('#btn-add-event').click();
  await page.locator('#event-time').fill('23:30');
  await page.locator('#event-building').selectOption('bld-it');
  await page.locator('#event-room').selectOption('0243');
  await page.locator('#event-name').fill('Senior design review');
  await page.locator('#event-submit').click();
  await expect(page.locator('#schedule-list')).toContainText('Senior design review');
  await expect(page.locator('#schedule-list')).toContainText('IT 243');
  await page.locator('#schedule-list [data-go]').first().click();
  const panel = page.locator('#route-panel');
  await expect(panel.locator('#route-dest')).toHaveText('IT 243');
  await expect(panel).toContainText('Take Stair 1 up to Floor 2');
  await page.locator('#route-next').click();
  await expect(panel).toContainText('Arrive at IT 243');
});

test('wheel zoom and the zoom buttons change the view box', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse wheel is a desktop gesture');
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  const svg = page.locator('#viewer svg.fv-svg');
  await expect(svg).toHaveAttribute('viewBox', /\S/);
  const before = await svg.getAttribute('viewBox');
  const box = await page.locator('#viewer').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -400);
  await expect(svg).not.toHaveAttribute('viewBox', before!);
  const zoomed = await svg.getAttribute('viewBox');
  expect(Number(zoomed!.split(' ')[2])).toBeLessThan(Number(before!.split(' ')[2]));
  await page.locator('#zoom-fit').click();
  await expect(svg).toHaveAttribute('viewBox', before!);
});
