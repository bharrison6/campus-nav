// The build-time export (scripts/data/export-campus-data.mjs) on the real seed and pipeline data, with and without
// overrides: the published shape, determinism, the overrides report, and that no key ever reaches the output.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FLOORPLANS_DIR, GEOREF_DIR, buildExport, exportCampusData, isPublicFloor } from '../../scripts/data/export-campus-data.mjs';
import { addCampusGeo, readEntranceFacing, readGeoref } from '../../scripts/data/campus-geo.mjs';
import { applyAccess, publishAltDoorCost, publishAltFactor } from '../../scripts/data/access.mjs';
import { OVERRIDES_DIR, openCampus } from '../../scripts/data/campus-engine.mjs';
import { COLLECTIONS } from '../../scripts/data/overrides.mjs';

const require = createRequire(import.meta.url);
const { makeRuntime } = require('../../dev/gas-runtime.cjs');
// The real hidden floors are never in the repository (the local admin reads them from the private location outside
// it). The hidden-floor filter is checked on a synthetic private location: one made-up hidden floor, floor-it-9,
// wired to the real IT stair by a cross-floor edge.
const PRIVATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'private');

// Scratch folders under the OS temp dir, removed when the file's tests end (only what this run created).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-export-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (files = {}) => {
  const d = path.join(tmp, `d${++n}`);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, recs] of Object.entries(files)) fs.writeFileSync(path.join(d, `${name}.json`), JSON.stringify(recs));
  return d;
};
const EMPTY = dir();

// The v2 backend's own answer, no overrides layer involved.
const plain = makeRuntime();
plain.ctx.initSystem();
const reference = plain.run('getPublicCampusData', []); // what the site publishes
const withPrivate = makeRuntime(undefined, '', { gsDirs: [path.join(PRIVATE, 'gs')], htmlDirs: [path.join(PRIVATE, 'gs')] });
withPrivate.ctx.initSystem();
const full = withPrivate.run('getAllCampusData', []); // what the local admin sees, hidden floors included
// Only public floors are published.
const PUBLIC_FLOORS = full.floors.filter(isPublicFloor).map((f) => f.id);
const HIDDEN_FLOORS = full.floors.filter((f) => !isPublicFloor(f)).map((f) => f.id);

const withoutVersion = (c) => ({ ...c, version: '', config: c.config.map((r) => (r.key === 'dataVersion' ? { ...r, value: '' } : r)) });
// What the site publishes since v4: getPublicCampusData plus the map fields (scripts/data/campus-geo.mjs), and since
// v5 the access classes (scripts/data/access.mjs) and numeric routing.altFactor and routing.altDoorCost.
const referenceGeo = JSON.parse(JSON.stringify(reference));
publishAltFactor(referenceGeo);
publishAltDoorCost(referenceGeo);
applyAccess(referenceGeo);
addCampusGeo(referenceGeo, readGeoref(GEOREF_DIR), readEntranceFacing(FLOORPLANS_DIR));
/**
 * campus.json with the map and access fields taken out again: entrance lat/lng, derived entrances,
 * levels/height, access (and what applyAccess retypes), the numeric routing values.
 */
function withoutGeo(c, ref) {
  const refB = new Map(ref.buildings.map((b) => [b.id, b]));
  const refN = new Map(ref.navNodes.map((n) => [n.id, n]));
  const refR = new Map(ref.rooms.map((r) => [r.id, r]));
  const refC = new Map(ref.config.map((r) => [r.key, r]));
  return {
    ...c,
    config: c.config.map((r) => ({ ...r, value: refC.get(r.key).value })),
    buildings: c.buildings.map((b) => {
      const { levels, height, entrances, ...rest } = b;
      const r = refB.get(b.id);
      return { ...rest, entrances: r.entrances, levels: r.levels, height: r.height };
    }),
    rooms: c.rooms.map((x) => {
      const { access, searchable, ...rest } = x;
      const r = refR.get(x.id);
      return { ...rest, searchable: r.searchable, access: r.access };
    }),
    navNodes: c.navNodes.map((n) => {
      const { lat, lng, access, type, ...rest } = n;
      const r = refN.get(n.id);
      return { ...rest, type: r.type, access: r.access };
    }),
  };
}

test('the committed overrides files are the eight collections, each a JSON array', () => {
  for (const c of Object.keys(COLLECTIONS)) {
    const recs = JSON.parse(fs.readFileSync(path.join(OVERRIDES_DIR, `${c}.json`), 'utf8'));
    assert.ok(Array.isArray(recs), c);
  }
});

test('no overrides: campus.json is what getPublicCampusData returns plus the map fields (only version differs); the diff is empty', () => {
  const x = buildExport({ overridesDir: EMPTY });
  assert.deepEqual(Object.keys(x.campus), ['contractVersion', 'version', 'config', 'buildings', 'floors', 'rooms', 'navNodes', 'navEdges', 'photos', 'qrLocations']);
  assert.deepEqual(withoutVersion(x.campus), withoutVersion(referenceGeo));
  // ...and nothing else changed: without the documented map fields it is getPublicCampusData exactly.
  assert.deepEqual(withoutVersion(withoutGeo(x.campus, reference)), withoutVersion(reference));
  assert.match(x.version, /^[0-9a-f]{12}$/);
  assert.equal(x.campus.version, x.version);
  assert.deepEqual(x.campus.config, [{ key: 'dataVersion', value: x.version }, { key: 'routing.altFactor', value: 3 }, { key: 'routing.altDoorCost', value: 300 }]);
  assert.deepEqual(x.floors.map((f) => f.id), PUBLIC_FLOORS);
  assert.deepEqual(x.missingPlans, []);
  const engine = openCampus({ overridesDir: EMPTY });
  for (const [c, recs] of Object.entries(engine.diff())) assert.deepEqual(recs, [], c);
});

test('deterministic: the same inputs give byte-identical files (version.json too, with SOURCE_DATE_EPOCH)', () => {
  const env = { SOURCE_DATE_EPOCH: '1759572000', GITHUB_SHA: 'abc123' };
  const a = dir();
  const b = dir();
  const ra = exportCampusData({ outDir: a, overridesDir: EMPTY, env });
  const rb = exportCampusData({ outDir: b, overridesDir: EMPTY, env });
  assert.deepEqual(ra.files, rb.files);
  assert.equal(ra.files.length, 2 + PUBLIC_FLOORS.length);
  for (const f of ra.files) assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), f);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, 'version.json'), 'utf8')),
    { version: ra.version, builtAt: '2025-10-04T10:00:00.000Z', gitSha: 'abc123' });
  assert.equal(fs.readFileSync(path.join(a, 'floors', 'floor-it-1.svg'), 'utf8'), plain.run('getFloorPlanSvg', ['floor-it-1']));
});

test('hidden floors are not published: no floor, room, node, edge, photo, QR location or plan of theirs', () => {
  assert.deepEqual(PUBLIC_FLOORS, ['floor-it-1', 'floor-it-2', 'floor-ep-1', 'floor-ep-2']);
  assert.deepEqual(HIDDEN_FLOORS, ['floor-it-9']);
  const hidden = new Set(HIDDEN_FLOORS);
  // Positive controls: the full data the admin sees does carry hidden-floor records and edges into them.
  const fullHiddenNodes = new Set(full.navNodes.filter((n) => hidden.has(n.floorId)).map((n) => n.id));
  assert.ok(full.rooms.some((r) => hidden.has(r.floorId)), 'full data has rooms on hidden floors');
  assert.ok(fullHiddenNodes.size > 0, 'full data has nodes on hidden floors');
  assert.ok(full.navEdges.some((e) => fullHiddenNodes.has(e.fromNodeId) !== fullHiddenNodes.has(e.toNodeId)),
    'full data has cross-floor edges from a public floor into a hidden one');

  const out = dir();
  exportCampusData({ outDir: out, overridesDir: EMPTY, privateDir: PRIVATE });
  assert.deepEqual(fs.readdirSync(path.join(out, 'floors')).sort(), PUBLIC_FLOORS.map((id) => `${id}.svg`).sort());
  // The same files as an export that never saw the hidden floor (the build's own case).
  const bare = dir();
  const env = { SOURCE_DATE_EPOCH: '1759572000', GITHUB_SHA: 'abc123' };
  exportCampusData({ outDir: out, overridesDir: EMPTY, privateDir: PRIVATE, env });
  exportCampusData({ outDir: bare, overridesDir: EMPTY, env });
  for (const f of ['campus.json', 'version.json', ...PUBLIC_FLOORS.map((id) => `floors/${id}.svg`)]) {
    assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(bare, f))), f);
  }
  const campus = JSON.parse(fs.readFileSync(path.join(out, 'campus.json'), 'utf8'));
  assert.deepEqual(campus.floors.map((f) => f.id), PUBLIC_FLOORS);
  assert.ok(campus.floors.every(isPublicFloor), 'no floor with public false');
  for (const c of ['rooms', 'navNodes', 'photos', 'qrLocations']) {
    assert.deepEqual(campus[c].filter((r) => hidden.has(r.floorId)).map((r) => r.id), [], `${c} on hidden floors`);
  }
  // The published graph is closed: no dangling edge, node room or QR node.
  const nodeIds = new Set(campus.navNodes.map((n) => n.id));
  const roomIds = new Set(campus.rooms.map((r) => r.id));
  const floorIds = new Set(PUBLIC_FLOORS);
  assert.deepEqual(campus.navEdges.filter((e) => !nodeIds.has(e.fromNodeId) || !nodeIds.has(e.toNodeId)).map((e) => e.id), []);
  assert.deepEqual(campus.navNodes.filter((n) => n.roomId && !roomIds.has(n.roomId)).map((n) => n.id), []);
  assert.deepEqual(campus.rooms.filter((r) => !floorIds.has(r.floorId)).map((r) => r.id), []);
  assert.deepEqual(campus.qrLocations.filter((q) => q.nodeId && !nodeIds.has(q.nodeId)).map((q) => q.id), []);
  assert.ok(campus.rooms.length < full.rooms.length && campus.navEdges.length < full.navEdges.length);

  // A floor made public by an override is published with its rooms and plan.
  const ov = dir({ floors: [{ id: 'floor-it-9', public: true }] });
  const x = buildExport({ overridesDir: ov, privateDir: PRIVATE });
  assert.ok(x.campus.floors.some((f) => f.id === 'floor-it-9'));
  assert.ok(x.campus.rooms.some((r) => r.floorId === 'floor-it-9'));
  assert.ok(x.campus.navEdges.some((e) => e.id === 'it-x901'));
  assert.ok(x.floors.some((f) => f.id === 'floor-it-9'));
  for (const v of [false, 'false', 'FALSE']) assert.equal(isPublicFloor({ public: v }), false, String(v));
  for (const v of [true, 'true', undefined, '']) assert.equal(isPublicFloor({ public: v }), true, String(v));
});

test('overrides apply at export, change the version, and orphans and refusals are reported', () => {
  const ov = dir({
    rooms: [
      { id: 'room-it-1-0141', label: 'Dean of Engineering' },
      { id: 'room-it-1-9999', label: 'gone' },
      { id: 'room-ep-1-1322', _delete: true },
    ],
    qrLocations: [{ id: 'qrloc-test', _new: true, buildingId: 'bld-it', floorId: 'floor-it-1', nodeId: 'it-1-n0490', description: 'Lobby', permanent: true }],
    buildings: [{ id: 'bld-it', photoUrl: 'https://example.org/it.jpg' }],
    config: [{ key: 'mapsApiKey', _new: true, value: 'test-only-maps-key' }],
  });
  const x = buildExport({ overridesDir: ov });
  const base = buildExport({ overridesDir: EMPTY });
  assert.equal(x.campus.rooms.find((r) => r.id === 'room-it-1-0141').label, 'Dean of Engineering');
  assert.equal(x.campus.rooms.find((r) => r.id === 'room-ep-1-1322'), undefined);
  assert.equal(x.campus.rooms.length, base.campus.rooms.length - 1);
  assert.deepEqual(x.campus.qrLocations.map((q) => [q.id, q.permanent, q.description]), [['qrloc-test', true, 'Lobby']]);
  assert.equal(x.campus.buildings.find((b) => b.id === 'bld-it').photoUrl, 'https://example.org/it.jpg');
  assert.deepEqual(x.report.orphans, [{ collection: 'rooms', id: 'room-it-1-9999', op: 'edit' }]);
  assert.deepEqual(x.report.refused.map((r) => r.id), ['mapsApiKey']);
  assert.notEqual(x.version, base.version);
  assert.ok(!JSON.stringify(x.campus).includes('test-only-maps-key'), 'no Maps key in the export');
  assert.ok(!x.campus.config.some((c) => c.key === 'mapsApiKey'));
});

test('a Maps key present in the runtime (as the local admin may set one) never reaches the export', () => {
  const x = buildExport({ overridesDir: EMPTY, props: { mapsApiKey: 'test-only-maps-key' } });
  assert.ok(!JSON.stringify(x.campus).includes('test-only-maps-key'));
  assert.deepEqual(x.campus.config.map((c) => c.key), ['dataVersion', 'routing.altFactor', 'routing.altDoorCost']);
});

test('a malformed overrides file stops the export with the file named', () => {
  const bad = dir();
  fs.writeFileSync(path.join(bad, 'rooms.json'), '{ not json');
  assert.throws(() => buildExport({ overridesDir: bad }), /rooms\.json/);
});

test('a persisted override with a bad class, number, polygon or id stops the export with its file, index and id (review v5, finding 5)', () => {
  const cases = [
    [{ navNodes: [{ id: 'ep-1-n0365', access: 'bogus' }] }, /navNodes\.json\[0\] \(ep-1-n0365\): access must be main, alt or emergency \(got "bogus"\)/],
    [{ navNodes: [{ id: 'ep-1-n0365', x: 'not-a-number' }] }, /navNodes\.json\[0\] \(ep-1-n0365\): x must be a number/],
    [{ rooms: [{ id: 'room-ep-1-1322', access: 'alt' }, { id: 'room-it-1-0141', polygon: 'not-json' }] }, /rooms\.json\[1\] \(room-it-1-0141\): polygon must be JSON/],
    [{ rooms: [{ id: 'room-it-1-0141', polygon: [[0, 0], [1, 1]] }] }, /rooms\.json\[0\] \(room-it-1-0141\): polygon must be a list of at least three/],
    [{ navEdges: [{ id: 'edge-x', _new: true, fromNodeId: 'ep-1-n0365', toNodeId: 'no-such-node' }] }, /navEdges\.json\[0\] \(edge-x\): toNodeId names no NavNodes record: no-such-node/],
    [{ buildings: [{ id: 'bld-it', lat: 136 }] }, /buildings\.json\[0\] \(bld-it\): lat must be from -90 to 90/],
  ];
  for (const [files, re] of cases) assert.throws(() => buildExport({ overridesDir: dir(files) }), re);
  // the committed overrides pass the same rules
  assert.doesNotThrow(() => buildExport());
});
