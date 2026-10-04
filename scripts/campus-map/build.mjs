// The campus-map build as a function: committed inputs in, every generated file out (as text), no I/O.
//
// Inputs: the OpenStreetMap extract (data/campus-map/source/osm-extract.json), the hand-drawn overrides
// (data/campus-map/overrides.geojson), the seeded buildings, the operator's overrides (data/overrides: Buildings
// levels/height, NavNodes primary), and the pipeline's floor JSON (gross outlines, doors, rooms).
// Outputs: data/campus-map/{buildings.geojson, layers/*.geojson, outdoor-graph.json, manifest.json},
// data/georef/<buildingId>.json, the `entrances` block of each public floor's JSON, tools/admin/gs/SeedCampusMap.gs.
import { ATTRIBUTION } from './config.mjs';
import { fromExtract } from './extract.mjs';
import { haversine, round } from './geo.mjs';
import { basemapLayers, buildingHeight, clean, feature, footprints, indexOsm, labelPoint, matchBuildings } from './osm.mjs';
import { boundaryResiduals, fitOutline, unionOutline } from './georef-fit.mjs';
import { addOsmWays, addOverridePaths, connectEntrance, OutdoorGraph, pruneFragments } from './outdoor-graph.mjs';
import { choosePrimary, scoreEntrances, withEntrances } from '../floorplan-pipeline/stages/primary-entrances.mjs';

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
const truthy = (v) => v === true || /^(true|1|yes)$/i.test(String(v));

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
 * @param {Object} i
 * @param {Object} i.extract            the OSM extract object
 * @param {Object} i.overridesGeo       data/campus-map/overrides.geojson (FeatureCollection)
 * @param {Object[]} i.seeded           buildings as the engine returns them ({id, name, lat, lng, hasIndoor})
 * @param {Object[]} i.buildingOverrides data/overrides/buildings.json records
 * @param {Object[]} i.navNodeOverrides  data/overrides/navNodes.json records
 * @param {Object[]} i.floors           [{floorId, json}] every pipeline floor JSON
 * @param {Object} i.pipelineReport     data/floorplans/pipeline-report.json
 */
export function buildCampusMap({ extract, overridesGeo, seeded, buildingOverrides = [], navNodeOverrides = [], floors, pipelineReport }) {
  const osm = indexOsm(fromExtract(extract));
  const ovFeatures = (overridesGeo && overridesGeo.features) || [];
  const report = { buildings: {}, georef: {}, entrances: {}, graph: {}, overrides: {} };

  // ---- buildings ----
  const replaced = new Set(ovFeatures.filter((f) => f.properties && f.properties.replaces).map((f) => f.properties.replaces));
  const fps = footprints(osm).filter((f) => !replaced.has(f.osmId));
  ovFeatures.forEach((f, i) => {
    const p = f.properties || {};
    if (p.layer !== 'buildings' || !f.geometry || f.geometry.type !== 'Polygon') return;
    fps.push({ osmId: `override/${i + 1}`, name: p.name || '', tags: clean({ building: p.building || 'yes', height: p.height, 'building:levels': p.levels }), ring: f.geometry.coordinates[0], override: true, replaces: p.replaces });
  });
  const match = matchBuildings(fps, seeded);
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
    L.paths.push(feature(f.geometry, clean({ kind: p.kind || 'footway', name: p.name, surface: p.surface, steps: p.kind === 'steps', source: 'override' })));
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
  addOsmWays(g, osm);
  addOverridePaths(g, ovFeatures);
  report.overrides.pathSnaps = g.report.overrideSnaps;

  // ---- indoor buildings: georef, entrance scores, primaries ----
  const byBuilding = new Map();
  for (const f of floors) {
    if (!f.json.public) continue;
    if (!byBuilding.has(f.json.buildingId)) byBuilding.set(f.json.buildingId, []);
    byBuilding.get(f.json.buildingId).push({ floorId: f.floorId, level: f.json.level, json: f.json });
  }
  const navOver = new Map(navNodeOverrides.filter((r) => 'primary' in r).map((r) => [r.id, truthy(r.primary)]));
  const georef = {};
  const entranceBlocks = {};
  const heuristicPrimary = [];
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
    for (const e of scored) {
      if (e.primary) heuristicPrimary.push(e.nodeId);
      const eff = navOver.has(e.nodeId) ? navOver.get(e.nodeId) : e.primary;
      if (eff) entrancesToConnect.push({ id: e.nodeId, lat: e.lat, lng: e.lng, outline: floorOutline[e.floorId] || null, buildingId: bid });
    }
    for (const f of bf) {
      entranceBlocks[f.floorId] = scored
        .filter((e) => e.floorId === f.floorId)
        .map((e) => ({ nodeId: e.nodeId, primary: e.primary, score: e.score, factors: e.factors, roomId: e.roomId, roomType: e.roomType, widthUnits: e.widthUnits, outwardDeg: e.outward, pathMeters: e.pathMeters, pathKind: e.pathKind }));
    }
    report.entrances[bid] = {
      candidates: scored.length,
      excluded: [...excluded],
      primary: scored.filter((e) => e.primary).map((e) => ({ nodeId: e.nodeId, floorId: e.floorId, score: e.score, roomType: e.roomType, widthUnits: e.widthUnits, pathMeters: e.pathMeters })),
      operatorOverrides: scored.filter((e) => navOver.has(e.nodeId)).map((e) => ({ nodeId: e.nodeId, primary: navOver.get(e.nodeId) })),
    };
  }

  // ---- entrances into the network ----
  for (const e of entrancesToConnect.sort(byKey('id'))) connectEntrance(g, e, { outline: e.outline });
  report.graph.connectors = g.report.connectors;
  report.graph.prunedFragmentNodes = pruneFragments(g);
  const { comp, sizes } = g.components();
  const graph = g.toJSON();
  report.graph.nodes = graph.nodes.length;
  report.graph.edges = graph.edges.length;
  report.graph.components = sizes;
  report.graph.entrancesInMainComponent = graph.nodes.filter((n) => n.type === 'entrance').every((n) => comp.get(n.id) === 0);

  // ---- seed for the engine: heuristic primaries and building levels/height ----
  const levels = {};
  for (const b of [...seeded].sort(byKey('id'))) {
    const best = bestFootprint.get(b.id);
    const h = buildingHeight(best ? best.fp.tags : null, null, b.name);
    const explicit = best && best.fp.tags && parseFloat(best.fp.tags.height) > 0 ? round(parseFloat(best.fp.tags.height), 1) : '';
    levels[b.id] = [h.levels, explicit];
  }
  const seedGs = buildSeedGs(heuristicPrimary.sort(), levels);

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
export function buildSeedGs(primaryIds, levels) {
  const rows = Object.entries(levels).map(([id, v]) => `    ${JSON.stringify(id)}: ${JSON.stringify(v)}`);
  return (
    `/**\n * SeedCampusMap.gs - GENERATED by scripts/campus-map/run.mjs (npm run campus-map). Do not edit by hand.\n` +
    ` * The operator's edits go to data/overrides (admin: NavNodes primary, Buildings levels/height).\n */\n\n` +
    `/**\n * Entrance nodes the primary-entrance heuristic chose (scripts/floorplan-pipeline/stages/primary-entrances.mjs).\n` +
    ` * @return {Array<string>} ${primaryIds.length} NavNodes ids\n */\nfunction getGeneratedPrimaryEntrances() {\n  return ${JSON.stringify(primaryIds)};\n}\n\n` +
    `/**\n * Per building: [levels, height]. levels from OpenStreetMap (building:levels, else height / 3.5 m) or the default by\n` +
    ` * type (academic 3, residence 4, other 2); height (m) only where OpenStreetMap gives one, else ''.\n` +
    ` * @return {Object} buildingId -> [levels, height]\n */\nfunction getGeneratedBuildingLevels() {\n  return {\n${rows.join(',\n')}\n  };\n}\n`
  );
}
