#!/usr/bin/env node
// npm run campus-map [-- --refresh] [-- --aerial] [-- --aerial-refresh] [-- --check]
//
// Regenerates the campus map data from committed inputs (no network):
//   data/campus-map/source/osm-extract.json  OpenStreetMap extract (input; --refresh re-downloads it first)
//   data/campus-map/overrides.geojson        hand-drawn corrections (input)
//   data/floorplans/*.json, data/overrides   floor data and the operator's edits (inputs)
// and writes data/campus-map/{buildings.geojson, layers/*.geojson, outdoor-graph.json, manifest.json},
// data/georef/<buildingId>.json, the `entrances` block of each public floor JSON, and tools/admin/gs/SeedCampusMap.gs.
// (The app reads the transform through the ES module src/shared/georef.mjs itself, served as vendor/georef.mjs.)
// --aerial downloads the optional NAIP aerial tiles when data/campus-map/aerial is absent (--aerial-refresh: always).
// --check writes nothing and exits 1 when a committed output differs from what the inputs give.
import fs from 'node:fs';
import path from 'node:path';
import { BBOX, CACHE_DIR, FLOORPLANS_DIR, OUT_DIR, REPO } from './config.mjs';
import { fetchOsm } from './fetch-osm.mjs';
import { formatExtract, toExtract } from './extract.mjs';
import { buildCampusMap, withEntrances } from './build.mjs';
import { loadInputs } from './inputs.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const log = (...a) => console.log(...a);

async function main() {
  const extractPath = path.join(OUT_DIR, 'source', 'osm-extract.json');
  if (has('--refresh') || !fs.existsSync(extractPath)) {
    if (has('--check')) throw new Error('--check needs the committed extract');
    log(`downloading OpenStreetMap data for ${JSON.stringify(BBOX)}`);
    const r = await fetchOsm(BBOX, { log });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, 'osm.json'), JSON.stringify({ bbox: BBOX, source: r.source, fetchedAt: r.fetchedAt, elements: r.elements }));
    const x = toExtract(r.elements, { source: r.source, fetchedAt: r.fetchedAt, bbox: BBOX });
    fs.mkdirSync(path.dirname(extractPath), { recursive: true });
    fs.writeFileSync(extractPath, formatExtract(x));
    log(`  extract: ${x.nodes.length} nodes, ${x.ways.length} ways, ${x.relations.length} relations -> ${path.relative(REPO, extractPath)}`);
  }

  const t0 = Date.now();
  const inputs = loadInputs();
  const out = buildCampusMap(inputs);
  const files = { ...out.files };
  for (const f of inputs.floors) {
    if (!out.entranceBlocks[f.floorId]) continue;
    files[path.relative(REPO, path.join(FLOORPLANS_DIR, `${f.floorId}.json`)).replace(/\\/g, '/')] = JSON.stringify(withEntrances(f.json, out.entranceBlocks[f.floorId]), null, 1) + '\n';
  }

  const changed = [];
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(REPO, rel);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) continue;
    changed.push(rel);
    if (!has('--check')) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
  }

  const r = out.report;
  log(`campus map built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  log(`  buildings: ${r.buildings.footprints} footprints (${r.buildings.named} named), ${r.buildings.seededWithFootprint} of ${inputs.seeded.length} seeded buildings matched`);
  log(`  layers: ${Object.entries(out.layers).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
  for (const [bid, g] of Object.entries(r.georef)) log(`  georef ${bid}: ${g.error || `residual ${g.residualMeters} m rms (mean ${g.residual.mean}, p90 ${g.residual.p90}, max ${g.residual.max}), rotation ${g.rotationDeg} deg, fitted to ${g.fittedTo}`}`);
  for (const [bid, e] of Object.entries(r.entrances)) log(`  primary entrances ${bid}: ${e.primary.map((p) => `${p.nodeId} (${p.score})`).join(', ')}`);
  log(`  outdoor graph: ${r.graph.nodes} nodes, ${r.graph.edges} edges, components ${r.graph.components.slice(0, 5).join('/')}, entrances in main component: ${r.graph.entrancesInMainComponent}`);
  for (const c of r.graph.connectors) if (c.straight) log(`  CONNECTOR ${c.nodeId}: ${c.meters} m straight line to the ${c.viaKind} network (over 30 m)`);
  for (const s of r.overrides.pathSnaps) if (s.how === 'unjoined') log(`  override path "${s.feature}" vertex ${s.vertex} ends without a junction (expected where a walk ends at a building wall)`);
  if (has('--check')) {
    if (changed.length) {
      console.error(`out of date (run npm run campus-map): ${changed.join(', ')}`);
      process.exit(1);
    }
    log('  committed outputs are up to date');
  } else {
    log(`  ${changed.length ? `wrote ${changed.join(', ')}` : 'no changes'}`);
  }

  if (has('--aerial') || has('--aerial-refresh')) {
    const { buildAerial } = await import('./aerial.mjs');
    await buildAerial({ force: has('--aerial-refresh'), log });
  }
}

main().catch((e) => {
  console.error(`campus-map failed: ${e.stack || e.message}`);
  process.exit(1);
});
