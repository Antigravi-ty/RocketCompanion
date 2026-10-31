/**
 * src/network/BotTunnelManager.js
 * Manages isolated virtual loopback tunnels between BotInferenceWorker and HostServerWorker.
 *
 * Each auto-filled bot slot (`bot_fill_1`, `bot_fill_2`, ..., or `bot`) is registered
 * as an independent virtual channel on the authoritative server and feeds standard
 * binary `InputPacketCodec` frames into `NetworkDataHandler` / `EstablishedSessionManager`.
 */

import { stepBotInferenceBatch } from './BotInferenceWorker.js';
import { ensureExperimentalEngine } from '../../ai/experimental/ExperimentalBotAgent.js';

export class BotTunnelManager {
  /**
   * @param {object} hostServer
   * @param {object} [options={}]
   */
  constructor(hostServer, options = {}) {
    this.hostServer = hostServer;
    this.options = options;
    this.worker = null;
    this.isWorker = typeof Worker !== 'undefined' && !options.forceInProcess;
    this.registeredTunnels = new Map(); // sessionId -> { sessionId, carIndex, team, botType }
    this.lastSteppedServerTick = -1;
    this.inferenceInFlight = false;
    this.inferenceStartedAtMs = 0;
    this.cachedPads = null;
    this._padsSentToWorker = false;
    this.hasDirectPort = false;
  }

  init() {
    if (this.isWorker && !this.worker) {
      try {
        const workerUrl = new URL('./BotInferenceWorker.js', import.meta.url);
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.worker.onmessage = (ev) => this._handleWorkerMessage(ev.data);
        this.worker.onerror = (err) => {
          if (typeof err?.preventDefault === 'function') err.preventDefault();
          console.warn('[BotTunnelManager] BotInferenceWorker error, falling back to async in-process tunnel:', err);
          try {
            this.worker?.terminate?.();
          } catch (_e) {}
          this.worker = null;
          this.isWorker = false;
          this.inferenceInFlight = false;
          this.hasDirectPort = false;
          this.hostServer?._postCommand?.('detach_bot_port', {});
          ensureExperimentalEngine('nexto');
        };
        this.worker.postMessage({ type: 'init', botType: 'nexto', pads: this.cachedPads });
        if (Array.isArray(this.cachedPads) && this.cachedPads.length > 0) {
          this._padsSentToWorker = true;
        }
        this._connectDirectPortIfAvailable();
      } catch (err) {
        console.warn('[BotTunnelManager] Failed to spawn BotInferenceWorker, using in-process tunnel:', err);
        this.worker = null;
        this.isWorker = false;
        this.inferenceInFlight = false;
        this.hasDirectPort = false;
        ensureExperimentalEngine('nexto');
      }
    } else {
      ensureExperimentalEngine('nexto');
    }
  }

  _connectDirectPortIfAvailable() {
    if (
      this.hasDirectPort ||
      !this.isWorker ||
      !this.worker ||
      !this.hostServer?.isWorker ||
      !this.hostServer?.worker ||
      typeof MessageChannel === 'undefined'
    ) {
      return false;
    }
    try {
      const { port1, port2 } = new MessageChannel();
      this.worker.postMessage({ type: 'attach_port', port: port1 }, [port1]);
      this.hostServer._postCommand('attach_bot_port', { port: port2 }, [port2]);
      this.hasDirectPort = true;
      return true;
    } catch (err) {
      console.warn('[BotTunnelManager] Failed to attach direct MessageChannel port, using main-thread relay:', err);
      this.hasDirectPort = false;
      return false;
    }
  }

  _handleWorkerMessage(data) {
    if (!data) return;
    if (data.type === 'bot_tunnel_packets') {
      this.inferenceInFlight = false;
      this._deliverBotTunnelPackets(data.packets || []);
    }
  }

  _deliverBotTunnelPackets(packets = []) {
    if (!this.hostServer || !Array.isArray(packets)) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (let i = 0; i < packets.length; i++) {
      const item = packets[i];
      if (!item || !item.sessionId || !item.packetBytes) continue;
      if (this.hostServer.isWorker && this.hostServer.worker) {
        this.hostServer._postCommand('channel_packet', {
          channelId: item.sessionId,
          packet: item.packetBytes,
          timestamp: now
        });
      } else if (this.hostServer.fallbackDataHandler) {
        this.hostServer.fallbackDataHandler.handleIncomingPacket(
          item.sessionId,
          item.packetBytes,
          now
        );
      }
    }
  }

  /**
   * Synchronizes virtual bot channels with the authoritative room state roster.
   * @param {object} roomState
   */
  syncFromRoomState(roomState) {
    if (Array.isArray(roomState?.pads) && roomState.pads.length > 0) {
      this.cachedPads = roomState.pads;
      if (this.isWorker && this.worker && !this._padsSentToWorker) {
        this.worker.postMessage({ type: 'set_pads', pads: this.cachedPads });
        this._padsSentToWorker = true;
      }
    }

    const players = roomState?.roster?.players || roomState?.players || [];
    const activeBotMap = new Map();

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const sid = p?.sessionId;
      const isBot = Boolean(p?.isBot || sid === 'bot' || String(sid || '').startsWith('bot_'));
      if (!isBot || !sid) continue;
      const carIndex = p.carIndex ?? p.entityId ?? -1;
      if (carIndex < 0 || carIndex >= 8) continue;
      activeBotMap.set(sid, {
        sessionId: sid,
        carIndex,
        team: p.team === 1 ? 1 : 0,
        botType: p.botType || 'nexto'
      });
    }

    // Register newly added bot tunnels on the server
    for (const [sid, info] of activeBotMap.entries()) {
      if (!this.registeredTunnels.has(sid)) {
        this.registeredTunnels.set(sid, info);
        if (this.hostServer?.isWorker && this.hostServer?.worker) {
          this.hostServer._postCommand('registerChannel', { channelId: sid });
        } else if (this.hostServer?.fallbackDataHandler) {
          this.hostServer.fallbackDataHandler.registerChannel(sid, { send: () => {} });
        }
      } else {
        this.registeredTunnels.set(sid, info);
      }
    }

    // Unregister removed bot tunnels
    for (const sid of Array.from(this.registeredTunnels.keys())) {
      if (!activeBotMap.has(sid)) {
        this.registeredTunnels.delete(sid);
      }
    }
  }

  /**
   * Triggered when HostServerWorker receives an authoritative physics frame.
   * Dispatches state to BotInferenceWorker and feeds resulting InputPacketCodec
   * frames back into the server over each bot's virtual tunnel.
   *
   * @param {Float32Array} stateSnapshot
   * @param {number} serverTick
   * @param {string} [matchState='playing']
   */
  onServerPhysicsFrame(stateSnapshot, serverTick, matchState = 'playing') {
    if (this.hasDirectPort) return;
    if (!stateSnapshot || this.registeredTunnels.size === 0) return;
    if (serverTick === this.lastSteppedServerTick) return;
    this.lastSteppedServerTick = serverTick;

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const bots = Array.from(this.registeredTunnels.values());
    const rosterPlayers = this.hostServer?.lastRoomState?.roster?.players || [];
    const activeCars = [];
    for (let i = 0; i < rosterPlayers.length; i++) {
      const p = rosterPlayers[i];
      const cIdx = p?.carIndex ?? p?.entityId ?? -1;
      if (cIdx >= 0 && cIdx < 8) {
        activeCars.push({
          carIndex: cIdx,
          team: p.team === 1 ? 1 : 0
        });
      }
    }
    if (activeCars.length === 0) {
      for (let i = 0; i < bots.length; i++) {
        activeCars.push({ carIndex: bots[i].carIndex, team: bots[i].team });
      }
    }

    const payload = {
      stateSnapshot: new Float32Array(stateSnapshot),
      serverTick,
      matchState,
      bots,
      activeCars,
      pads: this._padsSentToWorker ? null : this.cachedPads,
      redundantTicks: 10,
      nowMs
    };

    if (this.isWorker && this.worker) {
      if (this.inferenceInFlight && (nowMs - this.inferenceStartedAtMs) < 250) {
        return;
      }
      this.inferenceInFlight = true;
      this.inferenceStartedAtMs = nowMs;
      if (payload.pads) {
        this._padsSentToWorker = true;
      }
      this.worker.postMessage(
        { type: 'step_bots', ...payload },
        [payload.stateSnapshot.buffer]
      );
    } else {
      const packets = stepBotInferenceBatch(payload);
      this._deliverBotTunnelPackets(packets);
    }
  }

  destroy() {
    this.registeredTunnels.clear();
    this.inferenceInFlight = false;
    this._padsSentToWorker = false;
    this.hasDirectPort = false;
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (_e) {}
      this.worker = null;
    }
  }
}

export default BotTunnelManager;
