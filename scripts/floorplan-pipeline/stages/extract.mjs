// Stage "extract": rooms, labels, walls, extents (doors, verticals and types are layered on in later helpers).
import {
  area, bbox, bboxUnion, centroid, cleanRing, dist, expandBulges, pointInPolygon, poleOfInaccessibility, round,
} from '../lib/geometry.mjs';
import { entityToPrimitives, primBBox, transformPrimitive } from '../lib/primitives.mjs';
import { EXCLUDED_LAYER, INSUNITS_METERS } from '../config.mjs';

const ROOM_LAYER = /^AREA-ROOM$/i;
const CHASE_LAYER = /^AREA-CHAS$/i;
const GROSS_LAYER = /^AREA-GROS$/i;
const OPEN_BELOW_LAYER = /^AREA-OTBW$/i;
const TAG_BLOCK = /^FMGRM1$/i;
const DRAW_LAYER = /^A-(BLDG|ANNO)/i;
const CLIP_MARGIN = 240; // drawing units around the gross outline kept as plan content
const PAD = 36; // drawing units of padding around the plan extents

function ringOf(e) {
  const pts = expandBulges(e.v.map((v) => ({ x: v[0], y: v[1], bulge: v[2] })), true, 0.5);
  return cleanRing(pts, 0.01);
}

/** Closure verdict for an AREA-ROOM polyline (the DWG closed flag is unreliable in the converter output). */
export function closeRing(e) {
  const ring = ringOf(e);
  const first = e.v[0];
  const last = e.v[e.v.length - 1];
  const gap = first && last ? Math.hypot(first[0] - last[0], first[1] - last[1]) : 0;
  let method;
  if (e.closed) method = 'closed-flag';
  else if (gap <= 0.01) method = 'coincident-endpoints';
  else method = 'implied-closing-edge';
  return { ring, method, gap };
}

export function parseAreaSf(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

/** Human label for a CAD room number: leading zeros dropped ("0140B" -> "140B"). */
export function labelFromNumber(number) {
  if (!number) return '';
  const s = String(number).replace(/^0+(?=\d)/, '');
  return s;
}

export function extractFloor(norm, floor, { log = () => {} } = {}) {
  const anomalies = [];
  const ents = norm.entities.filter((e) => !EXCLUDED_LAYER.test(e.L));

  // Units.
  const insunits = norm.header?.INSUNITS;
  let metersPerUnit = INSUNITS_METERS[insunits];
  let unitsMethod;
  if (metersPerUnit) unitsMethod = `$INSUNITS=${insunits} (${insunits === 1 ? 'inches' : 'see AutoCAD table'})`;
  else {
    metersPerUnit = 0.0254;
    unitsMethod = '$INSUNITS unreadable; assumed inches';
  }

  // Gross outline -> clip region.
  const grossE = ents.find((e) => e.t === 'poly' && GROSS_LAYER.test(e.L));
  const gross = grossE ? ringOf(grossE) : null;

  // Rooms and chases.
  const tags = ents.filter((e) => e.t === 'insert' && TAG_BLOCK.test(e.name)).map((e) => ({
    handle: e.h,
    layer: e.L,
    p: e.p,
    number: e.attribs.RMNUMB?.text || '',
    numberPos: e.attribs.RMNUMB?.p || e.p,
    door: e.attribs.RMDOOR?.text || '',
    data: ['DATA1', 'DATA2', 'DATA3', 'DATA4', 'DATA5'].map((k) => e.attribs[k]?.text || '').filter(Boolean),
    areaSf: parseAreaSf(e.attribs.RMAREA?.text),
    used: false,
  }));
  const tagByNumber = new Map();
  for (const t of tags) {
    if (!t.number) continue;
    if (tagByNumber.has(t.number)) anomalies.push({ kind: 'duplicate-tag-number', number: t.number });
    else tagByNumber.set(t.number, t);
  }

  const spaces = [];
  for (const e of ents) {
    if (e.t !== 'poly') continue;
    const isRoom = ROOM_LAYER.test(e.L);
    const isChase = CHASE_LAYER.test(e.L);
    if (!isRoom && !isChase) continue;
    const { ring, method, gap } = closeRing(e);
    if (ring.length < 3 || area(ring) < 1) {
      anomalies.push({ kind: 'degenerate-room-polyline', handle: e.h, layer: e.L });
      continue;
    }
    spaces.push({ handle: e.h, kind: isChase ? 'chase' : 'room', ring, closure: method, closureGap: round(gap, 1), fm: e.fm });
  }

  // Match tags: xdata number first, then tag point in polygon, then nearest unmatched tag within reach.
  const byFm = new Map();
  for (const s of spaces) {
    if (s.fm && tagByNumber.has(s.fm) && !tagByNumber.get(s.fm).used) {
      s.tag = tagByNumber.get(s.fm);
      s.tag.used = true;
      s.matchedBy = 'xdata-number';
      if (!pointInPolygon(s.tag.p, s.ring) && !pointInPolygon(s.tag.numberPos, s.ring)) {
        anomalies.push({ kind: 'tag-outside-its-polygon', number: s.fm });
      }
    }
    if (s.fm) byFm.set(s.fm, s);
  }
  for (const s of spaces) {
    if (s.tag) continue;
    const inside = tags.filter((t) => !t.used && (pointInPolygon(t.p, s.ring) || pointInPolygon(t.numberPos, s.ring)));
    if (inside.length) {
      inside.sort((a, b) => dist(a.p, centroid(s.ring)) - dist(b.p, centroid(s.ring)));
      s.tag = inside[0];
      s.tag.used = true;
      s.matchedBy = 'tag-in-polygon';
      if (s.fm && s.fm !== s.tag.number) anomalies.push({ kind: 'xdata-number-differs-from-tag', xdata: s.fm, tag: s.tag.number });
    }
  }
  let unk = 0;
  for (const s of spaces) {
    if (s.tag) {
      s.number = s.tag.number;
    } else if (s.fm) {
      s.number = s.fm;
      s.matchedBy = 'xdata-number-no-tag';
      anomalies.push({ kind: 'room-without-tag', number: s.fm });
    } else {
      s.number = `UNK-${++unk}`;
      s.matchedBy = 'synthetic';
      anomalies.push({ kind: 'room-without-number', handle: s.handle, areaSf: round(area(s.ring) / 144, 0) });
    }
  }
  for (const t of tags) {
    if (!t.used) anomalies.push({ kind: 'tag-without-polygon', number: t.number, layer: t.layer });
  }

  // Area check against the tag's RMAREA.
  const sfPerUnit2 = (metersPerUnit / 0.3048) ** 2;
  for (const s of spaces) {
    s.areaSf = area(s.ring) * sfPerUnit2;
    s.tagAreaSf = s.tag ? s.tag.areaSf : null;
    if (s.tagAreaSf != null && s.tagAreaSf > 0) {
      const diff = Math.abs(s.areaSf - s.tagAreaSf);
      if (diff > Math.max(2, 0.03 * s.tagAreaSf)) anomalies.push({ kind: 'area-mismatch', number: s.number, polygonSf: round(s.areaSf, 0), tagSf: s.tagAreaSf });
    }
  }

  // Drawing primitives (walls, fixtures, doors and windows expanded from blocks).
  const arcs = [];
  let prims = [];
  const blockDoors = [];
  for (const e of ents) {
    if (!DRAW_LAYER.test(e.L)) continue;
    if (e.t === 'insert' && /^ZDR/i.test(e.name)) {
      const sink = [];
      const before = prims.length;
      entityToPrimitives(e, norm.blocks, null, null, 0, prims, sink);
      blockDoors.push({ handle: e.h, name: e.name, p: e.p, doorNo: e.attribs.DOOR_NO?.text || '', arcs: sink, primRange: [before, prims.length] });
      continue;
    }
    if (e.t === 'insert') {
      entityToPrimitives(e, norm.blocks, null, null, 0, prims, null);
      continue;
    }
    entityToPrimitives(e, norm.blocks, null, null, 0, prims, e.t === 'arc' ? arcs : null);
  }
  const fixtures = ents
    .filter((e) => e.t === 'insert' && /^(TOILET|URINAL|SINK|RTOI|LAV)/i.test(e.name))
    .map((e) => ({ name: e.name, p: e.p })); // normalized INSERT points are already WCS

  // Extents: rooms + gross outline + drawing primitives that fall near the building.
  let roomBox = null;
  for (const s of spaces) roomBox = bboxUnion(roomBox, bbox(s.ring));
  if (gross) roomBox = bboxUnion(roomBox, bbox(gross));
  if (!roomBox) throw new Error(`${floor.floorId}: no rooms and no gross outline`);
  const clip = { minX: roomBox.minX - CLIP_MARGIN, minY: roomBox.minY - CLIP_MARGIN, maxX: roomBox.maxX + CLIP_MARGIN, maxY: roomBox.maxY + CLIP_MARGIN };
  const inClip = (b) => b && b.minX >= clip.minX && b.maxX <= clip.maxX && b.minY >= clip.minY && b.maxY <= clip.maxY;
  const dropped = prims.filter((p) => !inClip(primBBox(p))).length;
  if (dropped) anomalies.push({ kind: 'drawing-outside-building-dropped', count: dropped });
  prims = prims.filter((p) => inClip(primBBox(p)));
  let ext = roomBox;
  for (const p of prims) if (p.k !== 'text') ext = bboxUnion(ext, primBBox(p));
  ext = { minX: ext.minX - PAD, minY: ext.minY - PAD, maxX: ext.maxX + PAD, maxY: ext.maxY + PAD };

  // Frame change: DWG (y up) -> SVG (origin at extents min-x / max-y, y down).
  const ox = ext.minX;
  const oy = ext.maxY;
  const T = (p) => [p[0] - ox, oy - p[1]];
  const width = ext.maxX - ext.minX;
  const height = ext.maxY - ext.minY;

  const svgPrims = prims.map((p) => transformPrimitive(p, T, true));
  const svgArcs = arcs.map((a) => transformPrimitive({ k: 'arc', ...a }, T, true));
  for (const d of blockDoors) {
    d.p = T(d.p);
    d.arcs = d.arcs.map((a) => ({ ...a, pts: a.pts.map(T), c: T(a.c), ends: a.ends.map(T) }));
  }

  const rooms = spaces.map((s) => {
    const ring = s.ring.map(T);
    const pole = poleOfInaccessibility(ring, 2);
    return {
      handle: s.handle,
      kind: s.kind,
      number: s.number,
      label: labelFromNumber(s.number) + (s.tag && s.tag.data.length ? ' ' + s.tag.data.join(' ') : ''),
      useText: s.tag ? s.tag.data.join(' ') : '',
      polygon: ring,
      center: [pole[0], pole[1]],
      inradius: pole[2],
      areaSf: s.areaSf,
      tagAreaSf: s.tagAreaSf,
      closure: s.closure,
      closureGap: s.closureGap,
      matchedBy: s.matchedBy,
      tagPos: s.tag ? T(s.tag.p) : null,
    };
  });

  const openBelow = ents.filter((e) => e.t === 'poly' && OPEN_BELOW_LAYER.test(e.L)).map((e) => ringOf(e).map(T));

  log(`  ${floor.floorId}: ${rooms.length} spaces, ${tags.length} tags, ${svgPrims.length} primitives, ${svgArcs.length} arcs, ${blockDoors.length} door blocks`);
  return {
    floor,
    units: { insunits, metersPerUnit, method: unitsMethod },
    origin: { x: ox, y: oy, note: 'SVG (x, y) = (dwgX - origin.x, origin.y - dwgY)' },
    width,
    height,
    gross: gross ? gross.map(T) : null,
    rooms,
    prims: svgPrims,
    arcs: svgArcs,
    blockDoors,
    fixtures: fixtures.map((f) => ({ ...f, p: T(f.p) })),
    openBelow,
    anomalies,
  };
}
