import {
  useAppStore,
  hudStore,
  setNameTagRuntimeState,
  notifyNetworkTelemetryExportAvailable,
} from '../runtimeUiPort.ts';
import { captureRuntimeReplayCarEntries } from '../../replay/replayDirectorCarRosterPipeline.ts';
import { retainCompletedMatchReplayAndNotify } from '../../replay/ReplayFileExporter.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type {
  RuntimeSignalHostPort,
  RuntimeSignalLatchState,
  RuntimeSignalPacket,
} from './RuntimeParticipantAndCombatSignalSubController.ts';

export function isLocalReplayOrRewinderBlockingLivePhysics(
  modeManager: RuntimeSignalHostPort['modeManager']
): boolean {
  const activeMode = modeManager?.getActiveMode?.();
  return Boolean(
    activeMode?.rewinderController?.isBlockingLivePhysics ||
    activeMode?.standaloneReplayViewer?.isActive
  );
}

export function focusLocalPlayerCarInArenaAndCamera(
  reconciler: PredictionReconciler | null | undefined,
  context: RuntimeSignalHostPort,
  options: { resetView?: boolean; syncInterpolator?: boolean; alwaysAssign?: boolean } = {}
): number {
  const hasLocalCar =
    typeof reconciler?.localCarIndex === 'number' && reconciler.localCarIndex >= 0;
  if (hasLocalCar || options.alwaysAssign) {
    const resolvedIndex = hasLocalCar
      ? reconciler!.localCarIndex
      : typeof context.playerCarIndex === 'number' && context.playerCarIndex >= 0
        ? context.playerCarIndex
        : 0;
    context.playerCarIndex = resolvedIndex;
    if (context.arena) context.arena.playerCarIndex = resolvedIndex;
    context.camera?.setFocusedCarIndex?.(resolvedIndex);
  }
  if (options.resetView) context.camera?.resetView?.();
  if (options.syncInterpolator) context.interpolator?.sync?.();
  return context.playerCarIndex;
}

export function teardownSignalReplayAndPodiumSession(
  context: RuntimeSignalHostPort,
  options: { exitPodium?: boolean; resetCameraIfWasInReplay?: boolean } = {}
): void {
  const wasOverrideActive = Boolean(
    options.resetCameraIfWasInReplay && context.isGoalReplayCameraOverrideActive()
  );
  context.replayPovCarIndex = null;
  context.releaseGoalReplayCameraOverride();
  const serverReplayCtrl =
    context.authoritativeServer?.fallbackManager?.goalReplay?.replayController;
  const timeline = context.replayTimelineController;
  if (
    timeline &&
    serverReplayCtrl &&
    serverReplayCtrl !== timeline &&
    serverReplayCtrl.ActiveWindowCount > 0
  ) {
    const existingEntries = timeline.sessionState?.carEntries;
    timeline.copyRetainedReplayFrom(serverReplayCtrl);
    if (
      (!Array.isArray(timeline.sessionState.carEntries) ||
        timeline.sessionState.carEntries.length === 0) &&
      Array.isArray(existingEntries) &&
      existingEntries.length > 0
    ) {
      timeline.sessionState.carEntries = existingEntries;
    }
  }
  timeline?.endReplaySession?.();
  if (options.exitPodium) context.podiumController?.exitPodium?.();
  if (wasOverrideActive) context.camera?.resetView?.();
}

export function toggleGoalReplayCameraViewMode(
  context: RuntimeSignalHostPort,
  scorerCarIdx: number
): void {
  const curMode = hudStore.getState().replayCameraMode === 'pov' ? 'pov' : 'director';
  const nextMode = curMode === 'director' ? 'pov' : 'director';
  const activeMode = context.modeManager?.getActiveMode?.();
  if (typeof activeMode?.setReplayCameraMode === 'function') {
    activeMode.setReplayCameraMode(nextMode);
  } else if (activeMode?.replaySession) {
    activeMode.replaySession.replayCameraMode = nextMode;
  } else if (nextMode === 'pov') {
    context.replayPovCarIndex = scorerCarIdx;
    context.releaseGoalReplayCameraOverride();
    hudStore.getState().setReplayState?.({ replayCameraMode: 'pov' });
  } else {
    context.replayPovCarIndex = null;
    context.acquireGoalReplayCameraOverride?.('goal-replay');
    hudStore.getState().setReplayState?.({ replayCameraMode: 'director' });
  }
}

export function startGoalReplayDirectorSession(
  context: RuntimeSignalHostPort,
  options: { durationTicks: number; scoringTeam: number; scorerCarIndex: number }
): void {
  context.replayPovCarIndex = null;
  context.acquireGoalReplayCameraOverride?.('goal-replay');
  const carEntries = captureRuntimeReplayCarEntries(context, {
    defaultTeam: options.scoringTeam,
  });
  setNameTagRuntimeState({ carEntries });
  context.replayTimelineController?.beginReplaySession?.({
    durationTicks: options.durationTicks,
    scoringTeam: options.scoringTeam,
    scorerCarIndex: options.scorerCarIndex,
    carEntries,
    isNetworkStreamed: true,
  });
}

export function resetGoalReplayIncidentFlags(
  context: RuntimeSignalHostPort,
  clearIncidentLatch = false
): void {
  if (clearIncidentLatch) context._clientGoalIncidentLatched = false;
  context._localSkipReplayReady = false;
}

export function exitLobbyDualWorldAndActivateMatchMode(context: RuntimeSignalHostPort): void {
  const arena = context.arena;
  if (arena) {
    arena.isLobbyMode = false;
    arena.isHostLobby = false;
  }
  context.setLobbyGhostMode(false, { syncServerLobby: false });
  context.setLatestServerRosterState('match');
  context.interpolator?.sync?.();
  context.modeManager?.setMode?.('match');
  useAppStore.getState().setMatchMode('match');
}

export function preparePhysicsReplayRecordingForMatch(
  context: RuntimeSignalHostPort,
  options: { clearBuffer?: boolean; resetBallTrail?: boolean } = {}
): void {
  const physics = context.physics;
  if (options.clearBuffer) {
    physics?.clearReplayBuffer?.();
    context.clientReplayOverflowPaused = false;
  }
  if (!context.clientReplayOverflowPaused) physics?.setReplayRecordingActive?.(true);
  physics?.resetGoalLatch?.();
  physics?.setSimulationFrozen?.(false);
  physics?.setUnlimitedBoost?.(false);
  if (options.resetBallTrail) context.arena?.resetBallTrail?.();
}

export function pushMatchPrepareSignalToPhysicsBuffer(
  context: RuntimeSignalHostPort,
  sig: RuntimeSignalPacket,
  currentTick: number
): void {
  const physics = context.physics;
  if (typeof physics?.pushSignalEvent === 'function') {
    const p1 = Number(sig.param1 || 0) >>> 0;
    const p2 = Number(sig.param2 || 0) >>> 0;
    physics.pushSignalEvent(
      sig.signalType || 0,
      (sig.frameId ?? currentTick) >>> 0,
      Number(sig.param1 || 0),
      Number(sig.param2 || 0),
      0,
      0,
      0,
      0,
      p1 & 0xffff,
      (p1 >>> 16) & 0xffff,
      p2,
      (sig.signalId || 0) >>> 0,
      0,
      0
    );
  }
}

export function isKickoffTransitioningFromReplay(context: RuntimeSignalHostPort): boolean {
  return Boolean(
    context.isGoalReplayCameraOverrideActive() ||
    context.replayTimelineController?.sessionState?.isActive ||
    context.match?.state?.phase === 'replay'
  );
}

export function resetCameraViewIfInvalidOrWasInReplay(
  context: RuntimeSignalHostPort,
  wasInReplay: boolean
): void {
  const pos = context.camera?.camera?.position;
  if (
    wasInReplay ||
    (pos && (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)))
  ) {
    context.camera?.resetView?.();
  }
}

export function syncMatchParticipantsInLocalWorld(
  context: RuntimeSignalHostPort,
  reconciler: PredictionReconciler | null
): void {
  const physics = context?.physics;
  const arena = context?.arena;
  if (!context || !physics) return;
  const presets = reconciler?.carVisualPresets;
  const peers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
  const activeParticipantMap = new Map<number, number>();
  const localIdx = focusLocalPlayerCarInArenaAndCamera(reconciler, context, { alwaysAssign: true });
  activeParticipantMap.set(localIdx, localIdx % 2);

  if (presets instanceof Map) {
    for (const cIdx of presets.keys()) {
      if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 6 && !activeParticipantMap.has(cIdx)) {
        activeParticipantMap.set(cIdx, cIdx % 2);
      }
    }
  }
  for (const peer of peers) {
    if (typeof peer?.carIndex === 'number' && peer.carIndex >= 0 && peer.carIndex < 6) {
      activeParticipantMap.set(
        peer.carIndex,
        typeof peer.team === 'number' ? peer.team : peer.carIndex % 2
      );
    }
  }
  if (context.remotePeerCarMap instanceof Map) {
    for (const cIdx of context.remotePeerCarMap.values()) {
      if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 6 && !activeParticipantMap.has(cIdx)) {
        activeParticipantMap.set(cIdx, cIdx % 2);
      }
    }
  }

  for (let c = 0; c < 8; c++) {
    if (activeParticipantMap.has(c)) {
      const team = activeParticipantMap.get(c) ?? c % 2;
      const preset = presets?.get?.(c) || 'octane';
      if (typeof physics.addCarAtSlot === 'function') physics.addCarAtSlot(c, team, preset);
      else if (physics.numCars <= c) physics.addCar(team, preset);
      physics.setCarTeam?.(c, team);
      physics.setCarCollisionMask?.(c, true, true);
      physics.setCarLinearFactorAndGravity?.(c, 1, 1, 1, 1);
      if (arena) {
        arena.vehicleRegistry.ensureCar(c, team, preset);
        if (arena.cars?.[c]) arena.cars[c].visible = true;
      }
    } else {
      if (physics.isCarSlotActive?.(c)) physics.removeCar?.(c);
      if (arena?.cars?.[c]) arena.cars[c].visible = false;
    }
  }
}

export function enterPodiumAndResetEndgameAudio(
  context: RuntimeSignalHostPort,
  reconciler: PredictionReconciler,
  isPodiumStart: boolean,
  winningTeam: number,
  winReason: string
): void {
  if (isPodiumStart) {
    reconciler.setMatchTelemetryActive?.(false, false);
    context.podiumController?.enterPodium?.(winningTeam, winReason);
  }
  if (!context.isNetworkTelemetryNotified()) {
    context.markNetworkTelemetryNotified(true);
    notifyNetworkTelemetryExportAvailable('match-complete', reconciler.telemetryCollector.recorder);
  }
  context.resetAudio?.();
  context.audioSubsystem?.resetAudio?.();
}

export function retainHostMatchReplayAfterEnd(
  context: RuntimeSignalHostPort,
  latch: RuntimeSignalLatchState,
  winningTeam: number,
  winReasonCode: number
): void {
  const server = context.authoritativeServer;
  const matchState = context.match?.state;
  if (!server || latch.hostMatchReplayNotified) return;
  latch.hostMatchReplayNotified = true;
  const blueScore = matchState?.blueScore ?? hudStore.getState().blueScore ?? 0;
  const orangeScore = matchState?.orangeScore ?? hudStore.getState().orangeScore ?? 0;
  const fallbackRoster =
    (server as { lastRoomState?: { roster?: { players?: Array<Record<string, unknown>> } } })
      .lastRoomState?.roster?.players || [];
  const basePayload = {
    ringBuffer: server.hostReplayRingBuffer,
    fallbackState: server.cachedSnapshot || context.physics?.state,
    mode: 'Host Match',
    durationSeconds: matchState?.durationSeconds ?? 300,
    roster: fallbackRoster,
    loadouts: fallbackRoster,
    blueScore,
    orangeScore,
    winnerTeam: winningTeam,
    winReason: winReasonCode,
  };
  server
    .requestFullReplayExport()
    .then((exp: Record<string, unknown> | null) => {
      const r = exp?.roster as
        { players?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined;
      const roster = Array.isArray(exp?.loadouts)
        ? (exp.loadouts as Array<Record<string, unknown>>)
        : !Array.isArray(r) && Array.isArray(r?.players)
          ? r.players
          : Array.isArray(r)
            ? r
            : fallbackRoster;
      retainCompletedMatchReplayAndNotify({
        ...basePayload,
        stateInputBytes: (exp?.stateInputBytes as Uint8Array) || undefined,
        incidentBytes: (exp?.incidentBytes as Uint8Array) || undefined,
        signalBytes: (exp?.signalBytes as Uint8Array) || undefined,
        gameMode: (exp?.gameMode as string) || '3v3',
        durationSeconds: (exp?.durationSeconds as number) ?? basePayload.durationSeconds,
        roster,
        loadouts: roster,
        blueScore: (exp?.blueScore as number) ?? blueScore,
        orangeScore: (exp?.orangeScore as number) ?? orangeScore,
      });
    })
    .catch((err: unknown) => {
      console.warn('[RuntimeSignalDomain] requestFullReplayExport fallback:', err);
      retainCompletedMatchReplayAndNotify(basePayload);
    });
}
