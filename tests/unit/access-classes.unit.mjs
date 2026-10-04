// v5 access classes (plan mscn-v5-access-classes-and-editors) in the app's route engine, on small synthetic graphs:
// main doors, hallways and paths at their length, alt ones at their length times the alt factor (default 3) plus a
// fixed cost for each alt door passed through (default 300 m), emergency never walked; the "Use side doors and paths"
// toggle passes factor 1 and door cost 0. Also the route panel's own use of them (WebApp_Route, run in a VM as
// route-plan.unit.mjs does).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { SRC, loadInclude, scriptBodies } from './load-include.mjs';

const P = loadInclude('WebApp_Pathfinding.html', 'MSCNPath');

const FLOOR = { id: 'f1', buildingId: 'B', level: 1, label: 'First Floor', metersPerPixel: 1 };
const node = (id, type, extra = {}) => ({ id, floorId: 'f1', type, x: 0, y: 0, ...extra });
const edge = (from, to, distance, extra = {}) => ({ id: `${from}-${to}`, fromNodeId: from, toNodeId: to, distance, ...extra });

// Room r1 to room r2 three ways: a main hallway (m1, m2) of `main` meters, an alt hallway (waypoint a1) of `alt`
// meters, and an emergency hallway (e1) of 2 meters that must never be taken.
function hallways({ main = 25, alt = 10, withMain = true, withAlt = true } = {}) {
  const navNodes = [node('r1', 'room', { roomId: 'R1' }), node('r2', 'room', { roomId: 'R2' }), node('e1', 'waypoint', { access: 'emergency' })];
  const navEdges = [edge('r1', 'e1', 1), edge('e1', 'r2', 1)];
  if (withMain) {
    navNodes.push(node('m1', 'waypoint'), node('m2', 'waypoint', { access: 'main' }));
    navEdges.push(edge('r1', 'm1', main / 3), edge('m1', 'm2', main / 3), edge('m2', 'r2', main / 3));
  }
  if (withAlt) {
    navNodes.push(node('a1', 'waypoint', { access: 'alt' }));
    navEdges.push(edge('r1', 'a1', alt / 2), edge('a1', 'r2', alt / 2));
  }
  return P.buildGraph({ floors: [FLOOR], navNodes, navEdges });
}

const via = (r) => Array.from(r.nodeIds).slice(1, -1).join(',');

test('accessOf: the access field, else main (the retired v4 primary flag is not read)', () => {
  assert.equal(P.accessOf({ type: 'door', access: 'emergency' }), 'emergency');
  assert.equal(P.accessOf({ type: 'entrance', access: 'alt', primary: true }), 'alt');
  assert.equal(P.accessOf({ nodeId: 'x', access: 'alt' }), 'alt', 'a buildings[].entrances entry');
  assert.equal(P.accessOf({ type: 'entrance', primary: false }), 'main');
  assert.equal(P.accessOf({ type: 'entrance' }), 'main');
  assert.equal(P.accessOf({ type: 'waypoint' }), 'main');
  assert.equal(P.accessOf({ type: 'door', access: 'bogus' }), 'main');
  assert.equal(P.accessOf(null), 'main');
  assert.equal(P.DEFAULT_ALT_FACTOR, 3);
  assert.equal(P.DEFAULT_ALT_DOOR_COST, 300);
});

test('alt factor: the main route wins when it is longer than the alt shortcut by less than the factor', () => {
  const r = P.findPath(hallways({ main: 25, alt: 10 }), 'r1', 'r2');
  assert.equal(via(r), 'm1,m2');
  assert.ok(Math.abs(r.distance - 25) < 1e-9, 'distance stays meters');
  assert.ok(Math.abs(r.cost - 25) < 1e-9);
});

test('alt factor: the alt shortcut wins when the main route is longer by more than the factor', () => {
  const r = P.findPath(hallways({ main: 40, alt: 10 }), 'r1', 'r2');
  assert.equal(via(r), 'a1');
  assert.ok(Math.abs(r.distance - 10) < 1e-9, 'meters walked');
  assert.ok(Math.abs(r.cost - 30) < 1e-9, 'priced at 3x');
  // the factor is per route: 5x keeps the main route, and a factor below 1 is read as 1
  assert.equal(via(P.findPath(hallways({ main: 40, alt: 10 }), 'r1', 'r2', { altFactor: 5 })), 'm1,m2');
  assert.equal(P.findPath(hallways({ main: 40, alt: 10 }), 'r1', 'r2', { altFactor: 0.2 }).cost, 10);
});

test('alt only: with no main way the alt hallway is used', () => {
  assert.equal(via(P.findPath(hallways({ withMain: false }), 'r1', 'r2')), 'a1');
});

test('the toggle (factor 1) puts the shorter alt way on the route', () => {
  const g = hallways({ main: 25, alt: 10 });
  assert.equal(via(P.findPath(g, 'r1', 'r2')), 'm1,m2');
  assert.equal(via(P.findPath(g, 'r1', 'r2', { altFactor: 1 })), 'a1');
});

test('emergency: never on a route, even as the shortest way; alone it means no route, unless asked', () => {
  for (const altFactor of [1, 3]) {
    for (const r of [P.findPath(hallways(), 'r1', 'r2', { altFactor }), P.findPath(hallways({ withAlt: false }), 'r1', 'r2', { altFactor })]) {
      assert.ok(!r.nodeIds.includes('e1'), via(r));
    }
  }
  const only = hallways({ withMain: false, withAlt: false });
  assert.equal(P.findPath(only, 'r1', 'r2'), null);
  assert.equal(P.findPath(only, 'r1', 'r2', { altFactor: 1 }), null, 'the toggle does not open emergency');
  assert.equal(via(P.findPath(only, 'r1', 'r2', { allowEmergency: true })), 'e1', 'only to tell the visitor why');
  // as the route's own start or goal (a code scanned at an emergency door) it is allowed, and left by the shortest way
  assert.deepEqual(Array.from(P.findPath(only, 'e1', 'r2').nodeIds), ['e1', 'r2']);
  assert.deepEqual(Array.from(P.findPath(only, 'r1', 'e1').nodeIds), ['r1', 'e1']);
});

test('emergency: a start inside an emergency hallway walks out of it, then never back in', () => {
  const g = P.buildGraph({
    floors: [FLOOR],
    navNodes: [node('x', 'door', { access: 'emergency' }), node('y', 'waypoint', { access: 'emergency' }), node('h', 'waypoint'),
      node('z', 'waypoint', { access: 'emergency' }), node('goal', 'room', { roomId: 'G' }), node('w', 'waypoint')],
    navEdges: [edge('x', 'y', 3), edge('y', 'h', 3), edge('h', 'z', 1), edge('z', 'goal', 1), edge('h', 'w', 5), edge('w', 'goal', 5)],
  });
  assert.deepEqual(Array.from(P.findPath(g, 'x', 'goal').nodeIds), ['x', 'y', 'h', 'w', 'goal']);
});

test('nodesForRoom and entranceIds leave emergency doors out when the room or building has another', () => {
  const g = P.buildGraph({
    floors: [FLOOR],
    navNodes: [node('rn', 'room', { roomId: 'S' }), node('dx', 'door', { roomId: 'S', access: 'emergency' }), node('ex', 'entrance', { access: 'emergency' }),
      node('en', 'entrance', { access: 'alt' }), node('only', 'door', { roomId: 'T', access: 'emergency' })],
    navEdges: [],
  });
  assert.deepEqual(Array.from(P.nodesForRoom(g, 'S')), ['rn']);
  assert.deepEqual(Array.from(P.nodesForRoom(g, 'T')), ['only'], 'a room behind nothing but an emergency door keeps it');
  assert.deepEqual(Array.from(P.entranceIds(g, 'B')), ['en']);
});

// ---------------- doors and paths outdoors ----------------

// Building B, room r2 behind a main door dm (`mainInside` m inside, default 30), an alt door da (5 m inside) and an
// emergency door dx (1 m inside). Outside, the path node o0 reaches each door's connector in 20 m.
function campus({ withMainDoor = true, roadAlt = false, mainInside = 30 } = {}) {
  const navNodes = [node('r2', 'room', { roomId: 'R2' }), node('da', 'entrance', { access: 'alt' })];
  const navEdges = [edge('da', 'r2', 5)];
  if (withMainDoor) { navNodes.push(node('dm', 'entrance', { access: 'main' })); navEdges.push(edge('dm', 'r2', mainInside)); }
  navNodes.push(node('dx', 'entrance', { access: 'emergency' }));
  navEdges.push(edge('dx', 'r2', 1));
  const at = (id, lng) => ({ id, lat: 36.6, lng, type: id[0] === 'o' ? 'path' : 'entrance' });
  const outdoor = {
    nodes: [at('o0', -88.3), at('o1', -88.3001)].concat(navNodes.filter((n) => n.type === 'entrance').map((n, i) => at(n.id, -88.3002 - i * 0.0001))),
    edges: [{ id: 'p', from: 'o0', to: 'o1', distance: 10, accessible: true, kind: roadAlt ? 'road' : 'footway', ...(roadAlt ? { access: 'alt' } : {}) }]
      .concat(navNodes.filter((n) => n.type === 'entrance').map((n) => ({ id: 'c-' + n.id, from: 'o1', to: n.id, distance: 10, accessible: true, kind: 'connector' }))),
  };
  return P.addOutdoorGraph(P.buildGraph({ floors: [FLOOR], navNodes, navEdges }), outdoor);
}

const doorOf = (r) => Array.from(r.nodeIds).find((id) => id[0] === 'd');
const stepsOf = (g, r) => P.buildRouteSteps(g, P.segmentRoute(g, r), { destination: 'R2', floorLabel: () => 'First Floor', buildingName: () => 'Hall' });

test('doors: the main door by default, the side door with the toggle, never the emergency exit', () => {
  const g = campus();
  // main: 10 + 10 + 30 = 50; alt: 10 + (10 + 5) x 3 + 300 = 355; emergency would be 21
  const r = P.findPath(g, 'o0', 'r2');
  assert.equal(doorOf(r), 'dm');
  const t = P.findPath(g, 'o0', 'r2', { altFactor: 1, altDoorCost: 0 });
  assert.equal(doorOf(t), 'da');
  const st = stepsOf(g, t);
  const enter = st.find((s) => s.kind === 'door');
  assert.match(enter.title, /^Enter by the side door\b/, enter.title);
  assert.match(st.find((s) => s.kind === 'outdoor').title, /^Walk to the side door\b/);
  assert.match(stepsOf(g, r).find((s) => s.kind === 'door').title, /^Enter by the entrance$/, 'a main door keeps its plain name');
  assert.deepEqual(Array.from(P.mainEntrances(g, 'B')), ['dm']);
  assert.deepEqual(Array.from(P.mainEntrances(g, 'B', true)).sort(), ['da', 'dm']);
  assert.ok(g.adj.dx.some((e) => e.outdoor), 'the emergency exit is joined (drawn) ...');
  assert.equal(g.outdoorEdges.find((e) => e.id === 'c-dx').access, 'emergency', '... its connector reads emergency (no snapping onto it)');
});

test('doors: with no main door the side door is used and named a side door', () => {
  const g = campus({ withMainDoor: false });
  const r = P.findPath(g, 'o0', 'r2');
  assert.equal(doorOf(r), 'da');
  assert.match(stepsOf(g, r).find((s) => s.kind === 'door').title, /^Enter by the side door/);
  assert.deepEqual(Array.from(P.mainEntrances(g, 'B')), ['da'], 'no main door: the side door is the building door');
});

test('side-door cost: a fixed cost per alt door passed through keeps the main door where the factor alone would not', () => {
  // main door 60 m inside: main 10 + 10 + 60 = 80; alt by the factor alone 10 + (10 + 5) x 3 = 55
  const g = campus({ mainInside: 60 });
  assert.equal(doorOf(P.findPath(g, 'o0', 'r2', { altDoorCost: 0 })), 'da', 'the factor alone takes the side door');
  const r = P.findPath(g, 'o0', 'r2');
  assert.equal(doorOf(r), 'dm', 'the default door cost (300) keeps the main door');
  assert.equal(r.cost, 80);
  assert.equal(doorOf(P.findPath(g, 'o0', 'r2', { altDoorCost: 20 })), 'da', '55 + 20 < 80');
  const t = P.findPath(g, 'o0', 'r2', { altDoorCost: 30 });
  assert.equal(doorOf(t), 'dm', '55 + 30 > 80');
  assert.equal(t.distance, 80, 'distance stays meters');
  // paid once per door: entering the alt door costs it, walking on from it does not (55 + 30 = 85)
  assert.equal(P.findPath(campus({ withMainDoor: false }), 'o0', 'r2', { altDoorCost: 30 }).cost, 85);
  // a route that starts at the alt door does not pay for it; a negative cost reads 0
  assert.equal(P.findPath(g, 'da', 'r2').cost, 15);
  assert.equal(P.findPath(campus({ withMainDoor: false }), 'o0', 'r2', { altDoorCost: -5 }).cost, 55);
  // alt hallways and alt paths are waypoints and edges, not doors: they take the factor only
  assert.equal(P.findPath(hallways({ withMain: false }), 'r1', 'r2').cost, 30);
});

test('outdoor alt paths: an alt edge is priced at the factor; old outdoor data (no access) reads main', () => {
  const plain = campus({ roadAlt: false });
  const road = campus({ roadAlt: true });
  assert.equal(P.findPath(plain, 'o0', 'r2').cost, 50);
  assert.equal(P.findPath(road, 'o0', 'r2').cost, 70, '10 m of road at 3x');
  assert.equal(P.findPath(road, 'o0', 'r2').distance, 50);
  assert.equal(road.outdoorEdges.find((e) => e.id === 'p').access, 'alt');
  assert.equal(plain.outdoorEdges.find((e) => e.id === 'p').access, 'main');
});

test('a sole door is an alt door the main doors cannot reach indoors', () => {
  const g = campus();
  assert.equal(g.nodes.da.soleDoor, undefined, 'da is reachable from dm indoors');
  const cut = P.addOutdoorGraph(P.buildGraph({
    floors: [FLOOR],
    navNodes: [node('r2', 'room', { roomId: 'R2' }), node('dm', 'entrance', { access: 'main' }), node('da', 'entrance', { access: 'alt' }), node('r3', 'room', { roomId: 'R3' })],
    navEdges: [edge('dm', 'r2', 5), edge('da', 'r3', 5)],
  }), { nodes: [{ id: 'dm', lat: 36.6, lng: -88.3 }, { id: 'da', lat: 36.6, lng: -88.3001 }], edges: [{ id: 'x', from: 'dm', to: 'da', distance: 9 }] });
  assert.equal(cut.nodes.da.soleDoor, true);
});

// ---------------- the route panel (WebApp_Route) ----------------

const INCLUDES = ['WebApp_Core.html', 'WebApp_Search.html', 'WebApp_Geo.html', 'WebApp_Pathfinding.html', 'WebApp_Indoor.html', 'WebApp_Route.html'];
const CODE = INCLUDES.map((f) => scriptBodies(readFileSync(join(SRC, f), 'utf8')).join('\n;\n')).join('\n;\n');

function panelApp({ config = [], emergencyOnly = false } = {}) {
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  vm.runInContext(CODE, ctx, { filename: 'webapp-route' });
  const navNodes = [node('r1', 'room', { roomId: 'R1' }), node('r2', 'room', { roomId: 'R2' }), node('e1', 'waypoint', { access: 'emergency' })];
  const navEdges = [edge('r1', 'e1', 1), edge('e1', 'r2', 1)];
  if (!emergencyOnly) {
    navNodes.push(node('m1', 'waypoint'), node('a1', 'waypoint', { access: 'alt' }));
    navEdges.push(edge('r1', 'm1', 12), edge('m1', 'r2', 13), edge('r1', 'a1', 5), edge('a1', 'r2', 5));
  }
  const rooms = [{ id: 'R1', floorId: 'f1', number: '101', type: 'other' }, { id: 'R2', floorId: 'f1', number: '102', type: 'other' }];
  const data = { buildings: [{ id: 'B', name: 'Hall', entrances: [] }], floors: [FLOOR], rooms, navNodes, navEdges, config };
  const APP = vm.runInContext('APP', ctx);
  APP.data = data;
  APP.by = { rooms: Object.fromEntries(rooms.map((r) => [r.id, r])), floors: { f1: FLOOR }, buildings: { B: data.buildings[0] }, nodes: {} };
  APP.graph = ctx.MSCNPath.addOutdoorGraph(ctx.MSCNPath.buildGraph(data, {}), null);
  return ctx;
}

function planFrom(ctx, sideDoors) {
  const NAV = vm.runInContext('NAV', ctx);
  NAV.start = { kind: 'room', roomId: 'R1', label: 'Hall 101' };
  NAV.useSideDoors = sideDoors;
  NAV.avoidStairs = false;
  NAV.dest = { kind: 'room', roomId: 'R2' };
  return ctx.planRoute(NAV.dest);
}
const routeVia = (r) => r.steps.flatMap((s) => Array.from(s.nodeIds)).filter((id) => id !== 'r1' && id !== 'r2').join(',');

test('route panel: "Use side doors and paths" switches the planned route onto the alt way; emergency never', () => {
  const ctx = panelApp();
  assert.equal(routeVia(planFrom(ctx, false)), 'm1', 'main 25 m beats alt 10 m at 3x');
  assert.equal(routeVia(planFrom(ctx, true)), 'a1', 'toggle on: the shorter alt way');
  assert.equal(ctx.routeOpts().altFactor, 1);
  assert.equal(ctx.routeOpts().altDoorCost, 0, 'toggle on: no side-door cost either');
  vm.runInContext('NAV', ctx).useSideDoors = false;
  assert.equal(ctx.routeOpts().altFactor, 3);
  assert.equal(ctx.routeOpts().altDoorCost, 300);
});

test('route panel: routing.altFactor from the campus config, either config row shape', () => {
  assert.equal(routeVia(planFrom(panelApp({ config: [{ key: 'routing.altFactor', value: '2' }] }), false)), 'a1', '10 m x 2 < 25 m');
  assert.equal(panelApp({ config: [{ key: 'routing', value: '{"altFactor": 4}' }] }).configAltFactor(), 4);
  assert.equal(panelApp({ config: [{ key: 'routing.altFactor', value: 'nonsense' }] }).configAltFactor(), 3);
  assert.equal(panelApp({ config: [{ key: 'routing.altFactor', value: 0.5 }] }).configAltFactor(), 3, 'below 1 is ignored');
});

test('route panel: routing.altDoorCost from the campus config, either config row shape', () => {
  assert.equal(panelApp({ config: [{ key: 'routing.altDoorCost', value: '45' }] }).configAltDoorCost(), 45);
  assert.equal(panelApp({ config: [{ key: 'routing', value: '{"altDoorCost": 0}' }] }).configAltDoorCost(), 0);
  assert.equal(panelApp({ config: [{ key: 'routing.altDoorCost', value: 'nonsense' }] }).configAltDoorCost(), 300);
  assert.equal(panelApp({ config: [{ key: 'routing.altDoorCost', value: -1 }] }).configAltDoorCost(), 300, 'below 0 is ignored');
  assert.equal(panelApp({ config: [] }).routeOpts().altDoorCost, 300);
});

test('route panel: no route without an emergency exit says so plainly', () => {
  const r = planFrom(panelApp({ emergencyOnly: true }), true);
  assert.equal(r.steps.length, 0);
  assert.match(r.error, /^No route without an emergency exit\./);
});
