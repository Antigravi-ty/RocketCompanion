/**
 * VehicleNameTagProjector.ts
 * 3D world-to-screen projection, distance curve scaling, and telemetry computation
 * for VehicleNameTagSystem.
 */

import * as THREE from 'three';
import {
  NAME_TAG_FAR_CALIBRATION_DEPTH_UU,
  NAME_TAG_NEAR_CALIBRATION_DEPTH_UU,
  NAME_TAG_REFERENCE_DEPTH_UU,
  computeAdaptiveNameTagWidthPx,
  resolveNameTagCornerRadiusPx,
  type NameTagCarTelemetry,
  type NameTagConfig,
} from '../../ui-core/config/nameTagConfig';
import type { NameTagBallOcclusionProjection2D } from '../../ui-core/config/nameTagPillRenderer';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  roundMetric,
  type VisibleNameTagCard2D,
} from './VehicleNameTagCanvasRenderer';

export const REFERENCE_TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(40));
export const REFERENCE_VIEWPORT_HEIGHT_PX = 1080;
export const SCREEN_SCALE_MULTIPLIER = 2.4;
export const SLOT_CODES = ['B1', 'B2', 'B3', 'O1', 'O2', 'O3', 'P7', 'P8'];

export interface CarProjectionConfigParams {
  config: NameTagConfig;
  viewportWidthPx: number;
  viewportHeightPx: number;
  tanHalfFov: number;
  fovScale: number;
  scaleFactor: number;
  distanceScaleExponent: number;
  nearScaleMultiplier: number;
  farScaleMultiplier: number;
  pillHeightPx: number;
  globalWorldOffsetUu: number;
  globalScreenOffsetPx: number;
  fontFamilyCss: string;
  fontWeight: number;
  cardOpacity: number;
  effectiveBgOpacity: number;
  rawBorderWidth: number;
  rawFontSize: number;
  measuredMaxRefTextWidthPx: number | undefined;
}

export interface ProjectSingleCarInput {
  carIndex: number;
  carMesh: THREE.Object3D;
  rawName: string;
  displayText: string;
  team: 0 | 1;
  shouldHideFocusedCar: boolean;
  boostAmount: number;
  boostBorderVisible: boolean;
  boostFraction: number;
  boostBorderColorHex: string;
  activeCamera: THREE.PerspectiveCamera | null | undefined;
  cameraUpVector: THREE.Vector3;
  cameraForwardVector: THREE.Vector3;
  projVector: THREE.Vector3;
  measureCtx: CanvasRenderingContext2D | null;
  params: CarProjectionConfigParams;
}

export interface ProjectedCarResult {
  behindCamera: boolean;
  cameraDistanceSq: number;
  spritePosX: number;
  spritePosY: number;
  spritePosZ: number;
  baseWidthWorld: number;
  baseHeightWorld: number;
  carPillWidthPx: number;
  effectiveCornerRadiusPx: number;
  telemetry: NameTagCarTelemetry | null;
  card2D: VisibleNameTagCard2D | null;
}

export function projectBallOcclusion2D(
  ball: THREE.Object3D | null | undefined,
  ballRadiusUu: number,
  activeCamera: THREE.PerspectiveCamera | null | undefined,
  cameraForwardVector: THREE.Vector3,
  projVector: THREE.Vector3,
  viewportWidthPx: number,
  viewportHeightPx: number,
  tanHalfFov: number,
  config: NameTagConfig
): NameTagBallOcclusionProjection2D | null {
  if (!config.ballOcclusionEnabled || !ball || !ball.visible || !activeCamera?.position) {
    return null;
  }
  const opacity = Math.max(0, Math.min(1, Number(config.ballOcclusionOpacity) ?? 1.0));
  if (opacity <= 0.001) return null;

  const dx = ball.position.x - activeCamera.position.x;
  const dy = ball.position.y - activeCamera.position.y;
  const dz = ball.position.z - activeCamera.position.z;
  const viewZDepthUu =
    dx * cameraForwardVector.x +
    dy * cameraForwardVector.y +
    dz * cameraForwardVector.z;
  if (viewZDepthUu <= 10 || !activeCamera.projectionMatrix) {
    return null;
  }

  projVector.set(ball.position.x, ball.position.y, ball.position.z).project(activeCamera);
  if (projVector.z < -1 || projVector.z > 1) {
    return null;
  }

  const screenX = (projVector.x * 0.5 + 0.5) * viewportWidthPx;
  const screenY = (-projVector.y * 0.5 + 0.5) * viewportHeightPx;
  const focalPx = (viewportHeightPx * 0.5) / Math.max(1e-4, tanHalfFov);
  const radiusUu = Math.max(10, Number(ballRadiusUu) || 95);
  const screenRadiusPx = (radiusUu / viewZDepthUu) * focalPx;
  if (screenRadiusPx <= 1) return null;

  return {
    visible: true,
    screenX,
    screenY,
    screenRadiusPx,
    viewZDepthUu,
    opacity,
  };
}

export function projectCarNameTag(input: ProjectSingleCarInput): ProjectedCarResult | null {
  const {
    carIndex,
    carMesh,
    rawName,
    displayText,
    team,
    shouldHideFocusedCar,
    boostAmount,
    boostBorderVisible,
    boostFraction,
    boostBorderColorHex,
    activeCamera,
    cameraUpVector,
    cameraForwardVector,
    projVector,
    measureCtx,
    params,
  } = input;

  const {
    config,
    viewportWidthPx,
    viewportHeightPx,
    tanHalfFov,
    fovScale,
    scaleFactor,
    distanceScaleExponent,
    nearScaleMultiplier,
    farScaleMultiplier,
    pillHeightPx,
    globalWorldOffsetUu,
    globalScreenOffsetPx,
    fontFamilyCss,
    fontWeight,
    cardOpacity,
    effectiveBgOpacity,
    rawBorderWidth,
    rawFontSize,
    measuredMaxRefTextWidthPx,
  } = params;

  const carOverride = config.carOverrides?.[carIndex];
  const isOverrideEnabled = Boolean(carOverride?.enabled);
  const effectiveWorldOffsetUu = isOverrideEnabled
    ? Number(carOverride.worldOffsetUu)
    : globalWorldOffsetUu;
  const effectiveScreenOffsetPx = isOverrideEnabled
    ? Number(carOverride.screenOffsetPx)
    : globalScreenOffsetPx;
  const carScaleMultiplier = isOverrideEnabled
    ? Number(carOverride.scaleMultiplier) || 1.0
    : 1.0;

  const worldRoofY = effectiveWorldOffsetUu * 0.55;
  const worldCameraUpUu = effectiveWorldOffsetUu * 0.45;
  const worldAnchorX =
    carMesh.position.x + cameraUpVector.x * worldCameraUpUu;
  const worldAnchorY =
    carMesh.position.y + worldRoofY + cameraUpVector.y * worldCameraUpUu;
  const worldAnchorZ =
    carMesh.position.z + cameraUpVector.z * worldCameraUpUu;

  let cameraDistanceSq = 0;
  let euclideanDistanceUu = NAME_TAG_REFERENCE_DEPTH_UU;
  let viewZDepthUu = NAME_TAG_REFERENCE_DEPTH_UU;
  let offAxisAngleDeg = 0;

  if (activeCamera?.position) {
    const deltaX = worldAnchorX - activeCamera.position.x;
    const deltaY = worldAnchorY - activeCamera.position.y;
    const deltaZ = worldAnchorZ - activeCamera.position.z;
    cameraDistanceSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    euclideanDistanceUu = Math.max(1, Math.sqrt(cameraDistanceSq));
    if (activeCamera.quaternion) {
      const forwardDepth =
        deltaX * cameraForwardVector.x +
        deltaY * cameraForwardVector.y +
        deltaZ * cameraForwardVector.z;
      if (forwardDepth <= 1) {
        return null;
      }
      viewZDepthUu = forwardDepth;
      const cosAngle = Math.max(
        -1,
        Math.min(1, forwardDepth / euclideanDistanceUu)
      );
      offAxisAngleDeg = THREE.MathUtils.radToDeg(Math.acos(cosAngle));
    } else {
      viewZDepthUu = euclideanDistanceUu;
    }
  }

  const activeDepthUu =
    config.depthMetric === 'euclidean' ? euclideanDistanceUu : viewZDepthUu;

  const uuPerRefScreenPx =
    (2 * activeDepthUu * tanHalfFov) / REFERENCE_VIEWPORT_HEIGHT_PX;
  const screenOffsetWorldUu = effectiveScreenOffsetPx * uuPerRefScreenPx;

  const bottomAnchorX =
    worldAnchorX + cameraUpVector.x * screenOffsetWorldUu;
  const bottomAnchorY =
    worldAnchorY + cameraUpVector.y * screenOffsetWorldUu;
  const bottomAnchorZ =
    worldAnchorZ + cameraUpVector.z * screenOffsetWorldUu;

  const curvedDepthUu =
    NAME_TAG_REFERENCE_DEPTH_UU *
    Math.pow(
      Math.max(10, activeDepthUu) / NAME_TAG_REFERENCE_DEPTH_UU,
      distanceScaleExponent
    );
  const depthLerpT = Math.max(
    0,
    Math.min(
      1,
      (activeDepthUu - NAME_TAG_NEAR_CALIBRATION_DEPTH_UU) /
        (NAME_TAG_FAR_CALIBRATION_DEPTH_UU - NAME_TAG_NEAR_CALIBRATION_DEPTH_UU)
    )
  );
  const rangeMultiplier =
    nearScaleMultiplier +
    (farScaleMultiplier - nearScaleMultiplier) * depthLerpT;
  const effectiveScaleMultiplier = rangeMultiplier * carScaleMultiplier;

  const effectiveDistance =
    curvedDepthUu *
    fovScale *
    SCREEN_SCALE_MULTIPLIER *
    effectiveScaleMultiplier;
  const baseHeightWorld = effectiveDistance * scaleFactor;
  const baseWidthWorld = baseHeightWorld * (CANVAS_WIDTH / CANVAS_HEIGHT);
  const halfPillHeightWorld =
    baseHeightWorld * (pillHeightPx / CANVAS_HEIGHT) * 0.5;

  const measuredTextWidthPx = measureCtx
    ? measureCtx.measureText(displayText).width
    : undefined;
  const carPillWidthPx = Math.min(
    CANVAS_WIDTH - 24,
    computeAdaptiveNameTagWidthPx(
      displayText,
      config,
      measuredTextWidthPx,
      measuredMaxRefTextWidthPx
    )
  );
  const effectiveCornerRadiusPx = resolveNameTagCornerRadiusPx(
    carPillWidthPx,
    pillHeightPx,
    config.cornerRadius
  );

  const frustumHeightWorld = Math.max(1, 2 * viewZDepthUu * tanHalfFov);
  const canvasScreenHeightPx =
    viewportHeightPx * (baseHeightWorld / frustumHeightWorld);
  const screenUnitScale = canvasScreenHeightPx / CANVAS_HEIGHT;
  const screenPillHeightPx = pillHeightPx * screenUnitScale;
  const screenPillWidthPx = carPillWidthPx * screenUnitScale;

  const spritePosX =
    bottomAnchorX + cameraUpVector.x * halfPillHeightWorld;
  const spritePosY =
    bottomAnchorY + cameraUpVector.y * halfPillHeightWorld;
  const spritePosZ =
    bottomAnchorZ + cameraUpVector.z * halfPillHeightWorld;

  const totalWorldVerticalOffsetUu =
    effectiveWorldOffsetUu + screenOffsetWorldUu;

  const telemetry: NameTagCarTelemetry | null =
    carIndex < 6
      ? {
          carIndex,
          slotCode: SLOT_CODES[carIndex] || `#${carIndex + 1}`,
          name: rawName,
          team,
          visible: !shouldHideFocusedCar,
          boostAmount: roundMetric(boostAmount, 1),
          boostBorderVisible,
          carWorldPos: [
            roundMetric(carMesh.position.x, 1),
            roundMetric(carMesh.position.y, 1),
            roundMetric(carMesh.position.z, 1),
          ],
          anchorWorldPos: [
            roundMetric(bottomAnchorX, 1),
            roundMetric(bottomAnchorY, 1),
            roundMetric(bottomAnchorZ, 1),
          ],
          spriteWorldPos: [
            roundMetric(spritePosX, 1),
            roundMetric(spritePosY, 1),
            roundMetric(spritePosZ, 1),
          ],
          euclideanDistanceUu: roundMetric(euclideanDistanceUu, 1),
          viewZDepthUu: roundMetric(viewZDepthUu, 1),
          activeDepthUu: roundMetric(activeDepthUu, 1),
          offAxisAngleDeg: roundMetric(offAxisAngleDeg, 2),
          worldScaleWidthUu: roundMetric(baseWidthWorld, 1),
          worldScaleHeightUu: roundMetric(baseHeightWorld, 1),
          screenPillWidthPx: roundMetric(screenPillWidthPx, 1),
          screenPillHeightPx: roundMetric(screenPillHeightPx, 1),
          effectiveScaleMultiplier: roundMetric(effectiveScaleMultiplier, 3),
          effectiveWorldOffsetUu: roundMetric(effectiveWorldOffsetUu, 1),
          effectiveScreenOffsetPx: roundMetric(effectiveScreenOffsetPx, 1),
          totalWorldVerticalOffsetUu: roundMetric(totalWorldVerticalOffsetUu, 1),
        }
      : null;

  let card2D: VisibleNameTagCard2D | null = null;
  if (!shouldHideFocusedCar && activeCamera?.projectionMatrix) {
    projVector.set(spritePosX, spritePosY, spritePosZ).project(activeCamera);
    if (projVector.z >= -1 && projVector.z <= 1) {
      const centerX = (projVector.x * 0.5 + 0.5) * viewportWidthPx;
      const centerY = (-projVector.y * 0.5 + 0.5) * viewportHeightPx;
      const borderW = rawBorderWidth * screenUnitScale;
      const halfBorder = borderW * 0.5;
      const left = centerX - screenPillWidthPx * 0.5;
      const top = centerY - screenPillHeightPx * 0.5;
      const radius = effectiveCornerRadiusPx * screenUnitScale;
      const isOrangeTeam = team === 1;
      card2D = {
        carIndex,
        cameraDistanceSq,
        viewZDepthUu,
        displayText,
        centerX,
        centerY,
        left,
        top,
        width: screenPillWidthPx,
        height: screenPillHeightPx,
        radius,
        borderW,
        screenUnitScale,
        outerLeft: left - halfBorder,
        outerTop: top - halfBorder,
        outerRight: left + screenPillWidthPx + halfBorder,
        outerBottom: top + screenPillHeightPx + halfBorder,
        outerWidth: screenPillWidthPx + borderW,
        outerHeight: screenPillHeightPx + borderW,
        outerRadius: radius + halfBorder,
        fontPx: Math.max(6, rawFontSize * screenUnitScale),
        fontWeight,
        fontFamilyCss,
        opacity: cardOpacity,
        bgOpacity: effectiveBgOpacity,
        bgColor: isOrangeTeam ? config.orangeBgColor : config.blueBgColor,
        borderColor: isOrangeTeam ? config.orangeBorderColor : config.blueBorderColor,
        textColor: isOrangeTeam ? config.orangeTextColor : config.blueTextColor,
        boostBorderVisible,
        boostFraction,
        boostBorderColor: boostBorderColorHex,
      };
    }
  }

  return {
    behindCamera: false,
    cameraDistanceSq,
    spritePosX,
    spritePosY,
    spritePosZ,
    baseWidthWorld,
    baseHeightWorld,
    carPillWidthPx,
    effectiveCornerRadiusPx,
    telemetry,
    card2D,
  };
}
