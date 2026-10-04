import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// v5 access classes (plan mscn-v5-access-classes-and-editors) in the app, on the real campus data: IT's "South entrance
// 2, level 2" (it-2-n0557) is a side (alt) door joined to the paths, EP's "West entrance 3" (ep-1-n0359, out of stair
// tower 1300K) an emergency exit the campus-map build leaves off the paths. The real data has no emergency hallway yet,
// so one page.route patch marks IT room 250C one. EP 1332 -> IT 203: the main doors win by default; with "Use side
// doors and paths" on, IT's side door saves about 250 m and wins. (The router refusing a joined emergency door that
// would be the shortest way is proven on synthetic graphs, tests/unit/access-classes.unit.mjs.)

const SIDE = 'it-2-n0557';
const SIDE_LABEL = 'South entrance 2, level 2';
const EXIT = 'ep-1-n0359';
const EXIT_ROOM = 'room-it-2-0250C';

async function patchClasses(page: Page) {
  await page.route(/\/data\/campus\.json(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const c = await res.json();
    for (const r of c.rooms) if (r.id === EXIT_ROOM) Object.assign(r, { type: 'corridor', access: 'emergency' });
    await route.fulfill({ response: res, json: c });
  });
}

async function boot(page: Page) {
  await page.goto('./');
  await expect(page.locator('#loading-screen')).toBeHidden();
  // the side door joins once the outdoor graph is in
  await expect.poll(() => page.evaluate((id) => !!(window as any).APP.graph.adj[id]?.some((e: any) => e.outdoor), SIDE), { timeout: 30_000 }).toBe(true);
}

async function searchAndOpen(page: Page, q: string, title: string) {
  if (await page.locator('#view-map').isVisible()) await page.getByRole('tab', { name: 'Indoor' }).click();
  const input = page.locator('#search-input');
  await input.fill(q);
  await expect(page.locator('#search-results li').first()).toContainText(title);
  await page.locator('#search-results li').first().click();
  await expect(page.locator('#room-sheet-title')).toHaveText(title);
}

async function routeEpToIt203(page: Page) {
  await searchAndOpen(page, 'EP 1332', 'EP 1332');
  await page.getByRole('button', { name: 'Set as start' }).click();
  await searchAndOpen(page, 'IT 203', 'IT 203');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await expect(page.locator('#route-panel')).toContainText('Route to');
}

// The route's node ids, the doors it enters by (with their class) and its step titles.
const routeFacts = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const r = w.NAV.route;
  const g = w.APP.graph;
  const ids: string[] = [].concat(...r.steps.map((s: any) => s.nodeIds));
  const doors = r.steps.filter((s: any) => s.kind === 'door').map((s: any) => ({ id: s.nodeId, access: w.MSCNPath.accessOf(g.nodes[s.nodeId]), title: s.title }));
  return { ids, doors, titles: r.steps.map((s: any) => s.title), error: r.error };
});

// Next until the step on IT's second floor indoors.
async function toItSecondFloor(page: Page) {
  for (let i = 0; i < 12; i++) {
    const s = await page.evaluate(() => { const r = (window as any).NAV.route; const st = r.steps[(window as any).NAV.stepIndex]; return st.floorId + ':' + st.kind; });
    if (s.startsWith('floor-it-2:')) break;
    const at = await page.evaluate(() => (window as any).NAV.stepIndex);
    await page.locator('#route-next').click();
    await expect(page.locator('#route-step .count')).toContainText(`Step ${at + 2} of`);
  }
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('Second Floor');
}

test('an emergency exit is drawn on the floor plan and never on a route; the route enters by a main door', async ({ page }) => {
  test.slow(); // a cross-building route: its outdoor steps fly the software-rendered (SwiftShader) map
  await patchClasses(page);
  await boot(page);
  expect(await page.evaluate((id) => (window as any).MSCNPath.accessOf((window as any).APP.graph.nodes[id]), EXIT)).toBe('emergency');
  await routeEpToIt203(page);
  const f = await routeFacts(page);
  expect(f.error).toBeNull();
  expect(f.ids).not.toContain(EXIT);
  expect(f.ids).not.toContain(SIDE);
  const itDoor = f.doors[f.doors.length - 1];
  expect(itDoor.access, itDoor.id).toBe('main');
  expect(f.titles.join(' | ')).not.toMatch(/side door|emergency/i);

  // the route starts on EP's first floor, where the emergency exit is drawn
  await expect(page.locator('#floor-picker [aria-checked="true"]')).toHaveText('First Floor');
  const exit = page.locator(`#viewer .fv-marker--exit[data-marker-id="class:${EXIT}"]`);
  await expect(exit).toHaveCount(1);
  await expect(exit).toContainText('EXIT');
  await expect(exit.locator('title')).toHaveText('Emergency exit (not used for directions)');

  await toItSecondFloor(page);
  await expect(page.locator(`#viewer .fv-marker--door-alt[data-marker-id="class:${SIDE}"]`)).toHaveCount(1);
  await expect(page.locator('#viewer .fv-marker--door-main')).not.toHaveCount(0);
  await expect(page.locator('#viewer .is-emergency')).not.toHaveCount(0);
  // the door step draws the door; the walk after it draws the route line
  if ((await page.evaluate(() => { const w = window as any; return w.NAV.route.steps[w.NAV.stepIndex].kind; })) === 'door') {
    const at = await page.evaluate(() => (window as any).NAV.stepIndex);
    await page.locator('#route-next').click();
    await expect(page.locator('#route-step .count')).toContainText(`Step ${at + 2} of`);
  }
  await expect(page.locator('#viewer .fv-route[data-route="active"] .fv-route-line')).toHaveCount(1);

  // the legend says what the three classes mean
  await page.locator('#route-legend summary').click();
  await expect(page.locator('#route-legend')).toContainText('Emergency exit');
  await expect(page.locator('#route-legend')).toContainText('Side door');
});

test('"Use side doors and paths" flips the route onto the side door, says so, and is remembered', async ({ page }) => {
  test.slow(); // a cross-building route: its outdoor steps fly the software-rendered (SwiftShader) map
  await patchClasses(page);
  await boot(page);
  await routeEpToIt203(page);
  expect((await routeFacts(page)).ids).not.toContain(SIDE);

  const toggle = page.locator('label.switch', { hasText: 'Use side doors and paths' });
  await toggle.click();
  await expect(page.locator('#use-side-doors')).toBeChecked();
  await expect.poll(async () => (await routeFacts(page)).ids.includes(SIDE)).toBe(true);
  const f = await routeFacts(page);
  expect(f.ids).not.toContain(EXIT);
  const side = f.doors.find((d) => d.id === SIDE)!;
  expect(side.access).toBe('alt');
  expect(side.title).toBe(`Enter by the side door (${SIDE_LABEL})`);
  expect(await page.evaluate(() => window.localStorage.getItem('mscnUseSideDoors'))).toBe('1');

  // the step shows the side door on the plan
  await toItSecondFloor(page);
  await expect(page.locator('#route-step .title')).toHaveText(/side door|Arrive at IT 203|Take the/);

  // off again: back on the main door
  await toggle.click();
  await expect.poll(async () => (await routeFacts(page)).ids.includes(SIDE)).toBe(false);
  expect(await page.evaluate(() => window.localStorage.getItem('mscnUseSideDoors'))).toBe('0');
});

// The phone screenshots for the lane record (light): MSCN_SHOT=1, desktop project only (each sets its own Pixel 7 page).
async function phone(browser: any, info: any) {
  const { devices } = await import('@playwright/test');
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: 'light', serviceWorkers: 'block', baseURL: info.project.use.baseURL });
  return { ctx, page: await ctx.newPage() };
}

// Frames the given node and the current step's route line, then writes .scratch/<name>.
async function shoot(page: Page, info: any, nodeId: string, name: string) {
  await page.evaluate((id) => {
    const w = window as any;
    const n = w.APP.graph.nodes[id];
    const st = w.NAV.route.steps[w.NAV.stepIndex];
    w.IND.viewer.focusPoints([[n.x, n.y]].concat(st.points || []));
  }, nodeId);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(info.config.rootDir, '..', '..', '.scratch', name) });
}

const firstDoor = (page: Page) => page.evaluate(() => { const w = window as any; const id = w.NAV.route.steps[0].nodeIds[0]; return w.MSCNPath.accessOf(w.APP.graph.nodes[id]) + ':' + id; });

test('screenshot: a phone floor plan of a route into IT by a main door, side doors drawn', async ({ browser }, info) => {
  test.skip(!process.env.MSCN_SHOT || info.project.name !== 'desktop', 'set MSCN_SHOT=1 to write .scratch/t-route-classes.png');
  const { ctx, page } = await phone(browser, info);
  await patchClasses(page);
  await boot(page);
  // no start: the automatic start is IT's main "South entrance, level 2", beside the side door it-2-n0557
  await searchAndOpen(page, 'IT 244', 'IT 244');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  await toItSecondFloor(page);
  expect(await firstDoor(page)).toBe('main:it-2-n0552');
  await shoot(page, info, SIDE, 't-route-classes.png');
  await ctx.close();
});

test('screenshot: a phone floor plan of a route into EP by a main door, the emergency exit drawn', async ({ browser }, info) => {
  test.skip(!process.env.MSCN_SHOT || info.project.name !== 'desktop', 'set MSCN_SHOT=1 to write .scratch/t-route-classes-ep-exit.png');
  const { ctx, page } = await phone(browser, info);
  await boot(page);
  // no start: the automatic start is EP's main "South entrance"; the emergency exit out of stair 1300K is on the way
  await searchAndOpen(page, 'EP 1351', 'EP 1351');
  await page.getByRole('button', { name: 'Navigate here' }).click();
  expect(await firstDoor(page)).toBe('main:ep-1-n0362');
  await expect(page.locator(`#viewer .fv-marker--exit[data-marker-id="class:${EXIT}"]`)).toHaveCount(1);
  await shoot(page, info, EXIT, 't-route-classes-ep-exit.png');
  await ctx.close();
});
