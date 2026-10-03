// Geometric detectors over wall primitives: stair treads, elevator shafts (boxed X), and a segment index.
import { bbox, dist, distToPolygon, pointInPolygon } from './geometry.mjs';

/** Flatten primitives into line segments [[x,y],[x,y]] (arcs and circles are skipped; paths are split). */
export function primsToSegments(prims, layerTest = () => true) {
  const segs = [];
  for (const p of prims) {
    if (!layerTest(p.L)) continue;
    if (p.k === 'seg') segs.push([p.a, p.b]);
    else if (p.k === 'path' && !p.fromArc) {
      for (let i = 0; i + 1 < p.pts.length; i++) segs.push([p.pts[i], p.pts[i + 1]]);
      if (p.closed && p.pts.length > 2) segs.push([p.pts[p.pts.length - 1], p.pts[0]]);
    }
  }
  return segs.filter((s) => dist(s[0], s[1]) > 0.1);
}

/** Uniform-grid spatial index of segments for proximity queries. */
export class SegmentIndex {
  constructor(segs, cell = 96) {
    this.segs = segs;
    this.cell = cell;
    this.grid = new Map();
    segs.forEach((s, i) => {
      const x0 = Math.floor(Math.min(s[0][0], s[1][0]) / cell);
      const x1 = Math.floor(Math.max(s[0][0], s[1][0]) / cell);
      const y0 = Math.floor(Math.min(s[0][1], s[1][1]) / cell);
      const y1 = Math.floor(Math.max(s[0][1], s[1][1]) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = x + ',' + y;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k).push(i);
      }
    });
  }

  query(b) {
    const out = new Set();
    const c = this.cell;
    for (let x = Math.floor(b.minX / c); x <= Math.floor(b.maxX / c); x++) {
      for (let y = Math.floor(b.minY / c); y <= Math.floor(b.maxY / c); y++) {
        for (const i of this.grid.get(x + ',' + y) || []) out.add(i);
      }
    }
    return [...out].map((i) => this.segs[i]);
  }
}

/** Segments lying inside a polygon (both endpoints inside, or within `tol` of its boundary). */
export function segmentsInside(index, poly, tol = 3) {
  const b = bbox(poly);
  const near = index.query({ minX: b.minX - tol, minY: b.minY - tol, maxX: b.maxX + tol, maxY: b.maxY + tol });
  const ok = (p) => pointInPolygon(p, poly) || distToPolygon(p, poly) <= tol;
  return near.filter((s) => ok(s[0]) && ok(s[1]));
}

/**
 * Longest run of stair treads among segments: parallel, similar length (24..180 units), overlapping along their
 * direction, at a regular spacing of 8..15 units (stair treads are 10..12 in deep).
 */
export function longestTreadRun(segs) {
  const groups = new Map();
  for (const s of segs) {
    const len = dist(s[0], s[1]);
    if (len < 24 || len > 180) continue;
    let ang = Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]);
    if (ang < 0) ang += Math.PI;
    if (ang >= Math.PI) ang -= Math.PI;
    const key = Math.round(ang / (Math.PI / 90)) % 90; // 2-degree buckets
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ s, len, ang });
  }
  let best = 0;
  let bestRun = [];
  for (const g of groups.values()) {
    if (g.length < 5) continue;
    const a = g[0].ang;
    const dir = [Math.cos(a), Math.sin(a)];
    const nrm = [-dir[1], dir[0]];
    const items = g.map((t) => {
      const m = [(t.s[0][0] + t.s[1][0]) / 2, (t.s[0][1] + t.s[1][1]) / 2];
      const along = [t.s[0][0] * dir[0] + t.s[0][1] * dir[1], t.s[1][0] * dir[0] + t.s[1][1] * dir[1]].sort((x, y) => x - y);
      return { ...t, off: m[0] * nrm[0] + m[1] * nrm[1], lo: along[0], hi: along[1], mid: m };
    }).sort((x, y) => x.off - y.off);
    // Dedupe near-identical offsets (double lines) keeping the longer.
    const uniq = [];
    for (const it of items) {
      const last = uniq[uniq.length - 1];
      if (last && Math.abs(it.off - last.off) < 1 && Math.min(it.hi, last.hi) - Math.max(it.lo, last.lo) > 0) continue;
      uniq.push(it);
    }
    // Chain: consecutive spacing 8..15, length ratio within 0.75..1.33, overlapping extents.
    for (let i = 0; i < uniq.length; i++) {
      const run = [uniq[i]];
      for (let j = i + 1; j < uniq.length; j++) {
        const prev = run[run.length - 1];
        const gap = uniq[j].off - prev.off;
        if (gap < 8) continue;
        if (gap > 15) break;
        const r = uniq[j].len / prev.len;
        const overlap = Math.min(uniq[j].hi, prev.hi) - Math.max(uniq[j].lo, prev.lo);
        if (r > 0.75 && r < 1.33 && overlap > 0.6 * Math.min(uniq[j].len, prev.len)) run.push(uniq[j]);
      }
      if (run.length > best) {
        best = run.length;
        bestRun = run;
      }
    }
  }
  const pts = bestRun.flatMap((t) => [t.s[0], t.s[1]]);
  return { count: best, box: pts.length ? bbox(pts) : null };
}

/**
 * Merge segments that are collinear (within `angTol` radians and `offTol` units of the same line) and touch end to end
 * (gap <= `gapTol`). CAD often draws one diagonal as two halves meeting at the shaft center.
 */
export function mergeCollinear(segs, { gapTol = 4, angTol = 0.05, offTol = 2 } = {}) {
  const items = segs.map((s) => ({ a: s[0], b: s[1], alive: true }));
  const key = (p) => Math.round(p[0] / 8) + ',' + Math.round(p[1] / 8);
  const ends = new Map();
  const add = (p, it) => {
    const [kx, ky] = key(p).split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = kx + dx + ',' + (ky + dy);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(it);
    }
  };
  items.forEach((it) => { add(it.a, it); add(it.b, it); });
  const angle = (it) => {
    let a = Math.atan2(it.b[1] - it.a[1], it.b[0] - it.a[0]);
    if (a < 0) a += Math.PI;
    return a % Math.PI;
  };
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 6) {
    changed = false;
    for (const it of items) {
      if (!it.alive) continue;
      for (const p of [it.a, it.b]) {
        for (const o of ends.get(key(p)) || []) {
          if (o === it || !o.alive) continue;
          let d = Math.abs(angle(it) - angle(o));
          d = Math.min(d, Math.PI - d);
          if (d > angTol) continue;
          const pairs = [[it.a, o.a], [it.a, o.b], [it.b, o.a], [it.b, o.b]];
          if (!pairs.some(([u, v]) => dist(u, v) <= gapTol)) continue;
          // Offset check: o's endpoints lie close to it's line.
          const L = dist(it.a, it.b);
          const n = [-(it.b[1] - it.a[1]) / L, (it.b[0] - it.a[0]) / L];
          const off = (q) => Math.abs((q[0] - it.a[0]) * n[0] + (q[1] - it.a[1]) * n[1]);
          if (off(o.a) > offTol || off(o.b) > offTol) continue;
          // Merge into the farthest pair of endpoints.
          const pts = [it.a, it.b, o.a, o.b];
          let best = [it.a, it.b];
          let bd = L;
          for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (dist(pts[i], pts[j]) > bd) { bd = dist(pts[i], pts[j]); best = [pts[i], pts[j]]; }
          it.a = best[0];
          it.b = best[1];
          o.alive = false;
          add(it.a, it);
          add(it.b, it);
          changed = true;
        }
      }
    }
  }
  return items.filter((it) => it.alive).map((it) => [it.a, it.b]);
}

/**
 * Elevator shafts drawn as a boxed X: two segments of similar length (48..200 units) crossing near both midpoints,
 * whose four endpoints span a box of 15..120 sq ft (at inches). Input segments should be collinear-merged first.
 */
export function findShaftXs(segs) {
  const cands = segs.filter((s) => {
    const l = dist(s[0], s[1]);
    return l >= 48 && l <= 200;
  });
  const out = [];
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i];
    const la = dist(a[0], a[1]);
    const ma = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2];
    for (let j = i + 1; j < cands.length; j++) {
      const b = cands[j];
      const lb = dist(b[0], b[1]);
      if (Math.abs(la - lb) > 0.12 * Math.max(la, lb)) continue;
      const mb = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
      if (dist(ma, mb) > 0.08 * la) continue;
      // Not collinear / not parallel.
      const ca = [(a[1][0] - a[0][0]) / la, (a[1][1] - a[0][1]) / la];
      const cb = [(b[1][0] - b[0][0]) / lb, (b[1][1] - b[0][1]) / lb];
      const cross = Math.abs(ca[0] * cb[1] - ca[1] * cb[0]);
      if (cross < 0.3) continue;
      const corners = [a[0], a[1], b[0], b[1]];
      const ar = shaftArea(corners);
      if (ar < 15 * 144 || ar > 120 * 144) continue;
      out.push({ center: [(ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2], corners, areaUnits: ar });
    }
  }
  // Dedupe nearby detections.
  const uniq = [];
  for (const x of out) if (!uniq.some((u) => dist(u.center, x.center) < 24)) uniq.push(x);
  return uniq;
}

/** Area of the quadrilateral formed by an X's endpoints (ordered by angle around their mean). */
function shaftArea(pts) {
  const c = [pts.reduce((s, p) => s + p[0], 0) / 4, pts.reduce((s, p) => s + p[1], 0) / 4];
  const sorted = pts.slice().sort((p, q) => Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(q[1] - c[1], q[0] - c[0]));
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = sorted[i];
    const q = sorted[(i + 1) % 4];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}
