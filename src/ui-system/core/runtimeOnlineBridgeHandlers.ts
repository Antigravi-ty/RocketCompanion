import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore } from '../../ui-core/stores/hudStore';
import { signalingProfileStore } from '../../ui-core/stores/signalingProfileStore';
import { credentialBundleManager } from '../../network/transport/CredentialBundleManager.ts';
import { testAllSignalingRelays } from '../../network/transport/diagnostics/signalingDiagnosticsProbe.ts';
import { setSignalingRelayMatchPolicy } from '../../network/transport/SignalingRelayLifecyclePolicy.ts';
import { ensureCloudProfileSyncBridge } from './runtimeProfileSyncBridge.ts';
import { ensureDevSignalingLabBridge } from './runtimeSignalingLabBridge.ts';
import type {
  GameRuntimeUiBridgePort,
  HostOnlineWarmupPortOptions,
  JoinOnlineWarmupPortOptions,
} from '../../game/runtimeUiPort.ts';
import type {
  ClockPacingMode,
  ClockPacingParams,
  ClockPacingPriority,
} from '../../ui-core/config/clockPacingConfig';

let signalingProfileUnsubscribe: (() => void) | null = null;

export function ensureSignalingProfileBridge(): void {
  ensureCloudProfileSyncBridge();
  ensureDevSignalingLabBridge();
  if (!signalingProfileUnsubscribe) {
    signalingProfileUnsubscribe = credentialBundleManager.subscribe((status) => {
      signalingProfileStore.getState().syncStatus(status);
    });
  }

  signalingProfileStore.getState().registerBridge({
    onImportBundle: async (rawContent: string, pinCode: string) => {
      await credentialBundleManager.importEncryptedBundle(rawContent, pinCode);
    },
    onExportBundle: async (options) => {
      const exported = await credentialBundleManager.exportActiveBundle(options);
      return {
        suggestedFileName: exported.suggestedFileName,
        serializedJson: exported.serializedJson,
        pinCode: exported.pinCode,
        windowMinutes: exported.windowMinutes,
        expiresAtMs: Date.now() + exported.expiresInSeconds * 1000,
      };
    },
    onClearBundle: () => {
      credentialBundleManager.clearImportedProfile();
    },
    onSaveCustomRelay: (payload) => {
      if (!payload || !payload.url.trim()) {
        credentialBundleManager.setCustomRelayConfig(null);
      } else {
        credentialBundleManager.setCustomRelayConfig({
          url: payload.url,
          username: payload.username,
          password: payload.password,
        });
      }
    },
    onSetRelayMatchPolicy: (policy) => {
      setSignalingRelayMatchPolicy(policy);
    },
    onVerifyRelays: async () => {
      const results = await testAllSignalingRelays(4000);
      return results.map((r) => ({
        id: r.id,
        label: r.label,
        protocol: (r.protocol === 'ws'
          ? 'ws'
          : r.protocol === 'supabase'
          ? 'supabase'
          : 'mqtt') as 'mqtt' | 'ws' | 'supabase',
        ok: r.ok,
        rttMs: r.rttMs,
        error: r.error ?? undefined,
      }));
    },
  });
}

export function createOnlineBridgeHandlers(runtimePort: GameRuntimeUiBridgePort) {
  const { matchPort, replayPort } = runtimePort;
  ensureSignalingProfileBridge();
  hudStore.getState().setReplayState?.({
    onReplaySeekNormalized: (progress01: number) => {
      const sought = replayPort.seekReplayNormalized(progress01);
      if (!sought) return;
      hudStore.getState().setReplayState({
        replayProgress: sought.progress,
        replayFrameIndex: sought.frameIndex,
        replayTotalFrames: sought.totalFrames,
        replayPaused: sought.isPaused,
        replayPersistent: true,
      });
    },
    onReplayTogglePause: () => {
      const toggled = replayPort.toggleReplayPause();
      if (!toggled) return;
      hudStore.getState().setReplayState({
        replayPaused: toggled.isPaused,
        replayPersistent: toggled.isPersistent,
      });
    },
    onReplayCycleSpeed: () => {
      const speed = replayPort.cycleReplaySpeed();
      if (speed === null) return;
      hudStore.getState().setReplayState({ replaySpeed: speed });
    },
  });

  return {
    onHostOnlineWarmup: async (opts: HostOnlineWarmupPortOptions) => {
      try {
        return await matchPort.hostOnlineWarmup(opts);
      } catch (e) {
        console.error('[mountGameUI] Error hosting online warmup', e);
        return false;
      }
    },
    onJoinOnlineWarmup: async (opts: JoinOnlineWarmupPortOptions) => {
      try {
        return await matchPort.joinOnlineWarmup(opts);
      } catch (e) {
        console.error('[mountGameUI] Error joining online warmup', e);
        return false;
      }
    },
    onApprovePendingPeer: (peerId: string) => {
      matchPort.approvePendingPeer(peerId);
    },
    onDeclinePendingPeer: (peerId: string) => {
      matchPort.declinePendingPeer(peerId);
    },
    onLeaveOnlineServer: async () => {
      try {
        await matchPort.leaveOnlineServer();
        useAppStore.getState().setMatchMode('freeplay');
        useAppStore.getState().setOnlineSession({
          isHosting: false,
          roomId: '',
          password: '',
          pairingCode: undefined,
          activeRelayLabel: undefined,
          pendingPairingRequests: [],
          signalingConnected: false,
          signalingHealthLevel: 'offline',
          connectedPeers: [],
          roomType: 'match',
          gameMode: '3v3',
          botFillMode: 'auto_fill',
          matchDurationSeconds: 90,
          isReady: false,
        });
      } catch (e) {
        console.error('[mountGameUI] Error stopping online server', e);
      }
    },
    onReturnToOnlineLobby: async () => {
      try {
        await matchPort.returnToOnlineLobby();
      } catch (e) {
        console.error('[mountGameUI] Error returning online match to lobby', e);
      }
    },
    onPauseOnlineMatch: (pause: boolean, resumeCountdownSeconds = 3) => {
      matchPort.pauseOnlineMatch(pause, resumeCountdownSeconds);
    },
    onRemovePlayer: async (carIndex: number) => {
      await matchPort.removeRemotePlayer(carIndex);
    },
    onReconnectSignaling: async () => {
      try {
        await matchPort.reconnectSignaling();
      } catch (e) {
        console.error('[mountGameUI] Error reconnecting signaling', e);
      }
    },
    onResetBall: () => {
      matchPort.resetKickoff();
    },
    onForceStartOnlineMatch: (durationSeconds = 90) => {
      useAppStore.getState().closeMenu();
      matchPort.forceStartOnlineMatch(durationSeconds);
    },
    onSetOnlineGameMode: (gameMode: '1v1' | '2v2' | '3v3') => {
      matchPort.setOnlineGameMode(gameMode);
    },
    onSetOnlineMatchDuration: (durationSeconds: number) => {
      useAppStore.getState().setOnlineSession({ matchDurationSeconds: durationSeconds });
      matchPort.setOnlineMatchDuration(durationSeconds);
    },
    onSetOnlineBotFillMode: (
      botFillMode: 'no_bots' | 'auto_fill' | 'bots_vs_humans' | 'custom',
    ) => {
      useAppStore.getState().setOnlineSession({ botFillMode });
      matchPort.setOnlineBotFillMode(botFillMode);
    },
    onAddOnlineBot: (team?: number) => {
      matchPort.addOnlineBot(team ?? null);
    },
    onSetClientReady: (ready: boolean) => {
      useAppStore.getState().setOnlineSession({ isReady: ready });
      matchPort.setClientReady(ready);
    },
    onVoteSkipReplay: () => {
      replayPort.voteOrSkipReplay();
    },
    onVoteRematch: (ready: boolean) => {
      matchPort.voteRematch(ready);
    },
    onSwitchOnlineRoleTeam: (role: 'player' | 'spectator', team: number) => {
      matchPort.switchOnlineRoleOrTeam(role, team);
    },
    onClockPacingModeChange: (mode: ClockPacingMode) => {
      matchPort.setClockPacingMode(mode);
    },
    onClockPacingPriorityChange: (priority: ClockPacingPriority) => {
      matchPort.setClockPacingPriority(priority);
    },
    onClockPacingParamsChange: (params: ClockPacingParams) => {
      matchPort.setClockPacingParams(params as unknown as Record<string, unknown>);
    },
    onInputBufferTargetChange: (target: number) => {
      matchPort.setInputBufferTarget(target);
    },
    onInputBufferThresholdChange: (range: [number, number]) => {
      matchPort.setInputBufferThresholds(range[0], range[1]);
    },
  };
}
