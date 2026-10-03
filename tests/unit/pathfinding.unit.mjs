import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInclude, loadFixture } from './load-include.mjs';

const P = loadInclude('WebApp_Pathfinding.html', 'MSCNPath');

// A tiny hand-made graph: two floors, a stair pair and an elevator pair.
//   F1: a(0,0) -- b(100,0) -- s1(200,0)      e1(100,100) hangs off b
//   F2: s2(200,0) -- c(100,0) -- e2(100,100)
function tinyData(overrides = {}) {
  return {
    floors: [
      { id: 'f1', buildingId: 'B', level: 1, label: 'Floor 1', metersPerPixel: 0.1 },
      { id: 'f2', buildingId: 'B', level: 2, label: 'Floor 2', metersPerPixel: 0.1 },
    ],
    navNodes: [
      { id: 'a', floorId: 'f1', x: 0, y: 0, type: 'entrance' },
      { id: 'b', floorId: 'f1', x: 100, y: 0, type: 'waypoint' },
      { id: 's1', floorId: 'f1', x: 200, y: 0, type: 'stair', linkId: 'S' },
      { id: 'e1', floorId: 'f1', x: 100, y: 100, type: 'elevator', linkId: 'E' },
      { id: 's2', floorId: 'f2', x: 200, y: 0, type: 'stair', linkId: 'S' },
      { id: 'c', floorId: 'f2', x: 100, y: 0, type: 'room', roomId: 'room-c' },
      { id: 'e2', floorId: 'f2', x: 100, y: 100, type: 'elevator', linkId: 'E' },
    ],
    navEdges: [
      { id: 'ab', fromNodeId: 'a', toNodeId: 'b', distance: 10, accessible: true },
      { id: 'bs1', fromNodeId: 'b', toNodeId: 's1', distance: 10, accessible: true },
      { id: 'be1', fromNodeId: 'b', toNodeId: 'e1', distance: 10, accessible: true },
      { id: 's1s2', fromNodeId: 's1', toNodeId: 's2', distance: 5, floorChange: true, accessible: false },
      { id: 'e1e2', fromNodeId: 'e1', toNodeId: 'e2', distance: 12, floorChange: true, accessible: true },
      { id: 's2c', fromNodeId: 's2', toNodeId: 'c', distance: 10, accessible: true },
      { id: 'e2c', fromNodeId: 'e2', toNodeId: 'c', distance: 10, accessible: true },
      ...(overrides.extraEdges || []),
    ],
  };
}

const ids = (route) => Array.from(route.nodeIds);

test('shortest path on one floor follows the cheaper chain', () => {
  const data = tinyData({ extraEdges: [{ id: 'as1', fromNodeId: 'a', toNodeId: 's1', distance: 50 }] });
  const g = P.buildGraph(data);
  const r = P.findPath(g, 'a', 's1');
  assert.deepEqual(ids(r), ['a', 'b', 's1']);
  assert.equal(r.distance, 20);
});

test('edges are walkable in both directions', () => {
  const g = P.buildGraph(tinyData());
  assert.deepEqual(ids(P.findPath(g, 's1', 'a')), ['s1', 'b', 'a']);
});

test('floor change takes the cheapest connector (stairs) by default', () => {
  const g = P.buildGraph(tinyData());
  const r = P.findPath(g, 'a', 'c');
  assert.deepEqual(ids(r), ['a', 'b', 's1', 's2', 'c']);
  assert.equal(r.distance, 35);
  const seg = P.segmentPath(g, r);
  assert.equal(seg.length, 2);
  assert.equal(seg[0].floorId, 'f1');
  assert.equal(seg[0].exit.type, 'stair');
  assert.equal(seg[0].exit.direction, 'up');
  assert.equal(seg[1].floorId, 'f2');
  const steps = P.buildSteps(g, seg, { floorLabel: (id) => (id === 'f1' ? 'Floor 1' : 'Floor 2'), destination: 'Room C' });
  assert.equal(steps[0].title, 'Take the stairs up to Floor 2');
  assert.equal(steps[1].title, 'Arrive at Room C');
});

test('accessible filter avoids stairs and uses the elevator', () => {
  const g = P.buildGraph(tinyData());
  const r = P.findPath(g, 'a', 'c', { accessibleOnly: true });
  assert.deepEqual(ids(r), ['a', 'b', 'e1', 'e2', 'c']);
  const seg = P.segmentPath(g, r);
  assert.equal(seg[0].exit.type, 'elevator');
});

test('missing accessible column: cross-floor stair edge counts as not accessible', () => {
  const data = tinyData();
  for (const e of data.navEdges) delete e.accessible;
  const g = P.buildGraph(data);
  assert.deepEqual(ids(P.findPath(g, 'a', 'c', { accessibleOnly: true })), ['a', 'b', 'e1', 'e2', 'c']);
});

test('sheet-style string booleans are honored', () => {
  const data = tinyData();
  for (const e of data.navEdges) e.accessible = e.accessible ? 'TRUE' : 'FALSE';
  const g = P.buildGraph(data);
  assert.deepEqual(ids(P.findPath(g, 'a', 'c', { accessibleOnly: true })), ['a', 'b', 'e1', 'e2', 'c']);
});

test('unreachable goal returns null', () => {
  const data = tinyData();
  data.navNodes.push({ id: 'island', floorId: 'f2', x: 500, y: 500, type: 'room' });
  const g = P.buildGraph(data);
  assert.equal(P.findPath(g, 'a', 'island'), null);
});

test('accessible-only route is null when only stairs connect the floors', () => {
  const data = tinyData();
  data.navEdges = data.navEdges.filter((e) => e.id !== 'e1e2');
  const g = P.buildGraph(data);
  assert.equal(P.findPath(g, 'a', 'c', { accessibleOnly: true }), null);
  assert.ok(P.findPath(g, 'a', 'c'));
});

test('unknown start or goal returns null', () => {
  const g = P.buildGraph(tinyData());
  assert.equal(P.findPath(g, 'nope', 'c'), null);
  assert.equal(P.findPath(g, 'a', 'nope'), null);
});

test('multi-source picks the nearest start', () => {
  const g = P.buildGraph(tinyData());
  const r = P.findPath(g, ['a', 's2'], 'c');
  assert.deepEqual(ids(r), ['s2', 'c']);
});

test('floor filter drops hidden floors from the graph', () => {
  const g = P.buildGraph(tinyData(), { floorFilter: (f) => f && f.id !== 'f2' });
  assert.equal(g.nodes.c, undefined);
  assert.equal(P.findPath(g, 'a', 'c'), null);
});

test('missing distance falls back to geometry times metersPerPixel', () => {
  const data = tinyData();
  data.navEdges = [{ id: 'ab', fromNodeId: 'a', toNodeId: 'b', distance: '' }];
  const g = P.buildGraph(data);
  assert.equal(P.findPath(g, 'a', 'b').distance, 10); // 100 units * 0.1 m
});

test('a multi-floor stair ride collapses into one transition', () => {
  const data = {
    floors: [1, 2, 3].map((l) => ({ id: 'f' + l, buildingId: 'B', level: l, label: 'Floor ' + l, metersPerPixel: 1 })),
    navNodes: [
      { id: 'r1', floorId: 'f1', x: 0, y: 0, type: 'room' },
      { id: 's1', floorId: 'f1', x: 10, y: 0, type: 'stair' },
      { id: 's2', floorId: 'f2', x: 10, y: 0, type: 'stair' },
      { id: 's3', floorId: 'f3', x: 10, y: 0, type: 'stair' },
      { id: 'r3', floorId: 'f3', x: 20, y: 0, type: 'room' },
    ],
    navEdges: [
      { id: '1', fromNodeId: 'r1', toNodeId: 's1', distance: 10 },
      { id: '2', fromNodeId: 's1', toNodeId: 's2', distance: 5, accessible: false },
      { id: '3', fromNodeId: 's2', toNodeId: 's3', distance: 5, accessible: false },
      { id: '4', fromNodeId: 's3', toNodeId: 'r3', distance: 10 },
    ],
  };
  const g = P.buildGraph(data);
  const seg = P.segmentPath(g, P.findPath(g, 'r1', 'r3'));
  assert.equal(seg.length, 2);
  assert.equal(seg[0].exit.toFloorId, 'f3');
  assert.equal(seg[0].exit.floors, 2);
  const steps = P.buildSteps(g, seg, { floorLabel: (id) => 'Floor ' + id.slice(1), destination: 'R3' });
  assert.equal(steps[0].title, 'Take the stairs up to Floor 3');
  const down = P.segmentPath(g, P.findPath(g, 'r3', 'r1'));
  assert.equal(down[0].exit.direction, 'down');
  assert.equal(down[0].exit.toFloorId, 'f1');
});

test('room lookup prefers the room node over the door node', () => {
  const data = tinyData();
  data.navNodes.push({ id: 'cdoor', floorId: 'f2', x: 100, y: 10, type: 'door', roomId: 'room-c' });
  const g = P.buildGraph(data);
  assert.deepEqual(Array.from(P.nodesForRoom(g, 'room-c')), ['c', 'cdoor']);
  assert.deepEqual(Array.from(P.nodesForRoom(g, 'missing')), []);
});

test('entranceIds and nearestNode', () => {
  const g = P.buildGraph(tinyData());
  assert.deepEqual(Array.from(P.entranceIds(g, 'B')), ['a']);
  assert.equal(P.nearestNode(g, 'f2', 90, 90).id, 'e2');
  assert.equal(P.nearestNode(g, 'f2', 90, 90, (n) => n.type === 'room').id, 'c');
});

test('MinHeap pops in priority order', () => {
  const h = new P.MinHeap();
  [5, 1, 4, 2, 3, 0].forEach((p) => h.push('n' + p, p));
  const out = [];
  while (h.size()) out.push(h.pop().pri);
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
});

// Against the dev fixture (contract-shaped campus data).
test('fixture: IT 141 to IT 241 routes up a floor; avoid-stairs uses the elevator', () => {
  const data = loadFixture();
  const publicOnly = (f) => !!f && P.toBool(f.public, true);
  const g = P.buildGraph(data, { floorFilter: publicOnly });
  const from = P.nodesForRoom(g, 'room-it-1-0141');
  const to = P.nodesForRoom(g, 'room-it-2-0241');
  const r = P.findPath(g, from, to);
  assert.ok(r, 'route exists');
  const seg = P.segmentPath(g, r);
  assert.equal(seg.length, 2);
  assert.equal(seg[0].exit.type, 'stair');
  const acc = P.segmentPath(g, P.findPath(g, from, to, { accessibleOnly: true }));
  assert.equal(acc[0].exit.type, 'elevator');
  assert.equal(g.nodes['node-it-3-room-0301'], undefined, 'hidden mezzanine is out of the public graph');
});

test('fixture: every public room node is reachable from its building entrance without stairs', () => {
  const data = loadFixture();
  const g = P.buildGraph(data, { floorFilter: (f) => !!f && P.toBool(f.public, true) });
  let checked = 0;
  for (const id of Object.keys(g.nodes)) {
    const n = g.nodes[id];
    if (n.type !== 'room') continue;
    const b = P.buildingOfNode(g, id);
    assert.ok(P.findPath(g, P.entranceIds(g, b), id, { accessibleOnly: true }), `reachable: ${id}`);
    checked += 1;
  }
  assert.ok(checked >= 10);
});
