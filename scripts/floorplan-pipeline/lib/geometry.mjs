// Pure 2D geometry helpers. Points are [x, y] arrays unless noted.

export const EPS = 1e-9;

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Signed shoelace area (positive = counter-clockwise in a y-up frame). */
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function area(pts) {
  return Math.abs(signedArea(pts));
}

export function perimeter(pts, closed = true) {
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) s += dist(pts[i], pts[(i + 1) % n]);
  return s;
}

/** Area centroid of a simple polygon; falls back to the vertex mean for degenerate input. */
export function centroid(pts) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < EPS) {
    const m = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
    return [m[0] / pts.length, m[1] / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, minY, maxX, maxY };
}

export function bboxUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function bboxOverlapArea(a, b) {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Even-odd ray cast. Points exactly on the boundary may go either way; use distToPolygon for tolerance tests. */
export function pointInPolygon(pt, poly) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < EPS) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from a point to a closed polygon's boundary. */
export function distToPolygon(p, poly) {
  let d = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const v = distToSegment(p, poly[i], poly[(i + 1) % n]);
    if (v < d) d = v;
  }
  return d;
}

/** Signed distance: negative inside, positive outside. */
export function signedDistToPolygon(p, poly) {
  const d = distToPolygon(p, poly);
  return pointInPolygon(p, poly) ? -d : d;
}

/** Proper or touching intersection test of segments ab and cd. */
export function segmentsIntersect(a, b, c, d) {
  const o = (p, q, r) => {
    const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return Math.abs(v) < EPS ? 0 : v > 0 ? 1 : -1;
  };
  const onSeg = (p, q, r) =>
    Math.min(p[0], r[0]) - EPS <= q[0] && q[0] <= Math.max(p[0], r[0]) + EPS &&
    Math.min(p[1], r[1]) - EPS <= q[1] && q[1] <= Math.max(p[1], r[1]) + EPS;
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(a, c, b)) return true;
  if (o2 === 0 && onSeg(a, d, b)) return true;
  if (o3 === 0 && onSeg(c, a, d)) return true;
  if (o4 === 0 && onSeg(c, b, d)) return true;
  return false;
}

/**
 * Expand an LWPOLYLINE vertex list with bulges into plain points.
 * verts: [{x, y, bulge}] ; closed: whether the last vertex connects back to the first.
 * Arc segments are sampled so the chord error stays under `tol` drawing units.
 */
export function expandBulges(verts, closed, tol = 1) {
  const out = [];
  const n = verts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    out.push([v.x, v.y]);
    if (i >= segs) continue;
    const b = v.bulge || 0;
    if (Math.abs(b) < 1e-6) continue;
    const w = verts[(i + 1) % n];
    out.push(...bulgeArcPoints([v.x, v.y], [w.x, w.y], b, tol));
  }
  return out;
}

/** Interior points (exclusive of both ends) of the arc a->b with the given bulge. */
export function bulgeArcPoints(a, b, bulge, tol = 1) {
  const theta = 4 * Math.atan(bulge); // included angle, signed (positive = CCW)
  const chord = dist(a, b);
  if (chord < EPS) return [];
  const r = Math.abs(chord / (2 * Math.sin(theta / 2)));
  // Center = chord midpoint + leftNormal(u) * (1 - b^2) / (4b), u = b - a (unnormalized).
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const k = (1 - bulge * bulge) / (4 * bulge);
  const cx = a[0] + ux / 2 - uy * k;
  const cy = a[1] + uy / 2 + ux * k;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  const steps = arcSteps(r, Math.abs(theta), tol);
  const pts = [];
  for (let k = 1; k < steps; k++) {
    const t = a0 + (theta * k) / steps;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

export function arcSteps(r, sweep, tol = 1) {
  if (r <= tol) return Math.max(2, Math.ceil(sweep / (Math.PI / 4)));
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  return Math.max(2, Math.min(64, Math.ceil(sweep / maxStep)));
}

/** Sample an arc (CCW from a0 to a1, radians) into points including both ends. */
export function arcPoints(c, r, a0, a1, tol = 1) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 2 * Math.PI;
  const steps = arcSteps(r, sweep, tol);
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const t = a0 + (sweep * k) / steps;
    pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return pts;
}

/** Ramer-Douglas-Peucker simplification of an open polyline. */
export function simplifyPolyline(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1;
    let bestD = tol;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Remove consecutive duplicate points (and a duplicated closing point) from a closed ring. */
export function cleanRing(pts, tol = 0.01) {
  const out = [];
  for (const p of pts) {
    if (!out.length || dist(out[out.length - 1], p) > tol) out.push(p);
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}

/**
 * Pole of inaccessibility (the interior point farthest from the boundary), grid-refined.
 * Good label anchor and room-center node for concave rooms. Returns [x, y, distance].
 */
export function poleOfInaccessibility(poly, precision = 1) {
  const bb = bbox(poly);
  const w = bb.maxX - bb.minX;
  const h = bb.maxY - bb.minY;
  const cellSize = Math.min(w, h);
  if (cellSize <= EPS) return [bb.minX, bb.minY, 0];
  const cell = (x, y, half) => {
    const d = -signedDistToPolygon([x, y], poly);
    return { x, y, half, d, max: d + half * Math.SQRT2 };
  };
  const queue = [];
  for (let x = bb.minX; x < bb.maxX; x += cellSize) {
    for (let y = bb.minY; y < bb.maxY; y += cellSize) queue.push(cell(x + cellSize / 2, y + cellSize / 2, cellSize / 2));
  }
  const c0 = centroid(poly);
  let best = cell(c0[0], c0[1], 0);
  const bboxCell = cell(bb.minX + w / 2, bb.minY + h / 2, 0);
  if (bboxCell.d > best.d) best = bboxCell;
  let guard = 0;
  while (queue.length && guard++ < 20000) {
    // pop the cell with the largest potential
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].max > queue[bi].max) bi = i;
    const c = queue[bi];
    queue[bi] = queue[queue.length - 1];
    queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const hh = c.half / 2;
    queue.push(cell(c.x - hh, c.y - hh, hh), cell(c.x + hh, c.y - hh, hh), cell(c.x - hh, c.y + hh, hh), cell(c.x + hh, c.y + hh, hh));
  }
  return [best.x, best.y, best.d];
}

/** Apply an INSERT transform (scale, rotate, translate) to a point in block coordinates. */
export function makeInsertTransform({ base = [0, 0], sx = 1, sy = 1, rot = 0, at = [0, 0] }) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return (p) => {
    const x = (p[0] - base[0]) * sx;
    const y = (p[1] - base[1]) * sy;
    return [at[0] + x * c - y * s, at[1] + x * s + y * c];
  };
}

export function round(v, d = 1) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
