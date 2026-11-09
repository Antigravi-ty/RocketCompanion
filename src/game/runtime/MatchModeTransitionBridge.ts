import {
  useAppStore,
  networkDiagnosticsStore,
  floatingStore,
  type RuntimeMatchPort,
} from '../runtimeUiPort.ts';
import type {
  FreeplayModeCleanupPort,
  RuntimeDomainPortOwner,
} from './GoalBarrierRuntimeBridge.ts';

export function leaveActiveBotMatchIfNeeded(target: RuntimeDomainPortOwner): void {
  if (target.botCoordinator.isBotMatch || target.match?.state?.mode === 'match') {
    target.botCoordinator.leaveBotMatch();
  }
}

export function stopActiveOnlineOrLoopbackSessionIfNeeded(target: RuntimeDomainPortOwner): void {
  const session = target.multiplayerSession;
  if (session) {
    if (session.isHosting) {
      void session.stopHosting?.();
    } else if (session.clientController || session.signalingHandler) {
      void session.leaveSession?.();
    }
  }
  const netSession = target.networkManager?.sessionCoordinator;
  if (
    netSession &&
    (netSession.authoritativeServer || netSession.networkChannel || netSession.networkReconciler)
  ) {
    netSession.cleanupOnlineSession?.();
    void netSession.stopOnlineServer?.({ rebindLoopback: false });
  }
}

export function transitionToTrainingMode(
  target: RuntimeDomainPortOwner,
  modeId: string,
  reEnterIfActive = false
): void {
  stopActiveOnlineOrLoopbackSessionIfNeeded(target);
  leaveActiveBotMatchIfNeeded(target);
  const alreadyActive = target.modeManager?.activeMode?.id === modeId;
  if (target.match) {
    target.match.leave();
    target.match.state.mode = modeId;
    target.match.state.countdown = 0;
  }
  if (reEnterIfActive && alreadyActive) {
    target.modeManager?.activeMode?.onEnter?.();
  } else {
    target.modeManager?.setMode?.(modeId);
  }
  target.domEventManager.syncPausedAndInputState();
}

export function transitionToExpMultiBotsMode(target: RuntimeDomainPortOwner): void {
  stopActiveOnlineOrLoopbackSessionIfNeeded(target);
  leaveActiveBotMatchIfNeeded(target);
  const activeMode = target.modeManager?.activeMode;
  const alreadyExpMode = activeMode?.id === 'exp-multi-bots';
  if (target.match) {
    target.match.start();
    target.match.state.mode = 'exp-multi-bots';
  }
  if (alreadyExpMode) {
    void activeMode?.applyRosterAndStartMatch?.();
  } else {
    target.modeManager?.setMode?.('exp-multi-bots');
  }
  target.domEventManager.syncPausedAndInputState();
}

export type LocalMatchModeTransitionSlice = Pick<
  RuntimeMatchPort,
  | 'getMatchMode'
  | 'isOnlineOrServerActive'
  | 'isBotMatch'
  | 'getPlayerCarIndex'
  | 'getMatchDurationSeconds'
  | 'syncPausedAndInputState'
  | 'handleOverlayChange'
  | 'openMainMenu'
  | 'startExpMultiBots'
  | 'startKickoffTraining'
  | 'startReplayViewer'
  | 'startStaticTrainingPack'
  | 'startDevTestLab'
  | 'restartMatch'
  | 'returnToFreeplay'
  | 'resetKickoff'
>;

export function createMatchModeTransitionBridge(
  target: RuntimeDomainPortOwner
): LocalMatchModeTransitionSlice {
  return {
    getMatchMode: () => target.match?.state?.mode || 'freeplay',
    isOnlineOrServerActive: () =>
      Boolean(
        target.networkManager.sessionCoordinator.authoritativeServer ||
        target.networkManager.sessionCoordinator.networkReconciler
      ),
    isBotMatch: () => target.botCoordinator.isBotMatch,
    getPlayerCarIndex: () => target.playerCarIndex ?? 0,
    getMatchDurationSeconds: () => target.matchDurationSeconds || 300,
    syncPausedAndInputState: (graphicsOverride = null) => {
      target.domEventManager.syncPausedAndInputState(graphicsOverride);
    },
    handleOverlayChange: (overlayName, isOpen) => {
      target.domEventManager.handleOverlayChange(overlayName, isOpen);
    },
    openMainMenu: () => {
      if (target.gameUI) {
        target.gameUI.openMenu('main-menu');
      } else {
        useAppStore.getState().openMenu('main-menu');
      }
    },
    startExpMultiBots: () => {
      transitionToExpMultiBotsMode(target);
    },
    startKickoffTraining: () => {
      transitionToTrainingMode(target, 'kickoff-training', false);
    },
    startReplayViewer: () => {
      transitionToTrainingMode(target, 'replay-viewer', false);
    },
    startStaticTrainingPack: () => {
      transitionToTrainingMode(target, 'static-training-pack', true);
    },
    startDevTestLab: () => {
      transitionToTrainingMode(target, 'dev-test-lab', true);
    },
    restartMatch: async () => {
      const currentMode = target.match?.state?.mode || useAppStore.getState().matchMode;
      if (currentMode === 'exp-multi-bots') {
        const activeMode = target.modeManager?.getActiveMode?.();
        if (activeMode && typeof activeMode.applyRosterAndStartMatch === 'function') {
          await activeMode.applyRosterAndStartMatch();
        } else {
          transitionToExpMultiBotsMode(target);
        }
        useAppStore.setState({ matchMode: 'exp-multi-bots' });
        return;
      }
      const duration = target.matchDurationSeconds || 300;
      await target.botCoordinator.startBotMatch(undefined, duration);
      useAppStore.setState({ matchMode: 'match' });
    },
    returnToFreeplay: (unlimitedBoost) => {
      floatingStore.closeWindow('subsystem-isolation-lab');
      floatingStore.closeWindow('experimental-multi-bots');
      floatingStore.closeWindow('experimental-bot-pack');
      floatingStore.closeWindow('kickoff-training-tuner');
      floatingStore.closeWindow('replay-viewer');
      floatingStore.closeWindow('replay-to-rcs-importer');

      const probe = target.networkManager.diagnosticsProbe;
      if (probe.diagnosticsFleetController?.enabled) {
        void probe.toggleDiagnosticTestFleet(false);
        networkDiagnosticsStore.syncZeroGFleetState(false);
      }
      if (probe.lobbyGhostMode) {
        probe.configureLobbyGhostMode(false);
        networkDiagnosticsStore?.setLobbyGhostMode?.(false);
      }

      const session = target.multiplayerSession;
      if (session) {
        if (session.isHosting) {
          void session.stopHosting?.();
        } else if (session.clientController || session.signalingHandler) {
          void session.leaveSession?.();
        }
      }
      const netSession = target.networkManager.sessionCoordinator;
      if (netSession.authoritativeServer || netSession.networkChannel) {
        void netSession.stopOnlineServer({ rebindLoopback: false });
      }
      leaveActiveBotMatchIfNeeded(target);
      target.match?.leave();
      target.modeManager?.setMode?.('freeplay');

      const freeplayMode = target.modeManager?.modes?.get?.('freeplay') as
        FreeplayModeCleanupPort | undefined;
      freeplayMode?.resetToCleanFreeplay?.();

      target.physics?.setUnlimitedBoost?.(unlimitedBoost);
      if (target.trainingOptions) {
        target.trainingOptions.boostOption = unlimitedBoost ? 'unlimited' : 'standard';
      }
      target.resetKickoff();
      target.domEventManager.syncPausedAndInputState();
    },
    resetKickoff: () => {
      target.resetKickoff();
    },
  };
}
