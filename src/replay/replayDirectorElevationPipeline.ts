/**
 * replayDirectorElevationPipeline.ts
 * Pure mathematical solvers for Goal Replay Director Camera:
 * 1. Multi-bounce vertical trajectory envelope & valley bridging (eliminates head-nodding on bouncing balls).
 * 2. Overhead adaptive camera elevation & non-upward-pitch enforcement (avoids looking up while
 *    staying strictly inside the stadium ceiling mesh).
 * 3. Balanced lateral side-bias resolution (prevents left-side bias and frames side-approaching cars).
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
 * Computes overhead-biased adaptive Director Camera elevation (Z in Unreal Units).
 * Keeps the camera slightly above the active ball/play height (`activeZ + overheadMargin`)
 * so the camera looks slightly downward rather than upward, tapering smoothly
 * to level (`pitch ≈ 0°`) only when the ball approaches the stadium ceiling (2044 UU).
 */
export function computeAdaptiveDirectorEyeHeight(
  activeZ: number,
  baseHeightUu: number = 195.0,
  aerialSlope: number = 0.36,
  latSpread: number = 0.0
): number {
  const baseOffset = clamp(baseHeightUu - 93.0, 72.0, 360.0);
  const slopeFactor = clamp(aerialSlope / 0.36, 0.4, 2.2);
  const aerialLift = smoothstep(93.0, 620.0, activeZ) * 42.0 * slopeFactor;
  const ceilingTaper = 1.0 - 0.78 * smoothstep(1360.0, 1840.0, activeZ);
  const overheadMargin = (baseOffset + aerialLift) * ceilingTaper + latSpread * 0.012;
  const desiredZ = Math.max(baseHeightUu, activeZ + overheadMargin);
  return clamp(desiredZ, 160.0, 1840.0);
}

/**
 * Clamps a 3D point in Unreal coordinates (X right, Y forward, Z up) strictly inside
 * the octagonal RocketSim stadium interior, including top-wall ceiling bevel insets,
 * so the Director Camera never exits the arena or gets occluded by the hexagonal mesh.
 */
export function clampPositionInsideArena(
  rawX: number,
  rawY: number,
  rawZ: number
): { x: number; y: number; z: number } {
  const z = clamp(rawZ, 145.0, 1840.0);
  // Inset horizontal bounds near the curved wall-to-ceiling bevel when Z > 1500 UU
  const roofBevelInset = Math.max(0.0, z - 1500.0) * 0.65;
  const maxX = 3720.0 - roofBevelInset;
  const maxY = 4780.0 - roofBevelInset;
  let x = clamp(rawX, -maxX, maxX);
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
 * Builds a bounce-bridged vertical trajectory envelope across `[0 .. N-1]`.
 * Eliminates V-shaped bounce troughs and multi-bounce pitch oscillation by bridging
 * across floor and surface rebounds with a monotone-preserving ramp.
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

  // 1. Detect vertical bounce troughs (floor/ramp impulse bounces and local rebound valleys)
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

    const isImpulseBounce = currZ < 420.0 && dvz > 85.0 && vzBefore < -45.0;
    if (isImpulseBounce) {
      if (
        bounceTroughIndices.length === 0 ||
        i - bounceTroughIndices[bounceTroughIndices.length - 1] > 14
      ) {
        bounceTroughIndices.push(i);
      }
    }
  }

  // 2. Bridge each bounce valley [pLeft, pRight] with a monotone-preserving ramp
  const bridged = new Float64Array(sbz);
  let earliestPeakIdx = limit;
  let latestPeakIdx = 0;

  for (let tIdx = 0; tIdx < bounceTroughIndices.length; tIdx++) {
    const b = bounceTroughIndices[tIdx];
    const searchStart = tIdx > 0 ? bounceTroughIndices[tIdx - 1] : 0;
    const searchEnd =
      tIdx + 1 < bounceTroughIndices.length
        ? bounceTroughIndices[tIdx + 1]
        : Math.min(n - 1, limit + 30);

    let pLeft = b;
    let maxLeftZ = sbz[b];
    for (let i = b - 1; i >= searchStart; i--) {
      if (sbz[i] >= maxLeftZ) {
        maxLeftZ = sbz[i];
        pLeft = i;
      } else if (maxLeftZ - sbz[i] > 40.0 && sbz[i] < 180.0) {
        break;
      }
    }

    let pRight = b;
    let maxRightZ = sbz[b];
    for (let i = b + 1; i <= searchEnd; i++) {
      if (sbz[i] >= maxRightZ) {
        maxRightZ = sbz[i];
        pRight = i;
      } else if (maxRightZ - sbz[i] > 40.0 && sbz[i] < 180.0) {
        break;
      }
    }

    if (pRight > pLeft && (maxLeftZ > sbz[b] + 25.0 || maxRightZ > sbz[b] + 25.0)) {
      if (pLeft < earliestPeakIdx) earliestPeakIdx = pLeft;
      if (pRight > latestPeakIdx) latestPeakIdx = pRight;
      const z0 = sbz[pLeft];
      const z1 = sbz[pRight];
      const zLow = Math.min(z0, z1);
      const zHigh = Math.max(z0, z1);
      const rampStart = z0 >= z1 ? zLow + 0.55 * (zHigh - zLow) : zLow;
      const rampEnd = z0 >= z1 ? zLow : zLow + 0.55 * (zHigh - zLow);
      const span = pRight - pLeft;
      for (let i = pLeft; i <= pRight; i++) {
        const u = (i - pLeft) / span;
        const rampZ = rampStart + (rampEnd - rampStart) * u;
        if (rampZ > bridged[i]) {
          bridged[i] = rampZ;
        }
      }
    }
  }

  // Enforce monotone non-increasing envelope between consecutive descending bounce peaks
  if (bounceTroughIndices.length > 0 && latestPeakIdx > earliestPeakIdx) {
    const startDesc = earliestPeakIdx;
    const endDesc = Math.min(limit, Math.max(latestPeakIdx, bounceTroughIndices[bounceTroughIndices.length - 1]));
    if (bridged[startDesc] > bridged[endDesc]) {
      for (let i = startDesc + 1; i <= endDesc; i++) {
        if (bridged[i] > bridged[i - 1]) {
          bridged[i] = bridged[i - 1];
        }
      }
    }
  }

  // Smooth the bridged curve across the post-apex bounce region while preserving the main apex
  const heavySmoothBridged = smooth1DZeroPhase(bridged, 0.042, 5);
  const smoothBridged = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (bounceTroughIndices.length === 0) {
      smoothBridged[i] = sbz[i];
    } else {
      const wBounce = smoothstep(earliestPeakIdx - 12, earliestPeakIdx + 72, i);
      smoothBridged[i] = sbz[i] * (1.0 - wBounce) + heavySmoothBridged[i] * wBounce;
    }
  }

  // 3. Gaze envelope: follows smoothBridged across the bounce sequence
  const gazeEnvelopeZ = new Float64Array(n);
  const bouncePullbackUu = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const valleyDepth = Math.max(0.0, smoothBridged[i] - sbz[i]);
    gazeEnvelopeZ[i] = smoothBridged[i];
    bouncePullbackUu[i] = Math.min(260.0, valleyDepth * 0.32);
  }

  // 4. Eye envelope: anticipates fast upward ball pops over a short 10-tick (0.08s) lookahead window
  // on pre-bounce climbs while staying strictly phase-locked with gazeEnvelopeZ across bounce descents.
  const rawEyeEnvZ = new Float64Array(n);
  const lookaheadTicks = 10;
  for (let i = 0; i < n; i++) {
    let maxAheadZ = gazeEnvelopeZ[i];
    const maxJ = Math.min(limit, i + lookaheadTicks);
    for (let j = i + 1; j <= maxJ; j++) {
      const w = 1.0 - (j - i) / (lookaheadTicks + 1);
      const candZ = gazeEnvelopeZ[i] + (gazeEnvelopeZ[j] - gazeEnvelopeZ[i]) * w;
      if (candZ > maxAheadZ) {
        maxAheadZ = candZ;
      }
    }
    rawEyeEnvZ[i] = maxAheadZ;
  }
  const eyeEnvelopeZ = new Float64Array(rawEyeEnvZ);

  return {
    gazeEnvelopeZ,
    eyeEnvelopeZ,
    bouncePullbackUu: smooth1DZeroPhase(bouncePullbackUu, 0.08, 2),
    bounceTroughIndices,
  };
}

/**
 * Resolves lateral side bias (+1 or -1 along W = (-uy, ux)) without any asymmetric left bias.
 * - Near side walls (|touchWeightedBallX| > 1050 UU), biases toward the open stadium interior (X = 0).
 * - In the central corridor (|touchWeightedBallX| <= 1050 UU), aligns with the scoring car's lateral
 *   approach side relative to the ball so side-approaching touches are framed from behind the car.
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
    // Weight the active touch phase 4.5x stronger than post-shot coasting
    const w = i <= touchEnd ? 4.5 : 0.6;
    sumWeight += w;
    sumBallX += sbx[i] * w;

    if (i <= touchEnd) {
      const bv = sbx[i] * wxAxis + sby[i] * wyAxis;
      const sv = smScx[i] * wxAxis + smScy[i] * wyAxis;
      // Weight opening approach frames even higher so right-side/left-side starts are always framed from behind the car
      const approachBoost = i <= Math.max(12, Math.floor(touchEnd * 0.65)) ? 1.8 : 1.0;
      sumCarRelV += (sv - bv) * w * approachBoost;
    }
  }

  const meanBallX = sumWeight > 0 ? sumBallX / sumWeight : 0;
  const interiorBiasV = -meanBallX * wxAxis;
  const wallProximity = smoothstep(1800.0, 3100.0, Math.abs(meanBallX));
  const carApproachV = sumWeight > 0 ? (sumCarRelV / sumWeight) * 1.6 : 0;

  // Favor the car's approach side in the main field so right-side touches are observed from the right,
  // and transition to stadium-interior side only when play is close to the side wall.
  const combinedV =
    interiorBiasV * wallProximity + carApproachV * (1.0 - wallProximity * 0.9);

  if (Math.abs(combinedV) > 1e-3) {
    return combinedV >= 0 ? 1.0 : -1.0;
  }
  const openCarV = ((smScx[0] ?? 0) - (sbx[0] ?? 0)) * wxAxis + ((smScy[0] ?? 0) - (sby[0] ?? 0)) * wyAxis;
  return openCarV >= 0 ? 1.0 : -1.0;
}
