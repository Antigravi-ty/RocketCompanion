import * as THREE from 'three';

export interface ArenaSurfaceHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

const ARENA_HALF_X = 4096;
const ARENA_HALF_Z = 5120;
const ARENA_HEIGHT = 2044;
const CORNER_PLANE_SUM = 8064;
const GOAL_HALF_WIDTH = 893;
const GOAL_HEIGHT = 642.775;
const GOAL_BACK_Z = 6000;

interface PlaneSpec {
  normalX: number;
  normalY: number;
  normalZ: number;
  constant: number;
  inBounds: (x: number, y: number, z: number) => boolean;
}

function isInsideCornerBound(x: number, z: number): boolean {
  return Math.abs(x) + Math.abs(z) <= CORNER_PLANE_SUM + 1;
}

function isInGoalMouth(x: number, y: number): boolean {
  return Math.abs(x) <= GOAL_HALF_WIDTH && y >= 0 && y <= GOAL_HEIGHT;
}

const ARENA_PLANES: readonly PlaneSpec[] = [
  // Floor (y = 0, normal +Y)
  {
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    constant: 0,
    inBounds: (x, _y, z) =>
      (Math.abs(x) <= ARENA_HALF_X && Math.abs(z) <= ARENA_HALF_Z && isInsideCornerBound(x, z)) ||
      (Math.abs(x) <= GOAL_HALF_WIDTH && Math.abs(z) >= ARENA_HALF_Z && Math.abs(z) <= GOAL_BACK_Z),
  },
  // Ceiling (y = ARENA_HEIGHT, normal -Y)
  {
    normalX: 0,
    normalY: -1,
    normalZ: 0,
    constant: ARENA_HEIGHT,
    inBounds: (x, _y, z) =>
      Math.abs(x) <= ARENA_HALF_X && Math.abs(z) <= ARENA_HALF_Z && isInsideCornerBound(x, z),
  },
  // Left/Right Side Walls (x = +-ARENA_HALF_X)
  {
    normalX: 1,
    normalY: 0,
    normalZ: 0,
    constant: ARENA_HALF_X,
    inBounds: (_x, y, z) =>
      y >= 0 &&
      y <= ARENA_HEIGHT &&
      Math.abs(z) <= ARENA_HALF_Z &&
      isInsideCornerBound(-ARENA_HALF_X, z),
  },
  {
    normalX: -1,
    normalY: 0,
    normalZ: 0,
    constant: ARENA_HALF_X,
    inBounds: (_x, y, z) =>
      y >= 0 &&
      y <= ARENA_HEIGHT &&
      Math.abs(z) <= ARENA_HALF_Z &&
      isInsideCornerBound(ARENA_HALF_X, z),
  },
  // End Walls (z = +-ARENA_HALF_Z, excluding goal openings)
  {
    normalX: 0,
    normalY: 0,
    normalZ: 1,
    constant: ARENA_HALF_Z,
    inBounds: (x, y, _z) =>
      y >= 0 &&
      y <= ARENA_HEIGHT &&
      Math.abs(x) <= ARENA_HALF_X &&
      isInsideCornerBound(x, -ARENA_HALF_Z) &&
      !isInGoalMouth(x, y),
  },
  {
    normalX: 0,
    normalY: 0,
    normalZ: -1,
    constant: ARENA_HALF_Z,
    inBounds: (x, y, _z) =>
      y >= 0 &&
      y <= ARENA_HEIGHT &&
      Math.abs(x) <= ARENA_HALF_X &&
      isInsideCornerBound(x, ARENA_HALF_Z) &&
      !isInGoalMouth(x, y),
  },
  // 4 Corner Bevel Walls (|x| + |z| = CORNER_PLANE_SUM)
  ...(
    [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const
  ).map(([sx, sz]): PlaneSpec => {
    const invSqrt2 = Math.SQRT1_2;
    return {
      normalX: -sx * invSqrt2,
      normalY: 0,
      normalZ: -sz * invSqrt2,
      constant: CORNER_PLANE_SUM * invSqrt2,
      inBounds: (x, y, z) =>
        y >= 0 &&
        y <= ARENA_HEIGHT &&
        x * sx >= 0 &&
        z * sz >= 0 &&
        Math.abs(x) <= ARENA_HALF_X + 1 &&
        Math.abs(z) <= ARENA_HALF_Z + 1,
    };
  }),
  // Goal Back Walls (z = +-GOAL_BACK_Z)
  {
    normalX: 0,
    normalY: 0,
    normalZ: 1,
    constant: GOAL_BACK_Z,
    inBounds: (x, y, _z) => isInGoalMouth(x, y),
  },
  {
    normalX: 0,
    normalY: 0,
    normalZ: -1,
    constant: GOAL_BACK_Z,
    inBounds: (x, y, _z) => isInGoalMouth(x, y),
  },
  // Goal Side Walls (x = +-GOAL_HALF_WIDTH, |z| in [ARENA_HALF_Z, GOAL_BACK_Z])
  {
    normalX: 1,
    normalY: 0,
    normalZ: 0,
    constant: GOAL_HALF_WIDTH,
    inBounds: (_x, y, z) =>
      y >= 0 && y <= GOAL_HEIGHT && Math.abs(z) >= ARENA_HALF_Z && Math.abs(z) <= GOAL_BACK_Z,
  },
  {
    normalX: -1,
    normalY: 0,
    normalZ: 0,
    constant: GOAL_HALF_WIDTH,
    inBounds: (_x, y, z) =>
      y >= 0 && y <= GOAL_HEIGHT && Math.abs(z) >= ARENA_HALF_Z && Math.abs(z) <= GOAL_BACK_Z,
  },
  // Goal Ceiling (y = GOAL_HEIGHT, |z| in [ARENA_HALF_Z, GOAL_BACK_Z])
  {
    normalX: 0,
    normalY: -1,
    normalZ: 0,
    constant: GOAL_HEIGHT,
    inBounds: (x, _y, z) =>
      Math.abs(x) <= GOAL_HALF_WIDTH && Math.abs(z) >= ARENA_HALF_Z && Math.abs(z) <= GOAL_BACK_Z,
  },
];

const scratchRaycaster = new THREE.Raycaster();
const scratchNdc = new THREE.Vector2();

export function raycastArenaSurface(ray: THREE.Ray, maxDist = 40000): ArenaSurfaceHit | null {
  let bestDist = maxDist;
  let bestHit: ArenaSurfaceHit | null = null;

  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;

  for (let i = 0; i < ARENA_PLANES.length; i++) {
    const plane = ARENA_PLANES[i];
    const denom = plane.normalX * dx + plane.normalY * dy + plane.normalZ * dz;
    if (denom >= -1e-5) continue;

    const numer = -(plane.normalX * ox + plane.normalY * oy + plane.normalZ * oz + plane.constant);
    const t = numer / denom;
    if (t < 1 || t >= bestDist) continue;

    const hx = ox + dx * t;
    const hy = oy + dy * t;
    const hz = oz + dz * t;
    if (!plane.inBounds(hx, hy, hz)) continue;

    bestDist = t;
    bestHit = {
      point: new THREE.Vector3(hx, hy, hz),
      normal: new THREE.Vector3(plane.normalX, plane.normalY, plane.normalZ),
      distance: t,
    };
  }

  return bestHit;
}

export function raycastScreenToArena(
  ndcX: number,
  ndcY: number,
  camera: THREE.Camera,
  extraTargets?: THREE.Object3D[]
): ArenaSurfaceHit | null {
  scratchNdc.set(ndcX, ndcY);
  scratchRaycaster.setFromCamera(scratchNdc, camera);

  if (extraTargets && extraTargets.length > 0) {
    const hits = scratchRaycaster.intersectObjects(extraTargets, true);
    if (hits.length > 0) {
      const first = hits[0];
      const worldNormal = first.face
        ? first.face.normal.clone().transformDirection(first.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);
      return {
        point: first.point.clone(),
        normal: worldNormal,
        distance: first.distance,
      };
    }
  }

  return raycastArenaSurface(scratchRaycaster.ray);
}
