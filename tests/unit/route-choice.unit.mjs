// v5.1 route choice (plan mscn-v5-1-route-choice-and-private-floors) on small synthetic graphs: the confusion score of
// an indoor walk (turns sharper than 45 degrees, floor changes, hallway junctions, rooms walked through), the side-door
// decision (a side door wins when it makes the way in simpler, not when it only saves walking), the entrance choice
// (Best entrance, Front door only, Any door, remembered per visitor) and Reroute (a locked door, a blocked path, from
// here), in the engine (MSCNPath) and in the route panel's own planning (WebApp_Route, run in a VM as
// route-plan.unit.mjs does). Real-campus numbers: unified-routing.unit.mjs, route-plan.unit.mjs, README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { SRC, loadInclude, scriptBodies } from './load-include.mjs';

const P = loadInclude('WebApp_Pathfinding.html', 'MSCNPath');
const W = P.DEFAULTS;

// metersPerPixel 1: x and y are meters
const F1 = { id: 'f1', buildingId: 'B', level: 1, label: 'First Floor', metersPerPixel: 1 };
const F2 = { id: 'f2', buildingId: 'B', level: 2, label: 'Second Floor', metersPerPixel: 1 };
const F3 = { id: 'f3', buildingId: 'B', level: 3, label: 'Third Floor', metersPerPixel: 1 };
const node = (id, type, x, y, extra = {}) => ({ id, floorId: 'f1', type, x, y, ...extra });
const edge = (from, to, distance, extra = {}) => ({ id: `${from}-${to}`, fromNodeId: from, toNodeId: to, ...(distance === undefined ? {} : { distance }), ...extra });
const graph = (navNodes, navEdges, floors = [F1]) => P.buildGraph({ floors, navNodes, navEdges });
const plain = { turnCost: 0, floorChangeCost: 0, junctionCost: 0, roomCost: 0, sideDoorCost: 0 };
const ids = (r) => Array.from(r.nodeIds).join(',');
const score = (c) => c.turns * W.turnCost + c.floorChanges * W.floorChangeCost + c.junctions * W.junctionCost + c.rooms * W.roomCost;

// ---------------- the confusion score ----------------

test('confusion: turns sharper than 45 degrees count, gentle bends and straight runs do not', () => {
  // a -> b -> c straight, c -> d a right angle, d -> e a 30-degree bend, e -> f a U-turn-ish 135 degrees
  const g = graph([node('a', 'waypoint', 0, 0), node('b', 'waypoint', 10, 0), node('c', 'waypoint', 20, 0), node('d', 'waypoint', 20, 10),
    node('e', 'waypoint', 20 + 10 * Math.sin(Math.PI / 6), 10 + 10 * Math.cos(Math.PI / 6)), node('f', 'waypoint', 10, 10)],
  [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e'), edge('e', 'f')]);
  const r = P.findPath(g, 'a', 'f', plain);
  assert.equal(ids(r), 'a,b,c,d,e,f');
  assert.deepEqual({ ...P.routeConfusion(g, r) }, { turns: 2, floorChanges: 0, junctions: 0, rooms: 0, sideDoors: 0, indoorMeters: r.distance });
  assert.equal(P.findPath(g, 'a', 'f').cost - r.distance, 2 * W.turnCost, 'priced per turn');
  // a leg shorter than 0.75 m has no direction to turn from (door swings, snapped hub links)
  const tiny = graph([node('a', 'waypoint', 0, 0), node('b', 'waypoint', 10, 0), node('c', 'door', 10, 0.5), node('d', 'waypoint', 0, 0.5)],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]);
  assert.equal(P.routeConfusion(tiny, P.findPath(tiny, 'a', 'd', plain)).turns, 0);
});

test('confusion: a stair or elevator ride is one floor change, however many floors it passes', () => {
  const g = graph([node('a', 'waypoint', 0, 0), node('s1', 'stair', 10, 0), node('s2', 'stair', 10, 0, { floorId: 'f2' }),
    node('s3', 'stair', 10, 0, { floorId: 'f3' }), node('b', 'room', 20, 0, { floorId: 'f3', roomId: 'RB' }), node('c', 'room', 20, 0, { floorId: 'f2', roomId: 'RC' })],
  [edge('a', 's1'), edge('s1', 's2', 8), edge('s2', 's3', 8), edge('s3', 'b'), edge('s2', 'c')], [F1, F2, F3]);
  const up2 = P.findPath(g, 'a', 'b');
  assert.equal(ids(up2), 'a,s1,s2,s3,b');
  assert.equal(P.routeConfusion(g, up2).floorChanges, 1, 'riding through floor 2 is the same ride');
  assert.equal(up2.cost - up2.distance, W.floorChangeCost);
  assert.equal(P.routeConfusion(g, P.findPath(g, 'a', 'c')).floorChanges, 1);
  // down and up again is two rides
  const g2 = graph([node('a', 'room', 0, 0, { floorId: 'f2', roomId: 'RA' }), node('s2', 'stair', 10, 0, { floorId: 'f2' }), node('s1', 'stair', 10, 0),
    node('h', 'waypoint', 20, 0), node('t1', 'stair', 30, 0), node('t2', 'stair', 30, 0, { floorId: 'f2' }), node('b', 'room', 40, 0, { floorId: 'f2', roomId: 'RB' })],
  [edge('a', 's2'), edge('s2', 's1', 8), edge('s1', 'h'), edge('h', 't1'), edge('t1', 't2', 8), edge('t2', 'b')], [F1, F2]);
  assert.equal(P.routeConfusion(g2, P.findPath(g2, 'a', 'b')).floorChanges, 2);
});

test('confusion: a hallway junction is where three hallway ways meet (a door off a hallway is not); rooms walked through count', () => {
  // hallway h0 - j - h2 with a branch j - h3 (a junction), and a door d off h2 (not a junction); room q in the middle
  const g = graph([node('h0', 'waypoint', 0, 0), node('j', 'waypoint', 10, 0), node('h2', 'waypoint', 20, 0), node('h3', 'waypoint', 10, 10),
    node('d', 'door', 20, 5, { roomId: 'RQ' }), node('q', 'room', 20, 10, { roomId: 'RQ' }), node('e', 'door', 30, 10, { roomId: 'RQ' }), node('z', 'waypoint', 40, 10)],
  [edge('h0', 'j'), edge('j', 'h2'), edge('j', 'h3'), edge('h2', 'd'), edge('d', 'q'), edge('q', 'e'), edge('e', 'z')]);
  const r = P.findPath(g, 'h0', 'z', plain);
  assert.equal(ids(r), 'h0,j,h2,d,q,e,z');
  const c = P.routeConfusion(g, r);
  assert.equal(c.junctions, 1, 'j only');
  assert.equal(c.rooms, 1, 'through RQ');
  assert.equal(c.turns, 2, 'into the door at h2, and out of the room at q');
  assert.equal(P.findPath(g, 'h0', 'z').cost - r.distance, score(c));
  // a room at the start or the end is not walked through
  assert.equal(P.routeConfusion(g, P.findPath(g, 'h0', 'q', plain)).rooms, 0);
});

test('confusion: the walk takes the simpler way when the detour is shorter than the turns it saves, the shorter when it is not', () => {
  // a to b: a zig-zag of 4 right angles (20 m) or a straight corridor `straight` m long
  const make = (straight) => graph([node('a', 'waypoint', 0, 0), node('z1', 'waypoint', 5, 0), node('z2', 'waypoint', 5, 5), node('z3', 'waypoint', 10, 5),
    node('z4', 'waypoint', 10, 0), node('b', 'waypoint', 15, 0), node('s1', 'waypoint', 0, -5), node('s2', 'waypoint', 15, -5)],
  [edge('a', 'z1'), edge('z1', 'z2'), edge('z2', 'z3'), edge('z3', 'z4'), edge('z4', 'b'),
    edge('a', 's1', (straight - 15) / 2), edge('s1', 's2', 15), edge('s2', 'b', (straight - 15) / 2)]);
  // zig-zag: 25 m and 4 turns (60 m); straight-ish: two turns (30 m) at a and b? no: a and b are the ends, so 2 turns
  // at s1 and s2 (30 m)
  assert.equal(ids(P.findPath(make(40), 'a', 'b')), 'a,s1,s2,b', '40 + 30 < 25 + 60');
  assert.equal(ids(P.findPath(make(40), 'a', 'b', plain)), 'a,z1,z2,z3,z4,b', 'plain meters: the short zig-zag');
  assert.equal(ids(P.findPath(make(60), 'a', 'b')), 'a,z1,z2,z3,z4,b', '60 + 30 > 25 + 60');
});

test('the shaped search finds the same routes as the plain one when every weight is 0 (one engine, two state spaces)', () => {
  const g = graph([node('a', 'room', 0, 0, { roomId: 'A' }), node('m', 'waypoint', 5, 5), node('n', 'waypoint', 10, 0), node('b', 'room', 20, 0, { roomId: 'B' })],
    [edge('a', 'm'), edge('m', 'n'), edge('a', 'n', 12), edge('n', 'b')]);
  const shaped = P.findPath(g, 'a', 'b', { ...plain, turnCost: 1e-9 });
  const flat = P.findPath(g, 'a', 'b', plain);
  assert.equal(ids(shaped), ids(flat));
  assert.ok(Math.abs(shaped.distance - flat.distance) < 1e-6);
});

// ---------------- the side-door decision ----------------

// Building B, room R. The main door M opens on floor 1, `mainApproach` m around the building from the path node p1; the
// way from M to R is `maze` (a hallway with five right-angle turns and two junctions, then a stair to floor 2, R on
// floor 2) or `straight` (one straight floor-1 hallway, R on floor 1). The side door S opens right beside R (5 m),
// 2 m from p1. The visitor walks 40 m from o0 to p1 (or 60 m by q, the way around a blocked path). X: an emergency
// exit 1 m from R, joined to p1, never used.
export function sideDoorCampus({ maze = true, mainApproach = 60 } = {}) {
  const rf = maze ? 'f2' : 'f1';
  const navNodes = [node('M', 'entrance', 0, 0, { access: 'main', label: 'Front entrance' }), node('S', 'entrance', 55, 30, { access: 'alt', floorId: rf, label: 'North entrance' }),
    node('X', 'entrance', 50, 31, { access: 'emergency', floorId: rf }), node('R', 'room', maze ? 50 : 75, maze ? 30 : 0, { floorId: rf, roomId: 'RR' })];
  const navEdges = [edge('S', 'R', 5), edge('X', 'R', 1)];
  if (maze) {
    const pts = [['a', 10, 0], ['b', 10, 10], ['c', 20, 10], ['d', 20, 20], ['e', 30, 20], ['s1', 30, 30]];
    for (const [id, x, y] of pts) navNodes.push(node(id, id === 's1' ? 'stair' : 'waypoint', x, y));
    navNodes.push(node('x1', 'waypoint', 0, 10), node('x2', 'waypoint', 10, 20), node('s2', 'stair', 30, 30, { floorId: 'f2' }), node('u', 'waypoint', 40, 30, { floorId: 'f2' }));
    navEdges.push(edge('M', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e'), edge('e', 's1'), edge('b', 'x1'), edge('d', 'x2'),
      edge('s1', 's2', 8), edge('s2', 'u'), edge('u', 'R'));
  } else {
    navNodes.push(node('a', 'waypoint', 25, 0), node('b', 'waypoint', 50, 0));
    navEdges.push(edge('M', 'a'), edge('a', 'b'), edge('b', 'R'));
  }
  const at = (id, lng, lat = 36.6) => ({ id, lat, lng, type: ['M', 'S', 'X'].includes(id) ? 'entrance' : 'path' });
  const outdoor = {
    nodes: [at('o0', -88.3), at('q', -88.3002, 36.6003), at('p1', -88.3004), at('M', -88.3010), at('S', -88.30041), at('X', -88.30042)],
    edges: [{ id: 'o0-p1', from: 'o0', to: 'p1', distance: 40, kind: 'footway' }, { id: 'o0-q', from: 'o0', to: 'q', distance: 30, kind: 'footway' },
      { id: 'q-p1', from: 'q', to: 'p1', distance: 30, kind: 'footway' }, { id: 'p1-M', from: 'p1', to: 'M', distance: mainApproach, kind: 'footway' },
      { id: 'c-S', from: 'p1', to: 'S', distance: 2, kind: 'connector' }, { id: 'c-X', from: 'p1', to: 'X', distance: 2, kind: 'connector' }],
  };
  const floors = [F1, F2];
  const data = { floors, navNodes, navEdges };
  return { data, outdoor, g: P.addOutdoorGraph(P.buildGraph(data, {}), outdoor) };
}

const doorOf = (r) => Array.from(r.nodeIds).find((id) => id === 'M' || id === 'S' || id === 'X');
const FRONT = { avoidNodes: { S: true } };

test('side door: wins when it saves real confusion (a floor change and five turns), with the walking it saves', () => {
  const { g } = sideDoorCampus({ maze: true });
  const best = P.findPath(g, 'o0', 'R');
  assert.equal(doorOf(best), 'S');
  const front = P.findPath(g, 'o0', 'R', FRONT);
  assert.equal(doorOf(front), 'M');
  const cb = P.routeConfusion(g, best);
  const cf = P.routeConfusion(g, front);
  assert.deepEqual([cf.floorChanges, cf.turns, cf.junctions], [1, 5, 2]);
  assert.deepEqual([cb.floorChanges, cb.turns, cb.junctions, cb.sideDoors], [0, 0, 0, 1]);
  // on walking alone it would not: the side-door cost is more than the 140 m it saves
  assert.equal(doorOf(P.findPath(g, 'o0', 'R', { turnCost: 0, floorChangeCost: 0, junctionCost: 0, roomCost: 0 })), 'M');
  // never the emergency exit, 1 m from the room
  assert.ok(!best.nodeIds.includes('X') && !front.nodeIds.includes('X'));
});

test('side door: loses when it only saves distance (a straight hallway from the main door)', () => {
  const { g } = sideDoorCampus({ maze: false });
  const best = P.findPath(g, 'o0', 'R');
  assert.equal(doorOf(best), 'M', 'the main door, though the side door saves 128 m');
  assert.equal(score(P.routeConfusion(g, best)), 0);
  // a far longer way round would tip it (the side-door cost is a fixed 300 m)
  assert.equal(doorOf(P.findPath(sideDoorCampus({ maze: false, mainApproach: 400 }).g, 'o0', 'R')), 'S');
  // Any door: the side door at its plain length
  assert.equal(doorOf(P.findPath(g, 'o0', 'R', { altFactor: 1, sideDoorCost: 0 })), 'S');
});

test('avoidances: a locked door and a blocked path segment are never walked; they never open an emergency exit', () => {
  const { g } = sideDoorCampus({ maze: true });
  assert.equal(doorOf(P.findPath(g, 'o0', 'R', { avoidNodes: { S: true } })), 'M', 'the next best door');
  const around = P.findPath(g, 'o0', 'R', { avoidEdges: { 'o0-p1': true } });
  assert.equal(ids(around).slice(0, 7), 'o0,q,p1', 'around the blocked segment');
  assert.equal(around.distance, P.findPath(g, 'o0', 'R').distance + 20);
  // both doors locked: no route, though the emergency exit is right there; the diagnostic still sees it
  assert.equal(P.findPath(g, 'o0', 'R', { avoidNodes: { S: true, M: true } }), null);
  assert.equal(doorOf(P.findPath(g, 'o0', 'R', { avoidNodes: { S: true, M: true }, allowEmergency: true })), 'X');
  // an avoided start or goal is no endpoint
  assert.equal(P.findPath(g, ['S'], 'R', { avoidNodes: { S: true } }), null);
  // false or missing marks avoid nothing
  assert.equal(doorOf(P.findPath(g, 'o0', 'R', { avoidNodes: { S: false }, avoidEdges: { nothing: true } })), 'S');
});

// ---------------- the route panel ----------------

const INCLUDES = ['WebApp_Core.html', 'WebApp_Search.html', 'WebApp_Geo.html', 'WebApp_Pathfinding.html', 'WebApp_Indoor.html', 'WebApp_Route.html'];
const CODE = INCLUDES.map((f) => scriptBodies(readFileSync(join(SRC, f), 'utf8')).join('\n;\n')).join('\n;\n');

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

function panel({ maze = true, ls = {} } = {}) {
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  ctx.localStorage = storage(ls);
  vm.runInContext(CODE, ctx, { filename: 'webapp-route' });
  const { data, outdoor } = sideDoorCampus({ maze });
  const rooms = [{ id: 'RR', floorId: maze ? 'f2' : 'f1', number: '201', type: 'other' }];
  const full = { ...data, buildings: [{ id: 'B', name: 'Hall', entrances: [] }], rooms, config: [] };
  const APP = vm.runInContext('APP', ctx);
  APP.data = full;
  APP.by = { rooms: { RR: rooms[0] }, floors: { f1: F1, f2: F2 }, buildings: { B: full.buildings[0] }, nodes: {} };
  APP.graph = ctx.MSCNPath.addOutdoorGraph(ctx.MSCNPath.buildGraph(full, {}), outdoor);
  ctx.toasts = [];
  ctx.toast = (m) => ctx.toasts.push(m);
  ctx.focusSoon = () => {};
  ctx.MSCNAnalytics = { track: () => {} };
  ctx.computeRoute = () => { const nav = vm.runInContext('NAV', ctx); nav.route = ctx.planRoute(nav.dest); nav.stepIndex = 0; };
  ctx.initRoute();
  const NAV = vm.runInContext('NAV', ctx);
  NAV.start = { kind: 'spot', ids: [{ id: 'o0', cost: 0 }], label: 'the path' };
  NAV.dest = { kind: 'room', roomId: 'RR' };
  return { ctx, NAV };
}

const routeDoors = (r) => Array.from(r.steps.filter((s) => s.kind === 'door'), (s) => s.nodeId);

test('panel, Best entrance: the side door that saves confusion, and its door step says why', () => {
  const { ctx, NAV } = panel();
  assert.equal(NAV.entrance, 'best', 'the default');
  const r = ctx.planRoute(NAV.dest);
  assert.equal(r.error, null);
  assert.deepEqual(routeDoors(r), ['S']);
  const door = r.steps.find((s) => s.kind === 'door');
  assert.equal(door.title, 'Enter by the side door (North entrance)');
  assert.equal(door.why, 'The side door is the simpler way in: by a main door there would be a stair or elevator ride, 5 more turns and 2 more hallway junctions, and about 140 m more walking.');
  // only distance saved: the main door, and no why anywhere
  const flat = panel({ maze: false });
  const rf = flat.ctx.planRoute(flat.NAV.dest);
  assert.deepEqual(routeDoors(rf), ['M']);
  assert.ok(rf.steps.every((s) => !s.why));
});

test('panel, Front door only: main doors only; Any door: the side door at its real length, no why', () => {
  const { ctx, NAV } = panel();
  NAV.entrance = 'front';
  const f = ctx.planRoute(NAV.dest);
  assert.deepEqual(routeDoors(f), ['M']);
  assert.ok(f.steps.every((s) => !s.why));
  assert.equal(f.entrance, 'front');
  NAV.entrance = 'any';
  const a = ctx.planRoute(NAV.dest);
  assert.deepEqual(routeDoors(a), ['S']);
  assert.ok(a.steps.every((s) => !s.why), 'every door is equal under Any door');
  const flat = panel({ maze: false });
  flat.NAV.entrance = 'any';
  assert.deepEqual(routeDoors(flat.ctx.planRoute(flat.NAV.dest)), ['S'], 'the 128 m shorter way');
});

test('panel, Front door only: a room with no way in but a side door still gets a route, and the step says so', () => {
  const { ctx, NAV } = panel();
  // the main door's hallway is cut: R is behind the side door only
  ctx.APP.graph = ctx.MSCNPath.addOutdoorGraph(ctx.MSCNPath.buildGraph({ ...ctx.APP.data, navEdges: ctx.APP.data.navEdges.filter((e) => e.id !== 'u-R') }, {}), sideDoorCampus().outdoor);
  NAV.entrance = 'front';
  const r = ctx.planRoute(NAV.dest);
  assert.equal(r.error, null);
  assert.deepEqual(routeDoors(r), ['S']);
  assert.equal(r.steps.find((s) => s.kind === 'door').why, 'Front door only: no main door leads to 201 without going through a side door, so this route uses one.');
  NAV.entrance = 'best';
  assert.equal(ctx.planRoute(NAV.dest).steps.find((s) => s.kind === 'door').why, 'This side door is the only way in.');
});

test('panel, Reroute: "This door is locked" at the door step goes to the next best door from outside it', () => {
  const { ctx, NAV } = panel();
  ctx.computeRoute();
  const at = NAV.route.steps.findIndex((s) => s.kind === 'door');
  NAV.stepIndex = at;
  const choices = Array.from(ctx.rerouteChoices(), (c) => c.id);
  assert.deepEqual(choices, ['locked'], 'a door step: the door, no path, no GPS');
  ctx.chooseReroute('locked');
  assert.deepEqual(Array.from(NAV.avoid.doors), ['S']);
  assert.equal(NAV.start.kind, 'spot');
  assert.deepEqual(Array.from(NAV.start.ids, (s) => s.id), ['p1'], 'outside the locked door');
  assert.equal(NAV.route.error, null);
  assert.deepEqual(routeDoors(NAV.route), ['M']);
  assert.equal(NAV.route.fromLabel, 'the locked door');
  assert.equal(NAV.route.marks, 'locked door');
  assert.match(ctx.toasts.at(-1), /locked/);
  // the walk to the door also offers it ("Walk to the side door ..."); the outdoor walk offers "Path blocked" too
  const { ctx: c2, NAV: n2 } = panel();
  c2.computeRoute();
  n2.stepIndex = 0;
  assert.deepEqual(Array.from(c2.rerouteChoices(), (c) => c.id), ['locked', 'blocked']);
  // and so does the step that walks out by a door
  const exitStep = { kind: 'walk', exitType: 'door', nodeIds: ['R', 'S'] };
  assert.deepEqual({ ...c2.stepDoor(exitStep) }, { id: 'S', outside: false });
});

test('panel, Reroute: every door locked says so plainly, never through the emergency exit; Clear brings the route back', () => {
  const { ctx, NAV } = panel();
  ctx.computeRoute();
  NAV.stepIndex = NAV.route.steps.findIndex((s) => s.kind === 'door');
  ctx.chooseReroute('locked');
  NAV.stepIndex = NAV.route.steps.findIndex((s) => s.kind === 'door');
  ctx.chooseReroute('locked');
  assert.deepEqual(Array.from(NAV.avoid.doors), ['S', 'M']);
  assert.equal(NAV.route.steps.length, 0);
  assert.equal(NAV.route.error, 'No route avoids the 2 locked doors you marked. Choose Reroute, then "Clear marked doors and paths", to see the route again.');
  assert.deepEqual(Array.from(ctx.rerouteChoices(), (c) => c.id), ['clear']);
  ctx.chooseReroute('clear');
  assert.equal(NAV.route.error, null);
  assert.ok(!NAV.route.steps.flatMap((s) => Array.from(s.nodeIds)).includes('X'));
  assert.equal(ctx.hasAvoid(), false);
});

test('panel, Reroute: "Path blocked" avoids the stretch ahead to the next junction and walks around it', () => {
  const { ctx, NAV } = panel();
  ctx.computeRoute();
  const before = NAV.route.meters;
  assert.equal(NAV.route.steps[0].kind, 'outdoor');
  ctx.chooseReroute('blocked');
  assert.deepEqual(Object.keys(NAV.avoid.edges), ['o0-p1'], 'o0 to p1, where three paths meet');
  assert.deepEqual(Array.from(NAV.avoid.paths, (p) => p.meters), [40]);
  assert.equal(NAV.route.error, null);
  assert.deepEqual(Array.from(NAV.route.steps[0].nodeIds).slice(0, 3), ['o0', 'q', 'p1']);
  assert.equal(NAV.route.meters, before + 20);
  assert.match(ctx.toasts.at(-1), /^Path marked blocked \(40 m\)/);
  // a new destination is a new route: the marks are gone
  ctx.newRoute({ kind: 'room', roomId: 'RR' });
  assert.equal(ctx.hasAvoid(), false);
});

test('panel, Reroute from here: offered with the blue dot on campus, restarts from it with the marks kept', () => {
  const { ctx, NAV } = panel();
  ctx.computeRoute();
  ctx.GPS = { state: 'on', fix: { lng: -88.3, lat: 36.6, raw: { lng: -88.3, lat: 36.6 }, accuracy: 5 } };
  NAV.stepIndex = 0;
  assert.deepEqual(Array.from(ctx.rerouteChoices(), (c) => c.id), ['locked', 'blocked', 'here']);
  NAV.avoid.nodes.S = true;
  NAV.avoid.doors.push('S');
  ctx.chooseReroute('here');
  assert.equal(NAV.start.kind, 'gps');
  assert.equal(NAV.route.startKind, 'gps');
  assert.equal(NAV.route.error, null);
  assert.deepEqual(routeDoors(NAV.route), ['M'], 'the locked door stays avoided');
});

test('panel: the entrance choice is remembered; v5\'s "Use side doors and paths" switch is migrated once', () => {
  assert.equal(panel({ ls: { mscnEntrance: 'front' } }).NAV.entrance, 'front');
  assert.equal(panel({ ls: { mscnEntrance: 'bogus' } }).NAV.entrance, 'best');
  const on = panel({ ls: { mscnUseSideDoors: '1' } });
  assert.equal(on.NAV.entrance, 'any');
  assert.equal(on.ctx.localStorage.map.get('mscnEntrance'), 'any');
  assert.equal(on.ctx.localStorage.map.has('mscnUseSideDoors'), false);
  const off = panel({ ls: { mscnUseSideDoors: '0' } });
  assert.equal(off.NAV.entrance, 'best');
  assert.equal(off.ctx.localStorage.map.get('mscnEntrance'), 'best');
  // storage that throws (private mode) reads as the default
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  Object.defineProperty(ctx, 'localStorage', { get() { throw new Error('denied'); } });
  vm.runInContext(CODE, ctx, { filename: 'webapp-route' });
  assert.equal(ctx.loadEntranceChoice(), 'best');
});

test('panel, Reroute: an automatic start at a door offers "This door is locked" for that door', () => {
  const { ctx, NAV } = panel();
  NAV.start = null;
  ctx.computeRoute();
  assert.equal(NAV.route.startKind, 'entrance');
  // standing at the building, no approach to save: the main door (211 m of confusion is less than the 300 m side-door cost)
  assert.equal(NAV.route.steps[0].nodeIds[0], 'M');
  assert.equal(NAV.route.fromLabel, 'the building entrance');
  assert.deepEqual({ ...ctx.stepDoor(NAV.route.steps[0]) }, { id: 'M', outside: true });
  ctx.chooseReroute('locked');
  assert.deepEqual(routeDoors(NAV.route), ['S'], 'walked around from outside it to the side door');
  assert.equal(NAV.route.fromLabel, 'the locked door');
  assert.equal(NAV.route.steps[0].kind, 'outdoor');
});
