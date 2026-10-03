// Stage helpers for doors: assemble every passage of a floor into one list.
//   kind: 'door'       an opening with a door swing (or a door swing between two rooms in a thick wall)
//         'opening'    a wall gap with no swing (cased opening, sliding elevator door)
//         'area-line'  coincident room boundaries with no wall (an area division, not a physical door)
//         'inferred'   a room had no detectable passage; linked to its best neighbour (flagged for review)
//   exterior: true when one side is outside the building (an entrance).
import { dist, distToPolygon } from '../lib/geometry.mjs';
import { doorSwings, findOpenings, sampleRing, swingSides, MAX_WALL } from '../lib/openings.mjs';

const SWING_NEAR = 36;

export function assembleOpenings(fp, wallIndex) {
  const rooms = fp.rooms;
  const spaceIdx = rooms.map((r, i) => (r.kind === 'room' ? i : -1)).filter((i) => i >= 0);
  const spaces = spaceIdx.map((i) => rooms[i]);
  const gaps = findOpenings(spaces, wallIndex).map((o) => ({ ...o, a: spaceIdx[o.a], b: spaceIdx[o.b] }));

  const arcs = [...fp.arcs, ...fp.blockDoors.flatMap((d) => d.arcs.map((a) => ({ ...a, doorNo: d.doorNo })))];
  const swings = doorSwings(arcs, wallIndex);
  for (const sw of swings) {
    const [s1, s2] = swingSides(sw, spaces, fp.gross, wallIndex);
    const side = (s) => (s.space >= 0 ? { room: spaceIdx[s.space] } : { room: -1, exterior: !!s.outside || !s.blocked });
    sw.sides = [side(s1), side(s2)];
  }

  const out = [];
  for (const g of gaps) {
    const sw = swings.find((s) => dist(s.p, g.p) <= Math.max(SWING_NEAR, g.width / 2) && s.sides.some((x) => x.room === g.a || x.room === g.b));
    if (sw) sw.used = true;
    out.push({
      p: g.p, a: g.a, b: g.b, width: g.width, exterior: false,
      kind: sw ? 'door' : g.kind === 'coincident' ? 'area-line' : 'opening',
      doorNo: sw ? sw.doorNo : '',
    });
  }
  let entrances = 0;
  for (const sw of swings) {
    const [x, y] = sw.sides;
    if (x.room >= 0 && y.room >= 0 && x.room !== y.room) {
      const a = Math.min(x.room, y.room);
      const b = Math.max(x.room, y.room);
      if (!out.some((o) => o.a === a && o.b === b && dist(o.p, sw.p) < 48)) {
        out.push({ p: sw.p, a, b, width: sw.width, exterior: false, kind: 'door', doorNo: sw.doorNo || '' });
      }
    } else if ((x.room >= 0) !== (y.room >= 0)) {
      const inside = x.room >= 0 ? x : y;
      const other = x.room >= 0 ? y : x;
      if (other.exterior) {
        out.push({ p: sw.p, a: inside.room, b: -1, width: sw.width, exterior: true, kind: 'door', doorNo: sw.doorNo || '' });
        entrances++;
      }
    }
  }
  // Evidence the classifier reads.
  for (const r of rooms) {
    if (!r.evidence) r.evidence = {};
    r.evidence.doorSwings = 0;
    r.evidence.openingCount = 0;
  }
  for (const sw of swings) for (const s of sw.sides) if (s.room >= 0) rooms[s.room].evidence.doorSwings++;
  for (const o of out) {
    rooms[o.a].evidence.openingCount++;
    if (o.b >= 0) rooms[o.b].evidence.openingCount++;
  }
  return { openings: out, swings, entrances };
}

/**
 * Rooms with no passage at all get one inferred link to the neighbour whose boundary runs closest for longest
 * (corridors first). Every real room has a door; these are detection misses, flagged for the admin editor.
 */
export function inferMissingOpenings(fp, openings) {
  const rooms = fp.rooms;
  const touched = new Set();
  for (const o of openings) {
    touched.add(o.a);
    if (o.b >= 0) touched.add(o.b);
  }
  const added = [];
  rooms.forEach((r, i) => {
    if (r.kind !== 'room' || touched.has(i)) return;
    const samples = sampleRing(r.polygon, 6);
    let best = null;
    rooms.forEach((q, j) => {
      if (j === i || q.kind !== 'room') return;
      let len = 0;
      let mid = null;
      let minD = Infinity;
      for (const s of samples) {
        const d = distToPolygon(s.p, q.polygon);
        if (d <= MAX_WALL + 8) {
          len += s.step;
          if (d < minD) {
            minD = d;
            mid = s.p;
          }
        }
      }
      if (!len) return;
      const score = len * (q.type === 'corridor' ? 3 : 1);
      if (!best || score > best.score) best = { j, score, mid, len };
    });
    if (best) {
      const o = { p: best.mid, a: Math.min(i, best.j), b: Math.max(i, best.j), width: 0, exterior: false, kind: 'inferred', doorNo: '' };
      openings.push(o);
      added.push({ room: r.number, to: rooms[best.j].number });
      r.evidence.openingCount = 1;
    }
  });
  return added;
}

