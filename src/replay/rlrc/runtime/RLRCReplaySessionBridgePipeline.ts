/**
 * RLRCReplaySessionBridgePipeline.ts
 * Pure telemetry formatting, background Worker .rcreplay.gz download helper,
 * and intervene environment port builder for RLRCReplaySessionController.
 */

import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import {
  setNameTagRuntimeState,
  useReplayToRcsImporterStore,
} from '../../../game/runtimeUiPort.ts';
import type {
  ReplayScoreboardModePort,
  ReplayScoreboardRuntimePort,
} from '../../ReplayScoreboardSynchronizer.ts';
import { packAndCompressRLRCContainer } from '../container/RLRCBinaryContainerCodec.ts';
import type { RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import type {
  RLRCInterpolationMethod,
  RLRCNonPovInterventionMode,
  RLRCPlayerSlotMeta,
  RLRCSessionPhase,
  RLRCSynthesizedCarControls,
} from '../RLRCReplayTypes.ts';
import {
  createRLRCInterveneBotDecisionPort,
  isNonNeutralControls,
  normalizeSynthesizedControls,
  type RLRCBridgeRuntimePort,
} from './RLRCInterveneBotPolicyPipeline.ts';
import { DEFAULT_NEUTRAL_CAR_CONTROLS } from './RLRCInterveneFrameStateBuilder.ts';
import type {
  RLRCGoalAndTouchTrackerPort,
  RLRCPrerollRingBufferPort,
} from './RLRCIntervenePrerollInjector.ts';
import type {
  RLRCInterveneArenaPort,
  RLRCInterveneBotDecisionPort,
  RLRCInterveneEnvironmentPort,
  RLRCIntervenePhysicsPort,
} from './RLRCInterveneTargetFrameApplier.ts';

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
      isBot: false,
      isLocalPlayer: r.slotIndex === activePovSlotIndex,
    })),
  });
}

export function readLiveRuntimePlayerControls(
  simPort: ReplayScoreboardRuntimePort | null,
  activePovSlotIndex: number
): RLRCSynthesizedCarControls {
  if (!simPort) return DEFAULT_NEUTRAL_CAR_CONTROLS;
  const bridgePort = simPort as unknown as RLRCBridgeRuntimePort;
  const livePlayerControls = bridgePort.playerControls;
  if (isNonNeutralControls(livePlayerControls)) {
    return normalizeSynthesizedControls(livePlayerControls);
  }

  const pad = bridgePort.gamepad;
  const padCandidate =
    pad?.getControls?.(activePovSlotIndex) ??
    (pad?.active?.() ? (pad.controls ?? pad.read?.()) : undefined);
  if (isNonNeutralControls(padCandidate)) {
    return normalizeSynthesizedControls(padCandidate);
  }

  const kb = bridgePort.keyboard;
  const kbCandidate = kb?.getControls?.(activePovSlotIndex) ?? kb?.read?.() ?? kb?.controls;
  if (isNonNeutralControls(kbCandidate)) {
    return normalizeSynthesizedControls(kbCandidate);
  }

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
  const sourcePacket =
    session.containerPacket.stateInputTrackBytes.byteLength > 0
      ? session.containerPacket
      : {
          header: session.header,
          roster: session.roster,
          bookmarks: session.bookmarks,
          frames120Hz: session.frames120Hz,
          stateInputTrackBytes: session.containerPacket.stateInputTrackBytes,
        };
  const packedResult = await packAndCompressRLRCContainer(sourcePacket);
  if (typeof document !== 'undefined') {
    const baseName = (loadedFileName || 'replay').replace(
      /\.(replay|rcreplay\.gz|rcreplay|rlrc)$/i,
      ''
    );
    const isGzip = Boolean(packedResult.compressed);
    const ext = isGzip ? '.rcreplay.gz' : '.rcreplay';
    const mimeType = isGzip ? 'application/gzip' : 'application/octet-stream';
    const blob = new Blob([packedResult.buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${baseName}${ext}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export function createRLRCInterveneEnvPort(sessionCtx: {
  getSession: () => RLRCConvertedReplaySession | null;
  getSimPort: () => ReplayScoreboardRuntimePort | null;
  getModePort: () => ReplayScoreboardModePort | null;
}): RLRCInterveneEnvironmentPort {
  const botDecisionPort = createRLRCInterveneBotDecisionPort(sessionCtx);

  return {
    getFrames120Hz: () => sessionCtx.getSession()?.frames120Hz ?? [],
    getRoster: () => sessionCtx.getSession()?.roster ?? [],
    getBookmarks: () => sessionCtx.getSession()?.bookmarks ?? [],
    getPhysics: (): RLRCIntervenePhysicsPort | null => {
      const sim = sessionCtx.getSimPort()?.physics as unknown as RLRCIntervenePhysicsPort & {
        setControls?: (slot: number, carControls: RLRCSynthesizedCarControls) => void;
      };
      if (!sim) return null;
      if (!sim.setCarControls && typeof sim.setControls === 'function') {
        sim.setCarControls = (slot, carControls) => sim.setControls?.(slot, carControls);
      }
      return sim;
    },
    getArena: (): RLRCInterveneArenaPort | null => {
      const simPort = sessionCtx.getSimPort();
      const arena = simPort?.arena as Record<string, unknown> | undefined;
      if (!arena) return null;
      return {
        rebuildSlotVehicle: (slotIndex, team, hitboxId, visualId, colorHex) => {
          simPort?.physics?.setCarTeam?.(slotIndex, team);
          simPort?.physics?.setCarHitbox?.(slotIndex, hitboxId);
          (arena.ensureCar as ((s: number, t: number, v: string) => void) | undefined)?.(
            slotIndex,
            team,
            visualId
          );
          (arena.setCarTeam as ((s: number, t: number) => void) | undefined)?.(slotIndex, team);
          if (colorHex) {
            (arena.setCarColor as ((s: number, c: string) => void) | undefined)?.(
              slotIndex,
              colorHex
            );
          }
        },
        setSlotEntityVisible: (slotIndex, visible) => {
          const cars = arena.cars as Array<{ visible?: boolean } | null> | undefined;
          if (cars?.[slotIndex]) cars[slotIndex]!.visible = visible;
        },
        setBallVisible: (visible) => {
          const ball = arena.ball as
            { visible?: boolean; group?: { visible?: boolean } } | undefined;
          if (ball) {
            ball.visible = visible;
            if (ball.group) ball.group.visible = visible;
          }
        },
        syncInterpolatorToState: (state) => {
          if (simPort?.interpolator) {
            simPort.interpolator.prevState.set(state);
            simPort.interpolator.currState.set(state);
            simPort.interpolator.alpha = 0;
          }
        },
        focusCameraOnSlot: (slotIndex) => {
          if (simPort) simPort.playerCarIndex = slotIndex;
          arena.playerCarIndex = slotIndex;
          const currentRoster = sessionCtx.getSession()?.roster;
          if (currentRoster && currentRoster.length > 0) {
            syncRLRCNameTagRoster(currentRoster, slotIndex);
          }
        },
      };
    },
    getRingBuffer: (): RLRCPrerollRingBufferPort | null =>
      (sessionCtx.getModePort() as unknown as { replayRingBuffer?: RLRCPrerollRingBufferPort })
        ?.replayRingBuffer ?? null,
    getGoalAndTouch: (): RLRCGoalAndTouchTrackerPort | null =>
      (sessionCtx.getModePort() as unknown as { goalAndTouch?: RLRCGoalAndTouchTrackerPort })
        ?.goalAndTouch ?? null,
    getBotPort: (): RLRCInterveneBotDecisionPort | null => botDecisionPort,
    playSound: (soundId, volume = 1.0) => {
      const audio = (sessionCtx.getSimPort()?.options?.gameAudio || gameAudio) as {
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
