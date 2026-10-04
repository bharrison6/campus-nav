// The committed pipeline outputs agree with each other. Needs no drawings, so it runs everywhere (CI included):
// the per-floor SVGs in data/floorplans are the floor-plan assets the backend serves (tools/admin/gs/FP_*.html), and
// the generated SeedFloorData.gs holds exactly the rooms, nodes and edges of the per-floor JSON plus the cross-floor
// edges. Whether those outputs still match the drawings is graph.test.mjs's job (it needs MSCN_DWG_DIR).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { FLOORS, planAssetName } from '../config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const OUT = path.join(repo, 'data', 'floorplans');
const GS = path.join(repo, 'tools', 'admin', 'gs');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const seedCtx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(GS, 'SeedFloorData.gs'), 'utf8'), seedCtx);
// JSON round trip: arrays made in the vm context have another realm's prototype, which deepStrictEqual rejects.
const seed = JSON.parse(JSON.stringify({
  floors: seedCtx.getGeneratedFloorsSeed(),
  rooms: seedCtx.getGeneratedRoomsSeed(),
  nodes: seedCtx.getGeneratedNavNodesSeed(),
  edges: seedCtx.getGeneratedNavEdgesSeed(),
}));
const cross = readJson(path.join(OUT, 'cross-floor-edges.json'));

for (const f of FLOORS) {
  test(`${f.floorId}: the served plan asset is the committed SVG; JSON and seed agree`, () => {
    const svg = fs.readFileSync(path.join(OUT, `${f.floorId}.svg`), 'utf8');
    assert.equal(fs.readFileSync(path.join(GS, `${planAssetName(f.floorId)}.html`), 'utf8'), svg);
    const json = readJson(path.join(OUT, `${f.floorId}.json`));
    assert.equal(json.source, f.file, 'source names the DWG file, never a repository path');
    assert.equal(json.planAsset, planAssetName(f.floorId));
    assert.deepEqual(seed.rooms.filter((r) => r[1] === f.floorId).map((r) => r[0]), json.rooms.map((r) => r.id));
    assert.deepEqual(seed.nodes.filter((n) => n[1] === f.floorId).map((n) => n[0]), json.nav.nodes.map((n) => n.id));
  });
}

test('seed floors and edges are the catalogue and the per-floor edges plus the cross-floor edges', () => {
  assert.deepEqual(seed.floors.map((r) => r[0]), FLOORS.map((f) => f.floorId));
  const floorEdges = FLOORS.flatMap((f) => readJson(path.join(OUT, `${f.floorId}.json`)).nav.edges.map((e) => e.id));
  assert.deepEqual(seed.edges.map((e) => e[0]).sort(), [...floorEdges, ...cross.map((e) => e.id)].sort());
});
