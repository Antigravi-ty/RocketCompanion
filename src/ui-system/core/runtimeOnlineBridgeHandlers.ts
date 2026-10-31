import { useAppStore } from '../../ui-core/stores/appStore';
import { hudStore } from '../../ui-core/stores/hudStore';

export function createOnlineBridgeHandlers(gameRuntime: any) {
  hudStore.getState().setReplayState?.({
    onReplaySeekNormalized: (progress01: number) => {
      const ctrl = gameRuntime?.replayTimelineController;
      if (!ctrl) return;
      ctrl.isPersistent = true;
      ctrl.seekToNormalized(progress01, gameRuntime.interpolator);
      hudStore.getState().setReplayState({
        replayProgress: ctrl.progress,
        replayFrameIndex: ctrl.currentFrameIndex,
        replayTotalFrames: ctrl.getTotalRecordedFrames(),
        replayPaused: ctrl.isPaused,
        replayPersistent: true,
      });
    },
    onReplayTogglePause: () => {
      const ctrl = gameRuntime?.replayTimelineController;
      if (!ctrl) return;
      const paused = ctrl.togglePause();
      hudStore.getState().setReplayState({
        replayPaused: paused,
        replayPersistent: ctrl.isPersistent,
      });
    },
    onReplayCycleSpeed: () => {
      const ctrl = gameRuntime?.replayTimelineController;
      if (!ctrl) return;
      const speed = ctrl.cyclePlaybackSpeed();
      hudStore.getState().setReplayState({ replaySpeed: speed });
    }
  });

  return {
    onHostOnlineWarmup: async (opts: any) => {
      if (!gameRuntime) return false;
      try {
        const session = gameRuntime.multiplayerSession;
        const roomConfig = {
          roomType: opts.roomType || 'match',
          gameMode: opts.gameMode || '2v2',
          botFillMode: opts.botFillMode || 'auto_fill',
          durationSeconds: opts.durationSeconds ?? 300,
          lobbyMode: opts.lobbyMode !== undefined ? Boolean(opts.lobbyMode) : true,
        };
        if (session) {
          session.playerName = opts.playerName;
          await session.startHosting(opts.roomId, opts.password || '', roomConfig);
          return true;
        }
        if (typeof gameRuntime.hostOnlineServer === 'function') {
          await gameRuntime.hostOnlineServer({
            roomId: opts.roomId,
            password: opts.password || '',
            playerName: opts.playerName,
            ...roomConfig,
          });
          return true;
        }
        return false;
      } catch (e) {
        console.error('[mountGameUI] Error hosting online warmup', e);
        return false;
      }
    },
    onJoinOnlineWarmup: async (opts: any) => {
      if (!gameRuntime) return false;
      try {
        const session = gameRuntime.multiplayerSession;
        if (session) {
          session.playerName = opts.playerName;
          return await session.joinRoom(opts.roomId, opts.password || '', 10000);
        }
        if (typeof gameRuntime.joinOnlineServer === 'function') {
          await gameRuntime.joinOnlineServer({
            roomId: opts.roomId,
            password: opts.password || '',
            playerName: opts.playerName,
          });
          return true;
        }
        return false;
      } catch (e) {
        console.error('[mountGameUI] Error joining online warmup', e);
        return false;
      }
    },
    onApprovePendingPeer: (peerId: string) => {
      gameRuntime?.multiplayerSession?.approvePendingPeer?.(peerId);
    },
    onDeclinePendingPeer: (peerId: string) => {
      gameRuntime?.multiplayerSession?.declinePendingPeer?.(peerId);
    },
    onLeaveOnlineServer: async () => {
      if (!gameRuntime) return;
      try {
        const session = gameRuntime.multiplayerSession;
        if (session) {
          if (session.isHosting) {
            await session.stopHosting?.();
          } else {
            await session.leaveSession?.();
          }
        }
        if (typeof gameRuntime.stopOnlineServer === 'function') {
          await gameRuntime.stopOnlineServer();
        }
        useAppStore.getState().setMatchMode('freeplay');
        useAppStore.getState().setOnlineSession({
          isHosting: false,
          roomId: '',
          password: '',
          pairingCode: undefined,
          activeRelayLabel: undefined,
          pendingPairingRequests: [],
          signalingConnected: false,
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
      if (!gameRuntime) return;
      try {
        await gameRuntime.returnOnlineMatchToLobby?.();
      } catch (e) {
        console.error('[mountGameUI] Error returning online match to lobby', e);
      }
    },
    onPauseOnlineMatch: (pause: boolean, resumeCountdownSeconds = 3) => {
      if (!gameRuntime?.authoritativeServer) return;
      if (pause) {
        gameRuntime.authoritativeServer.pauseMatch?.(true);
      } else {
        gameRuntime.authoritativeServer.resumeMatchWithCountdown?.(resumeCountdownSeconds);
      }
    },
    onRemovePlayer: async (carIndex: number) => {
      if (!gameRuntime) return;
      if (typeof gameRuntime.removeRemotePlayer === 'function') {
        await gameRuntime.removeRemotePlayer(carIndex);
      }
    },
    onReconnectSignaling: async () => {
      if (!gameRuntime) return;
      try {
        const session = gameRuntime.multiplayerSession;
        if (session) {
          if (session.isHosting) {
            session.initHostSignaling?.();
          } else if (session.joinRoomId) {
            await session.joinRoom?.(session.joinRoomId, session.joinPassword);
          }
        }
        useAppStore.getState().setOnlineSession({ signalingConnected: true });
      } catch (e) {
        console.error('[mountGameUI] Error reconnecting signaling', e);
      }
    },
    onResetBall: () => {
      if (!gameRuntime) return;
      gameRuntime.resetKickoff?.();
    },
    onForceStartOnlineMatch: (durationSeconds = 90) => {
      if (!gameRuntime) return;
      useAppStore.getState().closeMenu();
      gameRuntime.forceStartOnlineMatch?.(durationSeconds);
    },
    onSetOnlineGameMode: (gameMode: '1v1' | '2v2' | '3v3') => {
      if (!gameRuntime) return;
      gameRuntime.setOnlineGameMode?.(gameMode);
    },
    onSetOnlineMatchDuration: (durationSeconds: number) => {
      if (!gameRuntime) return;
      useAppStore.getState().setOnlineSession({ matchDurationSeconds: durationSeconds });
      gameRuntime.setOnlineMatchDuration?.(durationSeconds);
    },
    onSetOnlineBotFillMode: (botFillMode: 'no_bots' | 'auto_fill' | 'bots_vs_humans' | 'custom') => {
      if (!gameRuntime) return;
      useAppStore.getState().setOnlineSession({ botFillMode });
      gameRuntime.setOnlineBotFillMode?.(botFillMode);
    },
    onAddOnlineBot: (team?: number) => {
      if (!gameRuntime) return;
      gameRuntime.addOnlineBot?.(team ?? null);
    },
    onSetClientReady: (ready: boolean) => {
      if (!gameRuntime) return;
      useAppStore.getState().setOnlineSession({ isReady: ready });
      gameRuntime.setClientReady?.(ready);
    },
    onVoteSkipReplay: () => {
      if (!gameRuntime) return;
      const modeName = gameRuntime.match?.state?.mode;
      if (
        modeName === 'exp-multi-bots' ||
        modeName === 'freeplay' ||
        modeName === 'replay-viewer' ||
        modeName === 'static-training-pack'
      ) {
        gameRuntime.modeManager?.getActiveMode()?.skipGoalReplay?.();
        return;
      }
      gameRuntime.voteSkipReplay?.();
    },
    onVoteRematch: (ready: boolean) => {
      if (!gameRuntime) return;
      if (gameRuntime.match?.state?.mode === 'exp-multi-bots') {
        gameRuntime.modeManager?.getActiveMode()?.applyRosterAndStartMatch?.();
        return;
      }
      gameRuntime.voteRematch?.(ready);
    },
    onSwitchOnlineRoleTeam: (role: 'player' | 'spectator', team: number) => {
      if (!gameRuntime) return;
      gameRuntime.switchOnlineRoleOrTeam?.(role, team);
    },
    onClockPacingModeChange: (mode: any) => {
      if (gameRuntime?.networkReconciler) {
        gameRuntime.networkReconciler.setClockPacingMode?.(mode);
      }
    },
    onClockPacingPriorityChange: (priority: any) => {
      if (gameRuntime?.networkReconciler) {
        gameRuntime.networkReconciler.setClockPacingPriority?.(priority);
      }
    },
    onClockPacingParamsChange: (params: any) => {
      if (gameRuntime?.networkReconciler) {
        gameRuntime.networkReconciler.setClockPacingParams?.(params);
      }
    },
    onInputBufferTargetChange: (target: number) => {
      if (gameRuntime?.networkReconciler) {
        gameRuntime.networkReconciler.setInputBufferTarget?.(target);
      }
    },
    onInputBufferThresholdChange: (range: [number, number]) => {
      if (gameRuntime?.networkReconciler) {
        gameRuntime.networkReconciler.setInputBufferThresholds?.(range[0], range[1]);
      }
    }
  };
}
