/**
 * RLRCInterveneEnvPortBuilder.ts
 * Builds the RLRCInterveneEnvironmentPort and delegates ExperimentalBotAgent (Nexto/Necto)
 * non-POV decision policy to RLRCInterveneBotPolicyPipeline for RLRCReplaySessionController.
 */

import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import { useReplayToRcsImporterStore } from '../../../game/runtimeUiPort.ts';
import type {
  ReplayScoreboardModePort,
  ReplayScoreboardRuntimePort,
} from '../../ReplayScoreboardSynchronizer.ts';
import type { RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import type { RLRCSessionPhase, RLRCSynthesizedCarControls } from '../RLRCReplayTypes.ts';
import { createRLRCInterveneBotDecisionPort } from './RLRCInterveneBotPolicyPipeline.ts';
import type {
  RLRCGoalAndTouchTrackerPort,
  RLRCPrerollRingBufferPort,
} from './RLRCInterveneFrameStateBuilder.ts';
import type {
  RLRCInterveneArenaPort,
  RLRCInterveneBotDecisionPort,
  RLRCInterveneEnvironmentPort,
  RLRCIntervenePhysicsPort,
} from './RLRCInterveneNonPovSyncPipeline.ts';
import { syncRLRCNameTagRoster } from './RLRCReplaySessionBridgePipeline.ts';

export function createRLRCInterveneEnvPort(host: {
  getSession: () => RLRCConvertedReplaySession | null;
  getRuntime: () => ReplayScoreboardRuntimePort | null;
  getMode: () => ReplayScoreboardModePort | null;
}): RLRCInterveneEnvironmentPort {
  const botDecisionPort = createRLRCInterveneBotDecisionPort(host);

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
      (host.getMode() as unknown as { replayRingBuffer?: RLRCPrerollRingBufferPort })
        ?.replayRingBuffer ?? null,
    getGoalAndTouch: (): RLRCGoalAndTouchTrackerPort | null =>
      (host.getMode() as unknown as { goalAndTouch?: RLRCGoalAndTouchTrackerPort })?.goalAndTouch ??
      null,
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
