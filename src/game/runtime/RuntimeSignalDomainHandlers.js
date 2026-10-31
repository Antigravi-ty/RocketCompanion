/**
 * RuntimeSignalDomainHandlers.js
 * Domain-specific handlers for player roster/loadout signals and match clock/pause signals.
 */

import { MATCH_SIGNALS } from '../../network/protocol/GlobalPayloadCodec.js';
import {
  CAR_COLOR_SLOTS,
  unpackLoadoutSignalParam2
} from '../../ui-core/config/vehicleConstants.js';
import { gameAudio } from '../../audio/GameAudioEngineFacade.js';
import { isSignalAudioMutedInGoalReplay } from '../../audio/SignalAudioEngine.js';
import { hudStore } from '../../ui-core/stores/hudStore';
import { syncHostLobbyOngoingNotification } from './RuntimeOnlineRosterSync.js';

export const WIN_REASON_LABELS = Object.freeze({
  0: 'SCORE',
  1: 'POSSESSION',
  2: 'FORFEIT'
});

export function handleRuntimeRosterSignal(runtime, reconciler, sig) {
  const r = runtime;
  const isLobbyDualWorld = Boolean(
    r.arena?.isLobbyMode ||
    reconciler?.lobbyDualWorldMode ||
    r.networkManager?.lobbyGhostCoordinator?.lobbyModeActive
  );
  switch (sig.signalType) {
    case MATCH_SIGNALS.PLAYER_JOINED:
    case MATCH_SIGNALS.PLAYER_SLOT_UPDATED: {
      const carIdx = sig.param1;
      const team = sig.param2 & 0xFF;
      if (typeof carIdx === 'number' && carIdx >= 0 && carIdx < 8) {
        if (!(r._participantTeams instanceof Map)) {
          r._participantTeams = new Map();
        }
        if (team === 0 || team === 1) {
          r._participantTeams.set(carIdx, team);
        }
        if (isLobbyDualWorld && carIdx !== r.playerCarIndex) {
          if (r.arena?.cars?.[carIdx]) {
            r.arena.cars[carIdx].visible = false;
          }
          syncHostLobbyOngoingNotification(r);
          return true;
        }
        const preset = reconciler.carVisualPresets?.get(carIdx) || 'fennec';
        if (r.physics) {
          if (typeof r.physics.addCarAtSlot === 'function') {
            r.physics.addCarAtSlot(carIdx, team, preset);
          } else {
            while (r.physics.numCars <= carIdx) {
              const idx = r.physics.numCars;
              r.physics.addCar(idx === carIdx ? team : (idx % 2), reconciler.carVisualPresets?.get(idx) || 'fennec');
            }
          }
        }
        r.physics?.setCarTeam?.(carIdx, team);
        if (r.arena) {
          if (typeof r.arena.ensureCar === 'function') {
            r.arena.ensureCar(carIdx, team, 'fennec');
          } else {
            while (r.arena.cars.length <= carIdx) {
              r.arena.addCar(r.arena.cars.length % 2, 'fennec');
            }
          }
          r.arena.setCarTeam?.(carIdx, team);
          if (r.arena.cars[carIdx]) {
            r.arena.cars[carIdx].visible = isLobbyDualWorld ? (carIdx === r.playerCarIndex) : true;
          }
        }
        if (preset) {
          r.physics?.setCarHitbox?.(carIdx, preset);
        }
      }
      syncHostLobbyOngoingNotification(r);
      return true;
    }

    case MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED: {
      const carIdx = sig.param1;
      const {
        visualId,
        hitboxId,
        colorSlot: colorSlotId,
        paintFinish,
        boostVisual,
        boostAudio
      } = unpackLoadoutSignalParam2(sig.param2);

      if (typeof carIdx === 'number' && carIdx >= 0 && carIdx < 8) {
        reconciler.setCarVisualPreset?.(carIdx, visualId);
        if (isLobbyDualWorld && carIdx !== r.playerCarIndex) {
          if (r.arena?.cars?.[carIdx]) {
            r.arena.cars[carIdx].visible = false;
          }
          return true;
        }
        if (r.arena && !r.arena.cars[carIdx]) {
          r.arena.ensureCar?.(carIdx, carIdx % 2, 'fennec');
        }
        const currentConfig = r.entityManager?.getVehicleConfig?.(carIdx);
        const currentVisual = currentConfig?.visual;
        const currentHitbox = currentConfig?.hitbox;
        if (currentVisual !== visualId || currentHitbox !== hitboxId) {
          if (r.entityManager) {
            r.entityManager.hotSwapVehicle(carIdx, { visual: visualId, hitbox: hitboxId });
          } else {
            r.arena?.swapCarVisual?.(carIdx, visualId);
            r.physics?.setCarHitbox?.(carIdx, hitboxId);
          }
        } else {
          r.physics?.setCarHitbox?.(carIdx, hitboxId);
        }

        let colorHex = null;
        if (colorSlotId >= 0 && colorSlotId < CAR_COLOR_SLOTS.length) {
          const slotObj = CAR_COLOR_SLOTS[colorSlotId] || CAR_COLOR_SLOTS.find((s) => s.id === colorSlotId);
          if (slotObj) {
            colorHex = slotObj.hex;
            r.arena?.setCarColor?.(carIdx, slotObj.hex);
          }
        }
        r.arena?.setCarLoadout?.(carIdx, {
          colorHex: colorHex || undefined,
          paintFinish,
          boostVisual,
          boostAudio
        });
        const audioEngine = r.options?.gameAudio || gameAudio;
        audioEngine?.setCarBoostAudioVariation?.(carIdx, boostAudio || 'rush');
      }
      return true;
    }

    case MATCH_SIGNALS.PLAYER_LEFT: {
      const leftCarIndex = sig.param1;
      if (leftCarIndex >= 0 && leftCarIndex < 65535) {
        r._participantTeams?.delete?.(leftCarIndex);
      }
      if (leftCarIndex >= 0 && leftCarIndex < 65535 && leftCarIndex !== r.playerCarIndex) {
        r.physics?.removeCar?.(leftCarIndex);
        r.arena?.removeCar(leftCarIndex);
        if (r.flipResetVisuals.has(leftCarIndex)) {
          r.flipResetVisuals.get(leftCarIndex).stopVisual();
          r.flipResetVisuals.delete(leftCarIndex);
        }
      }
      syncHostLobbyOngoingNotification(r);
      return true;
    }

    default:
      return false;
  }
}

export function handleRuntimeClockAndPauseSignal(runtime, reconciler, sig, currentTick, audio) {
  const r = runtime;
  const muteSignalAudio = isSignalAudioMutedInGoalReplay(r);
  switch (sig.signalType) {
    case MATCH_SIGNALS.TIME_ALERT_60S: {
      if (r._lastAlert60Frame !== sig.frameId) {
        r._lastAlert60Frame = sig.frameId;
        if (!muteSignalAudio) {
          audio?.play('match_60_seconds_left', 1.0, 10000);
        }
      }
      return true;
    }

    case MATCH_SIGNALS.TIME_ALERT_30S: {
      if (r._lastAlert30Frame !== sig.frameId) {
        r._lastAlert30Frame = sig.frameId;
        if (!muteSignalAudio) {
          audio?.play('match_30_seconds_left', 1.0, 10000);
        }
      }
      return true;
    }

    case MATCH_SIGNALS.COUNTDOWN_10S: {
      const sec = sig.param1;
      if (sec >= 1 && sec <= 10 && r.audioLast10sCountdown !== sec) {
        r.audioLast10sCountdown = sec;
        if (!muteSignalAudio) {
          audio?.play('match_countdown_10s', 1.0);
        }
      }
      return true;
    }

    case MATCH_SIGNALS.CLOCK_UPDATED_SECONDS: {
      const seconds = sig.param1;
      const clockMode = sig.param2 || 0;
      const isOt = clockMode === 1;
      // Ignore stale regulation 0s clock packets once overtime has already started
      if (!isOt && r.match?.state?.overtime && (r.match?.state?.phase === 'kickoff' || seconds === 0)) {
        return true;
      }
      const remSec = isOt ? 0 : seconds;
      const otSec = isOt ? seconds : 0;

      if (r.match) {
        r.match.state.remainingSeconds = remSec;
        r.match.state.overtime = isOt;
        r.match.state.overtimeSeconds = otSec;
      }

      hudStore.getState().setMatchState({
        remainingSeconds: remSec,
        isOvertime: isOt,
        overtimeSeconds: otSec
      });
      return true;
    }

    case MATCH_SIGNALS.MATCH_PAUSED: {
      if (r.match) r.match.state.paused = true;
      hudStore.getState().setMatchState({ isPaused: true, matchPhase: 'paused' });
      return true;
    }

    case MATCH_SIGNALS.MATCH_WILL_RESUME: {
      const resumeAtTick = sig.param1;
      const remTicks = Math.max(0, resumeAtTick - currentTick);
      const remSec = Math.ceil(remTicks / 120);
      hudStore.getState().setMatchState({
        isPaused: true,
        kickoffCountdown: remSec
      });
      return true;
    }

    case MATCH_SIGNALS.MATCH_RESUMED: {
      if (r.match) {
        r.match.state.paused = false;
        if (r.match.state.phase === 'paused') {
          r.match.state.phase = 'playing';
        }
      }
      hudStore.getState().setMatchState({
        isPaused: false,
        matchPhase: r.match?.state?.phase || 'playing',
        kickoffCountdown: 0
      });
      return true;
    }

    case MATCH_SIGNALS.OVERTIME_START: {
      if (r.match) {
        r.match.state.overtime = true;
        r.match.state.overtimeSeconds = 0;
      }
      hudStore.getState().setMatchState({
        isOvertime: true,
        overtimeSeconds: 0
      });
      if (!r._overtimeAudioPlayed && !muteSignalAudio) {
        r._overtimeAudioPlayed = true;
        audio?.play('match_entering_overtime', 1.0, 10000);
      }
      return true;
    }

    default:
      return false;
  }
}
