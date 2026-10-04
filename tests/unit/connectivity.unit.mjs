// The connectivity invariant (scripts/data/connectivity.mjs, plan mscn-v5 contract item 6) on the real published data
// and outdoor graph: every searchable room reaches every other and every building with entrances is reachable, with
// emergency doors and hallways closed and alt ones open. Then the check's potency: cutting a hallway, a sole door or a
// building's paths, or making a hallway emergency in the overrides, is reported with exactly what it cuts off.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';
import { checkConnectivity, describeConnectivity } from '../../scripts/data/connectivity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTDOOR = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'campus-map', 'outdoor-graph.json'), 'utf8'));
const { campus } = buildExport();
const clone = (v) => JSON.parse(JSON.stringify(v));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mscn-connectivity-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function inRing(x, y, ring) {
  let s = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) s = !s;
  }
  return s;
}

/** The campus without some nodes and every edge touching them (what deleting them in the admin does). */
function withoutNodes(c, ids) {
  const gone = new Set(ids);
  return { ...c, navNodes: c.navNodes.filter((n) => !gone.has(n.id)), navEdges: c.navEdges.filter((e) => !gone.has(e.fromNodeId) && !gone.has(e.toNodeId)) };
}

const SUITE_1357 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((l) => `room-ep-1-1357${l}`).sort();

test('real data: every searchable room and every building with entrances is reachable (emergency closed, alt open)', () => {
  const r = checkConnectivity(campus, OUTDOOR);
  assert.deepEqual(describeConnectivity(r, { rooms: campus.rooms }), ['connectivity: every searchable room and every building with entrances is reachable']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unreachableRooms, []);
  assert.deepEqual(r.unreachableBuildings, []);
  assert.equal(r.components.length, 1, 'one part holds them all');
  assert.equal(r.components[0].rooms, campus.rooms.filter((x) => x.searchable === true).length);
  assert.ok(r.components[0].buildings >= 2);
  // The real data does carry an emergency exit (EP's stair-tower door), so the check ran with it closed.
  assert.ok(campus.navNodes.some((n) => n.access === 'emergency'));
  // EP 1322 opens only to the outside, through an alt door: reachable because alt is allowed.
  assert.equal(campus.navNodes.find((n) => n.id === 'ep-1-n0365').access, 'alt');
});

test('potency: removing one hallway\'s waypoints cuts off the rooms that open only onto it (EP 1357 suite)', () => {
  const hall = campus.rooms.find((r) => r.id === 'room-ep-1-1357');
  assert.equal(hall.type, 'corridor', 'EP 1357 is a hallway (typed by the v5 classifier)');
  const wps = campus.navNodes.filter((n) => n.floorId === hall.floorId && n.type === 'waypoint' && inRing(Number(n.x), Number(n.y), hall.polygon)).map((n) => n.id);
  assert.ok(wps.length >= 3, `${wps.length} waypoints`);
  const r = checkConnectivity(withoutNodes(campus, wps), OUTDOOR);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unreachableRooms.slice().sort(), SUITE_1357);
  assert.deepEqual(r.unreachableBuildings, []);
  assert.match(describeConnectivity(r, { rooms: campus.rooms })[0], /^unreachable rooms \(8\): room-ep-1-1357/);
});

test('potency: removing a sole door, or making it emergency, cuts off its room (EP 1322)', () => {
  const r = checkConnectivity(withoutNodes(campus, ['ep-1-n0365']), OUTDOOR);
  assert.deepEqual(r.unreachableRooms, ['room-ep-1-1322']);
  const c = clone(campus);
  c.navNodes.find((n) => n.id === 'ep-1-n0365').access = 'emergency';
  assert.deepEqual(checkConnectivity(c, OUTDOOR).unreachableRooms, ['room-ep-1-1322'], 'emergency closes it even while the outdoor graph still joins it');
  // as alt it is fine (alt is allowed), and as main of course
  c.navNodes.find((n) => n.id === 'ep-1-n0365').access = 'main';
  assert.equal(checkConnectivity(c, OUTDOOR).ok, true);
});

test('potency: a building cut from the paths is reported, with its rooms', () => {
  const itDoors = new Set(campus.navNodes.filter((n) => n.type === 'entrance' && n.floorId.startsWith('floor-it-')).map((n) => n.id));
  const cut = { nodes: OUTDOOR.nodes, edges: OUTDOOR.edges.filter((e) => !itDoors.has(e.from) && !itDoors.has(e.to)) };
  const r = checkConnectivity(campus, cut);
  assert.deepEqual(r.unreachableBuildings, ['bld-it']);
  assert.ok(r.unreachableRooms.length > 100 && r.unreachableRooms.every((id) => id.startsWith('room-it-')), 'all of IT, nothing of EP');
  assert.equal(r.components.length, 2);
});

test('potency through the overrides: an emergency hallway closes its waypoints in the export, and the check sees it', () => {
  const dir = path.join(tmp, 'emergency-hall');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify([{ id: 'room-ep-1-1357', access: 'emergency' }]));
  const x = buildExport({ overridesDir: dir });
  assert.equal(x.campus.rooms.find((r) => r.id === 'room-ep-1-1357').access, 'emergency');
  const r = checkConnectivity(x.campus, OUTDOOR);
  assert.deepEqual(r.unreachableRooms.slice().sort(), SUITE_1357);
  // alt: the hallway is usable, nothing is cut off
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify([{ id: 'room-ep-1-1357', access: 'alt' }]));
  assert.equal(checkConnectivity(buildExport({ overridesDir: dir }).campus, OUTDOOR).ok, true);
});

test('synthetic: floors change through stairs and elevators; emergency nodes are removed; no outdoor graph is fine', () => {
  const c = {
    rooms: [
      { id: 'a', searchable: true },
      { id: 'b', searchable: true },
      { id: 'hall', searchable: false },
    ],
    navNodes: [
      { id: 'ha', type: 'room', roomId: 'a', floorId: 'f1' },
      { id: 'd1', type: 'door', access: 'main', floorId: 'f1' },
      { id: 's1', type: 'stair', roomId: 's', floorId: 'f1' },
      { id: 's2', type: 'stair', roomId: 's', floorId: 'f2' },
      { id: 'd2', type: 'door', access: 'alt', floorId: 'f2' },
      { id: 'hb', type: 'room', roomId: 'b', floorId: 'f2' },
    ],
    navEdges: [
      { fromNodeId: 'ha', toNodeId: 'd1' },
      { fromNodeId: 'd1', toNodeId: 's1' },
      { fromNodeId: 's1', toNodeId: 's2', floorChange: true },
      { fromNodeId: 's2', toNodeId: 'd2' },
      { fromNodeId: 'd2', toNodeId: 'hb' },
    ],
    buildings: [],
  };
  assert.equal(checkConnectivity(c).ok, true);
  const e = clone(c);
  e.navNodes.find((n) => n.id === 'd2').access = 'emergency';
  const r = checkConnectivity(e);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unreachableRooms, ['b'], 'the larger part is the reference; the room behind the emergency door is out');
  // a searchable room with no node at all is unreachable too
  const m = clone(c);
  m.rooms.push({ id: 'ghost', searchable: true });
  assert.deepEqual(checkConnectivity(m).unreachableRooms, ['ghost']);
});
