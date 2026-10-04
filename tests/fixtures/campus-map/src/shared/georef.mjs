// FIXTURE STAND-IN for lane J's src/shared/georef.mjs (the real module replaces this at integration).
// Contract (plan mscn-v4-campus-map-2-5d): data/georef/<buildingId>.json =
//   {buildingId, floorFrame: "svg", transform: {originLat, originLng, rotationDeg, metersPerUnit}, method, residualMeters, fittedTo}
// Convention assumed here (lane K's guess; confirm against J's module):
//   SVG (x, y), y down, origin (0, 0) at (originLat, originLng); local east/north meters
//   e = x * metersPerUnit, n = -y * metersPerUnit, rotated counter-clockwise by rotationDeg; spherical offset.
// API lane K consumes: svgToLngLat(georef, x, y) -> [lng, lat]; lngLatToSvg(georef, lng, lat) -> [x, y].
// `georef` may be the whole document or just its `transform`.
const R = 6378137;
const D2R = Math.PI / 180;

function tf(georef) {
  const t = georef && georef.transform ? georef.transform : georef;
  if (!t || !isFinite(t.originLat) || !isFinite(t.originLng)) throw new Error('georef: transform missing');
  return { lat0: +t.originLat, lng0: +t.originLng, rot: (+t.rotationDeg || 0) * D2R, mpu: +t.metersPerUnit || 0.0254 };
}

export function svgToLngLat(georef, x, y) {
  const t = tf(georef);
  const e = x * t.mpu;
  const n = -y * t.mpu;
  const E = e * Math.cos(t.rot) - n * Math.sin(t.rot);
  const N = e * Math.sin(t.rot) + n * Math.cos(t.rot);
  return [t.lng0 + (E / (R * Math.cos(t.lat0 * D2R))) / D2R, t.lat0 + (N / R) / D2R];
}

export function lngLatToSvg(georef, lng, lat) {
  const t = tf(georef);
  const E = (lng - t.lng0) * D2R * R * Math.cos(t.lat0 * D2R);
  const N = (lat - t.lat0) * D2R * R;
  const e = E * Math.cos(-t.rot) - N * Math.sin(-t.rot);
  const n = E * Math.sin(-t.rot) + N * Math.cos(-t.rot);
  return [e / t.mpu, -n / t.mpu];
}
