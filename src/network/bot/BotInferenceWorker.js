/**
 * src/network/BotInferenceWorker.js
 * Dedicated Web Worker for AI Bot Inference (Nexto / Necto / Heuristic).
 *
 * Architectural Isolation:
 * Runs completely outside AuthoritativeServerWorker so heavy neural network
 * inference (EARL Perceiver / SafeTensors) never blocks or delays the 120Hz
 * authoritative physics loop. Produces standard binary InputPacketCodec
 * frames for each bot session, which BotTunnelManager feeds into the server's
 * NetworkDataHandler / EstablishedSessionManager over virtual loopback tunnels.
 */

import {
  ExperimentalBotAgent,
  ensureExperimentalEngine,
  DEFAULT_CAR_CONTROLS
} from '../../ai/experimental/ExperimentalBotAgent.js';
import { BallStateView, CarStateView } from '../../physics/RocketSimStateViews.js';
import { InputPacketCodec } from '../protocol/InputPacketCodec.js';

const DEFAULT_SOCCAR_BOOST_PADS = Object.freeze([
  { pos: [-3584, 0, 73], isBig: true },
  { pos: [3584, 0, 73], isBig: true },
  { pos: [-3072, 4096, 73], isBig: true },
  { pos: [3072, 4096, 73], isBig: true },
  { pos: [-3072, -4096, 73], isBig: true },
  { pos: [3072, -4096, 73], isBig: true },
  { pos: [0, -4240, 70], isBig: false },
  { pos: [-1792, -4184, 70], isBig: false },
  { pos: [1792, -4184, 70], isBig: false },
  { pos: [-940, -3308, 70], isBig: false },
  { pos: [940, -3308, 70], isBig: false },
  { pos: [0, -2816, 70], isBig: false },
  { pos: [-3584, -2484, 70], isBig: false },
  { pos: [3584, -2484, 70], isBig: false },
  { pos: [-1788, -2300, 70], isBig: false },
  { pos: [1788, -2300, 70], isBig: false },
  { pos: [-2048, -1036, 70], isBig: false },
  { pos: [0, -1024, 70], isBig: false },
  { pos: [2048, -1036, 70], isBig: false },
  { pos: [-1024, 0, 70], isBig: false },
  { pos: [1024, 0, 70], isBig: false },
  { pos: [-2048, 1036, 70], isBig: false },
  { pos: [0, 1024, 70], isBig: false },
  { pos: [2048, 1036, 70], isBig: false },
  { pos: [-1788, 2300, 70], isBig: false },
  { pos: [1788, 2300, 70], isBig: false },
  { pos: [-3584, 2484, 70], isBig: false },
  { pos: [3584, 2484, 70], isBig: false },
  { pos: [0, 2816, 70], isBig: false },
  { pos: [-940, 3308, 70], isBig: false },
  { pos: [940, 3308, 70], isBig: false },
  { pos: [-1792, 4184, 70], isBig: false },
  { pos: [1792, 4184, 70], isBig: false },
  { pos: [0, 4240, 70], isBig: false },
]);

const botAgents = new Map(); // sessionId -> { agent, kickoffStep, staggered }
const sBallView = new BallStateView();
const sCarView = new CarStateView();
let cachedPads = DEFAULT_SOCCAR_BOOST_PADS;
let directServerPort = null;

function postWorkerMessage(msg, transfer = []) {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    if (transfer && transfer.length > 0) {
      self.postMessage(msg, transfer);
    } else {
      self.postMessage(msg);
    }
  }
}

export function stepBotInferenceBatch(payload = {}) {
  const {
    stateSnapshot,
    serverTick = 0,
    matchState = 'playing',
    bots = [],
    activeCars = [],
    pads = null,
    redundantTicks = 6,
    nowMs = Date.now()
  } = payload;

  if (Array.isArray(pads) && pads.length > 0) {
    cachedPads = pads;
  }

  if (!stateSnapshot || !(stateSnapshot instanceof Float32Array) || bots.length === 0) {
    return [];
  }

  // Prune agents no longer in bots list
  const activeBotSids = new Set(bots.map((b) => b.sessionId));
  for (const sid of Array.from(botAgents.keys())) {
    if (!activeBotSids.has(sid)) {
      botAgents.delete(sid);
    }
  }

  sBallView.attach(stateSnapshot);
  const closestCarPerTeam = { 0: -1, 1: -1 };
  const closestDistPerTeam = { 0: Infinity, 1: Infinity };

  if (matchState === 'playing') {
    for (let i = 0; i < activeCars.length; i++) {
      const entry = activeCars[i];
      if (!entry || typeof entry.carIndex !== 'number' || entry.carIndex < 0 || entry.carIndex >= 8) continue;
      sCarView.attachCar(stateSnapshot, entry.carIndex);
      if (sCarView.isDemoed) continue;
      const d = Math.hypot(sCarView.posX - sBallView.posX, sCarView.posY - sBallView.posY);
      const t = entry.team === 1 ? 1 : 0;
      if (d < closestDistPerTeam[t]) {
        closestDistPerTeam[t] = d;
        closestCarPerTeam[t] = entry.carIndex;
      }
    }
  }

  const packets = [];
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const sid = bot.sessionId;
    const carIndex = bot.carIndex ?? bot.entityId ?? 1;
    const team = bot.team === 1 ? 1 : 0;
    const botType = bot.botType || 'nexto';

    let record = botAgents.get(sid);
    if (!record) {
      const agent = new ExperimentalBotAgent(botType, carIndex, team);
      ensureExperimentalEngine(botType);
      record = {
        agent,
        kickoffStep: 0,
        staggered: false,
        lastServerTick: -1,
        maxCommittedTick: -1,
        committedControls: new Map(),
      };
      botAgents.set(sid, record);
    } else {
      record.agent.carIndex = carIndex;
      record.agent.team = team;
      if (record.agent.botType !== botType) {
        record.agent.setBotType(botType);
      }
    }

    if (
      matchState !== 'playing' ||
      record.maxCommittedTick < serverTick - 16 ||
      record.maxCommittedTick > serverTick + 16
    ) {
      record.maxCommittedTick = serverTick - 1;
      record.committedControls.clear();
    }

    const deltaTicks =
      record.lastServerTick >= 0 && serverTick > record.lastServerTick
        ? Math.min(16, serverTick - record.lastServerTick)
        : 1;
    record.lastServerTick = serverTick;

    let ctrl = DEFAULT_CAR_CONTROLS;
    const isPrimaryKickoffCar = closestCarPerTeam[team] === carIndex;
    const baseKickoffStep = record.kickoffStep;

    if (matchState !== 'playing') {
      record.kickoffStep = 0;
      record.staggered = false;
      record.agent.reset();
      ctrl = DEFAULT_CAR_CONTROLS;
    } else {
      const ko = record.agent.getKickoffControls(stateSnapshot, baseKickoffStep, isPrimaryKickoffCar);
      if (ko) {
        ctrl = ko;
        record.agent.overrideControls(ko);
      } else if (record.agent.tickSkipCounter <= 0) {
        ctrl = record.agent.decideSync(stateSnapshot, cachedPads, activeCars);
        record.agent.tickSkipCounter = record.staggered
          ? Math.max(0, record.agent.tickSkip - deltaTicks)
          : (carIndex % record.agent.tickSkip) + 1;
        record.staggered = true;
      } else {
        record.agent.tickSkipCounter = Math.max(0, record.agent.tickSkipCounter - deltaTicks);
        ctrl = record.agent.action;
      }
      record.kickoffStep += deltaTicks;
    }

    const targetTick = serverTick + 1;
    const startCommitTick = Math.max(serverTick, record.maxCommittedTick + 1);
    for (let t = startCommitTick; t <= targetTick; t++) {
      let tickCtrl = ctrl || DEFAULT_CAR_CONTROLS;
      const k = t - serverTick;
      if (matchState === 'playing' && baseKickoffStep + k < 168) {
        const koTick = record.agent.getKickoffControls(stateSnapshot, baseKickoffStep + k, isPrimaryKickoffCar);
        if (koTick) {
          tickCtrl = koTick;
        }
      }
      record.committedControls.set(t, { ...tickCtrl });
      record.maxCommittedTick = t;
    }

    for (const oldTick of record.committedControls.keys()) {
      if (oldTick < serverTick - 4) {
        record.committedControls.delete(oldTick);
      }
    }

    const history = [];
    for (let t = serverTick; t <= targetTick; t++) {
      const committed = record.committedControls.get(t) || ctrl || DEFAULT_CAR_CONTROLS;
      history.push({
        tick: t,
        carIndex,
        controls: committed
      });
    }

    const packetBytes = InputPacketCodec.encode(
      carIndex,
      targetTick,
      history,
      nowMs,
      bot.acks || [],
      bot.commands || []
    );

    packets.push({
      sessionId: sid,
      carIndex,
      packetBytes
    });
  }

  return packets;
}

export async function handleBotWorkerMessage(eventOrData, customEmit = null) {
  const data = eventOrData?.data !== undefined ? eventOrData.data : (eventOrData || {});
  const emit = customEmit || postWorkerMessage;

  switch (data.type) {
    case 'init': {
      const botType = data.botType || 'nexto';
      await ensureExperimentalEngine(botType);
      if (Array.isArray(data.pads) && data.pads.length > 0) {
        cachedPads = data.pads;
      }
      if (data.port || eventOrData?.ports?.[0]) {
        const port = data.port || eventOrData.ports[0];
        attachDirectServerPort(port);
      }
      emit({ type: 'initialized', botType });
      break;
    }

    case 'set_pads': {
      if (Array.isArray(data.pads) && data.pads.length > 0) {
        cachedPads = data.pads;
      }
      break;
    }

    case 'attach_port': {
      const port = data.port || eventOrData?.ports?.[0];
      if (port) {
        attachDirectServerPort(port);
      }
      break;
    }

    case 'step_bots': {
      const packets = stepBotInferenceBatch(data);
      const transfers = [];
      for (let i = 0; i < packets.length; i++) {
        if (packets[i].packetBytes?.buffer instanceof ArrayBuffer) {
          transfers.push(packets[i].packetBytes.buffer);
        }
      }
      emit({ type: 'bot_tunnel_packets', serverTick: data.serverTick || 0, packets }, transfers);
      break;
    }

    case 'reset': {
      botAgents.clear();
      break;
    }

    default:
      break;
  }
}

function attachDirectServerPort(port) {
  if (!port) return;
  if (directServerPort && directServerPort !== port) {
    try {
      directServerPort.close?.();
    } catch (_e) {}
  }
  directServerPort = port;
  const portEmit = (msg, transfer = []) => {
    try {
      if (transfer && transfer.length > 0) {
        directServerPort.postMessage(msg, transfer);
      } else {
        directServerPort.postMessage(msg);
      }
    } catch (_err) {
      directServerPort.postMessage(msg);
    }
  };
  directServerPort.onmessage = (ev) => handleBotWorkerMessage(ev, portEmit);
  directServerPort.start?.();
}

if (typeof self !== 'undefined') {
  self.onmessage = (event) => handleBotWorkerMessage(event);
}
