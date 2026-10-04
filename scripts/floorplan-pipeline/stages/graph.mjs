// Stage "graph": navigation nodes and edges per floor, then cross-floor links.
//   room       one hub per non-corridor room, at its pole of inaccessibility (stair / elevator for verticals)
//   waypoint   corridor centerline points (sampled medial axis, simplified), and area lines between corridors
//   door       each passage between two spaces; entrance when the other side is outside
// Doors, entrances and waypoints carry an access class (accessOf): main, alt or emergency.
// Edges: room hub <-> its doors; door <-> nearest visible point on each adjacent corridor's centerline (the
// centerline edge is split there); centerline chains; cross-floor stair/elevator links. Distances in meters.
import { dist, segmentsIntersect, round } from '../lib/geometry.mjs';
import { corridorCenterline } from '../lib/skeleton.mjs';

export const FLOOR_CHANGE_METERS = { stair: 10, elevator: 14 }; // nominal effort per floor (about 4 m storey height)
const SNAP = 18; // units: attach to an existing centerline vertex when the foot point is this close
const LOS_SKIP = 8; // units: ignore walls this close to the door point (frame and jamb lines)

function footOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { q: [a[0] + t * dx, a[1] + t * dy], t };
}

export function lineOfSight(p, q, wallIndex, skip = LOS_SKIP) {
  const L = dist(p, q);
  if (L <= skip) return true;
  const u = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
  const s = [p[0] + u[0] * skip, p[1] + u[1] * skip];
  const e = [q[0] - u[0] * 1, q[1] - u[1] * 1];
  const bb = { minX: Math.min(s[0], e[0]), minY: Math.min(s[1], e[1]), maxX: Math.max(s[0], e[0]), maxY: Math.max(s[1], e[1]) };
  return !wallIndex.query(bb).some((sg) => segmentsIntersect(s, e, sg[0], sg[1]));
}

export function buildFloorGraph(fp, openings, wallIndex, { idPrefix, previous = null }) {
  const mpu = fp.units.metersPerUnit;
  const nodes = [];
  const edges = [];
  const edgeSet = new Set();
  const addNode = (type, p, roomId = '', linkId = '') => {
    const n = { id: `${idPrefix}-n${String(nodes.length + 1).padStart(4, '0')}`, type, x: round(p[0], 1), y: round(p[1], 1), p, roomId, linkId };
    nodes.push(n);
    return n;
  };
  const addEdge = (a, b) => {
    if (a === b) return;
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    edges.push({ from: a, to: b, distance: round(dist(a.p, b.p) * mpu, 2), floorChange: false, accessible: true });
  };
  const removeEdge = (a, b) => {
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (!edgeSet.delete(k)) return;
    const i = edges.findIndex((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    if (i >= 0) edges.splice(i, 1);
  };

  // Which spaces get a centerline: corridors always; any other room whose straight hub-to-passage lines are not all
  // clear of walls (long, L-shaped or partitioned rooms), so routes follow the walkable space instead of cutting
  // through walls.
  const openingsOf = new Map();
  for (const o of openings) {
    for (const idx of [o.a, o.b]) {
      if (idx < 0) continue;
      if (!openingsOf.has(idx)) openingsOf.set(idx, []);
      openingsOf.get(idx).push(o);
    }
  }
  const walkable = new Set();
  fp.rooms.forEach((r, i) => {
    if (r.kind !== 'room') return;
    if (r.type === 'corridor') walkable.add(i);
    else if ((openingsOf.get(i) || []).some((o) => !lineOfSight(o.p, r.center, wallIndex))) walkable.add(i);
  });

  // Room hubs.
  const hub = new Map();
  fp.rooms.forEach((r, i) => {
    if (r.kind !== 'room' || r.type === 'corridor') return;
    const type = r.type === 'stair' || r.type === 'elevator' ? r.type : 'room';
    hub.set(i, addNode(type, r.center, r.id, r.linkId || ''));
  });

  // Centerlines.
  const cl = new Map(); // room index -> { nodes:[node], segs:[[node,node]] }
  for (const i of walkable) {
    const r = fp.rooms[i];
    const c = corridorCenterline(r.polygon);
    const cn = c.points.map((p) => addNode('waypoint', p));
    const segs = [];
    for (const [a, b] of c.segs) {
      addEdge(cn[a], cn[b]);
      segs.push([cn[a], cn[b]]);
    }
    if (!segs.length) {
      const only = hub.get(i) || (cn.length ? cn[0] : addNode('waypoint', r.center));
      cl.set(i, { nodes: [only], segs: [], solo: only });
    } else cl.set(i, { nodes: cn, segs });
  }

  // Attach a point to a corridor centerline: nearest visible foot point; split the centerline edge there.
  const attach = (ci, node) => {
    const c = cl.get(ci);
    if (c.solo) {
      addEdge(node, c.solo);
      return true;
    }
    const cands = c.segs.map((s) => ({ s, ...footOnSegment(node.p, s[0].p, s[1].p) })).map((x) => ({ ...x, d: dist(node.p, x.q) }));
    cands.sort((x, y) => x.d - y.d);
    for (const cand of cands.slice(0, 6)) {
      if (!lineOfSight(node.p, cand.q, wallIndex)) continue;
      const [a, b] = cand.s;
      if (cand.d < 2 && dist(node.p, a.p) >= 1 && dist(node.p, b.p) >= 1) {
        // The node already lies on the centerline (a room hub on its own room's axis): splice it in.
        removeEdge(a, b);
        addEdge(a, node);
        addEdge(node, b);
        c.segs.splice(c.segs.indexOf(cand.s), 1, [a, node], [node, b]);
        c.nodes.push(node);
        return true;
      }
      let target;
      if (dist(cand.q, a.p) <= SNAP) target = a;
      else if (dist(cand.q, b.p) <= SNAP) target = b;
      else {
        target = addNode('waypoint', cand.q);
        removeEdge(a, b);
        addEdge(a, target);
        addEdge(target, b);
        c.segs.splice(c.segs.indexOf(cand.s), 1, [a, target], [target, b]);
        c.nodes.push(target);
      }
      addEdge(node, target);
      return true;
    }
    // Nothing visible: fall back to the nearest centerline vertex (flagged by the caller's report).
    let bestN = c.nodes[0];
    for (const n of c.nodes) if (dist(n.p, node.p) < dist(bestN.p, node.p)) bestN = n;
    addEdge(node, bestN);
    return false;
  };

  let blindAttach = 0;
  // Room hubs inside walkable rooms join that room's centerline.
  for (const i of walkable) {
    if (!hub.has(i) || cl.get(i).solo === hub.get(i)) continue;
    if (!attach(i, hub.get(i))) blindAttach++;
  }
  for (const o of openings) {
    const ra = fp.rooms[o.a];
    const rb = o.b >= 0 ? fp.rooms[o.b] : null;
    const corrA = ra.type === 'corridor';
    const corrB = rb && rb.type === 'corridor';
    let type = o.exterior ? 'entrance' : 'door';
    if (o.kind === 'area-line' && corrA && corrB) type = 'waypoint';
    const n = addNode(type, o.p);
    // Access class (v5): an exterior door out of a stairwell is a stair-tower exit (emergency); any other exterior
    // door is alt until the campus-map build picks the main ones; interior doors are main.
    if (type === 'entrance') n.access = ra.type === 'stair' ? 'emergency' : 'alt';
    n.opening = o;
    o.nodeId = n.id;
    for (const idx of [o.a, o.b]) {
      if (idx < 0) continue;
      if (walkable.has(idx)) {
        if (!attach(idx, n)) blindAttach++;
      } else if (hub.has(idx)) addEdge(n, hub.get(idx));
    }
  }

  // Doors with a single edge that sit on an area line between a room hub and nothing else are fine; drop isolated
  // waypoints that ended up with no edges (degenerate centerline fragments).
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.from.id, (deg.get(e.from.id) || 0) + 1);
    deg.set(e.to.id, (deg.get(e.to.id) || 0) + 1);
  }
  const kept = nodes.filter((n) => n.type !== 'waypoint' || deg.get(n.id));
  const remap = assignIds(kept, edges, idPrefix, previous);
  for (const o of openings) if (o.nodeId) o.nodeId = remap.get(o.nodeId) || o.nodeId;
  return { nodes: kept, edges, hub, blindAttach };
}

/**
 * Node and edge ids. Without a previous graph they are dense in creation order (`it-1-n0001`...). With one (the
 * committed floor JSON's nav block) every node that is still there keeps its id: a room's hub (room, stair, elevator)
 * by its roomId, any other node by type and position. New nodes and edges take ids after the highest previous one.
 * Ids are what overrides, QR locations and the outdoor graph hold, so a change of room typing (which adds or removes
 * nodes) must not renumber the rest of the floor. Rerunning on its own output gives the same ids.
 * @return {Map} creation id -> final id
 */
export function assignIds(nodes, edges, idPrefix, previous) {
  const pad = (k) => String(k).padStart(4, '0');
  const remap = new Map();
  if (!previous || !previous.nodes || !previous.nodes.length) {
    nodes.forEach((n, i) => {
      const id = `${idPrefix}-n${pad(i + 1)}`;
      remap.set(n.id, id);
      n.id = id;
    });
    edges.forEach((e, i) => {
      e.id = `${idPrefix}-e${pad(i + 1)}`;
    });
    return remap;
  }
  const isHub = (t) => t === 'room' || t === 'stair' || t === 'elevator';
  const key = (n) => (isHub(n.type) && n.roomId ? `hub|${n.roomId}` : `${n.type}|${n.x}|${n.y}`);
  const num = (id, letter) => {
    const m = new RegExp(`-${letter}(\\d+)$`).exec(id);
    return m ? Number(m[1]) : 0;
  };
  const byKey = new Map();
  for (const p of previous.nodes) {
    const k = key(p);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p.id);
  }
  let nextNode = Math.max(0, ...previous.nodes.map((p) => num(p.id, 'n')));
  const fresh = [];
  for (const n of nodes) {
    const list = byKey.get(key(n));
    if (list && list.length) remap.set(n.id, list.shift());
    else fresh.push(n);
  }
  for (const n of fresh) remap.set(n.id, `${idPrefix}-n${pad(++nextNode)}`);
  for (const n of nodes) n.id = remap.get(n.id);
  const pair = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const prevEdge = new Map((previous.edges || []).map((e) => [pair(e.from, e.to), e.id]));
  let nextEdge = Math.max(0, ...(previous.edges || []).map((e) => num(e.id, 'e')));
  const used = new Set();
  for (const e of edges) {
    const id = prevEdge.get(pair(e.from.id, e.to.id));
    if (id && !used.has(id)) {
      e.id = id;
      used.add(id);
    } else e.id = null;
  }
  for (const e of edges) if (!e.id) e.id = `${idPrefix}-e${pad(++nextEdge)}`;
  return remap;
}

/** The access class of a graph node: its own (entrances), main for any other door or waypoint, '' for hubs. */
export function accessOf(n) {
  if (n.access) return n.access;
  return n.type === 'door' || n.type === 'waypoint' || n.type === 'entrance' ? 'main' : '';
}

/** Connected components over nodes/edges (union-find); returns Map nodeId -> component id. */
export function components(nodes, edges) {
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const e of edges) {
    const a = find(e.from.id || e.from);
    const b = find(e.to.id || e.to);
    if (a !== b) parent.set(a, b);
  }
  const out = new Map();
  for (const n of nodes) out.set(n.id, find(n.id));
  return out;
}

