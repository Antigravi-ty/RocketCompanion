/**
 * RLRCReplaySessionBridgePipeline.ts
 * Pure telemetry formatting, binary pack download helper, and intervene environment port builder
 * for RLRCReplaySessionController.
 */

import {
  ExperimentalBotAgent,
  ensureExperimentalEngine,
} from '../../../ai/experimental/ExperimentalBotAgent.ts';
import type { BoostPadDescriptor } from '../../../ai/experimental/experimentalMultiCarObsPipeline.ts';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import {
  setNameTagRuntimeState,
  useReplayToRcsImporterStore,
} from '../../../game/runtimeUiPort.ts';
import type { ReplayScoreboardModePort, ReplayScoreboardRuntimePort } from '../../ReplayScoreboardSynchronizer.ts';
import {
  exportRLRCSessionToBinaryBytes,
  type RLRCConvertedReplaySession,
} from '../RLReplayToRLRCConverter.ts';
import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCInterpolationMethod,
  type RLRCNonPovInterventionMode,
  type RLRCPlayerSlotMeta,
  type RLRCSessionPhase,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
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

interface RLRCBridgeInputDevicePort {
  readonly controls?: Partial<RLRCSynthesizedCarControls>;
  readonly active?: () => boolean;
  readonly read?: () => Partial<RLRCSynthesizedCarControls> | null | undefined;
  readonly getControls?: (carIdx?: number) => Partial<RLRCSynthesizedCarControls> | null | undefined;
}

interface RLRCBridgeBotCoordinatorPort {
  readonly runtime?: { readonly bot?: { readonly id?: string } | null } | null;
  readonly resetBotState?: () => void;
  readonly resetAllBots?: () => void;
  readonly decideControlsForSlot?: (
    slotIndex: number, team: RLRCTeamIndex, state: Float32Array, dt: number
  ) => Partial<RLRCSynthesizedCarControls> | null | undefined;
}

interface RLRCBridgeRuntimePort {
  readonly playerControls?: Partial<RLRCSynthesizedCarControls> | null;
  readonly keyboard?: RLRCBridgeInputDevicePort | null;
  readonly gamepad?: RLRCBridgeInputDevicePort | null;
  readonly botCoordinator?: RLRCBridgeBotCoordinatorPort | null;
  readonly physics?: {
    readonly isCarSlotActive?: (slotIndex: number) => boolean;
    readonly getPads?: () => ReadonlyArray<BoostPadDescriptor>;
  } | null;
}

function normalizeSynthesizedControls(
  raw: Partial<RLRCSynthesizedCarControls> | null | undefined
): RLRCSynthesizedCarControls {
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

function isNonNeutralControls(raw: Partial<RLRCSynthesizedCarControls> | null | undefined): boolean {
  return Boolean(
    raw && (
      Number(raw.throttle) || Number(raw.steer) || Number(raw.pitch) ||
      Number(raw.yaw) || Number(raw.roll) || raw.jump || raw.boost || raw.handbrake
    )
  );
}

function resolveSelectedBotPolicyId(
  botCoordinator: RLRCBridgeBotCoordinatorPort | null | undefined
): 'nexto' | 'necto' {
  const uiMode = useReplayToRcsImporterStore.getState().nonPovInterventionMode;
  if (uiMode === 'necto' || uiMode === 'nexto') return uiMode;
  return botCoordinator?.runtime?.bot?.id === 'necto' ? 'necto' : 'nexto';
}

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
  activePovSlotIndex: number = roster[0]?.slotIndex ?? 0
): void {
  setNameTagRuntimeState({
    isMultiplayerOrMultiCarMode: roster.length > 1,
    focusedCarIndex: activePovSlotIndex,
    carEntries: roster.map((r) => ({
      carIndex: r.slotIndex,
      name: r.userName,
      username: r.userName,
      team: r.team,
      isBot: r.slotIndex !== activePovSlotIndex,
      isLocalPlayer: r.slotIndex === activePovSlotIndex,
    })),
  });
}

export function readLiveRuntimePlayerControls(
  runtime: ReplayScoreboardRuntimePort | null,
  activePovSlotIndex: number
): RLRCSynthesizedCarControls {
  if (!runtime) return DEFAULT_NEUTRAL_CAR_CONTROLS;
  const bridgeRuntime = runtime as unknown as RLRCBridgeRuntimePort;
  const livePlayerControls = bridgeRuntime.playerControls;
  if (isNonNeutralControls(livePlayerControls)) return normalizeSynthesizedControls(livePlayerControls);

  const pad = bridgeRuntime.gamepad;
  const padCandidate =
    pad?.getControls?.(activePovSlotIndex) ?? (pad?.active?.() ? (pad.controls ?? pad.read?.()) : undefined);
  if (isNonNeutralControls(padCandidate)) return normalizeSynthesizedControls(padCandidate);

  const kb = bridgeRuntime.keyboard;
  const kbCandidate = kb?.getControls?.(activePovSlotIndex) ?? kb?.read?.() ?? kb?.controls;
  if (isNonNeutralControls(kbCandidate)) return normalizeSynthesizedControls(kbCandidate);

  return normalizeSynthesizedControls(livePlayerControls);
}

export function publishConvertedSessionTelemetry(
  converted: RLRCConvertedReplaySession,
  fileName: string,
  clampedCursor: number,
  activePovSlotIndex: number
): void {
  syncRLRCNameTagRoster(converted.roster, activePovSlotIndex);
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
  const slotBotAgents = new Map<number, ExperimentalBotAgent>();

  const botDecisionPort: RLRCInterveneBotDecisionPort = {
    resetAllBots: () => {
      const bridgeRuntime = host.getRuntime() as unknown as RLRCBridgeRuntimePort | null;
      const botCoord = bridgeRuntime?.botCoordinator;
      const policyId = resolveSelectedBotPolicyId(botCoord);
      void ensureExperimentalEngine(policyId);
      botCoord?.resetAllBots?.();
      botCoord?.resetBotState?.();
      for (const agent of slotBotAgents.values()) {
        agent.setBotType(policyId);
        agent.reset();
      }
    },
    decideControlsForSlot: (slotIndex, team, state, dt) => {
      const bridgeRuntime = host.getRuntime() as unknown as RLRCBridgeRuntimePort | null;
      const botCoord = bridgeRuntime?.botCoordinator;
      const customDecision = botCoord?.decideControlsForSlot?.(slotIndex, team, state, dt);
      if (customDecision) return normalizeSynthesizedControls(customDecision);

      const policyId = resolveSelectedBotPolicyId(botCoord);
      let agent = slotBotAgents.get(slotIndex);
      if (!agent || agent.team !== team) {
        agent = new ExperimentalBotAgent(policyId, slotIndex, team);
        slotBotAgents.set(slotIndex, agent);
      } else if (agent.botType !== policyId) {
        agent.setBotType(policyId);
      }

      if (agent.tickSkipCounter <= 0) {
        const roster = host.getSession()?.roster ?? [];
        const sim = bridgeRuntime?.physics;
        const activeCars: Array<{ carIndex: number; team: number }> = [];
        for (let c = 0; c < RLRC_MAX_PLAYER_SLOTS; c++) {
          const isActive =
            c === slotIndex ||
            (typeof sim?.isCarSlotActive === 'function' ? sim.isCarSlotActive(c) : roster.some((r) => r.slotIndex === c));
          if (!isActive) continue;
          const slotMeta = roster.find((r) => r.slotIndex === c);
          activeCars.push({ carIndex: c, team: c === slotIndex ? team : (slotMeta?.team ?? (c < 3 ? 0 : 1)) });
        }
        const decided = agent.decideSync(state, sim?.getPads?.() ?? [], activeCars);
        agent.tickSkipCounter = agent._staggered ? agent.tickSkip - 1 : (slotIndex % agent.tickSkip) + 1;
        agent._staggered = true;
        return normalizeSynthesizedControls(decided);
      }

      agent.tickSkipCounter--;
      return normalizeSynthesizedControls(agent.action);
    },
  };

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
        syncInterpolatorToState: (state) => {
          if (runtime?.interpolator) {
            runtime.interpolator.prevState.set(state);
            runtime.interpolator.currState.set(state);
            runtime.interpolator.alpha = 0;
          }
        },
        focusCameraOnSlot: (slotIndex) => {
          if (runtime) runtime.playerCarIndex = slotIndex;
          arena.playerCarIndex = slotIndex;
          const currentRoster = host.getSession()?.roster;
          if (currentRoster && currentRoster.length > 0) {
            syncRLRCNameTagRoster(currentRoster, slotIndex);
          }
        },
      };
    },
    getRingBuffer: (): RLRCPrerollRingBufferPort | null =>
      (host.getMode() as unknown as { replayRingBuffer?: RLRCPrerollRingBufferPort })?.replayRingBuffer ?? null,
    getGoalAndTouch: (): RLRCGoalAndTouchTrackerPort | null =>
      (host.getMode() as unknown as { goalAndTouch?: RLRCGoalAndTouchTrackerPort })?.goalAndTouch ?? null,
    getBotPort: (): RLRCInterveneBotDecisionPort | null => botDecisionPort,
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
