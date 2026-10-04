import { expect, test, type Page } from '@playwright/test';

// Runs against the built static site (npm run build output) served at /campus-nav/ by dev/serve.mjs --dist
// (tests/e2e/playwright.config.ts). The data is the exporter's data/campus.json and floors/*.svg (the DWG
// pipeline's output). Data facts used here (data/floorplans/*.json): IT (bld-it) floors 1-2 public and its
// mezzanine (room 0301) hidden; EP (bld-ep) floors 1-2 public and its penthouse (3300*) hidden; IT has entrances
// on both floors; EP 1322 is reachable only through its own exterior door. The campus map is the committed one
// (data/campus-map); map, route handoff, GPS and offline behaviour are in map.e2e.ts. Searches here run from the Indoor tab (a room searched on the
// Map tab flies the map instead). Failures (a floor plan that will not load, no network) are made with page.route,
// not with app test hooks.

const BASE_PATH = '/campus-nav/';

// Navigation is page-relative ('./'), never '/', so every test exercises the sub-path deployment.
async function boot(page: Page, query = '') {
  await page.goto('./' + query);
  await expect(page.locator('#loading-screen')).toBeHidden();
}

const failData = (page: Page) => page.route(/\/(config\.json|data\/[^?]*)(\?.*)?$/, (r) => r.abort('internetdisconnected'));

async function searchAndOpen(page: Page, q: string, title: string) {
  if (await page.locator('#view-map').isVisible()) await page.getByRole('tab', { name: 'Indoor' }).click();
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

test('without WebGL 2 the Map tab is a building list with "Directions to campus" to a main door', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).WebGL2RenderingContext; });
  await boot(page);
  await expect(page.locator('#map-notice')).toHaveAttribute('data-reason', 'nowebgl');
  const link = page.locator('#bcard-bld-it a[data-directions]');
  await expect(link).toHaveText('Directions to campus');
  await expect(link).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=36\.61\d+%2C-88\.32\d+$/);
  await expect(link).toHaveAttribute('target', '_blank');
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

  await page.locator('label.switch', { hasText: 'Avoid stairs' }).click();
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
  await expect(activeRoute(page)).toHaveCount(1);
  // the automatic start is one of IT's main doors (the common ones), not the side door nearest the room
  const r = await page.evaluate(() => {
    const route = (window as any).NAV.route;
    const g = (window as any).APP.graph;
    const first = route.steps[0].nodeIds[0];
    return { last: route.steps[route.steps.length - 1].title, first, main: !g.hasOutdoor || (window as any).MSCNPath.accessOf(g.nodes[first]) === 'main' };
  });
  expect(r.last).toBe('Arrive at IT 143');
  expect(r.main, r.first).toBe(true);
});

test('EP 1322 (exterior door only): reachable from outside; from it, out its own door and back in by a main door', async ({ page }) => {
  await boot(page);
  await searchAndOpen(page, 'EP 1322', 'EP 1322');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('From the building entrance');
  await expect(panel).toContainText('Arrive at EP 1322');
  await page.locator('#route-close').click();

  // v4: its door (ep-1-n0365) is a sole door, joined to the paths, so EP 1322 -> EP 2321 walks outside and back in
  await setStart(page, 'EP 1322', 'EP 1322');
  await searchAndOpen(page, 'EP 2321', 'EP 2321');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(panel.locator('#route-sentence')).toHaveText(/^Leave by the .+, walk \d+ m along the path, enter by the .+, take the (stairs|elevator) up to Second Floor, arrive at EP 2321\.$/);
  const kinds = () => page.evaluate(() => (window as any).NAV.route.steps.map((s: any) => s.kind).join(','));
  expect(await kinds()).toMatch(/^walk,outdoor,door,walk/);
  await page.locator('label.switch', { hasText: 'Avoid stairs' }).click();
  await expect(panel.locator('#route-sentence')).toHaveText(/take the elevator up to Second Floor, arrive at EP 2321\.$/);
});

test('without the outdoor graph EP 1322 is cut off from the rest of EP, with no false "turn off Avoid stairs" hint', async ({ page }) => {
  await page.route('**/data/campus-map/outdoor-graph.json', (r) => r.fulfill({ status: 404, body: '' }));
  await boot(page);
  await setStart(page, 'EP 1322', 'EP 1322');
  await searchAndOpen(page, 'EP 2321', 'EP 2321');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  const panel = page.locator('#route-panel');
  await expect(panel).toContainText('No route was found between these points.');
  await page.locator('label.switch', { hasText: 'Avoid stairs' }).click();
  await expect(panel).toContainText('No route was found between these points.');
  await expect(panel).not.toContainText('Turn off');
});

test('cross-building route: out by a door, along the paths on the map, in by a door, to the room', async ({ page }) => {
  await boot(page);
  await setStart(page, 'IT 145', 'IT 145');
  await searchAndOpen(page, 'EP 1332', 'EP 1332');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  const panel = page.locator('#route-panel');
  await expect(panel.locator('#route-step .title')).toHaveText(/^Leave by the .+ entrance$/);
  await page.locator('#route-next').click();
  await expect(panel.locator('#route-step .title')).toHaveText(/^Walk to the .+ of Engineering and Physics Building$/);
  await expect(page.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#route-next').click();
  await expect(panel.locator('#route-step .title')).toHaveText(/^Enter by the /);
  await expect(page.getByRole('tab', { name: 'Indoor' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#building-select')).toHaveValue('bld-ep');
  await page.locator('#route-next').click();
  await expect(panel).toContainText('Arrive at EP 1332');
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
  await page.route('**/floors/*.svg*', (r) => r.abort('failed'));
  await boot(page);
  await page.getByRole('tab', { name: 'Indoor' }).click();
  await page.locator('#building-select').selectOption('bld-it');
  await expect(page.locator('#viewer-notice')).toContainText('Simplified plan');
  await page.locator('[data-mscn-room="room-it-1-0141"]').click();
  await expect(page.locator('#room-sheet-title')).toHaveText('IT 141');
});

test('offline reload uses cached campus data', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#stale-banner')).toBeHidden();
  await failData(page);
  await boot(page);
  await expect(page.locator('#stale-banner')).toBeVisible();
  await expect(page.locator('#bcard-bld-it')).toBeVisible();
});

test('first load with no data and no cache shows a retryable error', async ({ page }) => {
  await failData(page);
  await page.goto('./');
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
