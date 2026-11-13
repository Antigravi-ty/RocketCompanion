import { useAppStore } from '../../ui-core/stores/appStore.ts';
import { floatingStore } from '../../ui-core/stores/floatingStore.ts';
import { DYNAMIC_TRAINING_PACK_PRESET } from '../../ui-core/stores/devFloatingPresets.ts';
import { useDynamicTrainingPackStore } from '../../ui-core/stores/dynamicTrainingPackStore.ts';
import { loadDynamicStateSession } from '../../ui-core/stores/dynamicTrainingPackStorage.ts';
import { useReplayToRcsImporterStore } from '../../ui-core/stores/replayToRcsImporterStore.ts';
import { useReplayViewerStore } from '../../ui-core/stores/replayViewerStore.ts';
import { quickNotification } from '../../ui-core/stores/quickNotificationStore.ts';
import type { GameRuntimeUiBridgePort } from '../../game/runtimeUiPort.ts';
import type { DynamicTrainingMode } from '../../game/modes/dynamic-training/DynamicTrainingMode.ts';
import type { DynamicTrainingStateSession } from '../../ui-core/config/dynamicTrainingPackTypes.ts';
import type { RLRCReplaySessionController } from '../../replay/rlrc/runtime/RLRCReplaySessionController.ts';

interface RuntimeDynamicBridgeOwner {
  modeManager?: {
    modes?: Map<string, unknown>;
    setMode?: (modeId: string) => void;
  } | null;
  match?: {
    state?: { mode?: string } | null;
  } | null;
  rlrcReplaySession?: RLRCReplaySessionController | null;
}

export function bindDynamicTrainingBridge(
  runtimePort: GameRuntimeUiBridgePort | null | undefined
): void {
  const owner = runtimePort as unknown as RuntimeDynamicBridgeOwner | null | undefined;

  const getDynamicMode = (): DynamicTrainingMode | null => {
    const mode = owner?.modeManager?.modes?.get('dynamic-training-pack');
    return (mode as DynamicTrainingMode | undefined) ?? null;
  };

  const saveExtractedSessionAndOpenPack = async (
    session: DynamicTrainingStateSession | null,
    emptyWarning: string
  ): Promise<void> => {
    if (!session) {
      quickNotification.warning(emptyWarning);
      return;
    }
    await useDynamicTrainingPackStore.getState().initialize();
    const { pack, shot } = await useDynamicTrainingPackStore
      .getState()
      .saveCaptureSessionIntoPack(session);
    floatingStore.spawnWindow({ ...DYNAMIC_TRAINING_PACK_PRESET, startMinimized: false });
    useDynamicTrainingPackStore.getState().setLivePlaybackState({
      statusMessage: `Captured "${shot.name}" into ${pack.metadata.title}`,
    });
    quickNotification.success(`Captured 4s pre-roll into "${pack.metadata.title}"`);
  };

  const dynMode = getDynamicMode();
  if (dynMode) {
    dynMode.setCallbacks({
      onPhaseChange: (phase, countdownSec) => {
        useDynamicTrainingPackStore.getState().setLivePlaybackState({
          playPhase: phase,
          countdownRemainingSec: countdownSec,
        });
      },
      onTimerTick: (remainingTimeoutSec) => {
        useDynamicTrainingPackStore.getState().setLivePlaybackState({ remainingTimeoutSec });
      },
      onOutcome: (shotId, outcome) => {
        void useDynamicTrainingPackStore.getState().recordShotOutcome(shotId, outcome);
      },
    });
  }

  useReplayViewerStore.getState().setRuntimeHandlers({
    onPutIntoDynamicTrainingPack: async (options) => {
      const freeplay = owner?.modeManager?.modes?.get('freeplay') as
        | {
            standaloneReplayViewer?: {
              extractCurrentDynamicSession?: (opts?: {
                interveneFrame?: number;
                originEndFrame?: number;
              }) => DynamicTrainingStateSession | null;
            } | null;
          }
        | undefined;
      const session =
        freeplay?.standaloneReplayViewer?.extractCurrentDynamicSession?.(options) ?? null;
      await saveExtractedSessionAndOpenPack(
        session,
        'Load an .RCReplay file in Replay Viewer before capturing into Dynamic Training Pack.'
      );
    },
  });

  useReplayToRcsImporterStore.getState().setRuntimeHandlers({
    onPutIntoDynamicTrainingPack: async (options) => {
      const session =
        (
          owner?.rlrcReplaySession as
            | {
                extractCurrentDynamicSession?: (opts?: {
                  interveneFrame?: number;
                  originEndFrame?: number;
                }) => DynamicTrainingStateSession | null;
              }
            | null
            | undefined
        )?.extractCurrentDynamicSession?.(options) ?? null;
      await saveExtractedSessionAndOpenPack(
        session,
        'Load a .replay file in Replay to RLRCReplay Importer before capturing into Dynamic Training Pack.'
      );
    },
  });

  useDynamicTrainingPackStore.getState().setRuntimeHandlers({
    onPlayShot: async (packUuid, shotId) => {
      const store = useDynamicTrainingPackStore.getState();
      const pack = store.packs.find((p) => p.metadata.uuid === packUuid);
      const shot = pack?.shots.find((s) => s.id === shotId);
      if (!shot) return;
      const session = await loadDynamicStateSession(shot.sessionId);
      if (!session) {
        store.setLivePlaybackState({ statusMessage: 'Missing StateSession for shot' });
        return;
      }
      useAppStore.getState().closeMenu();
      useAppStore.setState({ matchMode: 'dynamic-training-pack' as never });
      if (owner?.match?.state) owner.match.state.mode = 'dynamic-training-pack';
      owner?.modeManager?.setMode?.('dynamic-training-pack');
      const mode = getDynamicMode();
      if (!mode) {
        store.setLivePlaybackState({ statusMessage: 'DynamicTrainingMode not registered' });
        return;
      }
      mode.startShot(shot, session);
    },
    onRestartShot: () => {
      getDynamicMode()?.restartCurrentShot();
    },
    onStopSession: () => {
      getDynamicMode()?.stopShot();
      useDynamicTrainingPackStore.getState().setLivePlaybackState({
        playPhase: 'idle',
        lastResult: null,
      });
    },
  });
}
