/**
 * vehicleTunerConfig.js
 * Pure configuration data, descriptors, and runtime tuning state for vehicles, wheels, anodized paint, and boost particles.
 */

export const DEFAULT_TEAM_COLORS = [3111891, 13857839];
export const DEFAULT_PLAYER_TEAM_INDEX = 0;

export const VEHICLE_PAINT_FINISH_PRESETS = {
  matte: {
    mode: 'standard',
    metalness: 0.5,
    roughness: 0.85,
  },
  metallic: {
    mode: 'standard',
    metalness: 0.7,
    roughness: 0.45,
  },
};

export const GLOBAL_VEHICLE_SURFACE_MATERIALS = {
  body: {
    slotName: 'body',
    label: 'Body Shell (body)',
    mode: 'standard',
    color: '#bc8100',
    pearlColor: '#ff2a60',
    metalness: 0.5,
    roughness: 0.85,
    clearcoat: 1,
    clearcoatRoughness: 0.11,
    sheen: 0.7,
    envMapIntensity: 1,
    toonSteps: 4,
    toonShadowMin: 0.11,
    toonHighlightMax: 1,
    toonSmooth: false,
    glbDefaultMetalness: 0,
    glbDefaultRoughness: 0.5,
  },
  window: {
    slotName: 'window',
    label: 'Windshield & Glass (window)',
    mode: 'standard',
    color: '#727272',
    pearlColor: '#243044',
    metalness: 1,
    roughness: 0,
    clearcoat: 0.9,
    clearcoatRoughness: 0.1,
    sheen: 0.2,
    envMapIntensity: 1,
    toonSteps: 3,
    toonShadowMin: 0.08,
    toonHighlightMax: 0.85,
    toonSmooth: false,
    glbDefaultMetalness: 0,
    glbDefaultRoughness: 0.5,
  },
  border: {
    slotName: 'border',
    label: 'Trim & Chassis Skirt (border)',
    mode: 'standard',
    color: '#262626',
    pearlColor: '#282e38',
    metalness: 0,
    roughness: 0.7,
    clearcoat: 0,
    clearcoatRoughness: 0.3,
    sheen: 0.1,
    envMapIntensity: 0.9,
    toonSteps: 3,
    toonShadowMin: 0.1,
    toonHighlightMax: 0.8,
    toonSmooth: false,
    glbDefaultMetalness: 0,
    glbDefaultRoughness: 0.5,
  },
  metal: {
    slotName: 'metal',
    label: 'Rear Exhaust & Trim Metal (metal)',
    mode: 'standard',
    color: '#c9c9c9',
    pearlColor: '#6d788a',
    metalness: 1,
    roughness: 0.5,
    clearcoat: 0.3,
    clearcoatRoughness: 0.2,
    sheen: 0.1,
    envMapIntensity: 1,
    toonSteps: 4,
    toonShadowMin: 0.15,
    toonHighlightMax: 1,
    toonSmooth: false,
    glbDefaultMetalness: 0,
    glbDefaultRoughness: 0.5,
  },
};

export function applyVehiclePaintFinishPreset(finish) {
  const preset = VEHICLE_PAINT_FINISH_PRESETS[finish];
  if (preset && GLOBAL_VEHICLE_SURFACE_MATERIALS.body) {
    GLOBAL_VEHICLE_SURFACE_MATERIALS.body.mode = preset.mode;
    GLOBAL_VEHICLE_SURFACE_MATERIALS.body.metalness = preset.metalness;
    GLOBAL_VEHICLE_SURFACE_MATERIALS.body.roughness = preset.roughness;
  }
  return GLOBAL_VEHICLE_SURFACE_MATERIALS.body;
}

export function getActiveVehiclePaintFinishPreset() {
  const body = GLOBAL_VEHICLE_SURFACE_MATERIALS.body;
  if (
    body &&
    Math.abs((body.metalness ?? 0.5) - VEHICLE_PAINT_FINISH_PRESETS.metallic.metalness) < 0.05 &&
    Math.abs((body.roughness ?? 0.85) - VEHICLE_PAINT_FINISH_PRESETS.metallic.roughness) < 0.05
  ) {
    return 'metallic';
  }
  return 'matte';
}

export const GLOBAL_VEHICLE_LAMPS_CONFIG = {
  frontColor: '#ffefd5',
  frontIntensity: 1,
  frontToneMapped: false,
  tailIdleColor: '#5c0a0a',
  tailIdleIntensity: 0.85,
  brakeColor: '#ff2200',
  brakeIntensity: 1,
  brakeMinSpeed: 30,
  brakeDecelEpsilon: 0.25,
  tailToneMapped: false,
};

export const FENNEC_DESCRIPTOR = {
  id: 'fennec',
  name: 'Fennec',
  hitboxPreset: 'hitbox-octane',
  modelUrl: '/assets/vehicles/Fennec.glb',
  rawBounds: {
    min: [-62.3896, -13.8302, -35.7124],
    max: [78.0319, 33.4147, 35.7124],
    length: 140.4215,
    height: 47.2449,
    width: 71.4248,
    center: [7.8212, 9.7923, 0],
    roofTopY: 33.4147,
    rlHitboxTopY: 38.8346,
  },
  alignment: {
    scale: 1.0,
    scaleX: 1.0,
    scaleY: 1.0,
    scaleZ: 1.0,
    centerOffset: [-0.1, 1.6, 0],
  },
  wheelNames: [
    'wheel-front-right',
    'wheel-front-left',
    'wheel-rear-right',
    'wheel-rear-left',
  ],
  wheelAnchors: [
    [48.55, 26.9291, 12.5],
    [48.55, -26.9291, 12.5],
    [-36.68, 28.6221, 15.0],
    [-36.68, -28.6221, 15.0],
  ],
  suspensionHeights: [-4.5, -4.5, -2.0, -2.0],
  boostOutlets: [
    [-57.97, 10.57, 19.62],
    [-57.97, 10.57, -19.62],
  ],
  boostNozzleParams: {
    x: -57.87,
    y: 8.97,
    z: 19.62,
    followChassisOffset: true,
  },
  surfaceMaterials: GLOBAL_VEHICLE_SURFACE_MATERIALS,
  lampsConfig: GLOBAL_VEHICLE_LAMPS_CONFIG,
  colors: {
    default: {
      primary: 16734742,
      realisticPrimary: 16555020,
      pearl: 16724660,
    },
  },
};

export const INSIDIO_DESCRIPTOR = {
  id: 'insidio',
  name: 'Insidio',
  hitboxPreset: 'hitbox-hybrid',
  modelUrl: '/assets/vehicles/Insidio.glb',
  rawBounds: {
    min: [-59.8536, -10.7404, -39.3438],
    max: [79.8535, 31.1743, 39.3438],
    length: 139.7071,
    height: 41.9147,
    width: 78.6876,
    center: [10.0, 10.217, 0],
    roofTopY: 31.1743,
    rlHitboxTopY: 37.8346,
  },
  alignment: {
    scale: 1.0,
    scaleX: 1.0,
    scaleY: 1.0,
    scaleZ: 1.0,
    centerOffset: [0.2, -1.0, 0],
  },
  wheelNames: [
    'wheel-front-right',
    'wheel-front-left',
    'wheel-rear-right',
    'wheel-rear-left',
  ],
  wheelAnchors: [
    [48.8139, 26.9291, 12.5],
    [48.8139, -26.9291, 12.5],
    [-36.5145, 28.6221, 15.0],
    [-36.5145, -28.622, 15.0],
  ],
  suspensionHeights: [-4.5, -4.5, -2.0, -2.0],
  boostOutlets: [
    [-56.8, 9.25, 20.428],
    [-56.8, 9.25, -20.428],
  ],
  boostNozzleParams: {
    x: -57.0,
    y: 10.25,
    z: 20.4278,
    followChassisOffset: true,
  },
  surfaceMaterials: GLOBAL_VEHICLE_SURFACE_MATERIALS,
  lampsConfig: GLOBAL_VEHICLE_LAMPS_CONFIG,
  colors: {
    default: {
      primary: 3115263,
      realisticPrimary: 3115263,
      pearl: 58879,
    },
  },
};

const vehicleRegistry = new Map([
  ['fennec', FENNEC_DESCRIPTOR],
  ['insidio', INSIDIO_DESCRIPTOR],
]);

export function registerVehicleDescriptor(descriptor) {
  if (!descriptor || !descriptor.id) {
    throw new Error("Vehicle descriptor must include a valid unique 'id'");
  }
  vehicleRegistry.set(descriptor.id, descriptor);
  if (descriptor.aliases && Array.isArray(descriptor.aliases)) {
    for (const alias of descriptor.aliases) {
      vehicleRegistry.set(alias, descriptor);
    }
  }
}

export function getVehicleDescriptor(id) {
  return vehicleRegistry.get(id) || null;
}

export function getAllVehicleDescriptors() {
  const unique = new Set(vehicleRegistry.values());
  return Array.from(unique);
}

export function hasVehicleDescriptor(id) {
  return vehicleRegistry.has(id);
}

export function recomputeDescriptorBoostOutlets(descriptor) {
  if (!descriptor || !descriptor.boostNozzleParams) return descriptor?.boostOutlets;
  const { x, y, z, followChassisOffset } = descriptor.boostNozzleParams;
  const offsetX = followChassisOffset ? (descriptor.alignment?.centerOffset?.[0] ?? 0) : 0;
  const offsetY = followChassisOffset ? (descriptor.alignment?.centerOffset?.[1] ?? 0) : 0;
  const offsetZ = followChassisOffset ? (descriptor.alignment?.centerOffset?.[2] ?? 0) : 0;

  descriptor.boostOutlets = [
    [Number((x + offsetX).toFixed(3)), Number((y + offsetY).toFixed(3)), Number((z + offsetZ).toFixed(3))],
    [Number((x + offsetX).toFixed(3)), Number((y + offsetY).toFixed(3)), Number((-z + offsetZ).toFixed(3))],
  ];
  return descriptor.boostOutlets;
}

export const vehicleTunerRuntimeFlags = {
  activeVehicleId: 'fennec',
  colorOverride: false,
  forceBoostPreview: false,
  forceBrakeLightPreview: false,
  brakePreviewMode: 'auto',
  showNozzleGizmos: false,
};

export function getVehicleTunerRuntimeFlags() {
  return { ...vehicleTunerRuntimeFlags };
}

export function setVehicleTunerRuntimeFlags(patch = {}) {
  Object.assign(vehicleTunerRuntimeFlags, patch);
  return getVehicleTunerRuntimeFlags();
}

export const DEFAULT_WHEEL_MODIFIER_CONFIG = {
  mode: 'solid-cylinder',
  width: 6,
  radiusScale: 1,
  verticalOffsetY: 0,
  outerRimRadiusPct: 80,
  outerColor: '#737373',
  innerColor: '#000000',
  treadColor: '#000000',
  treadShaderMode: 'standard',
  treadRoughness: 1,
  treadMetalness: 0,
  sideShaderMode: 'standard',
  sideRoughness: 0.5,
  sideMetalness: 0.7,
  innerRimFollowsOuter: true,
  innerRimRadiusPct: 80,
  innerRimColor: '#737373',
  innerRimShaderMode: 'standard',
  innerRimRoughness: 0.5,
  innerRimMetalness: 0.7,
  innerShaderMode: 'standard',
  innerRoughness: 1,
  innerMetalness: 0,
  shaderMode: 'standard',
  roughness: 1,
  metalness: 0,
};

export const wheelModifierRuntimeConfig = {
  ...DEFAULT_WHEEL_MODIFIER_CONFIG,
};

export function getWheelModifierConfig() {
  return { ...wheelModifierRuntimeConfig };
}

export function setWheelModifierConfig(patch = {}) {
  if (!patch) return getWheelModifierConfig();
  const nextConfig = { ...patch };

  if (nextConfig.innerColor !== undefined && nextConfig.treadColor === undefined) {
    nextConfig.treadColor = nextConfig.innerColor;
  } else if (nextConfig.treadColor !== undefined && nextConfig.innerColor === undefined) {
    nextConfig.innerColor = nextConfig.treadColor;
  }

  if (nextConfig.innerShaderMode !== undefined && nextConfig.treadShaderMode === undefined) {
    nextConfig.treadShaderMode = nextConfig.innerShaderMode;
  } else if (nextConfig.treadShaderMode !== undefined && nextConfig.innerShaderMode === undefined) {
    nextConfig.innerShaderMode = nextConfig.treadShaderMode;
  }

  if (nextConfig.innerRoughness !== undefined && nextConfig.treadRoughness === undefined) {
    nextConfig.treadRoughness = nextConfig.innerRoughness;
  } else if (nextConfig.treadRoughness !== undefined && nextConfig.innerRoughness === undefined) {
    nextConfig.innerRoughness = nextConfig.treadRoughness;
  }

  if (nextConfig.innerMetalness !== undefined && nextConfig.treadMetalness === undefined) {
    nextConfig.treadMetalness = nextConfig.innerMetalness;
  } else if (nextConfig.treadMetalness !== undefined && nextConfig.innerMetalness === undefined) {
    nextConfig.innerMetalness = nextConfig.treadMetalness;
  }

  const hasExplicitSurfaceFields =
    nextConfig.treadShaderMode !== undefined ||
    nextConfig.sideShaderMode !== undefined ||
    nextConfig.innerShaderMode !== undefined ||
    nextConfig.innerRimShaderMode !== undefined ||
    nextConfig.treadRoughness !== undefined ||
    nextConfig.sideRoughness !== undefined ||
    nextConfig.innerRoughness !== undefined ||
    nextConfig.innerRimRoughness !== undefined ||
    nextConfig.treadMetalness !== undefined ||
    nextConfig.sideMetalness !== undefined ||
    nextConfig.innerMetalness !== undefined ||
    nextConfig.innerRimMetalness !== undefined;

  if (!hasExplicitSurfaceFields) {
    if (nextConfig.shaderMode !== undefined) {
      nextConfig.treadShaderMode = nextConfig.shaderMode;
      nextConfig.sideShaderMode = nextConfig.shaderMode;
      nextConfig.innerShaderMode = nextConfig.shaderMode;
      nextConfig.innerRimShaderMode = nextConfig.shaderMode;
    }
    if (nextConfig.roughness !== undefined) {
      nextConfig.treadRoughness = nextConfig.roughness;
      nextConfig.sideRoughness = nextConfig.roughness;
      nextConfig.innerRoughness = nextConfig.roughness;
      nextConfig.innerRimRoughness = nextConfig.roughness;
    }
    if (nextConfig.metalness !== undefined) {
      nextConfig.treadMetalness = nextConfig.metalness;
      nextConfig.sideMetalness = nextConfig.metalness;
      nextConfig.innerMetalness = nextConfig.metalness;
      nextConfig.innerRimMetalness = nextConfig.metalness;
    }
  }

  const shouldInnerFollowOuter =
    nextConfig.innerRimFollowsOuter !== undefined
      ? Boolean(nextConfig.innerRimFollowsOuter)
      : Boolean(wheelModifierRuntimeConfig.innerRimFollowsOuter ?? true);

  if (shouldInnerFollowOuter) {
    const targetPct = nextConfig.outerRimRadiusPct ?? wheelModifierRuntimeConfig.outerRimRadiusPct ?? 80;
    const targetColor = nextConfig.outerColor ?? wheelModifierRuntimeConfig.outerColor ?? '#737373';
    const targetShader = nextConfig.sideShaderMode ?? wheelModifierRuntimeConfig.sideShaderMode ?? 'standard';
    const targetRoughness = nextConfig.sideRoughness ?? wheelModifierRuntimeConfig.sideRoughness ?? 0.5;
    const targetMetalness = nextConfig.sideMetalness ?? wheelModifierRuntimeConfig.sideMetalness ?? 0.7;

    if (nextConfig.innerRimRadiusPct === undefined) nextConfig.innerRimRadiusPct = targetPct;
    if (nextConfig.innerRimColor === undefined) nextConfig.innerRimColor = targetColor;
    if (nextConfig.innerRimShaderMode === undefined) nextConfig.innerRimShaderMode = targetShader;
    if (nextConfig.innerRimRoughness === undefined) nextConfig.innerRimRoughness = targetRoughness;
    if (nextConfig.innerRimMetalness === undefined) nextConfig.innerRimMetalness = targetMetalness;
  }

  Object.assign(wheelModifierRuntimeConfig, nextConfig);
  return getWheelModifierConfig();
}

export const anodizedPaintTuning = {
  roughness: 0.04,
  metalness: 0.76,
  clearcoat: 1.0,
  clearcoatRoughness: 0.11,
  sheen: 0.7,
  sheenRoughness: 0.24,
  envMapIntensity: 1.4,
  pearlFresnelPower: 1.35,
  pearlBlendStrength: 0.82,
};

const anodizedPaintListeners = new Set();

export function subscribeAnodizedPaintTuning(listener) {
  if (typeof listener !== 'function') return () => {};
  anodizedPaintListeners.add(listener);
  return () => {
    anodizedPaintListeners.delete(listener);
  };
}

export function getAnodizedPaintTuning() {
  return { ...anodizedPaintTuning };
}

export function updateAnodizedPaintTuning(patch = {}) {
  if (!patch) return anodizedPaintTuning;
  Object.assign(anodizedPaintTuning, patch);
  for (const listener of anodizedPaintListeners) {
    try {
      listener(patch, anodizedPaintTuning);
    } catch (err) {
      console.warn('[vehicleTunerConfig] Anodized paint listener threw an error:', err);
    }
  }
  return anodizedPaintTuning;
}

export const boostParticleRuntimeConfig = {
  detailPreset: 'full', // 'none' | 'low' | 'full'
  trailSpawnMultiplier: 1,
  trailLifeMultiplier: 1,
  dualStreamEnabled: true,
  shortTrailSpawnMultiplier: 1,
  shortTrailLifetime: 0.1,
  shortTrailScaleRefLife: 0.6,
  longTrailSpawnMultiplier: 0.1,
  longTrailLifetime: 2,
  smoothStreamTransition: true,
  distanceDecayEnabled: true,
  distanceDecayFalloff: 1200,
  drivePuffsEnabled: true,
  pointLightEnabled: false,
  bloomEnabled: false,
};

export function getBoostParticleRuntimeConfig() {
  return { ...boostParticleRuntimeConfig };
}

export function setBoostParticleRuntimeConfig(patch = {}) {
  if (!patch) return boostParticleRuntimeConfig;
  if (patch.detailPreset === 'none') {
    boostParticleRuntimeConfig.detailPreset = 'none';
    boostParticleRuntimeConfig.trailSpawnMultiplier = 0.0;
    boostParticleRuntimeConfig.trailLifeMultiplier = 0.5;
    boostParticleRuntimeConfig.shortTrailSpawnMultiplier = 0.0;
    boostParticleRuntimeConfig.longTrailSpawnMultiplier = 0.0;
    boostParticleRuntimeConfig.drivePuffsEnabled = false;
  } else if (patch.detailPreset === 'low') {
    boostParticleRuntimeConfig.detailPreset = 'low';
    boostParticleRuntimeConfig.trailSpawnMultiplier = 0.4;
    boostParticleRuntimeConfig.trailLifeMultiplier = 0.65;
    boostParticleRuntimeConfig.shortTrailSpawnMultiplier = 0.6;
    boostParticleRuntimeConfig.shortTrailLifetime = 0.1;
    boostParticleRuntimeConfig.shortTrailScaleRefLife = 0.6;
    boostParticleRuntimeConfig.longTrailSpawnMultiplier = 0.05;
    boostParticleRuntimeConfig.longTrailLifetime = 1.4;
    boostParticleRuntimeConfig.drivePuffsEnabled = false;
  } else if (patch.detailPreset === 'full') {
    boostParticleRuntimeConfig.detailPreset = 'full';
    boostParticleRuntimeConfig.trailSpawnMultiplier = 1;
    boostParticleRuntimeConfig.trailLifeMultiplier = 1;
    boostParticleRuntimeConfig.shortTrailSpawnMultiplier = 1;
    boostParticleRuntimeConfig.shortTrailLifetime = 0.1;
    boostParticleRuntimeConfig.shortTrailScaleRefLife = 0.6;
    boostParticleRuntimeConfig.longTrailSpawnMultiplier = 0.1;
    boostParticleRuntimeConfig.longTrailLifetime = 2;
    boostParticleRuntimeConfig.drivePuffsEnabled = true;
  }
  Object.assign(boostParticleRuntimeConfig, patch);
  return boostParticleRuntimeConfig;
}
