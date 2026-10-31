import {
  GlobalPayloadCodec,
  MATCH_SIGNALS,
  createBoostPadEdgeTracker,
  applyBoostPadEdgeCooldowns
} from '../protocol/GlobalPayloadCodec.js';
import { EstablishedSessionManager } from './EstablishedSessionManager.js';
import {
  createHostSimProxy,
  createDefaultHostChannel,
  deliverToHostLoopback
} from './HostLoopbackChannel.js';
import {
  HOST_WORKER_MSG_TYPES,
  createWorkerEnvelope,
  routeProtocolMessageInWorker,
} from './HostWorkerMessageRouter.js';
import {
  initHostServerFallback,
  stepHostServerFallback,
  destroyHostServerFallback,
} from './HostServerFallbackHelper.js';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../replay/ReplayRingBuffer.js';
import { BotTunnelManager } from '../bot/BotTunnelManager.js';

export class AuthoritativeServerHost {
  /**
   * @param {object} [channel=null] Host's local channel
   * @param {object} [options={}]
   */
  constructor(channel = null, options = {}) {
    if (channel && typeof channel === 'object' && !channel.send && !channel.sendClientInput && !channel.inboundQueue) {
      options = channel;
      channel = null;
    }
    this.options = { ...options };
    this.channels = [];
    this.channelMap = new Map();
    this.channelIdToChannel = new Map();
    this.nextChannelId = 1;

    this.isWorker = typeof Worker !== 'undefined' && !options.forceFallback;
    this.worker = null;
    this.botTunnelManager = new BotTunnelManager(this);
    this.fallbackManager = null;
    this.fallbackSim = null;
    this.fallbackPhysics = null;
    this.fallbackSession = null;
    this.fallbackDataHandler = null;

    this.active = false;
    this.cachedSnapshot = new Float32Array(448);
    this.boostPadEdgeTracker = createBoostPadEdgeTracker();
    this.hostReplayRingBuffer = new ReplayRingBuffer({ mode: REPLAY_BUFFER_MODES.COUNTDOWN_MATCH });
    this.lastServerTick = 0;
    this.lastGoal = 0;
    this.lastRoomState = null;

    this.headerViewInstance = null;
    this.pendingRequests = new Map();
    this.envelopeListeners = new Set();
    this.reqId = 0;

    this.sim = createHostSimProxy(this);

    this.hostChannel = channel || this._createDefaultHostChannel();
    this.channelMap.set(this.hostChannel, 'host');
    this.channelIdToChannel.set('host', this.hostChannel);
  }

  _createDefaultHostChannel() {
    return createDefaultHostChannel(this);
  }

  get channel() {
    return this.hostChannel;
  }

  set channel(ch) {
    if (ch && ch !== this.hostChannel) {
      this.hostChannel = ch;
      this.addClientChannel(ch, 'host');
    }
  }

  async init() {
    if (this.isWorker) {
      const maxAttempts = 3;
      return new Promise((resolve, reject) => {
        let settled = false;
        let attempt = 0;

        const fallbackToMainThread = (err) => {
          if (settled) return;
          settled = true;
          console.warn('[HostServerWorker] Worker initialization failed after retries, falling back to in-memory:', err);
          if (this.worker) {
            try {
              this.worker.terminate();
            } catch (_e) {}
            this.worker = null;
          }
          this.isWorker = false;
          this._initFallback().then(resolve).catch(reject);
        };

        const trySpawnWorker = () => {
          if (settled) return;
          attempt++;
          try {
            if (this.worker) {
              try {
                this.worker.terminate();
              } catch (_e) {}
              this.worker = null;
            }

            const workerUrl = new URL('./AuthoritativeServerWorker.js', import.meta.url);
            if (attempt > 1) {
              workerUrl.searchParams.set('retry', `${attempt}_${Date.now()}`);
            }

            const workerInstance = new Worker(workerUrl, { type: 'module' });
            this.worker = workerInstance;
            workerInstance.onmessage = (event) => this._handleWorkerMessage(event.data);

            const handleInitFailure = (err) => {
              if (settled || this.worker !== workerInstance) return;
              if (attempt < maxAttempts) {
                console.warn(
                  `[HostServerWorker] Worker bootstrap error on attempt ${attempt}/${maxAttempts}, retrying in 150ms...`,
                  err
                );
                setTimeout(trySpawnWorker, 150 * attempt);
              } else {
                fallbackToMainThread(err);
              }
            };

            workerInstance.onerror = (err) => {
              if (!settled) {
                if (typeof err?.preventDefault === 'function') {
                  err.preventDefault();
                }
                handleInitFailure(err);
              } else {
                console.error('[HostServerWorker] Runtime worker error:', err);
              }
            };

            const initListener = (event) => {
              const msg = event.data;
              if (!settled && (msg?.type === 'initialized' || msg?.type === HOST_WORKER_MSG_TYPES.WORKER_READY)) {
                settled = true;
                this.active = true;
                const res = msg.result || msg.payload || {};
                if (res.snapshot) {
                  const copyLen = Math.min(this.cachedSnapshot.length, res.snapshot.length);
                  this.cachedSnapshot
                    .subarray(0, copyLen)
                    .set(res.snapshot.subarray ? res.snapshot.subarray(0, copyLen) : res.snapshot.slice(0, copyLen));
                }
                if (res.tickCount !== undefined) this.lastServerTick = res.tickCount;
                if (res.roomState) {
                  this.lastRoomState = res.roomState;
                  this.botTunnelManager?.init?.();
                  this.botTunnelManager?.syncFromRoomState?.(res.roomState);
                }
                workerInstance.removeEventListener('message', initListener);
                resolve(this);
              } else if (!settled && msg?.type === 'error') {
                workerInstance.removeEventListener('message', initListener);
                handleInitFailure(new Error(msg.error));
              }
            };

            workerInstance.addEventListener('message', initListener);

            this.sendEnvelope(HOST_WORKER_MSG_TYPES.WORKER_INIT, {
              roomId: this.options.roomId || 'local_room',
              gameMode: this.options.gameMode || '3v3',
              botFillMode: this.options.botFillMode || 'no_bots',
              externalBotTunnels: true,
              initialState: this.options.initialState,
              hostPlayerName:
                this.options.hostPlayerName && this.options.hostPlayerName !== 'Host'
                  ? this.options.hostPlayerName
                  : `Player${Math.floor(1000 + Math.random() * 9000)}`,
              hostVisualId: this.options.hostVisualId || 'octane',
              hostHitboxId: this.options.hostHitboxId || null,
              hostColorSlot: this.options.hostColorSlot ?? 0,
              hostPaintFinish: this.options.hostPaintFinish || 'matte',
              hostBoostVisual: this.options.hostBoostVisual || 'cartoon',
              hostBoostAudio: this.options.hostBoostAudio || 'rush',
              isBotMatch: Boolean(this.options.isBotMatch),
              botPlayerName: this.options.botPlayerName || 'AI Bot',
              botVisualId: this.options.botVisualId || 'octane',
              numCars: this.options.numCars || (this.options.isBotMatch ? 2 : 1),
              startAsMatch: Boolean(this.options.startAsMatch),
              lobbyMode: Boolean(this.options.lobbyMode),
              lobbyOptions: this.options.lobbyOptions || null,
              durationSeconds: this.options.durationSeconds ?? 300,
              skipReplayByDefault:
                this.options.skipReplayByDefault !== undefined
                  ? Boolean(this.options.skipReplayByDefault)
                  : true
            });
          } catch (err) {
            fallbackToMainThread(err);
          }
        };

        trySpawnWorker();
      });
    }
    console.warn(
      `[HostServerWorker] Initializing in-memory server fallback (Worker available: ${typeof Worker !== 'undefined'}, forceFallback: ${Boolean(this.options.forceFallback)}).`
    );
    return this._initFallback();
  }

  async _initFallback() {
    return initHostServerFallback(this);
  }

  addEnvelopeListener(fn) {
    if (typeof fn === 'function') {
      this.envelopeListeners.add(fn);
      return () => this.envelopeListeners.delete(fn);
    }
    return () => {};
  }

  _notifyEnvelopeListeners(envelope) {
    for (const listener of this.envelopeListeners) {
      try {
        listener(envelope);
      } catch (err) {
        console.warn('[HostServerWorker] Error in envelope listener:', err);
      }
    }
  }

  _handleWorkerMessage(data) {
    if (!data) return;

    if (data.type && data.payload !== undefined) {
      if (data.type === HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC) {
        this.lastRoomState = data.payload;
        this.botTunnelManager?.syncFromRoomState?.(data.payload);
      }
      if (data.seq && this.pendingRequests.has(data.seq)) {
        const req = this.pendingRequests.get(data.seq);
        this.pendingRequests.delete(data.seq);
        req.resolve(data.payload);
      }
      this._notifyEnvelopeListeners(data);
    }

    switch (data.type) {
      case 'channel_packet': {
        const { channelId, packet } = data;
        if (channelId === 'host') {
          if (typeof packet === 'string') {
            try {
              const parsed = JSON.parse(packet);
              if (parsed?.type === 'roster_update') {
                this.lastRoomState = {
                  ...(this.lastRoomState || {}),
                  state: parsed.state || this.lastRoomState?.state || 'lobby',
                  roster: parsed.roster || this.lastRoomState?.roster || { players: [], spectators: [] }
                };
                this.botTunnelManager?.syncFromRoomState?.(this.lastRoomState);
              }
            } catch (_e) {}
          }
          if (!deliverToHostLoopback(this.hostChannel, packet)) return;
          if (packet instanceof Uint8Array || packet instanceof ArrayBuffer) {
            try {
              const clientHeader = EstablishedSessionManager.parseClientPacket(packet);
              if (clientHeader?.globalPayloadSlice) {
                const globalPayload = GlobalPayloadCodec.decode(clientHeader.globalPayloadSlice);
                if (Array.isArray(globalPayload?.signals)) {
                  for (let s = 0; s < globalPayload.signals.length; s++) {
                    const sig = globalPayload.signals[s];
                    if (!sig) continue;
                    if (!this.lastRoomState) {
                      this.lastRoomState = { state: 'lobby', roster: { players: [], spectators: [] } };
                    }
                    if (
                      sig.signalType === MATCH_SIGNALS.KICKOFF_START ||
                      sig.signalType === MATCH_SIGNALS.ROUND_STARTED ||
                      sig.signalType === MATCH_SIGNALS.OVERTIME_STARTED
                    ) {
                      this.lastRoomState.state = 'playing';
                    } else if (
                      sig.signalType === MATCH_SIGNALS.KICKOFF_WILL_START ||
                      sig.signalType === MATCH_SIGNALS.GOAL_REPLAY_END ||
                      sig.signalType === MATCH_SIGNALS.MATCH_STARTED
                    ) {
                      this.lastRoomState.state = 'kickoff';
                    } else if (
                      sig.signalType === MATCH_SIGNALS.GOAL_SCORED ||
                      sig.signalType === MATCH_SIGNALS.GOAL_REPLAY_START
                    ) {
                      this.lastRoomState.state = 'replay';
                    } else if (
                      sig.signalType === MATCH_SIGNALS.MATCH_ENDED ||
                      sig.signalType === MATCH_SIGNALS.PODIUM_START
                    ) {
                      this.lastRoomState.state = 'ended';
                    }
                  }
                }
                if (globalPayload?.hasPhysics && globalPayload.physics?.stateSnapshot) {
                  const snap = globalPayload.physics.stateSnapshot;
                  applyBoostPadEdgeCooldowns(
                    snap,
                    globalPayload.physics.tick,
                    this.boostPadEdgeTracker
                  );
                  if (this.cachedSnapshot.length !== snap.length) {
                    this.cachedSnapshot = new Float32Array(snap.length);
                  }
                  this.cachedSnapshot.set(snap);
                  this.lastServerTick = globalPayload.physics.tick;
                  const newSignals = [];
                  if (Array.isArray(globalPayload.signals)) {
                    for (let s = 0; s < globalPayload.signals.length; s++) {
                      const sig = globalPayload.signals[s];
                      if (!sig) continue;
                      if (this.lastRoomState) {
                        if (sig.signalType === MATCH_SIGNALS.KICKOFF_START) {
                          this.lastRoomState.state = 'playing';
                        } else if (
                          sig.signalType === MATCH_SIGNALS.KICKOFF_WILL_START ||
                          sig.signalType === MATCH_SIGNALS.GOAL_REPLAY_END ||
                          sig.signalType === MATCH_SIGNALS.ROUND_STARTED
                        ) {
                          this.lastRoomState.state = 'kickoff';
                        } else if (sig.signalType === MATCH_SIGNALS.GOAL_REPLAY_START) {
                          this.lastRoomState.state = 'replay';
                        } else if (sig.signalType === MATCH_SIGNALS.MATCH_PREPARE) {
                          this.lastRoomState.state = 'prepare';
                        } else if (sig.signalType === MATCH_SIGNALS.MATCH_ENDED) {
                          this.lastRoomState.state = 'ended';
                        }
                      }
                      if (
                        sig.signalType === MATCH_SIGNALS.CLOCK_UPDATED_SECONDS ||
                        sig.signalType === MATCH_SIGNALS.COMMAND_ACK
                      ) {
                        continue;
                      }
                      if (!this._seenReplaySignalIds) this._seenReplaySignalIds = new Set();
                      const key = sig.signalId ? `id_${sig.signalId}` : `${sig.signalType}_${sig.frameId}`;
                      if (!this._seenReplaySignalIds.has(key)) {
                        this._seenReplaySignalIds.add(key);
                        newSignals.push(sig);
                      }
                    }
                  }
                  if (this.botTunnelManager && this.isWorker) {
                    this.botTunnelManager.onServerPhysicsFrame(
                      this.cachedSnapshot,
                      this.lastServerTick,
                      this.lastRoomState?.state || 'playing'
                    );
                  }
                  this.hostReplayRingBuffer?.recordFrame(
                    this.lastServerTick,
                    this.cachedSnapshot,
                    newSignals,
                    null,
                    null,
                    globalPayload.physics.acknowledgedControls || null
                  );
                }
              }
            } catch (err) {
              console.warn('[HostServerWorker] Failed to decode authoritative frame packet:', err);
            }
          }
        } else {
          const ch = this.channelIdToChannel.get(channelId);
          if (ch) {
            if (typeof ch.send === 'function') ch.send(packet);
            else if (typeof ch.sendServerState === 'function') ch.sendServerState(packet);
          }
        }
        break;
      }

      case 'requestResponse': {
        const { reqId, result } = data;
        const req = this.pendingRequests.get(reqId);
        if (req) {
          this.pendingRequests.delete(reqId);
          req.resolve(result);
        }
        break;
      }

      default:
        break;
    }
  }

  sendEnvelope(type, payload = {}, transfer = [], seqOverride = null) {
    if (
      type === HOST_WORKER_MSG_TYPES.MATCH_START_REQUEST ||
      type === HOST_WORKER_MSG_TYPES.ROOM_CREATE
    ) {
      this.hostReplayRingBuffer?.clear();
      this._seenReplaySignalIds?.clear();
    }
    const seq = seqOverride ?? ++this.reqId;
    const envelope = createWorkerEnvelope(type, payload, seq);
    if (this.isWorker && this.worker) {
      this.worker.postMessage(envelope, transfer);
    } else if (this.fallbackManager) {
      routeProtocolMessageInWorker({
        sim: this.fallbackSim,
        physicsManager: this.fallbackPhysics,
        sessionManager: this.fallbackSession,
        matchManager: this.fallbackManager,
        dataHandler: this.fallbackDataHandler,
        postEnvelope: (replyEnv) => this._handleWorkerMessage(replyEnv)
      }, envelope);
    }
    return envelope;
  }

  _postCommand(type, data = {}, transfer = []) {
    if (this.isWorker && this.worker) this.worker.postMessage({ type, ...data }, transfer);
  }

  _sendRequest(type, data = {}) {
    return new Promise((resolve) => {
      const reqId = ++this.reqId;
      this.pendingRequests.set(reqId, { resolve });
      this._postCommand(type, { reqId, ...data });
    });
  }

  addClientChannel(channel, overrideId = null) {
    if (!channel) return null;
    if (this.channelMap.has(channel)) return this.channelMap.get(channel);
    const channelId = overrideId || `peer_${this.nextChannelId++}`;
    this.channels.push(channel);
    this.channelMap.set(channel, channelId);
    this.channelIdToChannel.set(channelId, channel);

    const origPacketReceived = channel.onPacketReceived;
    channel.onPacketReceived = (packet) => {
      origPacketReceived?.(packet);
      if (this.isWorker && this.worker) {
        this._postCommand('channel_packet', { channelId, packet });
      } else if (this.fallbackDataHandler) {
        this.fallbackDataHandler.handleIncomingPacket(channelId, packet, performance.now());
      }
    };

    if (this.isWorker && this.worker) {
      this._postCommand('registerChannel', {
        channelId,
        playerName: channel.peerName || 'Player',
        visualId: channel.visualId || 'octane',
        colorSlot: channel.colorSlot ?? 0
      });
    } else if (this.fallbackDataHandler) {
      this.fallbackDataHandler.registerChannel(channelId, {
        send: (pkt) => { if (typeof channel.send === 'function') channel.send(pkt); }
      });
    }
    return channelId;
  }

  removeClientChannel(channel) {
    const channelId = this.channelMap.get(channel);
    if (!channelId) return;
    const idx = this.channels.indexOf(channel);
    if (idx !== -1) this.channels.splice(idx, 1);
    this.channelMap.delete(channel);
    this.channelIdToChannel.delete(channelId);

    if (this.isWorker && this.worker) {
      this._postCommand('removeChannel', { channelId });
    } else if (this.fallbackDataHandler) {
      this.fallbackDataHandler.unregisterChannel(channelId);
      this.fallbackManager?.removePlayerSession(channelId);
    }
  }

  ensureCar(carIndex, team = 1, visualId = 'octane') {
    if (this.isWorker && this.worker) this._postCommand('ensureCar', { carIndex, team, visualId });
    else this.fallbackPhysics?.registerCarEntity(carIndex, team, visualId);
  }

  removeCar(carIndex) {
    if (this.isWorker && this.worker) this._postCommand('removeCar', { carIndex });
    else this.fallbackPhysics?.unregisterCarEntity(carIndex);
  }

  setCarControls(carIndex, controls) {
    if (this.isWorker && this.worker) this._postCommand('setCarControls', { carIndex, controls });
    else this.fallbackPhysics?.setDirectCarControls(carIndex, controls);
  }

  pauseMatch(paused = true) {
    if (this.isWorker && this.worker) this._postCommand('pauseMatch', { paused: Boolean(paused) });
    else this.fallbackManager?.setPaused(Boolean(paused));
  }

  notifyPlayerJoined(
    entityId,
    name,
    role = 'player',
    channelId = null,
    visualId = 'octane',
    colorSlot = 0,
    hitboxId = null,
    paintFinish = undefined,
    boostVisual = undefined,
    boostAudio = undefined
  ) {
    const chId = channelId || (entityId === 0 ? 'host' : `peer_${entityId}`);
    if (this.isWorker && this.worker) {
      this._postCommand('notifyPlayerJoined', {
        entityId,
        name,
        role,
        channelId: chId,
        visualId,
        colorSlot,
        hitboxId,
        paintFinish,
        boostVisual,
        boostAudio
      });
    } else {
      this.fallbackManager?.assignPlayerSlot(
        chId,
        name,
        role,
        typeof entityId === 'number' && entityId >= 0 ? entityId % 2 : null,
        {
          visualId,
          hitboxId,
          colorSlot,
          paintFinish,
          boostVisual,
          boostAudio
        },
        colorSlot
      );
    }
  }

  startMatch(durationSeconds) {
    this.hostReplayRingBuffer?.clear();
    this._seenReplaySignalIds?.clear();
    if (this.isWorker && this.worker) this._postCommand('startMatch', { durationSeconds });
    else this.fallbackManager?.startMatch(durationSeconds);
  }

  forceStartMatch(durationSeconds) {
    this.hostReplayRingBuffer?.clear();
    this._seenReplaySignalIds?.clear();
    if (this.isWorker && this.worker) this._postCommand('forceStartMatch', { durationSeconds });
    else this.fallbackManager?.forceStartMatch(durationSeconds);
  }

  initiateMatchPrepare(durationSeconds) {
    this.hostReplayRingBuffer?.clear();
    this._seenReplaySignalIds?.clear();
    if (this.isWorker && this.worker) this._postCommand('initiateMatchPrepare', { durationSeconds });
    else this.fallbackManager?.initiateMatchPrepare(durationSeconds);
  }

  setGameMode(gameMode) {
    if (this.isWorker && this.worker) this._postCommand('setGameMode', { gameMode });
    else this.fallbackManager?.setGameMode(gameMode);
  }

  setBotFillMode(botFillMode) {
    if (this.isWorker && this.worker) this._postCommand('setBotFillMode', { botFillMode });
    else this.fallbackManager?.setBotFillMode(botFillMode);
  }

  addBotPlayer(team = 1, botName = null, visualId = 'octane') {
    if (this.isWorker && this.worker) this._postCommand('addBotPlayer', { team, botName, visualId });
    else this.fallbackManager?.addBotPlayer(team, botName, visualId);
  }

  setLoadout(
    sessionId,
    visualId,
    colorSlot = 0,
    hitboxId = null,
    extraOrPaintFinish = null,
    boostVisualArg = null,
    boostAudioArg = null
  ) {
    const extraLoadout =
      extraOrPaintFinish && typeof extraOrPaintFinish === 'object'
        ? extraOrPaintFinish
        : extraOrPaintFinish !== null || boostVisualArg !== null || boostAudioArg !== null
        ? {
            paintFinish: extraOrPaintFinish ?? undefined,
            boostVisual: boostVisualArg ?? undefined,
            boostAudio: boostAudioArg ?? undefined,
          }
        : null;
    if (this.isWorker && this.worker) {
      this._postCommand('setLoadout', { sessionId, visualId, colorSlot, hitboxId, extraLoadout });
    } else {
      this.fallbackManager?.updatePlayerLoadout(sessionId || 'host', visualId, colorSlot, hitboxId, extraLoadout);
    }
  }

  switchRoleTeam(sessionId, role, team) {
    if (this.isWorker && this.worker) this._postCommand('switchRoleTeam', { sessionId, role, team });
    else this.fallbackManager?.switchPlayerRoleOrTeam(sessionId || 'host', role, team);
  }

  setSkipReplayByDefault(enabled) {
    if (this.isWorker && this.worker) this._postCommand('setSkipReplayByDefault', { enabled: Boolean(enabled) });
    else if (this.fallbackManager) this.fallbackManager.skipReplayByDefault = Boolean(enabled);
  }

  startTrainingMode() {
    if (this.isWorker && this.worker) this._postCommand('startTrainingMode', {});
    else this.fallbackManager?.startTrainingMode();
  }

  setLobbyMode(enabled = true, options = {}) {
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.LOBBY_MODE_SET, { enabled: Boolean(enabled), ...options });
  }

  setGhostCarConfig(carIndex, interactWithBall = false, interactWithCars = false, opacity = undefined) {
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.GHOST_CAR_CONFIG, {
      carIndex,
      interactWithBall: Boolean(interactWithBall),
      interactWithCars: Boolean(interactWithCars),
      opacity
    });
  }

  enterPodiumMode(winner = 0) {
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.PODIUM_ENTER, { winner });
  }

  requestReplayWindow(count = 360) {
    return new Promise((resolve) => {
      const seq = ++this.reqId;
      this.pendingRequests.set(seq, { resolve });
      this.sendEnvelope(HOST_WORKER_MSG_TYPES.REPLAY_WINDOW_REQUEST, { reqId: seq, count }, [], seq);
    });
  }

  requestFullReplayExport() {
    return new Promise((resolve) => {
      const seq = ++this.reqId;
      this.pendingRequests.set(seq, { resolve });
      this.sendEnvelope(HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_REQUEST, { reqId: seq }, [], seq);
    });
  }

  configureDiagnosticFleet(enabled = true, anchorMode = 'z_hover') {
    if (this.isWorker && this.worker) {
      this._postCommand('configureDiagnosticFleet', { enabled: Boolean(enabled), anchorMode });
    }
  }

  update() {
    if (!this.isWorker) {
      stepHostServerFallback(this);
    }
  }

  destroy() {
    this.active = false;
    this.botTunnelManager?.destroy?.();
    if (this.isWorker && this.worker) {
      this.sendEnvelope(HOST_WORKER_MSG_TYPES.WORKER_DESTROY, {});
      try {
        this.worker.terminate();
      } catch (err) {
        console.warn('[HostServerWorker] Error terminating worker:', err);
      }
      this.worker = null;
    }
    destroyHostServerFallback(this);
    this.channels = [];
    this.channelMap.clear();
    this.channelIdToChannel.clear();
    this.pendingRequests.clear();
    this.envelopeListeners.clear();
  }
}

export default AuthoritativeServerHost;
