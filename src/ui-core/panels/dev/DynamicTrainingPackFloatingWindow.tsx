import React, { useEffect } from 'react';
import type { StandardSurfaceProps, SurfaceMeta } from '../../manifest/surfaceMetaTypes';
import { useDynamicTrainingPackStore } from '../../stores/dynamicTrainingPackStore';
import {
  decodeRcdPackFromFileBytes,
  encodeRcdPackToGzipBytes,
} from '../../config/dynamicTrainingPackCodec';
import { loadDynamicStateSession } from '../../stores/dynamicTrainingPackStorage';
import { DynamicTrainingPackManagerSection } from './dynamic-training/DynamicTrainingPackManagerSection';
import { DynamicTrainingShotEditorCard } from './dynamic-training/DynamicTrainingShotEditorCard';

export const SURFACE_META: SurfaceMeta = {
  id: 'dynamic-training-pack',
  title: 'Dynamic Training Pack (.rcd)',
  subtitle: 'Capture 4s replay state sessions, configure per-car takeover, and practice.',
  icon: 'UsersRoundCollaboration',
  layer: 'floating-dev',
  menuGroup: 'sandboxes',
  hideFooter: true,
  defaultSizing: {
    width: 480,
    height: 580,
    minHeight: 240,
    mode: 'adaptive',
  },
};

export interface DynamicTrainingPackFloatingWindowProps extends StandardSurfaceProps {
  active?: boolean;
}

export const DynamicTrainingPackFloatingWindow: React.FC<DynamicTrainingPackFloatingWindowProps> =
  React.memo(({ isLight = false }) => {
    const {
      isLoaded,
      packs,
      sessionSummaries,
      activePackUuid,
      activeShotId,
      playPhase,
      countdownRemainingSec,
      remainingTimeoutSec,
      lastResult,
      shotStats,
      statusMessage,
      initialize,
      selectPack,
      selectShot,
      createPack,
      updateShotConfig,
      updateShotPerCarTakeover,
      moveShotToPack,
      duplicateShotToPack,
      deleteShotWithSessionCheck,
      exportPackJson,
      importPackJson,
      setLivePlaybackState,
      runtimeHandlers,
    } = useDynamicTrainingPackStore();

    useEffect(() => {
      if (!isLoaded) void initialize();
    }, [isLoaded, initialize]);

    const activePack = packs.find((p) => p.metadata.uuid === activePackUuid) ?? packs[0] ?? null;
    const activeShot =
      activePack?.shots.find((s) => s.id === activeShotId) ?? activePack?.shots[0] ?? null;
    const sessionSummary = activeShot
      ? (sessionSummaries.find((s) => s.sessionId === activeShot.sessionId) ?? null)
      : null;

    const handleExportPack = async (uuid: string) => {
      const targetPack = packs.find((p) => p.metadata.uuid === uuid);
      if (!targetPack) return;
      const sessionMap = new Map<string, NonNullable<Awaited<ReturnType<typeof loadDynamicStateSession>>>>();
      for (const shot of targetPack.shots) {
        if (sessionMap.has(shot.sessionId)) continue;
        const sess = await loadDynamicStateSession(shot.sessionId);
        if (sess) sessionMap.set(shot.sessionId, sess);
      }
      const gzBytes = await encodeRcdPackToGzipBytes(targetPack, sessionMap);
      const blob = new Blob([gzBytes as BlobPart], { type: 'application/gzip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${targetPack.metadata.title || 'dynamic-pack'}.RCDPack`;
      a.click();
      URL.revokeObjectURL(url);
      setLivePlaybackState({ statusMessage: 'Exported .RCDPack' });
    };

    const handleImportPack = async (rawOrBytes: ArrayBuffer | string) => {
      try {
        let imported;
        if (typeof rawOrBytes === 'string') {
          imported = await importPackJson(rawOrBytes);
        } else {
          const decoded = await decodeRcdPackFromFileBytes(rawOrBytes);
          imported = await importPackJson(
            JSON.stringify({
              format: 'RCDPack',
              version: 1,
              category: 'dynamic-training-pack',
              metadata: decoded.pack.metadata,
              shots: decoded.pack.shots,
              sessions: decoded.sessions,
            })
          );
        }
        setLivePlaybackState({ statusMessage: `Imported ${imported.metadata.title}` });
      } catch (err) {
        setLivePlaybackState({
          statusMessage: err instanceof Error ? err.message : 'Failed to import .RCDPack',
        });
      }
    };

    return (
      <div className="flex flex-col gap-2.5 text-xs select-none">
        <DynamicTrainingPackManagerSection
          isLight={isLight}
          packs={packs}
          activePack={activePack}
          activeShotId={activeShot?.id ?? null}
          onSelectPack={(uuid) => selectPack(uuid)}
          onSelectShot={(shotId) => selectShot(shotId)}
          onCreatePack={(title) => void createPack(title)}
          onExportPack={(uuid) => void handleExportPack(uuid)}
          onImportPack={(rawOrBytes) => void handleImportPack(rawOrBytes)}
          onMoveShot={(targetUuid, shotId) =>
            activePack && void moveShotToPack(activePack.metadata.uuid, targetUuid, shotId)
          }
          onDuplicateShot={(targetUuid, shotId) =>
            activePack && void duplicateShotToPack(activePack.metadata.uuid, targetUuid, shotId)
          }
          onDeleteShot={(shotId, deleteSess) =>
            activePack &&
            void deleteShotWithSessionCheck(activePack.metadata.uuid, shotId, deleteSess)
          }
        />

        {activePack && activeShot ? (
          <DynamicTrainingShotEditorCard
            isLight={isLight}
            pack={activePack}
            shot={activeShot}
            sessionSummary={sessionSummary}
            stats={shotStats[activeShot.id]}
            playPhase={playPhase}
            countdownRemainingSec={countdownRemainingSec}
            remainingTimeoutSec={remainingTimeoutSec}
            lastResult={lastResult}
            onUpdateShot={(patch) =>
              void updateShotConfig(activePack.metadata.uuid, activeShot.id, patch)
            }
            onUpdatePerCar={(slot, mode, modelId) =>
              void updateShotPerCarTakeover(activePack.metadata.uuid, activeShot.id, slot, {
                mode,
                ...(modelId ? { modelId } : {}),
              })
            }
            onPlayShot={() =>
              void runtimeHandlers.onPlayShot?.(activePack.metadata.uuid, activeShot.id)
            }
            onRestartShot={() => runtimeHandlers.onRestartShot?.()}
            onStopSession={() => runtimeHandlers.onStopSession?.()}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-neutral-600/50 p-4 text-center text-[11px] opacity-75">
            No shots in this pack yet. Open Replay Viewer (or Replay to RLRCReplay Importer) and
            click "Put 4s Pre-Roll into Dynamic Training Pack (.RCDPack)" at any frame, or import a
            .RCDPack.
          </div>
        )}

        {statusMessage && (
          <div className="text-[11px] text-cyan-400 font-medium truncate">{statusMessage}</div>
        )}
      </div>
    );
  });
DynamicTrainingPackFloatingWindow.displayName = 'DynamicTrainingPackFloatingWindow';

export default DynamicTrainingPackFloatingWindow;
