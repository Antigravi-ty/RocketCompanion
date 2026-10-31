/**
 * HostServerFallbackHelper.js
 * Synchronous main-thread fallback initialization, step loop, and teardown
 * for HostServerWorker when WebWorkers are disabled or unavailable.
 */

import { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.js';
import { PhysicsEngineManager } from './PhysicsEngineManager.js';
import { NetworkInputBuffer, MAX_INPUT_BUFFER_TICKS } from './NetworkInputBuffer.js';
import { EstablishedSessionManager } from './EstablishedSessionManager.js';
import { MatchSessionAdmin } from './match/MatchSessionAdmin.js';
import { NetworkDataHandler } from './NetworkDataHandler.js';
import { deliverToHostLoopback } from './HostLoopbackChannel.js';
import { buildWorkerRoomStateSummary } from './HostWorkerMessageRouter.js';
import {
  retainCompletedMatchReplayAndNotify,
  clearRetainedMatchReplayOnMatchStart,
} from '../../replay/ReplayFileExporter.js';

export async function initHostServerFallback(hostWorker) {
  console.warn('[HostServerWorker:Fallback] Operating in synchronous main-thread fallback mode (WebWorker disabled)');
  const hostVisualId = hostWorker.options.hostVisualId || 'octane';
  const hostColorSlot = hostWorker.options.hostColorSlot ?? 0;

  hostWorker.fallbackSim = new RocketSimPhysicsEngine();
  const wasmInitOpts = { ...(hostWorker.options.wasmInitOptions || {}), isolated: true };
  if (!wasmInitOpts.collisionData && RocketSimPhysicsEngine.cachedCollisionData) {
    wasmInitOpts.collisionData = RocketSimPhysicsEngine.cachedCollisionData;
  }
  await hostWorker.fallbackSim.init(wasmInitOpts);
  hostWorker.fallbackInputBuffer = new NetworkInputBuffer(MAX_INPUT_BUFFER_TICKS);
  hostWorker.fallbackPhysics = new PhysicsEngineManager({
    sim: hostWorker.fallbackSim,
    inputBuffer: hostWorker.fallbackInputBuffer,
  });
  hostWorker.fallbackSession = new EstablishedSessionManager(hostWorker.fallbackPhysics);
  hostWorker.fallbackManager = new MatchSessionAdmin({
    physicsManager: hostWorker.fallbackPhysics,
    sessionManager: hostWorker.fallbackSession,
    isHost: true,
    externalBotTunnels: true,
    roomId: hostWorker.options.roomId || 'local_room',
    gameMode: hostWorker.options.gameMode || '3v3',
    botFillMode: hostWorker.options.botFillMode || 'no_bots',
    matchDurationSeconds: hostWorker.options.durationSeconds ?? 300,
    lobbyMode: Boolean(hostWorker.options.lobbyMode),
    skipReplayByDefault:
      hostWorker.options.skipReplayByDefault !== undefined
        ? Boolean(hostWorker.options.skipReplayByDefault)
        : true,
    onClearRetainedReplay: clearRetainedMatchReplayOnMatchStart,
    onRetainCompletedReplay: retainCompletedMatchReplayAndNotify,
  });
  hostWorker.fallbackDataHandler = new NetworkDataHandler({
    matchManager: hostWorker.fallbackManager,
    sessionManager: hostWorker.fallbackSession,
    physicsManager: hostWorker.fallbackPhysics,
  });
  hostWorker.fallbackManager.dataHandler = hostWorker.fallbackDataHandler;

  hostWorker.fallbackPhysics.registerCarEntity(0, 0, hostWorker.options.hostHitboxId || hostVisualId);
  hostWorker.fallbackManager.assignPlayerSlot(
    'host',
    hostWorker.options.hostPlayerName && hostWorker.options.hostPlayerName !== 'Host'
      ? hostWorker.options.hostPlayerName
      : `Player${Math.floor(1000 + Math.random() * 9000)}`,
    'player',
    0,
    {
      visualId: hostVisualId,
      hitboxId: hostWorker.options.hostHitboxId || null,
      colorSlot: hostColorSlot,
      paintFinish: hostWorker.options.hostPaintFinish || 'metallic',
      boostVisual: hostWorker.options.hostBoostVisual || 'cartoon',
      boostAudio: hostWorker.options.hostBoostAudio || 'rush',
    },
    hostColorSlot
  );

  if (hostWorker.options.isBotMatch || hostWorker.options.numCars >= 2) {
    const botVisualId = hostWorker.options.botVisualId || 'octane';
    hostWorker.fallbackPhysics.registerCarEntity(1, 1, botVisualId);
    if (hostWorker.options.isBotMatch) {
      hostWorker.fallbackPhysics.setDirectCarControls(1, {
        throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false
      });
    }
    hostWorker.fallbackManager.assignPlayerSlot(
      'bot',
      hostWorker.options.botPlayerName || 'AI Bot',
      'player',
      1,
      botVisualId,
      0
    );
  }

  hostWorker.fallbackDataHandler.registerChannel('host', {
    send: (packet) => deliverToHostLoopback(hostWorker.hostChannel, packet),
  });

  if (hostWorker.options.initialState) {
    hostWorker.fallbackSim.restoreState(hostWorker.options.initialState);
  }

  if (hostWorker.options.startAsMatch) {
    hostWorker.fallbackManager.startMatch(hostWorker.options.durationSeconds);
  } else if (hostWorker.options.lobbyMode) {
    hostWorker.fallbackManager.enterLobbyMode(hostWorker.options.lobbyOptions || hostWorker.options);
  } else {
    hostWorker.fallbackManager.startTrainingMode();
  }

  hostWorker.active = true;
  const snap =
    typeof hostWorker.fallbackSim.saveCompactState === 'function'
      ? hostWorker.fallbackSim.saveCompactState()
      : hostWorker.fallbackSim.saveState();
  hostWorker.cachedSnapshot.subarray(0, snap.length).set(snap);
  hostWorker.lastServerTick = Math.floor(hostWorker.fallbackSim.getHeaderView().tickCount);
  hostWorker.lastRoomState = buildWorkerRoomStateSummary(
    hostWorker.fallbackManager,
    hostWorker.fallbackPhysics
  );
  hostWorker.botTunnelManager?.init?.();
  hostWorker.botTunnelManager?.syncFromRoomState?.(hostWorker.lastRoomState);
  return hostWorker;
}

export function stepHostServerFallback(hostWorker) {
  if (!hostWorker.isWorker && hostWorker.fallbackManager && hostWorker.fallbackDataHandler) {
    const globalPayloadBytes = hostWorker.fallbackManager.stepFrame();
    if (globalPayloadBytes && globalPayloadBytes.length > 0) {
      hostWorker.fallbackDataHandler.dispatchFrameToSessions(globalPayloadBytes);
    }
    if (hostWorker.fallbackSim) {
      const snap =
        typeof hostWorker.fallbackSim.saveCompactState === 'function'
          ? hostWorker.fallbackSim.saveCompactState()
          : hostWorker.fallbackSim.saveState();
      hostWorker.cachedSnapshot.subarray(0, snap.length).set(snap);
      hostWorker.lastServerTick = Math.floor(hostWorker.fallbackSim.getHeaderView().tickCount);
      hostWorker.lastRoomState = buildWorkerRoomStateSummary(
        hostWorker.fallbackManager,
        hostWorker.fallbackPhysics
      );
      hostWorker.botTunnelManager?.syncFromRoomState?.(hostWorker.lastRoomState);
      hostWorker.botTunnelManager?.onServerPhysicsFrame?.(
        hostWorker.cachedSnapshot,
        hostWorker.lastServerTick,
        hostWorker.fallbackManager.state
      );
      hostWorker.hostReplayRingBuffer?.recordFrame(hostWorker.lastServerTick, hostWorker.cachedSnapshot);
    }
  }
}

export function destroyHostServerFallback(hostWorker) {
  if (hostWorker.fallbackManager) {
    hostWorker.fallbackManager.destroy();
    hostWorker.fallbackSession?.destroy();
    hostWorker.fallbackDataHandler?.destroy();
    hostWorker.fallbackPhysics = null;
    hostWorker.fallbackInputBuffer = null;
    hostWorker.fallbackSession = null;
    hostWorker.fallbackManager = null;
    hostWorker.fallbackDataHandler = null;
    hostWorker.fallbackSim = null;
  }
}
