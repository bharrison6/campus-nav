// Corridor centerlines: rasterize a polygon, thin it to a one-pixel skeleton (Zhang-Suen), trace the skeleton into
// a graph of polylines, prune short spurs (door pockets, alcoves), and simplify. Output coordinates are in the input
// frame. This is a sampled medial axis; it is approximate by design and is only used to place walkable waypoints.
import { bbox, dist, simplifyPolyline } from './geometry.mjs';

/** Scanline fill of a polygon into a Uint8Array grid of `res`-unit cells. */
export function rasterize(poly, res) {
  const b = bbox(poly);
  const ox = b.minX - res;
  const oy = b.minY - res;
  const w = Math.ceil((b.maxX - b.minX) / res) + 3;
  const h = Math.ceil((b.maxY - b.minY) / res) + 3;
  const g = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const y = oy + (j + 0.5) * res;
    const xs = [];
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % n];
      if ((p[1] > y) !== (q[1] > y)) xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
    }
    xs.sort((a, c) => a - c);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - ox) / res - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - ox) / res - 0.5));
      for (let i = i0; i <= i1; i++) g[j * w + i] = 1;
    }
  }
  return { g, w, h, ox, oy, res };
}

/** Zhang-Suen thinning in place. */
export function thin(r) {
  const { g, w, h } = r;
  const idx = (i, j) => j * w + i;
  let changed = true;
  let iter = 0;
  const del = [];
  while (changed && iter++ < 500) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let j = 1; j < h - 1; j++) {
        for (let i = 1; i < w - 1; i++) {
          if (!g[idx(i, j)]) continue;
          const p2 = g[idx(i, j - 1)];
          const p3 = g[idx(i + 1, j - 1)];
          const p4 = g[idx(i + 1, j)];
          const p5 = g[idx(i + 1, j + 1)];
          const p6 = g[idx(i, j + 1)];
          const p7 = g[idx(i - 1, j + 1)];
          const p8 = g[idx(i - 1, j)];
          const p9 = g[idx(i - 1, j - 1)];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(idx(i, j));
        }
      }
      for (const k of del) g[k] = 0;
      if (del.length) changed = true;
    }
  }
  return r;
}

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Trace a thinned raster into { nodes:[[x,y]], edges:[{a,b,pts:[[x,y],...]}] } in the input frame. */
export function traceSkeleton(r) {
  const { g, w, h, ox, oy, res } = r;
  const on = (i, j) => i >= 0 && j >= 0 && i < w && j < h && g[j * w + i] === 1;
  const nb = (i, j) => N8.map(([dx, dy]) => [i + dx, j + dy]).filter(([a, b]) => on(a, b));
  const toXY = (i, j) => [ox + (i + 0.5) * res, oy + (j + 0.5) * res];
  const key = (i, j) => j * w + i;
  const isNode = (i, j) => nb(i, j).length !== 2;
  const nodeId = new Map();
  const nodes = [];
  const nodePix = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (on(i, j) && isNode(i, j)) {
    nodeId.set(key(i, j), nodes.length);
    nodes.push(toXY(i, j));
    nodePix.push(key(i, j));
  }
  const visited = new Set(); // edge pixel keys "a>b"
  const edges = [];
  const walk = (si, sj, ni, nj) => {
    const pts = [toXY(si, sj)];
    let pi = si;
    let pj = sj;
    let ci = ni;
    let cj = nj;
    let guard = 0;
    while (guard++ < w * h) {
      pts.push(toXY(ci, cj));
      const k = key(ci, cj);
      if (nodeId.has(k)) return { end: nodeId.get(k), pts, last: [pi, pj] };
      const nx = nb(ci, cj).filter(([a, b]) => !(a === pi && b === pj));
      if (!nx.length) return { end: null, pts };
      [pi, pj, ci, cj] = [ci, cj, nx[0][0], nx[0][1]];
      if (ci === si && cj === sj) return { end: nodeId.get(key(si, sj)), pts: [...pts, toXY(si, sj)] };
    }
    return { end: null, pts };
  };
  for (const [k, id] of nodeId) {
    const i = k % w;
    const j = Math.floor(k / w);
    for (const [a, b] of nb(i, j)) {
      const e1 = `${k}>${key(a, b)}`;
      if (visited.has(e1)) continue;
      const res2 = walk(i, j, a, b);
      visited.add(e1);
      if (res2.end == null) continue;
      // Mark the chain's last step from the far node so the same chain is not traced again from that end.
      const lastPix = res2.last || [i, j];
      visited.add(`${nodePix[res2.end]}>${key(lastPix[0], lastPix[1])}`);
      if (res2.end === id && res2.pts.length < 3) continue;
      edges.push({ a: id, b: res2.end, pts: res2.pts });
    }
  }
  // Pure loops with no node pixel: seed one.
  if (!nodes.length) {
    for (let j = 0; j < h && !nodes.length; j++) for (let i = 0; i < w; i++) if (on(i, j)) {
      nodes.push(toXY(i, j));
      nodeId.set(key(i, j), 0);
      const n0 = nb(i, j)[0];
      if (n0) {
        const res3 = walk(i, j, n0[0], n0[1]);
        if (res3.end === 0) edges.push({ a: 0, b: 0, pts: res3.pts });
      }
      break;
    }
  }
  return { nodes, edges };
}

function polyLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** Remove spur edges (one end of degree 1) shorter than `spur`; merge degree-2 nodes; repeat. */
export function pruneSkeleton(sk, spur) {
  let { nodes, edges } = sk;
  for (let round = 0; round < 4; round++) {
    const deg = new Array(nodes.length).fill(0);
    for (const e of edges) {
      deg[e.a]++;
      deg[e.b]++;
    }
    const keep = edges.filter((e) => {
      const leaf = deg[e.a] === 1 || deg[e.b] === 1;
      const bothLeaf = deg[e.a] === 1 && deg[e.b] === 1;
      return bothLeaf || !leaf || polyLen(e.pts) >= spur;
    });
    const removed = keep.length !== edges.length;
    edges = keep;
    // merge chains through degree-2 nodes
    let merged = true;
    while (merged) {
      merged = false;
      const d2 = new Array(nodes.length).fill(0);
      for (const e of edges) {
        d2[e.a]++;
        d2[e.b]++;
      }
      for (let n = 0; n < nodes.length && !merged; n++) {
        if (d2[n] !== 2) continue;
        const es = edges.filter((e) => e.a === n || e.b === n);
        if (es.length !== 2 || es[0] === es[1] || (es[0].a === es[0].b)) continue;
        const [e1, e2] = es;
        const p1 = e1.b === n ? e1.pts : e1.pts.slice().reverse();
        const s1 = e1.b === n ? e1.a : e1.b;
        const p2 = e2.a === n ? e2.pts : e2.pts.slice().reverse();
        const s2 = e2.a === n ? e2.b : e2.a;
        if (s1 === n || s2 === n) continue;
        edges = edges.filter((e) => e !== e1 && e !== e2);
        edges.push({ a: s1, b: s2, pts: [...p1, ...p2.slice(1)] });
        merged = true;
      }
    }
    if (!removed) break;
  }
  // compact nodes
  const used = new Map();
  const outNodes = [];
  const map = (n) => {
    if (!used.has(n)) {
      used.set(n, outNodes.length);
      outNodes.push(nodes[n]);
    }
    return used.get(n);
  };
  const outEdges = edges.map((e) => ({ a: map(e.a), b: map(e.b), pts: e.pts }));
  return { nodes: outNodes, edges: outEdges };
}

/**
 * Corridor centerline graph as waypoints and straight segments.
 * Returns { points:[[x,y]], segs:[[i,j]] }.
 */
export function corridorCenterline(poly, { res = 4, spur = 48, tol = 8, maxSeg = 360 } = {}) {
  const r = thin(rasterize(poly, res));
  const sk = pruneSkeleton(traceSkeleton(r), spur);
  const points = sk.nodes.slice();
  const segs = [];
  const idxOf = (p) => {
    for (let i = 0; i < points.length; i++) if (dist(points[i], p) < 0.5) return i;
    points.push(p);
    return points.length - 1;
  };
  for (const e of sk.edges) {
    const simp = simplifyPolyline(e.pts, tol);
    // Densify long runs so doors have nearby attachment points and the graph follows the corridor.
    const pts = [simp[0]];
    for (let k = 1; k < simp.length; k++) {
      const a = simp[k - 1];
      const b = simp[k];
      const L = dist(a, b);
      const n = Math.ceil(L / maxSeg);
      for (let s = 1; s <= n; s++) pts.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
    }
    let prev = e.a;
    points[e.a] = pts[0];
    for (let k = 1; k < pts.length; k++) {
      const cur = k === pts.length - 1 ? e.b : idxOf(pts[k]);
      if (k === pts.length - 1) points[e.b] = pts[k];
      if (cur !== prev) segs.push([prev, cur]);
      prev = cur;
    }
  }
  return { points, segs };
}
