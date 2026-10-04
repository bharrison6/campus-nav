// The app's own route planning (WebApp_Route: resolveStart, planRoute, routeOnPosition) on the REAL campus: the
// published indoor data joined with the committed outdoor graph, run through the same includes the page loads (Core,
// Search, Geo, Pathfinding, Indoor, Route) in one VM context, GPS stubbed. Engine costs are covered in
// unified-routing.unit.mjs; these check what the visitor gets: the rendered geometry and steps of a snapped start or
// goal (Codex review v4, finding 2) and the automatic start's doors (finding 3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT, SRC, scriptBodies } from './load-include.mjs';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';

const data = buildExport().campus;
const OUTDOOR = JSON.parse(readFileSync(join(ROOT, 'data', 'campus-map', 'outdoor-graph.json'), 'utf8'));
const INCLUDES = ['WebApp_Core.html', 'WebApp_Search.html', 'WebApp_Geo.html', 'WebApp_Pathfinding.html', 'WebApp_Indoor.html', 'WebApp_Route.html'];
const CODE = INCLUDES.map((f) => scriptBodies(readFileSync(join(SRC, f), 'utf8')).join('\n;\n')).join('\n;\n');

function app({ outdoor = OUTDOOR } = {}) {
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  vm.runInContext(CODE, ctx, { filename: 'webapp-route' });
  const by = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
  const APP = vm.runInContext('APP', ctx);
  APP.data = data;
  APP.by = { rooms: by(data.rooms), floors: by(data.floors), buildings: by(data.buildings) };
  APP.graph = ctx.MSCNPath.addOutdoorGraph(ctx.MSCNPath.buildGraph(data, {}), outdoor);
  ctx.advanced = [];
  ctx.goToStep = (i) => { ctx.advanced.push(i); vm.runInContext('NAV', ctx).stepIndex = i; };
  ctx.toast = () => {};
  ctx.computeRoute = () => { ctx.recomputed = (ctx.recomputed || 0) + 1; };
  return ctx;
}

const A = app();
const G = A.MSCNGeo;
const g = A.APP.graph;
const NAV = vm.runInContext('NAV', A);
const P = A.MSCNPath;

const edge = (id) => g.outdoorEdges.find((e) => e.id === id);
const midpoint = (e) => { const L = G.local(e.a); const b = L.toXY(e.b); return L.toLngLat(b[0] / 2, b[1] / 2); };
const near = (a, b, m = 0.3) => G.haversine(a, b) < m;
const fixAt = (p) => ({ lng: p[0], lat: p[1], raw: { lng: p[0], lat: p[1] }, accuracy: 5 });
const stepMeters = (r) => r.steps.reduce((s, x) => s + (x.distance || 0), 0);

function plan(ctx, dest, start = null, gps = null) {
  const nav = vm.runInContext('NAV', ctx);
  nav.start = start;
  nav.avoidStairs = false;
  ctx.GPS = gps ? { state: 'on', fix: fixAt(gps) } : undefined;
  nav.dest = dest;
  return ctx.planRoute(dest);
}

// Every step is where the one before left the visitor: outdoor walks begin where the previous outdoor walk or door
// ended, a door sits at the end of the walk to it, and nothing indoors comes before a door.
function assertConnected(r) {
  let lastLL = r.lead ? r.lead[1] : null;
  let inside = r.steps[0].kind !== 'outdoor';
  for (const s of r.steps) {
    if (s.kind === 'outdoor') {
      if (lastLL) assert.ok(near(lastLL, s.coords[0]), `step ${s.index} starts where the last one ended`);
      lastLL = s.coords[s.coords.length - 1];
      inside = false;
    } else if (s.kind === 'door') {
      assert.ok(lastLL && near(lastLL, s.coords[0]), `door step ${s.index} is at the end of the walk to it`);
      inside = true;
    } else {
      assert.ok(inside, `indoor step ${s.index} comes after a door`);
      if (s.exitType === 'door') { const d = g.nodes[s.nodeIds.at(-1)]; lastLL = [d.lng, d.lat]; }
    }
  }
  if (r.tail) assert.ok(near(lastLL, r.tail[0]), 'the tail starts where the walk ends');
}

// ---------------- finding 2: a snapped start or goal ----------------

for (const id of ['e13', 'e3', 'e5', 'e6']) {
  test(`GPS at the midpoint of ${id}: the walk starts at the blue dot, with the partial edge in its geometry and meters`, () => {
    const e = edge(id);
    assert.ok(e, `${id} is a real outdoor edge`);
    const m = midpoint(e);
    const r = plan(A, { kind: 'room', roomId: 'room-it-2-0241' }, null, m);
    assert.equal(r.error, null);
    assert.equal(r.startKind, 'gps');
    const first = r.steps[0];
    assert.equal(first.kind, 'outdoor', `${id}: a visitor on the path starts outside (${r.steps.map((s) => s.kind).join(',')})`);
    assert.ok(near(first.coords[0], m), 'the first step begins at the snapped point');
    assert.ok(r.lead && near(r.lead[1], first.coords[0]), 'the dotted lead meets the drawn walk');
    assert.ok(first.distance >= e.distance / 2 - 0.1, `the first step counts the half edge (${first.distance.toFixed(2)} m of ${e.distance})`);
    // the engine's own route from the snapped edge, stepped without its ends: the steps now add the partial edge
    const sn = A.snapToPaths(fixAt(m));
    assert.equal(sn.edge.id, id, 'the blue dot snaps onto that edge');
    const engine = P.findPath(g, sn.ids, A.resolveGoal(NAV.dest).ids);
    const bare = Array.from(P.buildRouteSteps(g, P.segmentRoute(g, engine), {}));
    assert.ok(Math.abs(engine.distance + G.haversine(r.lead[0], r.lead[1]) - r.meters) < 0.01);
    assert.ok(Math.abs(stepMeters(r) - (stepMeters({ steps: bare }) + engine.startCost)) < 0.05,
      `step meters (${stepMeters(r).toFixed(2)}) = the engine route's steps + the partial edge (${engine.startCost.toFixed(2)} m)`);
    const doorAt = r.steps.findIndex((s) => s.kind === 'door');
    assert.ok(doorAt >= 1, 'a door step before the indoor leg');
    assert.equal(r.steps[doorAt - 1].kind, 'outdoor');
    assert.equal(r.steps[doorAt - 1].exitType, 'door');
    assert.ok(near(r.steps[doorAt - 1].coords.at(-1), r.steps[doorAt].coords[0]), 'the walk ends at the door');
    assert.ok(r.steps.slice(0, doorAt).every((s) => s.kind === 'outdoor'), 'nothing indoors before the door');
    assert.equal(r.steps.at(-1).title, 'Arrive at IT 241');
    assertConnected(r);
    for (const s of r.steps) for (const nid of s.nodeIds) assert.ok(g.nodes[nid], `${nid}: step node ids are graph nodes`);
  });
}

test('a start on an entrance connector (e5): the approach to that door, then the door, then the floor plan', () => {
  const e = edge('e5');
  const r = plan(A, { kind: 'room', roomId: 'room-it-2-0241' }, null, midpoint(e));
  assert.deepEqual(Array.from(r.steps.slice(0, 2), (s) => s.kind), ['outdoor', 'door']);
  assert.equal(r.steps[1].nodeId, 'it-1-n0490', 'in by the connector\'s own door');
  assert.ok(Math.abs(r.steps[0].distance - e.distance / 2) < 0.2, `the approach is the half connector (${r.steps[0].distance.toFixed(2)} m)`);
  assert.match(r.steps[0].title, /^Walk to the .+ of /);
  assert.equal(r.steps[1].view, 'indoor');
  assert.equal(r.steps[2].kind, 'walk');
});

test('the approach step stays until the at-door logic advances it', () => {
  const e = edge('e13');
  const m = midpoint(e);
  const r = plan(A, { kind: 'room', roomId: 'room-it-2-0241' }, null, m);
  NAV.route = r;
  NAV.stepIndex = 0;
  NAV.offPath = null;
  A.advanced = [];
  A.routeOnPosition(fixAt(m));
  assert.deepEqual(A.advanced, [], 'on the walk, still on the walk');
  assert.equal(A.recomputed || 0, 0, 'on the path: no re-route');
  const doorAt = r.steps.findIndex((s) => s.kind === 'door');
  for (let i = 0; i < doorAt; i++) {
    NAV.stepIndex = i;
    A.routeOnPosition(fixAt(r.steps[i].coords.at(-1)));
  }
  assert.equal(NAV.stepIndex, doorAt, 'at the door the door step takes over');
});

test('a point destination beside a path: the walk ends at the snapped point, the tail goes on from there', () => {
  const e = edge('e13');
  const m = midpoint(e);
  const beside = G.local(m).toLngLat(4, 3);
  const r = plan(A, { kind: 'point', lng: beside[0], lat: beside[1], label: 'the bench' }, { kind: 'building', buildingId: 'bld-it' });
  assert.equal(r.error, null);
  const last = r.steps.at(-1);
  assert.equal(last.kind, 'outdoor');
  assert.equal(last.title, 'Arrive at the bench');
  assert.ok(r.tail && near(last.coords.at(-1), r.tail[0]), 'the drawn walk reaches the tail');
  assert.ok(near(r.tail[0], G.nearestEdge(g.outdoorEdges, beside).point));
  const engine = P.findPath(g, A.resolveStart(A.resolveGoal(NAV.dest)).ids, A.resolveGoal(NAV.dest).ids);
  const bare = Array.from(P.buildRouteSteps(g, P.segmentRoute(g, engine), {}));
  assert.ok(engine.goalCost > 1);
  assert.ok(Math.abs(stepMeters(r) - (stepMeters({ steps: bare }) + engine.goalCost)) < 0.05, 'the steps add the partial edge to the point');
  assertConnected(r);
});

test('a point destination on an entrance connector, from inside: leave by that door, then walk out to the point', () => {
  const e = edge('e6');
  const m = midpoint(e);
  const r = plan(A, { kind: 'point', lng: m[0], lat: m[1], label: 'the terrace' }, { kind: 'room', roomId: 'room-it-1-0101F', label: 'IT 101F' });
  assert.equal(r.error, null);
  const k = r.steps.map((s) => s.kind);
  assert.equal(k.at(-1), 'outdoor', k.join(','));
  assert.equal(k.at(-2), 'walk');
  assert.equal(r.steps.at(-2).exitType, 'door');
  assert.ok(near(r.steps.at(-1).coords.at(-1), m), 'the walk ends at the point');
  assert.ok(r.steps.at(-1).distance > 1, 'the partial connector is walked');
  assertConnected(r);
});

// ---------------- finding 3: the automatic start ----------------

const prim = (bid) => Array.from(P.primaryEntrances(g, bid)).sort();

test('resolveStart, automatic: a room\'s route starts at its building\'s primary doors (IT 101F)', () => {
  const ctx = A;
  NAV.start = null;
  ctx.GPS = undefined;
  const goal = ctx.resolveGoal({ kind: 'room', roomId: 'room-it-1-0101F' });
  const st = ctx.resolveStart(goal);
  assert.equal(st.kind, 'entrance');
  assert.deepEqual(Array.from(st.ids).sort(), prim('bld-it'));
  assert.ok(!st.ids.includes('it-1-n0489'), 'not the non-primary door beside 101F');
  const r = plan(A, { kind: 'room', roomId: 'room-it-1-0101F' });
  assert.equal(r.error, null);
  const doors = r.steps.flatMap((s) => s.nodeIds).filter((id) => g.nodes[id].type === 'entrance');
  assert.ok(doors.length && doors.every((id) => g.nodes[id].primary === true), `starts at a primary door (${doors.join(',')})`);
  assert.ok(r.meters > 1.49 + 1, `longer than the 1.49 m side-door start (${r.meters.toFixed(2)} m)`);
});

test('resolveStart, automatic: no room of IT or EP starts at a door the outdoor join closed', () => {
  NAV.start = null;
  A.GPS = undefined;
  for (const bid of ['bld-it', 'bld-ep']) {
    const rooms = data.rooms.filter((rm) => A.APP.by.floors[rm.floorId].buildingId === bid);
    for (const rm of rooms) {
      const st = A.resolveStart(A.resolveGoal({ kind: 'room', roomId: rm.id }));
      for (const id of st.ids) assert.ok(g.nodes[id].primary === true || g.nodes[id].soleDoor === true, `${rm.id}: ${id}`);
    }
  }
});

test('resolveStart, automatic: EP 1322 falls back to its sole door, which the primaries cannot reach indoors', () => {
  NAV.start = null;
  A.GPS = undefined;
  const goal = A.resolveGoal({ kind: 'room', roomId: 'room-ep-1-1322' });
  assert.equal(P.findPath(g, P.primaryEntrances(g, 'bld-ep'), goal.ids, { indoorOnly: true }), null);
  const st = A.resolveStart(goal);
  assert.deepEqual(Array.from(st.ids), ['ep-1-n0365']);
  const r = plan(A, { kind: 'room', roomId: 'room-ep-1-1322' });
  assert.equal(r.error, null);
  assert.equal(r.steps.at(-1).title, 'Arrive at EP 1322');
});

test('resolveStart: an explicit scanned or selected start is kept, even at a non-primary door', () => {
  A.GPS = undefined;
  const goal = A.resolveGoal({ kind: 'room', roomId: 'room-it-2-0241' });
  NAV.start = { kind: 'node', nodeId: 'it-1-n0489', label: 'the code by 101F' };
  assert.deepEqual(Array.from(A.resolveStart(goal).ids), ['it-1-n0489']);
  NAV.start = { kind: 'room', roomId: 'room-it-1-0101F', label: 'IT 101F' };
  assert.deepEqual(Array.from(A.resolveStart(goal).ids), Array.from(P.nodesForRoom(g, 'room-it-1-0101F')));
  NAV.start = { kind: 'building', buildingId: 'bld-ep' };
  assert.deepEqual(Array.from(A.resolveStart(goal).ids).sort(), prim('bld-ep'));
  NAV.start = null;
});

test('resolveStart without a campus map: every mapped entrance, as in v3', () => {
  const V = app({ outdoor: null });
  vm.runInContext('NAV', V).start = null;
  const goal = V.resolveGoal({ kind: 'room', roomId: 'room-it-1-0101F' });
  const st = V.resolveStart(goal);
  assert.deepEqual(Array.from(st.ids).sort(), Array.from(V.MSCNPath.entranceIds(V.APP.graph, 'bld-it')).sort());
});

// ---------------- the route panel's Start (lane O): "My location" or a search for a start ----------------
// The field's results are the top bar's own search (MSCNSearch over the same index); a picked entry becomes a
// NAV.start of the existing shapes, which resolveStart and planRoute already handle.

const INDEX = A.MSCNSearch.buildIndex(data, { floorFilter: A.isPublicFloor });
A.APP.searchIndex = INDEX;
const pick = (q) => A.MSCNSearch.search(INDEX, q, 6)[0];

function choose(start, gps = null) {
  A.tracked = [];
  A.MSCNAnalytics = { track: (name, label) => A.tracked.push([name, label]) };
  A.gpsStarted = 0;
  A.gpsStart = () => { A.gpsStarted++; };
  A.GPS = gps ? { state: 'on', fix: fixAt(gps), listeners: [] } : undefined;
  A.recomputed = 0;
  NAV.avoidStairs = false;
  NAV.dest = { kind: 'room', roomId: 'room-ep-1-1332' };
  A.setRouteStart(start);
  return A.planRoute(NAV.dest);
}

test('Start search "IT 141": the room starts the route to an EP room, and the field shows it', () => {
  const e = pick('IT 141');
  assert.equal(e.kind, 'room');
  assert.equal(e.roomId, 'room-it-1-0141');
  const s = A.startForSearchEntry(e);
  assert.deepEqual({ ...s }, { kind: 'room', roomId: 'room-it-1-0141', label: 'IT 141' });
  const r = choose(s);
  assert.equal(A.recomputed, 1, 'the route is recomputed in place');
  assert.equal(r.error, null);
  assert.equal(r.startKind, 'room');
  assert.equal(r.fromLabel, 'IT 141');
  assert.ok(P.nodesForRoom(g, 'room-it-1-0141').includes(r.steps[0].nodeIds[0]), 'the first step leaves IT 141');
  assert.equal(r.steps.at(-1).title, 'Arrive at EP 1332');
  assert.deepEqual(A.tracked, [['route_from', 'room']], 'analytics: the kind only, never the text');
  assert.equal(A.startFieldText().value, 'IT 141');
});

test('Start search "Engineering": the building starts the route at its primary doors', () => {
  // "Engineering" ties EP with E.B. Howton Agricultural Engineering (same score, alphabetical): the visitor picks EP
  const hits = A.MSCNSearch.search(INDEX, 'Engineering', 6);
  const e = hits.find((h) => h.title === 'Engineering and Physics Building');
  assert.ok(e && hits.indexOf(e) < 3, 'EP is among the first results');
  assert.equal(e.kind, 'building');
  assert.equal(e.buildingId, 'bld-ep');
  const s = A.startForSearchEntry(e);
  assert.deepEqual({ ...s }, { kind: 'building', buildingId: 'bld-ep' });
  const r = choose(s);
  assert.equal(r.error, null);
  assert.equal(r.startKind, 'building');
  assert.deepEqual(Array.from(A.resolveStart(A.resolveGoal(NAV.dest)).ids).sort(), prim('bld-ep'));
  const firstNode = g.nodes[r.steps[0].nodeIds[0]];
  assert.equal(firstNode.type, 'entrance');
  assert.equal(firstNode.primary, true, 'starts at an EP primary door');
  assert.deepEqual(A.tracked, [['route_from', 'building']]);
  assert.equal(A.startFieldText().value, 'Engineering and Physics Building');
});

test('"My location": GPS is started and the route walks from the blue dot; the field says "My location"', () => {
  const r = choose({ kind: 'gps' }, midpoint(edge('e13')));
  assert.equal(A.gpsStarted, 1);
  assert.equal(r.error, null);
  assert.equal(r.startKind, 'gps');
  assert.equal(r.steps[0].kind, 'outdoor');
  assert.deepEqual(A.tracked, [['route_from', 'gps']]);
  assert.deepEqual({ ...A.startFieldText() }, { value: 'My location', placeholder: 'My location (automatic)', kind: 'gps' });
});

test('clearing the start returns to automatic: the building entrance, said in the placeholder', () => {
  const r = choose(null);
  assert.equal(NAV.start, null);
  assert.equal(r.startKind, 'entrance');
  assert.deepEqual(A.tracked, [], 'clearing sends nothing');
  assert.deepEqual({ ...A.startFieldText() }, { value: '', placeholder: 'Building entrance (automatic)', kind: '' });
  A.GPS = { state: 'on', fix: fixAt(midpoint(edge('e13'))) };
  assert.equal(A.startFieldText().placeholder, 'My location (automatic)', 'with the blue dot on campus, automatic is my location');
  A.GPS = undefined;
});

test('a start set elsewhere (a scanned code or ?loc=, a room\'s "Set as start") shows in the field', () => {
  NAV.start = { kind: 'node', nodeId: 'it-1-n0489', label: 'IT first-floor entrance' };
  assert.deepEqual({ ...A.startFieldText() }, { value: 'IT first-floor entrance', placeholder: 'Building entrance (automatic)', kind: 'node' });
  NAV.start = { kind: 'room', roomId: 'room-it-1-0101F', label: 'IT 101F' };
  assert.equal(A.startFieldText().value, 'IT 101F');
  NAV.start = null;
});
