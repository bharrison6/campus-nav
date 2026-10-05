// v4 unified routing (decision mscn-v4-georeferenced-entrances-and-unified-routing) on the REAL campus: the published
// indoor data (scripts/data/export-campus-data.mjs, what the site serves as data/campus.json) joined with the committed
// outdoor graph (data/campus-map/outdoor-graph.json, npm run campus-map) by the app's own engine (MSCNPath). Also
// MSCNGeo, the geodesy the map and GPS use. The main doors are the ones the primary-entrance heuristic chose (lane J,
// plan mscn-v4-campus-map-2-5d); since v5 the other exterior doors are joined too, as alt (side) doors, and since v5.1
// (plan mscn-v5-1-route-choice-and-private-floors) a route takes one when the confusion it saves indoors (stairs,
// turns, junctions, rooms walked through) and the walking together outweigh the side-door cost, or nothing main gets
// there. FRONT is Front door only: every joined side door avoided.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadInclude } from './load-include.mjs';
import { buildExport } from '../../scripts/data/export-campus-data.mjs';

const data = buildExport().campus;
const P = loadInclude('WebApp_Pathfinding.html', 'MSCNPath');
const G = loadInclude('WebApp_Geo.html', 'MSCNGeo');
const OUTDOOR = JSON.parse(readFileSync(join(ROOT, 'data', 'campus-map', 'outdoor-graph.json'), 'utf8'));
const MAIN = {
  'bld-it': ['it-1-n0490', 'it-1-n0492', 'it-2-n0552', 'it-2-n0554'],
  'bld-ep': ['ep-1-n0358', 'ep-1-n0362', 'ep-1-n0363'],
};

const unified = (outdoor = OUTDOOR) => P.addOutdoorGraph(P.buildGraph(data, {}), outdoor);
const g = unified();
const ll = (n) => [Number(n.lng), Number(n.lat)];
// The far corner: the outdoor node farthest from the IT/EP area (about 2 km out); the hub: the path node nearest the
// midpoint between IT's east terrace door and EP's south-east door. Both derived, since path node ids are generated.
const CENTER = [-88.322, 36.6155];
const FAR = OUTDOOR.nodes.reduce((b, n) => (G.haversine(CENTER, ll(n)) > G.haversine(CENTER, ll(b)) ? n : b)).id;
const MID = [(g.nodes['it-2-n0554'].lng + g.nodes['ep-1-n0362'].lng) / 2, (g.nodes['it-2-n0554'].lat + g.nodes['ep-1-n0362'].lat) / 2];
const HUB = OUTDOOR.nodes.filter((n) => n.type !== 'entrance').reduce((b, n) => (G.haversine(MID, ll(n)) < G.haversine(MID, ll(b)) ? n : b)).id;

const floorLabel = (id) => (data.floors.find((f) => f.id === id) || {}).label || id;
const names = (dest) => ({ floorLabel, destination: dest, doorName: (n) => (n && n.label) || 'entrance ' + n.id, buildingName: (id) => id });
const room = (id, graph = g) => P.nodesForRoom(graph, id);
const steps = (r, dest, graph = g) => P.buildRouteSteps(graph, P.segmentRoute(graph, r), names(dest));
const kinds = (list) => Array.from(list).map((s) => s.kind);
const pathCost = (from, to, opts) => { const r = P.findPath(g, from, to, opts); return r ? r.distance : Infinity; };
const pathWeight = (from, to, opts) => { const r = P.findPath(g, from, to, opts); return r ? r.cost : Infinity; };
const isDoorOk = (graph, id) => P.accessOf(graph.nodes[id]) === 'main' || graph.nodes[id].soleDoor === true;
const FRONT = { avoidNodes: Object.fromEntries(Object.values(g.entrances).flat().filter((id) => P.accessOf(g.nodes[id]) === 'alt').map((id) => [id, true])) };
const W = P.DEFAULTS;
const confusion = (r) => { const c = P.routeConfusion(g, r); return c.turns * W.turnCost + c.floorChanges * W.floorChangeCost + c.junctions * W.junctionCost + c.rooms * W.roomCost; };

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

test('the outdoor graph joins the indoor graph at entrance ids; main doors are offered, side and sole doors kept', () => {
  const it = g.nodes['it-1-n0492'];
  assert.equal(it.floorId, 'floor-it-1');
  assert.ok(P.hasLngLat(it) && it.joined, 'the indoor entrance node gained coordinates');
  assert.ok(G.haversine(CENTER, ll(g.nodes[FAR])) > 1500, 'the far corner is across town');
  for (const [bid, ids] of Object.entries(MAIN)) assert.deepEqual(Array.from(P.mainEntrances(g, bid)).sort(), ids.slice().sort(), bid);
  assert.ok(g.nodes[HUB].outdoor);
  assert.ok(g.hasOutdoor && g.outdoorEdges.length > 2000);
  // EP 1322 opens only to the outside (ep-1-n0365, alt): that door stays joined, flagged soleDoor, and is not
  // offered as the building's door
  assert.equal(g.nodes['ep-1-n0365'].soleDoor, true);
  assert.equal(g.adj['ep-1-n0365'].some((e) => e.outdoor), true);
  assert.equal(P.mainEntrances(g, 'bld-ep').includes('ep-1-n0365'), false);
  // v5: an alt door the main doors reach indoors (EP's ep-1-n0356) is joined as a side door, priced at the alt factor
  // plus the side-door cost
  const n0356 = data.navNodes.find((n) => n.id === 'ep-1-n0356');
  assert.equal(n0356.access, 'alt');
  assert.ok(g.nodes['ep-1-n0356'].joined);
  assert.equal(g.adj['ep-1-n0356'].some((e) => e.outdoor), true, 'joined at the alt cost');
  assert.equal(g.nodes['ep-1-n0356'].soleDoor, undefined);
  assert.equal(P.mainEntrances(g, 'bld-ep').includes('ep-1-n0356'), false, 'not offered as the building door');
  assert.equal(P.mainEntrances(g, 'bld-ep', true).includes('ep-1-n0356'), true, 'offered with side doors on');
  // the emergency exit (ep-1-n0359, out of a stair tower) is not on the paths at all
  assert.equal(OUTDOOR.nodes.some((n) => n.id === 'ep-1-n0359'), false);
  // any real steps edge is never accessible
  for (const e of g.outdoorEdges.filter((x) => x.kind === 'steps')) assert.equal(e.accessible, false, e.id);
});

test('entrance coordinates agree: the outdoor graph (what the engine joins) and campus.json (lane J export) within 1 m, same classes', () => {
  const nav = new Map(data.navNodes.map((n) => [n.id, n]));
  const ents = OUTDOOR.nodes.filter((n) => n.type === 'entrance');
  assert.ok(ents.length >= 7);
  for (const o of ents) {
    const n = nav.get(o.id);
    assert.ok(n && n.type === 'entrance', `${o.id} is a published entrance node`);
    assert.ok(G.haversine(ll(o), ll(n)) < 1, `${o.id}: graph vs campus.json ${G.haversine(ll(o), ll(n)).toFixed(2)} m`);
    assert.equal(o.access, n.access, `${o.id} access`);
    assert.ok(!('primary' in o) && !('primary' in n), `${o.id}: the retired primary flag is gone`);
    const joined = g.nodes[o.id];
    assert.ok(G.haversine(ll(joined), ll(n)) < 1, `${o.id}: the engine's joined node sits where campus.json says`);
    assert.equal(joined.access, n.access, `${o.id}: the engine reads access from campus.json`);
  }
  for (const b of data.buildings.filter((x) => MAIN[x.id])) {
    const listed = b.entrances.filter((e) => e.access === 'main').map((e) => e.nodeId).sort();
    assert.deepEqual(listed, MAIN[b.id].slice().sort(), `${b.id}: buildings[].entrances main`);
    for (const e of b.entrances) {
      const o = ents.find((x) => x.id === e.nodeId);
      if (o) assert.ok(G.haversine(ll(o), [e.lng, e.lat]) < 1, `${e.nodeId}: building entrance vs graph`);
    }
  }
});

test('outdoor only: the far corner to the hub between IT and EP is one outdoor walk', () => {
  const r = P.findPath(g, FAR, HUB);
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
  const v3 = P.buildGraph(data, {});
  const a = P.findPath(v3, P.nodesForRoom(v3, 'room-it-1-0141'), P.nodesForRoom(v3, 'room-it-2-0241'));
  const b = P.findPath(g, room('room-it-1-0141'), room('room-it-2-0241'));
  assert.deepEqual(Array.from(b.nodeIds), Array.from(a.nodeIds));
  assert.equal(b.distance, a.distance);
  assert.deepEqual(kinds(steps(b, 'IT 241')), ['walk', 'walk']);
  assert.match(steps(b, 'IT 241')[0].title, /^Take the stairs up to Second Floor$/);
});

test('main doors: every one is reachable from the far corner, step-free too', () => {
  for (const ids of Object.values(MAIN)) {
    for (const d of ids) {
      assert.ok(P.findPath(g, FAR, d), d);
      assert.ok(P.findPath(g, FAR, d, { accessibleOnly: true }), d + ' step-free');
    }
  }
});

test('door to room: from the far corner to IT 241 is outdoor walk, door, indoor legs, arrival; one sentence', () => {
  const r = P.findPath(g, FAR, room('room-it-2-0241'), FRONT);
  assert.ok(r);
  const st = steps(r, 'IT 241');
  const k = kinds(st);
  assert.deepEqual(k.slice(0, 2), ['outdoor', 'door']);
  assert.ok(k.slice(2).length >= 1 && k.slice(2).every((x) => x === 'walk'), k.join(','));
  assert.deepEqual(Array.from(st, (s) => s.view), ['map'].concat(k.slice(1).map(() => 'indoor')));
  assert.match(st[0].title, /^Walk to the entrance it-\d-n\d+ of bld-it$/);
  assert.equal(st[1].nodeId, st[2].nodeIds[0], 'the door step is where the indoor leg starts');
  assert.ok(MAIN['bld-it'].includes(st[1].nodeId), 'the walk ends at a main door');
  assert.equal(st[1].floorId, g.nodes[st[1].nodeId].floorId);
  assert.equal(st[st.length - 1].title, 'Arrive at IT 241');
  assert.match(P.routeSentence(st), /^Walk \d+ m along the path, enter by the entrance it-\d-n\d+, (take the (stairs|elevator) up to Second Floor, )?arrive at IT 241\.$/);
  // the route's length counts both graphs
  const outM = st[0].distance;
  const inM = st.slice(2).reduce((t, s) => t + s.distance, 0);
  assert.ok(Math.abs(r.distance - outM - inM - stairCost(r)) < 0.01);
  // the step-free variant ends at a main door as well
  const flat = P.findPath(g, FAR, room('room-it-2-0241'), { ...FRONT, accessibleOnly: true });
  assert.ok(flat && MAIN['bld-it'].includes(steps(flat, 'IT 241')[1].nodeId));
  // Best entrance (the defaults) and Any door (factor 1, no side-door cost) both take IT's level-2 side door
  // it-2-n0551: by a main door the walk climbs a stair (IT's level-1 doors are nearer the far corner) and turns more
  const best = P.findPath(g, FAR, room('room-it-2-0241'));
  const side = P.findPath(g, FAR, room('room-it-2-0241'), { altFactor: 1, sideDoorCost: 0 });
  for (const x of [best, side]) {
    const sst = steps(x, 'IT 241');
    assert.equal(sst[1].nodeId, 'it-2-n0551');
    assert.match(sst[0].title, /^Walk to the side door \(entrance it-2-n0551\) of bld-it$/);
  }
  assert.ok(best.distance < r.distance, `${best.distance} < ${r.distance}`);
  const cb = P.routeConfusion(g, best);
  const cf = P.routeConfusion(g, r);
  assert.ok(cb.floorChanges < cf.floorChanges && cb.turns < cf.turns, `simpler: ${JSON.stringify(cb)} vs ${JSON.stringify(cf)}`);
  // the side door wins on the confusion it saves: on walking alone (no confusion weights) the 300 m side-door cost
  // keeps the main door
  const plain = { turnCost: 0, floorChangeCost: 0, junctionCost: 0, roomCost: 0 };
  assert.ok(MAIN['bld-it'].includes(steps(P.findPath(g, FAR, room('room-it-2-0241'), plain), 'IT 241')[1].nodeId), 'distance alone: a main door');
});

function stairCost(r) {
  let c = 0;
  for (let i = 1; i < r.nodes.length; i++) {
    const a = r.nodes[i - 1], b = r.nodes[i];
    if (!a.outdoor && !b.outdoor && a.floorId !== b.floorId) c += g.adj[a.id].find((e) => e.to === b.id).cost;
  }
  return c;
}

test('door to room: EP 1322 is entered by its own exterior door (the sole door), from the far corner', () => {
  const r = P.findPath(g, FAR, room('room-ep-1-1322'));
  assert.ok(r);
  const st = steps(r, 'EP 1322');
  assert.deepEqual(kinds(st).slice(0, 2), ['outdoor', 'door']);
  // the last door is the room's own; the walk there may cut through EP (in by a main door, out by another), which
  // the real paths make shorter than going around the building
  const doorSteps = st.filter((s) => s.kind === 'door');
  assert.equal(doorSteps[doorSteps.length - 1].nodeId, 'ep-1-n0365');
  assert.deepEqual(kinds(st).slice(-2), ['door', 'walk']);
  for (const s of doorSteps) assert.ok(isDoorOk(g, s.nodeId), s.nodeId);
  assert.equal(st[st.length - 1].title, 'Arrive at EP 1322');
});

test('the door chosen minimizes the WHOLE walk (outdoor + indoor, as priced by class and confusion), not the outdoor leg alone', () => {
  const targets = ['room-ep-1-1332', 'room-ep-2-2321', 'room-ep-1-1104', 'room-it-1-0145', 'room-it-2-0241'];
  let checked = 0;
  const checkedDoors = new Set();
  for (const t of targets) {
    const goal = room(t);
    if (!goal.length) continue;
    const r = P.findPath(g, FAR, goal);
    assert.ok(r, t);
    const st = steps(r, t);
    const used = st.find((s) => s.kind === 'door').nodeId;
    const bid = P.buildingOfNode(g, used);
    if (P.accessOf(g.nodes[used]) !== 'main') {
      // a side door only where it is the simpler way: by a main door the indoor walk is more confusing
      const front = P.findPath(g, FAR, goal, FRONT);
      assert.ok(!front || confusion(front) > confusion(r), `${t}: ${used} saves confusion (${front && confusion(front)} vs ${confusion(r)})`);
    }
    let best = Infinity;
    let bestDoor = null;
    for (const d of P.mainEntrances(g, bid, true)) {
      // the side-door cost is paid once on the whole route, but by both legs when it is split at that door
      const total = pathWeight(FAR, d) + pathWeight(d, goal) - (P.isSideDoor(g, d) ? W.sideDoorCost : 0);
      if (total < best) { best = total; bestDoor = d; }
    }
    assert.ok(Math.abs(r.cost - best) < 0.01, `${t}: ${r.cost} vs best ${best} via ${bestDoor}`);
    // and the nearest door as the crow flies is not what decides it
    const crow = P.mainEntrances(g, bid).map((d) => [d, G.haversine(ll(g.nodes[d]), ll(g.nodes[FAR]))]).sort((x, y) => x[1] - y[1])[0][0];
    if (crow !== used) assert.ok(pathWeight(FAR, crow) + pathWeight(crow, goal) >= r.cost - 0.01);
    checkedDoors.add(P.accessOf(g.nodes[used]));
    checked++;
  }
  assert.ok(checked >= 4, 'the sample rooms exist');
  assert.deepEqual([...checkedDoors].sort(), ['alt', 'main'], 'the sample has both: main doors, and IT 241 by its side door');
});

test('avoid stairs applies outdoors: a steps shortcut is taken by default and refused step-free (synthetic steps edge)', () => {
  // The OpenStreetMap extract has no steps ways near IT/EP (lane J audit: 0 steps), so the filter is proven against a
  // synthetic steps edge added where the real IT -> EP walk makes its largest detour.
  const from = room('room-it-1-0145');
  const to = room('room-ep-1-1332');
  const base = P.findPath(g, from, to);
  assert.ok(base);
  const out = base.nodes.filter((n) => n.outdoor);
  const cum = [0];
  for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + G.haversine(ll(out[i - 1]), ll(out[i])));
  let pick = null;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 2; j < out.length; j++) {
      const crow = G.haversine(ll(out[i]), ll(out[j]));
      const detour = cum[j] - cum[i] - crow;
      if (!pick || detour > pick.detour) pick = { a: out[i].id, b: out[j].id, crow, detour };
    }
  }
  assert.ok(pick && pick.detour > 3, `the real walk has a detour to shortcut (${pick && pick.detour.toFixed(1)} m)`);
  const gs = unified({ nodes: OUTDOOR.nodes, edges: OUTDOOR.edges.concat([{ id: 'test-steps', from: pick.a, to: pick.b, distance: pick.crow, accessible: true, kind: 'steps' }]) });
  assert.equal(gs.outdoorEdges.find((e) => e.id === 'test-steps').accessible, false, 'kind steps is never accessible');
  const fromS = room('room-it-1-0145', gs);
  const toS = room('room-ep-1-1332', gs);
  const any = P.findPath(gs, fromS, toS);
  const flat = P.findPath(gs, fromS, toS, { accessibleOnly: true });
  assert.ok(any && flat);
  const outdoorSteps = (r) => steps(r, 'EP 1332', gs).filter((s) => s.kind === 'outdoor');
  assert.equal(outdoorSteps(any).some((s) => s.steps), true, 'the default route takes the steps');
  assert.match(outdoorSteps(any)[0].detail, /including steps/);
  assert.equal(outdoorSteps(flat).some((s) => s.steps), false, 'the step-free route does not');
  assert.ok(flat.distance > any.distance);
  assert.ok(Math.abs(flat.distance - P.findPath(g, from, to, { accessibleOnly: true }).distance) < 0.01, 'step-free is the real route');
});

test('leaving one building for another: leave by a door, walk, enter by a door, arrive', () => {
  const r = P.findPath(g, room('room-it-1-0145'), room('room-ep-1-1332'));
  const st = steps(r, 'EP 1332');
  const k = kinds(st);
  const o = k.indexOf('outdoor');
  assert.ok(o >= 1 && k.slice(0, o).every((x) => x === 'walk'), k.join(','));
  assert.equal(k[o + 1], 'door');
  assert.match(st[o - 1].title, /^Leave by the entrance it-\d-n\d+$/, 'a main door');
  assert.equal(st[o - 1].exitType, 'door');
  assert.equal(st[o].entryType, 'door');
  assert.equal(st[o + 1].buildingId, 'bld-ep');
  assert.equal(st[st.length - 1].title, 'Arrive at EP 1332');
  const doors = r.nodeIds.filter((id) => g.nodes[id].type === 'entrance');
  assert.ok(doors.length >= 2);
  for (const id of doors) assert.ok(isDoorOk(g, id), `${id}: only main (or sole) doors are used`);
});

test('snapping: a position beside a path starts the route with the meters to each end of the snapped edge', () => {
  const e = g.outdoorEdges.find((x) => (x.from === FAR || x.to === FAR) && x.distance > 5);
  assert.ok(e, 'an edge at the far corner');
  const L = G.local(e.a);
  const along = G.local(e.a).toXY(e.b);
  const p = L.toLngLat(along[0] * 0.3 + 2, along[1] * 0.3); // 30 % along, a couple of meters off
  const snap = G.nearestEdge(g.outdoorEdges, p);
  assert.ok(snap.dist < 8);
  const starts = [{ id: snap.edge.from, cost: snap.dFrom }, { id: snap.edge.to, cost: snap.dTo }];
  const r = P.findPath(g, starts, HUB);
  const plain = P.findPath(g, snap.edge.to, HUB);
  assert.ok(r.startCost > 0);
  assert.ok(Math.abs(r.distance - (r.startCost + pathCost(r.nodeIds[0], HUB))) < 0.01);
  assert.ok(r.distance <= plain.distance + snap.dTo + 0.01);
  // goal costs work the same way: a map point beside a path
  const g2 = P.findPath(g, HUB, [{ id: snap.edge.from, cost: snap.dFrom }, { id: snap.edge.to, cost: snap.dTo }]);
  assert.ok(g2.goalCost > 0 && Math.abs(g2.distance - r.distance) < 0.01, 'symmetric');
});

test('no outdoor graph: addOutdoorGraph with nothing leaves the v3 graph usable', () => {
  const v = P.addOutdoorGraph(P.buildGraph(data, {}), null);
  assert.equal(v.hasOutdoor, false);
  assert.deepEqual(Array.from(P.mainEntrances(v, 'bld-it')), []);
  assert.ok(P.findPath(v, P.nodesForRoom(v, 'room-it-1-0141'), P.nodesForRoom(v, 'room-it-2-0241')));
});
