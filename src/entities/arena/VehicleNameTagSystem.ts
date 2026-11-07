import * as THREE from 'three';
import {
  formatNameTagDisplayText,
  resolveCarSlotCode,
  shouldUseSingleCharIndicator,
  type NameTagBoostBorderOverride,
  type NameTagCarEntry,
  type NameTagCarTelemetry,
} from '../../ui-core/config/nameTagConfig';
import type { CarAerialClimbStatus } from './VehicleAerialClimbTracker';
import { getNameTagConfig, getNameTagRuntimeState, setNameTagTelemetrySnapshot } from '../../game/runtimeUiPort.ts';
import {
  createNameTagSprite,
  ensureOverlayCanvas,
  hideOverlayCanvas,
  projectBallOcclusion2D,
  renderHighDpiOverlay,
  renderPillCardToSprite,
  roundMetric,
  type NameTagOffscreenIndicatorCard2D,
  type NameTagOverlayCanvasState,
  type NameTagSprite,
  type VisibleNameTagCard2D,
} from './VehicleNameTagCanvasRenderer';
import { resolveCarBoostBorderState } from './VehicleNameTagBoostBorderPolicy';
import {
  VehicleNameTagGroundSimVisual,
  buildDistanceSimOffscreenIndicator2D,
  buildPovActionSimulationIndicator2D,
  resolveCarAerialClimbSimulation,
} from './VehicleNameTagGroundSimVisual';
import { buildCarProjectionConfigParams, projectCarNameTag } from './VehicleNameTagProjector';

export interface NameTagArenaHost {
  ball?: THREE.Object3D | null;
  ballRadius?: number;
  cars?: Array<THREE.Object3D | null | undefined>;
  carTeams?: ArrayLike<number>;
  carColors?: Array<string | number | null | undefined>;
  carBoostAmounts?: ArrayLike<number>;
  carVerticalVelZUu?: ArrayLike<number>;
  carAirborneFlipExhausted?: ArrayLike<number>;
  carAerialClimbStatuses?: ArrayLike<CarAerialClimbStatus>;
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
  public readonly root = new THREE.Group();
  public readonly sprites: NameTagSprite[] = [];
  public boostBorderOverride: NameTagBoostBorderOverride = null;

  private readonly _visibleSprites: NameTagSprite[] = [];
  private readonly _visibleCards2D: VisibleNameTagCard2D[] = [];
  private readonly _offscreenIndicators2D: NameTagOffscreenIndicatorCard2D[] = [];
  private readonly _groundSimVisual: VehicleNameTagGroundSimVisual;
  private readonly cameraUpVector = new THREE.Vector3(0, 1, 0);
  private readonly cameraForwardVector = new THREE.Vector3(0, 0, -1);
  private readonly cameraRightVector = new THREE.Vector3(1, 0, 0);
  private readonly _projVector = new THREE.Vector3();
  private readonly _overlayState: NameTagOverlayCanvasState = { overlayCanvas: null, overlayCtx: null };

  constructor(scene: THREE.Scene | null | undefined) {
    this.scene = scene;
    this.root.name = 'vehicle-name-tags';
    for (let i = 0; i < 8; i++) {
      const s = createNameTagSprite();
      this.sprites.push(s);
      this.root.add(s);
    }
    this._groundSimVisual = new VehicleNameTagGroundSimVisual(this.root);
    if (this.scene) this.scene.add(this.root);
  }

  public setBoostBorderOverride(override: NameTagBoostBorderOverride): void {
    this.boostBorderOverride = override;
  }

  public update(arena: NameTagArenaHost | null | undefined, numCars = 0, camera: THREE.PerspectiveCamera | null = null): void {
    if (!arena || !this.root) return;
    const config = getNameTagConfig();
    const runtime = getNameTagRuntimeState();
    const isGoalReplay = Boolean(arena.isGoalReplayActive);
    const shouldShow =
      Boolean(config.enabled) &&
      Boolean(
        runtime.isTunerArenaActive ||
          runtime.isMultiplayerOrMultiCarMode ||
          arena.isLobbyMode ||
          config.aerialClimbSimulatePovInTuner ||
          config.offscreenDistanceSimEnabled ||
          config.showOnLocalCar ||
          isGoalReplay ||
          arena.cameraMode === 'director' ||
          runtime.activeCameraMode === 'director' ||
          numCars > 1
      );

    if (!shouldShow) {
      this.root.visible = false;
      hideOverlayCanvas(this._overlayState);
      return;
    }

    this.root.visible = true;
    const activeCam = camera || arena.camera || null;
    activeCam?.updateMatrixWorld?.();

    const maxSlots = Math.min(this.sprites.length, Math.max(arena.cars?.length || 0, numCars));
    const camMode = arena.cameraMode || runtime.activeCameraMode || (arena.isFreeCam ? 'free' : 'pov');
    const isPovCam =
      camMode === 'director' || camMode === 'free' || camMode === 'podium'
        ? false
        : typeof arena.isPovCamera === 'boolean'
          ? arena.isPovCamera
          : camMode === 'pov' || camMode === 'wasmPov' || camMode === 'rearView';
    const focusedIdx =
      typeof arena.focusedCarIndex === 'number'
        ? arena.focusedCarIndex
        : typeof runtime.focusedCarIndex === 'number'
          ? runtime.focusedCarIndex
          : (arena.playerCarIndex ?? 0);

    if (activeCam?.quaternion) {
      const q = activeCam.quaternion;
      this.cameraUpVector.set(0, 1, 0).applyQuaternion(q).normalize();
      this.cameraForwardVector.set(0, 0, -1).applyQuaternion(q).normalize();
      this.cameraRightVector.set(1, 0, 0).applyQuaternion(q).normalize();
    } else {
      this.cameraUpVector.set(0, 1, 0);
      this.cameraForwardVector.set(0, 0, -1);
      this.cameraRightVector.set(1, 0, 0);
    }

    const vw = typeof window !== 'undefined' ? window.innerWidth || 1920 : 1920;
    const vh = typeof window !== 'undefined' ? window.innerHeight || 1080 : 1080;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const useOverlay = Boolean(ensureOverlayCanvas(this._overlayState) && this._overlayState.overlayCtx);

    const fovDeg = Number(activeCam?.fov) || 80;
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(fovDeg * 0.5));

    const measureCtx = this._overlayState.overlayCtx || this.sprites[0]?.userData?.canvas?.getContext?.('2d') || null;
    if (measureCtx) {
      measureCtx.save();
      measureCtx.setTransform(1, 0, 0, 1, 0, 0);
    }

    const pillProjectionParams = buildCarProjectionConfigParams(config, false, vw, vh, tanHalfFov, measureCtx);
    const singleCharProjectionParams = buildCarProjectionConfigParams(config, true, vw, vh, tanHalfFov, measureCtx);

    const carEntries: NameTagCarEntry[] = Array.isArray(runtime.carEntries) ? runtime.carEntries : [];
    const resolveCarTeam = (carIdx: number): 0 | 1 => {
      const entry = carEntries.find((item) => item.carIndex === carIdx);
      const t = entry?.team as unknown;
      const raw = typeof t === 'number' ? t : t === 'orange' ? 1 : t === 'blue' ? 0 : (arena.carTeams?.[carIdx] ?? (carIdx < 3 ? 0 : 1));
      return Number(raw) === 1 ? 1 : 0;
    };

    const focusedCarTeam = resolveCarTeam(focusedIdx);
    const sysOverride = this.boostBorderOverride !== null ? this.boostBorderOverride : (arena.boostBorderOverride ?? null);

    this._visibleSprites.length = 0;
    this._visibleCards2D.length = 0;
    this._offscreenIndicators2D.length = 0;
    const telemetryCars: NameTagCarTelemetry[] = [];

    for (let carIndex = 0; carIndex < this.sprites.length; carIndex++) {
      const sprite = this.sprites[carIndex];
      if (!sprite) continue;
      const carMesh = arena.cars?.[carIndex];
      if (carIndex >= maxSlots || !carMesh?.visible) {
        sprite.visible = false;
        continue;
      }

      const shouldHideFocusedCar = isPovCam && carIndex === focusedIdx && !config.showOnLocalCar;
      const carEntry = carEntries.find((e) => e.carIndex === carIndex);
      const rawName =
        carEntry?.name ||
        (carEntry as { username?: string } | undefined)?.username ||
        config.previewNames?.[carIndex % 6] ||
        `Player ${carIndex + 1}`;
      const team = resolveCarTeam(carIndex);
      const isSingleChar = shouldUseSingleCharIndicator(config, team, focusedCarTeam);
      const projectionParams = isSingleChar ? singleCharProjectionParams : pillProjectionParams;
      const displayText = isSingleChar
        ? resolveCarSlotCode(carIndex, team, config.slotCodes)
        : formatNameTagDisplayText(rawName, projectionParams.maxChars);
      const liveBoost = arena.carBoostAmounts && carIndex < arena.carBoostAmounts.length ? Number(arena.carBoostAmounts[carIndex]) : undefined;

      const simClimb = resolveCarAerialClimbSimulation({
        config,
        carIndex,
        focusedCarIndex: focusedIdx,
        isTunerArenaActive: Boolean(runtime.isTunerArenaActive),
        carEntry,
        carAerialClimbStatuses: arena.carAerialClimbStatuses,
        carAirborneFlipExhausted: arena.carAirborneFlipExhausted,
        carVerticalVelZUu: arena.carVerticalVelZUu,
      });

      const boostState = resolveCarBoostBorderState({
        config,
        carEntry: simClimb.effectiveCarEntry,
        carIndex,
        carTeam: team,
        focusedCarIndex: focusedIdx,
        focusedCarTeam,
        isGoalReplayActive: isGoalReplay,
        isCinematicCamera: camMode === 'director',
        isTunerFreeCamOverview: Boolean(runtime.isTunerArenaActive && camMode === 'free'),
        liveCarBoostAmount: liveBoost,
        liveCarDoubleJumpedAndClimbing: simClimb.liveCarDoubleJumpedAndClimbing,
        runtimeOverride: runtime.boostBorderOverride,
        systemOverride: sysOverride,
      });

      const projected = projectCarNameTag({
        carIndex,
        carMesh,
        rawName,
        displayText,
        team,
        shouldHideFocusedCar,
        boostAmount: boostState.boostAmount,
        boostBorderVisible: boostState.visible,
        boostFraction: boostState.boostFraction,
        boostBorderColorHex: boostState.borderColorHex,
        offscreenAudienceVisible: boostState.offscreenAudienceVisible,
        isDoubleJumpedAndClimbing: boostState.isDoubleJumpedAndClimbing,
        aerialClimbGlowVisible: boostState.aerialClimbGlowVisible,
        aerialClimbTriggerReason: simClimb.aerialClimbTriggerReason,
        carAltitudeUu: simClimb.activeClimbStatus?.altitudeUu,
        carVelZUu: simClimb.activeClimbStatus?.velZUu,
        carPitchFwdZ: simClimb.activeClimbStatus?.pitchFwdZ,
        carJumpHoldMs: simClimb.activeClimbStatus?.maxJumpHoldMs,
        povCarPosition: arena.cars?.[focusedIdx]?.position ?? null,
        liveCarColorHex:
          typeof arena.carColors?.[carIndex] === 'string'
            ? (arena.carColors[carIndex] as string)
            : typeof arena.carColors?.[carIndex] === 'number'
              ? `#${(Math.trunc(arena.carColors[carIndex] as number) & 0xffffff).toString(16).padStart(6, '0')}`
              : null,
        activeCamera: activeCam,
        cameraUpVector: this.cameraUpVector,
        cameraForwardVector: this.cameraForwardVector,
        cameraRightVector: this.cameraRightVector,
        projVector: this._projVector,
        measureCtx,
        params: projectionParams,
      });

      if (!projected) {
        sprite.visible = false;
        continue;
      }
      if (projected.telemetry) telemetryCars.push(projected.telemetry);
      if (shouldHideFocusedCar) {
        sprite.visible = false;
        continue;
      }
      if (projected.isOffscreen) {
        sprite.visible = false;
        if (projected.offscreenIndicator2D) this._offscreenIndicators2D.push(projected.offscreenIndicator2D);
        continue;
      }

      sprite.userData.cameraDistanceSq = projected.cameraDistanceSq;
      sprite.position.set(projected.spritePosX, projected.spritePosY, projected.spritePosZ);
      sprite.scale.set(projected.baseWidthWorld, projected.baseHeightWorld, 1);

      if (useOverlay && activeCam?.projectionMatrix) {
        sprite.visible = false;
        if (projected.card2D) this._visibleCards2D.push(projected.card2D);
      } else {
        renderPillCardToSprite({
          sprite,
          displayText,
          team,
          config,
          variant: projectionParams.variant,
          carPillWidthPx: projected.carPillWidthPx,
          effectiveCornerRadiusPx: projected.effectiveCornerRadiusPx,
          boostBorderVisible: boostState.visible,
          boostFraction: boostState.boostFraction,
          boostBorderColor: boostState.borderColorHex,
          aerialClimbGlowVisible: false,
        });
        sprite.material.opacity = projectionParams.cardOpacity;
        sprite.visible = true;
        this._visibleSprites.push(sprite);
      }
    }

    measureCtx?.restore();

    const povCarMesh = arena.cars?.[focusedIdx] ?? null;
    const povClimb = arena.carAerialClimbStatuses?.[focusedIdx];
    const povBoost = arena.carBoostAmounts && focusedIdx >= 0 && focusedIdx < arena.carBoostAmounts.length ? Number(arena.carBoostAmounts[focusedIdx]) : undefined;

    this._groundSimVisual.update(config, povCarMesh, this.cameraForwardVector, this.cameraRightVector);
    const povSim = buildPovActionSimulationIndicator2D({
      config,
      povCarMesh,
      focusedCarIndex: focusedIdx,
      focusedCarTeam,
      liveBoostAmount: povBoost,
      povClimbStatus: povClimb,
      activeCamera: activeCam,
      cameraUpVector: this.cameraUpVector,
      projVector: this._projVector,
      viewportWidthPx: vw,
      viewportHeightPx: vh,
    });
    if (povSim) this._offscreenIndicators2D.push(povSim);

    const distSim = buildDistanceSimOffscreenIndicator2D({ config, viewportWidthPx: vw, viewportHeightPx: vh, povClimbStatus: povClimb });
    if (distSim) this._offscreenIndicators2D.push(distSim);

    const r1 = (n: number) => roundMetric(n, 1);
    const r4 = (n: number) => roundMetric(n, 4);
    setNameTagTelemetrySnapshot({
      updatedAtMs: Date.now(),
      viewportWidthPx: vw,
      viewportHeightPx: vh,
      aspectRatio: vw / Math.max(1, vh),
      devicePixelRatio: dpr,
      cameraMode: camMode,
      focusedCarIndex: focusedIdx,
      cameraFovDeg: fovDeg,
      cameraPosition: activeCam?.position ? [r1(activeCam.position.x), r1(activeCam.position.y), r1(activeCam.position.z)] : [0, 0, 0],
      cameraForward: [r4(this.cameraForwardVector.x), r4(this.cameraForwardVector.y), r4(this.cameraForwardVector.z)],
      cameraUp: [r4(this.cameraUpVector.x), r4(this.cameraUpVector.y), r4(this.cameraUpVector.z)],
      cars: telemetryCars,
    });

    if (useOverlay) {
      const occ = projectBallOcclusion2D(arena.ball, arena.ballRadius ?? 95, activeCam, this.cameraForwardVector, this._projVector, vw, vh, tanHalfFov, config);
      renderHighDpiOverlay(this._overlayState, this._visibleCards2D, vw, vh, dpr, config, occ, this._offscreenIndicators2D);
    } else {
      this._visibleSprites.sort((a, b) => (a.userData.cameraDistanceSq || 0) - (b.userData.cameraDistanceSq || 0));
      for (let i = 0; i < this._visibleSprites.length; i++) this._visibleSprites[i].renderOrder = 950 + i;
    }
  }

  public dispose(): void {
    hideOverlayCanvas(this._overlayState);
    this._overlayState.overlayCanvas?.parentNode?.removeChild(this._overlayState.overlayCanvas);
    this._overlayState.overlayCanvas = null;
    this._overlayState.overlayCtx = null;
    for (const s of this.sprites) {
      s?.userData?.texture?.dispose?.();
      s?.userData?.material?.dispose?.();
    }
    if (this.root && this.scene) this.scene.remove(this.root);
  }
}
