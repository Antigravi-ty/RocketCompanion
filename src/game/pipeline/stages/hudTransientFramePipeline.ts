/**
 * hudTransientFramePipeline.ts
 * Pure data operator transforming (physicsState, camera, roster) into a HudTransientFramePayload
 * including 6-slot EdgeRosterHudState, 2D pitch mini-map coordinates, and 3D name-tag screen projections.
 */
import * as THREE from 'three';
import { assignTeamSlotKeys } from '../../../replay/container/RCReplayTimelineParser.ts';
import type { RosterTeamEntry } from './hudRosterResolverPipeline.ts';

export type * from './hudRosterResolverPipeline.ts';

const PITCH_HALF_WIDTH_UU = 4096;
const PITCH_HALF_LENGTH_UU = 5120;
const PITCH_MINIMAP_SPAN_X_PCT = 44;
const PITCH_MINIMAP_SPAN_Y_PCT = 43.5;
const UU_PER_SECOND_TO_KPH = 0.036;

export interface CarHudTelemetry {
  boostAmount: number;
  isDemolished: boolean;
  demoRespawnRemainingSec: number;
  demolishedAtMs: number;
}

export interface HudTransientPhysicsStateInput {
  ballPosX?: number;
  ballPosY?: number;
  ballPosZ?: number;
  ballVelX?: number;
  ballVelY?: number;
  ballVelZ?: number;
  carPositions?: ReadonlyArray<{
    carIndex: number;
    posX: number;
    posY: number;
    posZ: number;
  }>;
  resolveCarTelemetry: (carIndex: number) => CarHudTelemetry;
}

export interface HudTransientCameraInput {
  activeCameraCar: number;
  replayCameraMode?: string;
  perspectiveCamera?: THREE.Camera | null;
  viewportWidthPx?: number;
  viewportHeightPx?: number;
}

export interface HudTransientRosterInput {
  blueEntries: readonly RosterTeamEntry[];
  orangeEntries: readonly RosterTeamEntry[];
  detectedLocalTeam: number | null;
  isSpectatingNoHuman: boolean;
  choreographySignal?: string;
  matchPhase?: string;
  localSkipReplayReady?: boolean;
  acknowledgedJumpByCar?: ReadonlyMap<number, boolean>;
}

export interface HudTransientPlayerSlotPayload {
  slotKey: number;
  carIndex?: number;
  team: 'left' | 'right';
  name: string;
  boostAmount: number;
  exists: boolean;
  isSelf: boolean;
  isFocusedPov: boolean;
  isDemolished: boolean;
  demoRespawnRemainingSec: number;
  demoRespawnTotalSec: number;
  demolishedAtMs: number;
  replaySkipReady: boolean;
}

export interface HudTransientMiniMapPayload {
  ballX: number;
  ballY: number;
  ballNormX: number;
  ballNormY: number;
  ballHitKph: number;
  isFlipped: boolean;
}

export interface HudTransientNameTagProjection2D {
  carIndex: number;
  screenX: number;
  screenY: number;
  ndcZ: number;
  visible: boolean;
}

export interface HudTransientFramePayload {
  localTeam: 0 | 1;
  slotKeyToCarIndex: Record<number, number>;
  rosterPatch: {
    viewMode: 'player-live' | 'goal-replay' | 'spectator';
    focusedSlotKey: number | null;
    leftPlayers: HudTransientPlayerSlotPayload[];
    rightPlayers: HudTransientPlayerSlotPayload[];
  };
  miniMap: HudTransientMiniMapPayload;
  nameTagProjections: HudTransientNameTagProjection2D[];
}

const _scratchProjVec = new THREE.Vector3();

export function computeMiniMapCoordinates(
  ballPosX = 0,
  ballPosY = 0,
  ballVelX = 0,
  ballVelY = 0,
  ballVelZ = 0,
  localTeam: 0 | 1 = 0
): HudTransientMiniMapPayload {
  const clampedX = Math.max(-PITCH_HALF_WIDTH_UU, Math.min(PITCH_HALF_WIDTH_UU, ballPosX));
  const clampedY = Math.max(-PITCH_HALF_LENGTH_UU, Math.min(PITCH_HALF_LENGTH_UU, ballPosY));
  const ballX = 50 + (clampedX / PITCH_HALF_WIDTH_UU) * PITCH_MINIMAP_SPAN_X_PCT;
  const ballY = 50 - (clampedY / PITCH_HALF_LENGTH_UU) * PITCH_MINIMAP_SPAN_Y_PCT;
  const ballSpeedUu = Math.hypot(ballVelX, ballVelY, ballVelZ);
  const ballHitKph = Math.round(ballSpeedUu * UU_PER_SECOND_TO_KPH);

  return {
    ballX,
    ballY,
    ballNormX: ballX / 100,
    ballNormY: ballY / 100,
    ballHitKph,
    isFlipped: localTeam === 1,
  };
}

export function projectNameTagScreenPositions(
  carPositions:
    ReadonlyArray<{ carIndex: number; posX: number; posY: number; posZ: number }> | undefined,
  perspectiveCamera: THREE.Camera | null | undefined,
  viewportWidthPx = 1920,
  viewportHeightPx = 1080
): HudTransientNameTagProjection2D[] {
  if (!carPositions || carPositions.length === 0 || !perspectiveCamera) return [];
  const projections: HudTransientNameTagProjection2D[] = [];
  for (const car of carPositions) {
    _scratchProjVec.set(car.posX, car.posZ, car.posY).project(perspectiveCamera);
    const visible = _scratchProjVec.z >= -1 && _scratchProjVec.z <= 1;
    projections.push({
      carIndex: car.carIndex,
      screenX: (_scratchProjVec.x * 0.5 + 0.5) * viewportWidthPx,
      screenY: (-_scratchProjVec.y * 0.5 + 0.5) * viewportHeightPx,
      ndcZ: _scratchProjVec.z,
      visible,
    });
  }
  return projections;
}

export function buildHudTransientFramePayload(
  physicsState: HudTransientPhysicsStateInput,
  camera: HudTransientCameraInput,
  roster: HudTransientRosterInput
): HudTransientFramePayload {
  const { blueEntries, orangeEntries, detectedLocalTeam, isSpectatingNoHuman } = roster;
  const localInOrange = orangeEntries.some((e) => e.isSelf);
  const localInBlue = blueEntries.some((e) => e.isSelf);
  const localTeam: 0 | 1 =
    detectedLocalTeam === 1 || localInOrange ? 1 : detectedLocalTeam === 0 || localInBlue ? 0 : 0;

  const leftEntries = localTeam === 1 ? orangeEntries : blueEntries;
  const rightEntries = localTeam === 1 ? blueEntries : orangeEntries;
  const leftLabelPrefix = localTeam === 1 ? 'Orange' : 'Blue';
  const rightLabelPrefix = localTeam === 1 ? 'Blue' : 'Orange';

  const { rightStartKey, leftSlotKeys, rightSlotKeys, slotKeyToCarIndex } = assignTeamSlotKeys(
    [...leftEntries],
    [...rightEntries]
  );

  const sig = roster.choreographySignal || 'kickoff-will-start';
  const isGoalReplayView =
    sig === 'goal-replay-started' ||
    sig === 'goal-replay-will-end' ||
    roster.matchPhase === 'replay';

  const viewMode: 'player-live' | 'goal-replay' | 'spectator' = isGoalReplayView
    ? 'goal-replay'
    : isSpectatingNoHuman
      ? 'spectator'
      : 'player-live';

  const activeCameraCar = camera.activeCameraCar;
  let focusedSlotKey: number | null = null;

  const buildSideSlot = (
    _idx: number,
    side: 'left' | 'right',
    slotKeyRaw: number,
    labelPrefix: string,
    entry: RosterTeamEntry | undefined
  ): HudTransientPlayerSlotPayload => {
    const slotKey = Math.min(6, Math.max(1, slotKeyRaw));
    if (!entry) {
      return {
        slotKey,
        team: side,
        name: `${labelPrefix} #${slotKey}`,
        boostAmount: 0,
        exists: false,
        isSelf: false,
        isFocusedPov: false,
        isDemolished: false,
        demoRespawnRemainingSec: 0,
        demoRespawnTotalSec: 3.0,
        demolishedAtMs: 0,
        replaySkipReady: false,
      };
    }

    const tel = physicsState.resolveCarTelemetry(entry.carIndex);
    const isFocused =
      isGoalReplayView && camera.replayCameraMode === 'director'
        ? false
        : viewMode === 'player-live'
          ? Boolean(entry.isSelf || entry.carIndex === activeCameraCar)
          : entry.carIndex === activeCameraCar;
    if (isFocused) focusedSlotKey = slotKey;

    const replaySkipReady = isGoalReplayView
      ? Boolean(
          entry.isBot ||
          (entry.isSelf && roster.localSkipReplayReady) ||
          roster.acknowledgedJumpByCar?.get(entry.carIndex)
        )
      : false;

    return {
      slotKey,
      carIndex: entry.carIndex,
      team: side,
      name: entry.name,
      boostAmount: tel.boostAmount,
      exists: true,
      isSelf: entry.isSelf,
      isFocusedPov: isFocused,
      isDemolished: tel.isDemolished,
      demoRespawnRemainingSec: tel.demoRespawnRemainingSec,
      demoRespawnTotalSec: 3.0,
      demolishedAtMs: tel.demolishedAtMs,
      replaySkipReady,
    };
  };

  const leftPlayers = [0, 1, 2, 3, 4].map((idx) =>
    buildSideSlot(idx, 'left', leftSlotKeys[idx] ?? idx + 1, leftLabelPrefix, leftEntries[idx])
  );

  const rightPlayers = [0, 1, 2, 3, 4].map((idx) =>
    buildSideSlot(
      idx,
      'right',
      rightSlotKeys[idx] ?? rightStartKey + idx,
      rightLabelPrefix,
      rightEntries[idx]
    )
  );

  const miniMap = computeMiniMapCoordinates(
    physicsState.ballPosX ?? 0,
    physicsState.ballPosY ?? 0,
    physicsState.ballVelX ?? 0,
    physicsState.ballVelY ?? 0,
    physicsState.ballVelZ ?? 0,
    localTeam
  );

  const nameTagProjections = projectNameTagScreenPositions(
    physicsState.carPositions,
    camera.perspectiveCamera,
    camera.viewportWidthPx,
    camera.viewportHeightPx
  );

  return {
    localTeam,
    slotKeyToCarIndex,
    rosterPatch: { viewMode, focusedSlotKey, leftPlayers, rightPlayers },
    miniMap,
    nameTagProjections,
  };
}
