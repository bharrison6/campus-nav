// Room typing from geometry. The DWGs carry no use text (DATA1..DATA5 are empty on every floor), so a type is only
// asserted where the drawing gives evidence; everything else is `other`. Each room records `typeEvidence`.
import { bbox, bboxOverlapArea, dist, distToPolygon, pointInPolygon } from './geometry.mjs';
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

export function distance(a, b) {
  return dist(a, b);
}
