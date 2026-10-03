// Stage "graph": navigation nodes and edges per floor, then cross-floor links.
//   room       one hub per non-corridor room, at its pole of inaccessibility (stair / elevator for verticals)
//   waypoint   corridor centerline points (sampled medial axis, simplified), and area lines between corridors
//   door       each passage between two spaces; entrance when the other side is outside
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

export function buildFloorGraph(fp, openings, wallIndex, { idPrefix }) {
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
  // Renumber ids densely so the sheet looks tidy.
  const remap = new Map();
  kept.forEach((n, i) => {
    const id = `${idPrefix}-n${String(i + 1).padStart(4, '0')}`;
    remap.set(n.id, id);
    n.id = id;
  });
  for (const o of openings) if (o.nodeId) o.nodeId = remap.get(o.nodeId) || o.nodeId;
  edges.forEach((e, i) => {
    e.id = `${idPrefix}-e${String(i + 1).padStart(4, '0')}`;
  });
  return { nodes: kept, edges, hub, blindAttach };
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

