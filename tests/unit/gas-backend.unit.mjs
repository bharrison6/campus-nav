// Backend (.gs) tests in the Apps Script runtime stand-in (dev/gas-runtime.cjs). Since v3 the backend runs only
// locally (build-time export, local admin): no PIN, no settings writes, no floor import or reseed.
// Part 1 runs on a tiny synthetic floor seed (defined after the real files, so it overrides
// SeedFloorData.gs) to check contract shapes and admin operations by hand-countable numbers.
// Part 2 runs on the real generated SeedFloorData.gs and data/floorplans/*.json (public floors only: the hidden
// floors are never in the repository), plus a synthetic private seed (tests/unit/fixtures/private) for the hidden-floor
// paths.
// Adopted from lane B's mock-runtime suite (2026-10-03).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const FLOORPLANS = join(ROOT, 'data', 'floorplans');
const require = createRequire(import.meta.url);
const { makeRuntime, CELL_LIMIT, GS_DIR: SRC } = require('../../dev/gas-runtime.cjs');
// The synthetic private location: SeedFloorDataPrivate.gs and FP_floor_it_9.html for a made-up hidden floor.
const PRIVATE_GS = join(here, 'fixtures', 'private', 'gs');

const GEN = `
function getGeneratedFloorsSeed() { return [
  ['floor-it-1','bld-it',1,'1st Floor','FP_floor_it_1',5000,3350,0.0254,true],
  ['floor-it-3','bld-it',3,'Mezzanine','FP_floor_it_3',5000,3350,0.0254,false]
]; }
function getGeneratedRoomsSeed() { return [
  ['room-it-1-0141','floor-it-1','0141','141 Office','office','[[0,0],[10,0],[10,10]]',5,5,true,''],
  ['room-it-1-0140B','floor-it-1','0140B','140B','storage',[[0,0],[1,1],[2,0]],1,1,false,''],
  ['room-it-3-0301','floor-it-3','0301','301','mechanical','',1,1,false,'']
]; }
function getGeneratedNavNodesSeed() { return [
  ['n1','floor-it-1',0,0,'stair','','it-stair-1',''],
  ['n2','floor-it-1',10,0,'room','room-it-1-0141','',''],
  ['n3','floor-it-3',0,0,'stair','','it-stair-1','']
]; }
function getGeneratedNavEdgesSeed() { return [
  ['e1','n1','n2',3.2,false,true],
  ['e2','n1','n3',4,true,false]
]; }`;

const BUILDINGS = 89;

// google.script.run returns JSON-shaped values; compare in that shape.
const js = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------------------------------------
// Part 1: synthetic seed
// ---------------------------------------------------------------------------------------------

const R = makeRuntime(SRC, GEN);
const g = new Proxy(R.ctx, {
  get: (o, k) => (typeof o[k] === 'function' ? (...a) => js(o[k](...a)) : o[k]),
});

test('uninitialized data calls name initSystem', () => {
  assert.throws(() => R.ctx.getAllCampusData(), /initSystem\(\)/);
});

test('initSystem creates and seeds; idempotent; no PIN or settings any more', () => {
  const init = g.initSystem();
  assert.equal(init.created, true);
  assert.deepEqual(init.seeded, { Buildings: BUILDINGS, Floors: 2, Rooms: 3, NavNodes: 3, NavEdges: 2 });
  assert.equal(init.counts.Config, 3, 'dataVersion, routing.altFactor and routing.altDoorCost');
  assert.deepEqual(init.schemaMismatch, []);
  assert.equal(init.floorSeedSource, 'generated');
  assert.equal(init.settings, undefined);
  assert.deepEqual(Object.keys(R.props), ['SHEET_ID'], 'no ADMIN_PIN is generated');
  assert.ok(!R.ss().getSheetByName('Sheet1'), 'Sheet1 not removed');

  const again = g.initSystem();
  assert.equal(again.created, false);
  assert.equal(again.seeded.Buildings, 'kept');
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
  assert.deepEqual(Object.keys(it), ['id', 'name', 'code', 'number', 'lat', 'lng', 'entrances', 'photoUrl', 'hasIndoor', 'levels', 'height']);
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

test('a Maps key held as a Script Property (as the local admin sets from MSCN_MAPS_API_KEY) reaches getAllCampusData', () => {
  R.props.mapsApiKey = 'test-only-maps-key';
  const cfg = g.getAllCampusData().config.filter((c) => c.key === 'mapsApiKey');
  assert.deepEqual(cfg, [{ key: 'mapsApiKey', value: 'test-only-maps-key' }]);
  delete R.props.mapsApiKey;
  assert.ok(!g.getAllCampusData().config.some((c) => c.key === 'mapsApiKey'));
});
test('CRUD: rooms merge on update and keep text numbers', () => {
  const { id } = g.saveRoom({ floorId: 'floor-it-1', number: '0150', label: '150', polygon: [[1, 2], [3, 4], [1, 4]], centerX: 0, centerY: 0 });
  g.updateRoom({ id, label: '150 Lab' });
  const r = g.getAllCampusData().rooms.find((x) => x.id === id);
  assert.deepEqual([r.number, r.label, r.centerX, r.searchable], ['0150', '150 Lab', 0, true]);
  assert.deepEqual(r.polygon, [[1, 2], [3, 4], [1, 4]]);
  g.updateRoom({ id, searchable: false });
  assert.equal(g.getAllCampusData().rooms.find((x) => x.id === id).searchable, false);
  assert.deepEqual(g.deleteRoom({ id }), { deleted: true });
});

test('CRUD: floors, buildings, entrances, nav nodes/edges (updateNavEdge as the admin calls it), cascade delete, QR', () => {
  const f = g.saveFloor({ buildingId: 'bld-ep', level: 1, label: '1st', planAsset: 'FP_floor_ep_1', public: true, id: 'floor-ep-1' });
  assert.equal(f.id, 'floor-ep-1');
  assert.throws(() => g.saveFloor({ buildingId: 'bld-ep', level: 1, label: 'x', id: 'floor-ep-1' }), /already exists/);
  g.updateFloor({ id: 'floor-ep-1', public: false });
  assert.equal(g.getAllCampusData().floors.find((x) => x.id === 'floor-ep-1').public, false);
  g.updateBuildingEntrances({ id: 'bld-it', entrances: [{ lat: 1, lng: 2 }] });
  const it = g.getAllCampusData().buildings.find((b) => b.id === 'bld-it');
  assert.deepEqual(it.entrances, [{ lat: 1, lng: 2 }]);
  assert.equal(it.number, '0135');
  const b = g.saveBuilding({ name: 'New Hall', code: 'NH', number: '0999' });
  assert.equal(g.getAllCampusData().buildings.find((x) => x.id === b.id).number, '0999');
  const nodes = g.saveBatchNavNodes({ floorId: 'floor-ep-1', nodes: [{ x: 0, y: 0 }, { x: 5, y: 5, type: 'door' }] });
  assert.equal(nodes.count, 2);
  const e = g.saveNavEdge({ fromNodeId: nodes.ids[0], toNodeId: nodes.ids[1], distance: 2 });
  // The admin edge editor's call (Admin.html saveNavEdgeEdit): every field.
  g.updateNavEdge({ id: e.id, fromNodeId: nodes.ids[0], toNodeId: nodes.ids[1], distance: 2, floorChange: false, accessible: false });
  const edge = g.getAllCampusData().navEdges.find((x) => x.id === e.id);
  assert.deepEqual([edge.accessible, edge.floorChange, edge.distance], [false, false, 2]);
  g.updateNavNode({ id: nodes.ids[0], x: 0 });
  assert.equal(g.getAllCampusData().navNodes.find((x) => x.id === nodes.ids[0]).type, 'waypoint');
  assert.deepEqual(g.deleteNavNode({ id: nodes.ids[0] }), { deleted: true, edgesRemoved: 1 });
  const qr = g.saveQrLocation({ buildingId: 'bld-it', nodeId: 'n1', description: 'Lobby', permanent: true });
  const q = g.getAllCampusData().qrLocations.find((x) => x.id === qr.id);
  assert.equal(q.permanent, true);
  assert.equal(typeof q.createdDate, 'string');
});

test('getFloorPlanSvg errors clearly', () => {
  assert.throws(() => g.getFloorPlanSvg('floor-it-9'), /FP_floor_it_9 not found for floor floor-it-9/);
  assert.throws(() => g.getFloorPlanSvg('../x'), /floorId is required/);
  // A plan asset in a further folder (the private location's gs/) is found after the backend's own.
  const R3 = makeRuntime(SRC, '', { gsDirs: [PRIVATE_GS], htmlDirs: [PRIVATE_GS] });
  assert.ok(R3.run('getFloorPlanSvg', ['floor-it-9']).includes('data-floor-id="floor-it-9"'));
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

test('private helpers stay private; no Drive access; no PIN or settings machinery left', () => {
  const src = R.files.map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');
  const pub = [...src.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]).filter((n) => !n.endsWith('_'));
  assert.ok(!pub.some((n) => /^_/.test(n)), 'leading-underscore helper still public');
  assert.throws(() => R.run('adminOp_', []), /Script function not found/);
  assert.ok(!/DriveApp|UrlFetchApp/.test(src), 'Drive or UrlFetch use needs its OAuth scope back in appsscript.json');
  assert.ok(!/ADMIN_PIN|verifyAdminPin|requirePin_|setMapsApiKey|changeAdminPin|importFloorData|reseedCampusData/.test(src));
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

test('real seed: init writes every generated floor, room, node and edge (pipeline totals)', () => {
  assert.equal(realInit.floorSeedSource, 'generated');
  assert.deepEqual(realInit.seeded, {
    Buildings: BUILDINGS,
    Floors: floorsJson.length,
    Rooms: sum((f) => f.rooms.length),
    NavNodes: sum((f) => f.nav.nodes.length),
    NavEdges: sum((f) => f.nav.edges.length) + crossFloor.length,
  });
  assert.deepEqual(realInit.seeded, { Buildings: 89, Floors: 4, Rooms: 486, NavNodes: 1820, NavEdges: 1940 });
  // The committed data holds no hidden floor: those live in the private location, outside the repository.
  assert.deepEqual(floorsJson.filter((f) => f.public === false).map((f) => f.floorId), []);
});

test('a private seed (the hidden floors) is appended to the generated rows when its folder is loaded', () => {
  const P = makeRuntime(SRC, '', { gsDirs: [PRIVATE_GS], htmlDirs: [PRIVATE_GS] });
  const seeded = js(P.ctx.initSystem()).seeded;
  assert.deepEqual(seeded, { ...realInit.seeded, Floors: realInit.seeded.Floors + 1, Rooms: realInit.seeded.Rooms + 2, NavNodes: realInit.seeded.NavNodes + 3, NavEdges: realInit.seeded.NavEdges + 3 });
  const all = P.run('getAllCampusData', []);
  assert.deepEqual(all.floors.filter((f) => f.public === false).map((f) => f.id), ['floor-it-9']);
  assert.equal(all.navEdges.find((e) => e.id === 'it-x901').fromNodeId, 'it-2-n0064');
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

test('real seed with a private seed: the public payload drops only the hidden floor and what touches it', () => {
  const P = makeRuntime(SRC, '', { gsDirs: [PRIVATE_GS], htmlDirs: [PRIVATE_GS] });
  P.ctx.initSystem();
  const all = P.run('getAllCampusData', []);
  const pub = P.run('getPublicCampusData', []);
  assert.deepEqual(all.floors.filter((f) => f.public === false).map((f) => f.id), ['floor-it-9']);
  assert.deepEqual(pub.floors.map((f) => f.id).sort(), ['floor-ep-1', 'floor-ep-2', 'floor-it-1', 'floor-it-2']);
  const bare = makeRuntime(SRC);
  bare.ctx.initSystem();
  assert.deepEqual(pub, bare.run('getPublicCampusData', []), 'the same public payload as without the private seed');
  const stats = P.run('getCampusDataStats', []);
  // Measured 2026-10-03: 620,517 vs 612,283 bytes (1.3 %). Not material, so the exported campus.json is the full
  // getAllCampusData payload and the web app filters hidden floors itself.
  assert.ok(stats.public.jsonBytes < stats.full.jsonBytes);
  assert.ok(stats.public.jsonBytes > stats.full.jsonBytes * 0.95);
});
