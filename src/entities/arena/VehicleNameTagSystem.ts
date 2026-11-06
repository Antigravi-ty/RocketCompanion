/**
 * VehicleNameTagSystem.ts
 * Renders horizontal pill name tags anchored in 3D above vehicles in
 * Multiplayer Mode, Multi-Car Bots Mode, and the 6-Car Kickoff Name Tag Tuner.
 *
 * Uses a dedicated high-DPI 2D overlay canvas running at 100% native Retina render scale
 * (`cardRenderScale = 100%` by default), completely decoupled from the 3D WebGL scene's
 * global `renderScale`, with left-to-right boost progress border strokes and scene flags.
 */

import * as THREE from 'three';
import {
  DEFAULT_NAME_TAG_CONFIG,
  formatNameTagDisplayText,
  resolveNameTagFontFamilyCss,
  type NameTagBoostBorderOverride,
  type NameTagCarEntry,
  type NameTagCarTelemetry,
} from '../../ui-core/config/nameTagConfig';
import {
  getNameTagConfig,
  getNameTagRuntimeState,
  setNameTagTelemetrySnapshot,
} from '../../game/runtimeUiPort.ts';
import {
  CANVAS_HEIGHT,
  createNameTagSprite,
  ensureOverlayCanvas,
  hideOverlayCanvas,
  renderHighDpiOverlay,
  renderPillCardToSprite,
  roundMetric,
  type NameTagOverlayCanvasState,
  type NameTagSprite,
  type VisibleNameTagCard2D,
} from './VehicleNameTagCanvasRenderer';
import { resolveCarBoostBorderState } from './VehicleNameTagBoostBorderPolicy';
import {
  REFERENCE_TAN_HALF_FOV,
  projectBallOcclusion2D,
  projectCarNameTag,
  type CarProjectionConfigParams,
} from './VehicleNameTagProjector';

export interface NameTagArenaHost {
  ball?: THREE.Object3D | null;
  ballRadius?: number;
  cars?: Array<THREE.Object3D | null | undefined>;
  carTeams?: ArrayLike<number>;
  carBoostAmounts?: ArrayLike<number>;
  camera?: THREE.PerspectiveCamera | null;
  cameraMode?: string;
  isFreeCam?: boolean;
  isPovCamera?: boolean;
  isGoalReplayActive?: boolean;
  isLobbyMode?: boolean;
  focusedCarIndex?: number;
  playerCarIndex?: number;
  boostBorderOverride?: NameTagBoostBorderOverride;
}

export class VehicleNameTagSystem {
  public readonly scene: THREE.Scene | null | undefined;
  public readonly root: THREE.Group;
  public readonly sprites: NameTagSprite[];
  public boostBorderOverride: NameTagBoostBorderOverride = null;

  private readonly _visibleSprites: NameTagSprite[] = [];
  private readonly _visibleCards2D: VisibleNameTagCard2D[] = [];
  private readonly cameraUpVector = new THREE.Vector3(0, 1, 0);
  private readonly cameraForwardVector = new THREE.Vector3(0, 0, -1);
  private readonly _projVector = new THREE.Vector3();
  private readonly _overlayState: NameTagOverlayCanvasState = {
    overlayCanvas: null,
    overlayCtx: null,
  };

  constructor(scene: THREE.Scene | null | undefined) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'vehicle-name-tags';
    this.sprites = [];

    for (let slotIndex = 0; slotIndex < 8; slotIndex++) {
      const sprite = createNameTagSprite();
      this.sprites.push(sprite);
      this.root.add(sprite);
    }

    if (this.scene) {
      this.scene.add(this.root);
    }
  }

  public setBoostBorderOverride(override: NameTagBoostBorderOverride): void {
    this.boostBorderOverride = override;
  }

  public update(
    arena: NameTagArenaHost | null | undefined,
    numCars = 0,
    camera: THREE.PerspectiveCamera | null = null
  ): void {
    if (!arena || !this.root) return;
    const config = getNameTagConfig();
    const runtimeState = getNameTagRuntimeState();

    const isGoalReplayActive = Boolean(arena.isGoalReplayActive);
    const isDirectorOrGoalReplay =
      isGoalReplayActive ||
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
      hideOverlayCanvas(this._overlayState);
      return;
    }

    this.root.visible = true;
    const activeCamera = camera || arena.camera || null;
    if (typeof activeCamera?.updateMatrixWorld === 'function') {
      activeCamera.updateMatrixWorld();
    }

    const maxSlots = Math.min(
      this.sprites.length,
      Math.max(arena.cars?.length || 0, numCars)
    );

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
    const isCinematicCamera = cameraMode === 'director';
    const isTunerFreeCamOverview = Boolean(
      runtimeState.isTunerArenaActive && cameraMode === 'free'
    );

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
      typeof window !== 'undefined' && window.devicePixelRatio
        ? window.devicePixelRatio
        : 1;

    const overlayCanvas = ensureOverlayCanvas(this._overlayState);
    const useHighDpiOverlay = Boolean(overlayCanvas && this._overlayState.overlayCtx);

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
      Math.min(
        32,
        Math.round(Number(config.maxChars) || DEFAULT_NAME_TAG_CONFIG.maxChars)
      )
    );

    const measureCtx =
      this._overlayState.overlayCtx ||
      this.sprites[0]?.userData?.canvas?.getContext?.('2d') ||
      null;
    let measuredMaxRefTextWidthPx: number | undefined;
    if (measureCtx) {
      measureCtx.save();
      measureCtx.setTransform(1, 0, 0, 1, 0, 0);
      measureCtx.font = `${fontWeight} ${rawFontSize}px ${fontFamilyCss}`;
      measuredMaxRefTextWidthPx = measureCtx.measureText('M'.repeat(maxChars)).width;
    }

    const projectionParams: CarProjectionConfigParams = {
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
    };

    const carEntries: NameTagCarEntry[] = Array.isArray(runtimeState.carEntries)
      ? runtimeState.carEntries
      : [];

    const resolveCarTeam = (carIdx: number): 0 | 1 => {
      const entry = carEntries.find((item) => item.carIndex === carIdx);
      const rawTeam =
        typeof entry?.team === 'number'
          ? entry.team
          : (entry?.team as unknown) === 'orange'
            ? 1
            : (entry?.team as unknown) === 'blue'
              ? 0
              : typeof arena.carTeams?.[carIdx] === 'number'
                ? arena.carTeams[carIdx]
                : carIdx < 3
                  ? 0
                  : 1;
      return Number(rawTeam) === 1 ? 1 : 0;
    };

    const focusedCarTeam = resolveCarTeam(focusedCarIndex);
    const systemOverride =
      this.boostBorderOverride !== null
        ? this.boostBorderOverride
        : (arena.boostBorderOverride ?? null);

    this._visibleSprites.length = 0;
    this._visibleCards2D.length = 0;
    const telemetryCars: NameTagCarTelemetry[] = [];

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

      const carEntry = carEntries.find((entry) => entry.carIndex === carIndex);
      const rawName =
        carEntry?.name ||
        (carEntry as { username?: string } | undefined)?.username ||
        config.previewNames?.[carIndex % 6] ||
        `Player ${carIndex + 1}`;
      const team = resolveCarTeam(carIndex);
      const displayText = formatNameTagDisplayText(rawName, maxChars);

      const liveBoostAmount =
        arena.carBoostAmounts && carIndex < arena.carBoostAmounts.length
          ? Number(arena.carBoostAmounts[carIndex])
          : undefined;

      const boostBorderState = resolveCarBoostBorderState({
        config,
        carEntry,
        carIndex,
        carTeam: team,
        focusedCarIndex,
        focusedCarTeam,
        isGoalReplayActive,
        isCinematicCamera,
        isTunerFreeCamOverview,
        liveCarBoostAmount: liveBoostAmount,
        runtimeOverride: runtimeState.boostBorderOverride,
        systemOverride,
      });

      const projected = projectCarNameTag({
        carIndex,
        carMesh,
        rawName,
        displayText,
        team,
        shouldHideFocusedCar,
        boostAmount: boostBorderState.boostAmount,
        boostBorderVisible: boostBorderState.visible,
        boostFraction: boostBorderState.boostFraction,
        boostBorderColorHex: boostBorderState.borderColorHex,
        activeCamera,
        cameraUpVector: this.cameraUpVector,
        cameraForwardVector: this.cameraForwardVector,
        projVector: this._projVector,
        measureCtx,
        params: projectionParams,
      });

      if (!projected) {
        sprite.visible = false;
        continue;
      }

      if (projected.telemetry) {
        telemetryCars.push(projected.telemetry);
      }

      if (shouldHideFocusedCar) {
        sprite.visible = false;
        continue;
      }

      sprite.userData.cameraDistanceSq = projected.cameraDistanceSq;
      sprite.position.set(
        projected.spritePosX,
        projected.spritePosY,
        projected.spritePosZ
      );
      sprite.scale.set(projected.baseWidthWorld, projected.baseHeightWorld, 1);

      if (useHighDpiOverlay && activeCamera?.projectionMatrix) {
        sprite.visible = false;
        if (projected.card2D) {
          this._visibleCards2D.push(projected.card2D);
        }
      } else {
        renderPillCardToSprite({
          sprite,
          displayText,
          team,
          config,
          carPillWidthPx: projected.carPillWidthPx,
          effectiveCornerRadiusPx: projected.effectiveCornerRadiusPx,
          boostBorderVisible: boostBorderState.visible,
          boostFraction: boostBorderState.boostFraction,
          boostBorderColor: boostBorderState.borderColorHex,
        });
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
      const ballOcclusion = projectBallOcclusion2D(
        arena.ball,
        arena.ballRadius ?? 95,
        activeCamera,
        this.cameraForwardVector,
        this._projVector,
        viewportWidthPx,
        viewportHeightPx,
        tanHalfFov,
        config
      );
      renderHighDpiOverlay(
        this._overlayState,
        this._visibleCards2D,
        viewportWidthPx,
        viewportHeightPx,
        devicePixelRatio,
        config,
        ballOcclusion
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

  public dispose(): void {
    hideOverlayCanvas(this._overlayState);
    if (
      this._overlayState.overlayCanvas &&
      this._overlayState.overlayCanvas.parentNode
    ) {
      this._overlayState.overlayCanvas.parentNode.removeChild(
        this._overlayState.overlayCanvas
      );
    }
    this._overlayState.overlayCanvas = null;
    this._overlayState.overlayCtx = null;

    for (const sprite of this.sprites) {
      sprite?.userData?.texture?.dispose?.();
      sprite?.userData?.material?.dispose?.();
    }
    if (this.root && this.scene) {
      this.scene.remove(this.root);
    }
  }
}
