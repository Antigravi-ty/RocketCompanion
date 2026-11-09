/**
 * RLRCVehicleLoadoutCatalog.ts
 * Resolves external .replay vehicle body product IDs and resting rigid-body
 * suspension kinematics into canonical RocketCompanion hitbox and visual presets.
 */

import type {
  RLRCHitboxId,
  RLRCQuat,
  RLRCRigidBodySample,
  RLRCVehicleLoadoutResolution,
  RLRCVisualId,
} from '../RLRCReplayTypes.ts';

export interface RLRCVehicleCatalogEntry {
  readonly bodyProductId: number;
  readonly name: string;
  readonly hitboxId: RLRCHitboxId;
  readonly visualId: RLRCVisualId;
}

export interface RLRCRestingKinematicsStats {
  readonly sampleCount: number;
  readonly medianRestZ: number;
  readonly medianSignedForwardZ: number;
}

export interface RLRCRestingSampleInput {
  readonly z: number;
  readonly signedForwardZ?: number;
  readonly rotation?: RLRCQuat;
}

const DEFAULT_HITBOX_ID: RLRCHitboxId = 'hitbox-octane';
const DEFAULT_VISUAL_ID: RLRCVisualId = 'fennec';

const HITBOX_DEFAULT_VISUAL_MAP: Readonly<Record<RLRCHitboxId, RLRCVisualId>> = Object.freeze({
  'hitbox-octane': 'fennec',
  'hitbox-dominus': 'dominus',
  'hitbox-plank': 'sentinel',
  'hitbox-breakout': 'breakout-mini',
  'hitbox-hybrid': 'insidio',
  'hitbox-merc': 'merc',
  'hitbox-psyclops': 'trioctane-threewheel',
});

const BODY_PRODUCT_CATALOG_ENTRIES: readonly RLRCVehicleCatalogEntry[] = Object.freeze([
  // Octane hitbox -> Fennec visual (including Octane 23 and Fennec 4284)
  { bodyProductId: 23, name: 'Octane', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 4284, name: 'Fennec', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  {
    bodyProductId: 7948,
    name: 'Octane Preset Variant',
    hitboxId: 'hitbox-octane',
    visualId: 'fennec',
  },
  { bodyProductId: 24, name: 'Takumi', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 26, name: 'Road Hog', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 27, name: 'Gizmo', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 29, name: 'Backfire', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 402, name: 'Scarab', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 404, name: 'Zippy', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 597, name: 'Grog', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 1159, name: 'Marauder', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 1317, name: 'Takumi RX-T', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 1416, name: 'Road Hog XL', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 1475, name: 'Proteus', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 1603, name: 'Vulcan', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 1675, name: 'Bone Shaker', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 1691, name: 'Twinzer', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 3879, name: 'Mudcat GXT', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 4725, name: 'Harbinger GXT', hitboxId: 'hitbox-octane', visualId: 'fennec' },
  { bodyProductId: 5657, name: 'Dingo', hitboxId: 'hitbox-octane', visualId: 'fennec' },

  // Octane hitbox -> Ryza dedicated visual
  { bodyProductId: 12814, name: 'Ryza', hitboxId: 'hitbox-octane', visualId: 'ryza' },

  // Hybrid hitbox -> Insidio visual
  { bodyProductId: 3582, name: 'Insidio', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 5480, name: 'Insidio Edition', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 25, name: 'Venom', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 31, name: 'X-Devil', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 1171, name: 'Esper', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 1300, name: 'X-Devil Mk2', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 1623, name: 'Jager 619', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 2070, name: 'Skyline GT-R R34', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 2298, name: 'Endo', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 2852, name: 'Nimbus', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 4369, name: 'R3MX GXT', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },
  { bodyProductId: 5082, name: 'Tygris', hitboxId: 'hitbox-hybrid', visualId: 'insidio' },

  // Dominus hitbox -> Dominus visual (403 is Dominus, along with 1568 and 12262)
  { bodyProductId: 403, name: 'Dominus', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 1568, name: 'Dominus GT', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  {
    bodyProductId: 12262,
    name: 'Dominus Variant',
    hitboxId: 'hitbox-dominus',
    visualId: 'dominus',
  },
  { bodyProductId: 21, name: 'Hotshot', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 600, name: 'Ripper', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 1172, name: 'Aftershock', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 1173, name: 'Masamune', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 1796, name: 'Imperator DT5', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  {
    bodyProductId: 2069,
    name: 'Dodge Charger R/T',
    hitboxId: 'hitbox-dominus',
    visualId: 'dominus',
  },
  { bodyProductId: 2665, name: 'Maverick GXT', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 3624, name: 'Guardian GXT', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 4291, name: 'Ronin GXT', hitboxId: 'hitbox-dominus', visualId: 'dominus' },
  { bodyProductId: 4611, name: 'Peregrine TT', hitboxId: 'hitbox-dominus', visualId: 'dominus' },

  // Breakout hitbox -> Breakout-Mini visual
  { bodyProductId: 22, name: 'Breakout', hitboxId: 'hitbox-breakout', visualId: 'breakout-mini' },
  {
    bodyProductId: 1894,
    name: 'Breakout Type-S',
    hitboxId: 'hitbox-breakout',
    visualId: 'breakout-mini',
  },
  {
    bodyProductId: 12658,
    name: 'Breakout Variant',
    hitboxId: 'hitbox-breakout',
    visualId: 'breakout-mini',
  },
  {
    bodyProductId: 1478,
    name: 'Animus GP',
    hitboxId: 'hitbox-breakout',
    visualId: 'breakout-mini',
  },
  { bodyProductId: 2268, name: 'Samurai', hitboxId: 'hitbox-breakout', visualId: 'breakout-mini' },
  { bodyProductId: 3032, name: 'Cyclone', hitboxId: 'hitbox-breakout', visualId: 'breakout-mini' },
  { bodyProductId: 4014, name: 'Komodo', hitboxId: 'hitbox-breakout', visualId: 'breakout-mini' },

  // Plank hitbox -> Sentinel visual
  { bodyProductId: 4268, name: 'Sentinel', hitboxId: 'hitbox-plank', visualId: 'sentinel' },
  { bodyProductId: 803, name: 'Batmobile 2016', hitboxId: 'hitbox-plank', visualId: 'sentinel' },
  { bodyProductId: 28, name: 'Paladin', hitboxId: 'hitbox-plank', visualId: 'sentinel' },
  { bodyProductId: 1624, name: 'Mantis', hitboxId: 'hitbox-plank', visualId: 'sentinel' },
  { bodyProductId: 1711, name: 'Centio V17', hitboxId: 'hitbox-plank', visualId: 'sentinel' },
  { bodyProductId: 1932, name: 'Twin Mill III', hitboxId: 'hitbox-plank', visualId: 'sentinel' },
  { bodyProductId: 3250, name: 'Artemis GXT', hitboxId: 'hitbox-plank', visualId: 'sentinel' },

  // Merc hitbox -> Merc visual
  { bodyProductId: 30, name: 'Merc', hitboxId: 'hitbox-merc', visualId: 'merc' },
  { bodyProductId: 4880, name: 'Battle Bus', hitboxId: 'hitbox-merc', visualId: 'merc' },
]);

export const BODY_PRODUCT_ID_MAP: ReadonlyMap<number, RLRCVehicleCatalogEntry> = new Map(
  BODY_PRODUCT_CATALOG_ENTRIES.map((entry) => [entry.bodyProductId, entry])
);

/**
 * Computes the signed forward pitch Z component `f_z = 2 * (qx * qz - qw * qy)`
 * from a unit quaternion in RocketCompanion/UE3 vehicle coordinates.
 * Note: Merc has positive `f_z` (~ +0.00485), while other hitboxes tilt slightly nose-down (`f_z < 0`).
 */
export function computeSignedForwardZFromQuat(rotation: RLRCQuat): number {
  return 2 * (rotation.x * rotation.z - rotation.w * rotation.y);
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return (sorted.length & 1) === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/**
 * Extracts flat-ground resting suspension samples from a sequence of rigid-body states
 * and computes `(medianRestZ, medianSignedForwardZ)`.
 */
export function extractRestingKinematicsStats(
  samples: readonly (RLRCRigidBodySample | RLRCRestingSampleInput)[]
): RLRCRestingKinematicsStats | null {
  const zValues: number[] = [];
  const fzValues: number[] = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if ('position' in sample) {
      const z = sample.position.z;
      if (z < 15.5 || z > 20.5) continue;
      const vz = Math.abs(sample.linearVelocity.z);
      if (vz > 5.0) continue;
      const upZ =
        1 - 2 * (sample.rotation.x * sample.rotation.x + sample.rotation.y * sample.rotation.y);
      if (upZ < 0.98) continue;
      zValues.push(z);
      fzValues.push(computeSignedForwardZFromQuat(sample.rotation));
    } else {
      const z = sample.z;
      if (!Number.isFinite(z) || z < 15.5 || z > 20.5) continue;
      const fz =
        typeof sample.signedForwardZ === 'number'
          ? sample.signedForwardZ
          : sample.rotation
            ? computeSignedForwardZFromQuat(sample.rotation)
            : -0.00954;
      zValues.push(z);
      fzValues.push(fz);
    }
  }

  if (zValues.length === 0) {
    return null;
  }

  return {
    sampleCount: zValues.length,
    medianRestZ: computeMedian(zValues),
    medianSignedForwardZ: computeMedian(fzValues),
  };
}

/**
 * Classifies unknown DLC vehicle bodies into the 5 distinct resting suspension buckets
 * using flat-ground `(median_rest_Z, signed_fwd_z)` measurements:
 * - Merc: `signed_fwd_z > +0.002` (unique nose-up pitch ~ +0.00485, rest_Z ~ 18.79 uu)
 * - Plank: `median_rest_Z > 18.50` (rest_Z ~ 18.65 uu, signed_fwd_z ~ -0.00602)
 * - Breakout: `median_rest_Z > 18.00` (rest_Z ~ 18.34 uu, signed_fwd_z ~ -0.01701)
 * - Dominus: `|signed_fwd_z| > 0.013` (rest_Z ~ 17.01..17.06 uu, steep pitch ~ -0.01672)
 * - Octane: default standard bucket (rest_Z ~ 17.01 uu, mild pitch ~ -0.00954)
 */
export function classifyHitboxByRestingKinematics(
  samplesOrStats:
    | readonly (RLRCRigidBodySample | RLRCRestingSampleInput)[]
    | RLRCRestingKinematicsStats
    | null
    | undefined
): { readonly hitboxId: RLRCHitboxId; readonly visualId: RLRCVisualId } {
  const stats =
    samplesOrStats === null || samplesOrStats === undefined
      ? null
      : Array.isArray(samplesOrStats)
        ? extractRestingKinematicsStats(
            samplesOrStats as readonly (RLRCRigidBodySample | RLRCRestingSampleInput)[]
          )
        : (samplesOrStats as RLRCRestingKinematicsStats);

  if (!stats || stats.sampleCount <= 0) {
    return { hitboxId: DEFAULT_HITBOX_ID, visualId: DEFAULT_VISUAL_ID };
  }

  const { medianRestZ, medianSignedForwardZ } = stats;

  if (medianSignedForwardZ > 0.002) {
    return { hitboxId: 'hitbox-merc', visualId: HITBOX_DEFAULT_VISUAL_MAP['hitbox-merc'] };
  }
  if (medianRestZ > 18.5) {
    return { hitboxId: 'hitbox-plank', visualId: HITBOX_DEFAULT_VISUAL_MAP['hitbox-plank'] };
  }
  if (medianRestZ > 18.0) {
    return { hitboxId: 'hitbox-breakout', visualId: HITBOX_DEFAULT_VISUAL_MAP['hitbox-breakout'] };
  }
  if (Math.abs(medianSignedForwardZ) > 0.013) {
    return { hitboxId: 'hitbox-dominus', visualId: HITBOX_DEFAULT_VISUAL_MAP['hitbox-dominus'] };
  }
  return { hitboxId: 'hitbox-octane', visualId: HITBOX_DEFAULT_VISUAL_MAP['hitbox-octane'] };
}

/**
 * Resolves a `.replay` vehicle body Product ID and optional resting rigid-body samples
 * into a canonical `{ bodyProductId, hitboxId, visualId, resolvedBy }` descriptor.
 */
export function resolveRLRCVehicleLoadout(
  bodyProductId: number | null | undefined,
  restingSamplesOrStats?:
    readonly (RLRCRigidBodySample | RLRCRestingSampleInput)[] | RLRCRestingKinematicsStats | null,
  customVisualHint?: string | null
): RLRCVehicleLoadoutResolution {
  const safeProductId =
    typeof bodyProductId === 'number' && Number.isFinite(bodyProductId)
      ? Math.trunc(bodyProductId)
      : 0;

  if (typeof customVisualHint === 'string' && customVisualHint.trim().toLowerCase() === 'ryza') {
    return {
      bodyProductId: safeProductId,
      hitboxId: 'hitbox-octane',
      visualId: 'ryza',
      resolvedBy: 'catalog',
    };
  }

  const catalogHit = BODY_PRODUCT_ID_MAP.get(safeProductId);
  if (catalogHit) {
    return {
      bodyProductId: safeProductId,
      hitboxId: catalogHit.hitboxId,
      visualId: catalogHit.visualId,
      resolvedBy: 'catalog',
    };
  }

  if (restingSamplesOrStats) {
    const stats = Array.isArray(restingSamplesOrStats)
      ? extractRestingKinematicsStats(
          restingSamplesOrStats as readonly (RLRCRigidBodySample | RLRCRestingSampleInput)[]
        )
      : (restingSamplesOrStats as RLRCRestingKinematicsStats);

    if (stats && stats.sampleCount > 0) {
      const fallback = classifyHitboxByRestingKinematics(stats);
      return {
        bodyProductId: safeProductId,
        hitboxId: fallback.hitboxId,
        visualId: fallback.visualId,
        resolvedBy: 'kinematics-fallback',
      };
    }
  }

  return {
    bodyProductId: safeProductId,
    hitboxId: DEFAULT_HITBOX_ID,
    visualId: DEFAULT_VISUAL_ID,
    resolvedBy: 'default',
  };
}

export function getDefaultVisualForHitbox(hitboxId: RLRCHitboxId): RLRCVisualId {
  return HITBOX_DEFAULT_VISUAL_MAP[hitboxId] ?? DEFAULT_VISUAL_ID;
}
