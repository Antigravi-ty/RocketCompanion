import {
  AlwaysStencilFunc,
  Color,
  type DataTexture,
  DoubleSide,
  FrontSide,
  KeepStencilOp,
  type Material,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  ReplaceStencilOp,
  type Texture,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import {
  DEFAULT_Q1_LAYER_COLORS,
  DEFAULT_Q1_LAYER_OPACITIES,
  type DriftwoodsGroundConfig,
  type DriftwoodsLayerConfig,
  type DriftwoodsQ1LayerId,
  type DriftwoodsTunerConfig,
  mixDecalOverBaseOklab,
  oklchToHex,
  setHexOklchLightness
} from '../../../ui-core/config/driftwoodsConfig';
import type { ExperimentalWallFxConfig } from '../../../ui-core/config/atmosphereFxConfig';
import {
  Q1_TOTAL_PIXELS,
  getPrecomputedQ1Mask,
  rebuildMirroredRepeatMipmaps
} from './DriftwoodsMipmapBuilder.ts';
import type { createWallFxUniforms } from './WallFxShaderController.ts';

export type DriftwoodsShaderUniforms = ReturnType<typeof createDriftwoodsShaderUniforms>;
export type DriftwoodsGroundUniforms = DriftwoodsShaderUniforms['groundUniforms'];
export type DriftwoodsGoalTeamUniforms = DriftwoodsShaderUniforms['goalTeamUniforms'];
export type DriftwoodsSpecularAAUniforms = DriftwoodsShaderUniforms['specularAAUniforms'];
export type DriftwoodsOcclusionUniforms = DriftwoodsShaderUniforms['occlusionUniforms'];

export interface DriftwoodsGroundBakeTarget {
  groundUniforms: DriftwoodsGroundUniforms;
  goalTeamUniforms: DriftwoodsGoalTeamUniforms;
  wallFxUniforms: ReturnType<typeof createWallFxUniforms>;
  wallFxConfig: ExperimentalWallFxConfig;
  bakedBlueGroundTexture: DataTexture;
  bakedOrangeGroundTexture: DataTexture;
  _lastBakedPaletteSignature: string | null;
}

export interface DriftwoodsResolvedTeamColors {
  blue: string;
  orange: string;
}

export interface DriftwoodsOcclusionOverlayPass {
  overlayStandardMat: MeshStandardMaterial;
  overlayLambertMat: MeshLambertMaterial;
  overlayOrder: number;
}

export type DriftwoodsSurfaceMaterial = MeshStandardMaterial | MeshLambertMaterial;

export function createDriftwoodsShaderUniforms(
  config: Partial<DriftwoodsTunerConfig>,
  bakedBlueGroundTexture: DataTexture,
  bakedOrangeGroundTexture: DataTexture,
  q1GroundTexture: Texture | null
) {
  const q1Colors = {
    ...DEFAULT_Q1_LAYER_COLORS,
    ...(config.ground?.q1Colors || {})
  };

  const groundUniforms = {
    uGroundMode: { value: config.ground?.textureMode === 'original' ? 0.0 : 1.0 },
    uQ1BakedReady: { value: 0.0 },
    uBakedBlueGroundMap: { value: bakedBlueGroundTexture },
    uBakedOrangeGroundMap: { value: bakedOrangeGroundTexture },
    uQ1GroundMap: { value: q1GroundTexture },
    uQ1UvScale: {
      value: new Vector2(
        config.ground?.q1ScaleX ?? 1.0,
        config.ground?.q1ScaleY ?? 1.0
      )
    },
    uQ1UvOffset: {
      value: new Vector2(
        config.ground?.q1OffsetX ?? 0.0,
        config.ground?.q1OffsetY ?? 0.0
      )
    },
    uGroundColor: { value: new Color(config.ground?.groundColor || '#18441c') },
    uLineColor: { value: new Color(config.ground?.lineColor || '#e1e6eb') },
    uLineThreshold: { value: config.ground?.lineThreshold ?? 0.35 },
    uLineSmoothness: { value: config.ground?.lineSmoothness ?? 0.15 },
    uOrigLineThreshold: { value: config.ground?.originalLineThreshold ?? 0.0921 },
    uOrigLineSmoothness: { value: config.ground?.originalLineSmoothness ?? 0.0364 },
    uL0Color: { value: new Color(q1Colors.L0) },
    uL1Color: { value: new Color(q1Colors.L1) },
    uL2Color: { value: new Color(q1Colors.L2) },
    uL3Color: { value: new Color(q1Colors.L3) },
    uL4Color: { value: new Color(q1Colors.L4) },
    uL5Color: { value: new Color(q1Colors.L5) },
    uL6Color: { value: new Color(q1Colors.L6) },
    uL4UseTeamColor: { value: config.ground?.l4UseTeamColor !== false ? 1.0 : 0.0 },
    uL5UseTeamColor: { value: config.ground?.l5UseTeamColor !== false ? 1.0 : 0.0 },
    uL6UseTeamColor: { value: config.ground?.l6UseTeamColor !== false ? 1.0 : 0.0 },
    uBallRingPos: { value: new Vector3(0, 95, 0) },
    uBallRingRadii: { value: new Vector4(100.51, 109.25, 86.44, 93.96) },
    uBallRingOpacity: { value: 0.2 }
  };

  const specularAAUniforms = {
    uSpecularAAStrength: {
      value:
        config.specularAA !== false ? Number(config.specularAAStrength ?? 1.0) : 0.0
    }
  };

  const occlusionUniforms = {
    uOcclusionOpacity: {
      value: Number(config.occlusionOpacity ?? 0.4)
    },
    uWallExteriorOcclusionEnabled: {
      value: config.wallExteriorOcclusion !== false ? 1.0 : 0.0
    },
    uGoalDepthMaskEnabled: {
      value: config.goalDepthMaskEnabled !== false ? 1.0 : 0.0
    },
    uGoalMaskOffsetUu: {
      value: Number(config.goalMaskOffsetUu ?? 250)
    },
    uGoalMaskGradientDistanceUu: {
      value: Math.max(1.0, Number(config.goalMaskGradientDistanceUu ?? 500))
    },
    uGoalMaskBezier: {
      value: new Vector4(
        Number(config.goalMaskBezierP1X ?? 0.27),
        Number(config.goalMaskBezierP1Y ?? 0.06),
        Number(config.goalMaskBezierP2X ?? 0.26),
        Number(config.goalMaskBezierP2Y ?? 0.73)
      )
    }
  };

  const goalTeamUniforms = {
    uGoalFrameUseTeamColor: {
      value: Boolean(config.goalFrame?.useTeamColor) ? 1.0 : 0.0
    },
    uGoalPostsUseTeamColor: {
      value: Boolean(config.goalPosts?.useTeamColor) ? 1.0 : 0.0
    },
    uGoalPostsGlowUseTeamColor: {
      value: config.goalPostsGlow?.useTeamColor !== false ? 1.0 : 0.0
    },
    uRampsUpperOuterUseTeamColor: {
      value: config.rampsUpperOuter?.useTeamColor !== false ? 1.0 : 0.0
    },
    uGoalNetUseTeamColor: { value: 0.0 },
    uGoalBlueColor: { value: new Color('#1982e6') },
    uGoalOrangeColor: { value: new Color('#e05d09') },
    uGoalPostsGlowBlueColor: { value: new Color('#7ec6ff') },
    uGoalPostsGlowOrangeColor: { value: new Color('#ffab6e') },
    uRampsUpperOuterBlueColor: { value: new Color('#1374d1') },
    uRampsUpperOuterOrangeColor: { value: new Color('#c95104') }
  };

  return {
    groundUniforms,
    specularAAUniforms,
    occlusionUniforms,
    goalTeamUniforms
  };
}

/**
 * Resolves effective layer colors and opacities in OKLCH / Oklab perceptual space
 * with unified Chroma (C) and Blue/Orange Hue (H) and independent Lightness (L)
 * for Ground Markings, Goal Posts/Frame, and Hexagon Grid.
 */
export function bakeQ1GroundTexturesIntoManager(
  manager: DriftwoodsGroundBakeTarget,
  g: Partial<DriftwoodsGroundConfig> | null | undefined
): void {
  if (!g) return;
  const rawColors = {
    ...DEFAULT_Q1_LAYER_COLORS,
    ...(g.q1Colors || {})
  };
  const opacities = {
    ...DEFAULT_Q1_LAYER_OPACITIES,
    ...(g.q1Opacities || {})
  };

  const oklchSync = g.oklchSyncEnabled !== false;
  const markingsL = g.oklchMarkingsLightness ?? 0.96;
  const teamL = g.oklchTeamLightness ?? 0.7;
  const goalL = g.oklchGoalLightness ?? 0.582;
  const goalGlowL = g.oklchGoalPostsGlowLightness ?? 0.65;
  const rampsUpperOuterL = g.oklchRampsUpperOuterLightness ?? 0.5;
  const hexL = g.oklchHexLightness ?? 0.65;
  const teamC = g.oklchTeamChroma ?? 0.19;
  const blueH = g.oklchBlueHue ?? 250;
  const orangeH = g.oklchOrangeHue ?? 45;

  const groundC = g.oklchGroundIndependentCH ? (g.oklchGroundChroma ?? teamC) : teamC;
  const groundBlueH = g.oklchGroundIndependentCH ? (g.oklchGroundBlueHue ?? blueH) : blueH;
  const groundOrangeH = g.oklchGroundIndependentCH ? (g.oklchGroundOrangeHue ?? orangeH) : orangeH;

  const goalC = g.oklchGoalIndependentCH ? (g.oklchGoalChroma ?? teamC) : teamC;
  const goalBlueH = g.oklchGoalIndependentCH ? (g.oklchGoalBlueHue ?? blueH) : blueH;
  const goalOrangeH = g.oklchGoalIndependentCH ? (g.oklchGoalOrangeHue ?? orangeH) : orangeH;

  const goalGlowC = g.oklchGoalPostsGlowIndependentCH
    ? (g.oklchGoalPostsGlowChroma ?? teamC)
    : teamC;
  const goalGlowBlueH = g.oklchGoalPostsGlowIndependentCH
    ? (g.oklchGoalPostsGlowBlueHue ?? blueH)
    : blueH;
  const goalGlowOrangeH = g.oklchGoalPostsGlowIndependentCH
    ? (g.oklchGoalPostsGlowOrangeHue ?? orangeH)
    : orangeH;

  const rampsUpperOuterC =
    g.oklchRampsUpperOuterIndependentCH !== false
      ? (g.oklchRampsUpperOuterChroma ?? 0.1)
      : teamC;
  const rampsUpperOuterBlueH =
    g.oklchRampsUpperOuterIndependentCH !== false
      ? (g.oklchRampsUpperOuterBlueHue ?? blueH)
      : blueH;
  const rampsUpperOuterOrangeH =
    g.oklchRampsUpperOuterIndependentCH !== false
      ? (g.oklchRampsUpperOuterOrangeHue ?? orangeH)
      : orangeH;

  const hexC = g.oklchHexIndependentCH !== false ? (g.oklchHexChroma ?? 0.32) : teamC;
  const hexBlueH = g.oklchHexIndependentCH !== false ? (g.oklchHexBlueHue ?? blueH) : blueH;
  const hexOrangeH = g.oklchHexIndependentCH !== false ? (g.oklchHexOrangeHue ?? orangeH) : orangeH;

  const baseTurfHex = rawColors.L0 || '#1b4a00';
  manager.groundUniforms.uL0Color.value.set(baseTurfHex);

  const blueTeamHex = oklchSync
    ? oklchToHex(teamL, groundC, groundBlueH)
    : g.blueTeamLineColor || manager.wallFxConfig.blueTeamColor || '#0089ff';
  const orangeTeamHex = oklchSync
    ? oklchToHex(teamL, groundC, groundOrangeH)
    : g.orangeTeamLineColor || manager.wallFxConfig.orangeTeamColor || '#ff5200';

  const blueGoalHex = oklchSync ? oklchToHex(goalL, goalC, goalBlueH) : blueTeamHex;
  const orangeGoalHex = oklchSync ? oklchToHex(goalL, goalC, goalOrangeH) : orangeTeamHex;
  manager.goalTeamUniforms.uGoalBlueColor.value.set(blueGoalHex);
  manager.goalTeamUniforms.uGoalOrangeColor.value.set(orangeGoalHex);

  const blueGoalGlowHex = oklchSync
    ? oklchToHex(goalGlowL, goalGlowC, goalGlowBlueH)
    : setHexOklchLightness(blueTeamHex, goalGlowL);
  const orangeGoalGlowHex = oklchSync
    ? oklchToHex(goalGlowL, goalGlowC, goalGlowOrangeH)
    : setHexOklchLightness(orangeTeamHex, goalGlowL);
  manager.goalTeamUniforms.uGoalPostsGlowBlueColor.value.set(blueGoalGlowHex);
  manager.goalTeamUniforms.uGoalPostsGlowOrangeColor.value.set(orangeGoalGlowHex);

  const blueRampsUpperOuterHex = oklchSync
    ? oklchToHex(rampsUpperOuterL, rampsUpperOuterC, rampsUpperOuterBlueH)
    : setHexOklchLightness(blueTeamHex, rampsUpperOuterL);
  const orangeRampsUpperOuterHex = oklchSync
    ? oklchToHex(rampsUpperOuterL, rampsUpperOuterC, rampsUpperOuterOrangeH)
    : setHexOklchLightness(orangeTeamHex, rampsUpperOuterL);
  manager.goalTeamUniforms.uRampsUpperOuterBlueColor.value.set(blueRampsUpperOuterHex);
  manager.goalTeamUniforms.uRampsUpperOuterOrangeColor.value.set(orangeRampsUpperOuterHex);

  if (oklchSync) {
    const blueHexGridColor = oklchToHex(hexL, hexC, hexBlueH);
    const orangeHexGridColor = oklchToHex(hexL, hexC, hexOrangeH);
    manager.wallFxUniforms.uBlueTeamColor.value.set(blueHexGridColor);
    manager.wallFxUniforms.uOrangeTeamColor.value.set(orangeHexGridColor);
    manager.wallFxConfig.blueTeamColor = blueHexGridColor;
    manager.wallFxConfig.orangeTeamColor = orangeHexGridColor;
  }

  const effColors: Record<DriftwoodsQ1LayerId, string> = {
    L0: baseTurfHex,
    L1: oklchSync ? setHexOklchLightness(rawColors.L1, markingsL) : rawColors.L1,
    L2: oklchSync ? setHexOklchLightness(rawColors.L2, markingsL) : rawColors.L2,
    L3: oklchSync ? setHexOklchLightness(rawColors.L3, markingsL) : rawColors.L3,
    L4: rawColors.L4,
    L5: oklchSync ? setHexOklchLightness(rawColors.L5, markingsL) : rawColors.L5,
    L6: rawColors.L6
  };

  const l4Team = g.l4UseTeamColor !== false;
  const l5Team = g.l5UseTeamColor !== false;
  const l6Team = g.l6UseTeamColor !== false;

  const layerIds: ReadonlyArray<Exclude<DriftwoodsQ1LayerId, 'L0'>> = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  const blueRgbLut = new Uint32Array(7);
  const orangeRgbLut = new Uint32Array(7);
  const baseBlend = mixDecalOverBaseOklab(baseTurfHex, baseTurfHex, 0);
  const basePacked =
    baseBlend.srgbBytes[0] | (baseBlend.srgbBytes[1] << 8) | (baseBlend.srgbBytes[2] << 16);
  blueRgbLut[0] = basePacked;
  orangeRgbLut[0] = basePacked;

  const layerColorUniforms: Record<Exclude<DriftwoodsQ1LayerId, 'L0'>, { value: Color }> = {
    L1: manager.groundUniforms.uL1Color,
    L2: manager.groundUniforms.uL2Color,
    L3: manager.groundUniforms.uL3Color,
    L4: manager.groundUniforms.uL4Color,
    L5: manager.groundUniforms.uL5Color,
    L6: manager.groundUniforms.uL6Color
  };

  for (let i = 0; i < 6; i++) {
    const id = layerIds[i];
    const idx = i + 1;
    const op = Math.max(0, Math.min(1, Number(opacities[id] ?? 0.85)));
    const useTeam =
      (id === 'L4' && l4Team) || (id === 'L5' && l5Team) || (id === 'L6' && l6Team);

    const blueTargetHex = useTeam ? blueTeamHex : effColors[id];
    const orangeTargetHex = useTeam ? orangeTeamHex : effColors[id];

    const blueMixed = mixDecalOverBaseOklab(baseTurfHex, blueTargetHex, op);
    const orangeMixed = mixDecalOverBaseOklab(baseTurfHex, orangeTargetHex, op);

    blueRgbLut[idx] =
      blueMixed.srgbBytes[0] |
      (blueMixed.srgbBytes[1] << 8) |
      (blueMixed.srgbBytes[2] << 16);
    orangeRgbLut[idx] =
      orangeMixed.srgbBytes[0] |
      (orangeMixed.srgbBytes[1] << 8) |
      (orangeMixed.srgbBytes[2] << 16);

    const uCol = layerColorUniforms[id];
    if (uCol) {
      uCol.value.setRGB(blueMixed.linear.r, blueMixed.linear.g, blueMixed.linear.b);
    }
  }

  const origGroundHex = g.groundColor || '#18441c';
  const origLineHex = oklchSync
    ? setHexOklchLightness(g.lineColor || '#e1e6eb', markingsL)
    : g.lineColor || '#e1e6eb';
  const origLineOp = Math.max(0, Math.min(1, Number(g.lineOpacity ?? 0.85)));
  const origBlended = mixDecalOverBaseOklab(origGroundHex, origLineHex, origLineOp);
  manager.groundUniforms.uGroundColor.value.set(origGroundHex);
  manager.groundUniforms.uLineColor.value.setRGB(
    origBlended.linear.r,
    origBlended.linear.g,
    origBlended.linear.b
  );

  const { dilatedLayerId, normalizedCoverage } = getPrecomputedQ1Mask();
  if (!dilatedLayerId || !normalizedCoverage) {
    manager.groundUniforms.uQ1BakedReady.value = 0.0;
    return;
  }

  const sig = JSON.stringify({
    b: Array.from(blueRgbLut),
    o: Array.from(orangeRgbLut)
  });
  if (sig === manager._lastBakedPaletteSignature && manager.groundUniforms.uQ1BakedReady.value > 0.5) {
    return;
  }
  manager._lastBakedPaletteSignature = sig;

  const blueUint32 = new Uint32Array(manager.bakedBlueGroundTexture.image.data.buffer);
  const orangeUint32 = new Uint32Array(manager.bakedOrangeGroundTexture.image.data.buffer);

  const len = Math.min(Q1_TOTAL_PIXELS, dilatedLayerId.length);
  for (let i = 0; i < len; i++) {
    const lid = dilatedLayerId[i];
    const alphaShift = normalizedCoverage[i] << 24;
    blueUint32[i] = blueRgbLut[lid] | alphaShift;
    orangeUint32[i] = orangeRgbLut[lid] | alphaShift;
  }

  rebuildMirroredRepeatMipmaps(manager.bakedBlueGroundTexture);
  rebuildMirroredRepeatMipmaps(manager.bakedOrangeGroundTexture);
  manager.bakedBlueGroundTexture.needsUpdate = true;
  manager.bakedOrangeGroundTexture.needsUpdate = true;
  manager.groundUniforms.uQ1BakedReady.value = 1.0;
}

export function resolveDriftwoodsTeamColors(
  groundConfig?: Partial<DriftwoodsGroundConfig> | null,
  wallFxConfig?: Partial<ExperimentalWallFxConfig> | null
): DriftwoodsResolvedTeamColors {
  const g = groundConfig;
  if (g && g.oklchSyncEnabled !== false) {
    const goalL = g.oklchGoalLightness ?? 0.582;
    const teamC = g.oklchTeamChroma ?? 0.19;
    const blueH = g.oklchBlueHue ?? 250;
    const orangeH = g.oklchOrangeHue ?? 45;
    const goalC = g.oklchGoalIndependentCH ? (g.oklchGoalChroma ?? teamC) : teamC;
    const goalBlueH = g.oklchGoalIndependentCH ? (g.oklchGoalBlueHue ?? blueH) : blueH;
    const goalOrangeH = g.oklchGoalIndependentCH ? (g.oklchGoalOrangeHue ?? orangeH) : orangeH;
    return {
      blue: oklchToHex(goalL, goalC, goalBlueH),
      orange: oklchToHex(goalL, goalC, goalOrangeH)
    };
  }
  return {
    blue: g?.blueTeamLineColor || wallFxConfig?.blueTeamColor || '#3fa3ff',
    orange: g?.orangeTeamLineColor || wallFxConfig?.orangeTeamColor || '#fa6e1d'
  };
}

/**
 * Creates the transparent occlusion overlay materials and mesh for Pass 2 stencil-masked rendering.
 */
export function createDriftwoodsOcclusionOverlayPass(
  mesh: Mesh,
  origMat: Material & { isMeshStandardMaterial?: boolean },
  overlayOrder: number
): DriftwoodsOcclusionOverlayPass {
  const name = mesh.name;
  const overlayStandardMat: MeshStandardMaterial = origMat.isMeshStandardMaterial
    ? (origMat as MeshStandardMaterial).clone()
    : new MeshStandardMaterial();
  overlayStandardMat.name = `${name}_OcclusionTransparent_Standard`;
  overlayStandardMat.transparent = true;
  overlayStandardMat.depthWrite = true;
  overlayStandardMat.stencilWrite = true;
  overlayStandardMat.stencilFunc = AlwaysStencilFunc;
  overlayStandardMat.stencilRef = 2;
  overlayStandardMat.stencilFuncMask = 0x02;
  overlayStandardMat.stencilWriteMask = 0x02;
  overlayStandardMat.stencilZPass = ReplaceStencilOp;
  overlayStandardMat.stencilFail = KeepStencilOp;
  overlayStandardMat.stencilZFail = KeepStencilOp;

  const overlayLambertMat = new MeshLambertMaterial({
    name: `${name}_OcclusionTransparent_Lambert`,
    map: overlayStandardMat.map || null,
    transparent: true,
    opacity: overlayStandardMat.opacity,
    depthWrite: true,
    side: overlayStandardMat.side,
    wireframe: overlayStandardMat.wireframe,
    emissiveIntensity: 0
  });
  overlayLambertMat.stencilWrite = true;
  overlayLambertMat.stencilFunc = AlwaysStencilFunc;
  overlayLambertMat.stencilRef = 2;
  overlayLambertMat.stencilFuncMask = 0x02;
  overlayLambertMat.stencilWriteMask = 0x02;
  overlayLambertMat.stencilZPass = ReplaceStencilOp;
  overlayLambertMat.stencilFail = KeepStencilOp;
  overlayLambertMat.stencilZFail = KeepStencilOp;

  return { overlayStandardMat, overlayLambertMat, overlayOrder };
}

export function attachDriftwoodsOcclusionOverlayMesh(
  mesh: Mesh,
  activeOverlayMat: Material,
  overlayOrder: number
): Mesh {
  const overlayMesh = new Mesh(mesh.geometry, activeOverlayMat);
  overlayMesh.name = `${mesh.name}_OcclusionTransparentOverlay`;
  overlayMesh.userData = { isOcclusionTransparentOverlay: true, bloomOccluder: false };
  overlayMesh.frustumCulled = false;
  overlayMesh.position.copy(mesh.position);
  overlayMesh.quaternion.copy(mesh.quaternion);
  overlayMesh.scale.copy(mesh.scale);
  overlayMesh.renderOrder = overlayOrder;
  overlayMesh.visible = mesh.visible;

  if (mesh.parent) {
    mesh.parent.add(overlayMesh);
  }
  return overlayMesh;
}

/**
 * Pure material property applicator for a single stadium mesh layer configuration.
 */
export function applyDriftwoodsLayerMaterials(
  meshName: string,
  layerConfig: Partial<DriftwoodsLayerConfig>,
  std: DriftwoodsSurfaceMaterial | null | undefined,
  lam: DriftwoodsSurfaceMaterial | null | undefined,
  overlayStd: DriftwoodsSurfaceMaterial | null | undefined,
  overlayLam: DriftwoodsSurfaceMaterial | null | undefined
): void {
  const keepTransparent =
    meshName === 'Woods_Field_Walls' || meshName === 'Woods_Field_Walls_Hexes';
  const isDynamicOcclusionMesh =
    meshName === 'Woods_Field_Ramps_Trim' ||
    meshName === 'Woods_Field_Wall_Posts' ||
    meshName === 'Woods_Field_Goal' ||
    meshName === 'Woods_Field_Goal_Posts' ||
    meshName === 'Woods_Field_Goal_Posts_1' ||
    meshName === 'Woods_Field_Goal_Posts_2' ||
    meshName === 'Woods_Field_Goal_Net' ||
    meshName === 'Woods_Field_Goal_Net_1';
  const isEmissiveMesh =
    meshName === 'Woods_Field_Walls_Hexes' || meshName === 'Woods_Field_Goal_Posts_2';
  const isUpperOuterMesh =
    meshName === 'Woods_Field_Ramps_2' || meshName === 'Woods_Field_Goal_Net_2';

  for (const mat of [std, lam, overlayStd, overlayLam]) {
    if (!mat) continue;
    const isOverlayMat = mat === overlayStd || mat === overlayLam;
    if (layerConfig.color) mat.color.set(layerConfig.color);
    if ('isMeshStandardMaterial' in mat && mat.isMeshStandardMaterial) {
      if (layerConfig.roughness !== undefined) mat.roughness = layerConfig.roughness;
      if (layerConfig.metalness !== undefined) mat.metalness = layerConfig.metalness;
    }
    if (isUpperOuterMesh) {
      const targetSide = layerConfig.oneWaySeeThrough !== false ? FrontSide : DoubleSide;
      if (mat.side !== targetSide) {
        mat.side = targetSide;
        mat.needsUpdate = true;
      }
    }
    if (isDynamicOcclusionMesh) {
      if (layerConfig.opacity !== undefined) {
        mat.opacity = layerConfig.opacity;
      }
      mat.transparent = isOverlayMat;
      mat.depthWrite = true;
      if (isOverlayMat) {
        mat.stencilWrite = true;
        mat.stencilFunc = AlwaysStencilFunc;
        mat.stencilRef = 2;
        mat.stencilFuncMask = 0x02;
        mat.stencilWriteMask = 0x02;
        mat.stencilZPass = ReplaceStencilOp;
        mat.stencilFail = KeepStencilOp;
        mat.stencilZFail = KeepStencilOp;
      }
    } else if (layerConfig.opacity !== undefined) {
      mat.opacity = layerConfig.opacity;
      mat.transparent = keepTransparent || layerConfig.opacity < 0.999;
      mat.depthWrite = !mat.transparent;
    } else if (keepTransparent) {
      mat.transparent = true;
      mat.depthWrite = false;
    }
    if (isEmissiveMesh) {
      if (layerConfig.emissive || layerConfig.color) {
        mat.emissive.set(layerConfig.emissive || layerConfig.color!);
      }
      mat.emissiveIntensity = Number(layerConfig.emissiveIntensity ?? 0);
    } else {
      mat.emissive.set('#000000');
      mat.emissiveIntensity = 0;
    }
    if (layerConfig.wireframe !== undefined) {
      mat.wireframe = layerConfig.wireframe;
    }
  }
}
