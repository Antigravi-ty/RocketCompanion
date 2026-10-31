import { useAppStore } from '../../ui-core/stores/appStore';
import { floatingStore } from '../../ui-core/stores/floatingStore';
import {
  SUBSYSTEM_ISOLATION_LAB_PRESET,
  EXPERIMENTAL_MULTI_BOTS_PRESET,
  KICKOFF_TRAINING_PRESET,
  REPLAY_VIEWER_PRESET,
} from '../../ui-core/stores/floatingPresets';
import { dialogue } from '../../ui-core/compounds/dialogue/dialogueStore';
import { useExperimentalMultiBotsStore } from '../../ui-core/stores/experimentalMultiBotsStore';
import { networkDiagnosticsStore } from '../../ui-core/stores/networkDiagnosticsStore';
import type { AppState } from '../../ui-core/stores/appStoreTypes';

export function createModeBridgeHandlers(gameRuntime: any): Partial<AppState['bridge']> {
  return {
    onResume: () => {
      if (gameRuntime) {
        gameRuntime.syncPausedAndInputState?.();
      }
    },
    onOverlayChange: (isOpen: boolean) => {
      if (gameRuntime.handleOverlayChange) {
        gameRuntime.handleOverlayChange('esc-menu', isOpen);
      }
    },
    onOpenGarage: () => {
      useAppStore.getState().openMenu('garage');
    },
    onOpenSettings: () => {
      useAppStore.getState().openMenu('settings');
    },
    onOpenPlay: () => {
      useAppStore.getState().openMenu('play');
    },
    onRequestTouchOpenMenuConfirm: () => {
      if (dialogue.getCount() > 0) return;
      dialogue.show({
        id: 'touch-open-menu-confirm',
        title: 'Open Game Menu?',
        content:
          'Touch testing mode (?touch=1) is active. Open the menu to configure Host / Client room or Model Input Agent?',
        buttons: [
          { label: 'No', variant: 'outline' },
          {
            label: 'Yes',
            variant: 'primary',
            onClick: () => {
              if (gameRuntime?.gameUI) {
                gameRuntime.gameUI.openMenu('main-menu');
              } else {
                useAppStore.getState().openMenu('main-menu');
              }
            },
          },
        ],
      });
    },
    onStartMatch: async (
      botId: string,
      durationSeconds = 90,
      teamSize?: 'standard' | 'double' | 'solo'
    ) => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      const resolvedBot = botId === 'nexto' ? 'nexto' : 'necto';
      const resolvedTeamSize =
        teamSize || useExperimentalMultiBotsStore.getState().exhibitionTeamSize || 'standard';
      useExperimentalMultiBotsStore
        .getState()
        .configureExhibitionMatch(resolvedBot, durationSeconds, resolvedTeamSize);
      if (typeof gameRuntime.startExpMultiBots === 'function') {
        gameRuntime.startExpMultiBots();
      } else if (gameRuntime.match?.state) {
        gameRuntime.match.state.mode = 'exp-multi-bots';
        gameRuntime.modeManager?.setMode?.('exp-multi-bots');
      }
      useAppStore.setState({ matchMode: 'exp-multi-bots' });
    },
    onStartKickoffTraining: () => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      const snap = floatingStore.getSnapshot();
      const hasWindow =
        snap.windows.some((w) => w.id === KICKOFF_TRAINING_PRESET.id) ||
        snap.activeFlight?.preset?.id === KICKOFF_TRAINING_PRESET.id;
      if (!hasWindow) {
        const w = KICKOFF_TRAINING_PRESET.width ?? 460;
        const posX = typeof window !== 'undefined' ? Math.max(20, window.innerWidth - w - 28) : 40;
        floatingStore.spawnWindow({
          ...KICKOFF_TRAINING_PRESET,
          position: { x: posX, y: 68 },
          startMinimized: true,
        });
      }
      if (typeof gameRuntime.startKickoffTraining === 'function') {
        gameRuntime.startKickoffTraining();
      } else if (gameRuntime.match?.state) {
        gameRuntime.match.state.mode = 'kickoff-training';
        gameRuntime.modeManager?.setMode?.('kickoff-training');
      }
      useAppStore.setState({ matchMode: 'kickoff-training' });
    },
    onStartReplayViewer: () => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      floatingStore.closeWindow(SUBSYSTEM_ISOLATION_LAB_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_MULTI_BOTS_PRESET.id);
      floatingStore.closeWindow(KICKOFF_TRAINING_PRESET.id);
      const freeplayMode = gameRuntime.modeManager?.modes?.get?.('freeplay');
      if (freeplayMode?.nameTagTunerController?.isActive) {
        freeplayMode.nameTagTunerController.exitTunerArena();
      }
      if (freeplayMode?.isReplayActive) {
        freeplayMode.exitDirectorPatternPreview?.();
      }
      if (freeplayMode?.rewinderController?.isBlockingLivePhysics) {
        freeplayMode.rewinderController.clearBuffer?.();
      }
      floatingStore.spawnWindow({
        ...REPLAY_VIEWER_PRESET,
        startMinimized: false,
      });
      if (typeof gameRuntime.startReplayViewer === 'function') {
        gameRuntime.startReplayViewer();
      } else if (gameRuntime.match?.state) {
        gameRuntime.match.state.mode = 'replay-viewer';
        gameRuntime.modeManager?.setMode?.('replay-viewer');
      }
      useAppStore.setState({ matchMode: 'replay-viewer' });
    },
    onStartStaticTrainingPack: () => {
      useAppStore.setState({ matchMode: 'static-training-pack' });
      if (!gameRuntime) return;
      try {
        if (typeof gameRuntime.startStaticTrainingPack === 'function') {
          gameRuntime.startStaticTrainingPack();
        } else if (gameRuntime.match?.state) {
          gameRuntime.match.state.mode = 'static-training-pack';
          gameRuntime.modeManager?.setMode?.('static-training-pack');
        }
      } catch (err) {
        console.error('[runtimeBridgeAdapter] Error starting static-training-pack:', err);
      }
    },
    onStartDevTestLab: () => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      floatingStore.setOpacity(70);
      const snap = floatingStore.getSnapshot();
      const exists =
        snap.windows.some((w) => w.id === SUBSYSTEM_ISOLATION_LAB_PRESET.id) ||
        snap.activeFlight?.preset?.id === SUBSYSTEM_ISOLATION_LAB_PRESET.id;
      if (!exists) {
        floatingStore.spawnWindow({
          ...SUBSYSTEM_ISOLATION_LAB_PRESET,
          startMinimized: true,
        });
      }
      if (typeof gameRuntime.startDevTestLab === 'function') {
        gameRuntime.startDevTestLab();
      } else if (gameRuntime.match?.state) {
        gameRuntime.match.state.mode = 'dev-test-lab';
        gameRuntime.modeManager?.setMode?.('dev-test-lab');
      }
      useAppStore.setState({ matchMode: 'dev-test-lab' });
    },
    onStartExpMultiBots: () => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      floatingStore.setOpacity(70);
      const snap = floatingStore.getSnapshot();
      const exists =
        snap.windows.some((w) => w.id === EXPERIMENTAL_MULTI_BOTS_PRESET.id) ||
        snap.activeFlight?.preset?.id === EXPERIMENTAL_MULTI_BOTS_PRESET.id;
      if (!exists) {
        floatingStore.spawnWindow({
          ...EXPERIMENTAL_MULTI_BOTS_PRESET,
          startMinimized: true,
        });
      }
      useExperimentalMultiBotsStore.getState().setIsExhibitionMode(false);
      if (typeof gameRuntime.startExpMultiBots === 'function') {
        gameRuntime.startExpMultiBots();
      } else if (gameRuntime.match?.state) {
        gameRuntime.match.state.mode = 'exp-multi-bots';
        gameRuntime.modeManager?.setMode?.('exp-multi-bots');
      }
      useAppStore.setState({ matchMode: 'exp-multi-bots' });
    },
    onRestartMatch: async () => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      const currentMode = gameRuntime.match?.state?.mode || useAppStore.getState().matchMode;
      if (currentMode === 'exp-multi-bots') {
        const activeMode = gameRuntime.modeManager?.getActiveMode?.();
        if (activeMode && typeof activeMode.applyRosterAndStartMatch === 'function') {
          await activeMode.applyRosterAndStartMatch();
        } else if (typeof gameRuntime.startExpMultiBots === 'function') {
          gameRuntime.startExpMultiBots();
        }
        useAppStore.setState({ matchMode: 'exp-multi-bots' });
        return;
      }
      if (typeof gameRuntime.startBotMatch === 'function') {
        const duration = gameRuntime.matchDurationSeconds || 300;
        await gameRuntime.startBotMatch(undefined, duration);
      } else if (gameRuntime.match) {
        gameRuntime.resetBotState?.();
        gameRuntime.match.start?.();
        gameRuntime.physics?.setUnlimitedBoost?.(false);
        gameRuntime.resetKickoff?.();
      }
      useAppStore.setState({ matchMode: 'match' });
    },
    onReturnToFreeplay: () => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      floatingStore.closeWindow(SUBSYSTEM_ISOLATION_LAB_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_MULTI_BOTS_PRESET.id);
      floatingStore.closeWindow(KICKOFF_TRAINING_PRESET.id);
      floatingStore.closeWindow(REPLAY_VIEWER_PRESET.id);

      const freeplayMode = gameRuntime.modeManager?.modes?.get?.('freeplay');
      freeplayMode?.resetToCleanFreeplay?.();

      if (gameRuntime.diagnosticsFleetController?.enabled) {
        gameRuntime.toggleDiagnosticTestFleet?.(false);
        networkDiagnosticsStore.syncZeroGFleetState(false);
      }
      if (gameRuntime.lobbyGhostMode || gameRuntime.lobbyGhostModeEnabled) {
        gameRuntime.setLobbyGhostMode?.(false);
        networkDiagnosticsStore?.setLobbyGhostMode?.(false);
      }

      const session = gameRuntime.multiplayerSession;
      if (session) {
        if (session.isHosting) {
          session.stopHosting?.();
        } else if (session.clientController || session.signalingHandler) {
          session.leaveSession?.();
        }
      }
      if (
        typeof gameRuntime.stopOnlineServer === 'function' &&
        (gameRuntime.authoritativeServer || gameRuntime.networkChannel)
      ) {
        gameRuntime.stopOnlineServer();
      }
      if (typeof gameRuntime.leaveBotMatch === 'function') {
        gameRuntime.leaveBotMatch();
      } else if (gameRuntime.match) {
        gameRuntime.resetBotState?.();
        gameRuntime.match.leave?.();
      }
      const unlimited = useAppStore.getState().gameplay.unlimitedBoost;
      gameRuntime.physics?.setUnlimitedBoost?.(unlimited);
      if (gameRuntime.trainingOptions) {
        gameRuntime.trainingOptions.boostOption = unlimited ? 'unlimited' : 'standard';
      }
      if (gameRuntime.match?.state) {
        gameRuntime.match.state.mode = 'freeplay';
        gameRuntime.match.state.phase = 'playing';
        gameRuntime.match.state.paused = false;
      }
      gameRuntime.modeManager?.setMode?.('freeplay');
      gameRuntime.resetKickoff?.();
      gameRuntime.syncPausedAndInputState?.();
      useAppStore.setState({ matchMode: 'freeplay', isFreeCam: false });
      useAppStore.getState().setOnlineSession({
        isHosting: false,
        roomId: '',
        signalingConnected: false,
        connectedPeers: [],
        roomType: 'warmup',
        isReady: false,
      });
    },
  };
}
