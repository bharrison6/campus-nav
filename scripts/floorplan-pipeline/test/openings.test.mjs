// Wall-gap openings, door swings, detectors and corridor centerlines on small synthetic plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentIndex, findShaftXs, longestTreadRun, mergeCollinear } from '../lib/detect.mjs';
import { doorSwings, findOpenings, swingSides } from '../lib/openings.mjs';
import { corridorCenterline } from '../lib/skeleton.mjs';
import { dist } from '../lib/geometry.mjs';

// Two rooms side by side, polygons on the inside faces of a 6-unit wall at x = 100..106.
const roomA = { polygon: [[0, 0], [100, 0], [100, 120], [0, 120]] };
const roomB = { polygon: [[106, 0], [206, 0], [206, 120], [106, 120]] };
const wallFaces = (gapFrom, gapTo) => {
  const segs = [];
  for (const x of [100, 106]) {
    if (gapFrom == null) segs.push([[x, 0], [x, 120]]);
    else segs.push([[x, 0], [x, gapFrom]], [[x, gapTo], [x, 120]]);
  }
  if (gapFrom != null) segs.push([[100, gapFrom], [106, gapFrom]], [[100, gapTo], [106, gapTo]]); // jambs
  return segs;
};

test('a solid wall between two rooms is not an opening', () => {
  assert.equal(findOpenings([roomA, roomB], new SegmentIndex(wallFaces(null))).length, 0);
});

test('a 36-unit gap in the wall is one opening at the gap', () => {
  const ops = findOpenings([roomA, roomB], new SegmentIndex(wallFaces(40, 76)));
  assert.equal(ops.length, 1);
  assert.ok(Math.abs(ops[0].p[1] - 58) < 6, `opening at y=${ops[0].p[1]}`);
  assert.ok(ops[0].width >= 30 && ops[0].width <= 44);
  assert.equal(ops[0].kind, 'gap');
});

test('coincident boundaries with no wall line are an area-line opening; with a line they are closed', () => {
  const c1 = { polygon: [[0, 0], [100, 0], [100, 60], [0, 60]] };
  const c2 = { polygon: [[100, 0], [300, 0], [300, 60], [100, 60]] };
  const open = findOpenings([c1, c2], new SegmentIndex([[[0, 0], [300, 0]]]));
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'coincident');
  assert.equal(findOpenings([c1, c2], new SegmentIndex([[[100, -5], [100, 65]]])).length, 0);
});

test('door swing: the drawn leaf marks the open end; sides found by marching', () => {
  // Hinge at (100, 40) on the wall line x=100..106, leaf open into room A (towards -x), closed end at (100, 76).
  const arc = { k: 'arc', c: [100, 40], r: 36, a0: Math.PI / 2, a1: Math.PI, src: 'arc' };
  const segs = [...wallFaces(40, 76), [[100, 40], [64, 40]]]; // leaf line hinge -> open end
  const idx = new SegmentIndex(segs);
  const [d] = doorSwings([arc], idx);
  assert.ok(dist(d.p, [100, 58]) < 1, `door midpoint ${d.p}`);
  assert.ok(d.swingDir[0] < -0.99, 'swings towards room A');
  const gross = [[-50, -50], [260, -50], [260, 170], [-50, 170]];
  const [s1, s2] = swingSides(d, [roomA, roomB], gross, idx);
  assert.equal(s1.space, 0);
  assert.equal(s2.space, 1);
});

test('exterior door: the far side leaves the gross outline', () => {
  const arc = { k: 'arc', c: [0, 40], r: 36, a0: 0, a1: Math.PI / 2, src: 'arc' };
  const idx = new SegmentIndex([[[0, 0], [0, 40]], [[0, 76], [0, 120]], [[0, 40], [36, 40]]]);
  const [d] = doorSwings([arc], idx);
  const gross = [[0, 0], [206, 0], [206, 120], [0, 120]];
  const [inside, outside] = swingSides(d, [roomA], gross, idx);
  assert.equal(inside.space, 0);
  assert.equal(outside.space, -1);
  assert.equal(outside.outside, true);
});

test('stair treads: parallel equal lines at ~11 unit spacing', () => {
  const treads = Array.from({ length: 10 }, (_, i) => [[0, i * 11], [44, i * 11]]);
  assert.equal(longestTreadRun(treads).count, 10);
  const random = [[[0, 0], [44, 0]], [[0, 40], [44, 40]], [[0, 90], [30, 90]]];
  assert.ok(longestTreadRun(random).count < 3);
});

test('boxed X drawn as four half-diagonals is found after merging collinear halves', () => {
  const c = [100, 100];
  const corners = [[64, 64], [136, 64], [136, 136], [64, 136]];
  const halves = corners.map((k) => [k, c]);
  assert.equal(findShaftXs(halves).length, 0);
  const xs = findShaftXs(mergeCollinear(halves));
  assert.equal(xs.length, 1);
  assert.ok(dist(xs[0].center, c) < 1);
});

test('corridor centerline runs down the middle of a long corridor', () => {
  const corridor = [[0, 0], [600, 0], [600, 60], [0, 60]];
  const { points, segs } = corridorCenterline(corridor);
  assert.ok(segs.length >= 1);
  for (const p of points) assert.ok(Math.abs(p[1] - 30) <= 6, `waypoint off-center: ${p}`);
  const xs = points.map((p) => p[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 450, 'spans most of the corridor');
});
