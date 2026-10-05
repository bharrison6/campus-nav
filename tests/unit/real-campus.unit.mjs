// The web app's pathfinding and search modules on the REAL campus data the site publishes: what
// getPublicCampusData returns (the export's campus.json, hidden floors absent) once the generated
// SeedFloorData.gs is seeded (built here by running the .gs files in dev/gas-runtime.cjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadInclude } from './load-include.mjs';

const require = createRequire(import.meta.url);
const { makeRuntime } = require('../../dev/gas-runtime.cjs');

const gas = makeRuntime(); // the backend in tools/admin/gs (GS_DIR)
gas.ctx.initSystem();
const data = gas.run('getPublicCampusData', []);
// The admin's view, hidden floors included. The real hidden floors are never in the repository, so the local admin's
// private location is stood in for by a synthetic one (tests/unit/fixtures/private: a made-up hidden floor wired to
// the real IT stair).
const PRIVATE_GS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'private', 'gs');
const withPrivate = makeRuntime(undefined, '', { gsDirs: [PRIVATE_GS], htmlDirs: [PRIVATE_GS] });
withPrivate.ctx.initSystem();
const full = withPrivate.run('getAllCampusData', []);

const P = loadInclude('WebApp_Pathfinding.html', 'MSCNPath');
const S = loadInclude('WebApp_Search.html', 'MSCNSearch');
const isPublic = (f) => !!f && P.toBool(f.public, true);
const g = P.buildGraph(data, { floorFilter: isPublic });
const floorsById = Object.fromEntries(data.floors.map((f) => [f.id, f]));
const publicRooms = data.rooms.filter((r) => isPublic(floorsById[r.floorId]));
// Corridors and mechanical chases are drawn and tappable but not searchable; they have no room hub (a tap
// routes to the nearest corridor node instead), so reachability is checked for searchable rooms.
const searchableRooms = publicRooms.filter((r) => P.toBool(r.searchable, true));
const index = S.buildIndex(data, { floorFilter: isPublic });
const titles = (q, n) => Array.from(S.search(index, q, n)).map((e) => e.title);

test('non-searchable public rooms are only corridors, mechanical spaces and unnumbered areas', () => {
  const kinds = new Set(publicRooms.filter((r) => !P.toBool(r.searchable, true)).map((r) => r.type));
  assert.deepEqual([...kinds].sort(), ['corridor', 'mechanical', 'other', 'storage']);
  assert.equal(searchableRooms.length, 385); // of 486 public rooms (v5: 14 more circulation spaces typed corridor)
});

test('every searchable room is on the graph and reachable from its building\'s entrances', () => {
  const missing = [];
  const unreachable = [];
  for (const r of searchableRooms) {
    const ids = P.nodesForRoom(g, r.id);
    if (!ids.length) { missing.push(r.id); continue; }
    const b = floorsById[r.floorId].buildingId;
    if (!P.findPath(g, P.entranceIds(g, b), ids)) unreachable.push(r.id);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(unreachable, []);
});

test('step-free: every searchable room is reachable from an entrance without stairs (elevators and IT\'s second-floor entrances)', () => {
  const unreachable = searchableRooms.filter((r) => {
    const b = floorsById[r.floorId].buildingId;
    return !P.findPath(g, P.entranceIds(g, b), P.nodesForRoom(g, r.id), { accessibleOnly: true });
  }).map((r) => r.id);
  assert.deepEqual(unreachable, []);
});

test('IT 141 to IT 241: stairs by default, the elevator when avoiding stairs', () => {
  const from = P.nodesForRoom(g, 'room-it-1-0141');
  const to = P.nodesForRoom(g, 'room-it-2-0241');
  const seg = P.segmentPath(g, P.findPath(g, from, to));
  assert.equal(seg.length, 2);
  assert.equal(seg[0].exit.type, 'stair');
  const acc = P.segmentPath(g, P.findPath(g, from, to, { accessibleOnly: true }));
  assert.equal(acc[0].exit.type, 'elevator');
});

test('EP 1322 connects only through its own exterior door', () => {
  const r1322 = P.nodesForRoom(g, 'room-ep-1-1322');
  assert.ok(P.findPath(g, P.entranceIds(g, 'bld-ep'), r1322), 'reachable from outside');
  assert.equal(P.findPath(g, r1322, P.nodesForRoom(g, 'room-ep-2-2321')), null, 'no indoor route from 1322');
});

test('the published data gives the same graph and search as the full data filtered by the client', () => {
  // Positive control: the full data does hold hidden floors, and the client's floorFilter is what hid them.
  assert.ok(full.floors.some((f) => !isPublic(f)));
  assert.ok(data.floors.every(isPublic), 'no hidden floor is published');
  const gFull = P.buildGraph(full, { floorFilter: isPublic });
  const gBare = P.buildGraph(data, {}); // no filter at all: absence alone must be enough
  const adj = (gr) => Object.keys(gr.adj).sort().map((k) => k + ':' + gr.adj[k].map((e) => e.to || e.id || JSON.stringify(e)).sort().join(','));
  assert.deepEqual(Object.keys(gBare.nodes).sort(), Object.keys(gFull.nodes).sort());
  assert.deepEqual(adj(gBare), adj(gFull));
  assert.deepEqual(Object.keys(gBare.floors).sort(), ['floor-ep-1', 'floor-ep-2', 'floor-it-1', 'floor-it-2']);
  const entries = (ix) => ix.entries.map((e) => e.title).sort();
  assert.deepEqual(entries(S.buildIndex(data, {})), entries(S.buildIndex(full, { floorFilter: isPublic })));
  // Routes across IT 1-2 and EP 1-2 work on the bare published graph.
  assert.ok(P.findPath(gBare, P.nodesForRoom(gBare, 'room-it-1-0141'), P.nodesForRoom(gBare, 'room-it-2-0241')));
  assert.ok(P.findPath(gBare, P.entranceIds(gBare, 'bld-ep'), P.nodesForRoom(gBare, 'room-ep-2-2321'), { accessibleOnly: true }));
});

test('hidden floors are out of the public graph and search', () => {
  assert.ok(!Object.values(g.nodes).some((n) => n.floorId === 'floor-it-3' || n.floorId === 'floor-ep-3'));
  assert.deepEqual(titles('IT 301'), []);
  assert.deepEqual(titles('3300'), []);
});

test('search: "IT 141" first; "EP 232" offers the EP 232x rooms; the catch-all type "other" is not shown', () => {
  assert.equal(titles('IT 141')[0], 'IT 141');
  assert.equal(titles('it141')[0], 'IT 141');
  const ep = titles('EP 232', 20);
  assert.equal(ep[0], 'EP 2321');
  assert.ok(ep.every((t) => /^EP 232\d/.test(t)), ep.join(', '));
  const e = S.search(index, 'IT 141', 1)[0];
  assert.equal(e.subtitle, 'Collins Industry and Technology Center, First Floor');
  assert.equal(S.search(index, 'EP 1310', 1)[0].subtitle, 'Restroom · Engineering and Physics Building, First Floor');
  assert.deepEqual(titles('other'), []);
});
