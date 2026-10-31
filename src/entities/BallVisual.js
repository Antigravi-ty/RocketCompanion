import * as THREE from 'three';
export const CLASSIC_BALL_RADIUS = 95;



export function createGeodesicBallGeometry(patternColor = null) {
  const {
    BufferGeometry,
    BufferAttribute,
    IcosahedronGeometry,
    Vector3,
    Color
  } = THREE;

  const baseIco = new IcosahedronGeometry(1, 0);
  const posAttr = baseIco.getAttribute("position");
  const uniqueVertices = [];
  const vertexLookup = new Map();
  const faces = [];

  if (posAttr) {
    for (let i = 0; i < posAttr.count; i += 3) {
      const face = [];
      for (let cornerIdx = 0; cornerIdx < 3; cornerIdx++) {
        const v = new Vector3().fromBufferAttribute(posAttr, i + cornerIdx);
        const key = v.toArray().map(val => Number(val).toFixed(6)).join(",");
        if (!vertexLookup.has(key)) {
          vertexLookup.set(key, uniqueVertices.length);
          uniqueVertices.push(v);
        }
        face.push(vertexLookup.get(key));
      }
      faces.push(face);
    }
  }
  baseIco.dispose();

  const lerpNorm = (aIdx, bIdx) => uniqueVertices[aIdx].clone().lerp(uniqueVertices[bIdx], 1 / 3).normalize();
  const adjacent = uniqueVertices.map(() => new Set());
  const panels = [];

  for (const [a, b, c] of faces) {
    adjacent[a].add(b).add(c);
    adjacent[b].add(a).add(c);
    adjacent[c].add(a).add(b);
    panels.push({
      corners: [lerpNorm(a, b), lerpNorm(b, a), lerpNorm(b, c), lerpNorm(c, b), lerpNorm(c, a), lerpNorm(a, c)],
      black: false
    });
  }

  for (let i = 0; i < uniqueVertices.length; i++) {
    const v = uniqueVertices[i].clone().normalize();
    const up = (Math.abs(v.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).cross(v).normalize();
    const right = v.clone().cross(up);
    const sorted = [...adjacent[i]].map(adj => lerpNorm(i, adj));
    sorted.sort((p1, p2) => Math.atan2(p1.dot(right), p1.dot(up)) - Math.atan2(p2.dot(right), p2.dot(up)));
    panels.push({
      corners: sorted,
      black: true
    });
  }

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  const whiteColor = new Color(16052713);
  const darkColor = patternColor != null ? new Color(patternColor) : new Color(1054498);
  const seamColor = new Color(3423560);

  const addVertex = (vNorm, radius, col) => {
    const idx = positions.length / 3;
    positions.push(vNorm.x * radius, vNorm.y * radius, vNorm.z * radius);
    normals.push(vNorm.x, vNorm.y, vNorm.z);
    colors.push(col.r, col.g, col.b);
    return idx;
  };

  for (const { corners, black } of panels) {
    const center = corners.reduce((acc, cur) => acc.add(cur), new Vector3()).normalize();
    const panelColor = black ? darkColor : whiteColor;
    const centerIdx = addVertex(center, CLASSIC_BALL_RADIUS, panelColor);
    const interpolated = [];

    for (let i = 0; i < corners.length; i++) {
      for (let step = 0; step < 3; step++) {
        interpolated.push(corners[i].clone().lerp(corners[(i + 1) % corners.length], step / 3).normalize());
      }
    }

    let previousRing = null;
    for (const radiusFraction of [0.3, 0.6, 0.85, 0.975, 1.0]) {
      const isRim = radiusFraction === 1.0;
      const currentRing = interpolated.map(pt =>
        addVertex(
          center.clone().lerp(pt, radiusFraction).normalize(),
          CLASSIC_BALL_RADIUS - (isRim ? 0.7 : 0),
          isRim ? seamColor : panelColor
        )
      );

      for (let i = 0; i < currentRing.length; i++) {
        const next = (i + 1) % currentRing.length;
        if (previousRing) {
          indices.push(previousRing[i], currentRing[i], currentRing[next], previousRing[i], currentRing[next], previousRing[next]);
        } else {
          indices.push(centerIdx, currentRing[i], currentRing[next]);
        }
      }
      previousRing = currentRing;
    }
  }

  const geometry = new BufferGeometry();
  geometry.name = "Classic ball / rounded panels";
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  geometry.userData.panels = {
    pentagons: panels.filter(panel => panel.corners.length === 5).length,
    hexagons: panels.filter(panel => panel.corners.length === 6).length
  };

  return geometry;
}

export function createClassicBall(patternColor = null) {
  const { Mesh, Group, MeshStandardMaterial } = THREE;
  const geometry = createGeodesicBallGeometry(patternColor);
  const material = new MeshStandardMaterial({
    name: "Classic ball / matte leather",
    vertexColors: true
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "Classic ball";
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const group = new Group();
  group.name = "ball";
  group.add(mesh);
  return group;
}

import { getThemeMaterial, isMultiThemeMaterial } from '../effects/ThemeMaterialPipeline.js';
import {
  STANDARD_GOAL_VOLUME_BOX,
} from '../physics/RocketSimConstants.js';
import {
   getGoalVolumeBoxForPreset,
  getBallGoalRimFxConfig,
  registerGoalVolumeTunerApplier,
} from '../ui-core/config/goalVolumeTunerConfig.js';
import {
  DEFAULT_BALL_VISUAL_CONFIG,
  ballVisualRuntimeConfig,
  getBallVisualConfig,
  subscribeBallVisualConfig,
  registerBallVisualApplier,
} from '../ui-core/config/ballVisualConfig.js';

const activeBallCompositeGroups = new Set();

function resolveEffectiveBallOpacity(config) {
  if (typeof config?.temporaryOpacityOverride === 'number' && Number.isFinite(config.temporaryOpacityOverride)) {
    return Math.max(0, Math.min(1, config.temporaryOpacityOverride));
  }
  return Math.max(0, Math.min(1, Number(config?.opacity) ?? 1.0));
}

const ballGoalUniforms = {
  uGoalEffectEnabled: { value: 1.0 },
  uGoalPlaneMinY: { value: STANDARD_GOAL_VOLUME_BOX.minY },
  uGoalPlaneMaxY: { value: STANDARD_GOAL_VOLUME_BOX.maxY },
  uGoalHalfWidthX: { value: STANDARD_GOAL_VOLUME_BOX.halfWidthX },
  uGoalMaxZ: { value: STANDARD_GOAL_VOLUME_BOX.maxZ },
  uGoalTime: { value: 0.0 },
  uGoalPenetration: { value: 0.0 },
  uGoalJitterWorldOffset: { value: new THREE.Vector3(0, 0, 0) },
  uGoalRimRange: { value: new THREE.Vector2(0.60, 1.00) },
  uGoalRimBezier: { value: new THREE.Vector4(0.75, 0.01, 1.0, 0.24) },
  uGoalRimColor: { value: new THREE.Color('#989898') },
  uGoalRimIntensity: { value: 1.0 },
  uGoalCoreColor: { value: new THREE.Color('#2d2d2d') },
  uGoalCoreBrightness: { value: 1.0 },
  uGoalSeamParams: { value: new THREE.Vector2(10.0, 0.8) },
};

function syncBallGoalRimUniforms() {
  const rimCfg = getBallGoalRimFxConfig();
  if (!rimCfg) return;
  const innerFrac = Math.max(0.0, Math.min(0.999, (Number(rimCfg.innerStartPct) ?? 60) / 100));
  const outerFrac = Math.max(innerFrac + 0.001, Math.min(1.0, (Number(rimCfg.outerEndPct) ?? 100) / 100));
  ballGoalUniforms.uGoalRimRange.value.set(innerFrac, outerFrac);
  ballGoalUniforms.uGoalRimBezier.value.set(
    Math.max(0.0, Math.min(1.0, Number(rimCfg.bezierP1X) ?? 0.75)),
    Number.isFinite(Number(rimCfg.bezierP1Y)) ? Number(rimCfg.bezierP1Y) : 0.01,
    Math.max(0.0, Math.min(1.0, Number(rimCfg.bezierP2X) ?? 1.0)),
    Number.isFinite(Number(rimCfg.bezierP2Y)) ? Number(rimCfg.bezierP2Y) : 0.24
  );
  try {
    ballGoalUniforms.uGoalRimColor.value.set(rimCfg.rimColor || '#989898');
  } catch {
    ballGoalUniforms.uGoalRimColor.value.set('#989898');
  }
  ballGoalUniforms.uGoalRimIntensity.value = Math.max(0.0, Number(rimCfg.rimIntensity) ?? 1.0);
  try {
    ballGoalUniforms.uGoalCoreColor.value.set(rimCfg.coreColor || '#2d2d2d');
  } catch {
    ballGoalUniforms.uGoalCoreColor.value.set('#2d2d2d');
  }
  ballGoalUniforms.uGoalCoreBrightness.value = Math.max(0.0, Number(rimCfg.coreBrightness) ?? 1.0);
  ballGoalUniforms.uGoalSeamParams.value.set(
    Math.max(0.0, Number(rimCfg.seamWidthUu) ?? 10.0),
    Math.max(0.0, Number(rimCfg.seamIntensity) ?? 0.8)
  );
}

syncBallGoalRimUniforms();
registerGoalVolumeTunerApplier(() => {
  syncBallGoalRimUniforms();
});

function attachBallGoalShader(mat) {
  if (!mat || mat.userData?.hasBallGoalShader) return;
  mat.userData = mat.userData || {};
  mat.userData.hasBallGoalShader = true;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGoalEffectEnabled = ballGoalUniforms.uGoalEffectEnabled;
    shader.uniforms.uGoalPlaneMinY = ballGoalUniforms.uGoalPlaneMinY;
    shader.uniforms.uGoalPlaneMaxY = ballGoalUniforms.uGoalPlaneMaxY;
    shader.uniforms.uGoalHalfWidthX = ballGoalUniforms.uGoalHalfWidthX;
    shader.uniforms.uGoalMaxZ = ballGoalUniforms.uGoalMaxZ;
    shader.uniforms.uGoalTime = ballGoalUniforms.uGoalTime;
    shader.uniforms.uGoalPenetration = ballGoalUniforms.uGoalPenetration;
    shader.uniforms.uGoalJitterWorldOffset = ballGoalUniforms.uGoalJitterWorldOffset;
    shader.uniforms.uGoalRimRange = ballGoalUniforms.uGoalRimRange;
    shader.uniforms.uGoalRimBezier = ballGoalUniforms.uGoalRimBezier;
    shader.uniforms.uGoalRimColor = ballGoalUniforms.uGoalRimColor;
    shader.uniforms.uGoalRimIntensity = ballGoalUniforms.uGoalRimIntensity;
    shader.uniforms.uGoalCoreColor = ballGoalUniforms.uGoalCoreColor;
    shader.uniforms.uGoalCoreBrightness = ballGoalUniforms.uGoalCoreBrightness;
    shader.uniforms.uGoalSeamParams = ballGoalUniforms.uGoalSeamParams;

    shader.vertexShader =
      `varying vec3 vBallWorldPos;\nvarying vec3 vBallViewNormal;\nvarying vec3 vBallViewDir;\nuniform vec3 uGoalJitterWorldOffset;\n` +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 ballWorldPosition = modelMatrix * mvPosition;
ballWorldPosition.xyz += uGoalJitterWorldOffset;
vBallWorldPos = ballWorldPosition.xyz;
mvPosition = viewMatrix * ballWorldPosition;
vBallViewNormal = normalize( normalMatrix * objectNormal );
vBallViewDir = normalize( -mvPosition.xyz );
gl_Position = projectionMatrix * mvPosition;`
      );

    shader.fragmentShader =
      `varying vec3 vBallWorldPos;
varying vec3 vBallViewNormal;
varying vec3 vBallViewDir;
uniform float uGoalEffectEnabled;
uniform float uGoalPlaneMinY;
uniform float uGoalPlaneMaxY;
uniform float uGoalHalfWidthX;
uniform float uGoalMaxZ;
uniform float uGoalTime;
uniform float uGoalPenetration;
uniform vec2 uGoalRimRange;
uniform vec4 uGoalRimBezier;
uniform vec3 uGoalRimColor;
uniform float uGoalRimIntensity;
uniform vec3 uGoalCoreColor;
uniform float uGoalCoreBrightness;
uniform vec2 uGoalSeamParams;

float evalGoalRimCubicBezier01(float t, vec4 bez) {
  float x = clamp(t, 0.0, 1.0);
  float x1 = clamp(bez.x, 0.0, 1.0);
  float y1 = bez.y;
  float x2 = clamp(bez.z, 0.0, 1.0);
  float y2 = bez.w;
  float u = x;
  for (int i = 0; i < 5; i++) {
    float om = 1.0 - u;
    float bx = 3.0 * om * om * u * x1 + 3.0 * om * u * u * x2 + u * u * u - x;
    float dbx = 3.0 * om * om * x1 + 6.0 * om * u * (x2 - x1) + 3.0 * u * u * (1.0 - x2);
    if (abs(dbx) < 1e-4) break;
    u = clamp(u - bx / dbx, 0.0, 1.0);
  }
  float om = 1.0 - u;
  return 3.0 * om * om * u * y1 + 3.0 * om * u * u * y2 + u * u * u;
}
` +
      shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
if (uGoalEffectEnabled > 0.5 && uGoalPenetration > 0.001) {
  float absZ = abs(vBallWorldPos.z);
  float inMouthX = 1.0 - smoothstep(uGoalHalfWidthX - 6.0, uGoalHalfWidthX + 6.0, abs(vBallWorldPos.x));
  float inMouthY = 1.0 - smoothstep(uGoalMaxZ - 6.0, uGoalMaxZ + 6.0, vBallWorldPos.y);
  float inDepthBack = 1.0 - smoothstep(uGoalPlaneMaxY - 8.0, uGoalPlaneMaxY + 8.0, absZ);
  float sliceDist = absZ - uGoalPlaneMinY;
  float insideMask = smoothstep(-2.0, 2.0, sliceDist) * inMouthX * inMouthY * inDepthBack;
  if (insideMask > 0.001) {
    vec3 viewDir = normalize(vBallViewDir);
    vec3 surfNormal = normalize(vBallViewNormal);
    float ndotv = clamp(abs(dot(surfNormal, viewDir)), 0.0, 1.0);
    float radialPct = sqrt(max(0.0, 1.0 - ndotv * ndotv));
    float innerStart = uGoalRimRange.x;
    float outerEnd = max(innerStart + 0.001, uGoalRimRange.y);
    float tRim = clamp((radialPct - innerStart) / (outerEnd - innerStart), 0.0, 1.0);
    float outerRim = clamp(evalGoalRimCubicBezier01(tRim, uGoalRimBezier), 0.0, 1.0);
    float planeSeam = (uGoalSeamParams.x > 0.01 && uGoalSeamParams.y > 0.001)
      ? exp(-abs(sliceDist) / max(0.1, uGoalSeamParams.x)) * uGoalSeamParams.y
      : 0.0;
    float rimGlow = clamp(max(outerRim, planeSeam), 0.0, 1.0);
    vec3 darkCore = uGoalCoreColor * uGoalCoreBrightness;
    vec3 brightRim = uGoalRimColor * uGoalRimIntensity;
    vec3 goalBallColor = mix(darkCore, brightRim, rimGlow);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, goalBallColor, insideMask);
  }
}`
      );
  };
  mat.customProgramCacheKey = () => 'ball-goal-darken-jitter-v4';
  mat.needsUpdate = true;
}

function applyConfigToSingleMaterial(mat, config) {
  if (!mat) return;
  attachBallGoalShader(mat);
  const opacity = resolveEffectiveBallOpacity(config);
  const isTransparent = opacity < 0.999;
  const targetDepthWrite = isTransparent ? Boolean(config.depthWriteWhenTransparent) : true;
  const targetSide =
    isTransparent && config.doubleSideWhenTransparent ? THREE.DoubleSide : THREE.FrontSide;
  const targetWireframe = Boolean(config.wireframe);

  const needsShaderRecompile =
    mat.transparent !== isTransparent ||
    mat.side !== targetSide;

  mat.transparent = isTransparent;
  mat.opacity = opacity;
  mat.depthWrite = targetDepthWrite;
  mat.side = targetSide;
  mat.wireframe = targetWireframe;
  if (needsShaderRecompile) {
    mat.needsUpdate = true;
  }
}

export function applyBallVisualConfigToObject(ballRoot, config = ballVisualRuntimeConfig, indicatorRings = []) {
  const rimCfg = getBallGoalRimFxConfig();
  ballGoalUniforms.uGoalEffectEnabled.value =
    config.goalDarkenJitterEnabled !== false && rimCfg?.enabled !== false ? 1.0 : 0.0;
  if (ballRoot) {
    const effOpacity = resolveEffectiveBallOpacity(config);
    ballRoot.visible = config.visible !== false && effOpacity > 0.001;
    ballRoot.traverse?.((node) => {
      if (!node.isMesh || !node.material) return;
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) {
        applyConfigToSingleMaterial(m, config);
        if (isMultiThemeMaterial(m)) {
          applyConfigToSingleMaterial(getThemeMaterial(m, 'arcade'), config);
          applyConfigToSingleMaterial(getThemeMaterial(m, 'realistic'), config);
        }
      }
    });
  }

  if (Array.isArray(indicatorRings)) {
    const ringAlpha = Math.max(0, Math.min(1, Number(config.indicatorRingOpacity) ?? 0.2));
    for (const ring of indicatorRings) {
      if (!ring) continue;
      ring.visible = ringAlpha > 0.001;
      if (ring.material) {
        ring.material.opacity = ringAlpha;
        ring.material.transparent = true;
      }
    }
  }
}

export function updateBallGoalEffect(ballGroup, isThrowback = false, delta = 0) {
  if (!ballGroup) return;
  const dt = Number.isFinite(delta) && delta > 0 ? Math.min(delta, 0.1) : 1 / 120;
  ballGoalUniforms.uGoalTime.value += dt;

  const box = getGoalVolumeBoxForPreset(isThrowback);
  ballGoalUniforms.uGoalPlaneMinY.value = box.minY;
  ballGoalUniforms.uGoalPlaneMaxY.value = box.maxY;
  ballGoalUniforms.uGoalHalfWidthX.value = box.halfWidthX;
  ballGoalUniforms.uGoalMaxZ.value = box.maxZ;

  syncBallGoalRimUniforms();
  const rimCfg = getBallGoalRimFxConfig();

  const enabled =
    ballVisualRuntimeConfig.goalDarkenJitterEnabled !== false &&
    rimCfg?.enabled !== false;
  ballGoalUniforms.uGoalEffectEnabled.value = enabled ? 1.0 : 0.0;
  if (!enabled) {
    ballGoalUniforms.uGoalPenetration.value = 0.0;
    ballGoalUniforms.uGoalJitterWorldOffset.value.set(0, 0, 0);
    return;
  }

  const pos = ballGroup.position;
  const xUu = pos.x;
  const zUu = pos.y;
  const absYUu = Math.abs(pos.z);
  const r = CLASSIC_BALL_RADIUS;

  const inMouth =
    Math.abs(xUu) < box.halfWidthX + r * 0.35 &&
    zUu > (box.minZ ?? 0.0) - r * 0.25 &&
    zUu < box.maxZ + r * 0.35 &&
    absYUu < box.maxY + r * 0.25;

  if (!inMouth || absYUu <= box.minY - r) {
    ballGoalUniforms.uGoalPenetration.value = 0.0;
    ballGoalUniforms.uGoalJitterWorldOffset.value.set(0, 0, 0);
    return;
  }

  const penetration = Math.max(0.0, Math.min(1.0, (absYUu - (box.minY - r)) / (2.0 * r)));
  ballGoalUniforms.uGoalPenetration.value = penetration;

  const jitterScale = Math.max(0.0, Number(rimCfg?.jitterAmplitude) ?? 1.0);
  const t = ballGoalUniforms.uGoalTime.value;
  const amp = (1.6 + 4.2 * penetration) * penetration * jitterScale;
  const jx = Math.sin(t * 137.0) * Math.cos(t * 59.0) * amp;
  const jy = Math.cos(t * 151.0) * Math.sin(t * 73.0) * amp;
  const jz = Math.sin(t * 179.0 + 1.3) * amp * 0.85;
  ballGoalUniforms.uGoalJitterWorldOffset.value.set(jx, jy, jz);
}

registerBallVisualApplier((config, ballRoot, indicatorRings) => {
  if (ballRoot) {
    applyBallVisualConfigToObject(ballRoot, config, indicatorRings);
  }
  for (const weakRef of activeBallCompositeGroups) {
    const group = weakRef.deref();
    if (group) {
      applyBallVisualConfigToObject(group, config);
    } else {
      activeBallCompositeGroups.delete(weakRef);
    }
  }
});

export async function loadBallAsset() {
  const compositeGroup = createClassicBall();

  const weakGroup = new WeakRef(compositeGroup);
  activeBallCompositeGroups.add(weakGroup);
  applyBallVisualConfigToObject(compositeGroup, ballVisualRuntimeConfig);

  return compositeGroup;
}
