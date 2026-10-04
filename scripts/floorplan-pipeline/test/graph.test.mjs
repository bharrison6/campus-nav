// Integration: run the real pipeline (without writing) over the drawings and check the navigation graph and the emitted
// GAS seed against the v2 data contract. Parsing is cached in scripts/floorplan-pipeline/.cache.
// The drawings are not in the repository (MSCN_DWG_DIR, default <repo>/../drawings/dwg): without them every test in
// this file is skipped with one message, so CI stays green; the committed outputs are still checked by tests/unit.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../pipeline.mjs';
import { buildSeedGs, HEADERS } from '../stages/emit-gas.mjs';
import { DWG_DIR_ENV, FLOORS, hasDrawings, planAssetName, resolveDwgDir } from '../config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const dwgDir = resolveDwgDir(repo);
const present = hasDrawings(dwgDir);
const SKIP = `drawings not found at ${dwgDir} (set ${DWG_DIR_ENV}); DWG-dependent pipeline checks skipped`;
if (!present) console.log(`# ${SKIP}`);
/** Every test here needs the drawings: skipped, with the reason, when they are absent. */
const test = (name, fn) => nodeTest(name, present ? {} : { skip: SKIP }, fn);
const result = present ? runPipeline({
  inDir: dwgDir,
  outDir: path.join(repo, 'data/floorplans'),
  gasDir: path.join(repo, 'tools/admin/gs'),
  cacheDir: path.join(repo, 'scripts/floorplan-pipeline/.cache'),
  log: () => {},
  write: false,
}) : { floors: [], crossEdges: [], report: {} };
const { floors, crossEdges, report } = result;

/** Adjacency over every floor graph plus the cross-floor edges. */
function adjacency() {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const f of floors) for (const e of f.nav.edges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  for (const e of crossEdges) {
    add(e.from, e.to);
    add(e.to, e.from);
  }
  return adj;
}

function bfs(adj, start) {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const n = q.shift();
    for (const m of adj.get(n) || []) if (!seen.has(m)) {
      seen.add(m);
      q.push(m);
    }
  }
  return seen;
}

test('every floor of the catalogue is produced, with contract ids and plan asset names', () => {
  assert.deepEqual(floors.map((f) => f.floorId), FLOORS.map((f) => f.floorId));
  for (const f of floors) {
    assert.equal(f.planAsset, planAssetName(f.floorId));
    assert.equal(f.metersPerUnit, 0.0254);
    assert.equal(f.public, !/-3$/.test(f.floorId), 'floors 3 are non-public');
  }
});

test('every room has a polygon, a contract id, a number and (unless synthetic) a label', () => {
  for (const f of floors) {
    const ids = new Set();
    for (const r of f.rooms) {
      assert.ok(r.polygon.length >= 3, r.id);
      assert.match(r.id, /^room-(it|ep)-[123]-/);
      assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
      ids.add(r.id);
      assert.ok(r.number);
      if (!r.number.startsWith('UNK-')) assert.ok(r.label, `${r.id} has a label`);
      assert.ok(['office', 'classroom', 'lab', 'restroom', 'corridor', 'stair', 'elevator', 'mechanical', 'storage', 'other'].includes(r.type));
    }
  }
});

test('every public room is reachable from every entrance on its floor (building graph incl. stairs/elevators)', () => {
  const adj = adjacency();
  const failures = [];
  for (const f of floors.filter((x) => x.public)) {
    const hubs = new Map(f.nav.nodes.filter((n) => n.roomId).map((n) => [n.roomId, n.id]));
    // Entrances that serve only an isolated exterior-access room are reported by the pipeline, not counted here.
    const isolated = new Set((report.floors[f.floorId].isolatedEntrances || []).map((e) => e.nodeId));
    const entrances = f.nav.nodes.filter((n) => n.type === 'entrance' && !isolated.has(n.id));
    const known = new Set(report.floors[f.floorId].unreachable.map((u) => u.room));
    for (const e of entrances) {
      const seen = bfs(adj, e.id);
      for (const r of f.rooms) {
        if (!r.searchable || known.has(r.id)) continue;
        if (!seen.has(hubs.get(r.id))) failures.push(`${f.floorId} ${r.number} from ${e.id}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('the only unreachable public rooms are the ones the report names (and they are few)', () => {
  const unreachable = floors.filter((f) => f.public).flatMap((f) => report.floors[f.floorId].unreachable.map((u) => u.number));
  assert.ok(unreachable.length <= 3, `unreachable: ${unreachable.join(', ')}`);
});

test('floors without an entrance are still reachable from the building entrances', () => {
  const adj = adjacency();
  for (const bldg of ['it', 'ep']) {
    const bf = floors.filter((f) => f.floorId.startsWith(`floor-${bldg}-`));
    const ent = bf.flatMap((f) => f.nav.nodes.filter((n) => n.type === 'entrance'));
    const isolated = new Set(bf.flatMap((f) => (report.floors[f.floorId].isolatedEntrances || []).map((e) => e.nodeId)));
    const start = ent.find((e) => !isolated.has(e.id));
    const seen = bfs(adj, start.id);
    for (const f of bf.filter((x) => x.public)) {
      const hubs = f.nav.nodes.filter((n) => n.type === 'room' || n.type === 'stair' || n.type === 'elevator');
      const reached = hubs.filter((n) => seen.has(n.id)).length;
      assert.ok(reached / hubs.length > 0.97, `${f.floorId}: ${reached}/${hubs.length}`);
    }
  }
});

test('cross-floor links exist for every stair/elevator pair; stairs are not accessible', () => {
  const nodeById = new Map(floors.flatMap((f) => f.nav.nodes.map((n) => [n.id, { ...n, floorId: f.floorId }])));
  for (const v of report.verticalStacks) {
    assert.ok(v.members.length >= 2, `${v.linkId} spans two floors`);
    const ms = v.members.slice().sort((a, b) => a.level - b.level);
    for (let i = 0; i + 1 < ms.length; i++) {
      const e = crossEdges.find((x) => x.linkId === v.linkId && nodeById.get(x.from).floorId === ms[i].floorId && nodeById.get(x.to).floorId === ms[i + 1].floorId);
      assert.ok(e, `${v.linkId}: ${ms[i].floorId} -> ${ms[i + 1].floorId}`);
      assert.equal(e.floorChange, true);
      assert.equal(e.accessible, v.type === 'elevator');
      assert.equal(nodeById.get(e.from).type, v.type);
      assert.equal(nodeById.get(e.from).linkId, v.linkId);
    }
  }
  // Both buildings have at least one accessible (elevator) link between floors 1 and 2.
  for (const bldg of ['it', 'ep']) assert.ok(report.verticalStacks.some((v) => v.bldg === bldg && v.type === 'elevator'));
});

test('edges have positive metric distances and reference existing nodes', () => {
  const ids = new Set(floors.flatMap((f) => f.nav.nodes.map((n) => n.id)));
  for (const f of floors) for (const e of f.nav.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to));
    assert.ok(e.distance > 0 && e.distance < 200, `${e.id} ${e.distance}`);
  }
});

test('SVGs are standalone, comment-free and well under 1 MB', () => {
  for (const f of floors) {
    assert.match(f.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ [\d.]+"/);
    assert.ok(!f.svg.includes('<!--'));
    assert.ok(Buffer.byteLength(f.svg) < 600 * 1024);
    assert.ok(f.svg.includes('<g id="rooms"'));
    for (const r of f.rooms) assert.ok(f.svg.includes(`data-room-id="${r.id}"`), r.id);
  }
});

test('SeedFloorData.gs evaluates, rows follow the contract headers, under 2 MB', () => {
  const src = buildSeedGs(floors, crossEdges, { unitName: 'inches' });
  assert.ok(Buffer.byteLength(src) < 2 * 1024 * 1024);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  // Values from the VM realm have foreign prototypes; a JSON round-trip makes them comparable.
  const own = (v) => JSON.parse(JSON.stringify(v));
  const sets = {
    Floors: own(ctx.getGeneratedFloorsSeed()),
    Rooms: own(ctx.getGeneratedRoomsSeed()),
    NavNodes: own(ctx.getGeneratedNavNodesSeed()),
    NavEdges: own(ctx.getGeneratedNavEdgesSeed()),
  };
  for (const [name, rows] of Object.entries(sets)) {
    assert.ok(rows.length > 0, name);
    for (const r of rows) assert.equal(r.length, HEADERS[name].length, `${name} row width`);
  }
  for (const r of sets.Rooms) assert.ok(Array.isArray(JSON.parse(r[5])));
  assert.deepEqual(sets.Floors.filter((f) => f[8] === false).map((f) => f[0]), ['floor-it-3', 'floor-ep-3']);
});

test('committed generated files are up to date with the DWGs and the pipeline', () => {
  const committed = fs.readFileSync(path.join(repo, 'tools/admin/gs/SeedFloorData.gs'), 'utf8');
  assert.equal(committed, buildSeedGs(floors, crossEdges, { unitName: 'inches' }), 'run `npm run pipeline` and commit');
  for (const f of floors) {
    assert.equal(fs.readFileSync(path.join(repo, 'tools/admin/gs', `${f.planAsset}.html`), 'utf8'), f.svg, f.floorId);
    assert.equal(fs.readFileSync(path.join(repo, 'data/floorplans', `${f.floorId}.svg`), 'utf8'), f.svg, f.floorId);
  }
});
