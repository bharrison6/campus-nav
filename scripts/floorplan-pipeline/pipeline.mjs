// The whole pipeline as a function: parse -> extract -> doors -> classify -> verticals -> svg -> graph -> emit-gas.
import fs from 'node:fs';
import path from 'node:path';
import { BUILDINGS, FLOORS, planAssetName, privatePaths } from './config.mjs';
import { parseAll } from './stages/parse.mjs';
import { extractFloor } from './stages/extract.mjs';
import { assembleOpenings, inferMissingOpenings } from './stages/doors.mjs';
import { accessOf, buildFloorGraph, components, FLOOR_CHANGE_METERS } from './stages/graph.mjs';
import { buildSvg } from './stages/svg.mjs';
import { emitGas, PRIVATE_SEED } from './stages/emit-gas.mjs';
import { carryEntrances, withEntrances } from './stages/primary-entrances.mjs';
import { classifyBuilding, corridorCandidates, floorEvidence, isSearchable, polygonIoU, refineCirculation } from './lib/classify.mjs';
import { findShaftXs, mergeCollinear, primsToSegments, SegmentIndex } from './lib/detect.mjs';
import { dist, round } from './lib/geometry.mjs';

const WALL_LAYER = (L) => /^A-BLDG$/i.test(L);

/** data/review/corridor-candidates.json: one candidate per line. */
export function formatCandidates(candidates) {
  const head = {
    generated: 'scripts/floorplan-pipeline/run.mjs (npm run pipeline)',
    note: 'Rooms typed other that look like circulation (hallway, lobby, vestibule, alcove), with the evidence and a confidence in [0, 1]. The admin floor-plan editor shows them; accepting one writes rooms.json type corridor.',
  };
  const lines = candidates.map((c) => '  ' + JSON.stringify(c));
  return JSON.stringify(head).slice(0, -1) + `,"candidates":[\n${lines.join(',\n')}${lines.length ? '\n' : ''}]}\n`;
}

/**
 * Splits the outputs by audience: `pub` holds the public floors and the cross-floor edges between two of them (what the
 * repository commits), `priv` the hidden floors and every cross-floor edge that touches one (the private location).
 */
export function splitByPublic(floors, crossEdges) {
  const hiddenNodes = new Set(floors.filter((f) => !f.public).flatMap((f) => f.nav.nodes.map((n) => n.id)));
  const touchesHidden = (e) => hiddenNodes.has(e.from) || hiddenNodes.has(e.to);
  return {
    pub: { floors: floors.filter((f) => f.public), crossEdges: crossEdges.filter((e) => !touchesHidden(e)) },
    priv: { floors: floors.filter((f) => !f.public), crossEdges: crossEdges.filter(touchesHidden) },
  };
}

/** The report without a row, id or count of a hidden floor (data/floorplans/pipeline-report.json). */
export function publicReport(report, floors = FLOORS, publicCrossEdges = []) {
  const pub = new Set(floors.filter((f) => f.public).map((f) => f.floorId));
  const only = (o) => Object.fromEntries(Object.entries(o).filter(([id]) => pub.has(id)));
  return {
    ...report,
    floors: only(report.floors),
    verticalStacks: report.verticalStacks
      .map((v) => ({ ...v, members: v.members.filter((m) => pub.has(m.floorId)) }))
      .filter((v) => v.members.length),
    frameChecks: Object.fromEntries(Object.entries(report.frameChecks).map(([b, list]) => [b, list.filter((c) => c.floors.every((id) => pub.has(id)))])),
    crossFloorEdges: publicCrossEdges.length,
    circulation: only(report.circulation),
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function runPipeline({ inDir, outDir, gasDir, privateDir, cacheDir, floors = FLOORS, forceParse = false, log = console.log, write = true, stableIds = true, reviewDir }) {
  // A hidden floor's outputs live in the private location (config.mjs resolvePrivateDir), never in outDir.
  const priv = privateDir ? privatePaths(privateDir) : null;
  if (write && floors.some((f) => !f.public) && !priv) throw new Error('runPipeline: hidden floors need privateDir; their outputs never go to the repository');
  const dirOf = (floor) => (floor.public ? outDir : priv && priv.floorplans);
  log('parse');
  const parsed = parseAll(floors, inDir, cacheDir, { force: forceParse, log });

  log('extract + doors');
  const F = floors.map((floor) => {
    const fp = extractFloor(parsed[floor.floorId], floor, { log });
    fp.buildingName = BUILDINGS[floor.bldg].name;
    const segs = primsToSegments(fp.prims, WALL_LAYER);
    const wallIndex = new SegmentIndex(segs);
    const shaftXs = findShaftXs(mergeCollinear(segs.filter((s) => dist(s[0], s[1]) < 210)));
    floorEvidence(fp, wallIndex, shaftXs);
    const { openings, swings, entrances } = assembleOpenings(fp, wallIndex);
    const toDwg = (p) => [p[0] + fp.origin.x, fp.origin.y - p[1]];
    return { floor, fp, wallIndex, shaftXs, openings, swings, entrancesFound: entrances, toDwg };
  });

  log('classify + verticals');
  const crossEdges = [];
  const verticalStacks = [];
  const frameChecks = {};
  for (const bk of Object.keys(BUILDINGS)) {
    const bf = F.filter((x) => x.floor.bldg === bk).sort((a, b) => a.floor.level - b.floor.level);
    if (!bf.length) continue;
    const { stairGroups, elevGroups } = classifyBuilding(bf, { log });
    // Shared-frame check: the gross outlines of consecutive floors overlap strongly in DWG coordinates.
    frameChecks[bk] = [];
    for (let i = 0; i + 1 < bf.length; i++) {
      const A = bf[i].fp.gross.map(bf[i].toDwg);
      const B = bf[i + 1].fp.gross.map(bf[i + 1].toDwg);
      frameChecks[bk].push({ floors: [bf[i].floor.floorId, bf[i + 1].floor.floorId], grossIoU: round(polygonIoU(A, B, 6000), 3) });
    }
    let n = 0;
    const sortKey = (g) => {
      const m = g.members[0];
      const c = m.F.toDwg(m.r.center);
      return c[0] * 1e-3 + c[1];
    };
    for (const g of [...stairGroups.sort((a, b) => sortKey(a) - sortKey(b)), ...elevGroups.sort((a, b) => sortKey(a) - sortKey(b))]) {
      n = verticalStacks.filter((v) => v.bldg === bk && v.type === g.kind).length + 1;
      const linkId = `${bk}-${g.kind}-${n}`;
      for (const m of g.members) m.r.linkId = linkId;
      verticalStacks.push({ bldg: bk, type: g.kind, linkId, members: g.members.map((m) => ({ floorId: m.F.floor.floorId, level: m.F.floor.level, number: m.r.number, why: m.why })) });
    }
  }

  log('circulation');
  const circulation = {};
  for (const x of F) circulation[x.floor.floorId] = refineCirculation(x.fp, x.openings).map((r) => ({ number: r.number, why: r.typeEvidence }));

  log('ids + inferred passages + graph');
  for (const x of F) {
    const { floor, fp } = x;
    for (const r of fp.rooms) {
      r.id = `room-${floor.bldg}-${floor.level}-${r.number}`;
      r.searchable = isSearchable(r) && !r.number.startsWith('UNK-');
      if (r.number.startsWith('UNK-')) r.label = '';
      r.svgLabel = r.label;
    }
    x.inferred = inferMissingOpenings(fp, x.openings);
    // Node ids carry over from the committed floor JSON (stages/graph.mjs assignIds), so retyping a room does not
    // renumber the floor under the overrides, QR locations and outdoor graph that hold those ids.
    const prevPath = dirOf(floor) && path.join(dirOf(floor), `${floor.floorId}.json`);
    const previous = stableIds && prevPath && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')).nav : null;
    const g = buildFloorGraph(fp, x.openings, x.wallIndex, { idPrefix: floor.floorId.replace(/^floor-/, ''), previous });
    x.graph = g;
  }

  // Cross-floor edges between consecutive members of each vertical stack.
  let xe = 0;
  for (const v of verticalStacks) {
    const ms = v.members.slice().sort((a, b) => a.level - b.level);
    for (let i = 0; i + 1 < ms.length; i++) {
      const A = F.find((x) => x.floor.floorId === ms[i].floorId);
      const B = F.find((x) => x.floor.floorId === ms[i + 1].floorId);
      const na = A.graph.nodes.find((nn) => nn.linkId === v.linkId);
      const nb = B.graph.nodes.find((nn) => nn.linkId === v.linkId);
      if (!na || !nb) continue;
      const levels = ms[i + 1].level - ms[i].level;
      crossEdges.push({
        id: `${v.bldg}-x${String(++xe).padStart(3, '0')}`,
        from: na.id, to: nb.id,
        distance: FLOOR_CHANGE_METERS[v.type] * levels,
        floorChange: true,
        accessible: v.type === 'elevator',
        linkId: v.linkId,
      });
    }
  }

  log('svg + reachability + outputs');
  const outFloors = [];
  const report = { generated: 'scripts/floorplan-pipeline/run.mjs', floors: {}, verticalStacks, frameChecks, crossFloorEdges: crossEdges.length, circulation };
  // Circulation-like rooms left `other`: suggestions for the admin floor-plan editor (public floors only).
  const candidates = F.filter((x) => x.floor.public).flatMap((x) => corridorCandidates(x.fp, x.openings, x.graph));
  // Building-level components (floor graphs + cross-floor edges).
  const allNodes = F.flatMap((x) => x.graph.nodes);
  const allEdges = [...F.flatMap((x) => x.graph.edges.map((e) => ({ from: e.from.id, to: e.to.id }))), ...crossEdges.map((e) => ({ from: e.from, to: e.to }))];
  const comp = components(allNodes, allEdges);
  const mainComponentOf = (bk) => {
    const tally = new Map();
    for (const y of F.filter((z) => z.floor.bldg === bk)) {
      for (const n of y.graph.nodes) {
        const c = comp.get(n.id);
        const t = tally.get(c) || { ent: 0, size: 0 };
        t.size++;
        if (n.type === 'entrance') t.ent++;
        tally.set(c, t);
      }
    }
    let best = null;
    for (const [c, t] of tally) if (!best || t.ent > best[1].ent || (t.ent === best[1].ent && t.size > best[1].size)) best = [c, t];
    return best ? best[0] : null;
  };

  for (const x of F) {
    const { floor, fp, graph } = x;
    const { svg, stats: svgStats } = buildSvg(fp);
    const mpu = fp.units.metersPerUnit;
    const roomNode = new Map();
    for (const [idx, n] of graph.hub) roomNode.set(fp.rooms[idx].id, n);
    // Reachability. The building's main component is the one holding the most entrances (floor graphs joined by the
    // cross-floor edges). A searchable room is reachable when its hub is in that component, i.e. reachable from every
    // entrance in it. An entrance outside it (for example an exterior-only service room) is reported as isolated.
    const mainComp = mainComponentOf(floor.bldg);
    const unreachable = [];
    for (const r of fp.rooms) {
      if (!r.searchable) continue;
      const n = roomNode.get(r.id);
      if (!n) continue;
      if (comp.get(n.id) !== mainComp) unreachable.push({ room: r.id, number: r.number });
    }
    const isolatedEntrances = graph.nodes
      .filter((n) => n.type === 'entrance' && comp.get(n.id) !== mainComp)
      .map((n) => ({ nodeId: n.id, rooms: n.opening ? [fp.rooms[n.opening.a].number] : [] }));
    const doors = x.openings.map((o) => ({
      nodeId: o.nodeId,
      kind: o.kind,
      exterior: o.exterior,
      x: round(o.p[0], 1),
      y: round(o.p[1], 1),
      rooms: [fp.rooms[o.a].id, o.b >= 0 ? fp.rooms[o.b].id : 'exterior'],
      widthUnits: round(o.width, 1),
      doorNo: o.doorNo || '',
    }));
    const swingR = x.swings.map((s) => (s.double ? s.width / 2 : s.width));
    const officeAreas = fp.rooms.filter((r) => r.kind === 'room' && r.areaSf >= 60 && r.areaSf <= 400).map((r) => r.areaSf);
    const units = {
      ...fp.units,
      metersPerPixel: mpu,
      sanity: {
        medianDoorLeafUnits: round(median(swingR), 1),
        medianRoomAreaSqFt: round(median(officeAreas), 0),
        tagAreaAgreement: `${fp.rooms.filter((r) => r.tagAreaSf != null && Math.abs(r.areaSf - r.tagAreaSf) <= Math.max(2, 0.03 * r.tagAreaSf)).length}/${fp.rooms.filter((r) => r.tagAreaSf != null).length} rooms match their RMAREA tag (computed with inches)`,
      },
    };
    const json = {
      floorId: floor.floorId,
      buildingId: BUILDINGS[floor.bldg].id,
      buildingCode: BUILDINGS[floor.bldg].code,
      level: floor.level,
      label: floor.label,
      public: floor.public,
      source: floor.file,
      planAsset: planAssetName(floor.floorId),
      svgFile: `${floor.floorId}.svg`,
      widthPx: round(fp.width, 1),
      heightPx: round(fp.height, 1),
      metersPerPixel: mpu,
      units,
      // A public floor's JSON lists only the frame checks between public floors.
      frame: { ...fp.origin, sharedBuildingFrame: floor.public ? frameChecks[floor.bldg].filter((c) => c.floors.every((id) => floors.find((f) => f.floorId === id).public)) : frameChecks[floor.bldg] },
      // The floor's gross outline (the drawing's GROSS layer) in this floor's SVG units: what the campus-map build fits
      // to the OpenStreetMap footprint (scripts/campus-map/georef-fit.mjs). null when the drawing has none.
      gross: fp.gross ? fp.gross.map((p) => [round(p[0], 1), round(p[1], 1)]) : null,
      rooms: fp.rooms.map((r) => ({
        id: r.id, number: r.number, label: r.label, type: r.type, ...(r.type === 'corridor' ? { access: 'main' } : {}), typeEvidence: r.typeEvidence, searchable: r.searchable,
        kind: r.kind, linkId: r.linkId || '', areaSqFt: round(r.areaSf, 0), tagAreaSqFt: r.tagAreaSf, useText: r.useText,
        matchedBy: r.matchedBy, closure: r.closure, center: r.center.map((v) => round(v, 1)),
        polygon: r.polygon.map((p) => [round(p[0], 1), round(p[1], 1)]),
      })),
      doors,
      verticals: graph.nodes.filter((n) => n.linkId).map((n) => ({ linkId: n.linkId, type: n.type, roomId: n.roomId, nodeId: n.id })),
      nav: {
        nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, roomId: n.roomId || '', linkId: n.linkId || '', ...(accessOf(n) ? { access: accessOf(n) } : {}) })),
        edges: graph.edges.map((e) => ({ id: e.id, from: e.from.id, to: e.to.id, distance: e.distance, floorChange: false, accessible: true })),
      },
      anomalies: [
        ...fp.anomalies,
        ...x.inferred.map((i) => ({ kind: 'inferred-passage', room: i.room, to: i.to })),
        ...isolatedEntrances.map((e) => ({ kind: 'isolated-entrance', nodeId: e.nodeId, rooms: e.rooms })),
        ...unreachable.map((u) => ({ kind: 'unreachable-room', number: u.number })),
      ],
    };
    const counts = {
      rooms: fp.rooms.length,
      roomsByType: fp.rooms.reduce((m, r) => ((m[r.type] = (m[r.type] || 0) + 1), m), {}),
      matchedLabels: fp.rooms.filter((r) => r.matchedBy === 'xdata-number' || r.matchedBy === 'tag-in-polygon').length,
      doors: doors.filter((d) => !d.exterior && (d.kind === 'door')).length,
      openings: doors.filter((d) => d.kind === 'opening').length,
      areaLines: doors.filter((d) => d.kind === 'area-line').length,
      inferredPassages: x.inferred.length,
      entrances: doors.filter((d) => d.exterior).length,
      verticals: json.verticals.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      blindCorridorAttachments: graph.blindAttach,
      unreachableRooms: unreachable.length,
      isolatedEntrances: isolatedEntrances.length,
      svgBytes: Buffer.byteLength(svg),
      ...svgStats,
    };
    report.floors[floor.floorId] = { counts, unreachable, isolatedEntrances, inferredPassages: x.inferred, units: units.sanity };
    outFloors.push({
      floorId: floor.floorId, buildingId: BUILDINGS[floor.bldg].id, level: floor.level, label: floor.label,
      planAsset: planAssetName(floor.floorId), width: fp.width, height: fp.height, metersPerUnit: mpu, public: floor.public,
      rooms: fp.rooms.map((r) => ({ ...r, polygon: r.polygon.map((p) => [round(p[0], 1), round(p[1], 1)]), center: r.center.map((v) => round(v, 1)) })),
      nav: json.nav, svg, json,
    });
  }

  const split = splitByPublic(outFloors, crossEdges);
  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    if (split.priv.floors.length) fs.mkdirSync(priv.floorplans, { recursive: true });
    for (const f of outFloors) {
      const dir = dirOf(f);
      fs.writeFileSync(path.join(dir, `${f.floorId}.svg`), f.svg);
      // The entrances block (primary-entrance scores) is written by npm run campus-map; carry it over.
      const jsonPath = path.join(dir, `${f.floorId}.json`);
      const prev = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;
      const kept = carryEntrances(prev, f.json.nav.nodes);
      fs.writeFileSync(jsonPath, JSON.stringify(kept ? withEntrances(f.json, kept) : f.json, null, 1) + '\n');
    }
    fs.writeFileSync(path.join(outDir, 'cross-floor-edges.json'), JSON.stringify(split.pub.crossEdges, null, 1) + '\n');
    const gas = emitGas(split.pub.floors, split.pub.crossEdges, gasDir, { unitName: 'inches' });
    report.seedFloorDataBytes = gas.seedBytes;
    fs.writeFileSync(path.join(outDir, 'pipeline-report.json'), JSON.stringify(publicReport(report, floors, split.pub.crossEdges), null, 1) + '\n');
    if (split.priv.floors.length) {
      fs.writeFileSync(path.join(priv.floorplans, 'cross-floor-edges.json'), JSON.stringify(split.priv.crossEdges, null, 1) + '\n');
      emitGas(split.priv.floors, split.priv.crossEdges, priv.gs, { unitName: 'inches', seed: PRIVATE_SEED });
      // The private copy of the report is the whole report, hidden floors included.
      fs.writeFileSync(path.join(priv.floorplans, 'pipeline-report.json'), JSON.stringify(report, null, 1) + '\n');
    }
    const review = reviewDir || path.join(outDir, '..', 'review');
    fs.mkdirSync(review, { recursive: true });
    fs.writeFileSync(path.join(review, 'corridor-candidates.json'), formatCandidates(candidates));
  }
  return { floors: outFloors, crossEdges, split, report, F, candidates };
}

