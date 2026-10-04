// Stage "primary entrances": which of a building's exterior doors a visitor should be routed to.
//
// Run by the campus-map build (scripts/campus-map/run.mjs), which knows where the doors are on the map (the georef)
// and where the walking paths are (OpenStreetMap + overrides). Every entrance node on a public floor that is joined to
// the building's main indoor component is scored from four factors, each in [0, 1]:
//   room    the space the door opens into: corridor (lobby, vestibule, hall) 1, unclassified 0.5, a working room
//           (office, classroom, lab) 0.3, restroom/storage/mechanical 0.1, a stairwell (an exit stair) 0.15
//   width   the door's clear width: a double door (>= 60 in) 1, >= 42 in 0.6, else 0.3
//   path    the distance to the nearest walking path: 1 at the door, 0 at 40 m (a road counts 10 m farther)
//   facing  whether the door faces that path: cosine of the angle between the door's outward direction (the normal
//           of the nearest outline edge, outside) and the direction to the path point, floored at 0 (1 when the path
//           is closer than 3 m)
// score = 0.35 room + 0.2 width + 0.3 path + 0.15 facing. The top-scoring entrance is primary; the next ones are too
// while the building has fewer than 2, or fewer than 4 and they score at least 0.75 of the best. A door within 8 m of
// one already chosen (the other leaf of a pair, the second door of a vestibule) is skipped, and so is a door on the
// same face as a chosen one (within 30 m and facing within 60 degrees of it): the set covers different approaches.
// The operator overrides the choice per node in the admin (NavNodes.primary).
import { round } from '../lib/geometry.mjs';

export const WEIGHTS = { room: 0.35, width: 0.2, path: 0.3, facing: 0.15 };

function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The SVG direction a door faces outward: the normal of the nearest edge of the floor's gross outline, on the side
 * that is outside the building (probed 24 units out). Falls back to (door - room center) without an outline.
 */
export function outwardVector(door, gross, roomCenter) {
  if (gross && gross.length >= 3) {
    let best = null;
    for (let i = 0; i < gross.length; i++) {
      const a = gross[i];
      const b = gross[(i + 1) % gross.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = Math.max(0, Math.min(1, ((door[0] - a[0]) * dx + (door[1] - a[1]) * dy) / L2));
      const d = Math.hypot(door[0] - a[0] - t * dx, door[1] - a[1] - t * dy);
      if (!best || d < best.d) best = { d, n: [-dy / Math.sqrt(L2), dx / Math.sqrt(L2)], foot: [a[0] + t * dx, a[1] + t * dy] };
    }
    if (best) {
      const probe = (s) => [best.foot[0] + s * 24 * best.n[0], best.foot[1] + s * 24 * best.n[1]];
      const outA = !inRing(probe(1), gross);
      const outB = !inRing(probe(-1), gross);
      if (outA !== outB) return outA ? best.n : [-best.n[0], -best.n[1]];
    }
  }
  return roomCenter ? [door[0] - roomCenter[0], door[1] - roomCenter[1]] : null;
}

export function roomFactor(type) {
  if (type === 'corridor') return 1;
  if (type === 'other' || !type) return 0.5;
  if (type === 'office' || type === 'classroom' || type === 'lab') return 0.3;
  if (type === 'stair') return 0.15;
  return 0.1;
}

export function widthFactor(widthUnits) {
  if (widthUnits >= 60) return 1;
  if (widthUnits >= 42) return 0.6;
  return 0.3;
}

/**
 * @param {Object} o
 * @param {Object[]} o.floors      [{floorId, level, json}] the building's public floors (pipeline floor JSON)
 * @param {Set<string>} o.excluded entrance node ids not joined to the main indoor component
 * @param {(floorId, x, y) => [lng, lat]} o.toLngLat  the georef
 * @param {(floorId, dx, dy) => number} o.bearingOf    bearing (deg from north) of an SVG direction
 * @param {(lng, lat) => {meters, bearing, kind}} o.nearestPath  the nearest walking path point
 * @return {Object[]} [{nodeId, floorId, lng, lat, outward, score, factors, pathMeters, pathKind}] by score
 */
export function scoreEntrances({ floors, excluded = new Set(), toLngLat, bearingOf, nearestPath }) {
  const out = [];
  for (const f of floors) {
    const rooms = new Map(f.json.rooms.map((r) => [r.id, r]));
    for (const d of f.json.doors) {
      if (!d.exterior || !d.nodeId || excluded.has(d.nodeId)) continue;
      const room = rooms.get(d.rooms[0]);
      const [lng, lat] = toLngLat(f.floorId, d.x, d.y);
      const ov = outwardVector([d.x, d.y], f.json.gross, room && room.center);
      const outward = ov ? bearingOf(f.floorId, ov[0], ov[1]) : null;
      const p = nearestPath(lng, lat);
      const eff = p.meters + (p.kind === 'road' ? 10 : 0);
      let facing = 0;
      if (p.meters < 3) facing = 1;
      else if (outward != null) facing = Math.max(0, Math.cos(((p.bearing - outward) * Math.PI) / 180));
      const factors = {
        room: roomFactor(room && room.type),
        width: widthFactor(d.widthUnits),
        path: Math.max(0, 1 - eff / 40),
        facing,
      };
      const score = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * factors[k], 0);
      out.push({
        nodeId: d.nodeId,
        floorId: f.floorId,
        level: f.level,
        lng,
        lat,
        roomId: d.rooms[0],
        roomType: room ? room.type : '',
        widthUnits: d.widthUnits,
        outward: outward == null ? null : round(outward, 0),
        pathMeters: round(p.meters, 1),
        pathKind: p.kind,
        factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, round(v, 2)])),
        score: round(score, 3),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1));
}

/** Marks the primary entrances of one building's scored list (in place); returns the chosen node ids. */
export function choosePrimary(scored, { min = 2, max = 4, ratio = 0.75, spacingMeters = 8, faceMeters = 30, faceDegrees = 60, distance } = {}) {
  const chosen = [];
  const best = scored.length ? scored[0].score : 0;
  for (const e of scored) {
    e.primary = false;
    if (chosen.length >= max) continue;
    if (chosen.length >= min && e.score < ratio * best) continue;
    const sameFace = (c) => {
      if (c.outward == null || e.outward == null) return false;
      const da = Math.abs(((c.outward - e.outward + 540) % 360) - 180);
      return distance(c, e) < faceMeters && da < faceDegrees;
    };
    if (chosen.some((c) => distance(c, e) < spacingMeters || sameFace(c))) continue;
    e.primary = true;
    chosen.push(e);
  }
  return chosen.map((e) => e.nodeId);
}

/**
 * Puts the entrances block right after `doors` in a floor JSON (one key order for every writer). Used by the
 * campus-map build, which scores the entrances, and by the pipeline, which carries the committed block over to the
 * regenerated floor JSON (for the entrance nodes that still exist) until the next `npm run campus-map` re-scores.
 */
export function withEntrances(json, entrances) {
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === 'entrances') continue;
    out[k] = v;
    if (k === 'doors') out.entrances = entrances;
  }
  if (!('entrances' in out)) out.entrances = entrances;
  return out;
}

/** The committed entrances block of a floor, kept for the entrance nodes the new graph still has; null if none. */
export function carryEntrances(previousJson, nodes) {
  if (!previousJson || !Array.isArray(previousJson.entrances)) return null;
  const ids = new Set(nodes.filter((n) => n.type === 'entrance').map((n) => n.id));
  return previousJson.entrances.filter((e) => ids.has(e.nodeId));
}
