/**
 * replayDirectorElevationPipeline.ts
 * Pure mathematical solvers for Goal Replay Director Camera:
 * 1. Multi-bounce vertical trajectory envelope & valley bridging (eliminates head-nodding on bouncing balls).
 * 2. Car-grounded action-plane adaptive camera elevation & non-upward-pitch enforcement
 *    (avoids hovering at ceiling height when cars are on the ground while staying strictly inside the arena).
 * 3. Balanced open-interior lateral side-bias resolution (frames off-center plays from the open stadium interior).
 */

export interface BounceBridgedBallTrajectory {
  /** Smooth bounce-bridged ball Z (no floor troughs). */
  gazeEnvelopeZ: Float64Array;
  /** Anticipatory upper envelope Z for camera eye elevation (prevents lag below fast rising balls). */
  eyeEnvelopeZ: Float64Array;
  /** Additional horizontal pullback (UU) during deep bounce valleys to keep bounce arc in VFOV. */
  bouncePullbackUu: Float64Array;
  /** Detected bounce trough frame indices. */
  bounceTroughIndices: number[];
}

export interface BalancedLateralBiasInput {
  goalIdx: number;
  lastScoreTouchFrame: number;
  holdTicks: number;
  wxAxis: number;
  wyAxis: number;
  sbx: Float64Array;
  sby: Float64Array;
  smScx: Float64Array;
  smScy: Float64Array;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

export function wrapAngleDeltaDeg(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Zero-phase forward-backward exponential smoothing filter on a 1D Float64Array.
 */
export function smooth1DZeroPhase(
  arr: ArrayLike<number> | null | undefined,
  alpha: number,
  passes: number = 2
): Float64Array {
  if (!arr || typeof arr.length !== 'number') return new Float64Array(0);
  const n = arr.length;
  if (n <= 1) return new Float64Array(arr);
  const cur = new Float64Array(arr);
  const nxt = new Float64Array(n);
  const a = clamp(alpha, 0.005, 0.99);
  for (let p = 0; p < passes; p++) {
    nxt[0] = cur[0];
    for (let i = 1; i < n; i++) {
      nxt[i] = nxt[i - 1] + (cur[i] - nxt[i - 1]) * a;
    }
    cur[n - 1] = nxt[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      cur[i] = cur[i + 1] + (nxt[i] - cur[i + 1]) * a;
    }
  }
  return cur;
}

/**
 * Zero-phase 3D camera trajectory smoother with symmetric velocity capping (`maxStepUu` per 120Hz tick)
 * and strict arena interior clamping. Guarantees calm, non-whipping camera motion without phase lag.
 */
export function smoothTrajectoryWithVelocityCap(
  rawX: Float64Array,
  rawY: Float64Array,
  rawZ: Float64Array,
  maxStepUu: number = 16.5,
  alpha: number = 0.13,
  passes: number = 2
): { eyeX: Float64Array; eyeY: Float64Array; eyeZ: Float64Array } {
  const n = rawX.length;
  if (n === 0) {
    return {
      eyeX: new Float64Array(0),
      eyeY: new Float64Array(0),
      eyeZ: new Float64Array(0),
    };
  }

  const sx = smooth1DZeroPhase(rawX, alpha, passes);
  const sy = smooth1DZeroPhase(rawY, alpha, passes);
  const sz = smooth1DZeroPhase(rawZ, alpha, passes);

  const fwdX = new Float64Array(n);
  const fwdY = new Float64Array(n);
  const fwdZ = new Float64Array(n);
  fwdX[0] = sx[0];
  fwdY[0] = sy[0];
  fwdZ[0] = sz[0];
  for (let i = 1; i < n; i++) {
    const dx = sx[i] - fwdX[i - 1];
    const dy = sy[i] - fwdY[i - 1];
    const dz = sz[i] - fwdZ[i - 1];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxStepUu && dist > 1e-6) {
      const s = maxStepUu / dist;
      fwdX[i] = fwdX[i - 1] + dx * s;
      fwdY[i] = fwdY[i - 1] + dy * s;
      fwdZ[i] = fwdZ[i - 1] + dz * s;
    } else {
      fwdX[i] = sx[i];
      fwdY[i] = sy[i];
      fwdZ[i] = sz[i];
    }
  }

  const bwdX = new Float64Array(n);
  const bwdY = new Float64Array(n);
  const bwdZ = new Float64Array(n);
  bwdX[n - 1] = sx[n - 1];
  bwdY[n - 1] = sy[n - 1];
  bwdZ[n - 1] = sz[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    const dx = sx[i] - bwdX[i + 1];
    const dy = sy[i] - bwdY[i + 1];
    const dz = sz[i] - bwdZ[i + 1];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxStepUu && dist > 1e-6) {
      const s = maxStepUu / dist;
      bwdX[i] = bwdX[i + 1] + dx * s;
      bwdY[i] = bwdY[i + 1] + dy * s;
      bwdZ[i] = bwdZ[i + 1] + dz * s;
    } else {
      bwdX[i] = sx[i];
      bwdY[i] = sy[i];
      bwdZ[i] = sz[i];
    }
  }

  const midX = new Float64Array(n);
  const midY = new Float64Array(n);
  const midZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    midX[i] = 0.5 * (fwdX[i] + bwdX[i]);
    midY[i] = 0.5 * (fwdY[i] + bwdY[i]);
    midZ[i] = 0.5 * (fwdZ[i] + bwdZ[i]);
  }

  const polX = smooth1DZeroPhase(midX, Math.min(0.16, alpha * 1.15), 2);
  const polY = smooth1DZeroPhase(midY, Math.min(0.16, alpha * 1.15), 2);
  const polZ = smooth1DZeroPhase(midZ, Math.min(0.16, alpha * 1.15), 2);

  const eyeX = new Float64Array(n);
  const eyeY = new Float64Array(n);
  const eyeZ = new Float64Array(n);
  const firstClamped = clampPositionInsideArena(polX[0], polY[0], polZ[0]);
  eyeX[0] = firstClamped.x;
  eyeY[0] = firstClamped.y;
  eyeZ[0] = firstClamped.z;

  for (let i = 1; i < n; i++) {
    const cl = clampPositionInsideArena(polX[i], polY[i], polZ[i]);
    const dx = cl.x - eyeX[i - 1];
    const dy = cl.y - eyeY[i - 1];
    const dz = cl.z - eyeZ[i - 1];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxStepUu && dist > 1e-6) {
      const s = maxStepUu / dist;
      const capped = clampPositionInsideArena(
        eyeX[i - 1] + dx * s,
        eyeY[i - 1] + dy * s,
        eyeZ[i - 1] + dz * s
      );
      eyeX[i] = capped.x;
      eyeY[i] = capped.y;
      eyeZ[i] = capped.z;
    } else {
      eyeX[i] = cl.x;
      eyeY[i] = cl.y;
      eyeZ[i] = cl.z;
    }
  }

  return { eyeX, eyeY, eyeZ };
}

/**
 * Computes Car-Grounded Action-Plane Director Camera elevation (Z in Unreal Units).
 * - When the active striker is on the ground (`carZ < 100 UU`), keeps the camera low (`~220-280 UU`)
 *   so ground plays have strong perspective and speed sensation while high balls are framed in the
 *   upper third of the screen via FOV.
 * - When the active striker climbs for an aerial (`carZ >= 100 UU`), smoothly lifts the camera
 *   alongside the striker (`carZ * 0.78 + ballZ * 0.14 + 75`).
 */
export function computeAdaptiveDirectorEyeHeight(
  activeCarZ: number,
  baseHeightUu: number = 218.0,
  aerialSlope: number = 0.78,
  ballZ: number = 0.0
): number {
  const effectiveBallZ = ballZ > 0 ? ballZ : activeCarZ;
  const aerialW = smoothstep(85.0, 360.0, activeCarZ);
  const ceilingBallLift = Math.max(0.0, effectiveBallZ - 1050.0) * 0.24;
  const groundZ = Math.max(195.0, baseHeightUu) + effectiveBallZ * 0.035 + ceilingBallLift;
  const slope = clamp(aerialSlope, 0.45, 0.92);
  const aerialZ = 75.0 + activeCarZ * slope + effectiveBallZ * 0.14;
  const desiredZ = groundZ * (1.0 - aerialW) + aerialZ * aerialW;
  return clamp(desiredZ, 195.0, 1240.0);
}

/**
 * Clamps a 3D point in Unreal coordinates (X right, Y forward, Z up) strictly inside
 * the octagonal RocketSim stadium interior, including top-wall ceiling bevel insets and
 * goal-mouth / goalpost backboard clearance so the camera never clips through goalposts.
 */
export function clampPositionInsideArena(
  rawX: number,
  rawY: number,
  rawZ: number
): { x: number; y: number; z: number } {
  const z = clamp(rawZ, 145.0, 1840.0);
  const roofBevelInset = Math.max(0.0, z - 1500.0) * 0.65;
  const maxX = 3720.0 - roofBevelInset;
  let x = clamp(rawX, -maxX, maxX);

  // Enforce smooth backboard/goalpost clearance (|X| <= 1150 near goalposts at |X|=893, |Y|=5120)
  const goalPostCorridorW = 1.0 - smoothstep(920.0, 1480.0, Math.abs(x));
  const maxY = (4780.0 - goalPostCorridorW * 120.0) - roofBevelInset;
  let y = clamp(rawY, -maxY, maxY);

  // Enforce 45-degree stadium corner chamfers (|X| + |Y| <= 7450 - roofBevelInset)
  const maxManhattan = 7450.0 - roofBevelInset * 1.2;
  const manhattan = Math.abs(x) + Math.abs(y);
  if (manhattan > maxManhattan) {
    const scale = maxManhattan / manhattan;
    x *= scale;
    y *= scale;
  }

  return { x, y, z };
}

/**
 * Enforces non-upward pitch on a 3D look vector `(dx, dy, dz)` so the camera never tilts
 * upward (`pitch > 0°`). When the ball is at the ceiling above the clamped eye height,
 * the sightline levels out horizontally (`dz <= 0`).
 */
export function clampNonUpwardDirectorRay(
  dx: number,
  dy: number,
  dz: number,
  maxUpwardSlope: number = 0.0
): [number, number, number] {
  const horiz = Math.hypot(dx, dy) || 1e-4;
  const maxDz = horiz * maxUpwardSlope;
  const clampedDz = Math.min(dz, maxDz);
  const norm = Math.hypot(dx, dy, clampedDz) || 1.0;
  return [dx / norm, dy / norm, clampedDz / norm];
}

/**
 * Builds a locally smoothed vertical ball trajectory envelope across `[0 .. N-1]`.
 * Bridges short floor-rebound troughs locally without inflating global pre-bounce heights.
 */
export function computeBounceBridgedBallTrajectory(
  bzArr: Float64Array,
  bvzArr: Float64Array,
  goalIdx: number
): BounceBridgedBallTrajectory {
  const n = bzArr.length;
  if (n === 0) {
    return {
      gazeEnvelopeZ: new Float64Array(0),
      eyeEnvelopeZ: new Float64Array(0),
      bouncePullbackUu: new Float64Array(0),
      bounceTroughIndices: [],
    };
  }

  const sbz = smooth1DZeroPhase(bzArr, 0.16, 2);
  const limit = Math.min(n - 1, Math.max(0, goalIdx));

  const bounceTroughIndices: number[] = [];
  for (let i = 2; i <= limit; i++) {
    const prevZ = bzArr[i - 1];
    const currZ = bzArr[i];
    const nextZ = bzArr[Math.min(n - 1, i + 1)];
    const isLocalMin = currZ <= prevZ && currZ <= nextZ;
    if (!isLocalMin) continue;

    const vzBefore =
      bvzArr[Math.max(0, i - 1)] ||
      (currZ - bzArr[Math.max(0, i - 2)]) * 60.0;
    const vzAfter =
      bvzArr[Math.min(n - 1, i + 1)] ||
      (bzArr[Math.min(n - 1, i + 2)] - currZ) * 60.0;
    const dvz = vzAfter - vzBefore;

    const isImpulseBounce = currZ < 320.0 && dvz > 95.0 && vzBefore < -55.0;
    if (isImpulseBounce) {
      if (
        bounceTroughIndices.length === 0 ||
        i - bounceTroughIndices[bounceTroughIndices.length - 1] > 14
      ) {
        bounceTroughIndices.push(i);
      }
    }
  }

  // Local trough softening (±24 ticks around floor impulse bounce) without global peak bridging
  const bridged = new Float64Array(sbz);
  const bouncePullbackUu = new Float64Array(n);
  for (let tIdx = 0; tIdx < bounceTroughIndices.length; tIdx++) {
    const b = bounceTroughIndices[tIdx];
    const left = Math.max(0, b - 24);
    const right = Math.min(limit, b + 24);
    const zLeft = sbz[left];
    const zRight = sbz[right];
    const span = Math.max(1, right - left);
    for (let i = left; i <= right; i++) {
      const u = (i - left) / span;
      const chordZ = zLeft + (zRight - zLeft) * u;
      const w = Math.sin(u * Math.PI) * 0.45;
      const softZ = sbz[i] * (1.0 - w) + chordZ * w;
      if (softZ > bridged[i]) {
        bridged[i] = softZ;
        bouncePullbackUu[i] = Math.min(140.0, (softZ - sbz[i]) * 0.25);
      }
    }
  }

  const gazeEnvelopeZ = smooth1DZeroPhase(bridged, 0.14, 2);
  const eyeEnvelopeZ = new Float64Array(gazeEnvelopeZ);

  return {
    gazeEnvelopeZ,
    eyeEnvelopeZ,
    bouncePullbackUu: smooth1DZeroPhase(bouncePullbackUu, 0.10, 2),
    bounceTroughIndices,
  };
}

/**
 * Resolves lateral side bias (+1 or -1 along W = (-uy, ux)).
 * Whenever play is off-center (|meanBallX| > 420 UU), strongly prefers the open stadium interior
 * side (-sign(meanBallX) * wxAxis) so the camera looks from the midfield interior across the
 * ball/car toward the goal mouth rather than getting pinned against the near side wall.
 */
export function resolveBalancedLateralBias({
  goalIdx,
  lastScoreTouchFrame,
  holdTicks,
  wxAxis,
  wyAxis,
  sbx,
  sby,
  smScx,
  smScy,
}: BalancedLateralBiasInput): number {
  const touchEnd = Math.min(goalIdx, Math.max(0, lastScoreTouchFrame + holdTicks));
  let sumWeight = 0;
  let sumBallX = 0;
  let sumCarRelV = 0;

  for (let i = 0; i <= goalIdx; i++) {
    const w = i <= touchEnd ? 4.0 : 1.0;
    sumWeight += w;
    sumBallX += sbx[i] * w;

    if (i <= touchEnd) {
      const bv = sbx[i] * wxAxis + sby[i] * wyAxis;
      const sv = smScx[i] * wxAxis + smScy[i] * wyAxis;
      sumCarRelV += (sv - bv) * w;
    }
  }

  const meanBallX = sumWeight > 0 ? sumBallX / sumWeight : 0;
  const interiorBiasV = -meanBallX * wxAxis;
  const offCenterW = smoothstep(320.0, 950.0, Math.abs(meanBallX));
  const carApproachV = sumWeight > 0 ? sumCarRelV / sumWeight : 0;

  const combinedV =
    interiorBiasV * (0.35 + 0.65 * offCenterW) + carApproachV * 0.25 * (1.0 - offCenterW);

  if (Math.abs(combinedV) > 1e-3) {
    return combinedV >= 0 ? 1.0 : -1.0;
  }
  const openCarV = ((smScx[0] ?? 0) - (sbx[0] ?? 0)) * wxAxis + ((smScy[0] ?? 0) - (sby[0] ?? 0)) * wyAxis;
  return openCarV >= 0 ? 1.0 : -1.0;
}
