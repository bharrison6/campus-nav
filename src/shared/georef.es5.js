/* GENERATED from src/shared/georef.mjs by scripts/campus-map/georef-es5.mjs (npm run campus-map). Do not edit. */
var MSCNGeoref = (function () {
  'use strict';

  // georef.mjs - the floor-plan (SVG) <-> map (lng/lat) transform, shared by the data build (scripts/data,
  // scripts/campus-map) and the web app. One definition, so the dot on the map and the node on the plan agree.
  //
  // A georef record is data/georef/<buildingId>.json:
  //   { buildingId, floorFrame: "svg", fittedFloor: "floor-it-1",
  //     transform: { originLat, originLng, rotationDeg, metersPerUnit, reflected },
  //     floorOffsets: { "floor-it-2": [dx, dy], ... },  method, residualMeters, fittedTo }
  // The transform maps the fitted floor's SVG frame (drawing inches, y down, origin at the floor's extents):
  //   1. a point of another floor first moves into the fitted floor's frame: (x + dx, y + dy) (the floors share one
  //      drawing frame, but every floor's SVG origin is that floor's own extents);
  //   2. u = x * metersPerUnit (negated when reflected), v = -y * metersPerUnit (y down -> north up);
  //   3. rotate counterclockwise by rotationDeg: east = u cos - v sin, north = u sin + v cos;
  //   4. lat = originLat + north / mLat, lng = originLng + east / mLng, with meters per degree at originLat (WGS84
  //      series; exact to millimeters across a building).
  // (originLat, originLng) is where the fitted floor's SVG (0, 0) lies.
  //
  // The body is written in ES5 (var, function, no arrows or template strings): scripts/campus-map/georef-es5.mjs
  // derives src/shared/georef.es5.js (a browser global, MSCNGeoref) from this file mechanically, and a unit test keeps
  // the two identical in behavior.

  var registry = {};

  /** Meters per degree of latitude and longitude at a latitude (WGS84 series). */
  function metersPerDegree(lat) {
    var p = (lat * Math.PI) / 180;
    return {
      lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
      lng: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
    };
  }

  function floorOffset(record, floorId) {
    var o = floorId && record.floorOffsets ? record.floorOffsets[floorId] : null;
    return o ? o : [0, 0];
  }

  /**
   * SVG point of a floor -> [lng, lat] (GeoJSON order).
   * @param {Object} record   a georef record (data/georef/<buildingId>.json)
   * @param {string} [floorId] the floor whose SVG frame (x, y) is in; omitted = the fitted floor
   */
  function svgToLngLatWith(record, x, y, floorId) {
    var t = record.transform;
    var off = floorOffset(record, floorId);
    var mpu = t.metersPerUnit;
    var u = (x + off[0]) * mpu * (t.reflected ? -1 : 1);
    var v = -(y + off[1]) * mpu;
    var r = (t.rotationDeg * Math.PI) / 180;
    var c = Math.cos(r);
    var s = Math.sin(r);
    var east = u * c - v * s;
    var north = u * s + v * c;
    var m = metersPerDegree(t.originLat);
    return [t.originLng + east / m.lng, t.originLat + north / m.lat];
  }

  /** [lng, lat] -> [x, y] in a floor's SVG frame (the inverse of svgToLngLatWith). */
  function lngLatToSvgWith(record, lng, lat, floorId) {
    var t = record.transform;
    var off = floorOffset(record, floorId);
    var m = metersPerDegree(t.originLat);
    var east = (lng - t.originLng) * m.lng;
    var north = (lat - t.originLat) * m.lat;
    var r = (t.rotationDeg * Math.PI) / 180;
    var c = Math.cos(r);
    var s = Math.sin(r);
    var u = east * c + north * s;
    var v = -east * s + north * c;
    var mpu = t.metersPerUnit;
    return [(u / mpu) * (t.reflected ? -1 : 1) - off[0], -v / mpu - off[1]];
  }

  /** Bearing in degrees clockwise from north of the SVG direction (dx, dy) on a floor of this record. */
  function svgBearingWith(record, dx, dy) {
    var t = record.transform;
    var u = dx * (t.reflected ? -1 : 1);
    var v = -dy;
    var r = (t.rotationDeg * Math.PI) / 180;
    var east = u * Math.cos(r) - v * Math.sin(r);
    var north = u * Math.sin(r) + v * Math.cos(r);
    var b = (Math.atan2(east, north) * 180) / Math.PI;
    return b < 0 ? b + 360 : b;
  }

  /** Registers georef records (an array, or an object by buildingId); returns the registry's building ids. */
  function setGeoref(records) {
    var list = Object.prototype.toString.call(records) === '[object Array]' ? records : [];
    if (!list.length && records) {
      for (var k in records) if (Object.prototype.hasOwnProperty.call(records, k)) list.push(records[k]);
    }
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].buildingId) registry[list[i].buildingId] = list[i];
    var ids = [];
    for (var id in registry) if (Object.prototype.hasOwnProperty.call(registry, id)) ids.push(id);
    return ids;
  }

  /** The registered record of a building, or null. */
  function getGeoref(buildingId) {
    return Object.prototype.hasOwnProperty.call(registry, buildingId) ? registry[buildingId] : null;
  }

  /** Empties the registry (tests). */
  function clearGeoref() {
    registry = {};
  }

  /**
   * The contract's function: a building's SVG point -> [lng, lat], or null when the building has no georef.
   * @param {string} [floorId] the floor whose SVG frame (x, y) is in (pass it: floors' SVG origins differ by up to a
   *   meter); omitted = the fitted floor (floor 1)
   */
  function svgToLngLat(buildingId, x, y, floorId) {
    var rec = getGeoref(buildingId);
    return rec ? svgToLngLatWith(rec, x, y, floorId) : null;
  }

  /** [lng, lat] -> [x, y] in a building floor's SVG frame, or null when the building has no georef. */
  function lngLatToSvg(buildingId, lng, lat, floorId) {
    var rec = getGeoref(buildingId);
    return rec ? lngLatToSvgWith(rec, lng, lat, floorId) : null;
  }

  return {
    metersPerDegree: metersPerDegree,
    svgToLngLatWith: svgToLngLatWith,
    lngLatToSvgWith: lngLatToSvgWith,
    svgBearingWith: svgBearingWith,
    setGeoref: setGeoref,
    getGeoref: getGeoref,
    clearGeoref: clearGeoref,
    svgToLngLat: svgToLngLat,
    lngLatToSvg: lngLatToSvg
  };
})();
