import { CLIENT_COMMAND_TYPES } from '../../physics/RocketSimConstants.ts';
import {
  packLoadoutCommandParam1,
  packLoadoutCommandParam2,
} from '../../ui-core/config/vehicleConstants.ts';
import { useAppStore } from '../runtimeUiPort.ts';
import type { ReconcilerSignalCoordinator } from './ReconcilerSignalCoordinator.ts';
import type { OnlineRosterSyncCoordinator } from './OnlineRosterSyncCoordinator.ts';
import type { NetworkDiagnosticsProbe } from './NetworkDiagnosticsProbe.ts';
import type { OnlineSessionCoordinator } from './OnlineSessionCoordinator.ts';
import {
  assembleNetworkCoordinators,
  type RuntimeNetworkHostPort,
} from './RuntimeNetworkPortAssembler.ts';
import type { LocalPlayerLoadoutSyncRequest } from './RuntimeLoadoutCoordinator.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';

export type { RuntimeNetworkHostPort };

export class RuntimeNetworkManager {
  readonly context: RuntimeNetworkHostPort;
  readonly diagnosticsProbe!: NetworkDiagnosticsProbe;
  readonly sessionCoordinator!: OnlineSessionCoordinator;
  readonly rosterSyncCoordinator!: OnlineRosterSyncCoordinator;
  readonly signalCoordinator!: ReconcilerSignalCoordinator;
  diagnosticDumpMaxFrames = 36000;
  diagnosticDumpPauseOnOverflow = true;

  constructor(context: RuntimeNetworkHostPort) {
    this.context = context;
    Object.assign(this, assembleNetworkCoordinators(this, context));
  }

  isLobbyDualWorldActive(
    reconciler: PredictionReconciler | null = this.sessionCoordinator.networkReconciler
  ): boolean {
    const ctx = this.context;
    return Boolean(
      reconciler?.lobbyDualWorldMode ||
      ctx.arena?.isLobbyMode ||
      (ctx.match?.state?.mode !== 'match' && ctx.match?.state?.phase === 'lobby')
    );
  }

  syncLocalPlayerLoadout(request: LocalPlayerLoadoutSyncRequest): void {
    const playerCarIndex = this.context.playerCarIndex ?? 0;
    const server = this.sessionCoordinator.authoritativeServer;
    const reconciler = this.sessionCoordinator.networkReconciler;
    const channel = this.sessionCoordinator.networkChannel;

    if (request.updateVisualPreset && reconciler) {
      reconciler.setCarVisualPreset?.(playerCarIndex, request.visualId);
    }

    if (request.carIndex === playerCarIndex) {
      server?.setLoadout?.('host', request.visualId, request.colorSlotId, request.hitboxId, {
        paintFinish: request.paintFinish,
        boostVisual: request.boostVisual,
        boostAudio: request.boostAudio,
      });
      reconciler?.controlMessenger.enqueueClientCommand(
        CLIENT_COMMAND_TYPES.CMD_SET_LOADOUT,
        packLoadoutCommandParam1(request.visualId, request.hitboxId),
        packLoadoutCommandParam2(
          request.colorSlotId,
          request.paintFinish,
          request.boostVisual,
          request.boostAudio
        )
      );
    }

    if (request.broadcastColorHex && channel?.sendColorChange) {
      try {
        channel.sendColorChange(request.colorSlotId, request.broadcastColorHex, request.carIndex);
      } catch (err) {
        console.error('[GameRuntime] Failed to broadcast color change over network channel:', err);
      }
    }
  }

  forceStartOnlineMatch(durationSeconds = 300): void {
    this.rosterSyncCoordinator.dismissHostLobbyOngoingNotification();
    const server = this.sessionCoordinator.authoritativeServer;
    const reconciler = this.sessionCoordinator.networkReconciler;
    if (server) {
      this.diagnosticsProbe.despawnDiagnosticTestFleet();
      server.forceStartMatch(durationSeconds);
    } else if (reconciler) {
      reconciler.controlMessenger.enqueueClientCommand(
        CLIENT_COMMAND_TYPES.CMD_READY_ACK,
        1,
        durationSeconds
      );
    }
  }

  setOnlineGameMode(gameMode = '3v3', durationSeconds: number | null = null): void {
    const resolvedDuration =
      durationSeconds ?? useAppStore?.getState?.()?.onlineSession?.matchDurationSeconds ?? 300;
    this.sessionCoordinator.authoritativeServer?.setGameMode(gameMode, resolvedDuration);
    useAppStore?.getState?.()?.setOnlineSession({ gameMode });
    this.rosterSyncCoordinator.syncHostLobbyOngoingNotification();
  }

  setOnlineMatchDuration(durationSeconds = 300): void {
    const cleanDuration = Math.max(0, Number(durationSeconds) || 0);
    const currentGameMode = useAppStore?.getState?.()?.onlineSession?.gameMode || '1v1';
    this.sessionCoordinator.authoritativeServer?.setGameMode(currentGameMode, cleanDuration);
    useAppStore?.getState?.()?.setOnlineSession({ matchDurationSeconds: cleanDuration });
    this.rosterSyncCoordinator.syncHostLobbyOngoingNotification();
  }

  setOnlineBotFillMode(botFillMode = 'no_bots', botType?: string): void {
    this.sessionCoordinator.authoritativeServer?.setBotFillMode?.(botFillMode, botType);
    useAppStore?.getState?.()?.setOnlineSession({ botFillMode });
  }

  addOnlineBot(
    team: number | null = 1,
    botName: string | null = null,
    visualId: string | null = 'octane',
    botType?: string
  ): void {
    this.sessionCoordinator.authoritativeServer?.addBotPlayer?.(
      team ?? 1,
      botName,
      visualId ?? 'octane',
      botType
    );
  }

  setClientReady(ready = true): void {
    this.sessionCoordinator.networkReconciler?.controlMessenger.enqueueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_READY_ACK,
      ready ? 1 : 0,
      0
    );
  }

  voteSkipReplay(): void {
    this.sessionCoordinator.networkReconciler?.controlMessenger.enqueueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_VOTE_SKIP_REPLAY,
      1,
      0
    );
  }

  voteRematch(ready = true): void {
    this.sessionCoordinator.networkReconciler?.controlMessenger.enqueueClientCommand(
      CLIENT_COMMAND_TYPES.CMD_VOTE_REMATCH,
      ready ? 1 : 0,
      0
    );
  }

  switchOnlineRoleOrTeam(role = 'player', team = 0): void {
    const roleCode = role === 'spectator' ? 2 : 0;
    const server = this.sessionCoordinator.authoritativeServer;
    const reconciler = this.sessionCoordinator.networkReconciler;
    if (server) {
      server.switchRoleTeam('host', role, team);
    } else if (reconciler) {
      reconciler.controlMessenger.enqueueClientCommand(
        CLIENT_COMMAND_TYPES.CMD_SWITCH_ROLE_TEAM,
        roleCode,
        team
      );
    }
  }
}
