/**
 * polyhedra.mjs — Pure math module for calculating polyhedra vertex positions.
 * No browser or Three.js dependencies. All positions are {x, y, z} plain objects.
 */

/**
 * Radius formula: R = 200 + count * 20
 */
function radiusFor(count) {
  return 200 + count * 20;
}

/**
 * Distribute N points evenly on a sphere of given radius using the Fibonacci / golden-angle method.
 */
export function fibonacciSphere(n, radius) {
  if (n === 1) {
    return [{ x: radius, y: 0, z: 0 }];
  }
  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  const points = [];
  for (let i = 0; i < n; i++) {
    const theta = Math.acos(1 - (2 * (i + 0.5)) / n); // polar angle from north pole
    const phi = (2 * Math.PI * i) / goldenRatio;       // azimuthal angle
    points.push({
      x: radius * Math.sin(theta) * Math.cos(phi),
      y: radius * Math.cos(theta),
      z: radius * Math.sin(theta) * Math.sin(phi),
    });
  }
  return points;
}

/**
 * Get vertex positions for a given terminal count.
 */
export function getVertices(count) {
  const R = radiusFor(count);

  switch (count) {
    case 1:
      return [{ x: 0, y: 0, z: 0 }];

    case 2:
      return [
        { x: -R, y: 0, z: 0 },
        { x:  R, y: 0, z: 0 },
      ];

    case 3: {
      // Equilateral triangle in XZ plane (y=0)
      const verts = [];
      for (let i = 0; i < 3; i++) {
        const angle = (2 * Math.PI * i) / 3;
        verts.push({ x: R * Math.cos(angle), y: 0, z: R * Math.sin(angle) });
      }
      return verts;
    }

    case 4: {
      // Regular tetrahedron
      // Place one vertex at top (0, R, 0), the other 3 in a lower triangle
      const h = R;
      const baseR = R * Math.sqrt(8 / 9);
      const baseY = -R / 3;
      const verts = [{ x: 0, y: h, z: 0 }];
      for (let i = 0; i < 3; i++) {
        const angle = (2 * Math.PI * i) / 3;
        verts.push({
          x: baseR * Math.cos(angle),
          y: baseY,
          z: baseR * Math.sin(angle),
        });
      }
      return verts;
    }

    case 5: {
      // Triangular bipyramid: 3 equatorial + 2 polar
      const equatorialR = R * Math.sqrt(2 / 3);
      const poleY = R;
      const verts = [
        { x: 0, y:  poleY, z: 0 },
        { x: 0, y: -poleY, z: 0 },
      ];
      for (let i = 0; i < 3; i++) {
        const angle = (2 * Math.PI * i) / 3;
        verts.push({
          x: equatorialR * Math.cos(angle),
          y: 0,
          z: equatorialR * Math.sin(angle),
        });
      }
      return verts;
    }

    case 6: {
      // Octahedron: 2 poles on Y-axis + 4 equatorial on XZ plane
      return [
        { x:  0, y:  R, z:  0 },
        { x:  0, y: -R, z:  0 },
        { x:  R, y:  0, z:  0 },
        { x: -R, y:  0, z:  0 },
        { x:  0, y:  0, z:  R },
        { x:  0, y:  0, z: -R },
      ];
    }

    case 8: {
      // Cube: all 8 combinations of (±r, ±r, ±r) where r = R/sqrt(3)
      const r = R / Math.sqrt(3);
      const verts = [];
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            verts.push({ x: sx * r, y: sy * r, z: sz * r });
          }
        }
      }
      return verts;
    }

    default:
      // 7 and 9+ use Fibonacci sphere distribution
      return fibonacciSphere(count, R);
  }
}

/**
 * Cubic ease-in-out easing function.
 * @param {number} t - Input in [0, 1]
 * @returns {number} Eased value in [0, 1]
 */
export function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Linear interpolation between two {x,y,z} positions.
 * @param {{x,y,z}} a - Start position
 * @param {{x,y,z}} b - End position
 * @param {number} t - Interpolation factor [0, 1]
 * @returns {{x,y,z}}
 */
export function lerpPos(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * Greedy nearest-neighbor matching of current positions to new positions.
 *
 * @param {{x,y,z}[]} currentPositions - Existing terminal positions
 * @param {{x,y,z}[]} newPositions - Target positions
 * @returns {{ mapping: (number|null)[], unmatched: number[] }}
 *   mapping[i] = index into newPositions for existing terminal i (null if no match available)
 *   unmatched = indices of newPositions not matched to any current terminal
 */
export function matchPositions(currentPositions, newPositions) {
  const available = new Set(newPositions.map((_, i) => i));
  const mapping = new Array(currentPositions.length).fill(null);

  function sqDist(a, b) {
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
  }

  for (let i = 0; i < currentPositions.length; i++) {
    if (available.size === 0) break;
    const cur = currentPositions[i];
    let bestIdx = null;
    let bestDist = Infinity;
    for (const j of available) {
      const d = sqDist(cur, newPositions[j]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    if (bestIdx !== null) {
      mapping[i] = bestIdx;
      available.delete(bestIdx);
    }
  }

  const unmatched = [...available];
  return { mapping, unmatched };
}
