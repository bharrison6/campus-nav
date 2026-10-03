// Turn normalized entities into drawable/analysable primitives, expanding INSERT blocks.
//   { k:'seg', a:[x,y], b:[x,y], L }
//   { k:'arc', c:[x,y], r, a0, a1, L }      (top-level arcs; CCW a0->a1)
//   { k:'circle', c, r, L }
//   { k:'path', pts:[[x,y],...], closed, L }
//   { k:'text', p, text, ht, rot, L }
import { arcPoints, expandBulges, makeInsertTransform } from './geometry.mjs';

const MAX_DEPTH = 4;

export function entityToPrimitives(e, blocks, xf = null, layerOverride = null, depth = 0, out = [], arcSink = null) {
  const L = layerOverride && (e.L === '0' || !e.L) ? layerOverride : e.L;
  const T = xf || ((p) => p);
  switch (e.t) {
    case 'line':
      out.push({ k: 'seg', a: T(e.p[0]), b: T(e.p[1]), L });
      break;
    case 'arc':
      if (!xf) {
        out.push({ k: 'arc', c: e.c, r: e.r, a0: e.a0, a1: e.a1, L });
        if (arcSink) arcSink.push({ c: e.c, r: e.r, a0: e.a0, a1: e.a1, L, src: 'arc' });
      } else {
        const pts = arcPoints(e.c, e.r, e.a0, e.a1, 0.5).map(T);
        out.push({ k: 'path', pts, closed: false, L, fromArc: true });
        if (arcSink) arcSink.push({ pts, L, src: 'block-arc', c: T(e.c), ends: [pts[0], pts[pts.length - 1]] });
      }
      break;
    case 'circle':
      if (!xf) out.push({ k: 'circle', c: e.c, r: e.r, L });
      else out.push({ k: 'path', pts: arcPoints(e.c, e.r, 0, 2 * Math.PI, 0.5).map(T), closed: true, L, fromArc: true });
      break;
    case 'poly': {
      const pts = expandBulges(e.v.map((v) => ({ x: v[0], y: v[1], bulge: v[2] })), e.closed, 0.5).map(T);
      if (pts.length >= 2) out.push({ k: 'path', pts, closed: e.closed, L });
      break;
    }
    case 'spline':
      if (e.pts.length >= 2) out.push({ k: 'path', pts: e.pts.map(T), closed: false, L });
      break;
    case 'text':
      if (e.text) out.push({ k: 'text', p: T(e.p), text: e.text, ht: e.ht, rot: e.rot, L });
      break;
    case 'insert': {
      if (depth >= MAX_DEPTH) break;
      const b = blocks[e.name];
      if (!b) break;
      const inner = makeInsertTransform({ base: b.base, sx: e.sx, sy: e.sy, rot: e.rot, at: e.mirror ? [-e.p[0], e.p[1]] : e.p });
      const mir = e.mirror ? (p) => [-p[0], p[1]] : (p) => p;
      const local = (p) => T(mir(inner(p)));
      for (const be of b.entities) {
        if (be.t === 'text' && be.L === '0') continue; // attribute definitions / block-local labels
        entityToPrimitives(be, blocks, local, L, depth + 1, out, arcSink);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/** Bounding box of a primitive (cheap; arcs use the full circle). */
export function primBBox(p) {
  switch (p.k) {
    case 'seg':
      return { minX: Math.min(p.a[0], p.b[0]), minY: Math.min(p.a[1], p.b[1]), maxX: Math.max(p.a[0], p.b[0]), maxY: Math.max(p.a[1], p.b[1]) };
    case 'arc':
    case 'circle':
      return { minX: p.c[0] - p.r, minY: p.c[1] - p.r, maxX: p.c[0] + p.r, maxY: p.c[1] + p.r };
    case 'path': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of p.pts) {
        if (q[0] < minX) minX = q[0];
        if (q[1] < minY) minY = q[1];
        if (q[0] > maxX) maxX = q[0];
        if (q[1] > maxY) maxY = q[1];
      }
      return { minX, minY, maxX, maxY };
    }
    case 'text':
      return { minX: p.p[0], minY: p.p[1], maxX: p.p[0], maxY: p.p[1] };
    default:
      return null;
  }
}

/** Apply a point transform to a primitive (used for the DWG -> SVG frame change). Arcs flip orientation with y. */
export function transformPrimitive(p, T, flipsY) {
  switch (p.k) {
    case 'seg':
      return { ...p, a: T(p.a), b: T(p.b) };
    case 'arc':
      return flipsY ? { ...p, c: T(p.c), a0: -p.a1, a1: -p.a0 } : { ...p, c: T(p.c) };
    case 'circle':
      return { ...p, c: T(p.c) };
    case 'path':
      return { ...p, pts: p.pts.map(T) };
    case 'text':
      return { ...p, p: T(p.p), rot: flipsY ? -p.rot : p.rot };
    default:
      return p;
  }
}
