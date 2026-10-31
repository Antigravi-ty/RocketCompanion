import {
  networkDiagnosticsStore,
  type DiagnosticBufferSnapshot,
  type DiagnosticDumpExportOptions,
} from '../../ui-core/stores/networkDiagnosticsStore';
import {
  globalPacingTelemetryRecorder,
  MAX_TELEMETRY_TICKS,
} from '../../ui-core/stores/pacingTelemetryRecorder.js';
import { buildZipArchiveBytes } from '../../ui-core/stores/pacingTelemetryExporter.js';
import { serializeRCReplayBinaryContainer } from '../../replay/container/RCReplayBinaryEncoder.js';
import { RC_REPLAY_STATE_INPUT_STRIDE } from '../../replay/container/RCReplayBinarySchema.js';
import {
  retainCompletedMatchReplayAndNotify,
  exportRetainedMatchReplayFile,
} from '../../replay/ReplayFileExporter.js';

function triggerZipDownload(bytes: Uint8Array, filename: string): boolean {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') return false;
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

export function buildDiagnosticBufferSnapshot(rt: any): Partial<DiagnosticBufferSnapshot> {
  if (!rt) return {};
  const isOnlineSession = Boolean(rt.arena?.isOnlineMode || rt.networkReconciler);
  const isLobby = Boolean(rt.arena?.isLobbyMode || rt.match?.state === 'LOBBY');
  const matchState = String(rt.match?.state || 'FREEPLAY');
  const isHosting = Boolean(rt.authoritativeServer);
  const clientFrames = Number(rt.physics?.getReplayFrameCount?.() ?? 0);
  const clientRecordingActive = Boolean(rt.physics?.getReplayRecordingActive?.() ?? false);
  const clientOverflowPaused = Boolean(rt._clientReplayOverflowPaused);
  const maxClientFrames = Number(rt.diagnosticDumpMaxFrames) || 36000;
  const autoPauseOnOverflow =
    rt.diagnosticDumpPauseOnOverflow !== undefined
      ? Boolean(rt.diagnosticDumpPauseOnOverflow)
      : true;
  const recorder = rt.networkReconciler?.telemetryRecorder || globalPacingTelemetryRecorder;
  const telemetryTicks = Number(recorder?.count ?? 0);
  const summary = recorder?.getSummaryStats?.() || {};
  const serverFrames = Number(rt.authoritativeServer?.hostReplayRingBuffer?.size ?? 0);
  const activeCarMask = Number(rt.physics?.getActiveCarMask?.() ?? 0);

  return {
    isOnlineSession,
    isLobby,
    matchState,
    isHosting,
    localPlayerCarIndex: rt.playerCarIndex ?? 0,
    activeCarMask,
    clientFrames,
    clientRecordingActive,
    clientOverflowPaused,
    maxClientFrames,
    autoPauseOnOverflow,
    telemetryTicks,
    maxTelemetryTicks: MAX_TELEMETRY_TICKS,
    starvationCount: summary.starvationCount ?? 0,
    hardResyncCount: summary.hardResyncCount ?? 0,
    serverFrames,
  };
}

export function syncRuntimeNetworkDiagnostics(rt: any): void {
  if (!rt) return;
  if (typeof rt.diagnosticDumpMaxFrames !== 'number' || rt.diagnosticDumpMaxFrames <= 0) {
    rt.diagnosticDumpMaxFrames = 36000;
  }
  if (rt.diagnosticDumpPauseOnOverflow === undefined) {
    rt.diagnosticDumpPauseOnOverflow = true;
  }

  networkDiagnosticsStore.registerBridge({
    onToggleZeroGFleet: async (enabled: boolean, anchorMode: string) => {
      await rt.setZeroGFleetDiagnosticsEnabled?.(enabled, anchorMode);
    },
    onSampleZeroGFleetTelemetry: () => {
      return rt.sampleDiagnosticFleetTelemetry?.() || [];
    },
    onSetZeroGAnchorMode: async (anchorMode: string) => {
      await rt.setZeroGAnchorMode?.(anchorMode);
    },
    onSetObservationTarget: (targetCarIndex: number) => {
      rt.setDiagnosticObservationTarget?.(targetCarIndex);
    },
    onSetTestCarAudioEnabled: (enabled: boolean) => {
      rt.setTestCarAudioEnabled?.(enabled);
    },
    onSetLobbyGhostMode: (enabled: boolean) => {
      rt.setLobbyGhostModeEnabled?.(enabled);
    },
    onDumpNextPacket: () => {
      if (rt.networkReconciler?.dumpNextPacket) rt.networkReconciler.dumpNextPacket();
      else if (rt.dumpNetworkDiagnostics) rt.dumpNetworkDiagnostics();
    },
    onDumpLatestPacket: () => {
      if (rt.networkReconciler?.dumpPacketDiagnostics) rt.networkReconciler.dumpPacketDiagnostics();
      else if (rt.dumpNetworkDiagnostics) rt.dumpNetworkDiagnostics();
    },
    onTriggerBurstDrop: (count: number) => {
      if (rt.networkChannel?.forceDropNextInput) rt.networkChannel.forceDropNextInput(count);
      else if (rt.triggerBurstDrop) rt.triggerBurstDrop(count);
    },
    onSetDiagnosticMaxCapacity: (frames: number) => {
      rt.diagnosticDumpMaxFrames = frames;
      const clientFrames = Number(rt.physics?.getReplayFrameCount?.() ?? 0);
      if (clientFrames < frames && rt._clientReplayOverflowPaused) {
        rt._clientReplayOverflowPaused = false;
        rt.physics?.setReplayRecordingActive?.(true);
      }
      networkDiagnosticsStore.updateDiagnosticBuffers(buildDiagnosticBufferSnapshot(rt));
    },
    onSetDiagnosticAutoPauseOverflow: (enabled: boolean) => {
      rt.diagnosticDumpPauseOnOverflow = enabled;
      networkDiagnosticsStore.updateDiagnosticBuffers(buildDiagnosticBufferSnapshot(rt));
    },
    onToggleDiagnosticRecordingPause: (recordingActive: boolean) => {
      rt._clientReplayOverflowPaused = false;
      rt.physics?.setReplayRecordingActive?.(recordingActive);
      networkDiagnosticsStore.updateDiagnosticBuffers(buildDiagnosticBufferSnapshot(rt));
    },
    onClearDiagnosticBuffers: () => {
      rt._clientReplayOverflowPaused = false;
      rt.physics?.clearReplayBuffer?.();
      const isOnline = Boolean(rt.arena?.isOnlineMode || rt.networkReconciler);
      if (isOnline) {
        rt.physics?.setReplayRecordingActive?.(true);
      }
      rt.authoritativeServer?.hostReplayRingBuffer?.clear?.();
      if (rt.networkReconciler?.metrics) {
        rt.networkReconciler.metrics.mispredictions = 0;
        rt.networkReconciler.metrics.totalCorrections = 0;
        rt.networkReconciler.metrics.lastCorrectionDelta = 0;
        rt.networkReconciler.metrics.maxCorrectionDelta = 0;
      }
      const recorder = rt.networkReconciler?.telemetryRecorder || globalPacingTelemetryRecorder;
      recorder?.reset?.({
        mode: rt.networkReconciler?.clockPacingMode || 'csts',
        priority: rt.networkReconciler?.clockPacingPriority || 'balanced',
        params: rt.networkReconciler?.clockPacingParams || {},
      });
      networkDiagnosticsStore.updateDiagnosticBuffers(buildDiagnosticBufferSnapshot(rt));
    },
    onExportUnifiedDiagnosticDump: (options: DiagnosticDumpExportOptions) => {
      const snap = buildDiagnosticBufferSnapshot(rt);
      const isOnlineSession = Boolean(snap.isOnlineSession);
      const isLobby = Boolean(snap.isLobby);
      const isHosting = Boolean(snap.isHosting);
      const matchState = String(snap.matchState || 'FREEPLAY');
      const clientFrames = Number(snap.clientFrames ?? 0);
      const serverFrames = Number(snap.serverFrames ?? 0);
      const activeCarMask = Number(snap.activeCarMask ?? 0);
      const activeSlots: number[] = [];
      for (let i = 0; i < 8; i++) {
        if ((activeCarMask & (1 << i)) !== 0) activeSlots.push(i);
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const phaseSlug = !isOnlineSession ? 'offline' : isLobby ? 'lobby' : 'match';
      const entries: Array<{ name: string; data: Uint8Array | string }> = [];

      let exportedClientFrames = 0;
      if (options.includeClientReplay && rt.physics && clientFrames > 0) {
        try {
          const tracks = rt.physics.extractWasmReplayTracks?.();
          if (tracks && tracks.frameCount > 0) {
            const containerBytes = serializeRCReplayBinaryContainer({
              ...tracks,
              mode: isLobby ? 'online-lobby-client' : 'online-match-client',
              blueScore: rt.score?.blue ?? 0,
              orangeScore: rt.score?.orange ?? 0,
              roster: rt.lastOnlineRoster || [],
              loadouts: rt.lastOnlineRoster || [],
              createdAtIso: new Date().toISOString(),
            });
            entries.push({
              name: `client-presentation-${phaseSlug}.rcreplay`,
              data: containerBytes,
            });
            exportedClientFrames = tracks.frameCount;
          }
        } catch (err) {
          console.warn('[runtimeNetworkDiagnosticsBridge] Failed to serialize client replay:', err);
        }
      }

      const recorder = rt.networkReconciler?.telemetryRecorder || globalPacingTelemetryRecorder;
      let exportedTelemetryTicks = 0;
      if (options.includeReconcileTelemetry && recorder && recorder.count > 0) {
        try {
          const metaObj =
            typeof recorder.toMetadataObject === 'function'
              ? recorder.toMetadataObject()
              : {
                  schemaVersion: 'rc-network-telemetry-v2',
                  exportedAt: new Date().toISOString(),
                  summary: recorder.getSummaryStats?.() || {},
                };
          const csvText = recorder.toCsvString?.() || '';
          entries.push({
            name: 'reconcile-pacing-metadata.json',
            data: JSON.stringify(metaObj, null, 2),
          });
          if (csvText) {
            entries.push({
              name: 'reconcile-pacing-telemetry.csv',
              data: csvText,
            });
          }
          exportedTelemetryTicks = recorder.count;
        } catch (err) {
          console.warn('[runtimeNetworkDiagnosticsBridge] Failed to serialize telemetry:', err);
        }
      }

      const serverRingBuffer = rt.authoritativeServer?.hostReplayRingBuffer;
      let exportedServerFrames = 0;
      if (options.includeServerReplay && serverRingBuffer && serverRingBuffer.size > 0) {
        try {
          const rawSlots = serverRingBuffer.getRecentFrames?.() || [];
          if (rawSlots.length > 0) {
            const serverContainerBytes = serializeRCReplayBinaryContainer({
              slots: rawSlots,
              mode: isLobby ? 'online-lobby-server-auth' : 'online-match-server-auth',
              blueScore: rt.score?.blue ?? 0,
              orangeScore: rt.score?.orange ?? 0,
              roster: rt.lastOnlineRoster || [],
              loadouts: rt.lastOnlineRoster || [],
              createdAtIso: new Date().toISOString(),
            });
            entries.push({
              name: `server-authoritative-${phaseSlug}.rcreplay`,
              data: serverContainerBytes,
            });
            exportedServerFrames = rawSlots.length;
          }
        } catch (err) {
          console.warn('[runtimeNetworkDiagnosticsBridge] Failed to serialize server replay:', err);
        }
      }

      const metrics = networkDiagnosticsStore.getSnapshot().metrics;
      const clientMb = ((clientFrames * RC_REPLAY_STATE_INPUT_STRIDE) / (1024 * 1024)).toFixed(2);
      const manifest = {
        schemaVersion: 'rc-diagnostic-dump-v1',
        exportedAtIso: new Date().toISOString(),
        session: {
          isOnlineSession,
          isHosting,
          isLobby,
          matchState,
          localPlayerCarIndex: rt.playerCarIndex ?? 0,
          activeCarMask,
          activeCarSlots: activeSlots,
          scores: {
            blue: rt.score?.blue ?? 0,
            orange: rt.score?.orange ?? 0,
          },
          roster: rt.lastOnlineRoster || [],
        },
        buffers: {
          clientPresentationReplay: {
            included: options.includeClientReplay,
            recordedFrames: clientFrames,
            exportedFrames: exportedClientFrames,
            maxCapacityFrames: snap.maxClientFrames ?? 36000,
            overflowPaused: Boolean(snap.clientOverflowPaused),
            autoPauseOnOverflow: Boolean(snap.autoPauseOnOverflow),
            estimatedSizeMb: Number(clientMb),
          },
          reconcileAndPacingTelemetry: {
            included: options.includeReconcileTelemetry,
            recordedTicks: Number(snap.telemetryTicks ?? 0),
            exportedTicks: exportedTelemetryTicks,
            maxCapacityTicks: MAX_TELEMETRY_TICKS,
            totalCorrections: metrics.corrections,
            mispredictions: metrics.mispredictions,
            lastReconcileErrorUu: metrics.lastErrorUu,
            maxReconcileErrorUu: metrics.maxErrorUu,
            starvationCount: snap.starvationCount ?? 0,
            hardResyncCount: snap.hardResyncCount ?? 0,
            rttMs: metrics.rttMs,
            jitterMs: metrics.jitterMs,
            inputBufferDepth: metrics.inputBufferDepth,
          },
          serverAuthoritativeReplay: {
            included: options.includeServerReplay,
            available: isHosting,
            recordedFrames: serverFrames,
            exportedFrames: exportedServerFrames,
          },
        },
      };

      entries.unshift({
        name: 'diagnostic-manifest.json',
        data: JSON.stringify(manifest, null, 2),
      });

      const zipBytes = buildZipArchiveBytes(entries);
      const filename = `rc-diagnostic-dump-${phaseSlug}-${stamp}.zip`;
      triggerZipDownload(zipBytes, filename);
      const kb = (zipBytes.byteLength / 1024).toFixed(1);
      return `Exported ${filename} (${kb} KB · C:${exportedClientFrames}f, T:${exportedTelemetryTicks}t, S:${exportedServerFrames}f)`;
    },
    onExportStandaloneClientReplay: () => {
      const snap = buildDiagnosticBufferSnapshot(rt);
      const clientFrames = Number(snap.clientFrames ?? 0);
      if (!rt.physics || clientFrames <= 0) {
        return 'No client presentation replay frames recorded yet.';
      }
      const isLobby = Boolean(snap.isLobby);
      retainCompletedMatchReplayAndNotify({
        engine: rt.physics,
        mode: isLobby ? 'online-lobby-dump' : 'online-match-dump',
        blueScore: rt.score?.blue ?? 0,
        orangeScore: rt.score?.orange ?? 0,
        durationSeconds: rt.match?.state?.duration ?? 300,
        arenaPreset: rt.physics?.getArenaPreset?.() ?? 0,
        roster: rt.lastOnlineRoster || [],
        loadouts: rt.lastOnlineRoster || [],
        suppressNotification: true,
      });
      exportRetainedMatchReplayFile();
      const durationSec = (clientFrames / 120).toFixed(1);
      return `Exported standalone Client Replay (${clientFrames} frames / ${durationSec}s).`;
    },
  });

  networkDiagnosticsStore.setSession(
    rt.networkReconciler || null,
    rt.networkChannel || null
  );
  networkDiagnosticsStore.updateDiagnosticBuffers(buildDiagnosticBufferSnapshot(rt));
}
