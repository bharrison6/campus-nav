// Stage "svg": a clean, standalone floor-plan SVG per floor.
// Styling uses presentation attributes (no <style> element) so an inlined SVG cannot leak CSS into the host page,
// and nothing load-bearing lives in comments (GAS HtmlService strips them).
import { round } from '../lib/geometry.mjs';

export const TYPE_FILL = {
  office: '#e8f0fb',
  classroom: '#e6f4ea',
  lab: '#fdf2dc',
  restroom: '#e3f5f7',
  corridor: '#f7f7f7',
  stair: '#ece4f6',
  elevator: '#f9e1ec',
  mechanical: '#e9e9e9',
  storage: '#efefe6',
  other: '#f3f1ee',
};

const f1 = (v) => {
  const r = round(v, 1);
  return Object.is(r, -0) ? '0' : String(r);
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function ringToPath(ring) {
  if (!ring.length) return '';
  let d = `M${f1(ring[0][0])} ${f1(ring[0][1])}`;
  for (let i = 1; i < ring.length; i++) d += `L${f1(ring[i][0])} ${f1(ring[i][1])}`;
  return d + 'Z';
}

/** Serialize primitives into one compact path string, dropping zero-length and duplicate segments. */
export function primsToPath(prims) {
  const seen = new Set();
  const parts = [];
  let dropped = 0;
  const segKey = (a, b) => {
    const k1 = `${f1(a[0])},${f1(a[1])}`;
    const k2 = `${f1(b[0])},${f1(b[1])}`;
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
  };
  for (const p of prims) {
    if (p.k === 'seg') {
      if (Math.hypot(p.a[0] - p.b[0], p.a[1] - p.b[1]) < 0.1) { dropped++; continue; }
      const k = segKey(p.a, p.b);
      if (seen.has(k)) { dropped++; continue; }
      seen.add(k);
      parts.push(`M${f1(p.a[0])} ${f1(p.a[1])}L${f1(p.b[0])} ${f1(p.b[1])}`);
    } else if (p.k === 'path') {
      const pts = [];
      for (const q of p.pts) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) >= 0.1) pts.push(q);
      }
      if (pts.length < 2) { dropped++; continue; }
      const k = 'P' + pts.map((q) => `${f1(q[0])},${f1(q[1])}`).join(';');
      if (seen.has(k)) { dropped++; continue; }
      seen.add(k);
      let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
      for (let i = 1; i < pts.length; i++) d += `L${f1(pts[i][0])} ${f1(pts[i][1])}`;
      if (p.closed) d += 'Z';
      parts.push(d);
    } else if (p.k === 'arc') {
      let sweep = p.a1 - p.a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      if (p.r < 0.1) { dropped++; continue; }
      const s = [p.c[0] + p.r * Math.cos(p.a0), p.c[1] + p.r * Math.sin(p.a0)];
      const e = [p.c[0] + p.r * Math.cos(p.a1), p.c[1] + p.r * Math.sin(p.a1)];
      const k = `A${f1(p.c[0])},${f1(p.c[1])},${f1(p.r)},${f1(p.a0)},${f1(p.a1)}`;
      if (seen.has(k)) { dropped++; continue; }
      seen.add(k);
      parts.push(`M${f1(s[0])} ${f1(s[1])}A${f1(p.r)} ${f1(p.r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f1(e[0])} ${f1(e[1])}`);
    } else if (p.k === 'circle') {
      if (p.r < 0.1) { dropped++; continue; }
      const k = `C${f1(p.c[0])},${f1(p.c[1])},${f1(p.r)}`;
      if (seen.has(k)) { dropped++; continue; }
      seen.add(k);
      const x0 = p.c[0] - p.r;
      const x1 = p.c[0] + p.r;
      parts.push(`M${f1(x0)} ${f1(p.c[1])}A${f1(p.r)} ${f1(p.r)} 0 1 1 ${f1(x1)} ${f1(p.c[1])}A${f1(p.r)} ${f1(p.r)} 0 1 1 ${f1(x0)} ${f1(p.c[1])}`);
    }
  }
  return { d: parts.join(''), dropped, kept: parts.length };
}

export function labelFontSize(room) {
  const text = room.svgLabel || room.label;
  const byRoom = room.inradius * 0.6;
  const byWidth = (2 * room.inradius * 1.6) / Math.max(1, 0.62 * text.length);
  return Math.max(6, Math.min(30, byRoom, byWidth));
}

export function buildSvg(fp) {
  const W = round(fp.width, 1);
  const H = round(fp.height, 1);
  const wallPrims = fp.prims.filter((p) => p.k !== 'text' && !/FIXT/i.test(p.L));
  const fixtPrims = fp.prims.filter((p) => p.k !== 'text' && /FIXT/i.test(p.L));
  const walls = primsToPath(wallPrims);
  const fixt = primsToPath(fixtPrims);
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ` +
      `data-floor-id="${esc(fp.floor.floorId)}" data-meters-per-unit="${fp.units.metersPerUnit}" ` +
      `font-family="Arial, Helvetica, sans-serif">`
  );
  out.push(`<title>${esc(fp.buildingName + ' ' + fp.floor.label)}</title>`);
  out.push(`<rect id="background" x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push('<g id="rooms" stroke="#b9c2cc" stroke-width="1.5" stroke-linejoin="round">');
  for (const r of fp.rooms) {
    out.push(
      `<path data-room-id="${esc(r.id)}" data-room-number="${esc(r.number)}" data-room-type="${r.type}" ` +
        `fill="${TYPE_FILL[r.type] || TYPE_FILL.other}" d="${ringToPath(r.polygon)}"/>`
    );
  }
  out.push('</g>');
  if (fixt.d) out.push(`<g id="fixtures" fill="none" stroke="#8a8f96" stroke-width="1" stroke-linecap="round"><path d="${fixt.d}"/></g>`);
  out.push(`<g id="walls" fill="none" stroke="#2b2f36" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${walls.d}"/></g>`);
  out.push('<g id="labels" fill="#1f2a37" text-anchor="middle" dominant-baseline="central" pointer-events="none">');
  for (const r of fp.rooms) {
    if (r.kind === 'chase') continue;
    const fs = labelFontSize(r);
    out.push(`<text data-room-id="${esc(r.id)}" x="${f1(r.center[0])}" y="${f1(r.center[1])}" font-size="${f1(fs)}">${esc(r.svgLabel || r.label)}</text>`);
  }
  out.push('</g>');
  out.push('</svg>');
  return { svg: out.join('\n') + '\n', stats: { wallSegments: walls.kept, fixtureSegments: fixt.kept, droppedSegments: walls.dropped + fixt.dropped } };
}
