/**
 * vnextHudRosterConsumer.ts
 * Pure HUD 1~6 consumer reading RosterManifest.team + WorldFrame.cameraFocus.
 * Completely decoupled from local playerCarIndex.
 */
import { computeRightTeamStartSlotKey } from '../../../replay/container/RCReplayTimelineParser.ts';
import {
  computeMiniMapCoordinates,
  createHudTransientFrameBuffer,
  projectNameTagScreenPositions,
  type CarHudTelemetry,
  type HudTransientCameraInput,
  type HudTransientFramePayload,
  type HudTransientPhysicsStateInput,
  type HudTransientPlayerSlotPayload,
} from './hudTransientFramePipeline.ts';
import type {
  VNextCarHudTelemetry,
  VNextRosterEntry,
  VNextRosterManifest,
  VNextWorldFrameCameraAndHudHeader,
} from './vnextHudCameraTypes.ts';

const EMPTY_BLUE_NAMES = ['Blue #1', 'Blue #2', 'Blue #3', 'Blue #4', 'Blue #5', 'Blue #6'];
const EMPTY_ORANGE_NAMES = [
  'Orange #1',
  'Orange #2',
  'Orange #3',
  'Orange #4',
  'Orange #5',
  'Orange #6',
];

const _defaultVNextBuffer = createHudTransientFrameBuffer();
const _blueScratch: VNextRosterEntry[] = [];
const _orangeScratch: VNextRosterEntry[] = [];
const _telemetryByCarScratch = new Map<number, VNextCarHudTelemetry>();

function compareBySlotOrCarIndex(a: VNextRosterEntry, b: VNextRosterEntry): number {
  const sa = typeof a.slotKey === 'number' ? a.slotKey : a.carIndex;
  const sb = typeof b.slotKey === 'number' ? b.slotKey : b.carIndex;
  if (sa !== sb) return sa - sb;
  return a.carIndex - b.carIndex;
}

function resolveTelemetryForCar(
  carIndex: number,
  physicsState: HudTransientPhysicsStateInput | null | undefined
): CarHudTelemetry {
  const fromHeader = _telemetryByCarScratch.get(carIndex);
  if (fromHeader) {
    return {
      boostAmount: fromHeader.boostAmount,
      isDemolished: fromHeader.isDemolished,
      demoRespawnRemainingSec: fromHeader.demoRespawnRemainingSec,
      demolishedAtMs: fromHeader.demolishedAtMs ?? 0,
    };
  }
  if (physicsState) {
    return physicsState.resolveCarTelemetry(carIndex);
  }
  return {
    boostAmount: 0,
    isDemolished: false,
    demoRespawnRemainingSec: 0,
    demolishedAtMs: 0,
  };
}

function applyManifestSlotInPlace(
  slot: HudTransientPlayerSlotPayload,
  side: 'left' | 'right',
  slotKeyRaw: number,
  emptyNames: readonly string[],
  entry: VNextRosterEntry | undefined,
  physicsState: HudTransientPhysicsStateInput | null | undefined,
  isGoalReplayView: boolean,
  isDirectorCamera: boolean,
  focusedCarIndex: number | null,
  isSpectatorSession: boolean
): boolean {
  const slotKey = Math.min(6, Math.max(1, slotKeyRaw));
  let dirty = false;

  if (!entry) {
    const emptyName = emptyNames[slotKey - 1] || `Slot #${slotKey}`;
    if (
      slot.exists !== false ||
      slot.slotKey !== slotKey ||
      slot.carIndex !== undefined ||
      slot.team !== side ||
      slot.name !== emptyName ||
      slot.boostAmount !== 0 ||
      slot.isSelf !== false ||
      slot.isFocusedPov !== false ||
      slot.isDemolished !== false ||
      slot.demoRespawnRemainingSec !== 0 ||
      slot.demolishedAtMs !== 0 ||
      slot.replaySkipReady !== false
    ) {
      slot.slotKey = slotKey;
      slot.carIndex = undefined;
      slot.team = side;
      slot.name = emptyName;
      slot.boostAmount = 0;
      slot.exists = false;
      slot.isSelf = false;
      slot.isFocusedPov = false;
      slot.isDemolished = false;
      slot.demoRespawnRemainingSec = 0;
      slot.demoRespawnTotalSec = 3.0;
      slot.demolishedAtMs = 0;
      slot.replaySkipReady = false;
      dirty = true;
    }
    return dirty;
  }

  const tel = resolveTelemetryForCar(entry.carIndex, physicsState);
  const headerTel = _telemetryByCarScratch.get(entry.carIndex);
  const isSelf = Boolean(!isSpectatorSession && entry.roleFlag === 'player' && entry.isLocalPlayer);
  const isFocused =
    isGoalReplayView && isDirectorCamera
      ? false
      : typeof focusedCarIndex === 'number' &&
        focusedCarIndex >= 0 &&
        entry.carIndex === focusedCarIndex;
  const replaySkipReady = isGoalReplayView ? Boolean(entry.isBot || headerTel?.replaySkipReady) : false;

  if (
    slot.exists !== true ||
    slot.slotKey !== slotKey ||
    slot.carIndex !== entry.carIndex ||
    slot.team !== side ||
    slot.name !== entry.name ||
    slot.boostAmount !== tel.boostAmount ||
    slot.isSelf !== isSelf ||
    slot.isFocusedPov !== isFocused ||
    slot.isDemolished !== tel.isDemolished ||
    slot.demoRespawnRemainingSec !== tel.demoRespawnRemainingSec ||
    slot.demolishedAtMs !== tel.demolishedAtMs ||
    slot.replaySkipReady !== replaySkipReady
  ) {
    slot.slotKey = slotKey;
    slot.carIndex = entry.carIndex;
    slot.team = side;
    slot.name = entry.name;
    slot.boostAmount = tel.boostAmount;
    slot.exists = true;
    slot.isSelf = isSelf;
    slot.isFocusedPov = isFocused;
    slot.isDemolished = tel.isDemolished;
    slot.demoRespawnRemainingSec = tel.demoRespawnRemainingSec;
    slot.demoRespawnTotalSec = 3.0;
    slot.demolishedAtMs = tel.demolishedAtMs;
    slot.replaySkipReady = replaySkipReady;
    dirty = true;
  }
  return dirty;
}

export function buildHudFrameFromRosterManifest(
  manifest: VNextRosterManifest,
  frameHeader: VNextWorldFrameCameraAndHudHeader,
  physicsState?: HudTransientPhysicsStateInput | null,
  camera?: Pick<HudTransientCameraInput, 'perspectiveCamera' | 'viewportWidthPx' | 'viewportHeightPx'> | null,
  targetBuffer: HudTransientFramePayload = _defaultVNextBuffer
): HudTransientFramePayload {
  _blueScratch.length = 0;
  _orangeScratch.length = 0;
  _telemetryByCarScratch.clear();

  const carTel = frameHeader.carTelemetry;
  if (Array.isArray(carTel)) {
    for (let i = 0; i < carTel.length; i++) {
      const item = carTel[i];
      if (item && typeof item.carIndex === 'number') {
        _telemetryByCarScratch.set(item.carIndex, item);
      }
    }
  }

  let hasHumanLocalPlayer = false;
  let detectedLocalTeam: 0 | 1 = 0;
  const isSpectatorSession = Boolean(manifest.isSpectatorSession);

  for (let i = 0; i < manifest.entries.length; i++) {
    const entry = manifest.entries[i];
    if (!entry || entry.roleFlag === 'ghost') continue;
    if (entry.team === 1) {
      _orangeScratch.push(entry);
    } else {
      _blueScratch.push(entry);
    }
    if (!isSpectatorSession && entry.roleFlag === 'player' && entry.isLocalPlayer) {
      hasHumanLocalPlayer = true;
      detectedLocalTeam = entry.team === 1 ? 1 : 0;
    }
  }

  _blueScratch.sort(compareBySlotOrCarIndex);
  _orangeScratch.sort(compareBySlotOrCarIndex);

  const localTeam: 0 | 1 = hasHumanLocalPlayer ? detectedLocalTeam : 0;
  const leftEntries = localTeam === 1 ? _orangeScratch : _blueScratch;
  const rightEntries = localTeam === 1 ? _blueScratch : _orangeScratch;
  const leftEmptyNames = localTeam === 1 ? EMPTY_ORANGE_NAMES : EMPTY_BLUE_NAMES;
  const rightEmptyNames = localTeam === 1 ? EMPTY_BLUE_NAMES : EMPTY_ORANGE_NAMES;

  const leftCount = Math.min(5, leftEntries.length);
  const rightCount = Math.min(5, rightEntries.length);
  const rightStartKey = computeRightTeamStartSlotKey(leftCount, rightCount);

  const slotKeyToCarIndex = targetBuffer.slotKeyToCarIndex;
  for (let k = 1; k <= 6; k++) {
    delete slotKeyToCarIndex[k];
  }
  for (let i = 0; i < leftCount; i++) {
    const slotKey = Math.min(6, i + 1);
    slotKeyToCarIndex[slotKey] = leftEntries[i].carIndex;
  }
  for (let j = 0; j < rightCount; j++) {
    const slotKey = Math.min(6, rightStartKey + j);
    slotKeyToCarIndex[slotKey] = rightEntries[j].carIndex;
  }

  const { cameraFocus } = frameHeader;
  const isGoalReplayView =
    Boolean(cameraFocus.isGoalReplayActive) ||
    frameHeader.phase === 'replay' ||
    frameHeader.choreographySignal === 'goal-replay-started' ||
    frameHeader.choreographySignal === 'goal-replay-will-end';
  const isDirectorCamera =
    cameraFocus.cameraMode === 'director' || cameraFocus.replayCameraMode === 'director';
  const viewMode: 'player-live' | 'goal-replay' | 'spectator' = isGoalReplayView
    ? 'goal-replay'
    : isSpectatorSession || !hasHumanLocalPlayer
      ? 'spectator'
      : 'player-live';

  let focusedSlotKey: number | null = null;
  let rosterDirty = false;
  const leftPlayers = targetBuffer.rosterPatch.leftPlayers;
  const rightPlayers = targetBuffer.rosterPatch.rightPlayers;

  for (let idx = 0; idx < 5; idx++) {
    const slotKeyRaw = idx < leftCount ? Math.min(6, idx + 1) : idx + 1;
    const slot = leftPlayers[idx];
    if (
      applyManifestSlotInPlace(
        slot,
        'left',
        slotKeyRaw,
        leftEmptyNames,
        leftEntries[idx],
        physicsState,
        isGoalReplayView,
        isDirectorCamera,
        cameraFocus.focusedCarIndex,
        isSpectatorSession
      )
    ) {
      rosterDirty = true;
    }
    if (slot.exists && slot.isFocusedPov) {
      focusedSlotKey = slot.slotKey;
    }
  }

  for (let idx = 0; idx < 5; idx++) {
    const slotKeyRaw = idx < rightCount ? Math.min(6, rightStartKey + idx) : rightStartKey + idx;
    const slot = rightPlayers[idx];
    if (
      applyManifestSlotInPlace(
        slot,
        'right',
        slotKeyRaw,
        rightEmptyNames,
        rightEntries[idx],
        physicsState,
        isGoalReplayView,
        isDirectorCamera,
        cameraFocus.focusedCarIndex,
        isSpectatorSession
      )
    ) {
      rosterDirty = true;
    }
    if (slot.exists && slot.isFocusedPov) {
      focusedSlotKey = slot.slotKey;
    }
  }

  if (
    targetBuffer.rosterPatch.viewMode !== viewMode ||
    targetBuffer.rosterPatch.focusedSlotKey !== focusedSlotKey ||
    targetBuffer.localTeam !== localTeam
  ) {
    targetBuffer.rosterPatch.viewMode = viewMode;
    targetBuffer.rosterPatch.focusedSlotKey = focusedSlotKey;
    targetBuffer.localTeam = localTeam;
    rosterDirty = true;
  }

  const { dirty: miniMapDirty } = computeMiniMapCoordinates(
    physicsState?.ballPosX ?? 0,
    physicsState?.ballPosY ?? 0,
    physicsState?.ballVelX ?? 0,
    physicsState?.ballVelY ?? 0,
    physicsState?.ballVelZ ?? 0,
    localTeam,
    targetBuffer.miniMap
  );

  projectNameTagScreenPositions(
    physicsState?.carPositions,
    camera?.perspectiveCamera,
    camera?.viewportWidthPx,
    camera?.viewportHeightPx,
    targetBuffer.nameTagProjections
  );

  targetBuffer.rosterDirty = rosterDirty;
  targetBuffer.miniMapDirty = miniMapDirty;
  return targetBuffer;
}

export interface VNextHudChannelPushState {
  hasPushedInitialRoster: boolean;
  hasPushedInitialMiniMap: boolean;
}

export function pushVNextHudFrameToChannel(
  manifest: VNextRosterManifest,
  frameHeader: VNextWorldFrameCameraAndHudHeader,
  physicsState: HudTransientPhysicsStateInput,
  camera: Pick<HudTransientCameraInput, 'perspectiveCamera' | 'viewportWidthPx' | 'viewportHeightPx'>,
  frameBuffer: HudTransientFramePayload,
  pushState: VNextHudChannelPushState,
  hudChannel: {
    setRoster: (patch: HudTransientFramePayload['rosterPatch']) => void;
    setMiniMap?: (miniMap: HudTransientFramePayload['miniMap']) => void;
  },
  hudState?: { localTeam?: number; setMatchState?: (s: { localTeam: 0 | 1 }) => void } | null,
  runtimeTarget?: {
    _lastHudSlotCarMap?: Record<number, number>;
    interpolator?: { getCurrBallStateView?: () => { posX?: number; posY?: number; posZ?: number; velX?: number; velY?: number; velZ?: number } | null } | null;
    physics?: { getBallStateView?: () => { posX?: number; posY?: number; posZ?: number; velX?: number; velY?: number; velZ?: number } | null } | null;
    camera?: { camera?: HudTransientCameraInput['perspectiveCamera'] } | null;
  } | null
): void {
  const ballView =
    runtimeTarget?.interpolator?.getCurrBallStateView?.() ||
    runtimeTarget?.physics?.getBallStateView?.();
  physicsState.ballPosX = ballView?.posX ?? 0;
  physicsState.ballPosY = ballView?.posY ?? 0;
  physicsState.ballPosZ = ballView?.posZ ?? 0;
  physicsState.ballVelX = ballView?.velX ?? 0;
  physicsState.ballVelY = ballView?.velY ?? 0;
  physicsState.ballVelZ = ballView?.velZ ?? 0;
  camera.perspectiveCamera = runtimeTarget?.camera?.camera ?? null;
  const payload = buildHudFrameFromRosterManifest(
    manifest,
    frameHeader,
    physicsState,
    camera,
    frameBuffer
  );
  if (hudState && hudState.localTeam !== payload.localTeam) {
    hudState.setMatchState?.({ localTeam: payload.localTeam });
  }
  if (runtimeTarget) {
    runtimeTarget._lastHudSlotCarMap = payload.slotKeyToCarIndex;
  }
  if (payload.rosterDirty || !pushState.hasPushedInitialRoster) {
    pushState.hasPushedInitialRoster = true;
    hudChannel.setRoster(payload.rosterPatch);
  }
  if (payload.miniMapDirty || !pushState.hasPushedInitialMiniMap) {
    pushState.hasPushedInitialMiniMap = true;
    hudChannel.setMiniMap?.(payload.miniMap);
  }
}
