import {
  Color,
  Vector3,
  Vector4,
  MeshBasicMaterial,
  SphereGeometry,
  Mesh,
  Group,
  DoubleSide
} from 'three';

import {
  experimentalWallFxRuntimeConfig,
} from '../../../ui-core/config/atmosphereFxConfig.js';

export const PULSE_STEADY_MODE_MAP = {
  wave: 0,
  'solid-override': 1,
  'static-ring': 2,
};

export const PULSE_DIRECTION_MAP = {
  outward: 0,
  inward: 1,
};

export function createWallFxUniforms(wallFxConfig = experimentalWallFxRuntimeConfig) {
  return {
    uCircleBallPos: { value: new Vector3(0, 93, 0) },
    uPulseBallPos: { value: new Vector3(0, 93, 0) },
    uTime: { value: 0 },

    uWallBaseVisible: { value: 1.0 },
    uHexEmissiveColor: { value: new Color('#ffffff') },
    uHexEmissiveIntensity: { value: 0.0 },

    // Circle (Ring) uniforms -> Glass Walls only
    uCircleEnabled: { value: wallFxConfig.circleEnabled ? 1.0 : 0.0 },
    uCircleRadius: { value: wallFxConfig.circleRadius },
    uCircleVerticalExtendUu: { value: Number(wallFxConfig.circleVerticalExtendUu) || 0 },
    uCircleThickness: { value: wallFxConfig.circleThickness },
    uCircleColor: { value: new Color(wallFxConfig.circleColor) },
    uCircleUseTeamColor: { value: wallFxConfig.circleUseTeamColor ? 1.0 : 0.0 },
    uCircleOpacity: { value: wallFxConfig.circleOpacity },

    // Pulse uniforms (independent 3D sphere/spheroid) -> Shield Hexes & Optional Solid Walls
    uPulseEnabled: { value: wallFxConfig.pulseEnabled ? 1.0 : 0.0 },
    uPulseApplyToHexes: { value: wallFxConfig.pulseApplyToHexes !== false ? 1.0 : 0.0 },
    uPulseApplyToWalls: { value: wallFxConfig.pulseApplyToWalls ? 1.0 : 0.0 },
    uPulseSphereRadius: { value: wallFxConfig.pulseSphereRadius },
    uPulseVerticalExtendUu: { value: Number(wallFxConfig.pulseVerticalExtendUu) || 0 },
    uPulseDirection: { value: PULSE_DIRECTION_MAP[wallFxConfig.pulseDirection] ?? 1 },
    uPulseFadeShrinkPct: { value: Number(wallFxConfig.pulseFadeShrinkPct ?? 50) },
    uPulseFadeBezier: {
      value: new Vector4(
        Number(wallFxConfig.pulseFadeBezierP1X ?? 0.5),
        Number(wallFxConfig.pulseFadeBezierP1Y ?? 0.0),
        Number(wallFxConfig.pulseFadeBezierP2X ?? 1.0),
        Number(wallFxConfig.pulseFadeBezierP2Y ?? 0.0)
      ),
    },
    uPulseSteadyMode: { value: PULSE_STEADY_MODE_MAP[wallFxConfig.pulseSteadyMode] ?? 0 },
    uPulseStaticPositionPct: { value: Number(wallFxConfig.pulseStaticPositionPct ?? 47) },
    uPulseStaticBandWidthPct: { value: Number(wallFxConfig.pulseStaticBandWidthPct ?? 5) },
    uPulseIntervalSec: { value: wallFxConfig.pulseIntervalSec },
    uPulseRiseDurationSec: { value: Number(wallFxConfig.pulseRiseDurationSec ?? 0.01) },
    uPulseFallDurationSec: { value: Number(wallFxConfig.pulseFallDurationSec ?? 0.2) },
    uPulseSpeedRadiusPct: { value: wallFxConfig.pulseSpeedRadiusPct },
    uPulseRiseBezier: {
      value: new Vector4(
        Number(wallFxConfig.pulseRiseBezierP1X ?? 0.33),
        Number(wallFxConfig.pulseRiseBezierP1Y ?? 0.33),
        Number(wallFxConfig.pulseRiseBezierP2X ?? 0.67),
        Number(wallFxConfig.pulseRiseBezierP2Y ?? 0.67)
      ),
    },
    uPulseFallBezier: {
      value: new Vector4(
        Number(wallFxConfig.pulseFallBezierP1X ?? 0.0),
        Number(wallFxConfig.pulseFallBezierP1Y ?? 0.5),
        Number(wallFxConfig.pulseFallBezierP2X ?? 0.0),
        Number(wallFxConfig.pulseFallBezierP2Y ?? 1.01)
      ),
    },
    uPulseIntensity: { value: wallFxConfig.pulseIntensity },
    uPulseColor: { value: new Color(wallFxConfig.pulseColor) },
    uPulseMultiplyTeamColor: { value: wallFxConfig.pulseMultiplyTeamColor ? 1.0 : 0.0 },
    uPulseOpacity: { value: wallFxConfig.pulseOpacity },

    // Team gradient uniforms -> Shield Hexes only
    uTeamGradientEnabled: { value: wallFxConfig.teamGradientEnabled ? 1.0 : 0.0 },
    uCenterLineWidth: { value: wallFxConfig.centerLineWidth },
    uTeamTransitionWidth: { value: wallFxConfig.teamTransitionWidth },
    uTeamColorStrength: { value: wallFxConfig.teamColorStrength },
    uBlueTeamColor: { value: new Color(wallFxConfig.blueTeamColor) },
    uBlueTeamAlpha: { value: wallFxConfig.blueTeamAlpha },
    uOrangeTeamColor: { value: new Color(wallFxConfig.orangeTeamColor) },
    uOrangeTeamAlpha: { value: wallFxConfig.orangeTeamAlpha },
    uCenterLineColor: { value: new Color(wallFxConfig.centerLineColor) },
    uCenterLineAlpha: { value: wallFxConfig.centerLineAlpha },
  };
}

/**
 * Injects 3D sphere-wall outer ring, independent 3D pulse sphere (with inward/outward direction,
 * 3D sphere outer boundary fade-in / fade-out shrink %, and 2-part split Cubic-Bezier wave gradient),
 * half-field team gradient shader, and 3D GLB Hexagon Mesh anti-shimmer filtering.
 */
export function injectWallFxShader(material, wallFxUniforms, isWallsMesh = false) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wallFxUniforms);
    shader.uniforms.uIsWallsMesh = { value: isWallsMesh ? 1.0 : 0.0 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vExpWorldPos;'
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vExpWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vExpWorldPos;
        uniform vec3 uCircleBallPos;
        uniform vec3 uPulseBallPos;
        uniform float uTime;

        uniform float uWallBaseVisible;
        uniform vec3 uHexEmissiveColor;
        uniform float uHexEmissiveIntensity;

        uniform float uCircleEnabled;
        uniform float uCircleRadius;
        uniform float uCircleVerticalExtendUu;
        uniform float uCircleThickness;
        uniform vec3 uCircleColor;
        uniform float uCircleUseTeamColor;
        uniform float uCircleOpacity;

        uniform float uPulseEnabled;
        uniform float uPulseApplyToHexes;
        uniform float uPulseApplyToWalls;
        uniform float uPulseSphereRadius;
        uniform float uPulseVerticalExtendUu;
        uniform float uPulseDirection;
        uniform float uPulseFadeShrinkPct;
        uniform vec4 uPulseFadeBezier;
        uniform float uPulseSteadyMode;
        uniform float uPulseStaticPositionPct;
        uniform float uPulseStaticBandWidthPct;
        uniform float uPulseIntervalSec;
        uniform float uPulseRiseDurationSec;
        uniform float uPulseFallDurationSec;
        uniform float uPulseSpeedRadiusPct;
        uniform vec4 uPulseRiseBezier;
        uniform vec4 uPulseFallBezier;
        uniform float uPulseIntensity;
        uniform vec3 uPulseColor;
        uniform float uPulseMultiplyTeamColor;
        uniform float uPulseOpacity;

        uniform float uTeamGradientEnabled;
        uniform float uCenterLineWidth;
        uniform float uTeamTransitionWidth;
        uniform float uTeamColorStrength;
        uniform vec3 uBlueTeamColor;
        uniform float uBlueTeamAlpha;
        uniform vec3 uOrangeTeamColor;
        uniform float uOrangeTeamAlpha;
        uniform vec3 uCenterLineColor;
        uniform float uCenterLineAlpha;
        uniform float uIsWallsMesh;

        float calcSpheroidDistance(vec3 worldPos, vec3 centerPos, float radius, float verticalExtendUu) {
          vec3 d = worldPos - centerPos;
          float rX = max(1.0, radius);
          float rY = max(1.0, radius + verticalExtendUu);
          float yScale = rX / rY;
          return length(vec3(d.x, d.y * yScale, d.z));
        }

        // Evaluates 1D Cubic-Bezier y(t) for t in [0, 1] with control points P1(bez.x, bez.y), P2(bez.z, bez.w)
        // Guarantees y(0) = 0.0 and y(1) = 1.0
        float evalCubicBezier01(float t, vec4 bez) {
          if (t <= 0.0) return 0.0;
          if (t >= 1.0) return 1.0;
          float p1x = clamp(bez.x, 0.0, 1.0);
          float p1y = bez.y;
          float p2x = clamp(bez.z, 0.0, 1.0);
          float p2y = bez.w;
          float u = t;
          for (int i = 0; i < 5; i++) {
            float om = 1.0 - u;
            float x = 3.0 * om * om * u * p1x + 3.0 * om * u * u * p2x + u * u * u - t;
            float dx = 3.0 * om * om * p1x + 6.0 * om * u * (p2x - p1x) + 3.0 * u * u * (1.0 - p2x);
            if (abs(dx) < 1e-4) break;
            u = clamp(u - x / dx, 0.0, 1.0);
          }
          float om = 1.0 - u;
          return 3.0 * om * om * u * p1y + 3.0 * om * u * u * p2y + u * u * u;
        }

        // Evaluates two-stage Pulse Wave Gradient:
        // Stage 1 (Rise: 0 -> 1 over riseSec): y = evalCubicBezier01(tRise, uPulseRiseBezier)
        // Stage 2 (Fall: 1 -> 0 over fallSec): y = 1.0 - evalCubicBezier01(tFall, uPulseFallBezier)
        float evalTwoPartPulseWave(float ageSec, float riseSec, float fallSec, vec4 riseBez, vec4 fallBez) {
          if (ageSec < riseSec) {
            float tRise = clamp(ageSec / max(0.0001, riseSec), 0.0, 1.0);
            return clamp(evalCubicBezier01(tRise, riseBez), 0.0, 1.5);
          } else {
            float tFall = clamp((ageSec - riseSec) / max(0.0001, fallSec), 0.0, 1.0);
            return clamp(1.0 - evalCubicBezier01(tFall, fallBez), 0.0, 1.5);
          }
        }`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        bool isWall = (uIsWallsMesh > 0.5);

        float zCoord = vExpWorldPos.z;
        float absZ = abs(zCoord);
        vec3 sideColor = zCoord < 0.0 ? uBlueTeamColor : uOrangeTeamColor;
        float sideAlpha = zCoord < 0.0 ? uBlueTeamAlpha : uOrangeTeamAlpha;
        // Screen-space derivative anti-aliasing for the z=0 centerline
        float centerAa = max(4.0, fwidth(absZ) * 1.5);
        float centerLineFactor = 1.0 - smoothstep(max(0.0, uCenterLineWidth - centerAa), uCenterLineWidth + centerAa, absZ);
        float teamBlend = smoothstep(uCenterLineWidth, uCenterLineWidth + max(10.0, uTeamTransitionWidth), absZ);
        vec3 baseTeamTint = mix(uCenterLineColor, sideColor, teamBlend);
        float baseTeamAlpha = mix(uCenterLineAlpha, sideAlpha, teamBlend);

        float baseMeshAlpha = gl_FragColor.a;
        vec3 wallRgb = gl_FragColor.rgb;
        float wallAlpha = isWall ? ((uWallBaseVisible > 0.5) ? baseMeshAlpha : 0.0) : baseMeshAlpha;

        vec3 hexRgb = gl_FragColor.rgb + uHexEmissiveColor * uHexEmissiveIntensity;
        float hexAlphaGain = 1.0;

        if (!isWall && uTeamGradientEnabled > 0.5) {
          float blendFactor = clamp(uTeamColorStrength, 0.0, 1.0);
          float hdrMultiplier = max(1.0, uTeamColorStrength);
          vec3 fieldTint = mix(uCenterLineColor, sideColor * hdrMultiplier, teamBlend);
          hexRgb = mix(hexRgb, fieldTint + uHexEmissiveColor * uHexEmissiveIntensity, blendFactor);
          if (uCenterLineAlpha > 0.001) {
            hexRgb = mix(hexRgb, uCenterLineColor * hdrMultiplier, centerLineFactor * uCenterLineAlpha);
          }
          hexAlphaGain = mix(1.0, baseTeamAlpha * (0.6 + 0.4 * blendFactor), blendFactor);
        }

        bool wantWallPulse = isWall && (uPulseApplyToWalls > 0.5);
        bool wantHexPulse = (!isWall) && (uPulseApplyToHexes > 0.5);
        if (uPulseEnabled > 0.5 && (wantWallPulse || wantHexPulse)) {
          float distPulse = calcSpheroidDistance(vExpWorldPos, uPulseBallPos, uPulseSphereRadius, uPulseVerticalExtendUu);
          if (distPulse <= uPulseSphereRadius) {
            float sphereEdgeFade = 1.0;
            float shrinkFrac = clamp(uPulseFadeShrinkPct * 0.01, 0.0, 1.0);
            if (shrinkFrac > 0.001) {
              float fadeSpan = max(1.0, uPulseSphereRadius * shrinkFrac);
              float linearFade = clamp((uPulseSphereRadius - distPulse) / fadeSpan, 0.0, 1.0);
              sphereEdgeFade = clamp(evalCubicBezier01(linearFade, uPulseFadeBezier), 0.0, 1.5);
            }

            float shapeVal = 0.0;
            bool isPulseActiveAtFrag = false;

            float riseSec = max(0.0001, uPulseRiseDurationSec);
            float fallSec = max(0.0001, uPulseFallDurationSec);
            float totalDurationSec = riseSec + fallSec;
            float speedUuPerSec = max(10.0, uPulseSphereRadius * (uPulseSpeedRadiusPct * 0.01));

            if (uPulseSteadyMode > 0.5 && uPulseSteadyMode < 1.5) {
              shapeVal = 1.0;
              isPulseActiveAtFrag = true;
            } else if (uPulseSteadyMode >= 1.5) {
              float targetRadiusUu = clamp(uPulseStaticPositionPct * 0.01, 0.0, 1.0) * uPulseSphereRadius;
              float distFromLeadingUu = (uPulseDirection > 0.5)
                ? (distPulse - targetRadiusUu)
                : (targetRadiusUu - distPulse);
              float synthAge = distFromLeadingUu / speedUuPerSec;
              if (synthAge >= 0.0 && synthAge <= totalDurationSec) {
                shapeVal = evalTwoPartPulseWave(synthAge, riseSec, fallSec, uPulseRiseBezier, uPulseFallBezier);
                isPulseActiveAtFrag = true;
              }
            } else {
              float travelDist = (uPulseDirection > 0.5)
                ? max(0.0, uPulseSphereRadius - distPulse)
                : distPulse;
              float travelSec = travelDist / speedUuPerSec;
              float intervalSec = max(0.1, uPulseIntervalSec);
              float clampedTotalDur = min(totalDurationSec, intervalSec * 0.98);
              float durScale = clampedTotalDur / max(0.0001, totalDurationSec);
              float effRiseSec = riseSec * durScale;
              float effFallSec = fallSec * durScale;

              float ageSec = mod(uTime - travelSec, intervalSec);
              if (ageSec < 0.0) ageSec += intervalSec;

              if (ageSec <= clampedTotalDur) {
                shapeVal = evalTwoPartPulseWave(ageSec, effRiseSec, effFallSec, uPulseRiseBezier, uPulseFallBezier);
                isPulseActiveAtFrag = true;
              }
            }

            if (isPulseActiveAtFrag) {
              float pulseMask = clamp(shapeVal * sphereEdgeFade, 0.0, 1.0);
              if (pulseMask > 0.0005) {
                float pulseBlend = clamp(pulseMask * min(1.0, uPulseIntensity), 0.0, 1.0);
                float pulseHdr = max(1.0, uPulseIntensity);
                vec3 targetPulseCol = uPulseColor;
                if (uPulseMultiplyTeamColor > 0.5) {
                  targetPulseCol *= baseTeamTint;
                }
                if (wantWallPulse) {
                  wallRgb = mix(wallRgb, targetPulseCol * 1.35 * pulseHdr, pulseBlend);
                  wallAlpha = max(wallAlpha, clamp(pulseMask * uPulseOpacity, 0.0, 1.0));
                }
                if (wantHexPulse) {
                  hexRgb = mix(hexRgb, targetPulseCol * 1.35 * pulseHdr, pulseBlend);
                  hexAlphaGain = mix(hexAlphaGain, max(hexAlphaGain, 1.0 + uPulseOpacity * 8.0 * pulseHdr), pulseMask);
                }
              }
            }
          }
        }

        if (isWall) {
          vec3 outRgb = wallRgb;
          float outAlpha = wallAlpha;

          if (uCircleEnabled > 0.5) {
            float distCircle = calcSpheroidDistance(vExpWorldPos, uCircleBallPos, uCircleRadius, uCircleVerticalExtendUu);
            float aa = max(fwidth(distCircle) * 1.25, 2.0);
            if (distCircle <= uCircleRadius + uCircleThickness + aa * 2.0) {
              float ringDelta = abs(distCircle - uCircleRadius);
              // Sub-pixel energy conservation so thin rings at far distances fade smoothly instead of popping
              float energyScale = clamp(uCircleThickness / max(0.001, aa), 0.15, 1.0);
              float ringMask = (1.0 - smoothstep(max(0.0, uCircleThickness - aa), uCircleThickness + aa, ringDelta)) * energyScale;
              if (ringMask > 0.001) {
                vec3 activeRingColor = uCircleUseTeamColor > 0.5 ? baseTeamTint : uCircleColor;
                outRgb = mix(outRgb, activeRingColor * 1.25, ringMask);
                outAlpha = max(outAlpha, ringMask * uCircleOpacity);
              }
            }
          }

          if (outAlpha <= 0.001) {
            discard;
          }
          gl_FragColor.rgb = outRgb;
          gl_FragColor.a = outAlpha;
        } else {
          // 3D GLB Hex Mesh anti-shimmer:
          // Compute true inward arena wall normal from world position (immune to ribbon edge normals)
          // and apply screen-space footprint + grazing-angle energy conservation so sub-pixel hex bars
          // never shimmer at far distances while remaining 100% visible from every aerial camera angle.
          vec3 toCam = cameraPosition - vExpWorldPos;
          float camDist = length(toCam);
          vec3 viewDir = toCam / max(1.0, camDist);

          vec3 inwardSpine = vec3(0.0, min(vExpWorldPos.y, 1000.0), clamp(vExpWorldPos.z, -3500.0, 3500.0));
          vec3 wallNormal = normalize(inwardSpine - vExpWorldPos);
          float ndotv = abs(dot(wallNormal, viewDir));

          // Screen-space derivative of world position measures how many Unreal Units a single pixel spans
          float pixelFootprintUu = max(length(dFdx(vExpWorldPos)), length(dFdy(vExpWorldPos)));
          // A hex ribbon bar is ~16 UU wide; when pixelFootprintUu > 16 UU, sub-pixel coverage scales smoothly
          float subpixelEnergy = clamp(18.0 / max(18.0, pixelFootprintUu * 0.85), 0.38, 1.0);
          float grazingFactor = 0.55 + 0.45 * smoothstep(0.02, 0.22, ndotv);
          float antiShimmerGain = mix(subpixelEnergy * grazingFactor, 1.0, clamp((hexAlphaGain - 1.0) * 0.5, 0.0, 1.0));

          gl_FragColor.rgb = hexRgb;
          gl_FragColor.a = clamp(baseMeshAlpha * hexAlphaGain * antiShimmerGain, 0.0, 1.0);
        }`
      );
  };

  material.customProgramCacheKey = () =>
    `${material.isMeshLambertMaterial ? 'lambert' : 'standard'}-wall-fx-${isWallsMesh ? 'walls' : 'hexes'}-v9-3d-hex-aa`;
}

export function createSpherePreviewMeshes(scene, wallFxConfig) {
  if (!scene) return null;
  const invParentScale = 1 / (scene.scale?.x || 100);
  const group = new Group();
  group.name = 'Experimental_Virtual_Spheres_Preview';
  group.scale.setScalar(invParentScale);

  const unitSphereGeo = new SphereGeometry(1, 32, 24);

  const circleGroup = new Group();
  const circleFillMat = new MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    side: DoubleSide,
  });
  const circleWireMat = new MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.55,
    wireframe: true,
    depthWrite: false,
  });
  circleGroup.add(new Mesh(unitSphereGeo, circleFillMat), new Mesh(unitSphereGeo, circleWireMat));
  circleGroup.visible = Boolean(wallFxConfig.circleShowSpherePreview);

  const pulseGroup = new Group();
  const pulseFillMat = new MeshBasicMaterial({
    color: 0xf59e0b,
    transparent: true,
    opacity: 0.10,
    depthWrite: false,
    side: DoubleSide,
  });
  const pulseWireMat = new MeshBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.50,
    wireframe: true,
    depthWrite: false,
  });
  pulseGroup.add(new Mesh(unitSphereGeo, pulseFillMat), new Mesh(unitSphereGeo, pulseWireMat));
  pulseGroup.visible = Boolean(wallFxConfig.pulseShowSpherePreview);

  group.add(circleGroup, pulseGroup);
  scene.add(group);

  return { group, circlePreviewMesh: circleGroup, pulsePreviewMesh: pulseGroup };
}
