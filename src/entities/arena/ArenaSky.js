/**
 * ArenaSky.js
 * Modular skybox orchestrator supporting two primary rendering categories:
 * 1. 'hemisphere': Upper-hemisphere equirectangular textures (Woods_Sky_D, CHN_Sky3, Farmstead_Sky_T7, ForbiddenTemple)
 *    with multi-tap horizon-ring lower hemisphere gradient synthesis (`HemisphereSkyShader.js`).
 * 2. 'full-sphere': 25 CC0 360°×180° full-sphere equirectangular panoramas by Screaming Brain Studios (WebP)
 *    with lower-hemisphere V-offset cropping, smooth ground cutoff fade, and dimming (`FullSphereSkyShader.js`).
 */

import * as THREE from 'three';
import {
  SKYBOX_TEXTURE_PATH,
  CORONA_TEXTURE_PATH,
  SUN_GLOW_TEXTURE_PATH,
  CLOUD_OVERLAY_TEXTURE_PATH,
  OOB_NORMAL_TEXTURE_PATH,
  resolveSkyboxPreset,
  skyboxRuntimeConfig,
  updateSkyboxConfig as updateSkyboxConfigState,
  subscribeSkyboxConfig,
} from '../../ui-core/config/skyboxConfig.js';
import { SKYBOX_VERTEX_SHADER, SKYBOX_COMMON_GLSL_HEADER } from './skybox/SkyboxCommonShader.js';
import { HEMISPHERE_SKY_GLSL } from './skybox/HemisphereSkyShader.js';
import { FULL_SPHERE_SKY_GLSL } from './skybox/FullSphereSkyShader.js';
import { resolveAssetPath } from './ArenaConstants.js';

let activeSkyUniforms = null;
const cachedSkyTexturesByPath = new Map();
let cachedCoronaTexture = null;
let cachedSunGlowTexture = null;
let cachedCloudOverlayTexture = null;
let cachedOobNormalTexture = null;
let skyAccumulatedTime = 0;
const latestSceneSunDir = new THREE.Vector3(2500, 4000, 1500).normalize();

export function loadSkyboxTexture(path = SKYBOX_TEXTURE_PATH) {
  const resolvedPath = resolveAssetPath(path || SKYBOX_TEXTURE_PATH);
  if (cachedSkyTexturesByPath.has(resolvedPath)) {
    return cachedSkyTexturesByPath.get(resolvedPath);
  }
  const loader = new THREE.TextureLoader();
  const tex = loader.load(
    resolvedPath,
    (loaded) => {
      loaded.needsUpdate = true;
    },
    undefined,
    (err) => {
      console.warn(`[ArenaSky] Failed to load skybox texture (${resolvedPath}):`, err);
    }
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  cachedSkyTexturesByPath.set(resolvedPath, tex);
  return tex;
}

function loadCoronaTexture() {
  if (cachedCoronaTexture) return cachedCoronaTexture;
  const loader = new THREE.TextureLoader();
  const tex = loader.load(resolveAssetPath(CORONA_TEXTURE_PATH));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  cachedCoronaTexture = tex;
  return tex;
}

function loadSunGlowTexture() {
  if (cachedSunGlowTexture) return cachedSunGlowTexture;
  const loader = new THREE.TextureLoader();
  const tex = loader.load(resolveAssetPath(SUN_GLOW_TEXTURE_PATH));
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  cachedSunGlowTexture = tex;
  return tex;
}

function loadCloudOverlayTexture() {
  if (cachedCloudOverlayTexture) return cachedCloudOverlayTexture;
  cachedCloudOverlayTexture = loadSkyboxTexture(CLOUD_OVERLAY_TEXTURE_PATH);
  return cachedCloudOverlayTexture;
}

function loadOobNormalTexture() {
  if (cachedOobNormalTexture) return cachedOobNormalTexture;
  const loader = new THREE.TextureLoader();
  const tex = loader.load(resolveAssetPath(OOB_NORMAL_TEXTURE_PATH));
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  cachedOobNormalTexture = tex;
  return tex;
}

function computeDirectionFromAngles(azimuthDeg, elevationDeg, target = new THREE.Vector3()) {
  const azRad = ((Number(azimuthDeg) || 0) * Math.PI) / 180;
  const elRad = ((Number(elevationDeg) || 0) * Math.PI) / 180;
  const cosEl = Math.cos(elRad);
  target.set(cosEl * Math.cos(azRad), Math.sin(elRad), cosEl * Math.sin(azRad)).normalize();
  return target;
}

function updateCoronaSunBasisUniforms(uniforms, c) {
  if (!uniforms) return;
  const sunDir = uniforms.uSunDir.value;
  if (c.coronaFollowSceneSun) {
    sunDir.copy(latestSceneSunDir).normalize();
  } else {
    const rotDeg = Number(c.rotationDeg ?? c.textureRotationDeg ?? 0) || 0;
    const azDeg = (Number(c.coronaAzimuthDeg) || 0) - rotDeg;
    const elDeg = Number(c.coronaElevationDeg) ?? 3.5;
    computeDirectionFromAngles(azDeg, elDeg, sunDir);
  }
  const worldUp = Math.abs(sunDir.y) < 0.98 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const sunRight = uniforms.uSunRight.value.crossVectors(worldUp, sunDir).normalize();
  const sunUp = uniforms.uSunUp.value.crossVectors(sunDir, sunRight).normalize();

  const rotRad = ((Number(c.coronaRotationDeg) || 0) * Math.PI) / 180;
  if (Math.abs(rotRad) > 1e-4) {
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const rx = sunRight.x * cosR + sunUp.x * sinR;
    const ry = sunRight.y * cosR + sunUp.y * sinR;
    const rz = sunRight.z * cosR + sunUp.z * sinR;
    const ux = -sunRight.x * sinR + sunUp.x * cosR;
    const uy = -sunRight.y * sinR + sunUp.y * cosR;
    const uz = -sunRight.z * sinR + sunUp.z * cosR;
    sunRight.set(rx, ry, rz).normalize();
    sunUp.set(ux, uy, uz).normalize();
  }
}

function syncActiveSkyUniforms(c = skyboxRuntimeConfig) {
  if (!activeSkyUniforms) return;
  const useTex = c.useTexture !== undefined ? Boolean(c.useTexture) : c.mode === 'texture';
  const rotDeg = c.rotationDeg ?? c.textureRotationDeg ?? 0;
  const expVal = c.exposure ?? c.textureExposure ?? 0.6;
  const activePreset = resolveSkyboxPreset(c.presetId || c.texturePath, c.skyCategory);
  const isFullSphere = (c.skyCategory || activePreset.category) === 'full-sphere';

  const targetPath = c.texturePath || activePreset.path;
  activeSkyUniforms.uSkyMap.value = loadSkyboxTexture(targetPath);
  activeSkyUniforms.uSkyCategory.value = isFullSphere ? 1.0 : 0.0;

  activeSkyUniforms.uUseTexture.value = useTex ? 1.0 : 0.0;
  activeSkyUniforms.uTextureScaleU.value = Number(c.textureScaleU) || 1.0;
  activeSkyUniforms.uRotationRad.value = ((Number(rotDeg) || 0) * Math.PI) / 180;
  activeSkyUniforms.uExposure.value = Number(expVal) ?? 0.6;
  activeSkyUniforms.uUpperVerticalStretch.value = Math.max(0.2, Number(c.upperVerticalStretch) || 1.0);
  activeSkyUniforms.uContrastBalance.value = Math.max(0.0, Math.min(1.0, Number(c.contrastBalance) ?? 0.15));
  activeSkyUniforms.uContrastMidpoint.value = Math.max(0.05, Math.min(1.0, Number(c.contrastMidpoint) ?? 0.15));
  activeSkyUniforms.uHorizonOffset.value = Number(c.horizonOffset) ?? 0.0;
  activeSkyUniforms.uHorizonBlendWidth.value = Math.max(0.002, Number(c.horizonBlendWidth) ?? 0.03);
  activeSkyUniforms.uHorizonHazeStrength.value = Number(c.horizonHazeStrength) ?? 0.0;
  activeSkyUniforms.uGroundSampleHorizon.value = c.groundSampleHorizon !== false ? 1.0 : 0.0;
  activeSkyUniforms.uGroundGradientRange.value = Math.max(0.01, Number(c.groundGradientRange) ?? 0.95);
  activeSkyUniforms.uGroundHorizonStrength.value = Math.max(0.0, Math.min(1.0, Number(c.groundHorizonStrength) ?? 0.8));
  if (c.horizonColor) activeSkyUniforms.uHorizonColor.value.set(c.horizonColor);
  if (c.groundColor) activeSkyUniforms.uGroundColor.value.set(c.groundColor);
  if (c.zenithColor) activeSkyUniforms.uZenithColor.value.set(c.zenithColor);
  if (c.middleColor) activeSkyUniforms.uMiddleColor.value.set(c.middleColor);

  activeSkyUniforms.uFullSphereLowerVOffset.value = Math.max(0.0, Math.min(0.48, Number(c.fullSphereLowerVOffset) ?? 0.04));
  activeSkyUniforms.uFullSphereLowerVerticalStretch.value = Math.max(0.2, Number(c.fullSphereLowerVerticalStretch) || 1.0);
  activeSkyUniforms.uFullSphereLowerCutoffElev.value = Math.max(0.0, Math.min(1.0, Number(c.fullSphereLowerCutoffElev) ?? 0.18));
  activeSkyUniforms.uFullSphereLowerFadeRange.value = Math.max(0.01, Math.min(1.0, Number(c.fullSphereLowerFadeRange) ?? 0.45));
  activeSkyUniforms.uFullSphereLowerDimming.value = Math.max(0.0, Math.min(1.0, Number(c.fullSphereLowerDimming) ?? 0.25));
  activeSkyUniforms.uFullSphereLowerSampleHorizon.value = c.fullSphereLowerSampleHorizon ? 1.0 : 0.0;

  const coronaOn = Boolean(c.coronaEnabled);
  activeSkyUniforms.uCoronaEnabled.value = coronaOn ? 1.0 : 0.0;
  if (coronaOn) {
    activeSkyUniforms.uCoronaMap.value = loadCoronaTexture();
    activeSkyUniforms.uSunGlowMap.value = loadSunGlowTexture();
  }
  activeSkyUniforms.uCoronaSize.value = Math.max(0.02, Number(c.coronaSize) || 0.16);
  activeSkyUniforms.uCoronaIntensity.value = Math.max(0.0, Number(c.coronaIntensity) ?? 1.25);
  activeSkyUniforms.uSunGlowSize.value = Math.max(0.04, Number(c.sunGlowSize) || 0.42);
  activeSkyUniforms.uSunGlowIntensity.value = Math.max(0.0, Number(c.sunGlowIntensity) ?? 0.65);
  if (c.sunGlowColor) activeSkyUniforms.uSunGlowColor.value.set(c.sunGlowColor);
  updateCoronaSunBasisUniforms(activeSkyUniforms, c);

  const cloudOn = Boolean(c.cloudOverlayEnabled);
  activeSkyUniforms.uCloudOverlayEnabled.value = cloudOn ? 1.0 : 0.0;
  if (cloudOn) {
    activeSkyUniforms.uCloudOverlayMap.value = loadCloudOverlayTexture();
  }
  activeSkyUniforms.uCloudOverlayOpacity.value = Math.max(0.0, Math.min(1.0, Number(c.cloudOverlayOpacity) ?? 0.45));
  activeSkyUniforms.uCloudOverlayScaleU.value = Number(c.cloudOverlayScaleU) || 1.0;
  activeSkyUniforms.uCloudOverlayElevationOffset.value = Number(c.cloudOverlayElevationOffset) ?? 0.0;

  const oobOn = Boolean(c.oobNormalEnabled);
  activeSkyUniforms.uOobNormalEnabled.value = oobOn ? 1.0 : 0.0;
  if (oobOn) {
    activeSkyUniforms.uOobNormalMap.value = loadOobNormalTexture();
  }
  activeSkyUniforms.uOobNormalStrength.value = Math.max(0.0, Math.min(1.0, Number(c.oobNormalStrength) ?? 0.35));
  activeSkyUniforms.uOobNormalTileScale.value = Math.max(0.5, Number(c.oobNormalTileScale) || 6.0);
}

subscribeSkyboxConfig(syncActiveSkyUniforms);

export function updateSkyboxConfig(patch = {}) {
  return updateSkyboxConfigState(patch);
}

/**
 * Per-frame lightweight skybox uniform updater for animated cloud drift and scene-sun tracking.
 */
export function updateSkyboxFrame(delta = 0, sceneSunDir = null) {
  if (sceneSunDir && sceneSunDir.isVector3) {
    latestSceneSunDir.copy(sceneSunDir).normalize();
  }
  if (!activeSkyUniforms) return;
  const c = skyboxRuntimeConfig;
  if (c.cloudOverlayEnabled || c.oobNormalEnabled) {
    skyAccumulatedTime += Math.max(0, Math.min(0.1, Number(delta) || 0));
    const cloudSpeedRad = (((Number(c.cloudOverlayScrollSpeed) || 0) * Math.PI) / 180) * skyAccumulatedTime;
    activeSkyUniforms.uCloudScrollRad.value = cloudSpeedRad;
    activeSkyUniforms.uOobScrollOffset.value = skyAccumulatedTime * (Number(c.oobNormalScrollSpeed) || 0);
  }
  if (c.coronaEnabled && c.coronaFollowSceneSun) {
    updateCoronaSunBasisUniforms(activeSkyUniforms, c);
  }
}

/**
 * Creates stadium dome sky shader mesh supporting both Hemisphere and Full-Sphere rendering pipelines.
 */
export function createStadiumDomeSky() {
  const c = skyboxRuntimeConfig;
  const activePreset = resolveSkyboxPreset(c.presetId || c.texturePath, c.skyCategory);
  const isFullSphere = (c.skyCategory || activePreset.category) === 'full-sphere';
  const targetPath = c.texturePath || activePreset.path;
  const skyTex = loadSkyboxTexture(targetPath);
  const useTex = c.useTexture !== undefined ? Boolean(c.useTexture) : c.mode === 'texture';
  const rotDeg = c.rotationDeg ?? c.textureRotationDeg ?? 0;
  const expVal = c.exposure ?? c.textureExposure ?? 0.6;

  // Placeholder 1x1 black texture until optional auxiliary layers are toggled on
  const emptyTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  emptyTex.needsUpdate = true;

  const uniforms = {
    uSkyMap: { value: skyTex },
    uSkyCategory: { value: isFullSphere ? 1.0 : 0.0 },
    uUseTexture: { value: useTex ? 1.0 : 0.0 },
    uTextureScaleU: { value: Number(c.textureScaleU) || 1.0 },
    uRotationRad: { value: ((Number(rotDeg) || 0) * Math.PI) / 180 },
    uExposure: { value: Number(expVal) ?? 0.6 },
    uUpperVerticalStretch: { value: Math.max(0.2, Number(c.upperVerticalStretch) || 1.0) },
    uContrastBalance: { value: Math.max(0.0, Math.min(1.0, Number(c.contrastBalance) ?? 0.15)) },
    uContrastMidpoint: { value: Math.max(0.05, Math.min(1.0, Number(c.contrastMidpoint) ?? 0.15)) },
    uHorizonOffset: { value: Number(c.horizonOffset) ?? 0.0 },
    uHorizonBlendWidth: { value: Math.max(0.002, Number(c.horizonBlendWidth) ?? 0.03) },
    uHorizonHazeStrength: { value: Number(c.horizonHazeStrength) ?? 0.0 },
    uGroundSampleHorizon: { value: c.groundSampleHorizon !== false ? 1.0 : 0.0 },
    uGroundGradientRange: { value: Math.max(0.01, Number(c.groundGradientRange) ?? 0.95) },
    uGroundHorizonStrength: { value: Math.max(0.0, Math.min(1.0, Number(c.groundHorizonStrength) ?? 0.8)) },
    uHorizonColor: { value: new THREE.Color(c.horizonColor || '#1a202c') },
    uGroundColor: { value: new THREE.Color(c.groundColor || '#000000') },
    uZenithColor: { value: new THREE.Color(c.zenithColor || '#0c220d') },
    uMiddleColor: { value: new THREE.Color(c.middleColor || '#476649') },

    // Full-Sphere lower hemisphere controls
    uFullSphereLowerVOffset: { value: Math.max(0.0, Math.min(0.48, Number(c.fullSphereLowerVOffset) ?? 0.04)) },
    uFullSphereLowerVerticalStretch: { value: Math.max(0.2, Number(c.fullSphereLowerVerticalStretch) || 1.0) },
    uFullSphereLowerCutoffElev: { value: Math.max(0.0, Math.min(1.0, Number(c.fullSphereLowerCutoffElev) ?? 0.18)) },
    uFullSphereLowerFadeRange: { value: Math.max(0.01, Math.min(1.0, Number(c.fullSphereLowerFadeRange) ?? 0.45)) },
    uFullSphereLowerDimming: { value: Math.max(0.0, Math.min(1.0, Number(c.fullSphereLowerDimming) ?? 0.25)) },
    uFullSphereLowerSampleHorizon: { value: c.fullSphereLowerSampleHorizon ? 1.0 : 0.0 },

    // Auxiliary Layer 1: Sun Corona & Glow
    uCoronaEnabled: { value: c.coronaEnabled ? 1.0 : 0.0 },
    uCoronaMap: { value: c.coronaEnabled ? loadCoronaTexture() : emptyTex },
    uSunGlowMap: { value: c.coronaEnabled ? loadSunGlowTexture() : emptyTex },
    uSunDir: { value: new THREE.Vector3(1, 0.06, 0).normalize() },
    uSunRight: { value: new THREE.Vector3(0, 0, 1) },
    uSunUp: { value: new THREE.Vector3(0, 1, 0) },
    uCoronaSize: { value: Math.max(0.02, Number(c.coronaSize) || 0.16) },
    uCoronaIntensity: { value: Math.max(0.0, Number(c.coronaIntensity) ?? 1.25) },
    uSunGlowSize: { value: Math.max(0.04, Number(c.sunGlowSize) || 0.42) },
    uSunGlowIntensity: { value: Math.max(0.0, Number(c.sunGlowIntensity) ?? 0.65) },
    uSunGlowColor: { value: new THREE.Color(c.sunGlowColor || '#ffaa44') },

    // Auxiliary Layer 2: Horizon Cumulus Overlay
    uCloudOverlayEnabled: { value: c.cloudOverlayEnabled ? 1.0 : 0.0 },
    uCloudOverlayMap: { value: c.cloudOverlayEnabled ? loadCloudOverlayTexture() : emptyTex },
    uCloudOverlayOpacity: { value: Math.max(0.0, Math.min(1.0, Number(c.cloudOverlayOpacity) ?? 0.45)) },
    uCloudOverlayScaleU: { value: Number(c.cloudOverlayScaleU) || 1.0 },
    uCloudOverlayElevationOffset: { value: Number(c.cloudOverlayElevationOffset) ?? 0.0 },
    uCloudScrollRad: { value: 0.0 },

    // Auxiliary Layer 3: OOB Cloud-Sea Normal
    uOobNormalEnabled: { value: c.oobNormalEnabled ? 1.0 : 0.0 },
    uOobNormalMap: { value: c.oobNormalEnabled ? loadOobNormalTexture() : emptyTex },
    uOobNormalStrength: { value: Math.max(0.0, Math.min(1.0, Number(c.oobNormalStrength) ?? 0.35)) },
    uOobNormalTileScale: { value: Math.max(0.5, Number(c.oobNormalTileScale) || 6.0) },
    uOobScrollOffset: { value: 0.0 },
  };

  updateCoronaSunBasisUniforms(uniforms, c);
  activeSkyUniforms = uniforms;

  const fragmentShader = /* glsl */ `
    ${SKYBOX_COMMON_GLSL_HEADER}
    ${HEMISPHERE_SKY_GLSL}
    ${FULL_SPHERE_SKY_GLSL}

    void main() {
      vec3 dir = normalize(vSkyDirection);
      float elev = dir.y - uHorizonOffset;
      float bw = max(0.002, uHorizonBlendWidth);

      float phi = atan(dir.z, dir.x) + uRotationRad;
      // RepeatWrapping handles u wrap in hardware without fract() derivative spike
      float u = phi * INV_TWO_PI * uTextureScaleU + 0.5;

      vec3 finalColor;
      if (uSkyCategory > 0.5) {
        finalColor = evaluateFullSphereSky(dir, elev, bw, u);
      } else {
        finalColor = evaluateHemisphereSky(dir, elev, bw, u);
      }

      gl_FragColor = vec4(finalColor, 1.0);
      #include <colorspace_fragment>
    }
  `;

  const skyMat = new THREE.ShaderMaterial({
    name: 'Stadium / modular hemisphere & full-sphere skybox',
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    uniforms,
    vertexShader: SKYBOX_VERTEX_SHADER,
    fragmentShader,
  });

  const skyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(28000, 64, 32),
    skyMat
  );
  skyMesh.name = 'Stadium / open blue sky';
  skyMesh.visible = c.enabled !== false;
  skyMesh.frustumCulled = false;
  skyMesh.userData.bloomOccluder = false;
  skyMesh.renderOrder = -1000;
  return skyMesh;
}
