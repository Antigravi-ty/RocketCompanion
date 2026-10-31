/**
 * DriftwoodsGroundShader
 * GLSL shader injection routines for Driftwoods ground markings, goal team coloring,
 * and Kaplanyan 2016 Geometric Specular Anti-Aliasing.
 */

export function injectSpecularAAShader(material, specularAAUniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSpecularAAStrength = specularAAUniforms.uSpecularAAStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uSpecularAAStrength;'
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        if (uSpecularAAStrength > 0.001) {
          vec3 dndu = dFdx(vNormal);
          vec3 dndv = dFdy(vNormal);
          float variance = uSpecularAAStrength * (dot(dndu, dndu) + dot(dndv, dndv));
          float kernelRoughness2 = min(2.0 * variance, 0.18);
          float filteredRoughness2 = clamp(roughnessFactor * roughnessFactor + kernelRoughness2, 0.0, 1.0);
          roughnessFactor = sqrt(filteredRoughness2);
        }`
      );
  };
  material.customProgramCacheKey = () => 'driftwoods-standard-specular-aa-v1';
}

const GOAL_DEPTH_MASK_GLSL_HELPERS = `
float evalGoalMaskCubicBezier01(float x, vec4 bz) {
  float cx = clamp(x, 0.0, 1.0);
  float p1x = clamp(bz.x, 0.0, 1.0);
  float p1y = bz.y;
  float p2x = clamp(bz.z, 0.0, 1.0);
  float p2y = bz.w;
  float t = cx;
  for (int i = 0; i < 5; i++) {
    float inv = 1.0 - t;
    float bx = 3.0 * inv * inv * t * p1x + 3.0 * inv * t * t * p2x + t * t * t - cx;
    float dbx = 3.0 * inv * inv * p1x + 6.0 * inv * t * (p2x - p1x) + 3.0 * t * t * (1.0 - p2x);
    if (abs(dbx) < 0.0001) break;
    t = clamp(t - bx / dbx, 0.0, 1.0);
  }
  float inv = 1.0 - t;
  return 3.0 * inv * inv * t * p1y + 3.0 * inv * t * t * p2y + t * t * t;
}

float computeGoalDepthMask(
  vec3 worldPos,
  vec3 camPos,
  float offsetUu,
  float gradDistUu,
  vec4 bezier
) {
  float sz = worldPos.z < 0.0 ? -1.0 : 1.0;
  float camDepth = camPos.z * sz;
  float fragDepth = abs(worldPos.z);
  float maskReachZ = camDepth + offsetUu;
  float rawT = clamp((maskReachZ - fragDepth) / max(1.0, gradDistUu), 0.0, 1.0);
  return clamp(evalGoalMaskCubicBezier01(rawT, bezier), 0.0, 1.0);
}
`;

export function injectGoalTeamShader(
  material,
  goalTeamUniforms,
  specularAAUniforms,
  occlusionUniforms,
  targetType = 'goalFrame',
  includeSpecularAA = false,
  occlusionPassMode = 'all'
) {
  const applyGoalOcclusion = targetType !== 'rampsUpperOuter' && Boolean(occlusionUniforms);

  material.onBeforeCompile = (shader) => {
    if (targetType === 'goalPosts') {
      shader.uniforms.uGoalUseTeamColor = goalTeamUniforms.uGoalPostsUseTeamColor;
      shader.uniforms.uGoalBlueColor = goalTeamUniforms.uGoalBlueColor;
      shader.uniforms.uGoalOrangeColor = goalTeamUniforms.uGoalOrangeColor;
    } else if (targetType === 'goalPostsGlow') {
      shader.uniforms.uGoalUseTeamColor = goalTeamUniforms.uGoalPostsGlowUseTeamColor;
      shader.uniforms.uGoalBlueColor = goalTeamUniforms.uGoalPostsGlowBlueColor;
      shader.uniforms.uGoalOrangeColor = goalTeamUniforms.uGoalPostsGlowOrangeColor;
    } else if (targetType === 'rampsUpperOuter') {
      shader.uniforms.uGoalUseTeamColor = goalTeamUniforms.uRampsUpperOuterUseTeamColor;
      shader.uniforms.uGoalBlueColor = goalTeamUniforms.uRampsUpperOuterBlueColor;
      shader.uniforms.uGoalOrangeColor = goalTeamUniforms.uRampsUpperOuterOrangeColor;
    } else if (targetType === 'goalNet') {
      shader.uniforms.uGoalUseTeamColor = goalTeamUniforms.uGoalNetUseTeamColor;
      shader.uniforms.uGoalBlueColor = goalTeamUniforms.uGoalBlueColor;
      shader.uniforms.uGoalOrangeColor = goalTeamUniforms.uGoalOrangeColor;
    } else {
      shader.uniforms.uGoalUseTeamColor = goalTeamUniforms.uGoalFrameUseTeamColor;
      shader.uniforms.uGoalBlueColor = goalTeamUniforms.uGoalBlueColor;
      shader.uniforms.uGoalOrangeColor = goalTeamUniforms.uGoalOrangeColor;
    }
    if (applyGoalOcclusion) {
      shader.uniforms.uOcclusionOpacity = occlusionUniforms.uOcclusionOpacity;
      shader.uniforms.uGoalDepthMaskEnabled = occlusionUniforms.uGoalDepthMaskEnabled;
      shader.uniforms.uGoalMaskOffsetUu = occlusionUniforms.uGoalMaskOffsetUu;
      shader.uniforms.uGoalMaskGradientDistanceUu = occlusionUniforms.uGoalMaskGradientDistanceUu;
      shader.uniforms.uGoalMaskBezier = occlusionUniforms.uGoalMaskBezier;
    }
    if (includeSpecularAA) {
      shader.uniforms.uSpecularAAStrength = specularAAUniforms.uSpecularAAStrength;
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vGoalWorldPos;'
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vGoalWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'uniform vec3 diffuse;',
        `uniform vec3 diffuse;
        varying vec3 vGoalWorldPos;
        uniform float uGoalUseTeamColor;
        uniform vec3 uGoalBlueColor;
        uniform vec3 uGoalOrangeColor;
        ${
          applyGoalOcclusion
            ? `uniform float uOcclusionOpacity;
        uniform float uGoalDepthMaskEnabled;
        uniform float uGoalMaskOffsetUu;
        uniform float uGoalMaskGradientDistanceUu;
        uniform vec4 uGoalMaskBezier;
        ${GOAL_DEPTH_MASK_GLSL_HELPERS}`
            : ''
        }
        ${includeSpecularAA ? 'uniform float uSpecularAAStrength;' : ''}`
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec3 goalBaseCol = (uGoalUseTeamColor > 0.5)
          ? (vGoalWorldPos.z < 0.0 ? uGoalBlueColor : uGoalOrangeColor)
          : diffuse;
        float goalEffectiveOpacity = opacity;
        ${
          applyGoalOcclusion
            ? `if (uGoalDepthMaskEnabled > 0.5) {
          float goalDepthMask = computeGoalDepthMask(
            vGoalWorldPos,
            cameraPosition,
            uGoalMaskOffsetUu,
            uGoalMaskGradientDistanceUu,
            uGoalMaskBezier
          );
          goalEffectiveOpacity *= mix(1.0, uOcclusionOpacity, goalDepthMask);
        }`
            : ''
        }
        ${
          applyGoalOcclusion && occlusionPassMode === 'opaque'
            ? 'if (goalEffectiveOpacity < 0.999) discard;'
            : applyGoalOcclusion && occlusionPassMode === 'transparent'
            ? 'if (goalEffectiveOpacity >= 0.999 || goalEffectiveOpacity <= 0.001) discard;'
            : ''
        }
        vec4 diffuseColor = vec4( goalBaseCol, goalEffectiveOpacity );`
      );

    if (targetType === 'goalPostsGlow') {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 totalEmissiveRadiance = emissive;',
        `vec3 totalEmissiveRadiance = (uGoalUseTeamColor > 0.5)
          ? (vGoalWorldPos.z < 0.0 ? uGoalBlueColor : uGoalOrangeColor) * emissive
          : emissive;`
      );
    }

    if (includeSpecularAA) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        if (uSpecularAAStrength > 0.001) {
          vec3 dndu = dFdx(vNormal);
          vec3 dndv = dFdy(vNormal);
          float variance = uSpecularAAStrength * (dot(dndu, dndu) + dot(dndv, dndv));
          float kernelRoughness2 = min(2.0 * variance, 0.18);
          float filteredRoughness2 = clamp(roughnessFactor * roughnessFactor + kernelRoughness2, 0.0, 1.0);
          roughnessFactor = sqrt(filteredRoughness2);
        }`
      );
    }
  };

  material.customProgramCacheKey = () =>
    `driftwoods-goal-team-${targetType}-${occlusionPassMode}-${
      material.isMeshLambertMaterial ? 'lambert' : 'standard'
    }-v6`;
}

export function injectWallPostTrimOcclusionShader(
  material,
  occlusionUniforms,
  specularAAUniforms,
  isRampsTrim = false,
  includeSpecularAA = false,
  occlusionPassMode = 'all'
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOcclusionOpacity = occlusionUniforms.uOcclusionOpacity;
    shader.uniforms.uWallExteriorOcclusionEnabled =
      occlusionUniforms.uWallExteriorOcclusionEnabled;
    shader.uniforms.uGoalDepthMaskEnabled = occlusionUniforms.uGoalDepthMaskEnabled;
    shader.uniforms.uGoalMaskOffsetUu = occlusionUniforms.uGoalMaskOffsetUu;
    shader.uniforms.uGoalMaskGradientDistanceUu = occlusionUniforms.uGoalMaskGradientDistanceUu;
    shader.uniforms.uGoalMaskBezier = occlusionUniforms.uGoalMaskBezier;
    if (includeSpecularAA) {
      shader.uniforms.uSpecularAAStrength = specularAAUniforms.uSpecularAAStrength;
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vOcclusionWorldPos;'
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vOcclusionWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'uniform vec3 diffuse;',
        `uniform vec3 diffuse;
        varying vec3 vOcclusionWorldPos;
        uniform float uOcclusionOpacity;
        uniform float uWallExteriorOcclusionEnabled;
        uniform float uGoalDepthMaskEnabled;
        uniform float uGoalMaskOffsetUu;
        uniform float uGoalMaskGradientDistanceUu;
        uniform vec4 uGoalMaskBezier;
        ${isRampsTrim ? GOAL_DEPTH_MASK_GLSL_HELPERS : ''}
        ${includeSpecularAA ? 'uniform float uSpecularAAStrength;' : ''}`
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `float occlusionFactor = 0.0;
        vec3 P = vOcclusionWorldPos;
        float ax = abs(P.x);
        float az = abs(P.z);
        if (uWallExteriorOcclusionEnabled > 0.5) {
          vec3 camPos = cameraPosition;
          float sx = P.x < 0.0 ? -1.0 : 1.0;
          float sz = P.z < 0.0 ? -1.0 : 1.0;
          float camY = camPos.y;

          float sideWallLimit = 4035.0 - max(0.0, camY - 1538.0) * 0.95 - max(0.0, 160.0 - camY) * 1.3;
          float sideOccluded = smoothstep(sideWallLimit - 30.0, sideWallLimit + 20.0, camPos.x * sx);

          float backWallLimit = 5060.0 - max(0.0, camY - 1538.0) * 0.95 - max(0.0, 160.0 - camY) * 1.3;
          float backOccluded = smoothstep(backWallLimit - 30.0, backWallLimit + 20.0, camPos.z * sz);

          float cornerWallLimit = 7970.0 - max(0.0, camY - 1538.0) * 1.35 - max(0.0, 160.0 - camY) * 1.8;
          float inCornerQuad = smoothstep(2000.0, 2400.0, camPos.x * sx) * smoothstep(3000.0, 3400.0, camPos.z * sz);
          float cornerDirect = inCornerQuad * smoothstep(cornerWallLimit - 40.0, cornerWallLimit + 20.0, camPos.x * sx + camPos.z * sz);
          float cornerFromSide = sideOccluded * smoothstep(2800.0, 3400.0, camPos.z * sz);
          float cornerFromBack = backOccluded * smoothstep(1800.0, 2400.0, camPos.x * sx);
          float cornerOccluded = max(cornerDirect, max(cornerFromSide, cornerFromBack));

          sideOccluded = max(sideOccluded, cornerDirect * smoothstep(2800.0, 3400.0, az));
          backOccluded = max(backOccluded, cornerDirect * smoothstep(1800.0, 2400.0, ax));

          float wCorner = smoothstep(2560.0, 2600.0, ax) * smoothstep(3580.0, 3620.0, az);
          float wBack = smoothstep(3580.0, 3620.0, az);
          float wallOccluded = mix(mix(sideOccluded, backOccluded, wBack), cornerOccluded, wCorner);

          float ceilOccluded = smoothstep(2000.0, 2035.0, camY) * smoothstep(2020.0, 2040.0, P.y);
          occlusionFactor = max(wallOccluded, ceilOccluded);
        }
        ${
          isRampsTrim
            ? `if (uGoalDepthMaskEnabled > 0.5 && ax < 1000.0 && az > 4930.0) {
          float goalTrimRegion = smoothstep(995.0, 975.0, ax) * smoothstep(4930.0, 4950.0, az);
          float goalDepthMask = computeGoalDepthMask(
            P,
            cameraPosition,
            uGoalMaskOffsetUu,
            uGoalMaskGradientDistanceUu,
            uGoalMaskBezier
          );
          occlusionFactor = max(occlusionFactor, goalDepthMask * goalTrimRegion);
        }`
            : ''
        }
        float effectiveOpacity = opacity * mix(1.0, uOcclusionOpacity, clamp(occlusionFactor, 0.0, 1.0));
        ${
          occlusionPassMode === 'opaque'
            ? 'if (effectiveOpacity < 0.999) discard;'
            : occlusionPassMode === 'transparent'
            ? 'if (effectiveOpacity >= 0.999 || effectiveOpacity <= 0.001) discard;'
            : ''
        }
        vec4 diffuseColor = vec4( diffuse, effectiveOpacity );`
      );

    if (includeSpecularAA) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        if (uSpecularAAStrength > 0.001) {
          vec3 dndu = dFdx(vNormal);
          vec3 dndv = dFdy(vNormal);
          float variance = uSpecularAAStrength * (dot(dndu, dndu) + dot(dndv, dndv));
          float kernelRoughness2 = min(2.0 * variance, 0.18);
          float filteredRoughness2 = clamp(roughnessFactor * roughnessFactor + kernelRoughness2, 0.0, 1.0);
          roughnessFactor = sqrt(filteredRoughness2);
        }`
      );
    }
  };

  material.customProgramCacheKey = () =>
    `driftwoods-wall-occlusion-${isRampsTrim ? 'trim' : 'posts'}-${occlusionPassMode}-${
      material.isMeshLambertMaterial ? 'lambert' : 'standard'
    }-v3`;
}

export function injectGroundDetailShader(material, groundUniforms, wallFxUniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGroundMode = groundUniforms.uGroundMode;
    shader.uniforms.uQ1BakedReady = groundUniforms.uQ1BakedReady;
    shader.uniforms.uBakedBlueGroundMap = groundUniforms.uBakedBlueGroundMap;
    shader.uniforms.uBakedOrangeGroundMap = groundUniforms.uBakedOrangeGroundMap;
    shader.uniforms.uQ1GroundMap = groundUniforms.uQ1GroundMap;
    shader.uniforms.uQ1UvScale = groundUniforms.uQ1UvScale;
    shader.uniforms.uQ1UvOffset = groundUniforms.uQ1UvOffset;
    shader.uniforms.uGroundColor = groundUniforms.uGroundColor;
    shader.uniforms.uLineColor = groundUniforms.uLineColor;
    shader.uniforms.uLineThreshold = groundUniforms.uLineThreshold;
    shader.uniforms.uLineSmoothness = groundUniforms.uLineSmoothness;
    shader.uniforms.uOrigLineThreshold = groundUniforms.uOrigLineThreshold;
    shader.uniforms.uOrigLineSmoothness = groundUniforms.uOrigLineSmoothness;
    shader.uniforms.uL0Color = groundUniforms.uL0Color;
    shader.uniforms.uL1Color = groundUniforms.uL1Color;
    shader.uniforms.uL2Color = groundUniforms.uL2Color;
    shader.uniforms.uL3Color = groundUniforms.uL3Color;
    shader.uniforms.uL4Color = groundUniforms.uL4Color;
    shader.uniforms.uL5Color = groundUniforms.uL5Color;
    shader.uniforms.uL6Color = groundUniforms.uL6Color;
    shader.uniforms.uL4UseTeamColor = groundUniforms.uL4UseTeamColor;
    shader.uniforms.uL5UseTeamColor = groundUniforms.uL5UseTeamColor;
    shader.uniforms.uL6UseTeamColor = groundUniforms.uL6UseTeamColor;
    shader.uniforms.uBlueTeamColor = wallFxUniforms.uBlueTeamColor;
    shader.uniforms.uOrangeTeamColor = wallFxUniforms.uOrangeTeamColor;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vGroundWorldPos;'
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vGroundWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'uniform vec3 diffuse;',
        `uniform vec3 diffuse;
        varying vec3 vGroundWorldPos;
        uniform float uGroundMode;
        uniform float uQ1BakedReady;
        uniform sampler2D uBakedBlueGroundMap;
        uniform sampler2D uBakedOrangeGroundMap;
        uniform sampler2D uQ1GroundMap;
        uniform vec2 uQ1UvScale;
        uniform vec2 uQ1UvOffset;
        uniform vec3 uGroundColor;
        uniform vec3 uLineColor;
        uniform float uLineThreshold;
        uniform float uLineSmoothness;
        uniform float uOrigLineThreshold;
        uniform float uOrigLineSmoothness;
        uniform vec3 uL0Color;
        uniform vec3 uL1Color;
        uniform vec3 uL2Color;
        uniform vec3 uL3Color;
        uniform vec3 uL4Color;
        uniform vec3 uL5Color;
        uniform vec3 uL6Color;
        uniform float uL4UseTeamColor;
        uniform float uL5UseTeamColor;
        uniform float uL6UseTeamColor;
        uniform vec3 uBlueTeamColor;
        uniform vec3 uOrangeTeamColor;`
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          if (uGroundMode > 0.5) {
            vec2 q1Uv = vec2(vGroundWorldPos.x / 4096.0, vGroundWorldPos.z / 6000.0) * uQ1UvScale + uQ1UvOffset;
            const vec2 Q1_TEX_SIZE = vec2(2048.0, 3000.0);
            vec2 uvDx = dFdx(q1Uv * Q1_TEX_SIZE);
            vec2 uvDy = dFdy(q1Uv * Q1_TEX_SIZE);
            float footprintTexels = max(length(uvDx), length(uvDy));

            if (uQ1BakedReady > 0.5) {
              vec4 bakedDecal;
              if (vGroundWorldPos.z < -40.0) {
                bakedDecal = texture2D(uBakedBlueGroundMap, q1Uv);
              } else if (vGroundWorldPos.z > 40.0) {
                bakedDecal = texture2D(uBakedOrangeGroundMap, q1Uv);
              } else {
                vec4 blueSample = texture2D(uBakedBlueGroundMap, q1Uv);
                vec4 orangeSample = texture2D(uBakedOrangeGroundMap, q1Uv);
                bakedDecal = mix(blueSample, orangeSample, smoothstep(-40.0, 40.0, vGroundWorldPos.z));
              }
              float rawCov = bakedDecal.a;
              float aaHalfWidth = max(uLineSmoothness, fwidth(rawCov) * 0.75);
              float sharpCov = smoothstep(
                clamp(uLineThreshold - aaHalfWidth, 0.0, 0.98),
                clamp(uLineThreshold + aaHalfWidth, 0.02, 1.0),
                rawCov
              );
              float minificationBlend = smoothstep(0.75, 1.85, footprintTexels);
              float thresholdScale = clamp((0.5 - uLineThreshold) * 1.15 + 1.0, 0.35, 1.85);
              float integratedCov = clamp(rawCov * thresholdScale, 0.0, 1.0);
              float finalMask = mix(sharpCov, integratedCov, minificationBlend);
              diffuseColor.rgb = mix(uL0Color, bakedDecal.rgb, finalMask);
            } else {
              float smoothGray = texture2D(uQ1GroundMap, q1Uv).r;
              if (smoothGray <= 0.002) {
                diffuseColor.rgb = uL0Color;
              } else {
                const vec2 Q1_INV_SIZE = vec2(1.0 / 2048.0, 1.0 / 3000.0);
                vec2 baseTexelUv = (floor(fract(abs(q1Uv)) * Q1_TEX_SIZE) + 0.5) * Q1_INV_SIZE;
                float peakGray = smoothGray;
                if (peakGray < 0.788235) {
                  for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                      float g = texture2D(uQ1GroundMap, baseTexelUv + vec2(float(dx), float(dy)) * Q1_INV_SIZE).r;
                      peakGray = max(peakGray, g);
                    }
                  }
                }
                vec3 layerColor = uL0Color;
                if (peakGray < 0.070588) {
                  layerColor = uL0Color;
                } else if (peakGray < 0.215686) {
                  layerColor = uL1Color;
                } else if (peakGray < 0.356863) {
                  layerColor = uL2Color;
                } else if (peakGray < 0.501961) {
                  layerColor = uL3Color;
                } else if (peakGray < 0.643137) {
                  layerColor = uL4Color;
                } else if (peakGray < 0.788235) {
                  layerColor = uL5Color;
                } else {
                  layerColor = uL6Color;
                }
                float coverage = clamp(smoothGray / max(0.0001, peakGray), 0.0, 1.0);
                float halfWidth = max(uLineSmoothness, fwidth(coverage) * 0.75);
                float lineMask = smoothstep(uLineThreshold - halfWidth, uLineThreshold + halfWidth, coverage);
                diffuseColor.rgb = mix(uL0Color, layerColor, lineMask);
              }
            }
          } else {
            vec4 sampledDiffuseColor = texture2D(map, vMapUv);
            #ifdef DECODE_VIDEO_TEXTURE
              sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
            #endif
            float lineLum = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            float halfWidth = max(uOrigLineSmoothness, fwidth(lineLum) * 0.75);
            float isLine = smoothstep(uOrigLineThreshold - halfWidth, uOrigLineThreshold + halfWidth, lineLum);
            diffuseColor.rgb = mix(uGroundColor, uLineColor, isLine);
          }
        #endif`
      );
  };

  material.customProgramCacheKey = () =>
    material.isMeshLambertMaterial
      ? 'driftwoods-ground-tint-lambert-v10-q1-baked-af16'
      : 'driftwoods-ground-tint-standard-v10-q1-baked-af16';
}
