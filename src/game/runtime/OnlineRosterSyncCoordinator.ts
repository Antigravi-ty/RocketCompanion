/**
 * OnlineRosterSyncCoordinator.ts
 * Autonomous stateful OnlineRosterSyncCoordinator owning roster snapshot state,
 * participant team mappings, and remote peer vehicle lifecycle synchronization.
 */

import { CAR_COLOR_SLOTS } from '../../ui-core/config/vehicleConstants';
import {
  setNameTagRuntimeState,
  useAppStore,
  useQuickNotificationStore,
  type OnlinePeerEntryPort,
} from '../runtimeUiPort.ts';
import { gameAudio } from '../../audio/GameAudioEngineFacade.ts';
import type { ArenaWorld } from '../../entities/ArenaWorld.ts';
import type { EntityManager } from '../../entities/EntityManager.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { PhysicsStateInterpolator } from '../../physics/PhysicsStateInterpolator.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { AuthoritativeServerHost } from '../../network/server/AuthoritativeServerHost.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import type { MultiplayerSessionManager } from '../../network/transport/MultiplayerSessionManager.ts';

export const HOST_LOBBY_ONGOING_NOTIFICATION_ID = 'host-lobby-players';

export interface OnlineRosterPlayerEntry {
  entityId: number;
  sessionId?: string;
  name?: string;
  visualId?: string;
  hitboxId?: string | null;
  team?: number;
  colorSlot?: number;
  paintFinish?: string;
  boostVisual?: string;
  boostAudio?: string;
  isBot?: boolean;
  ready?: boolean;
  pingMs?: number;
  [key: string]: unknown;
}

export interface OnlineRosterSnapshotPayload {
  players: OnlineRosterPlayerEntry[];
  gameMode?: '1v1' | '2v2' | '3v3' | string;
  botFillMode?: string;
  durationSeconds?: number;
  [key: string]: unknown;
}

export interface RemotePeerChannel {
  carIndex?: number;
  visualId?: string;
  hitboxId?: string | null;
  colorSlot?: number;
  paintFinish?: string;
  boostVisual?: string;
  boostAudio?: string;
  measuredRttMs?: number;
  rttMs?: number;
  peerId?: string | null;
  pairingCode?: string | null;
  send?: (payload: string | Uint8Array | ArrayBuffer) => void;
  close?: () => void;
  destroy?: () => void;
  onColorChange?: ((msg: { carIndex?: number; hex: string }) => void) | null;
  onDiagnosticFleetToggle?: ((enabled: boolean, anchorMode?: string) => void) | null;
}

export type RemoteTransportChannelLike = RemotePeerChannel;

export interface FlipResetVisualHandle {
  stopVisual?(): void;
}

export interface OnlineRosterSessionPort {
  readonly authoritativeServer: AuthoritativeServerHost | null;
  readonly networkReconciler: PredictionReconciler | null;
  readonly remotePeerCarMap: Map<string, number>;
  isLobbyDualWorldActive(): boolean;
}

export interface OnlineRosterWorldPort {
  readonly arena: ArenaWorld | null;
  readonly physics: RocketSimPhysicsEngine | null;
  readonly entityManager: EntityManager | null;
  readonly interpolator: PhysicsStateInterpolator | null;
  readonly match: RuntimeMatchState | null;
  readonly multiplayerSession: MultiplayerSessionManager | null;
  readonly flipResetVisuals: Map<number, FlipResetVisualHandle>;
  readonly playerCarIndex: number;
  readonly isBotMatch: boolean;
  selectedColorSlot: number | null;
  setCarColor(carIndex: number, hexColor: string, persistPreference?: boolean): void;
}

export interface OnlineRosterDiagnosticsPort {
  isDiagnosticFleetEnabled(): boolean;
  spawnDiagnosticTestFleet(options?: { anchorMode?: string }): Promise<unknown>;
  despawnDiagnosticTestFleet(): void;
}

export interface OnlineRosterSyncHostPort {
  readonly session: OnlineRosterSessionPort;
  readonly world: OnlineRosterWorldPort;
  readonly diagnostics: OnlineRosterDiagnosticsPort;
}

export function dismissHostLobbyOngoingNotification(): void {
  try {
    const notifyStore = useQuickNotificationStore?.getState?.();
    notifyStore?.dismissOngoingNotification?.(HOST_LOBBY_ONGOING_NOTIFICATION_ID);
  } catch (err) {
    console.warn(
      '[OnlineRosterSyncCoordinator] Failed to dismiss host lobby ongoing notification:',
      err,
    );
  }
}

export class OnlineRosterSyncCoordinator {
  public readonly host: OnlineRosterSyncHostPort;
  public lastRosterSnapshot: OnlineRosterSnapshotPayload | null = null;
  public readonly participantTeams = new Map<number, number>();

  constructor(host: OnlineRosterSyncHostPort) {
    this.host = host;
  }

  public resetState(): void {
    this.lastRosterSnapshot = null;
    this.participantTeams.clear();
  }

  public syncHostLobbyOngoingNotification(): void {
    const { session, world } = this.host;
    if (!session.authoritativeServer || world.isBotMatch) {
      dismissHostLobbyOngoingNotification();
      return;
    }

    const isLobby = Boolean(
      world.arena?.isLobbyMode ||
        world.match?.state?.mode !== 'match' ||
        world.match?.state?.phase === 'lobby',
    );
    if (!isLobby) {
      dismissHostLobbyOngoingNotification();
      return;
    }

    const uiOnline = useAppStore?.getState?.()?.onlineSession;
    const gameMode = uiOnline?.gameMode || '3v3';
    const maxPlayers = gameMode === '1v1' ? 2 : gameMode === '2v2' ? 4 : 6;
    const connectedPeers = uiOnline?.connectedPeers || [];
    const joinedCount = Math.min(maxPlayers, 1 + connectedPeers.length);
    const roomCode = uiOnline?.roomId || 'Lobby';
    const ratio = maxPlayers > 0 ? Math.min(1, joinedCount / maxPlayers) : 0;
    const contentText = `Lobby (${roomCode}): ${joinedCount}/${maxPlayers} joined`;

    try {
      const notifyStore = useQuickNotificationStore?.getState?.();
      if (!notifyStore) return;
      const existing = notifyStore.ongoingTasks?.some?.(
        (t) => t.id === HOST_LOBBY_ONGOING_NOTIFICATION_ID,
      );
      if (existing) {
        notifyStore.updateOngoingNotification(HOST_LOBBY_ONGOING_NOTIFICATION_ID, {
          content: contentText,
          progress: ratio,
          tone: joinedCount >= maxPlayers ? 'success' : 'info',
          isSpinningIcon: joinedCount < maxPlayers,
        });
      } else {
        notifyStore.pushOngoingNotification({
          id: HOST_LOBBY_ONGOING_NOTIFICATION_ID,
          type: 'ongoing',
          content: contentText,
          icon: 'Users',
          progress: ratio,
          tone: joinedCount >= maxPlayers ? 'success' : 'info',
          isSpinningIcon: joinedCount < maxPlayers,
        });
      }
    } catch (err) {
      console.warn(
        '[OnlineRosterSyncCoordinator] Failed to update host lobby ongoing notification:',
        err,
      );
    }
  }

  public dismissHostLobbyOngoingNotification(): void {
    dismissHostLobbyOngoingNotification();
  }

  public async applyRosterSnapshot(
    roster: OnlineRosterSnapshotPayload | null | undefined,
  ): Promise<void> {
    const { session, world, diagnostics } = this.host;
    if (!roster || !Array.isArray(roster.players)) return;
    this.lastRosterSnapshot = roster;

    const isLobbyDualWorld = session.isLobbyDualWorldActive();
    const isHostLobby = Boolean(session.authoritativeServer && isLobbyDualWorld);

    await world.arena?.ensureOpponent?.();
    const connectedPeers: OnlinePeerEntryPort[] = [];
    const nameTagEntries: Array<{
      carIndex: number;
      name: string;
      team: 0 | 1;
      isBot: boolean;
    }> = [];

    for (const p of roster.players) {
      const cIdx = p.entityId;
      if (typeof cIdx !== 'number' || cIdx < 0 || cIdx >= 8) continue;
      const preset = p.visualId || 'octane';
      const hitbox = p.hitboxId || preset;
      const rawTeam = p.team ?? cIdx % 2;
      const physicsTeam: 0 | 1 = rawTeam === 1 ? 1 : 0;
      const displayName = p.name || `Player ${cIdx + 1}`;
      this.participantTeams.set(cIdx, physicsTeam);

      nameTagEntries.push({
        carIndex: cIdx,
        name: displayName,
        team: physicsTeam,
        isBot: Boolean(p.isBot),
      });

      if (cIdx !== world.playerCarIndex) {
        const prevPeers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
        const hostPeerList =
          (world.multiplayerSession?.hostController?.getConnectedPeerList?.() as
            | Array<{
                id?: string;
                carIndex?: number;
                pairingCode?: string;
                pingMs?: number;
              }>
            | undefined) || [];
        const matchedHostPeer = hostPeerList.find(
          (hp) => hp.carIndex === cIdx || hp.id === p.sessionId,
        );
        const matchedPrevPeer = prevPeers.find(
          (pp) => pp.carIndex === cIdx || pp.id === p.sessionId,
        );
        const resolvedPairingCode =
          matchedHostPeer?.pairingCode ||
          (matchedPrevPeer?.pairingCode as string | undefined) ||
          (!session.authoritativeServer
            ? useAppStore?.getState?.()?.onlineSession?.pairingCode
            : undefined);

        const lastParsed = session.networkReconciler?.lastParsedPacket as
          | {
              allUserRtt?: {
                players?: Array<{ carIndex?: number; rtt?: number }>;
              };
            }
          | null
          | undefined;
        const packetRttObj = lastParsed?.allUserRtt?.players?.find?.(
          (entry) => entry && entry.carIndex === cIdx,
        );
        const resolvedPingMs = p.isBot
          ? 0
          : Math.round(
              (typeof p.pingMs === 'number' && p.pingMs > 0 ? p.pingMs : null) ??
                (typeof packetRttObj?.rtt === 'number' && packetRttObj.rtt > 0
                  ? packetRttObj.rtt
                  : null) ??
                (typeof matchedHostPeer?.pingMs === 'number' && matchedHostPeer.pingMs > 0
                  ? matchedHostPeer.pingMs
                  : null) ??
                (typeof matchedPrevPeer?.pingMs === 'number' && matchedPrevPeer.pingMs > 0
                  ? matchedPrevPeer.pingMs
                  : null) ??
                (!session.authoritativeServer ? session.networkReconciler?.metrics?.rttMs || 15 : 15),
            );

        connectedPeers.push({
          id: p.sessionId || `peer_${cIdx}`,
          name: displayName,
          carIndex: cIdx,
          entityId: cIdx,
          team: rawTeam === 2 ? 2 : physicsTeam,
          isBot: Boolean(p.isBot),
          pingMs: resolvedPingMs,
          pairingCode: resolvedPairingCode,
          isReady: Boolean(p.ready),
        });
      }

      session.networkReconciler?.setCarVisualPreset?.(cIdx, preset);

      if (isLobbyDualWorld && cIdx !== world.playerCarIndex) {
        if (world.arena?.cars?.[cIdx]) {
          world.arena.cars[cIdx].visible = false;
        }
        continue;
      }

      if (world.physics) {
        if (typeof world.physics.addCarAtSlot === 'function') {
          world.physics.addCarAtSlot(cIdx, physicsTeam, preset);
        } else {
          while (world.physics.numCars <= cIdx) {
            const nextIdx = world.physics.numCars;
            world.physics.addCar(
              nextIdx === cIdx ? physicsTeam : nextIdx % 2,
              session.networkReconciler?.carVisualPresets?.get(nextIdx) || 'octane',
            );
          }
        }
      }
      world.physics?.setCarTeam?.(cIdx, physicsTeam);

      if (world.arena) {
        if (typeof world.arena.ensureCar === 'function') {
          world.arena.ensureCar(cIdx, physicsTeam, 'fennec');
        } else {
          while (world.arena.cars.length <= cIdx) {
            world.arena.addCar(world.arena.cars.length % 2, 'fennec');
          }
        }
        if (world.arena.cars[cIdx]) {
          world.arena.cars[cIdx].visible = isLobbyDualWorld ? cIdx === world.playerCarIndex : true;
        }
      }

      if (world.entityManager) {
        world.entityManager.hotSwapVehicle(cIdx, { visual: preset, hitbox });
      } else {
        world.arena?.swapCarVisual?.(cIdx, preset);
        world.physics?.setCarHitbox?.(cIdx, hitbox);
      }

      let colorHex: string | null = null;
      if (typeof p.colorSlot === 'number' && p.colorSlot >= 0) {
        const slotObj = CAR_COLOR_SLOTS.find((s) => s.id === p.colorSlot);
        if (slotObj) {
          colorHex = slotObj.hex;
          world.arena?.setCarColor?.(cIdx, slotObj.hex);
          if (cIdx === world.playerCarIndex) {
            world.selectedColorSlot = slotObj.id;
          }
        }
      } else {
        world.arena?.setCarTeam?.(cIdx, physicsTeam);
      }

      world.arena?.setCarLoadout?.(cIdx, {
        colorHex: colorHex || undefined,
        paintFinish: p.paintFinish || 'metallic',
        boostVisual: p.boostVisual || 'gold-rush',
        boostAudio: p.boostAudio || 'rush',
      });
      gameAudio?.setCarBoostAudioVariation?.(cIdx, p.boostAudio || 'rush');
    }

    if (isLobbyDualWorld || diagnostics.isDiagnosticFleetEnabled()) {
      if (!nameTagEntries.some((e) => e.carIndex === 6)) {
        nameTagEntries.push({ carIndex: 6, name: 'Boost', team: 0, isBot: true });
      }
      if (!nameTagEntries.some((e) => e.carIndex === 7)) {
        nameTagEntries.push({ carIndex: 7, name: 'Roll', team: 1, isBot: true });
      }
    }

    setNameTagRuntimeState({
      isMultiplayerOrMultiCarMode: true,
      carEntries: nameTagEntries,
    });

    if (useAppStore && typeof useAppStore.getState === 'function') {
      const localRosterEntry = roster.players.find(
        (p) =>
          p &&
          (p.entityId === world.playerCarIndex ||
            (session.authoritativeServer && p.sessionId === 'host')),
      );
      const sessionPatch: Record<string, unknown> = { connectedPeers };
      if (localRosterEntry) {
        sessionPatch.localTeam =
          localRosterEntry.team === 2
            ? 'neutral'
            : localRosterEntry.team === 1
              ? 'orange'
              : 'blue';
      }
      if (roster.gameMode === '1v1' || roster.gameMode === '2v2' || roster.gameMode === '3v3') {
        sessionPatch.gameMode = roster.gameMode;
      }
      if (typeof roster.botFillMode === 'string') {
        sessionPatch.botFillMode = roster.botFillMode;
      }
      if (
        typeof roster.durationSeconds === 'number' &&
        Number.isFinite(roster.durationSeconds) &&
        roster.durationSeconds >= 0
      ) {
        sessionPatch.matchDurationSeconds = roster.durationSeconds;
        if (isLobbyDualWorld && world.match?.state) {
          world.match.state.durationSeconds = roster.durationSeconds;
        }
      }
      useAppStore.getState().setOnlineSession(sessionPatch);
    }
    if (isHostLobby || session.authoritativeServer) {
      this.syncHostLobbyOngoingNotification();
    }
  }

  public async onRemotePlayerConnected(
    channel: RemotePeerChannel | null | undefined,
    remotePlayerName = 'Player 2',
    assignedCarIndex: number | null = null,
  ): Promise<number | null> {
    const { session, world, diagnostics } = this.host;
    if (session.authoritativeServer && channel) {
      const channelId = session.authoritativeServer.addClientChannel(channel);
      let targetCarIndex = assignedCarIndex;
      if (typeof targetCarIndex !== 'number' || targetCarIndex < 1) {
        const existingPeers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
        const usedCarIndices = new Set<number>([
          ...existingPeers
            .filter((p) => !p?.isBot && !String(p?.id || '').startsWith('bot_'))
            .map((p) => p.carIndex)
            .filter((idx): idx is number => typeof idx === 'number'),
          ...session.remotePeerCarMap.values(),
        ]);
        for (let i = 1; i < 6; i++) {
          if (!usedCarIndices.has(i)) {
            targetCarIndex = i;
            break;
          }
        }
        if (typeof targetCarIndex !== 'number') targetCarIndex = 1;
      }
      session.remotePeerCarMap.set(channelId || `peer_${targetCarIndex}`, targetCarIndex);
      channel.carIndex = targetCarIndex;

      const team = targetCarIndex % 2;
      const peerVisualId = channel.visualId || 'octane';
      const peerHitboxId = channel.hitboxId || null;
      const peerColorSlot = channel.colorSlot ?? 0;
      const peerPaintFinish = channel.paintFinish || 'metallic';
      const peerBoostVisual = channel.boostVisual || 'gold-rush';
      const peerBoostAudio = channel.boostAudio || 'rush';
      const isLobby = Boolean(
        session.isLobbyDualWorldActive() ||
          world.match?.state?.mode !== 'match' ||
          world.match?.state?.phase === 'lobby',
      );

      if (!isLobby) {
        session.authoritativeServer.ensureCar(targetCarIndex, team, peerVisualId);
      }
      session.authoritativeServer.notifyPlayerJoined(
        targetCarIndex,
        remotePlayerName,
        'player',
        channelId,
        peerVisualId,
        peerColorSlot,
        peerHitboxId,
        peerPaintFinish,
        peerBoostVisual,
        peerBoostAudio,
      );

      if (!isLobby) {
        if (world.arena) {
          await world.arena.ensureOpponent?.();
          if (typeof world.arena.ensureCar === 'function') {
            world.arena.ensureCar(targetCarIndex, team, 'fennec');
          } else {
            while (world.arena.cars.length <= targetCarIndex) {
              world.arena.addCar(world.arena.cars.length % 2, 'fennec');
            }
            if (!world.arena.cars[targetCarIndex]) {
              world.arena.addCar(team, 'fennec', targetCarIndex);
            }
          }
          if (world.arena.cars[targetCarIndex]) {
            world.arena.cars[targetCarIndex].visible = true;
          }
        }
        if (world.physics) {
          if (typeof world.physics.addCarAtSlot === 'function') {
            world.physics.addCarAtSlot(targetCarIndex, team, peerVisualId);
          } else {
            while (world.physics.numCars <= targetCarIndex) {
              world.physics.addCar(world.physics.numCars % 2, peerVisualId);
            }
          }
          world.physics.setCarTeam?.(targetCarIndex, team);
          world.physics.setCarHitbox(targetCarIndex, peerVisualId);
        }
        if (world.interpolator) {
          world.interpolator.sync(performance.now());
        }
      } else if (world.arena?.cars?.[targetCarIndex]) {
        world.arena.cars[targetCarIndex].visible = false;
      }

      channel.onColorChange = (msg: { carIndex?: number; hex: string }) => {
        const cIdx = msg.carIndex ?? targetCarIndex;
        world.setCarColor(cIdx, msg.hex, false);
      };
      channel.onDiagnosticFleetToggle = (enabled: boolean, anchorMode?: string) => {
        if (enabled) {
          void diagnostics.spawnDiagnosticTestFleet({ anchorMode });
        } else {
          diagnostics.despawnDiagnosticTestFleet();
        }
      };

      if (useAppStore && typeof useAppStore.getState === 'function') {
        const existingPeers = (
          useAppStore.getState().onlineSession?.connectedPeers || []
        ).filter((p) => p.carIndex !== targetCarIndex);
        const ping = Math.round(channel.measuredRttMs || 15);
        useAppStore.getState().setOnlineSession({
          connectedPeers: [
            ...existingPeers,
            {
              id: channel.peerId || `peer_${targetCarIndex}`,
              name: remotePlayerName,
              carIndex: targetCarIndex,
              pingMs: ping,
              pairingCode: channel.pairingCode || undefined,
            },
          ],
        });
      }
      this.syncHostLobbyOngoingNotification();
      return targetCarIndex;
    }
    return assignedCarIndex;
  }

  public async removeRemotePlayer(carIndex: number): Promise<void> {
    const { session, world } = this.host;
    if (carIndex === world.playerCarIndex) return;

    for (const [k, v] of session.remotePeerCarMap.entries()) {
      if (v === carIndex) session.remotePeerCarMap.delete(k);
    }

    if (world.arena) {
      world.arena.removeCar?.(carIndex);
    }
    if (world.flipResetVisuals?.has?.(carIndex)) {
      world.flipResetVisuals.get(carIndex)?.stopVisual?.();
      world.flipResetVisuals.delete(carIndex);
    }

    if (session.authoritativeServer) {
      session.authoritativeServer.removeCar?.(carIndex);
    }

    if (useAppStore && typeof useAppStore.getState === 'function') {
      const peers = useAppStore.getState().onlineSession?.connectedPeers || [];
      useAppStore.getState().setOnlineSession({
        connectedPeers: peers.filter((p) => p.carIndex !== carIndex),
      });
    }
    this.syncHostLobbyOngoingNotification();
  }
}
