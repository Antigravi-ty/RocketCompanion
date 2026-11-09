import {
  INCIDENT_EVENT_TYPES,
  MATCH_SIGNALS,
  MAX_CARS,
} from '../../../physics/RocketSimConstants.ts';
import type { ReplayRingBuffer } from '../../../replay/ReplayRingBuffer.ts';
import { getNameTagRuntimeState } from '../../runtimeUiPort.ts';
import type { MatchStateData } from '../../runtime/RuntimeMatchState.ts';
import type { HotkeyRuntimeOverlayPort } from '../../../input/hotkeyInputGuard.ts';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import {
  UU_TO_KPH,
  evaluateGoalScoredFromBallView,
  type BallStateViewLike,
  type CarStateViewLike,
} from '../shared/goalAndBallTouchPipeline.ts';
import { syncLocalMatchStateToRuntimeAndHud } from '../shared/matchClockAndPhasePipeline.ts';

export interface FreeplayGoalMetadataTargetPort {
  goalScoringTeam: number;
  goalScorerCarIndex: number;
  goalScorerName: string;
  goalBallSpeedKph: number | null;
  previewSpawnedExtraCars: boolean;
  resetGoalMetadata(scoringTeam?: number): void;
  setGoalMetadata(meta: {
    scoringTeam: number;
    scorerCarIndex: number;
    scorerName: string;
    ballSpeedKph: number | null;
  }): void;
  exitPatternPreview(): boolean;
}

export interface FreeplayBallStateViewCandidate {
  posX: number;
  posY: number;
  posZ: number;
  velX?: number;
  velY?: number;
  velZ?: number;
}

export interface FreeplayPhysicsEnginePort {
  state?: Float32Array | null;
  numCars?: number;
  controlsView?: ArrayLike<number> | null;
  isUnlimitedBoost?: boolean;
  getHeaderView?: () => { tickCount: number } | null;
  getBallStateView?: () => FreeplayBallStateViewCandidate | null;
  getCarStateView?: (carIndex: number) => unknown;
  getBallState?: () => Float32Array | ArrayLike<number>;
  setBallState?: (state: Float32Array) => void;
  isBallScored?: (bView: BallStateViewLike) => boolean;
  pollGoal?: () => void;
  resetGoalLatch?: () => void;
  removeCar?: (carIndex: number) => void;
  saveCompactState?: () => Float32Array;
}

export interface FreeplayAudioPort {
  play?: (cueName: string, volume?: number, cooldownMs?: number) => void;
}

export interface FreeplayGoalAndTouchRuntimePort extends HotkeyRuntimeOverlayPort {
  isPaused?: boolean;
  playerCarIndex?: number;
  playerControls?: Record<string, unknown> | null;
  neutralControls?: Record<string, unknown> | null;
  trainingOptions?: {
    disableGoalReset?: boolean;
  } | null;
  physics?: FreeplayPhysicsEnginePort | null;
  arena?: {
    isLobbyMode?: boolean;
    ball?: unknown;
    cars?: Array<{ visible?: boolean } | null | undefined>;
    setCarTeam?: (carIndex: number, team: number) => void;
    resetCarBoosts?: (carIndex: number) => void;
    carDemolitions?: Array<{ stop?: () => void } | null | undefined>;
    supersonicWheelTrailSystem?: { resetCar?: (carIndex: number) => void } | null;
    lighting?: { updateSunIntensities?: (scale: number) => void } | null;
  } | null;
  match?: {
    state?: { mode?: string; phase?: string; [key: string]: unknown } | null;
  } | null;
  options?: {
    gameAudio?: FreeplayAudioPort | null;
  } | null;
  audioSubsystem?: {
    audio?: FreeplayAudioPort | null;
    resetAudio?: () => void;
  } | null;
  audio?: FreeplayAudioPort | null;
  authoritativeServer?: {
    fallbackManager?: { domain?: { goalBufferTicks?: number } | null } | null;
    startTrainingMode?: (opts: Record<string, unknown>) => void;
    sim?: { restoreState?: (state: Float32Array) => Promise<void> | void } | null;
    clientInputBuffer?: { clear?: () => void } | null;
    lastReceivedControls?: { clear?: () => void } | null;
  } | null;
  networkReconciler?: {
    lobbyDualWorldMode?: boolean;
    syncTimeline?: (state: Float32Array, tick: number) => void;
  } | null;
}

export function normalizeFreeplayBallStateView(
  raw: FreeplayBallStateViewCandidate | null | undefined
): BallStateViewLike | null {
  if (!raw) return null;
  return {
    posX: raw.posX,
    posY: raw.posY,
    posZ: raw.posZ,
    velX: raw.velX ?? 0,
    velY: raw.velY ?? 0,
    velZ: raw.velZ ?? 0,
  };
}

export function canTriggerFreeplayManualBallExpire(
  scenePort: FreeplayGoalAndTouchRuntimePort | null | undefined,
  isBlockedBySubsystems: boolean,
  goalResetTicks: number
): scenePort is FreeplayGoalAndTouchRuntimePort & { physics: FreeplayPhysicsEnginePort } {
  if (!scenePort || !scenePort.physics || scenePort.isPaused) return false;
  if (scenePort.match?.state?.mode && scenePort.match.state.mode !== 'freeplay') return false;
  if (
    scenePort.arena?.isLobbyMode ||
    scenePort.match?.state?.phase === 'lobby' ||
    scenePort.networkReconciler?.lobbyDualWorldMode
  ) {
    return false;
  }
  return !isBlockedBySubsystems && goalResetTicks <= 0;
}

export function computeManualBallExpireMetadata(
  bView: BallStateViewLike | null | undefined,
  playerTeam: 0 | 1,
  playerCarIndex: number
): {
  scoringTeam: 0 | 1;
  scorerCarIndex: number;
  scorerName: string;
  ballSpeedKph: number;
} {
  const scoringTeam: 0 | 1 = bView ? (bView.posY >= 0 ? 0 : 1) : playerTeam;
  const ballSpeedKph = Math.round(
    (bView ? Math.hypot(bView.velX, bView.velY, bView.velZ) : 0) * UU_TO_KPH
  );
  return {
    scoringTeam,
    scorerCarIndex: playerCarIndex,
    scorerName: 'SHOT EXPIRED',
    ballSpeedKph,
  };
}

export function extractFreeplayAcknowledgedCarControls(
  sim: { numCars?: number; controlsView?: ArrayLike<number> | null },
  playerCarIndex: number,
  playerControls: Record<string, unknown>
): Array<{ carIndex: number; controls: Record<string, unknown> }> {
  const numActiveCars = Math.min(MAX_CARS, Math.max(1, sim.numCars || 1));
  const acknowledgedControls: Array<{ carIndex: number; controls: Record<string, unknown> }> = [];
  if (numActiveCars > 1 && sim.controlsView) {
    const view = sim.controlsView;
    for (let c = 0; c < numActiveCars; c++) {
      if (c === playerCarIndex) {
        acknowledgedControls.push({
          carIndex: c,
          controls: { ...playerControls },
        });
      } else {
        const base = c * 8;
        acknowledgedControls.push({
          carIndex: c,
          controls: {
            throttle: view[base + 0] || 0,
            steer: view[base + 1] || 0,
            pitch: view[base + 2] || 0,
            yaw: view[base + 3] || 0,
            roll: view[base + 4] || 0,
            jump: view[base + 5] >= 0.5,
            boost: view[base + 6] >= 0.5,
            handbrake: view[base + 7] >= 0.5,
          },
        });
      }
    }
  } else {
    acknowledgedControls.push({
      carIndex: playerCarIndex,
      controls: { ...playerControls },
    });
  }
  return acknowledgedControls;
}

export function resolveFreeplayScorerName(scorerCarIndex: number): string {
  const ntEntries = getNameTagRuntimeState()?.carEntries;
  const scorerEntry = Array.isArray(ntEntries)
    ? ntEntries.find((entry) => entry.carIndex === scorerCarIndex)
    : null;
  return scorerEntry?.name || scorerEntry?.username || 'Player';
}

export function handleDisabledOrLobbyGoalLatch(
  scenePort: FreeplayGoalAndTouchRuntimePort,
  sim: FreeplayPhysicsEnginePort,
  bView: BallStateViewLike | null
): boolean {
  const isOnlineLobby = Boolean(
    scenePort.arena?.isLobbyMode || scenePort.networkReconciler?.lobbyDualWorldMode
  );
  if (!scenePort.trainingOptions?.disableGoalReset && !isOnlineLobby) {
    return false;
  }
  if (
    isOnlineLobby &&
    !scenePort.authoritativeServer &&
    scenePort.networkReconciler?.lobbyDualWorldMode &&
    evaluateGoalScoredFromBallView(sim, bView).scored
  ) {
    if (sim.resetGoalLatch) sim.resetGoalLatch();
    if (sim.setBallState) {
      sim.setBallState(
        new Float32Array([0, 0, 93, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
      );
    }
  } else if (sim.resetGoalLatch) {
    sim.resetGoalLatch();
  }
  return true;
}

export function recordManualExpireAndSyncHud(params: {
  scenePort: FreeplayGoalAndTouchRuntimePort;
  ringBuffer: ReplayRingBuffer;
  currentTick: number;
  playerTeam: 0 | 1;
  scoringTeam: 0 | 1;
  ballSpeedKph: number;
}): void {
  const { scenePort, ringBuffer, currentTick, playerTeam, scoringTeam, ballSpeedKph } = params;
  ringBuffer.appendAudioEvent(currentTick, {
    cueId: 'training_ball_expire',
    cueName: 'training_ball_expire',
    volume: 1.0,
  });
  const audio =
    scenePort.options?.gameAudio ||
    scenePort.audioSubsystem?.audio ||
    scenePort.audio ||
    gameAudio;
  if (audio?.play) {
    audio.play('training_ball_expire', 1.0, 250);
  }
  syncLocalMatchStateToRuntimeAndHud(scenePort.match?.state as MatchStateData | null | undefined, {
    matchPhase: 'goal',
    localTeam: playerTeam,
    replayScorerName: 'SHOT EXPIRED',
    replayScorerTeam: scoringTeam,
    replayScorerAnthemId: null,
    replayBallSpeedKph: ballSpeedKph,
    replayAssistName: null,
  });
}

export function recordGoalScoredAndSyncHud(params: {
  scenePort: FreeplayGoalAndTouchRuntimePort;
  ringBuffer: ReplayRingBuffer;
  currentTick: number;
  bView: BallStateViewLike;
  playerTeam: 0 | 1;
  scoringTeam: 0 | 1;
  scorerCarIndex: number;
  scorerName: string;
  ballSpeedUu: number;
  ballSpeedKph: number;
}): void {
  const {
    scenePort,
    ringBuffer,
    currentTick,
    bView,
    playerTeam,
    scoringTeam,
    scorerCarIndex,
    scorerName,
    ballSpeedUu,
    ballSpeedKph,
  } = params;
  ringBuffer.appendIncident(currentTick, {
    type: INCIDENT_EVENT_TYPES.GOAL_SCORED,
    tick: currentTick,
    carIndex: scorerCarIndex,
    team: scoringTeam,
    posX: bView.posX,
    posY: bView.posY,
    posZ: bView.posZ,
    intensity: ballSpeedUu,
  });
  ringBuffer.appendSignal(currentTick, {
    signalType: MATCH_SIGNALS.SCORE_UPDATED,
    frameId: currentTick,
    param1: scoringTeam === 0 ? 1 : 0,
    param2: scoringTeam === 1 ? 1 : 0,
  });
  ringBuffer.appendAudioEvent(currentTick, {
    cueName: 'sfx_goal_poof',
    volume: 1.0,
  });
  const audio = scenePort.audioSubsystem?.audio || scenePort.audio;
  if (audio?.play) {
    audio.play('sfx_goal_poof', 1.0);
  }
  syncLocalMatchStateToRuntimeAndHud(scenePort.match?.state as MatchStateData | null | undefined, {
    matchPhase: 'goal',
    localTeam: playerTeam,
    replayScorerName: scorerName,
    replayScorerTeam: scoringTeam,
    replayScorerAnthemId: null,
    replayBallSpeedKph: ballSpeedKph,
    replayAssistName: null,
  });
}
