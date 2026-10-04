// The campus-map build as a function: committed inputs in, every generated file out (as text), no I/O.
//
// Inputs: the OpenStreetMap extract (data/campus-map/source/osm-extract.json), the hand-drawn overrides
// (data/campus-map/overrides.geojson), the seeded buildings, the operator's overrides (data/overrides: Buildings
// levels/height, NavNodes access (or a legacy primary)), data/overrides/pathAccess.json (outdoor path classes), the
// pipeline's floor JSON (gross outlines, doors, rooms), and the effective
// entrance set (campusEntrances in scripts/data/campus-geo.mjs: the exporter's entrance nodes, the operator's moves,
// floor changes, additions and deletions applied), which replaces the floor JSON's exterior doors before scoring,
// projecting and joining, so the outdoor graph's doors are where the export puts them.
// Outputs: data/campus-map/{buildings.geojson, layers/*.geojson, outdoor-graph.json, manifest.json},
// data/georef/<buildingId>.json, the `entrances` block of each public floor's JSON, tools/admin/gs/SeedCampusMap.gs.
import { ATTRIBUTION } from './config.mjs';
import { fromExtract } from './extract.mjs';
import { haversine, round } from './geo.mjs';
import { basemapLayers, buildingHeight, clean, feature, footprints, indexOsm, labelPoint, matchBuildings } from './osm.mjs';
import { boundaryResiduals, fitOutline, unionOutline } from './georef-fit.mjs';
import { ACCESS, addOsmWays, addOverridePaths, applyPathAccess, connectEntrance, overrideFeatureId, OutdoorGraph, pathAccess, pruneFragments } from './outdoor-graph.mjs';
import { choosePrimary, scoreEntrances, withEntrances } from '../floorplan-pipeline/stages/primary-entrances.mjs';
import { overrideAccess } from '../data/overrides.mjs';
import { validateOverridesGeo } from './validate-geo.mjs';

export { withEntrances };
import { svgBearingWith, svgToLngLatWith } from '../../src/shared/georef.mjs';

export const LAYERS = ['paths', 'roads', 'parking', 'landuse', 'water', 'labels'];

/** A FeatureCollection with one feature per line (reviewable diffs, still compact). */
export function formatGeojson(features, extra = {}) {
  const head = JSON.stringify({ type: 'FeatureCollection', ...extra }).slice(0, -1);
  if (!features.length) return `${head},"features":[]}\n`;
  return `${head},"features":[\n${features.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`;
}

const byKey = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);

/**
 * The automatic access class of a scored exterior door (v5): the primary-entrance heuristic's choice is main, a door
 * out of a stairwell (a stair-tower exit) emergency, any other exterior door alt.
 */
export function autoEntranceAccess(chosen, roomType) {
  if (chosen) return 'main';
  return roomType === 'stair' ? 'emergency' : 'alt';
}

/**
 * The entrances drawn for buildings without floor plans: overrides.geojson Point features with layer "entrances"
 * ({building, access, label}). Ids are the feature's own id, else "entrance-<building>-<n>" (n counts per building in
 * file order); access defaults to main. Returns [{id, buildingId, access, label, lat, lng}] and the rejects.
 */
export function drawnEntrances(features) {
  const out = [];
  const rejected = [];
  const count = {};
  features.forEach((f, i) => {
    const p = f.properties || {};
    if (p.layer !== 'entrances') return;
    if (!f.geometry || f.geometry.type !== 'Point' || !p.building) {
      rejected.push({ feature: i + 1, why: !p.building ? 'no building id' : 'not a Point' });
      return;
    }
    count[p.building] = (count[p.building] || 0) + 1;
    const [lng, lat] = f.geometry.coordinates;
    out.push({
      id: String(f.id || p.id || `entrance-${p.building}-${count[p.building]}`),
      buildingId: String(p.building),
      access: ACCESS.includes(p.access) ? p.access : 'main',
      label: p.label || '',
      lat: round(lat, 6),
      lng: round(lng, 6),
    });
  });
  return { entrances: out, rejected };
}

/** Georeferences one indoor building: fits the union of its public floors' outlines to its footprint. */
export function georeferenceBuilding(buildingId, floors, footprint) {
  const fitted = floors[0];
  const offsets = {};
  for (const f of floors) offsets[f.floorId] = [round(f.json.frame.x - fitted.json.frame.x, 3), round(fitted.json.frame.y - f.json.frame.y, 3)];
  const rings = floors.filter((f) => f.json.gross).map((f) => f.json.gross.map(([x, y]) => [x + offsets[f.floorId][0], y + offsets[f.floorId][1]]));
  const outline = unionOutline(rings, { metersPerUnit: fitted.json.metersPerPixel });
  const fit = fitOutline(outline, footprint.ring, { metersPerUnit: fitted.json.metersPerPixel });
  const floorOffsets = {};
  for (const f of floors) if (f !== fitted) floorOffsets[f.floorId] = offsets[f.floorId];
  const record = {
    buildingId,
    floorFrame: 'svg',
    fittedFloor: fitted.floorId,
    transform: fit.transform,
    floorOffsets,
    method:
      'similarity fit, scale fixed at metersPerUnit; rotation and translation solved (mirrored drawing also tried) by a ' +
      'coarse rotation search then trimmed symmetric ICP, matching the union of the public floors\' gross outlines ' +
      '(scripts/campus-map/georef-fit.mjs) to the footprint',
    residualMeters: 0,
    residual: null,
    fittedTo: footprint.replaces || footprint.osmId,
  };
  if (footprint.override) record.footprintSource = 'override: part of the OpenStreetMap way, split in data/campus-map/overrides.geojson';
  const res = boundaryResiduals(record, outline, footprint.ring);
  record.residualMeters = res.rms;
  record.residual = { ...res, measure: 'symmetric boundary distance between the fitted outline and the footprint, meters (residualMeters = rms)' };
  return { record, outline };
}

/**
 * A floor's door list with its exterior doors replaced by the effective entrances on that floor: a door the operator
 * moved takes the node's position, a deleted one (or one moved to another floor) is gone, and an added entrance (or
 * one moved here) is a door of no known width opening into no known room. Interior doors are unchanged; the original
 * order is kept and newcomers follow, so unedited data scores exactly as before.
 * @param {Object} json        the pipeline floor JSON
 * @param {string} floorId
 * @param {Object[]} entrances  campusEntrances(...) for the whole campus
 * @param {Map} doorsById       nodeId -> {door, floorId} over every floor's exterior doors
 */
export function effectiveDoors(json, floorId, entrances, doorsById) {
  const here = new Map(entrances.filter((e) => e.floorId === floorId).map((e) => [e.nodeId, e]));
  const out = [];
  for (const d of json.doors) {
    if (!d.exterior) out.push(d);
    else if (here.has(d.nodeId)) {
      const e = here.get(d.nodeId);
      out.push({ ...d, x: e.x, y: e.y });
      here.delete(d.nodeId);
    }
  }
  for (const e of here.values()) {
    const was = doorsById.get(e.nodeId);
    out.push({ ...(was ? was.door : { widthUnits: 0 }), nodeId: e.nodeId, x: e.x, y: e.y, exterior: true, rooms: [] });
  }
  return out;
}

/**
 * @param {Object} i
 * @param {Object} i.extract            the OSM extract object
 * @param {Object} i.overridesGeo       data/campus-map/overrides.geojson (FeatureCollection)
 * @param {Object[]} i.seeded           buildings as the engine returns them ({id, name, lat, lng, hasIndoor})
 * @param {Object[]} i.buildingOverrides data/overrides/buildings.json records
 * @param {Object[]} i.navNodeOverrides  data/overrides/navNodes.json records
 * @param {Object[]} [i.pathAccessOverrides] data/overrides/pathAccess.json records ({way, access})
 * @param {Object[]} i.floors           [{floorId, json}] every pipeline floor JSON
 * @param {Object} i.pipelineReport     data/floorplans/pipeline-report.json
 * @param {Object[]} [i.entrances]      campusEntrances of the exported campus (loadInputs); omitted, the floor JSON doors
 * @param {Object} [i.previousGraph]    the committed outdoor-graph.json: unchanged nodes and edges keep their ids
 */
export function buildCampusMap({ extract, overridesGeo, seeded, buildingOverrides = [], navNodeOverrides = [], pathAccessOverrides = [], floors, pipelineReport, entrances, previousGraph = null }) {
  if (overridesGeo) validateOverridesGeo(overridesGeo);
  const osm = indexOsm(fromExtract(extract));
  const ovFeatures = (overridesGeo && overridesGeo.features) || [];
  const report = { buildings: {}, georef: {}, entrances: {}, graph: {}, overrides: {}, access: {} };

  // ---- buildings ----
  const replaced = new Set(ovFeatures.filter((f) => f.properties && f.properties.replaces).map((f) => f.properties.replaces));
  const fps = footprints(osm).filter((f) => !replaced.has(f.osmId));
  ovFeatures.forEach((f, i) => {
    const p = f.properties || {};
    if (p.layer !== 'buildings' || !f.geometry || f.geometry.type !== 'Polygon') return;
    fps.push({ osmId: overrideFeatureId(f, i), name: p.name || '', tags: clean({ building: p.building || 'yes', height: p.height, 'building:levels': p.levels }), ring: f.geometry.coordinates[0], override: true, replaces: p.replaces, buildingId: p.buildingId });
  });
  const match = matchBuildings(fps, seeded);
  // A drawn footprint may name its building outright (properties.buildingId), e.g. a new building the operator adds.
  for (const fp of fps) if (fp.override && fp.buildingId) match.set(fp.osmId, { buildingId: String(fp.buildingId), score: 2, inside: true, distance: 0, nameSim: 1 });
  const seededById = new Map(seeded.map((b) => [b.id, b]));
  const bOver = new Map(buildingOverrides.map((r) => [r.id, r]));
  const buildingFeatures = [];
  const bestFootprint = new Map();
  for (const fp of fps) {
    const m = match.get(fp.osmId);
    const sb = m ? seededById.get(m.buildingId) : null;
    const h = buildingHeight(fp.tags, m ? bOver.get(m.buildingId) : null, sb && sb.name);
    const source = fp.override && h.source !== 'override' ? 'override' : h.source;
    buildingFeatures.push(
      feature({ type: 'Polygon', coordinates: [fp.ring] }, {
        osmId: fp.override ? fp.replaces || fp.osmId : fp.osmId,
        buildingId: m ? m.buildingId : null,
        name: fp.name || (sb ? sb.name : ''),
        height: h.height,
        levels: h.levels,
        source,
      })
    );
    if (m && (!bestFootprint.has(m.buildingId) || m.score > bestFootprint.get(m.buildingId).m.score)) bestFootprint.set(m.buildingId, { fp, m, h });
  }
  buildingFeatures.sort((a, b) => (a.properties.osmId + (a.properties.name || '') < b.properties.osmId + (b.properties.name || '') ? -1 : 1));
  report.buildings = {
    footprints: fps.length,
    named: fps.filter((f) => f.name).length,
    matched: [...match.values()].length,
    seededWithFootprint: bestFootprint.size,
    seededWithout: seeded.filter((b) => !bestFootprint.has(b.id)).map((b) => b.id),
  };

  // ---- basemap layers ----
  const L = basemapLayers(osm);
  for (const f of ovFeatures) {
    const p = f.properties || {};
    if (p.layer !== 'paths') continue;
    L.paths.push(feature(f.geometry, clean({ way: overrideFeatureId(f, ovFeatures.indexOf(f)), kind: p.kind || 'footway', name: p.name, surface: p.surface, steps: p.kind === 'steps', source: 'override' })));
  }
  L.labels = [];
  for (const f of buildingFeatures) {
    if (!f.properties.name) continue;
    L.labels.push(feature({ type: 'Point', coordinates: labelPoint(f.geometry.coordinates[0]) }, clean({ kind: 'building', name: f.properties.name, buildingId: f.properties.buildingId })));
  }
  for (const f of [...L.parking, ...L.landuse]) {
    if (f.properties.name) L.labels.push(feature({ type: 'Point', coordinates: labelPoint(f.geometry.coordinates[0]) }, { kind: f.properties.kind, name: f.properties.name }));
  }
  for (const k of LAYERS) L[k].sort((a, b) => ((a.properties.osmId || '~') + JSON.stringify(a.geometry.coordinates[0]) < (b.properties.osmId || '~') + JSON.stringify(b.geometry.coordinates[0]) ? -1 : 1));

  // ---- outdoor network (before entrances) ----
  const g = new OutdoorGraph();
  addOsmWays(g, osm, { clip: extract.meta && extract.meta.bbox });
  addOverridePaths(g, ovFeatures);
  report.overrides.pathSnaps = g.report.overrideSnaps;
  report.overrides.pathAccess = applyPathAccess(g, pathAccessOverrides);
  // The basemap's paths and roads carry the class routing uses (the app draws alt lighter than main).
  const wayAccess = new Map();
  for (const e of g.edges.values()) if (e.way) wayAccess.set(e.way, e.access);
  for (const f of L.paths) f.properties.access = wayAccess.get(f.properties.osmId || f.properties.way) || pathAccess(f.properties.kind);
  for (const f of L.roads) f.properties.access = wayAccess.get(f.properties.osmId) || 'alt';

  // ---- indoor buildings: georef, entrance scores, primaries ----
  const doorsById = new Map();
  for (const f of floors) for (const d of f.json.doors || []) if (d.exterior && d.nodeId) doorsById.set(d.nodeId, { door: d, floorId: f.floorId });
  const byBuilding = new Map();
  for (const f of floors) {
    if (!f.json.public) continue;
    if (!byBuilding.has(f.json.buildingId)) byBuilding.set(f.json.buildingId, []);
    const json = entrances ? { ...f.json, doors: effectiveDoors(f.json, f.floorId, entrances, doorsById) } : f.json;
    byBuilding.get(f.json.buildingId).push({ floorId: f.floorId, level: f.json.level, json });
  }
  // The operator's class for a node (access, or a legacy primary flag: true main, false alt).
  const navOver = new Map(navNodeOverrides.map((r) => [r.id, overrideAccess(r)]).filter(([, a]) => a));
  const georef = {};
  const entranceBlocks = {};
  const autoAccess = {};
  const entrancesToConnect = [];
  for (const [bid, bf] of [...byBuilding.entries()].sort()) {
    bf.sort((a, b) => a.level - b.level);
    const best = bestFootprint.get(bid);
    if (!best) {
      report.georef[bid] = { error: 'no OpenStreetMap footprint matched this building' };
      continue;
    }
    const { record } = georeferenceBuilding(bid, bf, best.fp);
    georef[bid] = record;
    report.georef[bid] = { residualMeters: record.residualMeters, residual: record.residual, fittedTo: record.fittedTo, rotationDeg: record.transform.rotationDeg, reflected: record.transform.reflected };
    const excluded = new Set();
    for (const f of bf) for (const e of (pipelineReport.floors[f.floorId] || {}).isolatedEntrances || []) excluded.add(e.nodeId);
    const nearestPath = (lng, lat) => {
      const c = g.nearestEdges(lat, lng, { max: 40, filter: (e) => e.kind !== 'connector' });
      const foot = c.find((x) => x.edge.kind !== 'road');
      const road = c.find((x) => x.edge.kind === 'road');
      const pick = foot && (!road || foot.d <= road.d + 10) ? foot : road || foot;
      const [plat, plng] = g.F.toLatLng(pick.point[0], pick.point[1]);
      const P = g.F.toXY(lat, lng);
      const bearing = ((Math.atan2(pick.point[0] - P[0], pick.point[1] - P[1]) * 180) / Math.PI + 360) % 360;
      return { meters: pick.d, bearing, kind: pick.edge.kind === 'road' ? 'road' : 'path', lat: plat, lng: plng };
    };
    const scored = scoreEntrances({
      floors: bf,
      excluded,
      toLngLat: (floorId, x, y) => svgToLngLatWith(record, x, y, floorId),
      bearingOf: (floorId, dx, dy) => svgBearingWith(record, dx, dy),
      nearestPath,
    });
    choosePrimary(scored, { distance: (a, b) => haversine(a.lat, a.lng, b.lat, b.lng) });
    // A door's connector must not cross its own floor's outline (the union would also contain terraces on lower roofs).
    const floorOutline = Object.fromEntries(bf.filter((f) => f.json.gross).map((f) => [f.floorId, f.json.gross.map(([x, y]) => svgToLngLatWith(record, x, y, f.floorId))]));
    // Every main and alt entrance joins the paths (alt ones cost more in routing); emergency exits do not.
    const byClass = { main: [], alt: [], emergency: [] };
    for (const e of scored) {
      e.access = autoEntranceAccess(e.primary, e.roomType);
      autoAccess[e.nodeId] = e.access;
      const eff = navOver.get(e.nodeId) || e.access;
      byClass[eff].push(e.nodeId);
      if (eff !== 'emergency') entrancesToConnect.push({ id: e.nodeId, lat: e.lat, lng: e.lng, outline: floorOutline[e.floorId] || null, buildingId: bid, access: eff });
    }
    // A door that is the only way into some room (the pipeline's isolated entrances, EP 1322's exterior door) joins
    // the outdoor graph too (alt unless the operator says otherwise): without it that room has no route at all.
    const soleAccess = [];
    const roomTypes = new Map(bf.flatMap((f) => f.json.rooms.map((r) => [r.id, r.type])));
    for (const f of bf) {
      for (const d of f.json.doors) {
        if (!d.exterior || !excluded.has(d.nodeId)) continue;
        const [lng, lat] = svgToLngLatWith(record, d.x, d.y, f.floorId);
        autoAccess[d.nodeId] = autoEntranceAccess(false, roomTypes.get((d.rooms || [])[0]));
        const eff = navOver.get(d.nodeId) || autoAccess[d.nodeId];
        byClass[eff].push(d.nodeId);
        if (eff !== 'emergency') entrancesToConnect.push({ id: d.nodeId, lat, lng, outline: floorOutline[f.floorId] || null, buildingId: bid, access: eff });
        soleAccess.push(d.nodeId);
      }
    }
    for (const f of bf) {
      entranceBlocks[f.floorId] = scored
        .filter((e) => e.floorId === f.floorId)
        .map((e) => ({ nodeId: e.nodeId, access: e.access, score: e.score, factors: e.factors, roomId: e.roomId, roomType: e.roomType, widthUnits: e.widthUnits, outwardDeg: e.outward, pathMeters: e.pathMeters, pathKind: e.pathKind }));
    }
    report.entrances[bid] = {
      candidates: scored.length,
      excluded: [...excluded],
      soleAccess,
      main: scored.filter((e) => e.primary).map((e) => ({ nodeId: e.nodeId, floorId: e.floorId, score: e.score, roomType: e.roomType, widthUnits: e.widthUnits, pathMeters: e.pathMeters })),
      byClass,
      operatorOverrides: [...scored.map((e) => e.nodeId), ...soleAccess].filter((id) => navOver.has(id)).map((id) => ({ nodeId: id, access: navOver.get(id) })),
    };
  }

  // ---- entrances drawn for buildings without floor plans (layer "entrances") ----
  const drawn = drawnEntrances(ovFeatures);
  report.entrances.drawn = { entrances: drawn.entrances.map((e) => ({ id: e.id, buildingId: e.buildingId, access: e.access })), rejected: drawn.rejected };
  for (const e of drawn.entrances) {
    if (e.access === 'emergency') continue;
    const best = bestFootprint.get(e.buildingId);
    entrancesToConnect.push({ ...e, drawn: true, outline: best ? best.fp.ring : null });
  }

  // ---- entrances into the network ----
  for (const e of entrancesToConnect.sort(byKey('id'))) connectEntrance(g, e, { outline: e.outline });
  const countBy = (list, k) => list.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});
  report.graph.connectors = g.report.connectors;
  report.graph.prunedFragmentNodes = pruneFragments(g);
  const { comp, sizes } = g.components();
  const graph = g.toJSON(previousGraph);
  report.graph.nodes = graph.nodes.length;
  report.graph.edges = graph.edges.length;
  report.graph.components = sizes;
  report.graph.entrancesInMainComponent = graph.nodes.filter((n) => n.type === 'entrance').every((n) => comp.get(n.id) === 0);
  report.access = {
    edges: countBy(graph.edges, 'access'),
    edgesByKind: graph.edges.reduce((m, e) => ((m[`${e.kind}/${e.access}`] = (m[`${e.kind}/${e.access}`] || 0) + 1), m), {}),
    graphEntrances: countBy(graph.nodes.filter((n) => n.type === 'entrance'), 'access'),
  };

  // ---- seed for the engine: heuristic primaries and building levels/height ----
  const levels = {};
  for (const b of [...seeded].sort(byKey('id'))) {
    const best = bestFootprint.get(b.id);
    const h = buildingHeight(best ? best.fp.tags : null, null, b.name);
    const explicit = best && best.fp.tags && parseFloat(best.fp.tags.height) > 0 ? round(parseFloat(best.fp.tags.height), 1) : '';
    levels[b.id] = [h.levels, explicit];
  }
  const seedGs = buildSeedGs(autoAccess, levels);

  // ---- files ----
  const files = {};
  files['data/campus-map/buildings.geojson'] = formatGeojson(buildingFeatures);
  for (const k of LAYERS) files[`data/campus-map/layers/${k}.geojson`] = formatGeojson(L[k]);
  files['data/campus-map/outdoor-graph.json'] =
    `{"nodes":[\n${graph.nodes.map((n) => JSON.stringify(n)).join(',\n')}\n],\n"edges":[\n${graph.edges.map((e) => JSON.stringify(e)).join(',\n')}\n]}\n`;
  for (const [bid, rec] of Object.entries(georef)) files[`data/georef/${bid}.json`] = JSON.stringify(rec, null, 1) + '\n';
  files['tools/admin/gs/SeedCampusMap.gs'] = seedGs;
  const manifest = {
    generated: 'scripts/campus-map/run.mjs (npm run campus-map)',
    attribution: { osm: ATTRIBUTION.osm },
    license: 'Map data (buildings, layers, outdoor graph) is derived from OpenStreetMap and published under the ODbL 1.0.',
    source: { osm: extract.meta },
    files: Object.keys(files).filter((p) => p.startsWith('data/campus-map/')).map((p) => p.replace('data/campus-map/', '')),
    counts: { buildings: buildingFeatures.length, ...Object.fromEntries(LAYERS.map((k) => [k, L[k].length])), graphNodes: graph.nodes.length, graphEdges: graph.edges.length },
    georef: report.georef,
  };
  files['data/campus-map/manifest.json'] = JSON.stringify(manifest, null, 1) + '\n';
  return { files, entranceBlocks, georef, graph, report, buildings: buildingFeatures, layers: L };
}

/** tools/admin/gs/SeedCampusMap.gs: what the campus-map build gives the engine's seed. */
export function buildSeedGs(entranceAccess, levels) {
  const rows = Object.entries(levels).map(([id, v]) => `    ${JSON.stringify(id)}: ${JSON.stringify(v)}`);
  const ids = Object.keys(entranceAccess).sort();
  const acc = ids.map((id) => `    ${JSON.stringify(id)}: ${JSON.stringify(entranceAccess[id])}`);
  return (
    `/**\n * SeedCampusMap.gs - GENERATED by scripts/campus-map/run.mjs (npm run campus-map). Do not edit by hand.\n` +
    ` * The operator's edits go to data/overrides (admin: NavNodes access, Buildings levels/height).\n */\n\n` +
    `/**\n * The automatic access class of each exterior door (scripts/campus-map/build.mjs autoEntranceAccess): the doors the\n` +
    ` * primary-entrance heuristic chose (scripts/floorplan-pipeline/stages/primary-entrances.mjs) main, stair-tower exits\n` +
    ` * emergency, the rest alt.\n * @return {Object} ${ids.length} NavNodes ids -> "main" | "alt" | "emergency"\n */\n` +
    `function getGeneratedEntranceAccess() {\n  return {\n${acc.join(',\n')}\n  };\n}\n\n` +
    `/**\n * Per building: [levels, height]. levels from OpenStreetMap (building:levels, else height / 3.5 m) or the default by\n` +
    ` * type (academic 3, residence 4, other 2); height (m) only where OpenStreetMap gives one, else ''.\n` +
    ` * @return {Object} buildingId -> [levels, height]\n */\nfunction getGeneratedBuildingLevels() {\n  return {\n${rows.join(',\n')}\n  };\n}\n`
  );
}
