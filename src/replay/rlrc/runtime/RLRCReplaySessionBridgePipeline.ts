/**
 * RLRCReplaySessionBridgePipeline.ts
 * Pure telemetry formatting, binary pack download helper, and intervene environment port builder
 * for RLRCReplaySessionController.
 */

import * as THREE from 'three';
import { ExperimentalBotAgent } from '../../../ai/experimental/ExperimentalBotAgent.ts';
import type { BallPredictionEnginePort } from '../../../ai/experimental/botpack9700488ObsExtendedPipeline.ts';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import {
  setNameTagRuntimeState,
  useReplayToRcsImporterStore,
} from '../../../game/runtimeUiPort.ts';
import type { ReplayScoreboardModePort, ReplayScoreboardRuntimePort } from '../../ReplayScoreboardSynchronizer.ts';
import { STANDARD_BOOST_PADS_34 } from '../catalog/RLRCBoostPadSpatialCatalog.ts';
import {
  exportRLRCSessionToBinaryBytes,
  type RLRCConvertedReplaySession,
} from '../RLReplayToRLRCConverter.ts';
import type {
  RLRCInterpolationMethod,
  RLRCNonPovInterventionMode,
  RLRCPlayerSlotMeta,
  RLRCSessionPhase,
  RLRCSynthesizedCarControls,
} from '../RLRCReplayTypes.ts';
import {
  DEFAULT_NEUTRAL_CAR_CONTROLS,
  type RLRCGoalAndTouchTrackerPort,
  type RLRCPrerollRingBufferPort,
} from './RLRCInterveneFrameStateBuilder.ts';
import type {
  RLRCInterveneArenaPort,
  RLRCInterveneBotDecisionPort,
  RLRCInterveneEnvironmentPort,
  RLRCIntervenePhysicsPort,
} from './RLRCInterveneNonPovSyncPipeline.ts';

const _spinAxis = new THREE.Vector3();
const _spinQuat = new THREE.Quaternion();
const _botPadDescriptors = STANDARD_BOOST_PADS_34.map((p) => ({
  pos: [p.position.x, p.position.y, p.position.z],
  isBig: p.isBigPad,
}));

export function mapUiInterpolationMethod(raw: string): RLRCInterpolationMethod {
  return raw === 'linear' || raw === 'linear-slerp' ? 'linear' : 'hermite-clamped';
}

export function mapUiNonPovMode(raw: string): RLRCNonPovInterventionMode {
  if (raw === 'disappear') return 'disappear';
  if (raw === 'no-input') return 'no-input';
  if (raw === 'nexto' || raw === 'necto' || raw === 'bot-takeover') return 'bot-takeover';
  return 'follow-state';
}

export function syncRLRCNameTagRoster(
  roster: readonly RLRCPlayerSlotMeta[],
  activePovSlotIndex = 0
): void {
  setNameTagRuntimeState({
    isMultiplayerOrMultiCarMode: roster.length > 1,
    focusedCarIndex: activePovSlotIndex,
    carEntries: roster.map((r) => ({
      carIndex: r.slotIndex,
      name: r.userName,
      username: r.userName,
      team: r.team,
      isBot: false,
      isLocalPlayer: r.slotIndex === activePovSlotIndex,
    })),
  });
}

export function readLiveRuntimePlayerControls(
  runtime: ReplayScoreboardRuntimePort | null,
  _activePovSlotIndex: number
): RLRCSynthesizedCarControls {
  const rt = runtime as unknown as {
    playerControls?: Partial<RLRCSynthesizedCarControls> | null;
    gamepad?: { active?: () => boolean; read?: () => Partial<RLRCSynthesizedCarControls> };
    keyboard?: { read?: () => Partial<RLRCSynthesizedCarControls> };
  } | null;
  const raw =
    rt?.playerControls ||
    (rt?.gamepad?.active?.() ? rt.gamepad.read?.() : rt?.keyboard?.read?.());
  if (!raw) return DEFAULT_NEUTRAL_CAR_CONTROLS;
  return {
    throttle: Number(raw.throttle) || 0,
    steer: Number(raw.steer) || 0,
    pitch: Number(raw.pitch) || 0,
    yaw: Number(raw.yaw) || 0,
    roll: Number(raw.roll) || 0,
    jump: Boolean(raw.jump),
    boost: Boolean(raw.boost),
    handbrake: Boolean(raw.handbrake),
  };
}

export function publishConvertedSessionTelemetry(
  converted: RLRCConvertedReplaySession,
  fileName: string,
  clampedCursor: number,
  activePovSlotIndex: number
): void {
  const totalFrames = Math.max(0, converted.frames120Hz.length - 1);
  const incidentMarkers = converted.bookmarks
    .filter((b) => b.kind === 'goal' || b.kind === 'demolish')
    .map((b) => ({
      frameIndex: b.frameIndex120Hz,
      type: b.kind === 'goal' ? 0x0e : 0x03,
      carIndex: Math.max(0, b.slotIndex),
      team: (b.team === 1 ? 1 : 0) as 0 | 1,
      label: b.label,
    }));

  const signalMarkers = converted.bookmarks
    .filter((b) => b.kind === 'user-mark' || b.kind === 'kickoff' || b.kind === 'ue-keyframe')
    .map((b) => ({
      frameIndex: b.frameIndex120Hz,
      type: b.kind === 'user-mark' ? 0x91 : 0x87,
      param1: b.sourceFrame30Hz,
      param2: b.slotIndex,
      synthesized: false,
      label: b.label,
    }));

  useReplayToRcsImporterStore.getState().updateLiveTelemetry({
    viewerState: 'paused',
    loadedFileName: fileName,
    totalFrames,
    sourceFrameCount: converted.header.sourceFrameCount,
    sourceRecordFps: converted.header.recordFps,
    cursorFrame: clampedCursor,
    targetFrame: clampedCursor,
    stateTrackCount: converted.frames120Hz.length,
    incidentTrackCount: incidentMarkers.length,
    signalTrackCount: signalMarkers.length,
    recordedSignalCount: signalMarkers.length,
    synthesizedSignalCount: 0,
    incidentMarkers,
    signalMarkers,
    trackDeltaSummary: {
      part1CrcValid: converted.header.part1CrcValid,
      part2CrcValid: converted.header.part2CrcValid,
      replayId: converted.header.replayId,
      mapName: converted.header.mapName,
      date: converted.header.date,
      sourceFrameCount: converted.header.sourceFrameCount,
      upsampledFrameCount: converted.frames120Hz.length,
      mappedPropertyCount: converted.roster.length,
      trackDeltaOnlyPropertyCount: converted.bookmarks.length,
      unmappedPropertyNames: converted.roster.map(
        (r) => `[Slot ${r.slotIndex + 1}] ${r.userName} (${r.visualId} / ${r.hitboxId})`
      ),
    },
    activePovCarIndex: activePovSlotIndex,
    activePovSlotKey: activePovSlotIndex + 1,
    activePovTeam: converted.roster[activePovSlotIndex]?.team ?? 0,
    isLoadingReplay: false,
    errorMessage: null,
  });
}

export async function downloadRcsReplayPack(
  session: RLRCConvertedReplaySession,
  loadedFileName: string | null
): Promise<void> {
  const rawBytes = exportRLRCSessionToBinaryBytes(session);
  let payloadBytes: Uint8Array = rawBytes;
  let ext = '.rlrc';
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    const copy = new Uint8Array(rawBytes.byteLength);
    copy.set(rawBytes);
    await writer.write(copy);
    await writer.close();
    const compressedBuf = await new Response(cs.readable).arrayBuffer();
    payloadBytes = new Uint8Array(compressedBuf);
    ext = '.rcreplay.gz';
  }
  if (typeof document !== 'undefined') {
    const baseName = (loadedFileName || 'replay').replace(/\.replay$/i, '');
    const outCopy = new Uint8Array(payloadBytes.byteLength);
    outCopy.set(payloadBytes);
    const blob = new Blob([outCopy.buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

export function createRLRCInterveneEnvPort(host: {
  getSession: () => RLRCConvertedReplaySession | null;
  getRuntime: () => ReplayScoreboardRuntimePort | null;
  getMode: () => ReplayScoreboardModePort | null;
}): RLRCInterveneEnvironmentPort {
  const botAgents = new Map<number, ExperimentalBotAgent>();
  return {
    getFrames120Hz: () => host.getSession()?.frames120Hz ?? [],
    getRoster: () => host.getSession()?.roster ?? [],
    getBookmarks: () => host.getSession()?.bookmarks ?? [],
    getPhysics: (): RLRCIntervenePhysicsPort | null => {
      const sim = host.getRuntime()?.physics as unknown as RLRCIntervenePhysicsPort & {
        setControls?: (slot: number, ctrl: RLRCSynthesizedCarControls) => void;
      };
      if (!sim) return null;
      if (!sim.setCarControls && typeof sim.setControls === 'function') {
        sim.setCarControls = (slot, ctrl) => sim.setControls?.(slot, ctrl);
      }
      return sim;
    },
    getArena: (): RLRCInterveneArenaPort | null => {
      const runtime = host.getRuntime();
      const arena = runtime?.arena as Record<string, unknown> | undefined;
      if (!arena) return null;
      return {
        rebuildSlotVehicle: (slotIndex, team, hitboxId, visualId, colorHex) => {
          runtime?.physics?.setCarTeam?.(slotIndex, team);
          runtime?.physics?.setCarHitbox?.(slotIndex, hitboxId);
          (arena.ensureCar as ((s: number, t: number, v: string) => void) | undefined)?.(
            slotIndex,
            team,
            visualId
          );
          (arena.setCarTeam as ((s: number, t: number) => void) | undefined)?.(slotIndex, team);
          if (colorHex) {
            (arena.setCarColor as ((s: number, c: string) => void) | undefined)?.(slotIndex, colorHex);
          }
        },
        setSlotEntityVisible: (slotIndex, visible) => {
          const cars = arena.cars as Array<{ visible?: boolean } | null> | undefined;
          if (cars?.[slotIndex]) cars[slotIndex]!.visible = visible;
        },
        setBallVisible: (visible) => {
          const ball = arena.ball as { visible?: boolean } | undefined;
          const ring = arena.indicatorRing as { visible?: boolean } | undefined;
          if (ball) ball.visible = visible;
          if (ring) ring.visible = visible;
        },
        spinBallInPlace: (angVel, dt) => {
          const ball = arena.ball as { quaternion?: THREE.Quaternion } | undefined;
          if (!ball?.quaternion) return;
          const speed = Math.hypot(angVel.x, angVel.y, angVel.z);
          if (speed > 1e-4) {
            _spinAxis.set(angVel.x / speed, angVel.z / speed, angVel.y / speed);
            _spinQuat.setFromAxisAngle(_spinAxis, -speed * dt);
            ball.quaternion.premultiply(_spinQuat).normalize();
          }
        },
        syncInterpolatorToState: (state) => {
          if (runtime?.interpolator) {
            runtime.interpolator.prevState.set(state);
            runtime.interpolator.currState.set(state);
            runtime.interpolator.alpha = 0;
          }
        },
        advanceInterpolatorBeforeStep: () => {
          if (runtime?.interpolator) {
            runtime.interpolator.prevState.set(runtime.interpolator.currState);
          }
        },
        commitInterpolatorAfterStep: (state) => {
          if (runtime?.interpolator) {
            runtime.interpolator.currState.set(state);
          }
        },
        focusCameraOnSlot: (slotIndex) => {
          if (runtime) runtime.playerCarIndex = slotIndex;
          arena.playerCarIndex = slotIndex;
        },
      };
    },
    getRingBuffer: (): RLRCPrerollRingBufferPort | null =>
      (host.getMode() as unknown as { replayRingBuffer?: RLRCPrerollRingBufferPort })?.replayRingBuffer ?? null,
    getGoalAndTouch: (): RLRCGoalAndTouchTrackerPort | null =>
      (host.getMode() as unknown as { goalAndTouch?: RLRCGoalAndTouchTrackerPort })?.goalAndTouch ?? null,
    getBotPort: (): RLRCInterveneBotDecisionPort => ({
      resetAllBots: () => {
        for (const agent of botAgents.values()) agent.reset();
      },
      decideControlsForSlot: (slotIndex, team, state) => {
        const uiMode = useReplayToRcsImporterStore.getState().nonPovInterventionMode;
        const botType = uiMode === 'necto' ? 'necto' : 'nexto';
        let agent = botAgents.get(slotIndex);
        if (!agent) {
          agent = new ExperimentalBotAgent(botType, slotIndex, team);
          botAgents.set(slotIndex, agent);
        } else {
          agent.team = team;
          agent.setBotType(botType);
        }
        if (agent.tickSkipCounter > 0) {
          agent.tickSkipCounter--;
          return agent.action;
        }
        const sim = host.getRuntime()?.physics;
        const roster = host.getSession()?.roster ?? [];
        const activeCars = roster
          .filter((r) => (sim?.isCarSlotActive ? sim.isCarSlotActive(r.slotIndex) : true))
          .map((r) => ({ carIndex: r.slotIndex, team: r.team }));
        const action = agent.decideSync(
          state,
          _botPadDescriptors,
          activeCars,
          sim as unknown as BallPredictionEnginePort
        );
        agent.tickSkipCounter = Math.max(1, agent.tickSkip) - 1;
        return action;
      },
    }),
    playSound: (soundId, volume = 1.0) => {
      const audio = (host.getRuntime()?.options?.gameAudio || gameAudio) as {
        play?: (cue: string, vol?: number) => void;
        playSound?: (cue: string, vol?: number) => void;
      };
      if (typeof audio?.play === 'function') audio.play(soundId, volume);
      else audio?.playSound?.(soundId, volume);
    },
    onPhaseChanged: (phase: RLRCSessionPhase, countdownSec: number) => {
      const viewerState =
        phase === 'preroll-countdown'
          ? 'preroll-countdown'
          : phase === 'intervening'
            ? 'intervening'
            : 'paused';
      useReplayToRcsImporterStore.getState().updateLiveTelemetry({
        viewerState,
        prerollRemainingSec: countdownSec,
      });
    },
  };
}
