import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVertices, fibonacciSphere, easeInOutCubic, lerpPos, matchPositions } from './polyhedra.mjs';

function dist(v) {
  return Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2);
}

function approxEq(a, b, eps = 0.001) {
  return Math.abs(a - b) < eps;
}

// getVertices tests

test('count=1 returns 1 vertex at origin', () => {
  const verts = getVertices(1);
  assert.equal(verts.length, 1);
  assert.ok(approxEq(verts[0].x, 0), `x should be 0, got ${verts[0].x}`);
  assert.ok(approxEq(verts[0].y, 0), `y should be 0, got ${verts[0].y}`);
  assert.ok(approxEq(verts[0].z, 0), `z should be 0, got ${verts[0].z}`);
});

test('count=2 returns 2 vertices on X-axis with opposite signs', () => {
  const verts = getVertices(2);
  assert.equal(verts.length, 2);
  // Both on X-axis
  for (const v of verts) {
    assert.ok(approxEq(v.y, 0), `y should be 0, got ${v.y}`);
    assert.ok(approxEq(v.z, 0), `z should be 0, got ${v.z}`);
  }
  // Opposite signs on X
  const xs = verts.map(v => v.x).sort((a, b) => a - b);
  assert.ok(xs[0] < 0, `first x should be negative, got ${xs[0]}`);
  assert.ok(xs[1] > 0, `second x should be positive, got ${xs[1]}`);
  assert.ok(approxEq(xs[0], -xs[1]), `x values should be symmetric, got ${xs[0]} and ${xs[1]}`);
});

test('count=3 returns 3 vertices all with y≈0 (XZ plane)', () => {
  const verts = getVertices(3);
  assert.equal(verts.length, 3);
  for (const v of verts) {
    assert.ok(approxEq(v.y, 0), `y should be ~0 for equilateral triangle in XZ plane, got ${v.y}`);
  }
});

test('count=4 returns 4 vertices with varying Y (tetrahedron has depth)', () => {
  const verts = getVertices(4);
  assert.equal(verts.length, 4);
  const ys = verts.map(v => v.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  assert.ok(maxY - minY > 10, `tetrahedron should have significant Y spread, got ${maxY - minY}`);
});

test('count=5 returns 5 vertices', () => {
  const verts = getVertices(5);
  assert.equal(verts.length, 5);
});

test('count=6 returns 6 vertices with 2 poles (x≈0 and z≈0)', () => {
  const verts = getVertices(6);
  assert.equal(verts.length, 6);
  // Poles should have x≈0 and z≈0 (on Y-axis)
  const poles = verts.filter(v => approxEq(v.x, 0, 1) && approxEq(v.z, 0, 1));
  assert.equal(poles.length, 2, `octahedron should have 2 poles on Y-axis, found ${poles.length}`);
});

test('count=8 returns 8 vertices (cube)', () => {
  const verts = getVertices(8);
  assert.equal(verts.length, 8);
});

test('count=7 returns 7 vertices using Fibonacci sphere', () => {
  const verts = getVertices(7);
  assert.equal(verts.length, 7);
});

test('count=9 returns 9 vertices', () => {
  const verts = getVertices(9);
  assert.equal(verts.length, 9);
});

test('count=10 returns 10 vertices', () => {
  const verts = getVertices(10);
  assert.equal(verts.length, 10);
});

test('radius scales with count (dist for count=8 > dist for count=3)', () => {
  const verts3 = getVertices(3);
  const verts8 = getVertices(8);
  const r3 = Math.max(...verts3.map(dist));
  const r8 = Math.max(...verts8.map(dist));
  assert.ok(r8 > r3, `radius for count=8 (${r8}) should be greater than for count=3 (${r3})`);
});

// fibonacciSphere tests

test('fibonacciSphere: all N points approximately on sphere surface', () => {
  const n = 20;
  const radius = 100;
  const pts = fibonacciSphere(n, radius);
  assert.equal(pts.length, n);
  for (const p of pts) {
    const d = dist(p);
    assert.ok(approxEq(d, radius, 0.01), `point distance ${d} should be ~${radius}`);
  }
});

test('fibonacciSphere: n=1 returns 1 point', () => {
  const pts = fibonacciSphere(1, 100);
  assert.equal(pts.length, 1);
  assert.ok(approxEq(dist(pts[0]), 100, 0.01), `single point should be on sphere surface`);
});

// easeInOutCubic tests

test('easeInOutCubic: t=0 → 0, t=1 → 1, t=0.5 → 0.5', () => {
  assert.ok(approxEq(easeInOutCubic(0), 0), 'at t=0 should return 0');
  assert.ok(approxEq(easeInOutCubic(1), 1), 'at t=1 should return 1');
  assert.ok(approxEq(easeInOutCubic(0.5), 0.5), 'at t=0.5 should return 0.5');
});

test('easeInOutCubic: output is between 0 and 1 for t in [0,1]', () => {
  for (let t = 0; t <= 1; t += 0.1) {
    const v = easeInOutCubic(t);
    assert.ok(v >= 0 && v <= 1, `easeInOutCubic(${t}) = ${v} should be in [0,1]`);
  }
});

// lerpPos tests

test('lerpPos: t=0 returns a, t=1 returns b', () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 10, y: 20, z: 30 };
  const r0 = lerpPos(a, b, 0);
  const r1 = lerpPos(a, b, 1);
  assert.ok(approxEq(r0.x, 0) && approxEq(r0.y, 0) && approxEq(r0.z, 0), 't=0 should equal a');
  assert.ok(approxEq(r1.x, 10) && approxEq(r1.y, 20) && approxEq(r1.z, 30), 't=1 should equal b');
});

test('lerpPos: t=0.5 returns midpoint', () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 10, y: 20, z: 30 };
  const mid = lerpPos(a, b, 0.5);
  assert.ok(approxEq(mid.x, 5), `midpoint x should be 5, got ${mid.x}`);
  assert.ok(approxEq(mid.y, 10), `midpoint y should be 10, got ${mid.y}`);
  assert.ok(approxEq(mid.z, 15), `midpoint z should be 15, got ${mid.z}`);
});

// matchPositions tests

test('matchPositions: 1-to-1 matching returns identity mapping', () => {
  const current = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ];
  const next = [
    { x: 1, y: 0, z: 0 },   // closest to current[0]
    { x: 11, y: 0, z: 0 },  // closest to current[1]
  ];
  const result = matchPositions(current, next);
  assert.equal(result.mapping[0], 0, 'current[0] should map to next[0]');
  assert.equal(result.mapping[1], 1, 'current[1] should map to next[1]');
  assert.equal(result.unmatched.length, 0, 'no unmatched positions');
});

test('matchPositions: more new positions than current → unmatched lists extras', () => {
  const current = [{ x: 0, y: 0, z: 0 }];
  const next = [
    { x: 0, y: 0, z: 0 },
    { x: 100, y: 0, z: 0 },
    { x: 200, y: 0, z: 0 },
  ];
  const result = matchPositions(current, next);
  assert.equal(result.mapping.length, 1, 'mapping has one entry per current');
  assert.equal(result.unmatched.length, 2, 'two positions unmatched');
});

test('matchPositions: fewer new positions than current → mapping has undefined/null for surplus', () => {
  const current = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 20, y: 0, z: 0 },
  ];
  const next = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ];
  const result = matchPositions(current, next);
  assert.equal(result.mapping.length, 3, 'mapping has one entry per current');
  // Two should be matched, one should be null/undefined
  const matched = result.mapping.filter(v => v != null);
  assert.equal(matched.length, 2, 'two current positions should be matched');
  assert.equal(result.unmatched.length, 0, 'no unmatched new positions');
});
