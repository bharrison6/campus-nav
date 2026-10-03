// Normalize a libredwg-web converted database into a compact entity list the later stages read.
//
// Output entity shapes (coordinates in DWG world units, model space only):
//   { t:'line',   L, h, p:[[x,y],[x,y]] }
//   { t:'arc',    L, h, c:[x,y], r, a0, a1 }          CCW from a0 to a1, radians, WCS
//   { t:'circle', L, h, c:[x,y], r }
//   { t:'poly',   L, h, v:[[x,y,bulge],...], closed, fm }   fm = room number from APLS_FM xdata (rooms, chases)
//   { t:'insert', L, h, name, p:[x,y], sx, sy, rot, mirror, attribs:{TAG:{text,p}} }
//   { t:'text',   L, h, text, p:[x,y], ht, rot }
//   { t:'spline', L, h, pts:[[x,y],...] }
// Block definitions use the same shapes in block coordinates, keyed by block name.

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const pt = (p) => [r6(p.x), r6(p.y)];

/** Mirror for OCS extrusion (0,0,-1): WCS x = -OCS x (arbitrary-axis algorithm). */
function isMirrored(e) {
  return !!(e.extrusionDirection && e.extrusionDirection.z < 0);
}

function fmNumber(e) {
  const x = (e.xdata || []).find((d) => d.appName === 'APLS_FM');
  const v = x && x.value && x.value[0] && x.value[0].value;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function normalizeEntity(e, attribsByOwner) {
  const L = e.layer || '0';
  const h = e.handle;
  const m = isMirrored(e);
  switch (e.type) {
    case 'LINE':
      return { t: 'line', L, h, p: [pt(e.startPoint), pt(e.endPoint)] };
    case 'ARC': {
      let c = pt(e.center);
      let a0 = e.startAngle;
      let a1 = e.endAngle;
      if (m) {
        c = [-c[0], c[1]];
        [a0, a1] = [Math.PI - a1, Math.PI - a0];
      }
      return { t: 'arc', L, h, c, r: r6(e.radius), a0: r6(a0), a1: r6(a1) };
    }
    case 'CIRCLE': {
      let c = pt(e.center);
      if (m) c = [-c[0], c[1]];
      return { t: 'circle', L, h, c, r: r6(e.radius) };
    }
    case 'LWPOLYLINE': {
      const v = (e.vertices || []).map((q) => (m ? [-r6(q.x), r6(q.y), -(q.bulge || 0)] : [r6(q.x), r6(q.y), q.bulge || 0]));
      // DWG LWPOLYLINE flag bit 512 = closed (the DXF-style `closed` field is not populated by the converter).
      const closed = !!e.closed || ((e.flag || 0) & 512) !== 0;
      return { t: 'poly', L, h, v, closed, fm: fmNumber(e) };
    }
    case 'POLYLINE2D': {
      const v = (e.vertices || []).map((q) => [r6(q.x ?? q.point?.x), r6(q.y ?? q.point?.y), q.bulge || 0]);
      return { t: 'poly', L, h, v, closed: !!e.closed || ((e.flag || 0) & 1) !== 0, fm: fmNumber(e) };
    }
    case 'INSERT': {
      const attribs = {};
      for (const a of attribsByOwner.get(h) || []) {
        const tx = a.text || {};
        attribs[a.tag] = { text: (tx.text || '').trim(), p: tx.startPoint ? pt(tx.startPoint) : null };
      }
      let p = pt(e.insertionPoint);
      if (m) p = [-p[0], p[1]];
      return {
        t: 'insert', L, h, name: e.name, p,
        sx: e.xScale ?? 1, sy: e.yScale ?? 1, rot: e.rotation || 0, mirror: m, attribs,
      };
    }
    case 'TEXT':
      return { t: 'text', L, h, text: (e.text || '').trim(), p: pt(e.startPoint || e.insertionPoint || { x: 0, y: 0 }), ht: e.textHeight || 0, rot: e.rotation || 0 };
    case 'MTEXT':
      return { t: 'text', L, h, text: String(e.text || '').replace(/\\[A-Za-z][^;]*;|[{}]/g, '').trim(), p: pt(e.insertionPoint || { x: 0, y: 0 }), ht: e.textHeight || 0, rot: e.rotation || 0 };
    case 'SPLINE': {
      const src = (e.fitPoints && e.fitPoints.length ? e.fitPoints : e.controlPoints) || [];
      return { t: 'spline', L, h, pts: src.map(pt) };
    }
    default:
      return null; // POINT, VIEWPORT, HATCH, ATTDEF, ... are not used downstream
  }
}

/** Pick the model-space owner: the block record that owns the most non-attribute entities. */
export function modelSpaceOwner(entities) {
  const counts = new Map();
  for (const e of entities) {
    if (e.type === 'ATTRIB') continue;
    counts.set(e.ownerBlockRecordSoftId, (counts.get(e.ownerBlockRecordSoftId) || 0) + 1);
  }
  let best = null;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
  return best;
}

export function normalizeDb(db, source) {
  const all = db.entities || [];
  const attribsByOwner = new Map();
  for (const e of all) {
    if (e.type !== 'ATTRIB') continue;
    const k = e.ownerBlockRecordSoftId;
    if (!attribsByOwner.has(k)) attribsByOwner.set(k, []);
    attribsByOwner.get(k).push(e);
  }
  const ms = modelSpaceOwner(all);
  const entities = [];
  for (const e of all) {
    if (e.type === 'ATTRIB' || e.ownerBlockRecordSoftId !== ms) continue;
    const n = normalizeEntity(e, attribsByOwner);
    if (n) entities.push(n);
  }
  const blocks = {};
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) {
    if (!b.name || /^\*(Model|Paper)_Space/i.test(b.name)) continue;
    const ents = (b.entities || []).map((e) => normalizeEntity(e, attribsByOwner)).filter(Boolean);
    if (ents.length) blocks[b.name] = { base: b.basePoint ? pt(b.basePoint) : [0, 0], entities: ents };
  }
  const hdr = db.header || {};
  const xy = (p) => (p ? [r6(p.x), r6(p.y)] : null);
  return {
    source,
    header: { INSUNITS: hdr.INSUNITS ?? null, LUNITS: hdr.LUNITS ?? null, MEASUREMENT: hdr.MEASUREMENT ?? null, EXTMIN: xy(hdr.EXTMIN), EXTMAX: xy(hdr.EXTMAX) },
    entities,
    blocks,
  };
}
