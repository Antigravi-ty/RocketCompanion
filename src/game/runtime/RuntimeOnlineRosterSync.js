/**
 * RuntimeOnlineRosterSync.js
 * Roster snapshot hydration and remote peer vehicle lifecycle synchronization
 * for RuntimeNetworkManager.
 */

import { CAR_COLOR_SLOTS } from '../../config/vehicleConstants.js';
import { useAppStore } from '../../stores/appStore';
import { useQuickNotificationStore } from '../../stores/quickNotificationStore';
import {
  spawnRuntimeDiagnosticTestFleet,
  despawnRuntimeDiagnosticTestFleet
} from './RuntimeNetworkDiagnosticsHelper.js';

export const HOST_LOBBY_ONGOING_NOTIFICATION_ID = 'host-lobby-players';

export function syncHostLobbyOngoingNotification(runtime) {
  const r = runtime;
  if (!r || !r.authoritativeServer || r.isBotMatch) {
    dismissHostLobbyOngoingNotification();
    return;
  }

  const isLobby = Boolean(
    r.arena?.isLobbyMode ||
    r.match?.state?.mode !== 'match' ||
    r.match?.state?.phase === 'lobby'
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
    const existing = notifyStore.ongoingTasks?.some?.((t) => t.id === HOST_LOBBY_ONGOING_NOTIFICATION_ID);
    if (existing) {
      notifyStore.updateOngoingNotification(HOST_LOBBY_ONGOING_NOTIFICATION_ID, {
        content: contentText,
        progress: ratio,
        tone: joinedCount >= maxPlayers ? 'success' : 'info',
        isSpinningIcon: joinedCount < maxPlayers
      });
    } else {
      notifyStore.pushOngoingNotification({
        id: HOST_LOBBY_ONGOING_NOTIFICATION_ID,
        type: 'ongoing',
        content: contentText,
        icon: 'Users',
        progress: ratio,
        tone: joinedCount >= maxPlayers ? 'success' : 'info',
        isSpinningIcon: joinedCount < maxPlayers
      });
    }
  } catch (err) {
    console.warn('[RuntimeOnlineRosterSync] Failed to update host lobby ongoing notification:', err);
  }
}

export function dismissHostLobbyOngoingNotification() {
  try {
    const notifyStore = useQuickNotificationStore?.getState?.();
    notifyStore?.dismissOngoingNotification?.(HOST_LOBBY_ONGOING_NOTIFICATION_ID);
  } catch (err) {
    console.warn('[RuntimeOnlineRosterSync] Failed to dismiss host lobby ongoing notification:', err);
  }
}

export async function applyRuntimeRosterSnapshot(runtime, roster) {
  const r = runtime;
  if (!roster || !Array.isArray(roster.players)) return;

  const isLobbyDualWorld = Boolean(
    r.arena?.isLobbyMode ||
    r.networkReconciler?.lobbyDualWorldMode ||
    r.networkManager?.lobbyGhostCoordinator?.lobbyModeActive
  );
  const isHostLobby = Boolean(r.authoritativeServer && isLobbyDualWorld);

  await r.arena?.ensureOpponent?.();
  const connectedPeers = [];

  for (const p of roster.players) {
    const cIdx = p.entityId;
    if (typeof cIdx !== 'number' || cIdx < 0 || cIdx >= 8) continue;
    const preset = p.visualId || 'octane';
    const hitbox = p.hitboxId || preset;
    const team = p.team ?? (cIdx % 2);

    if (cIdx !== r.playerCarIndex) {
      connectedPeers.push({
        id: p.sessionId || `peer_${cIdx}`,
        name: p.name || `Player ${cIdx + 1}`,
        carIndex: cIdx,
        pingMs: Math.round(r.networkReconciler?.metrics?.rttMs || 15),
        isReady: Boolean(p.ready)
      });
    }

    r.networkReconciler?.setCarVisualPreset?.(cIdx, preset);

    // During Lobby, Host and Client are in separate worlds; do not spawn remote peer cars into local physics
    if (isLobbyDualWorld && cIdx !== r.playerCarIndex) {
      if (r.arena?.cars?.[cIdx]) {
        r.arena.cars[cIdx].visible = false;
      }
      continue;
    }

    while (r.physics && r.physics.numCars <= cIdx) {
      const nextIdx = r.physics.numCars;
      r.physics.addCar(nextIdx === cIdx ? team : (nextIdx % 2), r.networkReconciler?.carVisualPresets?.get(nextIdx) || 'octane');
    }
    r.physics?.setCarTeam?.(cIdx, team);

    if (r.arena) {
      if (typeof r.arena.ensureCar === 'function') {
        r.arena.ensureCar(cIdx, team, 'fennec');
      } else {
        while (r.arena.cars.length <= cIdx) {
          r.arena.addCar(r.arena.cars.length % 2, 'fennec');
        }
      }
      if (r.arena.cars[cIdx]) {
        r.arena.cars[cIdx].visible = isLobbyDualWorld ? (cIdx === r.playerCarIndex) : true;
      }
    }

    if (r.entityManager) {
      r.entityManager.hotSwapVehicle(cIdx, { visual: preset, hitbox });
    } else {
      r.arena?.swapCarVisual?.(cIdx, preset);
      r.physics?.setCarHitbox?.(cIdx, hitbox);
    }

    if (p.colorSlot > 0) {
      const slotObj = CAR_COLOR_SLOTS.find((s) => s.id === p.colorSlot);
      if (slotObj) {
        r.arena?.setCarColor?.(cIdx, slotObj.hex);
      }
    } else {
      r.arena?.setCarTeam?.(cIdx, team);
    }
  }

  if (useAppStore && typeof useAppStore.getState === 'function') {
    useAppStore.getState().setOnlineSession({ connectedPeers });
  }
  if (isHostLobby || r.authoritativeServer) {
    syncHostLobbyOngoingNotification(r);
  }
}

export async function onRuntimeRemotePlayerConnected(runtime, channel, remotePlayerName = 'Player 2', assignedCarIndex = null) {
  const r = runtime;
  if (r.authoritativeServer) {
    if (!(r.remotePeerCarMap instanceof Map)) {
      r.remotePeerCarMap = new Map();
    }
    const channelId = r.authoritativeServer.addClientChannel(channel);
    let targetCarIndex = assignedCarIndex;
    if (typeof targetCarIndex !== 'number' || targetCarIndex < 1) {
      const existingPeers = useAppStore?.getState?.()?.onlineSession?.connectedPeers || [];
      const usedCarIndices = new Set([
        ...existingPeers.map((p) => p.carIndex).filter((idx) => typeof idx === 'number'),
        ...r.remotePeerCarMap.values()
      ]);
      for (let i = 1; i < 6; i++) {
        if (!usedCarIndices.has(i)) {
          targetCarIndex = i;
          break;
        }
      }
      if (typeof targetCarIndex !== 'number') targetCarIndex = 1;
    }
    r.remotePeerCarMap.set(channelId || `peer_${targetCarIndex}`, targetCarIndex);
    if (channel) {
      channel.carIndex = targetCarIndex;
    }

    const team = targetCarIndex % 2;
    const peerVisualId = channel?.visualId || 'octane';
    const peerColorSlot = channel?.colorSlot ?? 0;
    const isLobby = Boolean(
      r.arena?.isLobbyMode ||
      r.networkManager?.lobbyGhostCoordinator?.lobbyModeActive ||
      r.match?.state?.mode !== 'match' ||
      r.match?.state?.phase === 'lobby'
    );

    // In Lobby mode, EstablishedSessionManager only manages connection state;
    // do not register car #1 in Host's physics world until match starts.
    if (!isLobby) {
      r.authoritativeServer.ensureCar(targetCarIndex, team, peerVisualId);
    }
    r.authoritativeServer.notifyPlayerJoined(targetCarIndex, remotePlayerName, 'player', channelId, peerVisualId, peerColorSlot);

    if (!isLobby) {
      await r.arena.ensureOpponent();
      if (typeof r.arena.ensureCar === 'function') {
        r.arena.ensureCar(targetCarIndex, team, 'fennec');
      } else {
        while (r.arena.cars.length <= targetCarIndex) {
          r.arena.addCar(r.arena.cars.length % 2, 'fennec');
        }
        if (!r.arena.cars[targetCarIndex]) {
          r.arena.addCar(team, 'fennec', targetCarIndex);
        }
      }
      if (r.arena.cars[targetCarIndex]) {
        r.arena.cars[targetCarIndex].visible = true;
      }
      while (r.physics.numCars <= targetCarIndex) {
        r.physics.addCar(r.physics.numCars % 2, peerVisualId);
      }
      r.physics.setCarTeam?.(targetCarIndex, team);
      r.physics.setCarHitbox(targetCarIndex, peerVisualId);
      if (r.interpolator) {
        r.interpolator.sync(performance.now());
      }
    } else if (r.arena?.cars?.[targetCarIndex]) {
      r.arena.cars[targetCarIndex].visible = false;
    }

    if (channel) {
      channel.onColorChange = (msg) => {
        const cIdx = msg.carIndex ?? targetCarIndex;
        r.setCarColor(cIdx, msg.hex, false);
      };
      channel.onDiagnosticFleetToggle = (enabled, anchorMode) => {
        if (enabled) {
          spawnRuntimeDiagnosticTestFleet(r, { anchorMode });
        } else {
          despawnRuntimeDiagnosticTestFleet(r);
        }
      };
    }
    if (useAppStore && typeof useAppStore.getState === 'function') {
      const existingPeers = (useAppStore.getState().onlineSession?.connectedPeers || []).filter((p) => p.carIndex !== targetCarIndex);
      const ping = Math.round(channel?.measuredRttMs || 15);
      useAppStore.getState().setOnlineSession({
        connectedPeers: [...existingPeers, { id: channel?.peerId || `peer_${targetCarIndex}`, name: remotePlayerName, carIndex: targetCarIndex, pingMs: ping }]
      });
    }
    syncHostLobbyOngoingNotification(r);
    return targetCarIndex;
  }
  return assignedCarIndex;
}

export async function removeRuntimeRemotePlayer(runtime, carIndex) {
  const r = runtime;
  if (carIndex === r.playerCarIndex) return;

  if (r.remotePeerCarMap instanceof Map) {
    for (const [k, v] of r.remotePeerCarMap.entries()) {
      if (v === carIndex) r.remotePeerCarMap.delete(k);
    }
  }

  if (r.arena) {
    r.arena.removeCar?.(carIndex);
  }
  if (r.flipResetVisuals?.has?.(carIndex)) {
    r.flipResetVisuals.get(carIndex).stopVisual?.();
    r.flipResetVisuals.delete(carIndex);
  }

  if (r.authoritativeServer) {
    r.authoritativeServer.removeCar?.(carIndex);
  }

  if (useAppStore && typeof useAppStore.getState === 'function') {
    const peers = useAppStore.getState().onlineSession?.connectedPeers || [];
    useAppStore.getState().setOnlineSession({
      connectedPeers: peers.filter((p) => p.carIndex !== carIndex)
    });
  }
  syncHostLobbyOngoingNotification(r);
}
