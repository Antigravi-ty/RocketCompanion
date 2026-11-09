/**
 * RLRCInterveneEnvPortBuilder.ts
 * Builds the RLRCInterveneEnvironmentPort and ExperimentalBotAgent (Nexto/Necto)
 * non-POV decision adapter for RLRCReplaySessionController.
 */

import {
  ExperimentalBotAgent,
  ensureExperimentalEngine,
} from '../../../ai/experimental/ExperimentalBotAgent.ts';
import type { BallPredictionEnginePort } from '../../../ai/experimental/botpack9700488ObsExtendedPipeline.ts';
import type { BoostPadDescriptor } from '../../../ai/experimental/experimentalMultiCarObsPipeline.ts';
import { gameAudio } from '../../../audio/GameAudioEngineFacade.ts';
import { useReplayToRcsImporterStore } from '../../../game/runtimeUiPort.ts';
import type {
  ReplayScoreboardModePort,
  ReplayScoreboardRuntimePort,
} from '../../ReplayScoreboardSynchronizer.ts';
import { STANDARD_BOOST_PADS_34 } from '../catalog/RLRCBoostPadLocationsTable.ts';
import type { RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import {
  RLRC_MAX_PLAYER_SLOTS,
  type RLRCSessionPhase,
  type RLRCSynthesizedCarControls,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
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
import {
  normalizeSynthesizedControls,
  syncRLRCNameTagRoster,
  type RLRCBridgeBotCoordinatorPort,
  type RLRCBridgeRuntimePort,
} from './RLRCReplaySessionBridgePipeline.ts';

const _botPadDescriptors: ReadonlyArray<BoostPadDescriptor> = STANDARD_BOOST_PADS_34.map((p) => ({
  pos: [p.position.x, p.position.y, p.position.z],
  isBig: p.isBigPad,
}));

function resolveSelectedBotPolicyId(
  botCoordinator: RLRCBridgeBotCoordinatorPort | null | undefined
): 'nexto' | 'necto' {
  const uiMode = useReplayToRcsImporterStore.getState().nonPovInterventionMode;
  if (uiMode === 'necto' || uiMode === 'nexto') return uiMode;
  return botCoordinator?.runtime?.bot?.id === 'necto' ? 'necto' : 'nexto';
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
    decideControlsForSlot: (slotIndex, team: RLRCTeamIndex, state, dt) => {
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
            (typeof sim?.isCarSlotActive === 'function'
              ? sim.isCarSlotActive(c)
              : roster.some((r) => r.slotIndex === c));
          if (!isActive) continue;
          const slotMeta = roster.find((r) => r.slotIndex === c);
          activeCars.push({
            carIndex: c,
            team: c === slotIndex ? team : (slotMeta?.team ?? (c < 3 ? 0 : 1)),
          });
        }
        const pads = sim?.getPads?.() ?? _botPadDescriptors;
        const decided = agent.decideSync(
          state,
          pads,
          activeCars,
          sim as unknown as BallPredictionEnginePort
        );
        agent.tickSkipCounter = agent._staggered
          ? agent.tickSkip - 1
          : (slotIndex % agent.tickSkip) + 1;
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
            | { visible?: boolean; group?: { visible?: boolean } }
            | undefined;
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
