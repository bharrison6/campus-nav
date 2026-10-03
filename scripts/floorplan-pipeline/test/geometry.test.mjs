import test from 'node:test';
import assert from 'node:assert/strict';
import {
  area, signedArea, centroid, pointInPolygon, distToSegment, distToPolygon, segmentsIntersect, expandBulges,
  simplifyPolyline, cleanRing, poleOfInaccessibility, makeInsertTransform, arcPoints,
} from '../lib/geometry.mjs';

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('area, signed area and centroid of a square', () => {
  assert.equal(area(square), 100);
  assert.equal(signedArea(square), 100);
  assert.equal(signedArea(square.slice().reverse()), -100);
  assert.deepEqual(centroid(square), [5, 5]);
});

test('point in polygon and boundary distances', () => {
  assert.equal(pointInPolygon([5, 5], square), true);
  assert.equal(pointInPolygon([15, 5], square), false);
  assert.equal(distToSegment([5, 3], [0, 0], [10, 0]), 3);
  assert.equal(distToSegment([-3, 4], [0, 0], [10, 0]), 5);
  assert.equal(distToPolygon([5, 4], square), 4);
});

test('segment intersection: crossing, touching, parallel, apart', () => {
  assert.equal(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0]), true);
  assert.equal(segmentsIntersect([0, 0], [10, 0], [10, 0], [10, 5]), true);
  assert.equal(segmentsIntersect([0, 0], [10, 0], [0, 1], [10, 1]), false);
  assert.equal(segmentsIntersect([0, 0], [1, 0], [2, -1], [2, 1]), false);
});

test('bulge 1 is a semicircle: expanded ring area = half disc', () => {
  // Two vertices with bulge 1 each make a full circle of diameter 20 (radius 10).
  const ring = expandBulges([{ x: 0, y: 0, bulge: 1 }, { x: 20, y: 0, bulge: 1 }], true, 0.01);
  assert.ok(near(area(ring), Math.PI * 100, 0.5), `area ${area(ring)}`);
  // An open polyline with one CCW semicircle from (0,0) to (20,0) bulges below the chord (y < 0).
  const half = expandBulges([{ x: 0, y: 0, bulge: 1 }, { x: 20, y: 0, bulge: 0 }], false, 0.01);
  assert.ok(half.some((p) => p[1] < -9.9), 'semicircle reaches the radius below the chord');
  assert.ok(half.every((p) => p[1] <= 1e-9));
});

test('arc sampling includes both ends', () => {
  const pts = arcPoints([0, 0], 10, 0, Math.PI / 2, 0.1);
  assert.ok(near(pts[0][0], 10) && near(pts[0][1], 0));
  assert.ok(near(pts.at(-1)[0], 0, 1e-9) && near(pts.at(-1)[1], 10));
});

test('Douglas-Peucker keeps corners, drops collinear points', () => {
  const pts = [[0, 0], [5, 0.1], [10, 0], [10, 5], [10, 10]];
  assert.deepEqual(simplifyPolyline(pts, 0.5), [[0, 0], [10, 0], [10, 10]]);
});

test('cleanRing drops repeated and closing duplicates', () => {
  assert.deepEqual(cleanRing([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]]), [[0, 0], [1, 0], [1, 1]]);
});

test('pole of inaccessibility lies inside a concave L shape, away from its walls', () => {
  const L = [[0, 0], [100, 0], [100, 20], [20, 20], [20, 100], [0, 100]];
  const [x, y, d] = poleOfInaccessibility(L, 0.5);
  assert.equal(pointInPolygon([x, y], L), true);
  assert.ok(d >= 9, `inradius ${d}`);
  // The centroid of this L is outside the shape; the pole must not be.
  assert.equal(pointInPolygon(centroid(L), L), false);
});

test('insert transform: scale, rotate, translate', () => {
  const T = makeInsertTransform({ base: [0, 0], sx: 2, sy: 2, rot: Math.PI / 2, at: [100, 0] });
  const p = T([1, 0]);
  assert.ok(near(p[0], 100) && near(p[1], 2));
});
