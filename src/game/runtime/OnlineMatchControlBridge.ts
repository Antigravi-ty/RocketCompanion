import {
  useAppStore,
  buildHostWorkspaceBroadcastPayload,
  captureCameraSyncFromPort,
  syncClientInputEnabledUi,
  type HostOnlineWarmupPortOptions,
  type RuntimeCameraPort,
  type RuntimeMatchPort,
} from '../runtimeUiPort.ts';
import {
  resolveEffectiveClockPacingParams,
  type ClockPacingMode,
  type ClockPacingPriority,
  type ClockPacingParams,
} from '../../ui-core/config/clockPacingConfig.ts';
import type { PacingControllerParams } from '../../ui-core/config/pacingControllerEvaluator.ts';
import type { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { RuntimeDomainPortOwner } from './GoalBarrierRuntimeBridge.ts';
import {
  createMatchModeTransitionBridge,
  type MatchModeTransitionDomainPort,
} from './MatchModeTransitionBridge.ts';
import { resetRuntimeMatchStateToFreeplay } from './onlineSessionEnvironmentPipeline.ts';

export type CameraControlDomainPort = Pick<RuntimeDomainPortOwner, 'camera' | 'networkManager'>;
export type OnlineMatchControlDomainPort = MatchModeTransitionDomainPort & {
  camera?: RuntimeDomainPortOwner['camera'];
};

export type OnlineWarmupRoomConfigSpec = {
  readonly roomType: string;
  readonly gameMode: string;
  readonly botFillMode: string;
  readonly durationSeconds: number;
  readonly lobbyMode: boolean;
};

export type InitialClockPacingStateInput = Parameters<
  RuntimeMatchPort['syncInitialClockPacing']
>[0];

export function buildOnlineWarmupRoomConfig(
  opts: HostOnlineWarmupPortOptions
): OnlineWarmupRoomConfigSpec {
  return {
    roomType: opts.roomType || 'match',
    gameMode: opts.gameMode || '2v2',
    botFillMode: opts.botFillMode || 'auto_fill',
    durationSeconds: opts.durationSeconds ?? 300,
    lobbyMode: opts.lobbyMode !== undefined ? Boolean(opts.lobbyMode) : true,
  };
}

async function leaveMultiplayerSignalingSession(
  session: MultiplayerSessionManager | null
): Promise<void> {
  if (!session) return;
  if (session.isHosting) {
    await session.stopHosting?.();
  } else {
    await session.leaveSession?.();
  }
}

async function reconnectMultiplayerSignalingSession(
  session: MultiplayerSessionManager | null
): Promise<void> {
  if (!session) return;
  if (session.isHosting) {
    await session.reprobeAndRefreshHostSignaling?.();
  } else if (session.joinRoomId) {
    await session.joinRoom?.(session.joinRoomId, session.joinPassword);
  }
}

function applyInitialClockPacingToReconciler(
  reconciler: PredictionReconciler | null | undefined,
  state: InitialClockPacingStateInput
): void {
  if (!reconciler) return;
  reconciler.setClockPacingMode?.(state.clockPacingMode);
  reconciler.setClockPacingPriority?.(state.clockPacingPriority);
  reconciler.setInputBufferTarget?.(state.inputBufferTarget);
  if (Array.isArray(state.inputBufferThreshold)) {
    reconciler.setInputBufferThresholds?.(
      state.inputBufferThreshold[0],
      state.inputBufferThreshold[1]
    );
  }
  if (state.customClockPacingParams) {
    reconciler.setClockPacingParams?.(
      resolveEffectiveClockPacingParams(
        state.clockPacingMode as ClockPacingMode,
        state.clockPacingPriority as ClockPacingPriority,
        state.inputBufferTarget,
        state.inputBufferThreshold,
        state.customClockPacingParams as unknown as ClockPacingParams
      )
    );
  }
}

export function createRuntimeCameraPort(domain: CameraControlDomainPort): RuntimeCameraPort {
  const { diagnosticsProbe } = domain.networkManager;
  return {
    applyPovSettings: (cameraConfig) => {
      domain.camera?.applyPovSettings?.(cameraConfig);
    },
    setFreeCam: (enabled) => {
      domain.camera?.setFreeCam?.(enabled);
    },
    setFreeCamFov: (fov) => {
      domain.camera?.setFreeCamFov?.(fov);
    },
    resetFreeCamOverview: () => {
      domain.camera?.resetFreeCamOverview?.();
    },
    setDiagnosticObservationTarget: (targetCarIndex) =>
      diagnosticsProbe.setDiagnosticObservationTarget(targetCarIndex),
  };
}

export function createRuntimeMatchPort(domain: OnlineMatchControlDomainPort): RuntimeMatchPort {
  const modeTransitionSlice = createMatchModeTransitionBridge(domain);
  const { networkManager } = domain;
  const { sessionCoordinator, rosterSyncCoordinator } = networkManager;
  const getReconciler = () => sessionCoordinator.networkReconciler;

  return {
    ...modeTransitionSlice,
    hostOnlineWarmup: async (opts) => {
      const session = domain.multiplayerSession;
      const roomConfig = buildOnlineWarmupRoomConfig(opts);
      const applyTrainingActivity = () => {
        if (opts.roomType === 'warmup' || opts.boostPolicy) {
          sessionCoordinator.authoritativeServer?.switchActivity({
            activityId: 'multiplayer_training',
            stateSummary: {
              boostPolicy: opts.boostPolicy ?? 'limit_when_aerial',
              perPlayerBoostOverrides: opts.perPlayerBoostOverrides ?? {},
              ghostModeEnabled: opts.ghostMode === 'automatically-enable',
            },
          });
        }
      };
      if (session) {
        if (opts.playerName) session.playerName = opts.playerName;
        await session.startHosting(opts.roomId, opts.password || '', roomConfig);
        applyTrainingActivity();
        return true;
      }
      await sessionCoordinator.hostOnlineServer({
        roomId: opts.roomId,
        playerName: opts.playerName,
        ...roomConfig,
      });
      applyTrainingActivity();
      return true;
    },
    joinOnlineWarmup: async (opts) => {
      const session = domain.multiplayerSession;
      if (session) {
        if (opts.playerName) session.playerName = opts.playerName;
        return Boolean(await session.joinRoom(opts.roomId, opts.password || '', 10000));
      }
      await sessionCoordinator.joinOnlineServer({
        playerName: opts.playerName,
      });
      return true;
    },
    approvePendingPeer: (peerId) => {
      domain.multiplayerSession?.approvePendingPeer?.(peerId);
    },
    declinePendingPeer: (peerId) => {
      domain.multiplayerSession?.declinePendingPeer?.(peerId);
    },
    leaveOnlineServer: async () => {
      await leaveMultiplayerSignalingSession(domain.multiplayerSession);
      await sessionCoordinator.stopOnlineServer();
    },
    returnToOnlineLobby: async () => {
      await sessionCoordinator.returnOnlineMatchToLobby();
      domain.multiplayerSession?.notifyReturnedToLobby?.();
    },
    pauseOnlineMatch: (pause) => {
      sessionCoordinator.authoritativeServer?.pauseMatch?.(Boolean(pause));
    },
    removeRemotePlayer: async (carIndex) => {
      await rosterSyncCoordinator.removeRemotePlayer(carIndex);
    },
    reconnectSignaling: async () => {
      await reconnectMultiplayerSignalingSession(domain.multiplayerSession);
    },
    forceStartOnlineMatch: (durationSeconds = 90) => {
      networkManager.forceStartOnlineMatch(durationSeconds);
      domain.multiplayerSession?.notifyMatchStarted?.();
    },
    setOnlineGameMode: (gameMode) => {
      networkManager.setOnlineGameMode(gameMode);
    },
    setOnlineMatchDuration: (durationSeconds) => {
      networkManager.setOnlineMatchDuration(durationSeconds);
    },
    setOnlineBotFillMode: (botFillMode) => {
      networkManager.setOnlineBotFillMode(botFillMode);
    },
    setClientReady: (ready) => {
      networkManager.setClientReady(ready);
    },
    addOnlineBot: (team = null) => {
      networkManager.addOnlineBot(team);
    },
    voteRematch: (ready) => {
      if (domain.match?.state?.mode === 'exp-multi-bots') {
        void domain.modeManager?.getActiveMode?.()?.applyRosterAndStartMatch?.();
        return;
      }
      networkManager.voteRematch(ready);
    },
    switchOnlineRoleOrTeam: (role, team) => {
      networkManager.switchOnlineRoleOrTeam(role, team);
    },
    switchRoomActivity: (opts) => {
      const storeState = useAppStore.getState();
      const summary: Record<string, unknown> = {
        ...(opts.stateSummary ?? {}),
        ...(opts.trainingPackId ? { trainingPackId: opts.trainingPackId } : {}),
        ...(opts.replayId ? { replayId: opts.replayId } : {}),
      };
      let nextClientInput: boolean | undefined =
        typeof opts.stateSummary?.clientInputEnabled === 'boolean'
          ? opts.stateSummary.clientInputEnabled
          : undefined;

      if (opts.activityId === 'match') {
        const connectedPeers = storeState.onlineSession?.connectedPeers ?? [];
        if (summary.autoPullConnectedPeers === undefined) {
          summary.autoPullConnectedPeers = true;
        }
        if (summary.connectedPeers === undefined && connectedPeers.length > 0) {
          summary.connectedPeers = connectedPeers;
        }
        const hostCtrl = domain.multiplayerSession?.hostController;
        for (const peer of connectedPeers) {
          if (peer?.id && !peer.isBot) {
            hostCtrl?.recordPeerReadyState?.(peer.id, { ready: true, arenaLoaded: true });
          }
        }
        if (nextClientInput === undefined) nextClientInput = true;
        summary.clientInputEnabled = nextClientInput;
      }

      if (typeof nextClientInput === 'boolean') {
        syncClientInputEnabledUi(nextClientInput);
        sessionCoordinator.authoritativeServer?.setClientInputEnabled?.(nextClientInput);
      }

      sessionCoordinator.authoritativeServer?.switchActivity({
        activityId: opts.activityId,
        stateSummary: summary,
      });
      getReconciler()?.setReplayPlaybackMode?.(opts.activityId === 'replay');
      if (opts.activityId !== 'match') {
        if (domain.match?.state?.mode === 'match' || storeState.matchMode === 'match') {
          resetRuntimeMatchStateToFreeplay(domain.match ?? null, 'freeplay');
          storeState.setMatchMode?.('freeplay');
        }
      }
      storeState.setOnlineSession?.({
        activeRoomActivity: opts.activityId,
        ...(opts.activityId === 'multiplayer_training'
          ? {
              trainingPackSummary: {
                trainingPackId:
                  (summary.trainingPackId as string | undefined) ??
                  (summary.packId as string | undefined),
                packName: summary.packName as string | undefined,
                shotIndex: typeof summary.shotIndex === 'number' ? summary.shotIndex : undefined,
                totalShots: typeof summary.totalShots === 'number' ? summary.totalShots : undefined,
                shotName: summary.shotName as string | undefined,
                shotDescription: summary.shotDescription as string | undefined,
              },
            }
          : {}),
      });
      domain.multiplayerSession?.broadcastRoomActivitySwitch({
        activityId: opts.activityId,
        mode: opts.activityId,
        trainingPackId: opts.trainingPackId,
        replayId: opts.replayId,
        config: summary,
      });
      if (typeof nextClientInput === 'boolean') {
        const wsPayload = buildHostWorkspaceBroadcastPayload({
          clientInputEnabled: nextClientInput,
        });
        if (wsPayload) {
          domain.multiplayerSession?.broadcastGlobalWorkspace?.(wsPayload);
        }
      }
    },
    broadcastGlobalWorkspace: (opts) => {
      const nextOpts = { ...(opts as Record<string, unknown> | undefined) };
      if (nextOpts.cameraSync === undefined && domain.camera) {
        const camSync = captureCameraSyncFromPort(domain.camera, true);
        if (camSync) nextOpts.cameraSync = camSync;
      }
      const payload = buildHostWorkspaceBroadcastPayload(nextOpts);
      if (!payload) return 0;
      sessionCoordinator.authoritativeServer?.setClientInputEnabled?.(
        Boolean(payload.clientInputEnabled)
      );
      return domain.multiplayerSession?.broadcastGlobalWorkspace?.(payload) ?? 0;
    },
    setClientInputEnabled: (enabled) => {
      const next = Boolean(enabled);
      syncClientInputEnabledUi(next);
      sessionCoordinator.authoritativeServer?.setClientInputEnabled?.(next);
      const payload = buildHostWorkspaceBroadcastPayload({ clientInputEnabled: next });
      if (payload) {
        domain.multiplayerSession?.broadcastGlobalWorkspace?.(payload);
      }
    },
    resetTrainingShot: (opts) => {
      const payload = opts && typeof opts === 'object' ? opts : {};
      sessionCoordinator.authoritativeServer?.resetTrainingShot?.(payload);
      const store = useAppStore.getState();
      const prev = store.onlineSession?.trainingPackSummary ?? {};
      const nextSummary = {
        ...prev,
        ...(typeof payload.trainingPackId === 'string'
          ? { trainingPackId: payload.trainingPackId }
          : {}),
        ...(typeof payload.packName === 'string' ? { packName: payload.packName } : {}),
        ...(typeof payload.shotIndex === 'number' ? { shotIndex: payload.shotIndex } : {}),
        ...(typeof payload.totalShots === 'number' ? { totalShots: payload.totalShots } : {}),
        ...(typeof payload.shotName === 'string' ? { shotName: payload.shotName } : {}),
        ...(typeof payload.shotDescription === 'string'
          ? { shotDescription: payload.shotDescription }
          : {}),
        shotResetSeq: (prev.shotResetSeq ?? 0) + 1,
      };
      store.setOnlineSession?.({ trainingPackSummary: nextSummary });
      domain.multiplayerSession?.broadcastRoomActivitySwitch?.({
        activityId: 'multiplayer_training',
        mode: 'multiplayer_training',
        trainingPackId: nextSummary.trainingPackId,
        config: nextSummary,
      });
    },
    setClockPacingMode: (pacingMode) => {
      getReconciler()?.setClockPacingMode?.(pacingMode);
    },
    setClockPacingPriority: (priority) => {
      getReconciler()?.setClockPacingPriority?.(priority);
    },
    setClockPacingParams: (params) => {
      if (params) {
        getReconciler()?.setClockPacingParams?.(params as PacingControllerParams);
      }
    },
    setInputBufferTarget: (bufferTarget) => {
      getReconciler()?.setInputBufferTarget?.(bufferTarget);
    },
    setInputBufferThresholds: (minOffset, maxOffset) => {
      getReconciler()?.setInputBufferThresholds?.(minOffset, maxOffset);
    },
    syncInitialClockPacing: (state) => {
      applyInitialClockPacingToReconciler(getReconciler(), state);
    },
  };
}
