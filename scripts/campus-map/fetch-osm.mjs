// Downloads the OpenStreetMap data for the campus box: the main OSM API `map` call first (JSON), split into tiles when
// the API refuses the size, then Overpass mirrors as the fallback. Every request has a timeout and retries with backoff.
//   import { fetchOsm } from './fetch-osm.mjs';  const { elements, source } = await fetchOsm(BBOX, { log });
import { OSM_API, OVERPASS, USER_AGENT } from './config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { timeoutMs = 90000, method = 'GET', body, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    const res = await fetch(url, { method, body, signal: ac.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers } });
    const text = await res.text();
    return { status: res.status, text, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(t);
  }
}

/** Retries a request on network errors and 429/5xx with exponential backoff; returns the last response or throws. */
export async function withRetry(fn, { tries = 4, baseMs = 2000, log = () => {}, what = 'request' } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn();
      if (r.status === 429 || r.status >= 500) {
        last = new Error(`${what}: HTTP ${r.status}`);
        log(`  ${what}: HTTP ${r.status}${i + 1 < tries ? `, retry ${i + 1} of ${tries - 1}` : ', giving up'}`);
      } else {
        return r;
      }
    } catch (e) {
      last = e;
      log(`  ${what}: ${e.message}${i + 1 < tries ? `, retry ${i + 1} of ${tries - 1}` : ', giving up'}`);
    }
    if (i + 1 < tries) await sleep(baseMs * 2 ** i);
  }
  throw last;
}

const bboxParam = (b) => [b.minLng, b.minLat, b.maxLng, b.maxLat].map((v) => v.toFixed(6)).join(',');

function splitBox(b) {
  const mLat = (b.minLat + b.maxLat) / 2;
  const mLng = (b.minLng + b.maxLng) / 2;
  return [
    { minLat: b.minLat, minLng: b.minLng, maxLat: mLat, maxLng: mLng },
    { minLat: b.minLat, minLng: mLng, maxLat: mLat, maxLng: b.maxLng },
    { minLat: mLat, minLng: b.minLng, maxLat: b.maxLat, maxLng: mLng },
    { minLat: mLat, minLng: mLng, maxLat: b.maxLat, maxLng: b.maxLng },
  ];
}

/** Merges element lists by type/id (the API returns whole ways crossing a tile edge in both tiles). */
export function mergeElements(lists) {
  const m = new Map();
  for (const list of lists) for (const e of list) m.set(`${e.type}/${e.id}`, e);
  return [...m.values()].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.id - b.id));
}

async function osmApiBox(b, { log, depth = 0 }) {
  const url = `${OSM_API[0]}?bbox=${bboxParam(b)}`;
  const r = await withRetry(() => get(url), { log, what: `OSM API map ${bboxParam(b)}` });
  if (r.status === 200) {
    const j = JSON.parse(r.text);
    log(`  OSM API ${bboxParam(b)}: ${j.elements.length} elements`);
    return j.elements;
  }
  // 400: "You requested too many nodes" (limit 50,000) or area too large; 509: bandwidth. Split and recurse.
  if ((r.status === 400 || r.status === 509) && depth < 3) {
    log(`  OSM API ${bboxParam(b)}: HTTP ${r.status} (${r.text.slice(0, 120).trim()}), splitting`);
    const parts = [];
    for (const q of splitBox(b)) parts.push(await osmApiBox(q, { log, depth: depth + 1 }));
    return mergeElements(parts);
  }
  throw new Error(`OSM API HTTP ${r.status}: ${r.text.slice(0, 200)}`);
}

async function overpassBox(b, { log }) {
  const s = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
  const q = `[out:json][timeout:120];(node(${s});way(${s});relation(${s}););(._;>;);out body;`;
  let lastErr;
  for (const ep of OVERPASS) {
    try {
      const r = await withRetry(() => get(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeoutMs: 150000 }), { log, what: `Overpass ${ep}`, tries: 3 });
      if (r.status === 200 && r.text.trim().startsWith('{')) {
        const j = JSON.parse(r.text);
        log(`  Overpass ${ep}: ${j.elements.length} elements`);
        return j.elements;
      }
      lastErr = new Error(`Overpass ${ep}: HTTP ${r.status} ${r.text.slice(0, 120)}`);
      log('  ' + lastErr.message);
    } catch (e) {
      lastErr = e;
      log(`  Overpass ${ep}: ${e.message}`);
    }
  }
  throw lastErr || new Error('Overpass: no endpoint answered');
}

/** @return {Promise<{elements: Object[], source: string, fetchedAt: string}>} */
export async function fetchOsm(bbox, { log = console.log } = {}) {
  const fetchedAt = new Date().toISOString();
  try {
    const elements = mergeElements([await osmApiBox(bbox, { log })]);
    return { elements, source: 'api.openstreetmap.org/api/0.6/map', fetchedAt };
  } catch (e) {
    log(`OSM API failed (${e.message}); trying Overpass mirrors`);
  }
  const elements = mergeElements([await overpassBox(bbox, { log })]);
  return { elements, source: 'overpass', fetchedAt };
}
