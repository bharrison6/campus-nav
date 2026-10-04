// Room typing from geometry. The DWGs carry no use text (DATA1..DATA5 are empty on every floor), so a type is only
// asserted where the drawing gives evidence; everything else is `other`. Each room records `typeEvidence`.
import { bbox, bboxOverlapArea, distToPolygon, pointInPolygon } from './geometry.mjs';
import { longestTreadRun, segmentsInside } from './detect.mjs';

export const SF_PER_SQIN = 1 / 144;

/** Raster-sampled intersection-over-union of two polygons (same coordinate frame). */
export function polygonIoU(A, B, samples = 4000) {
  const a = bbox(A);
  const b = bbox(B);
  if (!bboxOverlapArea(a, b)) return 0;
  const u = { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
  const step = Math.max(1, Math.sqrt(((u.maxX - u.minX) * (u.maxY - u.minY)) / samples));
  let inter = 0;
  let uni = 0;
  for (let x = u.minX + step / 2; x < u.maxX; x += step) {
    for (let y = u.minY + step / 2; y < u.maxY; y += step) {
      const ia = pointInPolygon([x, y], A);
      const ib = pointInPolygon([x, y], B);
      if (ia && ib) inter++;
      if (ia || ib) uni++;
    }
  }
  return uni ? inter / uni : 0;
}

/** Corridor shape test: narrow (inradius <= 72 in, i.e. <= 12 ft wide) and long (area / inradius^2 >= 14). */
export function corridorShape(room) {
  const areaUnits = room.areaSf / SF_PER_SQIN;
  const elong = areaUnits / Math.max(1, room.inradius * room.inradius);
  return { elong, narrow: room.inradius <= 72, long: elong >= 14 };
}

/** Floor-root circulation numbering seen in these drawings: 1300D, 2300H, 0200 ... (a "00" room plus optional letter). */
export function isCirculationNumber(number) {
  return /^\d?\d00[A-Z]?$/.test(number);
}

/**
 * Per-floor evidence pass. Mutates rooms: sets treadRun, fixtures, xShaft, corridor shape metrics.
 */
export function floorEvidence(fp, wallIndex, shaftXs) {
  for (const r of fp.rooms) {
    r.evidence = {};
    if (r.kind === 'chase') continue;
    const tr = longestTreadRun(segmentsInside(wallIndex, r.polygon));
    r.evidence.treadRun = tr.count;
    r.evidence.toilets = fp.fixtures.filter((f) => /^(TOILET|URINAL|RTOI)/i.test(f.name) && pointInPolygon(f.p, r.polygon)).length;
    // The X is drawn on the shaft, which can sit a little outside the room polygon (polygons follow wall faces).
    r.evidence.xShaft = r.areaSf <= 120 && shaftXs.some((x) => pointInPolygon(x.center, r.polygon) || distToPolygon(x.center, r.polygon) <= 30);
    const cs = corridorShape(r);
    r.evidence.elongation = Math.round(cs.elong);
    r.evidence.inradius = Math.round(r.inradius);
  }
}

/**
 * Building pass: stack rooms across floors (shared DWG frame), then assign types.
 * floors: [{ fp, toDwg(p) }] for one building, ordered by level.
 * Returns { stacks, frameCheck } where stacks link vertically matching rooms.
 */
export function classifyBuilding(floors, { log = () => {} } = {}) {
  // Polygons in the building's shared DWG frame.
  for (const F of floors) for (const r of F.fp.rooms) r._dwg = r.polygon.map(F.toDwg);

  // Stacks: for each room, its best match on every other floor.
  const best = (r, F2) => {
    let bestR = null;
    let bestV = 0;
    const rb = bbox(r._dwg);
    for (const q of F2.fp.rooms) {
      if (q.kind === 'chase' || !bboxOverlapArea(rb, bbox(q._dwg))) continue;
      const v = polygonIoU(r._dwg, q._dwg, 1500);
      if (v > bestV) {
        bestV = v;
        bestR = q;
      }
    }
    return { room: bestR, iou: bestV };
  };

  // Stairs: tread evidence on this floor, or footprint stacked (IoU >= 0.6) on a tread-evidenced stair elsewhere.
  const treadStairs = [];
  for (const F of floors) for (const r of F.fp.rooms) if (r.kind === 'room' && r.evidence.treadRun >= 6) treadStairs.push({ F, r });
  const stairGroups = [];
  for (const { F, r } of treadStairs) {
    let g = stairGroups.find((gg) => gg.members.some((m) => m.r === r));
    if (!g) {
      g = { kind: 'stair', members: [{ F, r, why: `stair treads (${r.evidence.treadRun} parallel lines)` }] };
      stairGroups.push(g);
    }
    for (const F2 of floors) {
      if (F2 === F || g.members.some((m) => m.F === F2)) continue;
      const m = best(r, F2);
      if (m.room && m.iou >= 0.6 && m.room.areaSf > 0.4 * r.areaSf && m.room.areaSf < 2.5 * r.areaSf) {
        const other = stairGroups.find((gg) => gg !== g && gg.members.some((mm) => mm.r === m.room));
        if (other) {
          for (const mm of other.members) if (!g.members.some((x) => x.F === mm.F)) g.members.push(mm);
          stairGroups.splice(stairGroups.indexOf(other), 1);
        } else {
          g.members.push({ F: F2, r: m.room, why: `footprint stacked on stair ${r.number} (IoU ${m.iou.toFixed(2)})` });
        }
      }
    }
  }

  // Elevators: (a) a boxed-X shaft inside a small room's stacked footprint on any floor; (b) a small (40..110 sf)
  // room stacked (IoU >= 0.85) on two or more floors with no door swing on any floor (sliding doors).
  const elevGroups = [];
  const inGroup = (r) => stairGroups.some((g) => g.members.some((m) => m.r === r)) || elevGroups.some((g) => g.members.some((m) => m.r === r));
  for (const F of floors) {
    for (const r of F.fp.rooms) {
      if (r.kind !== 'room' || r.areaSf < 25 || r.areaSf > 120 || inGroup(r)) continue;
      const members = [{ F, r }];
      for (const F2 of floors) {
        if (F2 === F) continue;
        const m = best(r, F2);
        if (m.room && m.iou >= 0.85 && !inGroup(m.room)) members.push({ F: F2, r: m.room, iou: m.iou });
      }
      if (members.length < 2) continue;
      const hasX = members.some((m) => m.r.evidence.xShaft);
      const noSwing = members.every((m) => !m.r.evidence.doorSwings);
      const sized = members.every((m) => m.r.areaSf >= 40 && m.r.areaSf <= 110);
      if (hasX) {
        elevGroups.push({ kind: 'elevator', members: members.map((m) => ({ ...m, why: `stacked small shaft with a boxed-X shaft symbol on ${members.filter((x) => x.r.evidence.xShaft).map((x) => x.F.fp.floor.floorId).join(', ')}` })) });
      } else if (noSwing && sized) {
        elevGroups.push({ kind: 'elevator', members: members.map((m) => ({ ...m, why: 'stacked 40-110 sf shaft on every floor with no door swing (sliding doors)' })) });
      }
    }
  }

  // Assign types.
  for (const g of [...stairGroups, ...elevGroups]) {
    for (const m of g.members) {
      m.r.type = g.kind;
      m.r.typeEvidence = m.why;
    }
  }
  for (const F of floors) {
    for (const r of F.fp.rooms) {
      if (r.type) continue;
      if (r.kind === 'chase') {
        r.type = 'mechanical';
        r.typeEvidence = 'AREA-CHAS chase polygon';
        continue;
      }
      const e = r.evidence;
      if (e.toilets >= 1) {
        r.type = 'restroom';
        r.typeEvidence = `${e.toilets} toilet/urinal fixture block(s)`;
        continue;
      }
      const cs = corridorShape(r);
      const circ = isCirculationNumber(r.number);
      if (r.areaSf >= 80 && ((cs.narrow && cs.long) || (circ && r.inradius <= 96 && cs.elong >= 8 && (e.openingCount || 0) >= 3))) {
        r.type = 'corridor';
        r.typeEvidence = cs.narrow && cs.long
          ? `narrow and long (inradius ${Math.round(r.inradius)} in, area/inradius^2 ${Math.round(cs.elong)})`
          : `circulation number ${r.number} with elongated shape and ${e.openingCount} openings`;
        continue;
      }
      if (r.areaSf < 30) {
        r.type = 'storage';
        r.typeEvidence = `under 30 sf (${Math.round(r.areaSf)} sf): closet`;
        continue;
      }
      r.type = 'other';
      r.typeEvidence = 'no use text in the DWG and no geometric evidence';
    }
  }
  for (const F of floors) for (const r of F.fp.rooms) delete r._dwg;
  log(`  ${floors[0].fp.floor.bldg}: ${stairGroups.length} stair stacks, ${elevGroups.length} elevator stacks`);
  return { stairGroups, elevGroups };
}

/** Searchable unless it is circulation or building service space. */
export function isSearchable(room) {
  if (room.kind === 'chase') return false;
  return !['corridor', 'mechanical'].includes(room.type);
}


// ---- circulation spaces the shape test misses (v5) ----
//
// Measured on the v4 data: of 358 `other` rooms, the hallways the shape test missed are wide or short halls that serve
// many rooms (IT 0250Q serves 21, EP 1357 serves 9), lobbies and halls in a floor's circulation numbering (IT 0200E,
// EP 1300, 2300, 1300T), and open links that join two hallways with area lines and no door (IT 0115O, 0115Q, 0130).
// refineCirculation types those `corridor` where the passages give strong evidence; corridorCandidates lists the rest
// of the circulation-like `other` rooms (vestibules, alcoves, small halls) for the admin floor-plan editor.

function convexHullArea(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return 0;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of p.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  let s = 0;
  for (let i = 0; i < h.length; i++) s += h[i][0] * h[(i + 1) % h.length][1] - h[(i + 1) % h.length][0] * h[i][1];
  return Math.abs(s) / 2;
}

/** Area of the room over the area of its convex hull: about 1 for a rectangle, lower for an L or T. */
export function convexity(polygon) {
  let s = 0;
  for (let i = 0; i < polygon.length; i++) s += polygon[i][0] * polygon[(i + 1) % polygon.length][1] - polygon[(i + 1) % polygon.length][0] * polygon[i][1];
  const hull = convexHullArea(polygon);
  return hull ? Math.abs(s) / 2 / hull : 1;
}

/** Per room index: what its passages connect. { neighbors: Set, hallways: Set, doors, open, exterior }. */
export function passageEvidence(fp, openings) {
  const out = new Map(fp.rooms.map((r, i) => [i, { neighbors: new Set(), hallways: new Set(), doors: 0, open: 0, exterior: 0 }]));
  for (const o of openings) {
    for (const [p, q] of [[o.a, o.b], [o.b, o.a]]) {
      if (p < 0) continue;
      const e = out.get(p);
      if (o.kind === 'door' || o.kind === 'inferred') e.doors++;
      else e.open++;
      if (q < 0) e.exterior++;
      else {
        e.neighbors.add(q);
        if (fp.rooms[q].type === 'corridor') e.hallways.add(q);
      }
    }
  }
  return out;
}

/** The rule (if any) that makes an `other` room a hallway, with its evidence text; null when the evidence is weak. */
export function circulationRule(r, e) {
  const n = e.neighbors.size;
  const h = e.hallways.size;
  if (isCirculationNumber(r.number) && r.areaSf >= 80 && n >= 3 && h >= 1) {
    return `circulation number ${r.number} with passages to ${n} spaces, ${h} of them hallways`;
  }
  if (!e.doors && !e.exterior && h >= 2 && r.areaSf >= 40) {
    return `open link between ${h} hallways (area lines or openings, no door)`;
  }
  if (n >= 7 && r.inradius <= 96 && h >= 1) {
    return `hall serving ${n} spaces, ${Math.round((2 * r.inradius) / 12)} ft wide at most`;
  }
  if (r.inradius <= 60 && corridorShape(r).elong >= 8 && h >= 2 && n >= 3) {
    return `narrow passage (inradius ${Math.round(r.inradius)} in) joining ${h} hallways and ${n - h} other spaces`;
  }
  return null;
}

/**
 * Types more circulation spaces `corridor` on one floor (after classifyBuilding, before the graph). Repeats while
 * rooms change (a new hallway is a neighbor of the next), at most three passes. Returns the rooms it retyped.
 */
export function refineCirculation(fp, openings) {
  const moved = [];
  for (let pass = 0; pass < 3; pass++) {
    const ev = passageEvidence(fp, openings);
    const now = [];
    fp.rooms.forEach((r, i) => {
      if (r.kind !== 'room' || r.type !== 'other') return;
      const why = circulationRule(r, ev.get(i));
      if (why) now.push([r, why]);
    });
    if (!now.length) break;
    for (const [r, why] of now) {
      r.type = 'corridor';
      r.typeEvidence = why;
      moved.push(r);
    }
  }
  return moved;
}

/**
 * Circulation-like rooms still typed `other`, for review in the admin floor-plan editor (data/review/
 * corridor-candidates.json). Evidence is weighed into a confidence in [0, 1]; rooms at 0.35 or more are listed.
 * @param {Object} fp      the floor (rooms typed, ids set)
 * @param {Object[]} openings
 * @param {Object} graph   the floor graph (hub map, edges) to see whether routes pass through the room
 */
export function corridorCandidates(fp, openings, graph) {
  const ev = passageEvidence(fp, openings);
  const degree = new Map();
  for (const e of graph.edges) for (const n of [e.from, e.to]) degree.set(n.id, (degree.get(n.id) || 0) + 1);
  const out = [];
  fp.rooms.forEach((r, i) => {
    if (r.kind !== 'room' || r.type !== 'other') return;
    const e = ev.get(i);
    const n = e.neighbors.size;
    const cs = corridorShape(r);
    const conv = convexity(r.polygon);
    const hub = graph.hub.get(i);
    const evidence = [];
    let c = 0;
    const add = (w, text) => {
      c += w;
      evidence.push(text);
    };
    if (isCirculationNumber(r.number)) add(0.3, `circulation-style number ${r.number}`);
    if (e.exterior && r.areaSf <= 300 && n >= 1 && n <= 2) add(0.35, `vestibule: an exterior door and ${n} inner passage${n === 1 ? '' : 's'}, ${Math.round(r.areaSf)} sf`);
    if (n >= 4) add(Math.min(0.35, 0.2 + 0.03 * (n - 4)), `passages to ${n} spaces`);
    if (cs.narrow && cs.elong >= 8) add(0.2, `narrow and long (inradius ${Math.round(r.inradius)} in, area/inradius^2 ${Math.round(cs.elong)})`);
    if (conv < 0.75) add(0.1, `L or T shaped (convexity ${conv.toFixed(2)})`);
    if (e.open && e.hallways.size) add(0.15, `open to ${e.hallways.size} hallway${e.hallways.size === 1 ? '' : 's'} (area line or opening, no door)`);
    if (hub && (degree.get(hub.id) || 0) >= 3) add(0.15, `routes pass through it (${degree.get(hub.id)} passages meet at its center)`);
    if (r.number.startsWith('UNK-')) add(0.1, 'no room number in the drawing');
    const confidence = round(Math.min(1, c), 2);
    if (confidence < 0.35) return;
    out.push({ roomId: r.id, number: r.number, label: r.label, floorId: fp.floor.floorId, areaSqFt: Math.round(r.areaSf), confidence, evidence });
  });
  return out.sort((a, b) => b.confidence - a.confidence || (a.roomId < b.roomId ? -1 : 1));
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
