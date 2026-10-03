// Backend (.gs) tests in the Apps Script runtime stand-in (dev/gas-runtime.cjs).
// Part 1 runs on a tiny synthetic floor seed (defined after the real files, so it overrides
// SeedFloorData.gs) to check contract shapes and admin operations by hand-countable numbers.
// Part 2 runs on the real generated SeedFloorData.gs and data/floorplans/*.json.
// Adopted from lane B's mock-runtime suite (2026-10-03).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const SRC = join(ROOT, 'scripts', 'apps-script', 'src');
const FLOORPLANS = join(ROOT, 'data', 'floorplans');
const require = createRequire(import.meta.url);
const { makeRuntime, CELL_LIMIT } = require('../../dev/gas-runtime.cjs');

const GEN = `
function getGeneratedFloorsSeed() { return [
  ['floor-it-1','bld-it',1,'1st Floor','FP_floor_it_1',5000,3350,0.0254,true],
  ['floor-it-3','bld-it',3,'Mezzanine','FP_floor_it_3',5000,3350,0.0254,false]
]; }
function getGeneratedRoomsSeed() { return [
  ['room-it-1-0141','floor-it-1','0141','141 Office','office','[[0,0],[10,0],[10,10]]',5,5,true],
  ['room-it-1-0140B','floor-it-1','0140B','140B','storage',[[0,0],[1,1],[2,0]],1,1,false],
  ['room-it-3-0301','floor-it-3','0301','301','mechanical','',1,1,false]
]; }
function getGeneratedNavNodesSeed() { return [
  ['n1','floor-it-1',0,0,'stair','','it-stair-1'],
  ['n2','floor-it-1',10,0,'room','room-it-1-0141',''],
  ['n3','floor-it-3',0,0,'stair','','it-stair-1']
]; }
function getGeneratedNavEdgesSeed() { return [
  ['e1','n1','n2',3.2,false,true],
  ['e2','n1','n3',4,true,false]
]; }`;

const BUILDINGS = 89;

// google.script.run returns JSON-shaped values; compare in that shape.
const js = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const doGetJson = (R, parameter) => JSON.parse(R.ctx.doGet({ parameter }).text);

// ---------------------------------------------------------------------------------------------
// Part 1: synthetic seed
// ---------------------------------------------------------------------------------------------

const R = makeRuntime(SRC, GEN);
const g = new Proxy(R.ctx, {
  get: (o, k) => (typeof o[k] === 'function' ? (...a) => js(o[k](...a)) : o[k]),
});
const PIN = () => R.props.ADMIN_PIN;

test('ping route; uninitialized data calls name ?action=init', () => {
  assert.deepEqual(doGetJson(R, { action: 'ping' }), { ok: true, data: 'pong' });
  const out = doGetJson(R, { action: 'getAllCampusData' });
  assert.equal(out.ok, false);
  assert.match(out.error, /init/);
});

test('initSystem creates, seeds, generates a PIN, returns no secret; idempotent', () => {
  const init = doGetJson(R, { action: 'init' }).data;
  assert.equal(init.created, true);
  assert.deepEqual(init.seeded, { Buildings: BUILDINGS, Floors: 2, Rooms: 3, NavNodes: 3, NavEdges: 2 });
  assert.equal(init.counts.Config, 1);
  assert.deepEqual(init.schemaMismatch, []);
  assert.equal(init.floorSeedSource, 'generated');
  assert.equal(init.settings.adminPinConfigured, true);
  assert.equal(init.settings.mapsApiKeyConfigured, false);
  assert.match(R.props.ADMIN_PIN, /^[1-9]\d{5}$/);
  assert.ok(!JSON.stringify(init).includes(R.props.ADMIN_PIN), 'PIN leaked in init response');
  assert.ok(!R.ss().getSheetByName('Sheet1'), 'Sheet1 not removed');

  const pin = R.props.ADMIN_PIN;
  const again = g.initSystem();
  assert.equal(again.created, false);
  assert.equal(again.seeded.Buildings, 'kept');
  assert.equal(R.props.ADMIN_PIN, pin);
  assert.equal(again.counts.Rooms, 3);
});

test('getAllCampusData: v2 shapes, text numbers preserved, booleans normalized', () => {
  const all = g.getAllCampusData();
  assert.equal(all.contractVersion, 2);
  const it = all.buildings.find((b) => b.id === 'bld-it');
  assert.deepEqual([it.code, it.number, it.hasIndoor], ['IT', '0135', true]);
  const ep = all.buildings.find((b) => b.id === 'bld-ep');
  assert.deepEqual([ep.code, ep.number, ep.hasIndoor, ep.name], ['EP', '0174', true, 'Engineering and Physics Building']);
  assert.equal(all.buildings.find((b) => b.id === 'bld-ac').hasIndoor, false);
  assert.deepEqual(Object.keys(it), ['id', 'name', 'code', 'number', 'lat', 'lng', 'entrances', 'photoUrl', 'hasIndoor']);
  const r = all.rooms.find((x) => x.id === 'room-it-1-0141');
  assert.equal(r.number, '0141');
  assert.deepEqual(r.polygon, [[0, 0], [10, 0], [10, 10]]);
  assert.equal(r.searchable, true);
  assert.deepEqual(all.rooms.find((x) => x.id === 'room-it-1-0140B').polygon, [[0, 0], [1, 1], [2, 0]]);
  assert.equal(all.floors.find((f) => f.id === 'floor-it-3').public, false);
  assert.equal(all.navNodes.find((n) => n.id === 'n1').linkId, 'it-stair-1');
  const e2 = all.navEdges.find((e) => e.id === 'e2');
  assert.deepEqual([e2.floorChange, e2.accessible], [true, false]);
  assert.ok(!all.config.some((c) => c.key === 'mapsApiKey'), 'mapsApiKey present without a key');
  assert.equal(all.version, '1');
});

test('getPublicCampusData drops the non-public floor and everything on it, keeps non-searchable rooms', () => {
  const p = g.getPublicCampusData();
  assert.deepEqual(p.floors.map((f) => f.id), ['floor-it-1']);
  assert.deepEqual(p.rooms.map((r) => r.id).sort(), ['room-it-1-0140B', 'room-it-1-0141']);
  assert.deepEqual(p.navNodes.map((n) => n.id), ['n1', 'n2']);
  assert.deepEqual(p.navEdges.map((e) => e.id), ['e1']);
  const s = g.getCampusDataStats();
  assert.ok(s.full.jsonBytes > s.public.jsonBytes);
});

test('settings: status booleans, key reaches config, never the status; Config sheet fallback', () => {
  assert.throws(() => g.setMapsApiKey('000000', 'AIzaFAKEFAKEFAKEFAKEFAKE12345'), /Invalid admin PIN/);
  assert.throws(() => g.setMapsApiKey(PIN(), 'bad key!'), /does not look like/);
  const st = g.setMapsApiKey(PIN(), 'AIzaFAKEFAKEFAKEFAKEFAKE12345');
  assert.deepEqual(st, { mapsApiKeyConfigured: true, mapsApiKeySource: 'scriptProperty', adminPinConfigured: true });
  assert.ok(!JSON.stringify(g.getSettingsStatus()).includes('AIza'));
  assert.ok(g.getAllCampusData().config.some((c) => c.key === 'mapsApiKey' && c.value === 'AIzaFAKEFAKEFAKEFAKEFAKE12345'));
  g.setMapsApiKey(PIN(), '');
  assert.equal(g.getSettingsStatus().mapsApiKeyConfigured, false);

  R.ss().getSheetByName('Config').appendRow(['mapsApiKey', 'AIzaSHEETSHEETSHEETSHEET999']);
  assert.equal(g.getSettingsStatus().mapsApiKeySource, 'configSheet');
  g.setMapsApiKey(PIN(), 'AIzaPROPPROPPROPPROPPROP1234');
  const cfg = g.getAllCampusData().config.filter((c) => c.key === 'mapsApiKey');
  assert.equal(cfg.length, 1);
  assert.equal(cfg[0].value, 'AIzaPROPPROPPROPPROPPROP1234');
});

test('getSettingsStatus field names are the ones the admin Settings tab reads first', () => {
  const admin = readFileSync(join(SRC, 'Admin.html'), 'utf8');
  const st = g.getSettingsStatus();
  for (const name of ['mapsApiKeyConfigured', 'adminPinConfigured']) {
    assert.equal(typeof st[name], 'boolean', name);
    assert.ok(admin.includes(`['${name}'`), `Admin.html reads ${name}`);
  }
});

test('changeAdminPin follows the admin page rule (6 to 20 characters, no spaces); result has no PIN', () => {
  const old = PIN();
  assert.throws(() => g.changeAdminPin(old, '12345'), /6 to 20 characters/);
  assert.throws(() => g.changeAdminPin(old, 'abc 12345'), /no spaces/);
  assert.throws(() => g.changeAdminPin(old, 'x'.repeat(21)), /6 to 20 characters/);
  assert.deepEqual(g.changeAdminPin(old, 'racer-2468'), { changed: true });
  assert.equal(g.verifyAdminPin(old), false);
  assert.equal(g.verifyAdminPin('racer-2468'), true);
  assert.deepEqual(g.changeAdminPin('racer-2468', '24681357'), { changed: true });
});

test('PIN lockout after 10 failures', () => {
  for (let i = 0; i < 10; i++) g.verifyAdminPin('nope');
  assert.throws(() => g.verifyAdminPin(PIN()), /Too many failed/);
  delete R.cache.adminPinFailures;
  assert.equal(g.verifyAdminPin(PIN()), true);
});

test('CRUD: rooms merge on update and keep text numbers', () => {
  const { id } = g.saveRoom({ pin: PIN(), floorId: 'floor-it-1', number: '0150', label: '150', polygon: [[1, 2], [3, 4]], centerX: 0, centerY: 0 });
  g.updateRoom({ pin: PIN(), id, label: '150 Lab' });
  const r = g.getAllCampusData().rooms.find((x) => x.id === id);
  assert.deepEqual([r.number, r.label, r.centerX, r.searchable], ['0150', '150 Lab', 0, true]);
  assert.deepEqual(r.polygon, [[1, 2], [3, 4]]);
  g.updateRoom({ pin: PIN(), id, searchable: false });
  assert.equal(g.getAllCampusData().rooms.find((x) => x.id === id).searchable, false);
  assert.deepEqual(g.deleteRoom({ pin: PIN(), id }), { deleted: true });
});

test('CRUD: floors, buildings, entrances, nav nodes/edges (updateNavEdge as the admin calls it), cascade delete, QR', () => {
  const f = g.saveFloor({ pin: PIN(), buildingId: 'bld-ep', level: 1, label: '1st', planAsset: 'FP_floor_ep_1', public: true, id: 'floor-ep-1' });
  assert.equal(f.id, 'floor-ep-1');
  assert.throws(() => g.saveFloor({ pin: PIN(), buildingId: 'bld-ep', level: 1, label: 'x', id: 'floor-ep-1' }), /already exists/);
  g.updateFloor({ pin: PIN(), id: 'floor-ep-1', public: false });
  assert.equal(g.getAllCampusData().floors.find((x) => x.id === 'floor-ep-1').public, false);
  g.updateBuildingEntrances({ pin: PIN(), id: 'bld-it', entrances: [{ lat: 1, lng: 2 }] });
  const it = g.getAllCampusData().buildings.find((b) => b.id === 'bld-it');
  assert.deepEqual(it.entrances, [{ lat: 1, lng: 2 }]);
  assert.equal(it.number, '0135');
  const b = g.saveBuilding({ pin: PIN(), name: 'New Hall', code: 'NH', number: '0999' });
  assert.equal(g.getAllCampusData().buildings.find((x) => x.id === b.id).number, '0999');
  const nodes = g.saveBatchNavNodes({ pin: PIN(), floorId: 'floor-ep-1', nodes: [{ x: 0, y: 0 }, { x: 5, y: 5, type: 'door' }] });
  assert.equal(nodes.count, 2);
  const e = g.saveNavEdge({ pin: PIN(), fromNodeId: nodes.ids[0], toNodeId: nodes.ids[1], distance: 2 });
  // The admin edge editor's call (Admin.html saveNavEdgeEdit): every field plus the pin.
  g.updateNavEdge({ pin: PIN(), id: e.id, fromNodeId: nodes.ids[0], toNodeId: nodes.ids[1], distance: 2, floorChange: false, accessible: false });
  const edge = g.getAllCampusData().navEdges.find((x) => x.id === e.id);
  assert.deepEqual([edge.accessible, edge.floorChange, edge.distance], [false, false, 2]);
  g.updateNavNode({ pin: PIN(), id: nodes.ids[0], x: 0 });
  assert.equal(g.getAllCampusData().navNodes.find((x) => x.id === nodes.ids[0]).type, 'waypoint');
  assert.deepEqual(g.deleteNavNode({ pin: PIN(), id: nodes.ids[0] }), { deleted: true, edgesRemoved: 1 });
  const qr = g.saveQrLocation({ pin: PIN(), buildingId: 'bld-it', nodeId: 'n1', description: 'Lobby', permanent: true });
  const q = g.getAllCampusData().qrLocations.find((x) => x.id === qr.id);
  assert.equal(q.permanent, true);
  assert.equal(typeof q.createdDate, 'string');
});

test('importFloorData replaces one floor, keeps the others, drops edges whose ends are gone', () => {
  const before = g.getAllCampusData();
  const res = g.importFloorData(PIN(), JSON.stringify({
    floorId: 'floor-it-1',
    floor: { buildingId: 'bld-it', level: 1, label: 'First Floor', planAsset: 'FP_floor_it_1', widthPx: 4800, heightPx: 3300, metersPerPixel: 0.0254, public: true },
    rooms: [{ id: 'room-it-1-0101', number: '0101', label: '101 Lobby', type: 'other', polygon: [[0, 0], [5, 0], [5, 5]], centerX: 2, centerY: 2, searchable: true, area: 123 }],
    navNodes: [{ id: 'm1', x: 1, y: 1, type: 'stair', linkId: 'it-stair-1' }, { id: 'm2', x: 2, y: 2, type: 'room', roomId: 'room-it-1-0101' }],
    navEdges: [{ id: 'f1', fromNodeId: 'm1', toNodeId: 'm2', distance: 1.4, floorChange: false, accessible: true },
      { id: 'f2', fromNodeId: 'm1', toNodeId: 'n3', distance: 4, floorChange: true, accessible: false }],
  }));
  assert.deepEqual(res.written, { rooms: 1, navNodes: 2, navEdges: 2 });
  assert.deepEqual(res.removed, { rooms: 2, navNodes: 2, navEdges: 2 });
  assert.equal(res.danglingEdges, 0);
  assert.equal(res.crossFloorEdgesKept, 0);
  assert.equal(res.floorUpserted, true);
  const after = g.getAllCampusData();
  assert.equal(after.floors.find((f) => f.id === 'floor-it-1').widthPx, 4800);
  assert.deepEqual(after.rooms.filter((r) => r.floorId === 'floor-it-1').map((r) => r.number), ['0101']);
  assert.ok(after.rooms.some((r) => r.id === 'room-it-3-0301'), 'other floor rooms lost');
  assert.deepEqual(after.navEdges.map((e) => e.id).sort(), ['f1', 'f2']);
  assert.ok(Number(after.version) > Number(before.version));
  assert.throws(() => g.importFloorData(PIN(), { floorId: 'floor-it-1', rooms: [{ id: 'x', floorId: 'floor-ep-1', number: '1' }] }), /belongs to/);
  assert.throws(() => g.importFloorData('bad', { floorId: 'floor-it-1' }), /Invalid admin PIN/);
});

test('importFloorData keeps a cross-floor edge whose ends survive the import', () => {
  // f2 (m1 on floor-it-1 -> n3 on floor-it-3) exists from the previous test; re-import floor-it-1 with m1 kept.
  const res = g.importFloorData(PIN(), {
    floorId: 'floor-it-1',
    nav: { nodes: [{ id: 'm1', x: 1, y: 1, type: 'stair', linkId: 'it-stair-1' }], edges: [] },
  });
  assert.equal(res.crossFloorEdgesKept, 1);
  assert.deepEqual(g.getAllCampusData().navEdges.map((e) => e.id), ['f2']);
});

test('reseedCampusData restores the seed', () => {
  const res = g.reseedCampusData({ pin: PIN() });
  assert.deepEqual(res.seeded, { Buildings: BUILDINGS, Floors: 2, Rooms: 3, NavNodes: 3, NavEdges: 2 });
  const a = g.getAllCampusData();
  assert.equal(a.buildings.length, BUILDINGS);
  assert.equal(a.rooms.find((r) => r.id === 'room-it-1-0141').number, '0141');
});

test('getFloorPlanSvg errors clearly; include() validates; doGet serves both pages as templates', () => {
  assert.throws(() => g.getFloorPlanSvg('floor-it-9'), /FP_floor_it_9 not found for floor floor-it-9/);
  assert.throws(() => g.getFloorPlanSvg('../x'), /floorId is required/);
  assert.equal(doGetJson(R, { action: 'getFloorPlanSvg', floorId: 'floor-it-9' }).ok, false);
  assert.ok(g.include('WebApp').length > 1000);
  assert.throws(() => g.include('../x'), /invalid/);
  const web = R.ctx.doGet({ parameter: {} });
  assert.equal(web.file, 'WebApp');
  assert.equal(web.metaTags.viewport, 'width=device-width, initial-scale=1, viewport-fit=cover');
  const admin = R.ctx.doGet({ parameter: { action: 'admin' } });
  assert.equal(admin.file, 'Admin');
  assert.equal(admin.metaTags.viewport, 'width=device-width, initial-scale=1');
});

test('seed validation rejects wrong-width generated rows before writing', () => {
  const R2 = makeRuntime(SRC, GEN + "\nfunction getGeneratedRoomsSeed(){ return [['r','floor-it-1','1','1']]; }");
  assert.throws(() => R2.ctx.initSystem(), /Rooms row 1 has 4 columns/);
});

test('an empty generated seed: init seeds Buildings only', () => {
  const empty = 'function getGeneratedFloorsSeed(){return [];} function getGeneratedRoomsSeed(){return [];}' +
    ' function getGeneratedNavNodesSeed(){return [];} function getGeneratedNavEdgesSeed(){return [];}';
  const r = js(makeRuntime(SRC, empty).ctx.initSystem());
  assert.equal(r.floorSeedSource, 'placeholder-empty');
  assert.deepEqual(r.seeded, { Buildings: BUILDINGS, Floors: 0, Rooms: 0, NavNodes: 0, NavEdges: 0 });
});

test('private helpers stay private; no Drive access; the manifest asks for Sheets only', () => {
  const src = R.files.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');
  const pub = [...src.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]).filter((n) => !n.endsWith('_'));
  assert.ok(!pub.some((n) => /^_/.test(n)), 'leading-underscore helper still public');
  assert.throws(() => R.run('ensureAdminPin_', []), /Script function not found/);
  assert.ok(!/DriveApp|UrlFetchApp/.test(src), 'Drive or UrlFetch use needs its OAuth scope back in appsscript.json');
  const manifest = JSON.parse(readFileSync(join(SRC, 'appsscript.json'), 'utf8'));
  assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets']);
});

// ---------------------------------------------------------------------------------------------
// Part 2: the real generated seed and the pipeline's per-floor JSON
// ---------------------------------------------------------------------------------------------

const floorFiles = readdirSync(FLOORPLANS).filter((f) => /^floor-.*\.json$/.test(f)).sort();
const floorsJson = floorFiles.map((f) => JSON.parse(readFileSync(join(FLOORPLANS, f), 'utf8')));
const crossFloor = JSON.parse(readFileSync(join(FLOORPLANS, 'cross-floor-edges.json'), 'utf8'));
const sum = (fn) => floorsJson.reduce((n, f) => n + fn(f), 0);

const REAL = makeRuntime(SRC);
const realInit = js(REAL.ctx.initSystem());
REAL.props.ADMIN_PIN = 'real-test-pin';

test('real seed: init writes every generated floor, room, node and edge (pipeline totals)', () => {
  assert.equal(realInit.floorSeedSource, 'generated');
  assert.deepEqual(realInit.seeded, {
    Buildings: BUILDINGS,
    Floors: floorsJson.length,
    Rooms: sum((f) => f.rooms.length),
    NavNodes: sum((f) => f.nav.nodes.length),
    NavEdges: sum((f) => f.nav.edges.length) + crossFloor.length,
  });
  assert.deepEqual(realInit.seeded, { Buildings: 89, Floors: 6, Rooms: 491, NavNodes: 1825, NavEdges: 1945 });
});

test('real seed: the largest cell is far under the Sheets limit, and the runtime enforces the limit', () => {
  let max = 0;
  let where = '';
  for (const sheet of REAL.ss().sheets) {
    for (const row of sheet.rows) {
      for (const v of row || []) if (typeof v === 'string' && v.length > max) { max = v.length; where = sheet.name + ' ' + row[0]; }
    }
  }
  assert.ok(max < CELL_LIMIT / 10, `largest cell ${max} chars (${where})`);
  // Positive control: the stand-in refuses an oversize cell the way Sheets does.
  assert.throws(() => REAL.ss().getSheetByName('Config').appendRow(['big', 'x'.repeat(CELL_LIMIT + 1)]), /maximum of 50000/);
});

test('real seed: the public payload drops only the mezzanine and the penthouse', () => {
  const all = REAL.run('getAllCampusData', []);
  const pub = REAL.run('getPublicCampusData', []);
  assert.deepEqual(all.floors.filter((f) => f.public === false).map((f) => f.id).sort(), ['floor-ep-3', 'floor-it-3']);
  assert.deepEqual(pub.floors.map((f) => f.id).sort(), ['floor-ep-1', 'floor-ep-2', 'floor-it-1', 'floor-it-2']);
  const stats = REAL.run('getCampusDataStats', []);
  // Measured 2026-10-03: 620,517 vs 612,283 bytes (1.3 %). Not material, so the web app keeps
  // MSCN_DATA_FN = 'getAllCampusData' and filters hidden floors itself.
  assert.ok(stats.public.jsonBytes < stats.full.jsonBytes);
  assert.ok(stats.public.jsonBytes > stats.full.jsonBytes * 0.95);
  const core = readFileSync(join(SRC, 'WebApp_Core.html'), 'utf8');
  assert.match(core, /var MSCN_DATA_FN = 'getAllCampusData';/);
});

function floorSnapshot(data, floorId) {
  const nodeIds = new Set(data.navNodes.filter((n) => n.floorId === floorId).map((n) => n.id));
  const sortById = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    rooms: data.rooms.filter((r) => r.floorId === floorId).sort(sortById),
    navNodes: data.navNodes.filter((n) => n.floorId === floorId).sort(sortById),
    navEdges: data.navEdges.filter((e) => nodeIds.has(e.fromNodeId) || nodeIds.has(e.toNodeId)).sort(sortById),
    floor: data.floors.find((f) => f.id === floorId),
  };
}

test('real import: the pipeline file data/floorplans/floor-it-1.json imports as written and round-trips', () => {
  const before = floorSnapshot(REAL.run('getAllCampusData', []), 'floor-it-1');
  const file = JSON.parse(readFileSync(join(FLOORPLANS, 'floor-it-1.json'), 'utf8'));
  const crossIt1 = crossFloor.filter((e) => before.navNodes.some((n) => n.id === e.from || n.id === e.to)).length;
  assert.equal(crossIt1, 4);

  const res = REAL.run('importFloorData', ['real-test-pin', JSON.stringify(file)]);
  assert.deepEqual(res.written, { rooms: file.rooms.length, navNodes: file.nav.nodes.length, navEdges: file.nav.edges.length });
  assert.equal(res.crossFloorEdgesKept, crossIt1, 'stair and elevator links to floor 2 survive');
  assert.equal(res.danglingEdges, 0);

  const after = floorSnapshot(REAL.run('getAllCampusData', []), 'floor-it-1');
  assert.deepEqual(after.rooms, before.rooms, 'rooms identical to the seeded rows (center [x,y] mapped to centerX/centerY)');
  assert.deepEqual(after.navNodes, before.navNodes);
  assert.deepEqual(after.navEdges, before.navEdges, 'edges identical (from/to mapped to fromNodeId/toNodeId)');
});

test('real import: the payload the admin Import tab builds from that file (floor row from its top level)', () => {
  const file = JSON.parse(readFileSync(join(FLOORPLANS, 'floor-ep-2.json'), 'utf8'));
  const before = floorSnapshot(REAL.run('getAllCampusData', []), 'floor-ep-2');
  const floor = {};
  for (const k of ['buildingId', 'level', 'label', 'planAsset', 'widthPx', 'heightPx', 'metersPerPixel', 'public']) floor[k] = file[k];
  const payload = { floorId: file.floorId, rooms: file.rooms, navNodes: file.nav.nodes, navEdges: file.nav.edges, floor };
  const res = REAL.run('importFloorData', ['real-test-pin', payload]);
  assert.equal(res.floorUpserted, true);
  assert.equal(res.crossFloorEdgesKept, 6, 'EP 2 links down to EP 1 (4) and up to the penthouse (2)');
  const after = floorSnapshot(REAL.run('getAllCampusData', []), 'floor-ep-2');
  assert.deepEqual(after, before);
});

test('admin Import tab reads the pipeline file\'s nav.nodes / nav.edges', () => {
  const admin = readFileSync(join(SRC, 'Admin.html'), 'utf8');
  assert.match(admin, /var graph = parsed\.graph \|\| parsed\.nav \|\| \{\};/);
  assert.match(admin, /runServer\('reseedCampusData', \[\{ pin: adminPin \}\]/);
});
