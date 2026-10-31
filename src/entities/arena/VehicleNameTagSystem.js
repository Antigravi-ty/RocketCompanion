/**
 * VehicleNameTagSystem.js
 * Renders horizontal pill name tags anchored in 3D above vehicles in
 * Multiplayer Mode, Multi-Car Bots Mode, and the 6-Car Kickoff Name Tag Tuner.
 *
 * Uses a dedicated high-DPI 2D overlay canvas running at 100% native Retina render scale
 * (`cardRenderScale = 100%` by default), completely decoupled from the 3D WebGL scene's
 * global `renderScale` (which defaults to 50% for GPU performance).
 */

import * as THREE from 'three';
import {
  DEFAULT_NAME_TAG_CONFIG,
  NAME_TAG_FAR_CALIBRATION_DEPTH_UU,
  NAME_TAG_NEAR_CALIBRATION_DEPTH_UU,
  NAME_TAG_REFERENCE_DEPTH_UU,
  computeAdaptiveNameTagWidthPx,
  formatNameTagDisplayText,
  getNameTagConfig,
  getNameTagRuntimeState,
  resolveNameTagCornerRadiusPx,
  resolveNameTagFontFamilyCss,
  setNameTagTelemetrySnapshot,
} from '../../ui-core/config/nameTagConfig.ts';

const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 160;
const SPRITE_SUPERSAMPLE = 2;
const REFERENCE_TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(40));
const REFERENCE_VIEWPORT_HEIGHT_PX = 1080;
const SCREEN_SCALE_MULTIPLIER = 2.4;
const SLOT_CODES = ['B1', 'B2', 'B3', 'O1', 'O2', 'O3', 'P7', 'P8'];

function hexToRgba(hexColor, alpha = 1.0) {
  const cleanHex = String(hexColor || '#000000').replace('#', '');
  const numericValue = parseInt(
    cleanHex.length === 3
      ? cleanHex
          .split('')
          .map((char) => char + char)
          .join('')
      : cleanHex,
    16
  );
  if (!Number.isFinite(numericValue)) return `rgba(12, 45, 72, ${alpha})`;
  const red = (numericValue >> 16) & 255;
  const green = (numericValue >> 8) & 255;
  const blue = numericValue & 255;
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`;
}

function roundMetric(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(num * factor) / factor;
}

function createNameTagSprite() {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (canvas) {
    canvas.width = CANVAS_WIDTH * SPRITE_SUPERSAMPLE;
    canvas.height = CANVAS_HEIGHT * SPRITE_SUPERSAMPLE;
  }
  const texture = canvas ? new THREE.CanvasTexture(canvas) : null;
  if (texture) {
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }
  }
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: DEFAULT_NAME_TAG_CONFIG.opacity,
    alphaTest: 0.0002,
    depthTest: false,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFuncMask: 0x01,
    stencilWriteMask: 0x01,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 950;
  sprite.frustumCulled = false;
  sprite.visible = false;
  sprite.userData = {
    canvas,
    texture,
    material,
    cacheKey: '',
    cameraDistanceSq: 0,
  };
  return sprite;
}

function renderPillCardToSprite(
  sprite,
  displayText,
  team,
  config,
  carPillWidthPx,
  effectiveCornerRadiusPx
) {
  if (!sprite?.userData?.canvas) return;
  const isOrangeTeam = team === 1;
  const backgroundColor = isOrangeTeam ? config.orangeBgColor : config.blueBgColor;
  const borderColor = isOrangeTeam ? config.orangeBorderColor : config.blueBorderColor;
  const textColor = isOrangeTeam ? config.orangeTextColor : config.blueTextColor;
  const fontFamily = config.fontFamily || DEFAULT_NAME_TAG_CONFIG.fontFamily;
  const fontWeight = config.fontWeight || DEFAULT_NAME_TAG_CONFIG.fontWeight;

  const cacheKey = [
    displayText,
    team,
    carPillWidthPx,
    config.pillHeight,
    effectiveCornerRadiusPx,
    config.borderWidth,
    config.fontSize,
    fontFamily,
    fontWeight,
    config.bgOpacity,
    backgroundColor,
    borderColor,
    textColor,
  ].join('|');

  if (sprite.userData.cacheKey === cacheKey) return;
  sprite.userData.cacheKey = cacheKey;

  const canvas = sprite.userData.canvas;
  const context = canvas.getContext('2d');
  if (!context) return;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(SPRITE_SUPERSAMPLE, 0, 0, SPRITE_SUPERSAMPLE, 0, 0);

  const pillWidth = Math.max(
    40,
    Math.min(
      CANVAS_WIDTH - 24,
      Number(carPillWidthPx) || DEFAULT_NAME_TAG_CONFIG.pillMaxWidth
    )
  );
  const pillHeight = Math.max(
    28,
    Math.min(
      CANVAS_HEIGHT - 24,
      Number(config.pillHeight) || DEFAULT_NAME_TAG_CONFIG.pillHeight
    )
  );
  const pillX = (CANVAS_WIDTH - pillWidth) * 0.5;
  const pillY = (CANVAS_HEIGHT - pillHeight) * 0.5;
  const cornerRadius = resolveNameTagCornerRadiusPx(
    pillWidth,
    pillHeight,
    effectiveCornerRadiusPx
  );

  context.save();
  context.beginPath();
  context.roundRect(pillX, pillY, pillWidth, pillHeight, cornerRadius);
  const effectiveBgOpacity = Math.max(
    0.005,
    Number(config.bgOpacity) ?? DEFAULT_NAME_TAG_CONFIG.bgOpacity
  );
  context.fillStyle = hexToRgba(backgroundColor, effectiveBgOpacity);
  context.fill();

  const borderWidth = Math.max(
    0,
    Math.min(12, Number(config.borderWidth) ?? DEFAULT_NAME_TAG_CONFIG.borderWidth)
  );
  if (borderWidth > 0) {
    context.lineWidth = borderWidth;
    context.strokeStyle = borderColor;
    context.stroke();
  }

  context.clip();

  const fontSize = Math.max(
    12,
    Math.min(48, Number(config.fontSize) || DEFAULT_NAME_TAG_CONFIG.fontSize)
  );
  const fontFamilyCss = resolveNameTagFontFamilyCss(fontFamily);
  context.font = `${fontWeight} ${fontSize}px ${fontFamilyCss}`;
  context.fillStyle = textColor;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const maxTextWidth = Math.max(16, pillWidth - borderWidth * 2 - 12);
  context.fillText(displayText, CANVAS_WIDTH * 0.5, CANVAS_HEIGHT * 0.5 + 1, maxTextWidth);
  context.restore();

  if (sprite.userData.texture) {
    sprite.userData.texture.needsUpdate = true;
  }
}

export class VehicleNameTagSystem {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'vehicle-name-tags';
    this.sprites = [];
    this._visibleSprites = [];
    this._visibleCards2D = [];
    this.cameraUpVector = new THREE.Vector3(0, 1, 0);
    this.cameraForwardVector = new THREE.Vector3(0, 0, -1);
    this._projVector = new THREE.Vector3();
    this.overlayCanvas = null;
    this.overlayCtx = null;

    for (let slotIndex = 0; slotIndex < 8; slotIndex++) {
      const sprite = createNameTagSprite();
      this.sprites.push(sprite);
      this.root.add(sprite);
    }

    if (this.scene) {
      this.scene.add(this.root);
    }
  }

  _ensureOverlayCanvas() {
    if (typeof document === 'undefined') return null;
    if (this.overlayCanvas && this.overlayCanvas.isConnected && this.overlayCtx) {
      return this.overlayCanvas;
    }
    let existing = document.getElementById('vehicle-name-tag-overlay-canvas');
    if (!existing) {
      existing = document.createElement('canvas');
      existing.id = 'vehicle-name-tag-overlay-canvas';
      existing.className = 'name-tag-overlay-canvas';
      existing.style.position = 'fixed';
      existing.style.inset = '0';
      existing.style.width = '100%';
      existing.style.height = '100%';
      existing.style.pointerEvents = 'none';
      existing.style.userSelect = 'none';
      existing.style.zIndex = '10';
      existing.style.display = 'none';
      const host = document.getElementById('app') || document.body;
      host.appendChild(existing);
    }
    this.overlayCanvas = existing;
    this.overlayCtx = existing.getContext('2d');
    return this.overlayCanvas;
  }

  _hideOverlayCanvas() {
    if (this.overlayCanvas) {
      if (this.overlayCtx) {
        this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
        this.overlayCtx.clearRect(
          0,
          0,
          this.overlayCanvas.width,
          this.overlayCanvas.height
        );
      }
      this.overlayCanvas.style.display = 'none';
    }
  }

  update(arena, numCars = 0, camera = null) {
    if (!arena || !this.root) return;
    const config = getNameTagConfig();
    const runtimeState = getNameTagRuntimeState();

    const isDirectorOrGoalReplay =
      Boolean(arena.isGoalReplayActive) ||
      arena.cameraMode === 'director' ||
      runtimeState.activeCameraMode === 'director';
    const shouldShowSystem =
      Boolean(config.enabled) &&
      (Boolean(runtimeState.isTunerArenaActive) ||
        Boolean(runtimeState.isMultiplayerOrMultiCarMode) ||
        Boolean(arena.isLobbyMode) ||
        isDirectorOrGoalReplay ||
        numCars > 1);

    if (!shouldShowSystem) {
      this.root.visible = false;
      this._hideOverlayCanvas();
      return;
    }

    this.root.visible = true;
    const activeCamera = camera || arena.camera;
    if (typeof activeCamera?.updateMatrixWorld === 'function') {
      activeCamera.updateMatrixWorld();
    }

    const maxSlots = Math.min(this.sprites.length, Math.max(arena.cars?.length || 0, numCars));

    const cameraMode =
      arena.cameraMode ||
      runtimeState.activeCameraMode ||
      (arena.isFreeCam ? 'free' : 'pov');
    const isPovCamera =
      cameraMode === 'director' || cameraMode === 'free' || cameraMode === 'podium'
        ? false
        : typeof arena.isPovCamera === 'boolean'
          ? arena.isPovCamera
          : cameraMode === 'pov' ||
            cameraMode === 'wasmPov' ||
            cameraMode === 'rearView';
    const focusedCarIndex =
      typeof arena.focusedCarIndex === 'number'
        ? arena.focusedCarIndex
        : typeof runtimeState.focusedCarIndex === 'number'
          ? runtimeState.focusedCarIndex
          : (arena.playerCarIndex ?? 0);

    if (activeCamera?.quaternion) {
      this.cameraUpVector
        .set(0, 1, 0)
        .applyQuaternion(activeCamera.quaternion)
        .normalize();
      this.cameraForwardVector
        .set(0, 0, -1)
        .applyQuaternion(activeCamera.quaternion)
        .normalize();
    } else {
      this.cameraUpVector.set(0, 1, 0);
      this.cameraForwardVector.set(0, 0, -1);
    }

    const viewportWidthPx =
      typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1920;
    const viewportHeightPx =
      typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 1080;
    const devicePixelRatio =
      typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;

    const overlayCanvas = this._ensureOverlayCanvas();
    const useHighDpiOverlay = Boolean(overlayCanvas && this.overlayCtx);

    const cameraFovDegrees = Number(activeCamera?.fov) || 80;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(cameraFovDegrees * 0.5));
    const fovScale = tanHalfFov / REFERENCE_TAN_HALF_FOV;
    const scaleFactor = Math.max(
      0.02,
      Math.min(
        0.3,
        Number(config.cameraScaleFactor) || DEFAULT_NAME_TAG_CONFIG.cameraScaleFactor
      )
    );
    const distanceScaleExponent = Number.isFinite(Number(config.distanceScaleExponent))
      ? Math.max(0.0, Math.min(1.5, Number(config.distanceScaleExponent)))
      : DEFAULT_NAME_TAG_CONFIG.distanceScaleExponent;
    const nearScaleMultiplier = Number.isFinite(Number(config.nearScaleMultiplier))
      ? Math.max(0.2, Math.min(2.5, Number(config.nearScaleMultiplier)))
      : DEFAULT_NAME_TAG_CONFIG.nearScaleMultiplier;
    const farScaleMultiplier = Number.isFinite(Number(config.farScaleMultiplier))
      ? Math.max(0.2, Math.min(2.5, Number(config.farScaleMultiplier)))
      : DEFAULT_NAME_TAG_CONFIG.farScaleMultiplier;

    const pillHeightPx = Math.max(
      28,
      Math.min(
        CANVAS_HEIGHT - 24,
        Number(config.pillHeight) || DEFAULT_NAME_TAG_CONFIG.pillHeight
      )
    );
    const globalWorldOffsetUu = Number.isFinite(Number(config.verticalOffsetUu))
      ? Number(config.verticalOffsetUu)
      : DEFAULT_NAME_TAG_CONFIG.verticalOffsetUu;
    const globalScreenOffsetPx = Number.isFinite(Number(config.screenVerticalOffsetPx))
      ? Number(config.screenVerticalOffsetPx)
      : DEFAULT_NAME_TAG_CONFIG.screenVerticalOffsetPx;

    const fontFamily = config.fontFamily || DEFAULT_NAME_TAG_CONFIG.fontFamily;
    const fontFamilyCss = resolveNameTagFontFamilyCss(fontFamily);
    const fontWeight = config.fontWeight || DEFAULT_NAME_TAG_CONFIG.fontWeight;
    const cardOpacity = Math.max(
      0.1,
      Math.min(1.0, Number(config.opacity) || DEFAULT_NAME_TAG_CONFIG.opacity)
    );
    const effectiveBgOpacity = Math.max(
      0.0,
      Math.min(1.0, Number(config.bgOpacity) ?? DEFAULT_NAME_TAG_CONFIG.bgOpacity)
    );
    const rawBorderWidth = Math.max(
      0,
      Math.min(12, Number(config.borderWidth) ?? DEFAULT_NAME_TAG_CONFIG.borderWidth)
    );
    const rawFontSize = Math.max(
      12,
      Math.min(48, Number(config.fontSize) || DEFAULT_NAME_TAG_CONFIG.fontSize)
    );
    const maxChars = Math.max(
      4,
      Math.min(32, Math.round(Number(config.maxChars) || DEFAULT_NAME_TAG_CONFIG.maxChars))
    );

    const measureCtx =
      this.overlayCtx ||
      this.sprites[0]?.userData?.canvas?.getContext?.('2d') ||
      null;
    let measuredMaxRefTextWidthPx;
    if (measureCtx) {
      measureCtx.save();
      measureCtx.setTransform(1, 0, 0, 1, 0, 0);
      measureCtx.font = `${fontWeight} ${rawFontSize}px ${fontFamilyCss}`;
      measuredMaxRefTextWidthPx = measureCtx.measureText('M'.repeat(maxChars)).width;
    }

    this._visibleSprites.length = 0;
    this._visibleCards2D.length = 0;
    const telemetryCars = [];

    for (let carIndex = 0; carIndex < this.sprites.length; carIndex++) {
      const sprite = this.sprites[carIndex];
      if (!sprite) continue;

      const carMesh = arena.cars?.[carIndex];
      if (carIndex >= maxSlots || !carMesh || !carMesh.visible) {
        sprite.visible = false;
        continue;
      }

      const isFocusedPovCar = isPovCamera && carIndex === focusedCarIndex;
      const shouldHideFocusedCar = isFocusedPovCar && !config.showOnLocalCar;

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
        carMesh.position.x + this.cameraUpVector.x * worldCameraUpUu;
      const worldAnchorY =
        carMesh.position.y + worldRoofY + this.cameraUpVector.y * worldCameraUpUu;
      const worldAnchorZ =
        carMesh.position.z + this.cameraUpVector.z * worldCameraUpUu;

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
            deltaX * this.cameraForwardVector.x +
            deltaY * this.cameraForwardVector.y +
            deltaZ * this.cameraForwardVector.z;
          if (forwardDepth <= 1) {
            sprite.visible = false;
            continue;
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
        worldAnchorX + this.cameraUpVector.x * screenOffsetWorldUu;
      const bottomAnchorY =
        worldAnchorY + this.cameraUpVector.y * screenOffsetWorldUu;
      const bottomAnchorZ =
        worldAnchorZ + this.cameraUpVector.z * screenOffsetWorldUu;

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

      const carEntry = Array.isArray(runtimeState.carEntries)
        ? runtimeState.carEntries.find((entry) => entry.carIndex === carIndex)
        : null;

      const rawName =
        carEntry?.name ||
        carEntry?.username ||
        config.previewNames?.[carIndex % 6] ||
        `Player ${carIndex + 1}`;
      const team =
        typeof carEntry?.team === 'number'
          ? carEntry.team
          : carEntry?.team === 'orange'
          ? 1
          : carEntry?.team === 'blue'
          ? 0
          : typeof arena.carTeams?.[carIndex] === 'number'
          ? arena.carTeams[carIndex]
          : carIndex < 3
          ? 0
          : 1;

      const displayText = formatNameTagDisplayText(rawName, maxChars);
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
        bottomAnchorX + this.cameraUpVector.x * halfPillHeightWorld;
      const spritePosY =
        bottomAnchorY + this.cameraUpVector.y * halfPillHeightWorld;
      const spritePosZ =
        bottomAnchorZ + this.cameraUpVector.z * halfPillHeightWorld;

      const totalWorldVerticalOffsetUu =
        effectiveWorldOffsetUu + screenOffsetWorldUu;

      if (carIndex < 6) {
        telemetryCars.push({
          carIndex,
          slotCode: SLOT_CODES[carIndex] || `#${carIndex + 1}`,
          name: rawName,
          team,
          visible: !shouldHideFocusedCar,
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
        });
      }

      if (shouldHideFocusedCar) {
        sprite.visible = false;
        continue;
      }

      sprite.userData.cameraDistanceSq = cameraDistanceSq;
      sprite.position.set(spritePosX, spritePosY, spritePosZ);
      sprite.scale.set(baseWidthWorld, baseHeightWorld, 1);

      if (useHighDpiOverlay && activeCamera?.projectionMatrix) {
        sprite.visible = false;
        this._projVector.set(spritePosX, spritePosY, spritePosZ).project(activeCamera);
        if (this._projVector.z >= -1 && this._projVector.z <= 1) {
          const centerX = (this._projVector.x * 0.5 + 0.5) * viewportWidthPx;
          const centerY = (-this._projVector.y * 0.5 + 0.5) * viewportHeightPx;
          const borderW = rawBorderWidth * screenUnitScale;
          const halfBorder = borderW * 0.5;
          const left = centerX - screenPillWidthPx * 0.5;
          const top = centerY - screenPillHeightPx * 0.5;
          const radius = effectiveCornerRadiusPx * screenUnitScale;
          const isOrangeTeam = team === 1;
          this._visibleCards2D.push({
            carIndex,
            cameraDistanceSq,
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
          });
        }
      } else {
        renderPillCardToSprite(
          sprite,
          displayText,
          team,
          config,
          carPillWidthPx,
          effectiveCornerRadiusPx
        );
        sprite.material.opacity = cardOpacity;
        sprite.visible = true;
        this._visibleSprites.push(sprite);
      }
    }

    if (measureCtx) {
      measureCtx.restore();
    }

    setNameTagTelemetrySnapshot({
      updatedAtMs: Date.now(),
      viewportWidthPx,
      viewportHeightPx,
      aspectRatio: viewportWidthPx / Math.max(1, viewportHeightPx),
      devicePixelRatio,
      cameraMode,
      focusedCarIndex,
      cameraFovDeg: cameraFovDegrees,
      cameraPosition: activeCamera?.position
        ? [
            roundMetric(activeCamera.position.x, 1),
            roundMetric(activeCamera.position.y, 1),
            roundMetric(activeCamera.position.z, 1),
          ]
        : [0, 0, 0],
      cameraForward: [
        roundMetric(this.cameraForwardVector.x, 4),
        roundMetric(this.cameraForwardVector.y, 4),
        roundMetric(this.cameraForwardVector.z, 4),
      ],
      cameraUp: [
        roundMetric(this.cameraUpVector.x, 4),
        roundMetric(this.cameraUpVector.y, 4),
        roundMetric(this.cameraUpVector.z, 4),
      ],
      cars: telemetryCars,
    });

    if (useHighDpiOverlay) {
      this._renderHighDpiOverlay(
        viewportWidthPx,
        viewportHeightPx,
        devicePixelRatio,
        config
      );
    } else {
      this._visibleSprites.sort(
        (a, b) => (a.userData.cameraDistanceSq || 0) - (b.userData.cameraDistanceSq || 0)
      );
      for (let rank = 0; rank < this._visibleSprites.length; rank++) {
        this._visibleSprites[rank].renderOrder = 950 + rank;
      }
    }
  }

  _renderHighDpiOverlay(viewportWidthPx, viewportHeightPx, devicePixelRatio, config) {
    const canvas = this.overlayCanvas;
    const ctx = this.overlayCtx;
    if (!canvas || !ctx) return;

    if (this._visibleCards2D.length === 0) {
      this._hideOverlayCanvas();
      return;
    }

    if (canvas.style.display !== 'block') {
      canvas.style.display = 'block';
    }

    const cardRenderScalePct = Math.max(
      25,
      Math.min(
        200,
        Number.isFinite(Number(config.cardRenderScale))
          ? Number(config.cardRenderScale)
          : DEFAULT_NAME_TAG_CONFIG.cardRenderScale
      )
    );
    const effectiveCardPixelRatio = Math.max(
      0.5,
      devicePixelRatio * (cardRenderScalePct / 100)
    );
    const targetBackingWidth = Math.max(
      1,
      Math.round(viewportWidthPx * effectiveCardPixelRatio)
    );
    const targetBackingHeight = Math.max(
      1,
      Math.round(viewportHeightPx * effectiveCardPixelRatio)
    );

    if (
      canvas.width !== targetBackingWidth ||
      canvas.height !== targetBackingHeight
    ) {
      canvas.width = targetBackingWidth;
      canvas.height = targetBackingHeight;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = canvas.width / Math.max(1, viewportWidthPx);
    const scaleY = canvas.height / Math.max(1, viewportHeightPx);
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

    // Sort front-to-back (closest to camera first) so closer pills mask out their
    // exact rounded-rectangle silhouette and occlude farther pills behind them.
    this._visibleCards2D.sort(
      (a, b) => (a.cameraDistanceSq || 0) - (b.cameraDistanceSq || 0)
    );

    for (let rank = 0; rank < this._visibleCards2D.length; rank++) {
      const card = this._visibleCards2D[rank];
      ctx.save();

      for (let closerIdx = 0; closerIdx < rank; closerIdx++) {
        const closer = this._visibleCards2D[closerIdx];
        if (
          closer.outerRight <= card.outerLeft ||
          closer.outerLeft >= card.outerRight ||
          closer.outerBottom <= card.outerTop ||
          closer.outerTop >= card.outerBottom
        ) {
          continue;
        }
        ctx.beginPath();
        ctx.rect(0, 0, viewportWidthPx, viewportHeightPx);
        ctx.roundRect(
          closer.outerLeft,
          closer.outerTop,
          closer.outerWidth,
          closer.outerHeight,
          closer.outerRadius
        );
        ctx.clip('evenodd');
      }

      ctx.globalAlpha = card.opacity;
      ctx.beginPath();
      ctx.roundRect(card.left, card.top, card.width, card.height, card.radius);
      ctx.fillStyle = hexToRgba(card.bgColor, card.bgOpacity);
      ctx.fill();

      if (card.borderW > 0) {
        ctx.lineWidth = card.borderW;
        ctx.strokeStyle = card.borderColor;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.roundRect(card.left, card.top, card.width, card.height, card.radius);
      ctx.clip();

      ctx.font = `${card.fontWeight} ${card.fontPx.toFixed(2)}px ${card.fontFamilyCss}`;
      ctx.fillStyle = card.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const maxTextWidth = Math.max(
        12,
        card.width - card.borderW * 2 - 10 * (card.screenUnitScale || 1)
      );
      ctx.fillText(
        card.displayText,
        card.centerX,
        card.centerY + card.fontPx * 0.03,
        maxTextWidth
      );

      ctx.restore();
    }
  }

  dispose() {
    this._hideOverlayCanvas();
    if (this.overlayCanvas && this.overlayCanvas.parentNode) {
      this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
    }
    this.overlayCanvas = null;
    this.overlayCtx = null;

    for (const sprite of this.sprites) {
      sprite?.userData?.texture?.dispose?.();
      sprite?.userData?.material?.dispose?.();
    }
    if (this.root && this.scene) {
      this.scene.remove(this.root);
    }
  }
}
