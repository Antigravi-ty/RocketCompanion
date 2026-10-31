/**
 * src/network/AuthoritativeServerWorker.js
 * Dedicated Web Worker running the Authoritative Match Architecture.
 * 
 * Architecture Stack:
 * - RocketSimPhysicsEngine (Core WASM simulation)
 * - PhysicsEngineManager (10-tick input queue, clamping, masking)
 * - MatchSessionAdmin (Room state authority, symmetric rosters, signals)
 * - EstablishedSessionManager (17-byte client header packing & session registry)
 * - NetworkDataHandler (Ingress router, magic-byte fast path, egress dispatch)
 * - GlobalPayloadCodec (Binary bitmask physics, signals, RTT serialization)
 */

import { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.js';
import { PhysicsEngineManager } from './PhysicsEngineManager.js';
import { NetworkInputBuffer, MAX_INPUT_BUFFER_TICKS } from './NetworkInputBuffer.js';
import { EstablishedSessionManager } from './EstablishedSessionManager.js';
import { MatchSessionAdmin } from './match/MatchSessionAdmin.js';
import { NetworkDataHandler } from './NetworkDataHandler.js';
import {
  HOST_WORKER_MSG_TYPES,
  createWorkerEnvelope,
  routeProtocolMessageInWorker,
  buildWorkerRoomStateSummary
} from './HostWorkerMessageRouter.js';

let sim = null;
let physicsManager = null;
let inputBuffer = null;
let sessionManager = null;
let matchManager = null;
let dataHandler = null;
let diagnosticsController = null;
let botPort = null;
let botInferenceInFlight = false;
let botInferenceLastSentAt = 0;
let sentPadsToBotPort = false;

let isRunning = false;
let loopTimer = null;
let lastTickTime = -1;
let accumulator = 0;
const fixedTimestep = 1.0 / 120.0;

function postWorkerMessage(msg, transfer = []) {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    if (transfer && transfer.length > 0) {
      self.postMessage(msg, transfer);
    } else {
      self.postMessage(msg);
    }
  }
}

function sendToMain(channelId, packet) {
  let transferBuffer = null;
  let copy = packet;

  if (packet instanceof Uint8Array) {
    copy = new Uint8Array(packet);
    transferBuffer = copy.buffer;
  } else if (packet instanceof ArrayBuffer) {
    copy = new Uint8Array(packet);
    transferBuffer = copy.buffer;
  }

  try {
    if (transferBuffer) {
      postWorkerMessage({ type: 'channel_packet', channelId, packet: copy }, [transferBuffer]);
    } else {
      postWorkerMessage({ type: 'channel_packet', channelId, packet: copy });
    }
  } catch (err) {
    console.warn('[AuthoritativeServerWorker] postMessage with transferBuffer failed, retrying without transferBuffer:', err);
    postWorkerMessage({ type: 'channel_packet', channelId, packet: copy });
  }
}

function isVirtualBotChannelId(channelId) {
  return channelId === 'bot' || String(channelId || '').startsWith('bot_');
}

function registerWorkerChannel(channelId) {
  if (!dataHandler) return;
  if (isVirtualBotChannelId(channelId)) {
    dataHandler.registerChannel(channelId, {
      isVirtualBot: true,
      send: () => {},
      postMessage: () => {}
    });
    return;
  }
  dataHandler.registerChannel(channelId, {
    send: (packet) => sendToMain(channelId, packet),
    postMessage: (packet) => sendToMain(channelId, packet)
  });
}

function unregisterWorkerChannel(channelId) {
  if (!dataHandler) return;
  dataHandler.unregisterChannel(channelId);
  matchManager?.removePlayerSession(channelId);
}

let lastSyncedRoomSignature = '';

function computeRoomSyncSignature() {
  if (!matchManager) return '';
  let rosterSig = '';
  if (matchManager.players instanceof Map) {
    for (const [sid, p] of matchManager.players.entries()) {
      rosterSig += `${sid}:${p?.entityId ?? -1}:${p?.team ?? 0}:${p?.isBot ? 1 : 0}:${p?.visualId ?? ''}:${p?.hitboxId ?? ''}:${p?.colorSlot ?? 0}:${p?.paintFinish ?? ''}:${p?.boostVisual ?? ''}:${p?.boostAudio ?? ''}:${p?.ready ? 1 : 0}:${p?.arenaLoaded ? 1 : 0};`;
    }
  }
  return `${matchManager.state}|${matchManager.botFillMode}|${matchManager.gameMode}|${rosterSig}`;
}

function syncWorkerRoomStateIfNeeded(emitFn = postWorkerMessage, force = false) {
  if (!matchManager || !physicsManager) return;
  const sig = computeRoomSyncSignature();
  if (!force && sig === lastSyncedRoomSignature) return;
  lastSyncedRoomSignature = sig;
  const summary = buildWorkerRoomStateSummary(matchManager, physicsManager);
  if (summary) {
    emitFn(createWorkerEnvelope(HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC, summary, 0));
  }
}

function attachDirectBotPort(port) {
  if (!port) return;
  if (botPort && botPort !== port) {
    try {
      botPort.close?.();
    } catch (_e) {}
  }
  botPort = port;
  botInferenceInFlight = false;
  botInferenceLastSentAt = 0;
  sentPadsToBotPort = false;
  botPort.onmessage = (ev) => {
    const msg = ev?.data;
    if (!msg) return;
    if (msg.type === 'bot_tunnel_packets') {
      botInferenceInFlight = false;
      if (!dataHandler || !Array.isArray(msg.packets)) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      for (let i = 0; i < msg.packets.length; i++) {
        const item = msg.packets[i];
        if (!item || !item.sessionId || !item.packetBytes) continue;
        if (!dataHandler.channels.has(item.sessionId)) {
          registerWorkerChannel(item.sessionId);
        }
        dataHandler.handleIncomingPacket(item.sessionId, item.packetBytes, now);
      }
    }
  };
  botPort.start?.();
}

function stepDirectBotPort() {
  if (!botPort || !matchManager || !sim || !sim.state) return;
  const bots = [];
  const activeCars = [];
  for (const [sid, p] of matchManager.players.entries()) {
    const cIdx = p.entityId;
    if (typeof cIdx !== 'number' || cIdx < 0 || cIdx >= 6) continue;
    const team = p.team === 1 ? 1 : 0;
    activeCars.push({ carIndex: cIdx, team });
    if (p.isBot || isVirtualBotChannelId(sid)) {
      if (dataHandler && !dataHandler.channels.has(sid)) {
        registerWorkerChannel(sid);
      }
      bots.push({
        sessionId: sid,
        carIndex: cIdx,
        team,
        botType: p.botType || 'nexto'
      });
    }
  }
  if (bots.length === 0) return;

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (botInferenceInFlight && (now - botInferenceLastSentAt) < 150) {
    return;
  }

  const serverTick = physicsManager?.currentTick ?? Math.floor(sim.getHeaderView().tickCount);
  const stateCopy = new Float32Array(sim.state);
  let pads = null;
  if (!sentPadsToBotPort && typeof sim.getPads === 'function') {
    pads = sim.getPads();
    sentPadsToBotPort = true;
  }

  botInferenceInFlight = true;
  botInferenceLastSentAt = now;
  try {
    botPort.postMessage(
      {
        type: 'step_bots',
        stateSnapshot: stateCopy,
        serverTick,
        matchState: matchManager.state || 'playing',
        bots,
        activeCars,
        pads,
        redundantTicks: 10,
        nowMs: now
      },
      [stateCopy.buffer]
    );
  } catch (_err) {
    botInferenceInFlight = false;
  }
}

function tick() {
  if (!isRunning || !matchManager) return;
  const globalPayloadBytes = matchManager.stepFrame();
  syncWorkerRoomStateIfNeeded(postWorkerMessage, false);
  if (botPort && matchManager.externalBotTunnels) {
    stepDirectBotPort();
  }
  if (globalPayloadBytes && globalPayloadBytes.length > 0 && dataHandler) {
    dataHandler.dispatchFrameToSessions(globalPayloadBytes);
  }
}

function startLoop() {
  if (isRunning) return;
  isRunning = true;
  lastTickTime = performance.now();
  accumulator = 0;

  const loop = () => {
    if (!isRunning) return;
    const now = performance.now();
    const dt = Math.min((now - lastTickTime) / 1000.0, 0.25);
    lastTickTime = now;
    accumulator += dt;

    while (accumulator >= fixedTimestep) {
      accumulator -= fixedTimestep;
      tick();
    }

    loopTimer = setTimeout(loop, 2);
  };

  loopTimer = setTimeout(loop, 0);
}

function stopLoop() {
  isRunning = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

export function getAuthoritativeWorkerState() {
  return { sim, physicsManager, inputBuffer, sessionManager, matchManager, dataHandler, isRunning };
}

export async function handleAuthoritativeWorkerMessage(eventOrData, customPostMessage = null) {
  const raw = eventOrData?.data !== undefined ? eventOrData.data : (eventOrData || {});
  const { type, ...rest } = raw;
  const data = (raw.payload && typeof raw.payload === 'object' && ! (raw.payload instanceof Uint8Array))
    ? { ...rest, ...raw.payload }
    : rest;
  const emit = customPostMessage || postWorkerMessage;

  const workerCtx = {
    sim,
    physicsManager,
    sessionManager,
    matchManager,
    dataHandler,
    diagnosticsController,
    registerWorkerChannel,
    unregisterWorkerChannel,
    emit: (msg, transfer = []) => emit(msg, transfer),
    postEnvelope: (envelope, transfer = []) => emit(envelope, transfer)
  };

  if (
    type !== 'init' &&
    type !== HOST_WORKER_MSG_TYPES.WORKER_INIT &&
    type !== 'destroy' &&
    type !== HOST_WORKER_MSG_TYPES.WORKER_DESTROY &&
    type !== 'attach_bot_port' &&
    type !== 'detach_bot_port' &&
    routeProtocolMessageInWorker(workerCtx, raw)
  ) {
    if (workerCtx.diagnosticsController) {
      diagnosticsController = workerCtx.diagnosticsController;
    }
    if (type !== 'channel_packet' && type !== 'clientInput') {
      syncWorkerRoomStateIfNeeded(emit, false);
    }
    return;
  }

  switch (type) {
    case 'attach_bot_port': {
      const port = data.port || raw.port || eventOrData?.ports?.[0];
      if (port) {
        attachDirectBotPort(port);
      }
      break;
    }

    case 'detach_bot_port': {
      if (botPort) {
        try {
          botPort.close?.();
        } catch (_e) {}
      }
      botPort = null;
      botInferenceInFlight = false;
      break;
    }
    case 'init':
    case HOST_WORKER_MSG_TYPES.WORKER_INIT: {
      try {
        const hostVisualId = data.hostVisualId || 'octane';
        const hostColorSlot = data.hostColorSlot ?? 0;
        sim = new RocketSimPhysicsEngine();
        await sim.init(data.wasmInitOptions || {});

        inputBuffer = new NetworkInputBuffer(MAX_INPUT_BUFFER_TICKS);
        physicsManager = new PhysicsEngineManager({ sim, inputBuffer });
        sessionManager = new EstablishedSessionManager(physicsManager);
        matchManager = new MatchSessionAdmin({
          physicsManager,
          sessionManager,
          isHost: true,
          externalBotTunnels: data.externalBotTunnels !== undefined ? Boolean(data.externalBotTunnels) : true,
          roomId: data.roomId || 'local_room',
          gameMode: data.gameMode || '3v3',
          botFillMode: data.botFillMode || 'no_bots',
          matchDurationSeconds: data.durationSeconds ?? 300,
          maxOvertimeSeconds: data.maxOvertimeSeconds || 360,
          lobbyMode: Boolean(data.lobbyMode),
          skipReplayByDefault: data.skipReplayByDefault !== undefined ? Boolean(data.skipReplayByDefault) : true
        });
        dataHandler = new NetworkDataHandler({
          matchManager,
          sessionManager,
          physicsManager
        });
        matchManager.dataHandler = dataHandler;
        diagnosticsController = matchManager.diagnosticsController;

        physicsManager.registerCarEntity(0, 0, data.hostHitboxId || hostVisualId);
        const resolvedHostName =
          data.hostPlayerName && data.hostPlayerName !== 'Host'
            ? data.hostPlayerName
            : `Player${Math.floor(1000 + Math.random() * 9000)}`;
        matchManager.assignPlayerSlot(
          'host',
          resolvedHostName,
          'player',
          0,
          {
            visualId: hostVisualId,
            hitboxId: data.hostHitboxId || null,
            colorSlot: hostColorSlot,
            paintFinish: data.hostPaintFinish || 'metallic',
            boostVisual: data.hostBoostVisual || 'cartoon',
            boostAudio: data.hostBoostAudio || 'rush'
          },
          hostColorSlot
        );
        registerWorkerChannel('host');

        if (data.isBotMatch || data.numCars >= 2) {
          const botVisualId = data.botVisualId || 'octane';
          physicsManager.registerCarEntity(1, 1, botVisualId);
          if (data.isBotMatch) {
            physicsManager.setDirectCarControls(1, {
              throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false
            });
          }
          matchManager.assignPlayerSlot('bot', data.botPlayerName || 'AI Bot', 'player', 1, botVisualId, 0);
        }

        if (data.initialState) {
          sim.restoreState(data.initialState);
        }

        if (data.startAsMatch) {
          matchManager.startMatch(data.durationSeconds);
        } else if (data.lobbyMode) {
          matchManager.enterLobbyMode(data.lobbyOptions || data);
        } else {
          matchManager.startTrainingMode();
        }

        if (data.autoStartLoop !== false) {
          startLoop();
        }

        const snap = sim.saveCompactState ? sim.saveCompactState() : sim.saveState();
        const tickCount = Math.floor(sim.getHeaderView().tickCount);
        const roomSummary = buildWorkerRoomStateSummary(matchManager, physicsManager);
        lastSyncedRoomSignature = computeRoomSyncSignature();

        emit({ type: 'initialized', result: { snapshot: snap, tickCount, roomState: roomSummary } });
        emit(createWorkerEnvelope(HOST_WORKER_MSG_TYPES.WORKER_READY, {
          snapshot: snap, tickCount, roomState: roomSummary
        }, raw.seq || 0));
      } catch (err) {
        console.error('[AuthoritativeServerWorker] Init failed:', err);
        emit({ type: 'error', error: err.message });
      }
      break;
    }

    case 'destroy':
    case HOST_WORKER_MSG_TYPES.WORKER_DESTROY: {
      stopLoop();
      if (botPort) {
        try {
          botPort.close?.();
        } catch (_e) {}
      }
      botPort = null;
      botInferenceInFlight = false;
      sentPadsToBotPort = false;
      matchManager?.destroy();
      sessionManager?.destroy();
      dataHandler?.destroy();
      sim = null;
      physicsManager = null;
      inputBuffer = null;
      sessionManager = null;
      matchManager = null;
      dataHandler = null;
      diagnosticsController = null;
      lastSyncedRoomSignature = '';
      break;
    }

    default:
      break;
  }
}

if (typeof self !== 'undefined') {
  self.onmessage = (event) => handleAuthoritativeWorkerMessage(event);
}

