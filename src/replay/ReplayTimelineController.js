/**
 * ReplayTimelineController.js
 * Unified 256MB WASM Native Replay Buffer & JS RingBuffer Timeline Scrubber,
 * Goal Replay Controller, and main-thread audio/HUD event dispatcher.
 */

import { resolveReplayAudioCueForSignal } from './ReplayRingBuffer.js';
import {
  MAX_CARS,
  PHYSICS_EVENT_TYPES,
  INCIDENT_EVENT_TYPES,
  MATCH_SIGNALS,
  isBallFlipResetEvent,
} from '../physics/RocketSimConstants.js';
import { gameAudioEngine } from '../audio/GameAudioEngineFacade.js';
import { isSignalAudioMutedInGoalReplay } from '../audio/SignalAudioEngine.js';
import { audioConfig } from '../ui-core/config/audioConfig.js';
import { REPLAY_DIRECTOR_CONFIG } from '../ui-core/config/replayDirectorConfig.js';
import { eventStreamStore } from '../ui-core/stores/eventStreamStore';
import { hudStore } from '../ui-core/stores/hudStore';
import {
  unpackLoadoutSignalParam2,
  getCarColorSlotById,
} from '../ui-core/config/vehicleConstants.js';

/**
 * Dispatches recorded physics incidents (Track B), authoritative signals (Track C),
 * and audio cues from a ReplayTimelineController or 3-Timeline Viewer step result.
 */
export function dispatchReplayFrameEvents(stepRes, runtime = null, options = null) {
  if (!stepRes) return;
  const camera = runtime?.camera || null;
  let sawGoalIncident = false;

  const muteCfg =
    REPLAY_DIRECTOR_CONFIG.muteSignalAudioInGoalReplay !== false &&
    audioConfig.get('muteSignalAudioInGoalReplay') !== false;
  const isGoalReplay =
    typeof options?.isGoalReplay === 'boolean'
      ? options.isGoalReplay
      : isSignalAudioMutedInGoalReplay(runtime);
  const muteSignalAudio = Boolean(isGoalReplay && muteCfg);

  // 1. Track B: Physics Incidents -> Audio Engine + Event Stream Store + Visual FX
  if (Array.isArray(stepRes.incidents) && stepRes.incidents.length > 0) {
    for (let i = 0; i < stepRes.incidents.length; i++) {
      const evt = stepRes.incidents[i];
      if (!evt) continue;
      if (
        evt.type === PHYSICS_EVENT_TYPES.FLIP_RESET_GAINED ||
        evt.type === INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED
      ) {
        if (!isBallFlipResetEvent(evt)) {
          continue;
        }
        const targetCarIdx = typeof evt.carIndex === 'number' && evt.carIndex >= 0 ? evt.carIndex : 0;
        runtime?.getFlipResetVisual?.(targetCarIdx)?.play?.();
      }
      if (evt.type === INCIDENT_EVENT_TYPES.GOAL_SCORED) {
        sawGoalIncident = true;
      }
      const normalizedEvt =
        !Number.isFinite(evt.x) && Number.isFinite(evt.posX)
          ? {
              ...evt,
              x: evt.posX,
              y: evt.posY ?? 0,
              z: evt.posZ ?? 0,
            }
          : evt;
      try {
        eventStreamStore?.addEvent?.(normalizedEvt);
      } catch (err) {
        console.warn('[ReplayTimelineController] Failed to push replay incident to eventStreamStore:', err);
      }
      gameAudioEngine?.handleEvent?.(normalizedEvt, camera);
    }
  }

  // 2. Track C: Signals + Audio Cues (deduplicated per step; suppressed in Goal Replay when muteSignalAudio is enabled)
  const playedCueKeys = new Set();
  const isCountUp = Boolean(stepRes.isCountUp);

  if (!muteSignalAudio && Array.isArray(stepRes.audioEvents) && stepRes.audioEvents.length > 0) {
    for (let i = 0; i < stepRes.audioEvents.length; i++) {
      const cue = stepRes.audioEvents[i];
      const cueKey = cue?.cueId || cue?.cueName;
      if (cueKey && !playedCueKeys.has(cueKey)) {
        playedCueKeys.add(cueKey);
        gameAudioEngine?.play?.(cueKey, cue?.volume ?? 1.0);
      }
    }
  }

  if (Array.isArray(stepRes.signals) && stepRes.signals.length > 0) {
    for (let i = 0; i < stepRes.signals.length; i++) {
      const sig = stepRes.signals[i];
      if (!sig) continue;
      if (!muteSignalAudio) {
        const cue = resolveReplayAudioCueForSignal(sig, isCountUp);
        const cueKey = cue?.cueId || cue?.cueName;
        if (cueKey && !playedCueKeys.has(cueKey)) {
          playedCueKeys.add(cueKey);
          gameAudioEngine?.play?.(cueKey, cue?.volume ?? 1.0);
        }
      }

      if (sig.signalType === MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED && runtime) {
        const carIndex = Number(sig.param1 ?? -1);
        if (carIndex >= 0 && carIndex < MAX_CARS) {
          const unpacked = unpackLoadoutSignalParam2(sig.param2 ?? 0);
          const colorHex = getCarColorSlotById(unpacked.colorSlot)?.hex || '#42a5f5';
          runtime.physics?.setCarHitbox?.(carIndex, unpacked.hitboxId);
          runtime.arena?.setCarLoadout?.(carIndex, {
            visualId: unpacked.visualId,
            hitboxId: unpacked.hitboxId,
            colorHex,
            paintFinish: unpacked.hasExtendedCosmetics ? unpacked.paintFinish : undefined,
            boostVisual: unpacked.hasExtendedCosmetics ? unpacked.boostVisual : undefined,
          });
          if (unpacked.hasExtendedCosmetics) {
            gameAudioEngine?.setCarBoostAudioVariation?.(carIndex, unpacked.boostAudio);
          }
        }
      }

      if (stepRes.syncHudFromSignals) {
        if (sig.signalType === MATCH_SIGNALS.SCORE_UPDATED) {
          hudStore.getState().setMatchState({
            blueScore: sig.param1 ?? 0,
            orangeScore: sig.param2 ?? 0,
          });
        } else if (sig.signalType === MATCH_SIGNALS.OVERTIME_START) {
          hudStore.getState().setMatchState({
            remainingSeconds: 0,
            isOvertime: true,
            overtimeSeconds: 0,
          });
        } else if (
          sig.signalType === MATCH_SIGNALS.COUNTDOWN_10S ||
          sig.signalType === MATCH_SIGNALS.TIME_ALERT_60S ||
          sig.signalType === MATCH_SIGNALS.TIME_ALERT_30S
        ) {
          hudStore.getState().setMatchState({
            remainingSeconds: sig.param1 ?? 0,
            isOvertime: false,
          });
        }
      }
    }
  }

  if (!muteSignalAudio && sawGoalIncident && !playedCueKeys.has('sfx_goal_poof')) {
    playedCueKeys.add('sfx_goal_poof');
    gameAudioEngine?.play?.('sfx_goal_poof', 1.0);
  }
}

