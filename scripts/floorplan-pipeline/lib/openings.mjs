// Openings between spaces (wall-gap analysis) and door swings (arc analysis).
//
// A room polygon is drawn on the inside face of its walls, so two rooms that share a wall have boundaries a wall
// thickness apart, and two areas split by an imaginary area line have coincident boundaries. Walking along a room's
// boundary, wherever the neighbouring room's boundary is within MAX_WALL and the short segment across the gap crosses
// no wall line, people can pass: that run is an opening (a door leaf, a sliding elevator door, a cased opening, or an
// area division line). Door swings (90-degree arcs) mark which openings are doors, and an arc whose far side lies
// outside the building's gross outline is an exterior entrance.
import {
  bbox, dist, distToPolygon, pointInPolygon, segmentsIntersect,
} from './geometry.mjs';

export const MAX_WALL = 16; // widest interior wall + tolerance, drawing units (inches)
const SAMPLE = 4; // boundary sampling step
const MIN_OPENING = 26; // narrowest passable run
const SHRINK = 1.5; // keep gap probes off the wall-face lines the polygons are drawn on

function closestOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

function closestOnPolygon(p, poly) {
  let best = null;
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const q = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = dist(p, q);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return [best, bd];
}

/**
 * Is the passage from boundary point p (room A) to boundary point q (room B) blocked by a wall line?
 * Room polygons are not always on the wall faces (some sit inside the wall or on its centerline), so the probe runs
 * along the A->B normal and extends PROBE_EXT into both rooms: any wall really standing between them is crossed.
 * `nrm` is the unit normal to use when p and q (nearly) coincide.
 */
const PROBE_EXT = 6;
function blockedAcross(p, q, nrm, wallIndex) {
  const d = dist(p, q);
  const u = d > 1 ? [(q[0] - p[0]) / d, (q[1] - p[1]) / d] : nrm;
  const a = [p[0] - u[0] * PROBE_EXT, p[1] - u[1] * PROBE_EXT];
  const b = [q[0] + u[0] * PROBE_EXT, q[1] + u[1] * PROBE_EXT];
  const bb = { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
  for (const s of wallIndex.query(bb)) if (segmentsIntersect(a, b, s[0], s[1])) return true;
  return false;
}

/**
 * Sample points along a closed ring every `step` units, with the edge index each came from and the edge's outward
 * unit normal (outward = away from the ring's interior, whatever the winding).
 */
export function sampleRing(ring, step = SAMPLE) {
  const out = [];
  let s2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    s2 += p[0] * q[1] - q[0] * p[1];
  }
  const ccw = s2 > 0; // in a y-down frame this is visually clockwise; only the sign relation matters
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = dist(a, b);
    if (L < 1e-6) continue;
    const t0 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const outN = ccw ? [t0[1], -t0[0]] : [-t0[1], t0[0]];
    const n = Math.max(1, Math.floor(L / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      out.push({ p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], edge: i, step: L / n, out: outN });
    }
  }
  return out;
}

/**
 * Find openings between every pair of spaces. Returns [{ a, b, p, width, kind:'gap'|'coincident' }] with a < b
 * (space indexes), p the opening midpoint (between the two boundaries).
 */
export function findOpenings(spaces, wallIndex) {
  const boxes = spaces.map((s) => bbox(s.polygon));
  const found = [];
  for (let i = 0; i < spaces.length; i++) {
    const A = spaces[i].polygon;
    const bi = boxes[i];
    const nbrs = [];
    for (let j = 0; j < spaces.length; j++) {
      if (j === i) continue;
      const bj = boxes[j];
      if (bj.minX > bi.maxX + MAX_WALL || bj.maxX < bi.minX - MAX_WALL || bj.minY > bi.maxY + MAX_WALL || bj.maxY < bi.minY - MAX_WALL) continue;
      nbrs.push(j);
    }
    if (!nbrs.length) continue;
    const samples = sampleRing(A);
    // For each sample: nearest neighbour boundary within MAX_WALL and whether passable.
    const tags = samples.map((s) => {
      let best = -1;
      let bq = null;
      let bd = MAX_WALL;
      for (const j of nbrs) {
        const [q, d] = closestOnPolygon(s.p, spaces[j].polygon);
        if (d <= bd) {
          bd = d;
          best = j;
          bq = q;
        }
      }
      if (best < 0) return null;
      // The neighbour must be on the far side: the probe must not run through room A's own interior.
      const mid = [(s.p[0] + bq[0]) / 2, (s.p[1] + bq[1]) / 2];
      if (bd > 2 && pointInPolygon(mid, A)) return null;
      return { j: best, q: bq, d: bd, open: !blockedAcross(s.p, bq, s.out, wallIndex) };
    });
    // Runs of consecutive open samples towards the same neighbour (ring is cyclic).
    const n = samples.length;
    // Start just after a sample that ends a run (closed, or a change of neighbour) so no run wraps the seam.
    let start = 0;
    for (let k = 0; k < n; k++) {
      const t = tags[k];
      const nx = tags[(k + 1) % n];
      if (!t || !t.open || !nx || !nx.open || nx.j !== t.j) {
        start = (k + 1) % n;
        break;
      }
    }
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const len = run.reduce((s, k) => s + samples[k].step, 0);
      if (len >= MIN_OPENING) {
        const j = tags[run[0]].j;
        const mk = run[Math.floor(run.length / 2)];
        const p = [(samples[mk].p[0] + tags[mk].q[0]) / 2, (samples[mk].p[1] + tags[mk].q[1]) / 2];
        const meanD = run.reduce((s, k) => s + tags[k].d, 0) / run.length;
        found.push({ a: Math.min(i, j), b: Math.max(i, j), p, width: len, kind: meanD < 2 ? 'coincident' : 'gap' });
      }
      run = [];
    };
    for (let c = 0; c < n; c++) {
      const k = (start + c) % n;
      const t = tags[k];
      if (t && t.open && (!run.length || tags[run[0]].j === t.j)) run.push(k);
      else {
        flush();
        if (t && t.open) run.push(k);
      }
    }
    flush();
  }
  // Each opening is found from both sides; merge those with the same pair and nearby midpoints.
  const merged = [];
  for (const o of found) {
    const m = merged.find((x) => x.a === o.a && x.b === o.b && dist(x.p, o.p) < Math.max(24, Math.min(x.width, o.width) / 2));
    if (m) {
      m.p = [(m.p[0] + o.p[0]) / 2, (m.p[1] + o.p[1]) / 2];
      m.width = Math.max(m.width, o.width);
    } else merged.push({ ...o });
  }
  return merged;
}

/**
 * Door swings from arcs. Each arc gives hinge H, ends E1, E2. One end is the closed-leaf point (on the wall line),
 * the other the open-leaf tip. The hypothesis whose closed direction has more parallel wall length near the hinge
 * wins. Returns [{ p (opening midpoint), hinge, width, swingDir, src }].
 */
export function doorSwings(arcs, wallIndex, { minR = 20, maxR = 50 } = {}) {
  const out = [];
  for (const a of arcs) {
    let H;
    let E1;
    let E2;
    let r;
    if (a.k === 'arc' || a.r != null) {
      r = a.r;
      let sweep = a.a1 - a.a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      if (sweep < (70 * Math.PI) / 180 || sweep > (110 * Math.PI) / 180) continue;
      H = a.c;
      E1 = [a.c[0] + r * Math.cos(a.a0), a.c[1] + r * Math.sin(a.a0)];
      E2 = [a.c[0] + r * Math.cos(a.a1), a.c[1] + r * Math.sin(a.a1)];
    } else {
      H = a.c;
      E1 = a.ends[0];
      E2 = a.ends[1];
      r = (dist(H, E1) + dist(H, E2)) / 2;
      const v1 = [E1[0] - H[0], E1[1] - H[1]];
      const v2 = [E2[0] - H[0], E2[1] - H[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (dist(H, E1) * dist(H, E2) || 1);
      if (Math.abs(cos) > 0.35) continue; // not ~90 degrees
    }
    if (r < minR || r > maxR) continue;
    const score = (P) => {
      const d = [(P[0] - H[0]) / r, (P[1] - H[1]) / r];
      const nrm = [-d[1], d[0]];
      const near = wallIndex.query({ minX: H[0] - 2 * r, minY: H[1] - 2 * r, maxX: H[0] + 2 * r, maxY: H[1] + 2 * r });
      let s = 0;
      for (const seg of near) {
        const L = dist(seg[0], seg[1]);
        if (L < 1) continue;
        const sd = [(seg[1][0] - seg[0][0]) / L, (seg[1][1] - seg[0][1]) / L];
        if (Math.abs(sd[0] * d[0] + sd[1] * d[1]) < 0.97) continue; // parallel within ~14 degrees
        const m = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2];
        const off = Math.abs((m[0] - H[0]) * nrm[0] + (m[1] - H[1]) * nrm[1]);
        if (off <= MAX_WALL) s += Math.min(L, 2 * r);
      }
      return s;
    };
    // Preferred evidence: the leaf is drawn open, as a line from the hinge to the open end of the arc.
    const leafTo = (P) => wallIndex
      .query({ minX: H[0] - 3, minY: H[1] - 3, maxX: H[0] + 3, maxY: H[1] + 3 })
      .some((sg) => (dist(sg[0], H) < 2.5 && dist(sg[1], P) < 4) || (dist(sg[1], H) < 2.5 && dist(sg[0], P) < 4));
    const l1 = leafTo(E1);
    const l2 = leafTo(E2);
    let Pc;
    let Po;
    if (l1 !== l2) [Pc, Po] = l1 ? [E2, E1] : [E1, E2];
    else {
      const s1 = score(E1);
      const s2 = score(E2);
      [Pc, Po] = s1 >= s2 ? [E1, E2] : [E2, E1];
    }
    out.push({
      p: [(H[0] + Pc[0]) / 2, (H[1] + Pc[1]) / 2],
      hinge: H,
      width: r,
      swingDir: [(Po[0] - H[0]) / r, (Po[1] - H[1]) / r],
      wallDir: [(Pc[0] - H[0]) / r, (Pc[1] - H[1]) / r],
      src: a.src || 'arc',
      doorNo: a.doorNo || '',
    });
  }
  // Pair double doors: two swings whose openings are collinear and adjacent.
  const used = new Set();
  const doors = [];
  for (let i = 0; i < out.length; i++) {
    if (used.has(i)) continue;
    let d = out[i];
    for (let j = i + 1; j < out.length; j++) {
      if (used.has(j)) continue;
      const e = out[j];
      // A double door's two closed-leaf tips meet in the middle of one opening, and both leaves swing the same way.
      // (Two single doors hinged back to back across a partition fail this: their tips point away from each other.)
      const tipD = [d.hinge[0] + d.wallDir[0] * d.width, d.hinge[1] + d.wallDir[1] * d.width];
      const tipE = [e.hinge[0] + e.wallDir[0] * e.width, e.hinge[1] + e.wallDir[1] * e.width];
      const opposite = d.wallDir[0] * e.wallDir[0] + d.wallDir[1] * e.wallDir[1] < -0.95;
      const sameSwing = d.swingDir[0] * e.swingDir[0] + d.swingDir[1] * e.swingDir[1] > 0.9;
      if (opposite && sameSwing && dist(tipD, tipE) < 8) {
        used.add(j);
        d = { ...d, p: [(d.p[0] + e.p[0]) / 2, (d.p[1] + e.p[1]) / 2], width: d.width + e.width, double: true, doorNo: d.doorNo || e.doorNo };
        break;
      }
    }
    doors.push(d);
  }
  // Drop duplicates (a block door and a loose arc drawn at the same place).
  const uniq = [];
  for (const d of doors) if (!uniq.some((u) => dist(u.p, d.p) < 12)) uniq.push(d);
  return uniq;
}

/**
 * What lies on each side of a door: march from the opening along +/- the swing direction until the march enters a
 * room polygon (that room), leaves the building's gross outline (exterior), or is cut by a wall line first (none).
 */
export const MARCH_MAX = 600;
export function swingSides(door, spaces, gross, wallIndex = null) {
  const sideAt = (sign) => {
    const u = [sign * door.swingDir[0], sign * door.swingDir[1]];
    const start = [door.p[0] + u[0] * 3, door.p[1] + u[1] * 3];
    for (let t = 6; t <= MARCH_MAX; t += 6) {
      const q = [door.p[0] + u[0] * t, door.p[1] + u[1] * t];
      const idx = spaces.findIndex((s) => pointInPolygon(q, s.polygon));
      const out = gross ? !pointInPolygon(q, gross) : false;
      if (idx < 0 && !out) continue;
      if (wallIndex && t > 12) {
        const bb = { minX: Math.min(start[0], q[0]), minY: Math.min(start[1], q[1]), maxX: Math.max(start[0], q[0]), maxY: Math.max(start[1], q[1]) };
        // Allow the first 12 units (door frame and the wall the door sits in) before counting walls as blocking.
        const s12 = [door.p[0] + u[0] * 12, door.p[1] + u[1] * 12];
        if (wallIndex.query(bb).some((sg) => segmentsIntersect(s12, q, sg[0], sg[1]))) return { space: -1, q, outside: false, blocked: true };
      }
      if (idx >= 0) return { space: idx, q, dist: t };
      return { space: -1, q, outside: true, dist: t };
    }
    return { space: -1, q: start, outside: false };
  };
  return [sideAt(1), sideAt(-1)];
}
