// Reads the campus-map build's committed inputs (shared by run.mjs and the tests).
import fs from 'node:fs';
import path from 'node:path';
import { FLOORPLANS_DIR, OUT_DIR, OVERRIDES_DIR } from './config.mjs';
import { openCampus } from '../data/campus-engine.mjs';

const readJson = (p, dflt) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt);

export function loadInputs({ overridesDir = OVERRIDES_DIR } = {}) {
  const extract = readJson(path.join(OUT_DIR, 'source', 'osm-extract.json'));
  if (!extract) throw new Error('data/campus-map/source/osm-extract.json is missing: run npm run campus-map -- --refresh');
  const overridesGeo = readJson(path.join(OUT_DIR, 'overrides.geojson'), { type: 'FeatureCollection', features: [] });
  const seeded = openCampus({ overridesDir }).gas.run('getAllCampusData', []).buildings.map((b) => ({ id: b.id, name: b.name, lat: b.lat, lng: b.lng, hasIndoor: b.hasIndoor }));
  const floors = fs
    .readdirSync(FLOORPLANS_DIR)
    .filter((f) => /^floor-.*\.json$/.test(f))
    .sort()
    .map((f) => ({ floorId: f.replace(/\.json$/, ''), json: readJson(path.join(FLOORPLANS_DIR, f)) }));
  return {
    extract,
    overridesGeo,
    seeded,
    buildingOverrides: readJson(path.join(overridesDir, 'buildings.json'), []),
    navNodeOverrides: readJson(path.join(overridesDir, 'navNodes.json'), []),
    floors,
    pipelineReport: readJson(path.join(FLOORPLANS_DIR, 'pipeline-report.json'), { floors: {} }),
  };
}
