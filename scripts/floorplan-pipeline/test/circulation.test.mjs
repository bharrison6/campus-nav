// v5 pipeline pieces that need no drawings: the circulation rules (lib/classify.mjs), stable node and edge ids
// (stages/graph.mjs assignIds), and the committed hallway typing, candidate list and access fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { circulationRule, convexity, isCirculationNumber, passageEvidence } from '../lib/classify.mjs';
import { accessOf, assignIds } from '../stages/graph.mjs';
import { FLOORS } from '../config.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(repo, p), 'utf8'));

// A room of `sf` square feet whose inscribed circle has radius `inr` inches.
const room = (number, sf, inr, extra = {}) => ({ number, areaSf: sf, inradius: inr, kind: 'room', type: 'other', polygon: [[0, 0], [10, 0], [10, 10], [0, 10]], ...extra });
const ev = (neighbors, hallways, doors = neighbors, exterior = 0) => ({ neighbors: new Set(neighbors), hallways: new Set(hallways), doors, open: 0, exterior });

test('circulation rules: strong passage evidence makes a hallway; weak evidence does not', () => {
  // circulation number with passages to 3+ spaces, one a hallway (IT 0200E)
  assert.match(circulationRule(room('0200E', 655, 99), ev([1, 2, 3, 4], [1])), /^circulation number 0200E/);
  assert.equal(circulationRule(room('0200B', 51, 26), ev([1, 2, 3, 4], [1])), null, 'too small: a vestibule or alcove stays a candidate');
  assert.equal(circulationRule(room('0200A', 95, 48), ev([1], [1], 1, 1)), null, 'a vestibule (one inner passage) stays a candidate');
  // an open link between two hallways, no door (IT 0115Q)
  assert.match(circulationRule(room('0115Q', 65, 24), ev([1, 2], [1, 2], 0)), /^open link between 2 hallways/);
  assert.equal(circulationRule(room('0248', 268, 66), ev([1], [1], 0)), null, 'open to one hallway only: an alcove');
  // a hall serving many rooms, narrow enough (IT 0250Q, EP 1357); a wide room with many doors is not (IT 0157)
  assert.match(circulationRule(room('0250Q', 889, 88), ev([...Array(19).keys()], [0])), /^hall serving 19 spaces/);
  assert.equal(circulationRule(room('0157', 1550, 202), ev([...Array(11).keys()], [0])), null);
  // a narrow passage joining two hallways (IT 0112)
  assert.match(circulationRule(room('0112', 179, 49), ev([1, 2, 3, 4], [1, 2])), /^narrow passage/);
  assert.ok(isCirculationNumber('1300') && isCirculationNumber('2300R') && !isCirculationNumber('1357'));
  assert.ok(convexity([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]) < 0.9, 'an L');
  assert.equal(convexity([[0, 0], [2, 0], [2, 1], [0, 1]]), 1);
});

test('passage evidence counts distinct neighbors, hallway neighbors, doors and exterior doors', () => {
  const fp = { rooms: [room('a', 100, 50), room('b', 100, 50, { type: 'corridor' }), room('c', 100, 50)] };
  const e = passageEvidence(fp, [
    { a: 0, b: 1, kind: 'door' },
    { a: 0, b: 1, kind: 'door' },
    { a: 0, b: 2, kind: 'area-line' },
    { a: 0, b: -1, kind: 'door' },
  ]).get(0);
  assert.deepEqual([e.neighbors.size, e.hallways.size, e.doors, e.open, e.exterior], [2, 1, 3, 1, 1]);
});

test('stable ids: unchanged nodes and edges keep their ids, new ones number on, rerunning is a fixed point', () => {
  const mk = (id, type, x, y, roomId = '') => ({ id, type, x, y, roomId, p: [x, y] });
  const fresh = () => {
    const nodes = [mk('t1', 'room', 0, 0, 'r1'), mk('t2', 'door', 5, 0), mk('t3', 'waypoint', 9, 9), mk('t4', 'entrance', 10, 0)];
    const edges = [{ from: nodes[0], to: nodes[1] }, { from: nodes[1], to: nodes[2] }, { from: nodes[2], to: nodes[3] }];
    return { nodes, edges };
  };
  const a = fresh();
  assignIds(a.nodes, a.edges, 'x-1');
  assert.deepEqual(a.nodes.map((x) => x.id), ['x-1-n0001', 'x-1-n0002', 'x-1-n0003', 'x-1-n0004'], 'dense without a previous graph');
  const previous = { nodes: a.nodes.map((x) => ({ id: x.id, type: x.type, x: x.x, y: x.y, roomId: x.roomId })), edges: a.edges.map((e) => ({ id: e.id, from: e.from.id, to: e.to.id })) };
  // Now room r1 became a hallway: its hub is gone, two waypoints are new, the rest is unchanged.
  const nodes = [mk('u1', 'waypoint', 1, 1), mk('u2', 'door', 5, 0), mk('u3', 'waypoint', 9, 9), mk('u4', 'waypoint', 2, 2), mk('u5', 'entrance', 10, 0)];
  const edges = [{ from: nodes[0], to: nodes[3] }, { from: nodes[3], to: nodes[1] }, { from: nodes[1], to: nodes[2] }, { from: nodes[2], to: nodes[4] }];
  assignIds(nodes, edges, 'x-1', previous);
  assert.deepEqual(nodes.map((x) => x.id), ['x-1-n0005', 'x-1-n0002', 'x-1-n0003', 'x-1-n0006', 'x-1-n0004']);
  assert.deepEqual(edges.map((e) => e.id), ['x-1-e0004', 'x-1-e0005', 'x-1-e0002', 'x-1-e0003']);
  // rerun on its own output: nothing moves
  const again = { nodes: nodes.map((x) => ({ id: x.id, type: x.type, x: x.x, y: x.y, roomId: x.roomId })), edges: edges.map((e) => ({ id: e.id, from: e.from.id, to: e.to.id })) };
  const n2 = nodes.map((x) => ({ ...x, id: 'tmp' + x.id }));
  const e2 = edges.map((e) => ({ from: n2[nodes.indexOf(e.from)], to: n2[nodes.indexOf(e.to)] }));
  assignIds(n2, e2, 'x-1', again);
  assert.deepEqual(n2.map((x) => x.id), nodes.map((x) => x.id));
  assert.deepEqual(e2.map((e) => e.id), edges.map((e) => e.id));
});

test('access of graph nodes: entrances carry their own, doors and waypoints main, hubs none', () => {
  assert.equal(accessOf({ type: 'entrance', access: 'emergency' }), 'emergency');
  assert.equal(accessOf({ type: 'door' }), 'main');
  assert.equal(accessOf({ type: 'waypoint' }), 'main');
  assert.equal(accessOf({ type: 'room' }), '');
  assert.equal(accessOf({ type: 'stair' }), '');
});

test('committed floor data: corridors are main, doors/entrances/waypoints classed, candidates listed with evidence', () => {
  const counts = {};
  for (const f of FLOORS) {
    const j = readJson(`data/floorplans/${f.floorId}.json`);
    for (const r of j.rooms) {
      counts[r.type] = (counts[r.type] || 0) + 1;
      assert.equal(r.access, r.type === 'corridor' ? 'main' : undefined, r.id);
    }
    for (const n of j.nav.nodes) {
      if (n.type === 'door' || n.type === 'waypoint') assert.equal(n.access, 'main', n.id);
      else if (n.type === 'entrance') assert.ok(['alt', 'emergency'].includes(n.access), n.id);
      else assert.equal(n.access, undefined, n.id);
    }
  }
  assert.equal(counts.corridor, 58, '44 in v4 plus 14 typed by the circulation rules');
  const report = readJson('data/floorplans/pipeline-report.json');
  assert.equal(Object.values(report.circulation).flat().length, 14);
  const c = readJson('data/review/corridor-candidates.json');
  assert.ok(c.candidates.length >= 10);
  const rooms = new Map(FLOORS.flatMap((f) => readJson(`data/floorplans/${f.floorId}.json`).rooms.map((r) => [r.id, r])));
  for (const x of c.candidates) {
    assert.deepEqual(Object.keys(x), ['roomId', 'number', 'label', 'floorId', 'areaSqFt', 'confidence', 'evidence']);
    assert.equal(rooms.get(x.roomId).type, 'other', `${x.roomId} is still other`);
    assert.ok(x.confidence >= 0.35 && x.confidence <= 1 && x.evidence.length >= 1);
    assert.ok(!/-3$/.test(x.floorId), 'public floors only');
  }
});
