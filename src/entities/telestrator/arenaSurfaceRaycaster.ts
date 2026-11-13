import * as THREE from 'three';

export type ArenaSurfaceKind = 'floor' | 'wall' | 'ceiling' | 'goal';

export interface ArenaSurfaceHit {
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly distance: number;
  readonly surfaceKind: ArenaSurfaceKind;
}

const ARENA_HALF_X = 4096;
const ARENA_HALF_Y = 5120;
const ARENA_CEILING_Y = 2044;
const GOAL_HALF_WIDTH = 892.755;
const GOAL_HEIGHT = 642.78;
const GOAL_DEPTH = 880;
const CORNER_CHAMFER = 1152;
const SURFACE_OFFSET_UU = 3.5;

/**
 * Analytical RocketSim/Three.js arena surface raycaster (Y-up Three.js space: X=width, Y=up, Z=length).
 * Intersects floor (Y=0), ceiling (Y=2044), 4 side walls, 4 corner chamfers, and goal boxes.
 */
export function raycastArenaSurface(
  ray: THREE.Ray,
  extraMeshes?: readonly THREE.Object3D[]
): ArenaSurfaceHit | null {
  let bestDist = Infinity;
  let bestKind: ArenaSurfaceKind = 'floor';
  const bestPoint = new THREE.Vector3();
  const bestNormal = new THREE.Vector3(0, 1, 0);

  const testPlane = (
    nx: number,
    ny: number,
    nz: number,
    d: number,
    kind: ArenaSurfaceKind,
    boundsCheck: (px: number, py: number, pz: number) => boolean
  ) => {
    const denom = ray.direction.x * nx + ray.direction.y * ny + ray.direction.z * nz;
    if (denom >= -1e-5) return;
    const t = -(ray.origin.x * nx + ray.origin.y * ny + ray.origin.z * nz + d) / denom;
    if (t <= 0 || t >= bestDist) return;
    const px = ray.origin.x + ray.direction.x * t;
    const py = ray.origin.y + ray.direction.y * t;
    const pz = ray.origin.z + ray.direction.z * t;
    if (!boundsCheck(px, py, pz)) return;
    bestDist = t;
    bestKind = kind;
    bestPoint.set(px, py, pz);
    bestNormal.set(nx, ny, nz);
  };

  // Floor (Y = 0) & Ceiling (Y = 2044)
  testPlane(0, 1, 0, 0, 'floor', (px, _py, pz) => {
    if (Math.abs(px) <= GOAL_HALF_WIDTH && Math.abs(pz) <= ARENA_HALF_Y + GOAL_DEPTH) return true;
    return Math.abs(px) <= ARENA_HALF_X && Math.abs(pz) <= ARENA_HALF_Y;
  });
  testPlane(0, -1, 0, ARENA_CEILING_Y, 'ceiling', (px, _py, pz) => {
    return Math.abs(px) <= ARENA_HALF_X && Math.abs(pz) <= ARENA_HALF_Y;
  });

  // Side walls (X = +-4096)
  testPlane(
    -1,
    0,
    0,
    ARENA_HALF_X,
    'wall',
    (_px, py, pz) => py >= 0 && py <= ARENA_CEILING_Y && Math.abs(pz) <= ARENA_HALF_Y
  );
  testPlane(
    1,
    0,
    0,
    ARENA_HALF_X,
    'wall',
    (_px, py, pz) => py >= 0 && py <= ARENA_CEILING_Y && Math.abs(pz) <= ARENA_HALF_Y
  );

  // Back walls (Z = +-5120, excluding goal opening)
  const backWallBounds = (px: number, py: number) => {
    if (py < 0 || py > ARENA_CEILING_Y || Math.abs(px) > ARENA_HALF_X) return false;
    return !(Math.abs(px) < GOAL_HALF_WIDTH && py < GOAL_HEIGHT);
  };
  testPlane(0, 0, -1, ARENA_HALF_Y, 'wall', (px, py) => backWallBounds(px, py));
  testPlane(0, 0, 1, ARENA_HALF_Y, 'wall', (px, py) => backWallBounds(px, py));

  // 45-degree corner chamfers
  const invSqrt2 = Math.SQRT1_2;
  const cornerDist = (ARENA_HALF_X + ARENA_HALF_Y - CORNER_CHAMFER) * invSqrt2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      testPlane(-sx * invSqrt2, 0, -sz * invSqrt2, cornerDist, 'wall', (px, py, pz) => {
        return py >= 0 && py <= ARENA_CEILING_Y && px * sx > 0 && pz * sz > 0;
      });
    }
  }

  // Goal back & side walls
  for (const sz of [-1, 1]) {
    testPlane(0, 0, -sz, ARENA_HALF_Y + GOAL_DEPTH, 'goal', (px, py) => {
      return py >= 0 && py <= GOAL_HEIGHT && Math.abs(px) <= GOAL_HALF_WIDTH;
    });
    testPlane(0, -1, 0, GOAL_HEIGHT, 'goal', (px, _py, pz) => {
      return (
        Math.abs(px) <= GOAL_HALF_WIDTH &&
        pz * sz >= ARENA_HALF_Y &&
        pz * sz <= ARENA_HALF_Y + GOAL_DEPTH
      );
    });
    testPlane(-1, 0, 0, GOAL_HALF_WIDTH, 'goal', (_px, py, pz) => {
      return (
        py >= 0 &&
        py <= GOAL_HEIGHT &&
        pz * sz >= ARENA_HALF_Y &&
        pz * sz <= ARENA_HALF_Y + GOAL_DEPTH
      );
    });
    testPlane(1, 0, 0, GOAL_HALF_WIDTH, 'goal', (_px, py, pz) => {
      return (
        py >= 0 &&
        py <= GOAL_HEIGHT &&
        pz * sz >= ARENA_HALF_Y &&
        pz * sz <= ARENA_HALF_Y + GOAL_DEPTH
      );
    });
  }

  if (extraMeshes && extraMeshes.length > 0) {
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction, 0.1, bestDist);
    const hits = raycaster.intersectObjects(extraMeshes as THREE.Object3D[], true);
    if (hits.length > 0 && hits[0].distance < bestDist) {
      bestDist = hits[0].distance;
      bestPoint.copy(hits[0].point);
      if (hits[0].face) {
        bestNormal
          .copy(hits[0].face.normal)
          .transformDirection(hits[0].object.matrixWorld)
          .normalize();
      }
      bestKind = 'goal';
    }
  }

  if (!Number.isFinite(bestDist)) return null;
  bestPoint.addScaledVector(bestNormal, SURFACE_OFFSET_UU);
  return { point: bestPoint, normal: bestNormal, distance: bestDist, surfaceKind: bestKind };
}
