// The build-time export (scripts/data/export-campus-data.mjs) on the real seed and pipeline data, with and without
// overrides: the published shape, determinism, the overrides report, and that no key ever reaches the output.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildExport, exportCampusData, isPublicFloor } from '../../scripts/data/export-campus-data.mjs';
import { OVERRIDES_DIR, openCampus } from '../../scripts/data/campus-engine.mjs';
import { COLLECTIONS } from '../../scripts/data/overrides.mjs';

const require = createRequire(import.meta.url);
const { makeRuntime } = require('../../dev/gas-runtime.cjs');

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
const reference = plain.run('getAllCampusData', []);
// Only public floors' plans are published (the IT mezzanine and the EP penthouse are hidden).
const PUBLIC_FLOORS = reference.floors.filter(isPublicFloor).map((f) => f.id);

const withoutVersion = (c) => ({ ...c, version: '', config: c.config.map((r) => (r.key === 'dataVersion' ? { ...r, value: '' } : r)) });

test('the committed overrides files are the eight collections, each a JSON array', () => {
  for (const c of Object.keys(COLLECTIONS)) {
    const recs = JSON.parse(fs.readFileSync(path.join(OVERRIDES_DIR, `${c}.json`), 'utf8'));
    assert.ok(Array.isArray(recs), c);
  }
});

test('no overrides: campus.json is exactly what getAllCampusData returns (only version differs); the diff is empty', () => {
  const x = buildExport({ overridesDir: EMPTY });
  assert.deepEqual(Object.keys(x.campus), ['contractVersion', 'version', 'config', 'buildings', 'floors', 'rooms', 'navNodes', 'navEdges', 'photos', 'qrLocations']);
  assert.deepEqual(withoutVersion(x.campus), withoutVersion(reference));
  assert.match(x.version, /^[0-9a-f]{12}$/);
  assert.equal(x.campus.version, x.version);
  assert.deepEqual(x.campus.config, [{ key: 'dataVersion', value: x.version }]);
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

test('hidden floors stay in campus.json but their plans are never written', () => {
  assert.deepEqual(PUBLIC_FLOORS, ['floor-it-1', 'floor-it-2', 'floor-ep-1', 'floor-ep-2']);
  const hidden = reference.floors.filter((f) => !isPublicFloor(f)).map((f) => f.id);
  assert.deepEqual(hidden, ['floor-it-3', 'floor-ep-3']);
  const out = dir();
  const r = exportCampusData({ outDir: out, overridesDir: EMPTY });
  assert.deepEqual(fs.readdirSync(path.join(out, 'floors')).sort(), PUBLIC_FLOORS.map((id) => `${id}.svg`).sort());
  const campus = JSON.parse(fs.readFileSync(path.join(out, 'campus.json'), 'utf8'));
  assert.deepEqual(campus.floors.map((f) => f.id).filter((id) => hidden.includes(id)), hidden);
  // A floor made public by an override gets its plan published.
  const ov = dir({ floors: [{ id: 'floor-it-3', public: true }] });
  assert.ok(buildExport({ overridesDir: ov }).floors.some((f) => f.id === 'floor-it-3'));
  assert.ok(r.version);
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
    qrLocations: [{ id: 'qrloc-test', _new: true, buildingId: 'bld-it', floorId: 'floor-it-1', nodeId: 'it-1-n1', description: 'Lobby', permanent: true }],
    buildings: [{ id: 'bld-it', photoUrl: 'https://example.org/it.jpg' }],
    config: [{ key: 'mapsApiKey', _new: true, value: 'AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE' }],
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
  assert.ok(!JSON.stringify(x.campus).includes('AIza'), 'no Maps key in the export');
  assert.ok(!x.campus.config.some((c) => c.key === 'mapsApiKey'));
});

test('a Maps key present in the runtime (as the local admin may set one) never reaches the export', () => {
  const x = buildExport({ overridesDir: EMPTY, props: { mapsApiKey: 'AIzaSyLOCALLOCALLOCALLOCALLOCAL' } });
  assert.ok(!JSON.stringify(x.campus).includes('AIza'));
  assert.deepEqual(x.campus.config.map((c) => c.key), ['dataVersion']);
});

test('a malformed overrides file stops the export with the file named', () => {
  const bad = dir();
  fs.writeFileSync(path.join(bad, 'rooms.json'), '{ not json');
  assert.throws(() => buildExport({ overridesDir: bad }), /rooms\.json/);
});
