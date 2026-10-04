// Fits a building's floor frame (the drawing's gross outline, SVG units) to its OpenStreetMap footprint.
//
// Method: a rigid similarity with the scale fixed by the drawing units (0.0254 m per inch), so only the rotation and
// the translation are solved, for the drawing as is and mirrored (the reflection check). Both outlines are sampled
// every 0.5 m along their boundaries in a local metric frame around the footprint. A coarse search over the rotation
// (1 degree steps, centroids aligned, 2 m samples) scores the mean symmetric boundary distance (each sample to the
// other outline, capped at 10 m); the two best distinct rotations are refined (1 m samples) by trimmed symmetric ICP (closest boundary points both ways, the
// worst 20 % of pairs dropped, closed-form 2D Procrustes per iteration). The residual reported is the RMS of the
// untrimmed symmetric boundary distances of the final fit, recomputed through src/shared/georef.mjs.
import { closestOnSegment, distToPolyline, localFrame, polygonCentroid, round, sampleRing } from './geo.mjs';
import { svgToLngLatWith } from '../../src/shared/georef.mjs';

const STEP = 0.5;
const CAP = 10;

function closestOnRing(p, ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const q = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]).p;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (!best || d < best.d) best = { q, d };
  }
  return best;
}

const openRing = (r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r.slice());

function apply(pt, th, t) {
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [pt[0] * c - pt[1] * s + t[0], pt[0] * s + pt[1] * c + t[1]];
}

function symmetricCost(P, Ps, Q, Qs, th, t, cap = CAP) {
  const Pt = P.map((p) => apply(p, th, t));
  let sum = 0;
  for (const p of Ps) sum += Math.min(cap, distToPolyline(apply(p, th, t), Q, true));
  for (const q of Qs) sum += Math.min(cap, distToPolyline(q, Pt, true));
  return sum / (Ps.length + Qs.length);
}

/** Closed-form rigid 2D fit of pairs [src, dst]: returns { th, t }. */
function procrustes(pairs) {
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (const [a, b] of pairs) {
    sx += a[0]; sy += a[1]; dx += b[0]; dy += b[1];
  }
  const n = pairs.length;
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num = 0, den = 0;
  for (const [a, b] of pairs) {
    const ax = a[0] - sx, ay = a[1] - sy, bx = b[0] - dx, by = b[1] - dy;
    num += ax * by - ay * bx;
    den += ax * bx + ay * by;
  }
  const th = Math.atan2(num, den);
  const c = Math.cos(th);
  const s = Math.sin(th);
  return { th, t: [dx - (sx * c - sy * s), dy - (sx * s + sy * c)] };
}

function icp(P, Ps, Q, Qs, th0, t0, iters = 60) {
  let th = th0;
  let t = t0;
  for (let k = 0; k < iters; k++) {
    const pairs = [];
    const Pt = P.map((p) => apply(p, th, t));
    for (const p of Ps) {
      const c = closestOnRing(apply(p, th, t), Q);
      pairs.push({ src: p, dst: c.q, d: c.d });
    }
    // q -> closest point of the transformed P boundary; map that point back into P's own frame as the source.
    const c0 = Math.cos(-th);
    const s0 = Math.sin(-th);
    for (const q of Qs) {
      const c = closestOnRing(q, Pt);
      const back = [(c.q[0] - t[0]) * c0 - (c.q[1] - t[1]) * s0, (c.q[0] - t[0]) * s0 + (c.q[1] - t[1]) * c0];
      pairs.push({ src: back, dst: q, d: c.d });
    }
    const ds = pairs.map((p) => p.d).sort((a, b) => a - b);
    const cut = ds[Math.floor(ds.length * 0.8)];
    const kept = pairs.filter((p) => p.d <= cut).map((p) => [p.src, p.dst]);
    const next = procrustes(kept);
    const moved = Math.abs(next.th - th) + Math.hypot(next.t[0] - t[0], next.t[1] - t[1]);
    th = next.th;
    t = next.t;
    if (moved < 1e-6) break;
  }
  return { th, t };
}

function douglasPeucker(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.hypot(...[0, 1].map((k) => pts[i][k] - closestOnSegment(pts[i], pts[a], pts[b]).p[k]));
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * The outer outline of the union of several floors' gross outlines, all given in one SVG frame (the fitted floor's):
 * a footprint is a roof outline, so it is the union of the floors that is compared with it (IT's rotundas are on
 * floor 2 only, its east block on floor 1 only). Rasterized at `cell` meters, traced, simplified to `tol` meters.
 * @return {number[][]} ring in SVG units (open)
 */
export function unionOutline(rings, { metersPerUnit = 0.0254, cell = 0.25, tol = 0.2 } = {}) {
  const M = rings.map((r) => openRing(r).map(([x, y]) => [x * metersPerUnit, -y * metersPerUnit]));
  if (M.length === 1) return openRing(rings[0]);
  const xs = M.flat().map((p) => p[0]);
  const ys = M.flat().map((p) => p[1]);
  const x0 = Math.min(...xs) - 2 * cell;
  const y0 = Math.min(...ys) - 2 * cell;
  const W = Math.ceil((Math.max(...xs) - x0) / cell) + 2;
  const H = Math.ceil((Math.max(...ys) - y0) / cell) + 2;
  const mask = new Uint8Array(W * H);
  // Scanline fill (even-odd per ring) at cell centers.
  for (const ring of M) {
    for (let j = 0; j < H; j++) {
      const y = y0 + (j + 0.5) * cell;
      const xsHit = [];
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [ax, ay] = ring[k];
        const [bx, by] = ring[i];
        if ((ay > y) !== (by > y)) xsHit.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
      xsHit.sort((a, b) => a - b);
      for (let h = 0; h + 1 < xsHit.length; h += 2) {
        const i0 = Math.max(0, Math.ceil((xsHit[h] - x0) / cell - 0.5));
        const i1 = Math.min(W - 1, Math.floor((xsHit[h + 1] - x0) / cell - 0.5));
        for (let i = i0; i <= i1; i++) mask[j * W + i] = 1;
      }
    }
  }
  const at = (i, j) => (i >= 0 && j >= 0 && i < W && j < H ? mask[j * W + i] : 0);
  // Directed boundary edges with the inside on the left; chain them into loops; keep the largest.
  const next = new Map();
  const key = (i, j) => j * (W + 1) + i;
  const add = (a, b) => {
    const k = key(...a);
    if (!next.has(k)) next.set(k, []);
    next.get(k).push(b);
  };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) add([i, j], [i + 1, j]);
      if (!at(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
      if (!at(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
      if (!at(i - 1, j)) add([i, j + 1], [i, j]);
    }
  }
  let best = null;
  while (next.size) {
    const [k0, outs] = next.entries().next().value;
    let cur = [k0 % (W + 1), Math.floor(k0 / (W + 1))];
    const loop = [];
    for (;;) {
      const k = key(...cur);
      const o = next.get(k);
      if (!o || !o.length) break;
      const nb = o.shift();
      if (!o.length) next.delete(k);
      loop.push(cur);
      cur = nb;
    }
    if (!outs) break;
    const pts = loop.map(([i, j]) => [x0 + i * cell, y0 + j * cell]);
    let a = 0;
    for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) a += (pts[k][0] + pts[i][0]) * (pts[k][1] - pts[i][1]);
    if (!best || Math.abs(a) > best.area) best = { pts, area: Math.abs(a) };
  }
  const simple = douglasPeucker([...best.pts, best.pts[0]], tol).slice(0, -1);
  return simple.map(([u, v]) => [round(u / metersPerUnit, 1), round(-v / metersPerUnit, 1)]);
}

/** Symmetric boundary distances (m) of the final fit, through the shared transform. */
export function boundaryResiduals(record, gross, footprintRing, floorId) {
  const F = localFrame({ lat: record.transform.originLat, lng: record.transform.originLng });
  const Q = openRing(footprintRing).map(([lng, lat]) => F.toXY(lat, lng));
  const mpu = record.transform.metersPerUnit;
  const Pm = sampleRing(openRing(gross), STEP / mpu).map(([x, y]) => {
    const [lng, lat] = svgToLngLatWith(record, x, y, floorId);
    return F.toXY(lat, lng);
  });
  const Pring = openRing(gross).map(([x, y]) => {
    const [lng, lat] = svgToLngLatWith(record, x, y, floorId);
    return F.toXY(lat, lng);
  });
  const ds = [];
  for (const p of Pm) ds.push(distToPolyline(p, Q, true));
  for (const q of sampleRing(Q, STEP)) ds.push(distToPolyline(q, Pring, true));
  ds.sort((a, b) => a - b);
  const rms = Math.sqrt(ds.reduce((s, d) => s + d * d, 0) / ds.length);
  return { rms: round(rms, 2), mean: round(ds.reduce((s, d) => s + d, 0) / ds.length, 2), p90: round(ds[Math.floor(ds.length * 0.9)], 2), max: round(ds[ds.length - 1], 2) };
}

/**
 * Fits gross (SVG units, one floor) to footprintRing ([lng, lat]).
 * @return {{ transform, reflected, residual: {rms, mean, p90, max}, candidates }}
 */
export function fitOutline(gross, footprintRing, { metersPerUnit = 0.0254 } = {}) {
  const fc = polygonCentroid(openRing(footprintRing));
  const F = localFrame({ lat: fc[1], lng: fc[0] });
  const Q = openRing(footprintRing).map(([lng, lat]) => F.toXY(lat, lng));
  const Qs = sampleRing(Q, STEP);
  const qc = polygonCentroid(Q);
  const results = [];
  for (const reflected of [false, true]) {
    const P = openRing(gross).map(([x, y]) => [x * metersPerUnit * (reflected ? -1 : 1), -y * metersPerUnit]);
    const Ps = sampleRing(P, STEP);
    const Pc = sampleRing(P, 2);
    const Qc = sampleRing(Q, 2);
    const Pi = sampleRing(P, 1);
    const Qi = sampleRing(Q, 1);
    const pc = polygonCentroid(P);
    const coarse = [];
    for (let deg = 0; deg < 360; deg += 1) {
      const th = (deg * Math.PI) / 180;
      const rp = apply(pc, th, [0, 0]);
      const t = [qc[0] - rp[0], qc[1] - rp[1]];
      coarse.push({ deg, th, t, cost: symmetricCost(P, Pc, Q, Qc, th, t) });
    }
    coarse.sort((a, b) => a.cost - b.cost);
    // Refine the best few distinct rotations (at least 10 degrees apart).
    const seeds = [];
    for (const c of coarse) {
      if (seeds.every((s) => Math.abs(((c.deg - s.deg + 540) % 360) - 180) >= 10)) seeds.push(c);
      if (seeds.length === 2) break;
    }
    for (const s of seeds) {
      const r = icp(P, Pi, Q, Qi, s.th, s.t, 40);
      results.push({ reflected, th: r.th, t: r.t, cost: symmetricCost(P, Ps, Q, Qs, r.th, r.t, Infinity) });
    }
  }
  results.sort((a, b) => a.cost - b.cost);
  const best = results[0];
  const [oLat, oLng] = F.toLatLng(best.t[0], best.t[1]); // the image of SVG (0, 0)
  const deg = (((best.th * 180) / Math.PI) % 360 + 360) % 360;
  const transform = { originLat: round(oLat, 8), originLng: round(oLng, 8), rotationDeg: round(deg, 4), metersPerUnit, reflected: best.reflected };
  return {
    transform,
    candidates: results.map((r) => ({ reflected: r.reflected, rotationDeg: round((((r.th * 180) / Math.PI) % 360 + 360) % 360, 2), meanDistance: round(r.cost, 2) })),
  };
}
