// Geodesy helpers for the campus-map build: haversine distance, a local metric (equirectangular) frame, Web Mercator
// tile math, and small planar polygon utilities. Plain functions over [x, y] / {lat, lng}.

export const EARTH_R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Meters per degree of latitude and longitude at a latitude (ellipsoidal series, WGS84). */
export function metersPerDegree(lat) {
  const p = rad(lat);
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lng: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

/** A local east/north meter frame around a center: toXY(lat, lng) -> [e, n]; toLatLng(e, n) -> [lat, lng]. */
export function localFrame(center) {
  const m = metersPerDegree(center.lat);
  return {
    center,
    toXY: (lat, lng) => [(lng - center.lng) * m.lng, (lat - center.lat) * m.lat],
    toLatLng: (e, n) => [center.lat + n / m.lat, center.lng + e / m.lng],
  };
}

/** Web Mercator tile indices for a lng/lat at zoom z. */
export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = rad(lat);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y };
}

/** The tile's bounds as {west, south, east, north} in degrees and as EPSG:3857 meters. */
export function tileBounds(x, y, z) {
  const n = 2 ** z;
  const lng = (xx) => (xx / n) * 360 - 180;
  const lat = (yy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  const merc = 20037508.342789244;
  const mx = (xx) => (xx / n) * 2 * merc - merc;
  const my = (yy) => merc - (yy / n) * 2 * merc;
  return {
    west: lng(x), east: lng(x + 1), north: lat(y), south: lat(y + 1),
    mercator: [mx(x), my(y + 1), mx(x + 1), my(y)],
  };
}

export function polygonArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}

export function polygonCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on segment ab to p, and the parameter t in [0, 1]. */
export function closestOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return { p: [a[0] + t * dx, a[1] + t * dy], t };
}

export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Distance from p to a polyline or closed ring (closed: the last vertex joins the first). */
export function distToPolyline(p, pts, closed = false) {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i + 1 < n + (closed ? 1 : 0); i++) {
    const q = closestOnSegment(p, pts[i], pts[(i + 1) % n]).p;
    best = Math.min(best, dist2(p, q));
  }
  return best;
}

/** Points every `step` along a closed ring (vertices included). */
export function sampleRing(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const L = dist2(a, b);
    const k = Math.max(1, Math.ceil(L / step));
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

export const round = (v, d) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
