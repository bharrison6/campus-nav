import { expect, test, type Page } from '@playwright/test';

// Runs against dev/serve.mjs, which answers google.script.run with the real .gs backend seeded from the
// generated SeedFloorData.gs (the DWG pipeline's output) and serves the embedded FP_*.html floor plans.
// Data facts used here (data/floorplans/*.json): IT (bld-it) floors 1-2 public and its mezzanine (room 0301)
// hidden; EP (bld-ep) floors 1-2 public and its penthouse (3300*) hidden; IT has entrances on both floors;
// EP 1322 is reachable only through its own exterior door; no mapsApiKey is configured.

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

async function setStart(page: Page, q: string, title: string) {
  await searchAndOpen(page, q, title);
  await page.getByRole('button', { name: 'Set as start' }).click();
  await expect(page.locator('#start-chip')).toContainText('From ' + title);
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
  await expect(link).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&destination=36.615712%2C-88.322748&travelmode=walking');
  await expect(page.locator('#bcard-bld-wl')).toBeVisible();
  await page.locator('#bcard-bld-ep button[data-inside]').click();
  await expect(page.locator('#building-select')).toHaveValue('bld-ep');
});

test('search finds a room and opens it on its floor', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'IT 241', 'IT 241');
  await expect(page.locator('#view-indoor')).toBeVisible();
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('Second Floor');
  await expect(page.locator('path[data-mscn-room="room-it-2-0241"]')).toHaveClass(/is-selected/);
  await expect(page.locator('#room-sheet')).toContainText('Collins Industry and Technology Center · Second Floor');
});

test('"IT 141" ranks the room first; "EP 232" (EP numbers are four digits) offers the EP 232x rooms', async ({ page }) => {
  await boot(page);
  const input = page.locator('#search-input');
  await input.fill('IT 141');
  await expect(page.locator('#search-results li').first()).toContainText('IT 141');
  await expect(page.locator('#search-results li').first()).not.toContainText('other');
  await input.fill('EP 232');
  await expect(page.locator('#search-results li').first()).toContainText('EP 2321');
  await expect(page.locator('#search-results')).toContainText('EP 2323');
  await expect(page.locator('#search-results')).not.toContainText('IT ');
});

test('tapping a room on the plan selects it', async ({ page }) => {
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await page.locator('#building-select').selectOption('bld-it');
  await expect(page.locator('#viewer-status')).toBeHidden();
  await page.locator('[data-mscn-room="room-it-1-0143"]').click();
  await expect(page.locator('#room-sheet-title')).toHaveText('IT 143');
  await expect(page.locator('[data-mscn-room="room-it-1-0143"]')).toHaveClass(/is-selected/);
});

test('room labels: the plan\'s CAD labels are hidden and the viewer\'s labels keep their size under zoom', async ({ page, isMobile }) => {
  test.skip(isMobile, 'mouse wheel is a desktop gesture');
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await page.locator('#building-select').selectOption('bld-it');
  await expect(page.locator('#viewer-status')).toBeHidden();
  await expect(page.locator('#viewer svg [id="labels"]')).toHaveAttribute('display', 'none');
  await expect(page.locator('#viewer text[data-mscn-room]')).toHaveCount(0);
  const labels = page.locator('#viewer .fv-label');
  await expect(labels).toHaveCount(144); // every IT first-floor room
  const visibleHeight = async () => page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('#viewer .fv-label:not(.is-hidden)'))
      .find((t) => t.textContent === '143') as SVGTextElement | undefined;
    return el ? el.getBoundingClientRect().height : 0;
  });
  const before = await visibleHeight();
  expect(before).toBeGreaterThan(0);
  const box = await page.locator('#viewer').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -500);
  await expect.poll(visibleHeight).not.toBe(0);
  const after = await visibleHeight();
  expect(Math.abs(after - before) / before).toBeLessThan(0.2);
});

test('route across floors draws a path, steps switch floors, avoid-stairs uses the elevator', async ({ page }) => {
  await boot(page);
  await setStart(page, 'IT 141', 'IT 141');
  await searchAndOpen(page, 'IT 241', 'IT 241');
  await page.getByRole('button', { name: 'Navigate here' }).click();

  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('Step 1 of 2');
  await expect(panel).toContainText('Take the stairs up to Second Floor');
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('First Floor');
  await expect(activeRoute(page)).toHaveCount(1);
  const pts = await activeRoute(page).getAttribute('points');
  expect((pts || '').trim().split(/\s+/).length).toBeGreaterThan(2);

  await page.locator('#route-next').click();
  await expect(panel).toContainText('Arrive at IT 241');
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('Second Floor');
  await expect(activeRoute(page)).toHaveCount(1);
  await expect(page.locator('#viewer .fv-marker--dest')).toHaveCount(1);

  await page.locator('label.switch').click();
  await expect(panel).toContainText('Take the elevator up to Second Floor');

  await page.locator('#route-close').click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#viewer .fv-route')).toHaveCount(0);
});

test('without a start, routes begin at the building entrance', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'IT 143', 'IT 143');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.locator('#route-panel')).toContainText('From the building entrance');
  await expect(page.locator('#route-panel')).toContainText('Arrive at IT 143');
  await expect(activeRoute(page)).toHaveCount(1);
});

test('EP 1322 (exterior door only): reachable from outside, and no false "turn off Avoid stairs" hint from it', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'EP 1322', 'EP 1322');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('From the building entrance');
  await expect(panel).toContainText('Arrive at EP 1322');
  await page.locator('#route-close').click();

  await setStart(page, 'EP 1322', 'EP 1322');
  await searchAndOpen(page, 'EP 2321', 'EP 2321');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(panel).toContainText('No route was found between these points.');
  await page.locator('label.switch').click();
  await expect(panel).toContainText('No route was found between these points.');
  await expect(panel).not.toContainText('Turn off');
});

test('cross-building route adds an outdoor walking leg', async ({ page }) => {
  await boot(page);
  await setStart(page, 'IT 145', 'IT 145');
  await searchAndOpen(page, 'EP 1332', 'EP 1332');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('Leave by the nearest exit');
  await page.locator('#route-next').click();
  await expect(panel).toContainText('Walk to Engineering and Physics Building');
  await expect(panel.getByRole('link', { name: 'Open walking directions' })).toHaveAttribute('href', /travelmode=walking/);
  await page.locator('#route-next').click();
  await expect(panel).toContainText('Arrive at EP 1332');
  await expect(page.locator('#building-select')).toHaveValue('bld-ep');
});

test('hidden floors stay out of the picker and search', async ({ page }) => {
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  for (const b of ['bld-it', 'bld-ep']) {
    await page.locator('#building-select').selectOption(b);
    await expect(page.locator('#floor-picker button')).toHaveText(['First Floor', 'Second Floor']);
  }
  for (const q of ['mezzanine', 'IT 301', '3300']) {
    await page.locator('#search-input').fill(q);
    await expect(page.locator('#search-results')).toContainText('No rooms or buildings match');
  }
});

test('floor plan failure falls back to a simplified plan that still works', async ({ page }) => {
  await boot(page, '?mock_fail=getFloorPlanSvg');
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await page.locator('#building-select').selectOption('bld-it');
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

test('a location QR deep link (admin format ?qr=<base64 JSON>) sets the starting point', async ({ page }) => {
  const payload = { type: 'location', building: 'bld-it', floor: 'floor-it-1', nodeId: 'it-1-n0489', permanent: true, expires: '', description: 'IT first-floor entrance' };
  const qr = encodeURIComponent(Buffer.from(JSON.stringify(payload)).toString('base64'));
  await boot(page, '?qr=' + qr);
  await expect(page.locator('#start-chip')).toContainText('From IT first-floor entrance');
  await expect(page.locator('#viewer .fv-marker--you')).toHaveCount(1);
});

test('?room= and ?loc= deep links open a room and set a start node', async ({ page }) => {
  await boot(page, '?room=room-ep-2-2321');
  await expect(page.locator('#room-sheet-title')).toHaveText('EP 2321');
  await boot(page, '?loc=it-1-n0489');
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
  await expect(panel).toContainText('From the building entrance');
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
