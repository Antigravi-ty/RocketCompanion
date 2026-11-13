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
const scratchWorldNormal = new THREE.Vector3();

function isObjectChainVisible(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

function isInsideArenaRayBounds(p: THREE.Vector3): boolean {
  return (
    Math.abs(p.x) <= ARENA_HALF_X + 260 &&
    Math.abs(p.z) <= GOAL_BACK_Z + 260 &&
    p.y >= -60 &&
    p.y <= ARENA_HEIGHT + 260
  );
}

function isCameraOutsideArena(camPos: THREE.Vector3): boolean {
  return (
    Math.abs(camPos.x) > ARENA_HALF_X + 20 ||
    Math.abs(camPos.z) > ARENA_HALF_Z + 20 ||
    camPos.y > ARENA_HEIGHT + 20 ||
    camPos.y < -10 ||
    Math.abs(camPos.x) + Math.abs(camPos.z) > CORNER_PLANE_SUM + 20
  );
}

function resolveHitNormal(hit: THREE.Intersection, rayDir: THREE.Vector3): THREE.Vector3 {
  if (hit.face) {
    scratchWorldNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
    if (scratchWorldNormal.dot(rayDir) > 0) {
      scratchWorldNormal.negate();
    }
    return scratchWorldNormal.clone();
  }
  return rayDir.clone().negate().normalize();
}

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

export interface ArenaRaycastTargets {
  dynamicTargets?: THREE.Object3D[];
  stadiumTargets?: THREE.Object3D[];
}

export function raycastScreenToArena(
  ndcX: number,
  ndcY: number,
  camera: THREE.Camera,
  targets?: THREE.Object3D[] | ArenaRaycastTargets
): ArenaSurfaceHit | null {
  scratchNdc.set(ndcX, ndcY);
  scratchRaycaster.setFromCamera(scratchNdc, camera);

  const dynamicTargets = Array.isArray(targets) ? targets : targets?.dynamicTargets;
  const stadiumTargets = Array.isArray(targets) ? undefined : targets?.stadiumTargets;

  let bestDynamic: ArenaSurfaceHit | null = null;
  if (dynamicTargets && dynamicTargets.length > 0) {
    const hits = scratchRaycaster.intersectObjects(dynamicTargets, true);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!isObjectChainVisible(h.object)) continue;
      bestDynamic = {
        point: h.point.clone(),
        normal: resolveHitNormal(h, scratchRaycaster.ray.direction),
        distance: h.distance,
      };
      break;
    }
  }

  let bestStadium: ArenaSurfaceHit | null = null;
  if (stadiumTargets && stadiumTargets.length > 0) {
    const camOutside = isCameraOutsideArena(scratchRaycaster.ray.origin);
    const hits = scratchRaycaster.intersectObjects(stadiumTargets, true);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!isObjectChainVisible(h.object)) continue;
      if (!isInsideArenaRayBounds(h.point)) continue;
      if (camOutside && h.face) {
        scratchWorldNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        // When camera is outside the arena, skip near-side exterior walls facing toward camera
        const outwardFromCenter =
          h.point.x * scratchWorldNormal.x +
          (h.point.y - ARENA_HEIGHT * 0.5) * scratchWorldNormal.y +
          h.point.z * scratchWorldNormal.z;
        if (outwardFromCenter > 0 && scratchWorldNormal.dot(scratchRaycaster.ray.direction) < 0) {
          continue;
        }
      }
      bestStadium = {
        point: h.point.clone(),
        normal: resolveHitNormal(h, scratchRaycaster.ray.direction),
        distance: h.distance,
      };
      break;
    }
  }

  const analyticalHit = raycastArenaSurface(scratchRaycaster.ray);

  let best: ArenaSurfaceHit | null = bestDynamic;
  if (bestStadium && (!best || bestStadium.distance < best.distance)) {
    best = bestStadium;
  }
  if (!best) {
    best = analyticalHit;
  } else if (analyticalHit && analyticalHit.distance + 120 < best.distance) {
    best = analyticalHit;
  }

  return best;
}
