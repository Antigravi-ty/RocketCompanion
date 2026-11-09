import { useAppStore } from '../../ui-core/stores/appStore.ts';
import { floatingStore } from '../../ui-core/stores/floatingStore.ts';
import { REPLAY_VIEWER_PRESET } from '../../ui-core/stores/floatingPresets.ts';
import {
  SUBSYSTEM_ISOLATION_LAB_PRESET,
  EXPERIMENTAL_MULTI_BOTS_PRESET,
  EXPERIMENTAL_BOT_PACK_PRESET,
  KICKOFF_TRAINING_TUNER_PRESET,
  REPLAY_TO_RCS_IMPORTER_PRESET,
} from '../../ui-core/stores/devFloatingPresets.ts';
import { dialogue } from '../../ui-core/compounds/dialogue/dialogueStore.ts';
import { useExperimentalMultiBotsStore } from '../../ui-core/stores/experimentalMultiBotsStore.ts';
import {
  exportRetainedMatchReplayFile,
  type RetainedMatchReplay,
} from '../../replay/ReplayFileExporter.ts';
import type { AppState } from '../../ui-core/stores/appStoreTypes.ts';
import type { GameRuntimeUiBridgePort } from '../../game/runtimeUiPort.ts';

interface RuntimeWithExportableActiveMode {
  modeManager?: {
    getActiveMode?: () => {
      exportRecentHighlightReplay?: (
        durationSeconds?: number,
        suppressNotification?: boolean
      ) => RetainedMatchReplay | null;
    } | null;
  };
}

export function createModeBridgeHandlers(
  runtimePort: GameRuntimeUiBridgePort
): Partial<AppState['bridge']> {
  const { matchPort, replayPort } = runtimePort;
  return {
    onResume: () => {
      matchPort.syncPausedAndInputState();
    },
    onOverlayChange: (isOpen: boolean) => {
      matchPort.handleOverlayChange('esc-menu', isOpen);
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
              matchPort.openMainMenu();
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
      useAppStore.getState().closeMenu();
      floatingStore.closeWindow(SUBSYSTEM_ISOLATION_LAB_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_MULTI_BOTS_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_BOT_PACK_PRESET.id);
      const resolvedBot = botId === 'nexto' ? 'nexto' : 'necto';
      const resolvedTeamSize =
        teamSize || useExperimentalMultiBotsStore.getState().exhibitionTeamSize || 'standard';
      useExperimentalMultiBotsStore
        .getState()
        .configureExhibitionMatch(resolvedBot, durationSeconds, resolvedTeamSize);
      matchPort.startExpMultiBots();
      useAppStore.setState({ matchMode: 'exp-multi-bots' });
    },
    onStartKickoffTraining: () => {
      useAppStore.getState().closeMenu();
      const snap = floatingStore.getSnapshot();
      const hasWindow =
        snap.windows.some((w) => w.id === KICKOFF_TRAINING_TUNER_PRESET.id) ||
        snap.activeFlight?.preset?.id === KICKOFF_TRAINING_TUNER_PRESET.id;
      if (!hasWindow) {
        const w = KICKOFF_TRAINING_TUNER_PRESET.width ?? 460;
        const posX = typeof window !== 'undefined' ? Math.max(20, window.innerWidth - w - 28) : 40;
        floatingStore.spawnWindow({
          ...KICKOFF_TRAINING_TUNER_PRESET,
          position: { x: posX, y: 68 },
          startMinimized: true,
        });
      }
      matchPort.startKickoffTraining();
      useAppStore.setState({ matchMode: 'kickoff-training' });
    },
    onStartReplayViewer: () => {
      useAppStore.getState().closeMenu();
      floatingStore.closeWindow(SUBSYSTEM_ISOLATION_LAB_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_MULTI_BOTS_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_BOT_PACK_PRESET.id);
      floatingStore.closeWindow(KICKOFF_TRAINING_TUNER_PRESET.id);
      floatingStore.closeWindow(REPLAY_TO_RCS_IMPORTER_PRESET.id);
      replayPort.prepareForReplayViewerEntry();
      floatingStore.spawnWindow({
        ...REPLAY_VIEWER_PRESET,
        startMinimized: false,
      });
      matchPort.startReplayViewer();
      useAppStore.setState({ matchMode: 'replay-viewer' });
    },
    onStartReplayToRcsImporter: () => {
      useAppStore.getState().closeMenu();
      floatingStore.closeWindow(SUBSYSTEM_ISOLATION_LAB_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_MULTI_BOTS_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_BOT_PACK_PRESET.id);
      floatingStore.closeWindow(KICKOFF_TRAINING_TUNER_PRESET.id);
      floatingStore.closeWindow(REPLAY_VIEWER_PRESET.id);
      replayPort.prepareForReplayViewerEntry();
      const snap = floatingStore.getSnapshot();
      const exists =
        snap.windows.some((w) => w.id === REPLAY_TO_RCS_IMPORTER_PRESET.id) ||
        snap.activeFlight?.preset?.id === REPLAY_TO_RCS_IMPORTER_PRESET.id;
      if (!exists) {
        floatingStore.spawnWindow({
          ...REPLAY_TO_RCS_IMPORTER_PRESET,
          startMinimized: false,
        });
      }
      matchPort.startReplayViewer();
      useAppStore.setState({ matchMode: 'replay-viewer' });
    },
    onStartStaticTrainingPack: () => {
      useAppStore.setState({ matchMode: 'static-training-pack' });
      try {
        matchPort.startStaticTrainingPack();
      } catch (err) {
        console.error('[runtimeBridgeAdapter] Error starting static-training-pack:', err);
      }
    },
    onStartDevTestLab: () => {
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
      matchPort.startDevTestLab();
      useAppStore.setState({ matchMode: 'dev-test-lab' });
    },
    onStartExpMultiBots: () => {
      useAppStore.getState().closeMenu();
      floatingStore.setOpacity(70);
      const expState = useExperimentalMultiBotsStore.getState();
      const isBotpackShowcase = expState.activeSubMode === 'botpack';
      const targetPreset = isBotpackShowcase
        ? EXPERIMENTAL_BOT_PACK_PRESET
        : EXPERIMENTAL_MULTI_BOTS_PRESET;
      const otherPreset = isBotpackShowcase
        ? EXPERIMENTAL_MULTI_BOTS_PRESET
        : EXPERIMENTAL_BOT_PACK_PRESET;
      floatingStore.closeWindow(otherPreset.id);

      const snap = floatingStore.getSnapshot();
      const exists =
        snap.windows.some((w) => w.id === targetPreset.id) ||
        snap.activeFlight?.preset?.id === targetPreset.id;
      if (!exists) {
        floatingStore.spawnWindow({
          ...targetPreset,
          startMinimized: true,
        });
      }
      useExperimentalMultiBotsStore.getState().setIsExhibitionMode(false);
      matchPort.startExpMultiBots();
      useAppStore.setState({ matchMode: 'exp-multi-bots' });
    },
    onRestartMatch: async () => {
      useAppStore.getState().closeMenu();
      await matchPort.restartMatch();
    },
    onReturnToFreeplay: () => {
      useAppStore.getState().closeMenu();
      floatingStore.closeWindow(SUBSYSTEM_ISOLATION_LAB_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_MULTI_BOTS_PRESET.id);
      floatingStore.closeWindow(EXPERIMENTAL_BOT_PACK_PRESET.id);
      const unlimited = useAppStore.getState().gameplay.unlimitedBoost;
      matchPort.returnToFreeplay(unlimited);
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
    onExportRecentTrainingReplay: async (durationSeconds = 60): Promise<boolean> => {
      try {
        const driverRuntime =
          typeof window !== 'undefined'
            ? (
                window as unknown as {
                  __rcScenarioDriver?: { runtime?: RuntimeWithExportableActiveMode };
                }
              ).__rcScenarioDriver?.runtime
            : undefined;
        const activeMode = driverRuntime?.modeManager?.getActiveMode?.();
        if (typeof activeMode?.exportRecentHighlightReplay === 'function') {
          const retained = activeMode.exportRecentHighlightReplay(durationSeconds, false);
          if (retained) {
            await exportRetainedMatchReplayFile(retained);
            return true;
          }
        }
        const exportedFrames = replayPort.retainAndExportStandaloneClientReplay(false);
        return exportedFrames > 0;
      } catch (err) {
        console.error('[runtimeModeBridgeHandlers] Failed to export training replay:', err);
        return false;
      }
    },
  };
}
