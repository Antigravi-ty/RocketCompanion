/**
 * TelemetryStage.js
 * Updates speedometer HUD needles, flip availability indicator (with countdown & unlimited state),
 * Layer 5A 6-slot player HUD roster strips, and finalizes frame profiling metrics.
 */
import { hudStore } from '../../../ui-core/stores/hudStore';
import { useAppStore } from '../../../ui-core/stores/appStore';
import { useExperimentalMultiBotsStore } from '../../../ui-core/stores/experimentalMultiBotsStore';
import { globalHudTransientChannel } from '../../../ui-core/stores/hudTransientChannel';
import { assignTeamSlotKeys } from '../../../replay/container/RCReplayTimelineParser.js';

export class TelemetryStage {
  constructor(runtime) {
    this.runtime = runtime;
    this._demolishedAtMsByCar = {};
  }

  _resolveCarHudTelemetry(carIndex) {
    const r = this.runtime;
    const cv =
      r?.interpolator?.getCurrCarStateView?.(carIndex) ||
      r?.physics?.getCarStateView?.(carIndex);
    const boostAmount = cv ? Math.max(0, Math.min(100, Math.round(cv.boost || 0))) : 33;
    const isDemolished = Boolean(cv && (cv.isDemoed || cv.demoRespawnTimer > 0));
    const demoRespawnRemainingSec = isDemolished
      ? Math.max(0, Number((cv.demoRespawnTimer || 0).toFixed(2)))
      : 0;

    if (isDemolished) {
      if (!this._demolishedAtMsByCar[carIndex]) {
        this._demolishedAtMsByCar[carIndex] =
          typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
    } else if (this._demolishedAtMsByCar[carIndex]) {
      this._demolishedAtMsByCar[carIndex] = 0;
    }

    return {
      boostAmount,
      isDemolished,
      demoRespawnRemainingSec,
      demolishedAtMs: this._demolishedAtMsByCar[carIndex] || 0,
    };
  }

  _syncEdgeRosterHud(context, hudState) {
    const r = this.runtime;
    const appState = useAppStore?.getState?.();
    const matchMode = r?.match?.state?.mode || appState?.matchMode || 'freeplay';
    const freeplayMode = r?.modeManager?.modes?.get?.('freeplay') || null;
    const replayViewer = freeplayMode?.standaloneReplayViewer || null;
    const isReplayViewerLoaded =
      (matchMode === 'freeplay' || matchMode === 'replay-viewer') &&
      Boolean(replayViewer?.hasLoadedReplay);

    if (
      !isReplayViewerLoaded &&
      matchMode !== 'exp-multi-bots' &&
      matchMode !== 'match' &&
      matchMode !== 'online-warmup' &&
      matchMode !== 'dev-test-lab'
    ) {
      return;
    }

    const isReplayPov =
      (r?.match?.state?.phase === 'replay' || hudState?.matchPhase === 'replay') &&
      !r?.goalReplayCameraOverrideActive &&
      typeof r?.replayPovCarIndex === 'number' &&
      r.replayPovCarIndex >= 0;

    const activeCameraCar = isReplayViewerLoaded
      ? typeof replayViewer.activePovCarIndex === 'number'
        ? replayViewer.activePovCarIndex
        : r?.playerCarIndex ?? 0
      : isReplayPov
      ? r.replayPovCarIndex
      : typeof context?.activeCar === 'number'
      ? context.activeCar
      : typeof r?.playerCarIndex === 'number'
      ? r.playerCarIndex
      : 0;

    let blueEntries = [];
    let orangeEntries = [];
    let isSpectatingNoHuman = false;
    let detectedLocalTeam = null;

    if (isReplayViewerLoaded) {
      isSpectatingNoHuman = true;
      detectedLocalTeam = replayViewer.localTeam ?? 0;
      const roster = Array.isArray(replayViewer.resolvedRoster)
        ? replayViewer.resolvedRoster
        : [];
      for (const c of roster) {
        const item = {
          carIndex: c.carIndex,
          name: c.name || `Car ${c.carIndex + 1}`,
          isSelf: Boolean(c.isSelf),
        };
        if (c.team === 1) {
          orangeEntries.push(item);
        } else {
          blueEntries.push(item);
        }
      }
    } else if (matchMode === 'exp-multi-bots') {
      const expStore = useExperimentalMultiBotsStore.getState();
      const activeMode = r?.modeManager?.getActiveMode?.();
      const rawCars =
        Array.isArray(activeMode?.spawnedCars) && activeMode.spawnedCars.length > 0
          ? activeMode.spawnedCars
          : expStore.spawnedCars || [];
      isSpectatingNoHuman = expStore.playerParticipation === 'none';
      if (expStore.playerParticipation === 'orange') {
        detectedLocalTeam = 1;
      } else if (expStore.playerParticipation === 'blue') {
        detectedLocalTeam = 0;
      }

      const sameBotCounts = {};
      for (const c of rawCars) {
        if (!c.isPlayer) {
          const bt = String(c.botType || 'necto').toLowerCase();
          sameBotCounts[bt] = (sameBotCounts[bt] || 0) + 1;
        }
      }

      for (const c of rawCars) {
        const bt = String(c.botType || 'necto');
        const capBot = bt.charAt(0).toUpperCase() + bt.slice(1).toLowerCase();
        const defaultName = c.isPlayer
          ? 'Player'
          : (sameBotCounts[bt.toLowerCase()] || 0) > 1
          ? `${capBot} #${c.keyNumber || c.carIndex + 1}`
          : capBot;
        const isSelf = Boolean(c.isPlayer);
        if (isSelf) {
          detectedLocalTeam = c.team === 1 ? 1 : 0;
        }
        const item = {
          carIndex: c.carIndex,
          name: c.name || defaultName,
          isSelf,
          isBot: !c.isPlayer,
        };
        if (c.team === 1) {
          orangeEntries.push(item);
        } else {
          blueEntries.push(item);
        }
      }
    } else if (matchMode === 'match' || matchMode === 'online-warmup') {
      const rawRoster = r?._lastRosterSnapshot || r?.authoritativeServer?.lastRoomState?.roster;
      const rosterSnap = Array.isArray(rawRoster?.players)
        ? rawRoster.players
        : Array.isArray(rawRoster)
        ? rawRoster
        : Array.isArray(r?.replayTimelineController?.carEntries)
        ? r.replayTimelineController.carEntries
        : [];
      const peers = appState?.onlineSession?.connectedPeers || [];
      const localPeerId = r?.multiplayerSession?.localPeerId || appState?.onlineSession?.localPeerId;
      const localCarIdx =
        typeof r?.networkReconciler?.localCarIndex === 'number' &&
        r.networkReconciler.localCarIndex >= 0
          ? r.networkReconciler.localCarIndex
          : typeof r?.reconciler?.localCarIndex === 'number' && r.reconciler.localCarIndex >= 0
          ? r.reconciler.localCarIndex
          : r?.playerCarIndex ?? 0;

      if (rosterSnap.length > 0) {
        const sortedRoster = [...rosterSnap].sort((a, b) => {
          const ca = typeof a?.carIndex === 'number' ? a.carIndex : (a?.entityId ?? 0);
          const cb = typeof b?.carIndex === 'number' ? b.carIndex : (b?.entityId ?? 0);
          return ca - cb;
        });
        for (const p of sortedRoster) {
          const cIdx =
            typeof p?.carIndex === 'number'
              ? p.carIndex
              : typeof p?.entityId === 'number'
              ? p.entityId
              : -1;
          if (p.team === 'spectator' || p.role === 'spectator' || cIdx < 0) continue;
          const isOrange = p.team === 1 || p.team === 'orange';
          const isSelf = Boolean(
            p.isLocal ||
              p.isLocalPlayer ||
              (localPeerId && (p.peerId === localPeerId || p.sessionId === localPeerId)) ||
              cIdx === localCarIdx
          );
          if (isSelf) {
            detectedLocalTeam = isOrange ? 1 : 0;
          }
          const isBot = Boolean(
            p.isBot ||
              p.botType ||
              String(p.peerId || p.sessionId || '').startsWith('bot')
          );
          const item = {
            carIndex: cIdx,
            name: p.username || p.name || p.playerName || `Player ${cIdx + 1}`,
            isSelf,
            isBot,
          };
          if (isOrange) {
            orangeEntries.push(item);
          } else {
            blueEntries.push(item);
          }
        }
      } else if (peers.length > 0 || (r?._participantTeams instanceof Map && r._participantTeams.size > 0)) {
        const combinedByCar = new Map();
        const selfTeam =
          r?._participantTeams?.get?.(localCarIdx) ??
          r?.arena?.carTeams?.[localCarIdx] ??
          (localCarIdx % 2);
        const selfName =
          r?.multiplayerSession?.playerName ||
          appState?.onlineSession?.playerName ||
          r?.networkReconciler?.carNames?.get?.(localCarIdx) ||
          `Player ${localCarIdx + 1}`;
        combinedByCar.set(localCarIdx, {
          carIndex: localCarIdx,
          name: selfName,
          team: selfTeam === 1 || selfTeam === 'orange' ? 1 : 0,
          isSelf: true,
          isBot: false,
        });

        let fallbackIdx = 0;
        for (const p of peers) {
          if (p.team === 'spectator' || p.role === 'spectator') continue;
          const cIdx =
            typeof p.carIndex === 'number'
              ? p.carIndex
              : typeof p.entityId === 'number'
              ? p.entityId
              : fallbackIdx++;
          const isSelf = Boolean(
            p.isSelf || (localPeerId && p.id === localPeerId) || cIdx === localCarIdx
          );
          const isOrange =
            p.team === 1 ||
            p.team === 'orange' ||
            (p.team === undefined && (r?._participantTeams?.get?.(cIdx) ?? (cIdx % 2)) === 1);
          combinedByCar.set(cIdx, {
            carIndex: cIdx,
            name: p.name || p.username || r?.networkReconciler?.carNames?.get?.(cIdx) || `Player ${cIdx + 1}`,
            team: isOrange ? 1 : 0,
            isSelf,
            isBot: Boolean(p.isBot || p.botType),
          });
        }

        if (r?._participantTeams instanceof Map) {
          for (const [cIdx, tVal] of r._participantTeams.entries()) {
            if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 8 && !combinedByCar.has(cIdx)) {
              const cName = r?.networkReconciler?.carNames?.get?.(cIdx) || `Player ${cIdx + 1}`;
              combinedByCar.set(cIdx, {
                carIndex: cIdx,
                name: cName,
                team: tVal === 1 ? 1 : 0,
                isSelf: cIdx === localCarIdx,
                isBot: /^(necto|nexto|bot\b)/i.test(String(cName)),
              });
            }
          }
        }

        const orderedEntries = Array.from(combinedByCar.values()).sort(
          (a, b) => a.carIndex - b.carIndex
        );
        for (const entry of orderedEntries) {
          if (entry.isSelf) {
            detectedLocalTeam = entry.team === 1 ? 1 : 0;
          }
          const item = {
            carIndex: entry.carIndex,
            name: entry.name,
            isSelf: entry.isSelf,
            isBot: Boolean(entry.isBot),
          };
          if (entry.team === 1) {
            orangeEntries.push(item);
          } else {
            blueEntries.push(item);
          }
        }
      } else {
        const botNameRaw = String(r?.activeBotName || 'Necto');
        const botDisplay = botNameRaw.charAt(0).toUpperCase() + botNameRaw.slice(1);
        const selfName =
          r?.multiplayerSession?.playerName || appState?.onlineSession?.playerName || 'Player';
        blueEntries.push({ carIndex: 0, name: selfName, isSelf: true, isBot: false });
        detectedLocalTeam = 0;
        if ((r?.physics?.numCars ?? 2) >= 2) {
          orangeEntries.push({ carIndex: 1, name: botDisplay, isSelf: false, isBot: true });
        }
      }
    } else if (matchMode === 'dev-test-lab') {
      const numCars = r?.physics?.numCars ?? 1;
      blueEntries.push({ carIndex: 0, name: 'Player', isSelf: true, isBot: false });
      detectedLocalTeam = 0;
      if (numCars >= 2) {
        orangeEntries.push({ carIndex: 1, name: 'Bot', isSelf: false, isBot: true });
      }
    }

    const localInOrange = orangeEntries.some((e) => e.isSelf);
    const localInBlue = blueEntries.some((e) => e.isSelf);
    const localTeam =
      detectedLocalTeam === 1 || localInOrange ? 1 : detectedLocalTeam === 0 || localInBlue ? 0 : 0;
    if (hudState && hudState.localTeam !== localTeam) {
      hudState.setMatchState?.({ localTeam });
    }

    const leftEntries = localTeam === 1 ? orangeEntries : blueEntries;
    const rightEntries = localTeam === 1 ? blueEntries : orangeEntries;
    const leftLabelPrefix = localTeam === 1 ? 'Orange' : 'Blue';
    const rightLabelPrefix = localTeam === 1 ? 'Blue' : 'Orange';

    const { rightStartKey, leftSlotKeys, rightSlotKeys, slotKeyToCarIndex } = assignTeamSlotKeys(
      leftEntries,
      rightEntries
    );

    if (r) {
      r._lastHudSlotCarMap = slotKeyToCarIndex;
    }

    const sig = hudState?.choreographySignal || 'kickoff-will-start';
    const isGoalReplayView =
      sig === 'goal-replay-started' ||
      sig === 'goal-replay-will-end' ||
      hudState?.matchPhase === 'replay';

    const viewMode = isGoalReplayView
      ? 'goal-replay'
      : isSpectatingNoHuman
      ? 'spectator'
      : 'player-live';

    const ackJumpByCar = new Map();
    if (
      isGoalReplayView &&
      Array.isArray(r?.networkReconciler?.lastParsedPacket?.acknowledgedControls)
    ) {
      for (const item of r.networkReconciler.lastParsedPacket.acknowledgedControls) {
        if (item && typeof item.carIndex === 'number') {
          ackJumpByCar.set(item.carIndex, Boolean(item.controls?.jump));
        }
      }
    }

    let focusedSlotKey = null;

    const leftPlayers = [0, 1, 2, 3, 4].map((idx) => {
      const slotKey = Math.min(6, Math.max(1, leftSlotKeys[idx] ?? idx + 1));
      const entry = leftEntries[idx];
      if (!entry) {
        return {
          slotKey,
          team: 'left',
          name: `${leftLabelPrefix} #${slotKey}`,
          boostAmount: 0,
          exists: false,
          isSelf: false,
          isFocusedPov: false,
          isDemolished: false,
          demoRespawnRemainingSec: 0,
          demoRespawnTotalSec: 3.0,
          demolishedAtMs: 0,
          replaySkipReady: false,
        };
      }
      const tel = this._resolveCarHudTelemetry(entry.carIndex);
      const isFocused =
        isGoalReplayView && hudState?.replayCameraMode === 'director'
          ? false
          : viewMode === 'player-live'
          ? Boolean(entry.isSelf || entry.carIndex === activeCameraCar)
          : entry.carIndex === activeCameraCar;
      if (isFocused) {
        focusedSlotKey = slotKey;
      }
      const replaySkipReady = isGoalReplayView
        ? Boolean(
            entry.isBot ||
              (entry.isSelf &&
                (r?._localSkipReplayReady || r?.networkReconciler?.localSkipReplayReady)) ||
              ackJumpByCar.get(entry.carIndex)
          )
        : false;
      return {
        slotKey,
        carIndex: entry.carIndex,
        team: 'left',
        name: entry.name,
        boostAmount: tel.boostAmount,
        exists: true,
        isSelf: entry.isSelf,
        isFocusedPov: isFocused,
        isDemolished: tel.isDemolished,
        demoRespawnRemainingSec: tel.demoRespawnRemainingSec,
        demoRespawnTotalSec: 3.0,
        demolishedAtMs: tel.demolishedAtMs,
        replaySkipReady,
      };
    });

    const rightPlayers = [0, 1, 2, 3, 4].map((idx) => {
      const slotKey = Math.min(6, Math.max(1, rightSlotKeys[idx] ?? rightStartKey + idx));
      const entry = rightEntries[idx];
      if (!entry) {
        return {
          slotKey,
          team: 'right',
          name: `${rightLabelPrefix} #${slotKey}`,
          boostAmount: 0,
          exists: false,
          isSelf: false,
          isFocusedPov: false,
          isDemolished: false,
          demoRespawnRemainingSec: 0,
          demoRespawnTotalSec: 3.0,
          demolishedAtMs: 0,
          replaySkipReady: false,
        };
      }
      const tel = this._resolveCarHudTelemetry(entry.carIndex);
      const isFocused =
        isGoalReplayView && hudState?.replayCameraMode === 'director'
          ? false
          : viewMode === 'player-live'
          ? Boolean(entry.isSelf || entry.carIndex === activeCameraCar)
          : entry.carIndex === activeCameraCar;
      if (isFocused) {
        focusedSlotKey = slotKey;
      }
      const replaySkipReady = isGoalReplayView
        ? Boolean(
            entry.isBot ||
              (entry.isSelf &&
                (r?._localSkipReplayReady || r?.networkReconciler?.localSkipReplayReady)) ||
              ackJumpByCar.get(entry.carIndex)
          )
        : false;
      return {
        slotKey,
        carIndex: entry.carIndex,
        team: 'right',
        name: entry.name,
        boostAmount: tel.boostAmount,
        exists: true,
        isSelf: entry.isSelf,
        isFocusedPov: isFocused,
        isDemolished: tel.isDemolished,
        demoRespawnRemainingSec: tel.demoRespawnRemainingSec,
        demoRespawnTotalSec: 3.0,
        demolishedAtMs: tel.demolishedAtMs,
        replaySkipReady,
      };
    });

    globalHudTransientChannel.setRoster({
      viewMode,
      focusedSlotKey,
      leftPlayers,
      rightPlayers,
    });
  }

  execute(context) {
    const r = this.runtime;
    const { playerCarView } = context;
    const hudState = hudStore?.getState?.();

    if (playerCarView) {
      const hasFlipNow = !playerCarView.isDemoed && Boolean(playerCarView.isOnGround || playerCarView.hasFlipOrJump);
      const flipStatus = playerCarView.flipStatus;
      const flipRemainingSeconds = playerCarView.flipRemainingSeconds;
      const flipsRemaining = playerCarView.flipsRemaining;

      const carSpeed =
        typeof context.overrideCarSpeed === 'number'
          ? context.overrideCarSpeed
          : playerCarView.isDemoed
          ? 0
          : Math.hypot(playerCarView.velX, playerCarView.velY, playerCarView.velZ);
      hudState?.setHasFlip?.(hasFlipNow, flipStatus, flipRemainingSeconds, flipsRemaining);
      hudState?.setDemoRespawnState?.(
        playerCarView.isDemoed,
        playerCarView.demoRespawnTimer,
        playerCarView.demoSpawnSelection
      );
      hudState?.setCarSpeed?.(carSpeed);
    }

    this._syncEdgeRosterHud(context, hudState);

    if (r.profiler) {
      r.profiler.mark();
      const totalTicks = (r.pipeline?._accumSimTicks ?? 0) + (r.interpolator?.lastTicks ?? 0);
      const totalDropped = (r.pipeline?._accumSimDropped ?? 0) + (r.interpolator?.lastDropped ?? 0);
      const totalStalled = Boolean(r.pipeline?._accumSimStalled || r.interpolator?.lastStalled);
      r.profiler.frameEnd(totalTicks, totalDropped, totalStalled);
    }
  }
}
