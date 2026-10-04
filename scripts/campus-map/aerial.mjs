// Optional aerial layer: USDA NAIP orthoimagery (public domain) cut into Web Mercator tiles for the campus box,
// zooms 15 to 18, 256 px JPEG (quality 80), written to data/campus-map/aerial/{z}/{x}/{y}.jpg with aerial.json:
//   { bounds: [west, south, east, north], minzoom, maxzoom, tileSize, tiles, attribution, acquired, source, ... }
// Sources, in order: the USDA APFO NAIP image service, then the USGS National Map NAIP service (the same USDA NAIP
// imagery). No other imagery provider.
//   npm run campus-map -- --aerial            build when data/campus-map/aerial.json is absent
//   npm run campus-map -- --aerial-refresh    rebuild
// Downloaded tiles are kept in scripts/campus-map/.cache/aerial (gitignored), so a run interrupted by the service's
// intermittent errors resumes where it stopped. data/campus-map/aerial is written only when every tile is present and
// the total is under the cap; otherwise nothing is published and the reason is printed.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, OUT_DIR, USER_AGENT } from './config.mjs';
import { lngLatToTile, tileBounds } from './geo.mjs';
import { withRetry } from './fetch-osm.mjs';

/** The plan's campus box (the aerial covers the campus, not the whole OSM download box). */
export const AERIAL_BBOX = { minLat: 36.606, minLng: -88.333, maxLat: 36.625, maxLng: -88.31 };
export const ZOOMS = [15, 16, 17, 18];
export const CAP_BYTES = 25 * 1024 * 1024;
export const AERIAL_DIR = path.join(OUT_DIR, 'aerial');
export const AERIAL_MANIFEST = path.join(OUT_DIR, 'aerial.json');
export const TILE_CACHE = path.join(CACHE_DIR, 'aerial');

export const SERVICES = [
  { key: 'apfo', name: 'USDA APFO NAIP (USDA_CONUS_PRIME)', url: 'https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer', credit: 'USDA NAIP, public domain' },
  { key: 'usgs', name: 'USGS The National Map NAIP (USGSNAIPImagery)', url: 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer', credit: 'USDA NAIP via USGS The National Map, public domain' },
];

async function get(url, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, type: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(t);
  }
}

/** The tiles covering a box at the given zooms: [{z, x, y}]. */
export function tilesFor(bbox, zooms = ZOOMS) {
  const out = [];
  for (const z of zooms) {
    const a = lngLatToTile(bbox.minLng, bbox.maxLat, z);
    const b = lngLatToTile(bbox.maxLng, bbox.minLat, z);
    for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
  }
  return out;
}

export const tilePath = (t) => path.join(String(t.z), String(t.x), `${t.y}.jpg`);

async function pickService(log) {
  for (const s of SERVICES) {
    try {
      const r = await withRetry(() => get(`${s.url}?f=json`, 30000), { log, what: s.name, tries: 3, baseMs: 2000 });
      if (r.status === 200 && r.buf.toString('utf8').trim().startsWith('{')) return s;
      log(`  ${s.name}: HTTP ${r.status}`);
    } catch (e) {
      log(`  ${s.name}: ${e.message}${e.cause && e.cause.code ? ` (${e.cause.code})` : ''}`);
    }
  }
  return null;
}

async function acquisition(service, bbox) {
  const c = `${(bbox.minLng + bbox.maxLng) / 2},${(bbox.minLat + bbox.maxLat) / 2}`;
  try {
    const r = await get(`${service.url}/query?geometry=${c}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=acquisition_date,Year,agency,resolution_value&returnGeometry=false&f=json`, 30000);
    const j = JSON.parse(r.buf.toString('utf8'));
    const hits = (j.features || []).map((f) => f.attributes).filter((a) => a.acquisition_date).sort((a, b) => b.acquisition_date - a.acquisition_date);
    if (hits.length) return { date: new Date(hits[0].acquisition_date).toISOString().slice(0, 10), resolutionMeters: hits[0].resolution_value || null };
  } catch {
    /* the date is informative only */
  }
  return { date: '', resolutionMeters: null };
}

/** Downloads the tiles; returns the manifest, or null (with the reason logged) when skipped. */
export async function buildAerial({ force = false, log = console.log, bbox = AERIAL_BBOX, concurrency = 3 } = {}) {
  if (!force && fs.existsSync(AERIAL_MANIFEST)) {
    log('aerial: present (use --aerial-refresh to rebuild)');
    return JSON.parse(fs.readFileSync(AERIAL_MANIFEST, 'utf8'));
  }
  log('aerial: looking for a NAIP image service');
  const service = await pickService(log);
  if (!service) {
    log('aerial: SKIPPED, no NAIP service answered');
    return null;
  }
  const cache = path.join(TILE_CACHE, service.key);
  const tiles = tilesFor(bbox);
  const missing = tiles.filter((t) => !fs.existsSync(path.join(cache, tilePath(t))));
  log(`aerial: ${service.name}, ${tiles.length} tiles at zooms ${ZOOMS.join(', ')} (${tiles.length - missing.length} cached)`);

  const fetchTile = async (t, tries, baseMs, quiet) => {
    const m = tileBounds(t.x, t.y, t.z).mercator;
    const url = `${service.url}/exportImage?bbox=${m.join(',')}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&compressionQuality=80&interpolation=RSP_BilinearInterpolation&f=image`;
    const r = await withRetry(() => get(url), { log: quiet ? () => {} : log, what: `tile ${t.z}/${t.x}/${t.y}`, tries, baseMs });
    if (r.status !== 200 || !/image\/jpe?g/.test(r.type)) throw new Error(`HTTP ${r.status} ${r.type}`);
    const p = path.join(cache, tilePath(t));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, r.buf);
  };
  // Pass 1: every missing tile with a few quick retries; pass 2: the failures again, one at a time, slowly.
  let i = 0;
  const retry = [];
  const worker = async () => {
    while (i < missing.length) {
      const t = missing[i++];
      try {
        await fetchTile(t, 3, 1500, true);
      } catch {
        retry.push(t);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (retry.length) log(`aerial: retrying ${retry.length} tile(s) one at a time`);
  const failed = [];
  for (const t of retry) {
    try {
      await fetchTile(t, 6, 5000, false);
    } catch (e) {
      failed.push(`${t.z}/${t.x}/${t.y} (${e.message})`);
    }
  }
  if (failed.length) {
    log(`aerial: SKIPPED for now, ${failed.length} tile(s) still failing: ${failed.slice(0, 5).join(', ')}; the rest are cached, run again to resume`);
    return null;
  }
  const bytes = tiles.reduce((s, t) => s + fs.statSync(path.join(cache, tilePath(t))).size, 0);
  if (bytes > CAP_BYTES) {
    log(`aerial: SKIPPED, ${(bytes / 1048576).toFixed(1)} MB is over the ${CAP_BYTES / 1048576} MB cap`);
    return null;
  }
  for (const t of tiles) {
    const dst = path.join(AERIAL_DIR, tilePath(t));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(cache, tilePath(t)), dst);
  }
  const acquired = await acquisition(service, bbox);
  const manifest = {
    bounds: [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat],
    minzoom: ZOOMS[0],
    maxzoom: ZOOMS[ZOOMS.length - 1],
    tileSize: 256,
    format: 'jpg',
    tiles: 'aerial/{z}/{x}/{y}.jpg',
    attribution: service.credit,
    acquired: acquired.date,
    resolutionMeters: acquired.resolutionMeters,
    source: `${service.name}: ${service.url}`,
    tileCount: tiles.length,
    bytes,
  };
  fs.writeFileSync(AERIAL_MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
  log(`aerial: ${tiles.length} tiles, ${(bytes / 1048576).toFixed(1)} MB, acquired ${acquired.date || 'unknown'} -> data/campus-map/aerial`);
  return manifest;
}
