// v4 unified routing (decision mscn-v4-georeferenced-entrances-and-unified-routing) on the REAL published indoor
// graph joined with the FIXTURE outdoor graph (tests/fixtures/campus-map, lane K's stand-in for lane J's
// data/campus-map/outdoor-graph.json; swap the path below at integration to run the same tests on the real graph).
// Also MSCNGeo, the geodesy the map and GPS use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT, loadInclude } from './load-include.mjs';

const require = createRequire(import.meta.url);
const { makeRuntime } = require('../../dev/gas-runtime.cjs');
const gas = makeRuntime();
gas.ctx.initSystem();
const data = gas.run('getPublicCampusData', []);

const P = loadInclude('WebApp_Pathfinding.html', 'MSCNPath');
const G = loadInclude('WebApp_Geo.html', 'MSCNGeo');
const OUTDOOR = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'campus-map', 'data', 'campus-map', 'outdoor-graph.json'), 'utf8'));
const isPublic = (f) => !!f && P.toBool(f.public, true);

function unified() {
  const g = P.buildGraph(data, { floorFilter: isPublic });
  return P.addOutdoorGraph(g, OUTDOOR);
}
const g = unified();
const floorLabel = (id) => (data.floors.find((f) => f.id === id) || {}).label || id;
const names = (dest) => ({ floorLabel, destination: dest, doorName: (n) => (n && n.label) || 'entrance ' + n.id, buildingName: (id) => id });
const room = (id) => P.nodesForRoom(g, id);
const steps = (r, dest) => P.buildRouteSteps(g, P.segmentRoute(g, r), names(dest));
const kinds = (list) => Array.from(list).map((s) => s.kind);
const pathCost = (from, to, opts) => { const r = P.findPath(g, from, to, opts); return r ? r.distance : Infinity; };

// ---------------- MSCNGeo ----------------

test('geo: haversine, projection onto a segment, nearest edge, compass, rings', () => {
  // one degree of latitude is about 111.2 km
  assert.ok(Math.abs(G.haversine([0, 0], [0, 1]) - 111195) < 50);
  const a = [-88.32, 36.61];
  const b = G.local(a).toLngLat(100, 0); // 100 m east
  assert.ok(Math.abs(G.haversine(a, b) - 100) < 0.2);
  const p = G.local(a).toLngLat(40, 10); // 10 m north of the segment, 40 m along
  const pr = G.projectOnSegment(p, a, b);
  assert.ok(Math.abs(pr.t - 0.4) < 0.01 && Math.abs(pr.dist - 10) < 0.1);
  const far = G.local(a).toLngLat(150, 0);
  assert.equal(G.projectOnSegment(far, a, b).t, 1, 'clamped to the segment end');
  const edges = [{ id: 'x', a, b }, { id: 'y', a: G.local(a).toLngLat(0, 50), b: G.local(a).toLngLat(100, 50) }];
  const ne = G.nearestEdge(edges, p);
  assert.equal(ne.edge.id, 'x');
  assert.ok(Math.abs(ne.dFrom - 40) < 0.2 && Math.abs(ne.dTo - 60) < 0.2);
  assert.equal(G.nearestEdge(edges, p, (e) => e.id !== 'x').edge.id, 'y', 'accept() filters edges');
  assert.ok(Math.abs(G.distanceToLine(p, [a, b]) - 10) < 0.1);
  assert.equal(G.compass(0), 'north');
  assert.equal(G.compass(93), 'east');
  assert.equal(G.compass(225), 'south-west');
  assert.ok(Math.abs(G.bearing(a, b) - 90) < 0.1);
  const ring = G.circle(a, 20, 16);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(G.pointInRing(a, ring) && !G.pointInRing(far, ring));
  assert.equal(G.cone(a, 90, 10, 60).length, 11);
  assert.deepEqual(Array.from(G.bbox([[1, 2], [3, 0]])), [1, 0, 3, 2]);
});

// ---------------- the union ----------------

test('the outdoor graph joins the indoor graph at entrance ids; only primary doors are joined', () => {
  const it = g.nodes['it-1-n0489'];
  assert.equal(it.floorId, 'floor-it-1');
  assert.ok(P.hasLngLat(it) && it.joined, 'the indoor entrance node gained coordinates');
  assert.equal(data.navNodes.find((n) => n.id === 'it-1-n0489').lat, undefined, 'the campus data itself is not mutated');
  assert.deepEqual(Array.from(P.primaryEntrances(g, 'bld-it')).sort(), ['it-1-n0489', 'it-1-n0492', 'it-1-n0493']);
  assert.deepEqual(Array.from(P.primaryEntrances(g, 'bld-ep')).sort(), ['ep-1-n0356', 'ep-1-n0359', 'ep-1-n0363']);
  assert.ok(g.nodes['quad-hub'].outdoor);
  assert.ok(g.hasOutdoor && g.outdoorEdges.length > 20);
  // a non-primary entrance keeps its indoor edges but is not joined to the paths
  const nonPrimary = g.nodes['it-1-n0490'];
  assert.ok(nonPrimary.joined);
  assert.equal(g.adj['it-1-n0490'].some((e) => e.outdoor), false);
  const steps = g.outdoorEdges.filter((e) => e.kind === 'steps');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].accessible, false);
});

test('outdoor only: far corner to the quad is one outdoor walk', () => {
  const r = P.findPath(g, 'far-corner', 'quad-hub');
  assert.ok(r);
  const segs = P.segmentRoute(g, r);
  assert.deepEqual(Array.from(segs, (s) => s.kind), ['outdoor']);
  const st = steps(r, 'the Quad');
  assert.deepEqual(kinds(st), ['outdoor']);
  assert.equal(st[0].title, 'Arrive at the Quad');
  assert.equal(st[0].view, 'map');
  assert.equal(st[0].coords.length, r.nodes.length);
});

test('indoor only: the unified graph routes IT 141 -> IT 241 exactly as the v3 indoor graph does', () => {
  const v3 = P.buildGraph(data, { floorFilter: isPublic });
  const a = P.findPath(v3, P.nodesForRoom(v3, 'room-it-1-0141'), P.nodesForRoom(v3, 'room-it-2-0241'));
  const b = P.findPath(g, room('room-it-1-0141'), room('room-it-2-0241'));
  assert.deepEqual(Array.from(b.nodeIds), Array.from(a.nodeIds));
  assert.equal(b.distance, a.distance);
  assert.deepEqual(kinds(steps(b, 'IT 241')), ['walk', 'walk']);
  assert.match(steps(b, 'IT 241')[0].title, /^Take the stairs up to Second Floor$/);
});

test('door to room: from the far corner to IT 241 is outdoor walk, door, indoor legs, arrival; one sentence', () => {
  const r = P.findPath(g, 'far-corner', room('room-it-2-0241'));
  assert.ok(r);
  const st = steps(r, 'IT 241');
  assert.deepEqual(kinds(st), ['outdoor', 'door', 'walk', 'walk']);
  assert.deepEqual(Array.from(st, (s) => s.view), ['map', 'indoor', 'indoor', 'indoor']);
  assert.match(st[0].title, /^Walk to the entrance it-1-n\d+ of bld-it$/);
  assert.equal(st[1].nodeId, st[2].nodeIds[0], 'the door step is where the indoor leg starts');
  assert.ok(P.primaryEntrances(g, 'bld-it').includes(st[1].nodeId), 'the walk ends at a primary door');
  assert.equal(st[1].floorId, 'floor-it-1');
  assert.equal(st[3].title, 'Arrive at IT 241');
  const sentence = P.routeSentence(st);
  assert.match(sentence, /^Walk \d+ m along the path, enter by the entrance it-1-n\d+, take the stairs up to Second Floor, arrive at IT 241\.$/);
  // the route's length counts both graphs
  const outM = st[0].distance;
  const inM = st[2].distance + st[3].distance;
  assert.ok(Math.abs(r.distance - outM - inM - stairCost(r)) < 0.01);
});

function stairCost(r) {
  let c = 0;
  for (let i = 1; i < r.nodes.length; i++) {
    const a = r.nodes[i - 1], b = r.nodes[i];
    if (!a.outdoor && !b.outdoor && a.floorId !== b.floorId) c += g.adj[a.id].find((e) => e.to === b.id).cost;
  }
  return c;
}

test('the door chosen minimizes the WHOLE walk (outdoor + indoor), not the outdoor leg alone', () => {
  const targets = ['room-ep-1-1332', 'room-ep-2-2321', 'room-ep-1-1104', 'room-it-1-0145', 'room-it-2-0241'];
  for (const t of targets) {
    const goal = room(t);
    if (!goal.length) continue;
    const r = P.findPath(g, 'far-corner', goal);
    assert.ok(r, t);
    const st = steps(r, t);
    const used = st.find((s) => s.kind === 'door').nodeId;
    const bid = P.buildingOfNode(g, used);
    let best = Infinity;
    let bestDoor = null;
    for (const d of P.primaryEntrances(g, bid)) {
      const total = pathCost('far-corner', d) + pathCost(d, goal);
      if (total < best) { best = total; bestDoor = d; }
    }
    assert.ok(Math.abs(r.distance - best) < 0.01, `${t}: ${r.distance} vs best ${best} via ${bestDoor}`);
    // and the nearest door as the crow flies is not what decides it
    const crow = P.primaryEntrances(g, bid).map((d) => [d, G.haversine(g.nodes[d], g.nodes['far-corner'])]).sort((x, y) => x[1] - y[1])[0][0];
    if (crow !== used) assert.ok(pathCost('far-corner', crow) + pathCost(crow, goal) >= r.distance - 0.01);
  }
});

test('avoid stairs applies outdoors: the steps shortcut gives way to the longer ramp', () => {
  const from = room('room-it-1-0145');
  const to = room('room-ep-1-1332');
  const any = P.findPath(g, from, to);
  const flat = P.findPath(g, from, to, { accessibleOnly: true });
  assert.ok(any && flat);
  const stepsOf = (r) => steps(r, 'EP 1332').filter((s) => s.kind === 'outdoor');
  assert.equal(stepsOf(any).some((s) => s.steps), true, 'the default route takes the steps');
  assert.match(stepsOf(any)[0].detail, /including steps/);
  assert.equal(stepsOf(flat).some((s) => s.steps), false, 'the step-free route does not');
  assert.ok(flat.distance > any.distance);
  assert.ok(Array.from(flat.nodeIds).includes('ramp-1'));
});

test('leaving one building for another: leave by a door, walk, enter by a door, arrive', () => {
  const r = P.findPath(g, room('room-it-1-0145'), room('room-ep-1-1332'));
  const st = steps(r, 'EP 1332');
  assert.deepEqual(kinds(st), ['walk', 'outdoor', 'door', 'walk']);
  assert.match(st[0].title, /^Leave by the entrance it-1-n\d+$/);
  assert.equal(st[0].exitType, 'door');
  assert.equal(st[1].entryType, 'door');
  assert.equal(st[2].buildingId, 'bld-ep');
  assert.equal(st[3].title, 'Arrive at EP 1332');
  for (const id of r.nodeIds) assert.ok(!['it-1-n0490', 'it-1-n0494', 'it-1-n0495'].includes(id), 'non-primary doors are not used');
});

test('snapping: a position beside a path starts the route with the meters to each end of the snapped edge', () => {
  const e = g.outdoorEdges.find((x) => x.from === 'far-corner' || x.to === 'far-corner');
  const L = G.local(e.a);
  const along = G.local(e.a).toXY(e.b);
  const p = L.toLngLat(along[0] * 0.3 + 6, along[1] * 0.3); // 30 % along, a few meters off
  const snap = G.nearestEdge(g.outdoorEdges, p);
  assert.equal(snap.edge.id, e.id);
  assert.ok(snap.dist < 8);
  const starts = [{ id: snap.edge.from, cost: snap.dFrom }, { id: snap.edge.to, cost: snap.dTo }];
  const r = P.findPath(g, starts, 'quad-hub');
  const plain = P.findPath(g, snap.edge.to, 'quad-hub');
  assert.ok(r.startCost > 0);
  assert.ok(Math.abs(r.distance - (r.startCost + pathCost(r.nodeIds[0], 'quad-hub'))) < 0.01);
  assert.ok(r.distance <= plain.distance + snap.dTo + 0.01);
  // goal costs work the same way: a map point beside a path
  const g2 = P.findPath(g, 'quad-hub', [{ id: snap.edge.from, cost: snap.dFrom }, { id: snap.edge.to, cost: snap.dTo }]);
  assert.ok(g2.goalCost > 0 && Math.abs(g2.distance - r.distance) < 0.01, 'symmetric');
});

test('no outdoor graph: addOutdoorGraph with nothing leaves the v3 graph usable', () => {
  const v = P.addOutdoorGraph(P.buildGraph(data, { floorFilter: isPublic }), null);
  assert.equal(v.hasOutdoor, false);
  assert.deepEqual(Array.from(P.primaryEntrances(v, 'bld-it')), []);
  assert.ok(P.findPath(v, P.nodesForRoom(v, 'room-it-1-0141'), P.nodesForRoom(v, 'room-it-2-0241')));
});
