import {
  parseDirectorDiagnosticPatternText,
  parseDirectorDiagnosticInput,
} from '../../../replay/ReplayDirectorPatternParser.ts';
import type { ImportedDiagnosticPatternInput } from '../../../replay/ReplayDirectorStatePipeline.ts';
import {
  applyReplayCarEntriesToRuntime,
  captureRuntimeReplayCarEntries,
  type NormalizedReplayDirectorCarEntry,
  type ReplayCarEntryRuntimePort,
} from '../../../replay/replayDirectorCarRosterPipeline.ts';
import { decodeReplayDirectorTelemetryFromState } from '../../../replay/ReplayFrameInterpolator.ts';
import { extractGoalReplayFrames } from '../../../replay/ReplayPlaybackState.ts';
import type { ReplayRingBuffer, ReplayRingBufferSlot } from '../../../replay/ReplayRingBuffer.ts';
import {
  beginGoalReplaySession,
  stepGoalReplaySessionFrame,
  type GoalReplayFrameContextPort,
  type GoalReplayRuntimePort,
  type GoalReplayTimelineControllerPort,
} from './GoalReplaySessionCoordinator.ts';
import type { GoalReplayCameraMode } from './goalReplayHudPipeline.ts';

export const POST_GOAL_FREEZE_DELAY_TICKS = 30;
export const EXPIRE_REPLAY_LOOKBACK_TICKS = 1200;
export const UU_TO_KPH = 0.036;
export const TOUCH_DIRECT_DISTANCE_UU = 168.0;
export const TOUCH_IMPULSE_DISTANCE_UU = 198.0;
export const TOUCH_IMPULSE_MIN_DELTA_V_UU = 25.0;
export const DEFAULT_GRAVITY_Z_PER_TICK = -650.0 / 120.0;

export interface BallStateViewLike {
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
}
export interface CarStateViewLike {
  posX: number;
  posY: number;
  posZ: number;
  isDemoed?: boolean;
}
export interface BallVelocityTrackerState {
  prevBallVelX: number;
  prevBallVelY: number;
  prevBallVelZ: number;
}
export interface GoalScoredEvaluation {
  scored: boolean;
  scoringTeam: 0 | 1;
  ballSpeedUu: number;
  ballSpeedKph: number;
}

export interface GoalScoredEvaluationOptions {
  /**
   * Specialized for `.RLRCSPack` training packs where shots may launch outward from inside
   * the goal net: requires a positive velocity component pointing toward the inside of the goal
   * (`inwardVelUu > 0`) and rejects stationary or outward-moving balls (`outwardVelUu >= 0`
   * or `outwardVelUu > maxOutwardGoalVelocityUu`).
   */
  requireInwardGoalVelocity?: boolean;
  maxOutwardGoalVelocityUu?: number;
}

export function evaluateGoalScoredFromBallView(
  sim: { isBallScored?: (bView: BallStateViewLike) => boolean } | null | undefined,
  bView: BallStateViewLike | null | undefined,
  options?: GoalScoredEvaluationOptions
): GoalScoredEvaluation {
  if (!bView) return { scored: false, scoringTeam: 0, ballSpeedUu: 0, ballSpeedKph: 0 };
  const scored =
    typeof sim?.isBallScored === 'function'
      ? Boolean(sim.isBallScored(bView))
      : Math.abs(bView.posY) > 5120 + 91.25 &&
        Math.abs(bView.posX) < 892.755 &&
        bView.posZ < 642.775;
  if (!scored) return { scored: false, scoringTeam: 0, ballSpeedUu: 0, ballSpeedKph: 0 };

  if (options?.requireInwardGoalVelocity) {
    const inwardVelUu = bView.posY >= 0 ? bView.velY : -bView.velY;
    const outwardVelUu = -inwardVelUu;
    const maxOutwardUu = options.maxOutwardGoalVelocityUu ?? 100;
    if (inwardVelUu <= 0 || outwardVelUu > maxOutwardUu) {
      return { scored: false, scoringTeam: 0, ballSpeedUu: 0, ballSpeedKph: 0 };
    }
  }

  const scoringTeam: 0 | 1 = bView.posY > 0 ? 0 : 1;
  const ballSpeedUu = Math.hypot(bView.velX, bView.velY, bView.velZ);
  const ballSpeedKph = Math.max(1, Math.round(ballSpeedUu * UU_TO_KPH));
  return { scored: true, scoringTeam, ballSpeedUu, ballSpeedKph };
}

export function computeGravityCompensatedBallImpulse(
  bView: BallStateViewLike,
  tracker: BallVelocityTrackerState,
  gravityZPerTick = DEFAULT_GRAVITY_Z_PER_TICK
): number {
  const dvX = bView.velX - tracker.prevBallVelX;
  const dvY = bView.velY - tracker.prevBallVelY;
  const dvZ = bView.velZ - (tracker.prevBallVelZ + gravityZPerTick);
  tracker.prevBallVelX = bView.velX;
  tracker.prevBallVelY = bView.velY;
  tracker.prevBallVelZ = bView.velZ;
  return Math.hypot(dvX, dvY, dvZ);
}

export function detectSingleCarBallTouch(
  bView: BallStateViewLike | null | undefined,
  carView: CarStateViewLike | null | undefined,
  tracker: BallVelocityTrackerState
): boolean {
  if (!bView || !carView || carView.isDemoed) return false;
  const impulseMag = computeGravityCompensatedBallImpulse(bView, tracker);
  const dist = Math.hypot(
    carView.posX - bView.posX,
    carView.posY - bView.posY,
    carView.posZ - bView.posZ
  );
  return (
    dist <= TOUCH_DIRECT_DISTANCE_UU ||
    (dist <= TOUCH_IMPULSE_DISTANCE_UU && impulseMag > TOUCH_IMPULSE_MIN_DELTA_V_UU)
  );
}

export function findClosestTouchingCarIndex<T extends { carIndex: number }>(params: {
  sim: { getCarStateView?: (carIndex: number) => CarStateViewLike | null } | null | undefined;
  bView: BallStateViewLike | null | undefined;
  entries: readonly T[];
  tracker: BallVelocityTrackerState;
}): number {
  const { sim, bView, entries, tracker } = params;
  if (!sim || !bView) return -1;

  const impulseMag = computeGravityCompensatedBallImpulse(bView, tracker);
  let closestCarIdx = -1;
  let closestDist = Infinity;

  for (const entry of entries) {
    const cv = sim.getCarStateView?.(entry.carIndex);
    if (!cv || cv.isDemoed) continue;
    const dist = Math.hypot(cv.posX - bView.posX, cv.posY - bView.posY, cv.posZ - bView.posZ);
    if (dist < closestDist) {
      closestDist = dist;
      closestCarIdx = entry.carIndex;
    }
  }

  if (
    closestCarIdx >= 0 &&
    (closestDist <= TOUCH_DIRECT_DISTANCE_UU ||
      (closestDist <= TOUCH_IMPULSE_DISTANCE_UU && impulseMag > TOUCH_IMPULSE_MIN_DELTA_V_UU))
  ) {
    return closestCarIdx;
  }
  return -1;
}

export function stepPostGoalBallFreeze(params: {
  sim:
    | {
        getBallState?: () => Float32Array | ArrayLike<number>;
        setBallState?: (state: Float32Array) => void;
      }
    | null
    | undefined;
  goalResetTicks: number;
  currentTick: number;
  goalIncidentTick: number;
  frozenBallState: Float32Array | null;
  freezeDelayTicks?: number;
}): Float32Array | null {
  const {
    sim,
    goalResetTicks,
    currentTick,
    goalIncidentTick,
    frozenBallState,
    freezeDelayTicks = POST_GOAL_FREEZE_DELAY_TICKS,
  } = params;
  if (
    goalResetTicks <= 0 ||
    goalIncidentTick < 0 ||
    currentTick < goalIncidentTick + freezeDelayTicks
  ) {
    return frozenBallState;
  }
  let nextFrozen = frozenBallState;
  if (!nextFrozen && typeof sim?.getBallState === 'function') {
    const snapBall = new Float32Array(sim.getBallState());
    for (let i = 12; i < 18 && i < snapBall.length; i++) snapBall[i] = 0;
    nextFrozen = snapBall;
  }
  if (nextFrozen && typeof sim?.setBallState === 'function') sim.setBallState(nextFrozen);
  return nextFrozen;
}

export function hasKickoffBallMoved(bView: BallStateViewLike | null | undefined): boolean {
  if (!bView) return false;
  return (
    Math.abs(bView.posX) + Math.abs(bView.posY) > 2.0 || Math.hypot(bView.velX, bView.velY) > 5.0
  );
}

export function stepNetworkStreamedGoalReplayFrame(params: {
  runtime: GoalReplayRuntimePort | null | undefined;
  replayController: GoalReplayTimelineControllerPort;
  context?: GoalReplayFrameContextPort | null;
  source?: string;
  isUnlimitedBoost?: boolean;
  syncCarAudioControls?: boolean;
  syncBoostToHud?: boolean;
  getCameraMode: () => GoalReplayCameraMode;
  setCameraMode: (mode: GoalReplayCameraMode) => void;
  getScoringTeam: () => number;
  setScoringTeam?: (team: number) => void;
  getScorerCarIndex: () => number;
  setScorerCarIndex?: (carIndex: number) => void;
  getPovCarIndex?: () => number | null;
  setPovCarIndex?: (carIndex: number | null) => void;
}): void {
  const {
    runtime,
    replayController,
    context,
    source = 'freeplay-goal-replay',
    isUnlimitedBoost = false,
    syncCarAudioControls = true,
    syncBoostToHud = true,
    getCameraMode,
    setCameraMode,
    getScoringTeam,
    setScoringTeam,
    getScorerCarIndex,
    setScorerCarIndex,
    getPovCarIndex,
    setPovCarIndex,
  } = params;
  if (!replayController.sessionState?.isActive) {
    const scoringTeam = runtime?.match?.state?.scorer ?? 0;
    const scorerCarIndex = runtime?.match?.state?.scorerCarIndex ?? 0;
    const carEntries = captureRuntimeReplayCarEntries(
      runtime as unknown as ReplayCarEntryRuntimePort,
      { defaultTeam: scoringTeam }
    );
    const totalFrames = replayController.beginReplaySession({
      scoringTeam,
      scorerCarIndex,
      carEntries,
      isNetworkStreamed: Boolean(runtime?.networkReconciler ?? true),
    });
    setScoringTeam?.(scoringTeam);
    setScorerCarIndex?.(scorerCarIndex);
    setCameraMode('director');
    setPovCarIndex?.(null);
    if (runtime) runtime.replayPovCarIndex = null;
    beginGoalReplaySession(runtime, replayController, {
      cameraMode: 'director',
      source,
      syncHud: true,
      totalFrames,
      getCameraMode,
      setCameraMode,
      getScoringTeam,
      getScorerCarIndex,
      getPovCarIndex: () =>
        getPovCarIndex ? getPovCarIndex() : (runtime?.replayPovCarIndex ?? null),
      setPovCarIndex: (carIdx) => {
        setPovCarIndex?.(carIdx);
        if (runtime) runtime.replayPovCarIndex = carIdx;
      },
    });
  }
  if (typeof runtime?.replayPovCarIndex === 'number' && runtime.replayPovCarIndex >= 0) {
    setCameraMode('pov');
    setPovCarIndex?.(runtime.replayPovCarIndex);
  } else if (
    runtime?.isGoalReplayCameraOverrideActive?.() &&
    getCameraMode() === 'pov' &&
    runtime.replayPovCarIndex === null
  ) {
    setCameraMode('director');
    setPovCarIndex?.(null);
  }
  const cameraMode = getCameraMode() || 'director';
  const s = replayController.sessionState;
  const isCustomScrubbing = Boolean(
    s?.isScrubbing || s?.isPaused || Math.abs((s?.playbackSpeed ?? 1.0) - 1.0) > 0.01
  );
  const networkStreamSnapshot = !isCustomScrubbing
    ? (runtime?.networkReconciler?.lastParsedPacket?.stateSnapshot ?? null)
    : null;
  const embedded = networkStreamSnapshot
    ? decodeReplayDirectorTelemetryFromState(networkStreamSnapshot)
    : null;
  const scorerCarIdx = s?.scorerCarIndex ?? getScorerCarIndex();
  const resolvedPovCarIdx = getPovCarIndex
    ? getPovCarIndex()
    : typeof runtime?.replayPovCarIndex === 'number' && runtime.replayPovCarIndex >= 0
      ? runtime.replayPovCarIndex
      : scorerCarIdx;
  stepGoalReplaySessionFrame({
    runtime,
    replayController,
    context,
    dt: context?.dt ?? 1 / 120,
    source,
    cameraMode,
    scoringTeam: s?.scoringTeam ?? getScoringTeam(),
    scorerCarIndex: scorerCarIdx,
    povCarIndex: cameraMode === 'pov' ? resolvedPovCarIdx : null,
    applyToEngine: isCustomScrubbing,
    dispatchEvents: false,
    syncCarAudioControls,
    syncBoostToHud,
    emitWillEndSignal: false,
    syncHudProgress: true,
    isUnlimitedBoost,
    networkStreamSnapshot,
    overrideProgress: embedded && typeof embedded.progress === 'number' ? embedded.progress : null,
  });
}

export function restoreSingleCarAfterPreview(
  runtime:
    | {
        physics?: { numCars: number; removeCar?: (idx: number) => void } | null;
        arena?: { cars?: Array<{ visible?: boolean } | null | undefined> } | null;
      }
    | null
    | undefined,
  savedPrePreviewCar0: NormalizedReplayDirectorCarEntry | null
): void {
  if (savedPrePreviewCar0 && runtime) {
    applyReplayCarEntriesToRuntime(runtime as never, [savedPrePreviewCar0], 1);
    return;
  }
  if (runtime?.physics) {
    while (runtime.physics.numCars > 1 && typeof runtime.physics.removeCar === 'function') {
      runtime.physics.removeCar(runtime.physics.numCars - 1);
    }
  }
  if (runtime?.arena?.cars) {
    for (let i = 1; i < runtime.arena.cars.length; i++) {
      if (runtime.arena.cars[i]) runtime.arena.cars[i]!.visible = false;
    }
  }
}

export async function resolveImportedDiagnosticPatternInput(
  fileOrInput: unknown,
  fileName?: string
): Promise<ImportedDiagnosticPatternInput | null> {
  const candidate = fileOrInput as ImportedDiagnosticPatternInput | null;
  const parsed =
    candidate && typeof candidate === 'object' && Array.isArray(candidate.activeFrames)
      ? candidate
      : typeof fileOrInput === 'string'
        ? parseDirectorDiagnosticPatternText(fileOrInput, fileName)
        : await parseDirectorDiagnosticInput(
            fileOrInput as
              File | Blob | ArrayBuffer | Uint8Array | string | ImportedDiagnosticPatternInput,
            fileName
          );
  return parsed && Array.isArray(parsed.activeFrames) && parsed.activeFrames.length > 0
    ? parsed
    : null;
}

export function prepareFreeplayGoalReplaySessionData(params: {
  runtime: GoalReplayRuntimePort | null | undefined;
  ringBuffer: ReplayRingBuffer;
  playerTeam: number;
  isStandaloneReplayLoaded: boolean;
  explicitCarEntries?: unknown[] | null;
  incident: {
    goalIncidentTick: number;
    lastTouchTick: number;
    lastKickoffStartTick: number;
    scoringTeam?: number;
    scorerCarIndex: number;
    scorerName: string;
    ballSpeedKph: number | null;
    replayType?: 'goal' | 'expire';
  };
  currentTick: number;
  ballPosY?: number;
}): {
  scoringTeam: number;
  scorerCarIndex: number;
  scorerName: string;
  ballSpeedKph: number | null;
  extractedFrames: Array<ReplayRingBufferSlot | ReturnType<typeof extractGoalReplayFrames>[number]>;
  carEntries: NormalizedReplayDirectorCarEntry[];
} | null {
  const {
    runtime,
    ringBuffer,
    playerTeam,
    isStandaloneReplayLoaded,
    explicitCarEntries,
    incident,
    currentTick,
    ballPosY,
  } = params;
  const scoringTeam =
    incident.scoringTeam === 0 || incident.scoringTeam === 1
      ? incident.scoringTeam
      : typeof ballPosY === 'number' && Math.abs(ballPosY) > 100
        ? ballPosY >= 0
          ? 0
          : 1
        : playerTeam;
  const scorerCarIndex = incident.scorerCarIndex;
  const scorerName = incident.scorerName || 'Player';
  const goalTick = incident.goalIncidentTick > 0 ? incident.goalIncidentTick : currentTick;
  const extractedFrames =
    incident.replayType === 'expire'
      ? ringBuffer.getFramesInTickRange(
          Math.max(incident.lastKickoffStartTick, goalTick - EXPIRE_REPLAY_LOOKBACK_TICKS),
          currentTick
        )
      : extractGoalReplayFrames({
          ringBuffer,
          engine: null,
          goalIncidentTick: goalTick,
          scorerTouchTick: incident.lastTouchTick,
          lookbackSeconds: 10.0,
          touchLookbackSeconds: 7.0,
          postGoalTicks: Math.max(0, currentTick - goalTick),
          lastKickoffWillStartTick: incident.lastKickoffStartTick,
        });
  if (!Array.isArray(extractedFrames) || extractedFrames.length === 0) return null;

  const resolvedPlayerTeam: 0 | 1 = playerTeam === 1 ? 1 : 0;
  const fallbackCarName = incident.replayType === 'expire' ? 'Player' : scorerName;
  const capturedEntries = captureRuntimeReplayCarEntries(
    runtime as unknown as ReplayCarEntryRuntimePort,
    {
      frameBuffer: extractedFrames[0].snapshot,
      explicitEntries:
        (explicitCarEntries as NormalizedReplayDirectorCarEntry[] | undefined) ?? undefined,
      defaultTeam: resolvedPlayerTeam,
    }
  );
  const carEntries = capturedEntries.map((c) =>
    c.carIndex === scorerCarIndex
      ? {
          ...c,
          name: c.name || fallbackCarName,
          username: c.username || fallbackCarName,
          team: isStandaloneReplayLoaded ? c.team : resolvedPlayerTeam,
        }
      : c
  );
  return {
    scoringTeam,
    scorerCarIndex,
    scorerName,
    ballSpeedKph: incident.ballSpeedKph,
    extractedFrames,
    carEntries,
  };
}
