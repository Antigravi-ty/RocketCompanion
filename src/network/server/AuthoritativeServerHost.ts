import {
  createBoostPadEdgeTracker,
  type BoostPadEdgeTracker,
  type CarControlsInput,
} from '../protocol/GlobalPayloadCodec.ts';
import { createHostSimProxy } from './HostSimProxy.ts';
import { createDefaultHostChannel } from './HostLoopbackChannel.ts';
import {
  HOST_WORKER_MSG_TYPES,
  createWorkerEnvelope,
  type WorkerRoomStateSummary,
} from './HostWorkerMessageRouter.ts';
import {
  HostServerFallbackSubController,
  processHostLoopbackChannelPacket,
  spawnAuthoritativeWorkerWithRetry,
  prewarmAuthoritativeServerWorker,
} from './HostServerFallbackSubController.ts';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../replay/ReplayRingBuffer.ts';
import { BotTunnelManager, prewarmBotInferenceWorker } from '../bot/BotTunnelManager.ts';

export class AuthoritativeServerHost {
  static async prewarmWorkers(): Promise<{ serverWorker: boolean; botWorker: boolean }> {
    const [serverWorker, botWorker] = await Promise.all([
      prewarmAuthoritativeServerWorker().catch(() => false),
      prewarmBotInferenceWorker().catch(() => false),
    ]);
    return { serverWorker, botWorker };
  }
  options: Record<string, any>;
  channels: any[];
  channelMap: Map<any, string>;
  channelIdToChannel: Map<string, any>;
  nextChannelId: number;
  isWorker: boolean;
  worker: Worker | null;
  botTunnelManager: BotTunnelManager;
  fallbackSubController: HostServerFallbackSubController;
  active: boolean;
  cachedSnapshot: Float32Array;
  boostPadEdgeTracker: BoostPadEdgeTracker;
  hostReplayRingBuffer: any;
  lastServerTick: number;
  lastGoal: number;
  lastRoomState: WorkerRoomStateSummary | Record<string, any> | null;
  headerViewInstance: any;
  pendingRequests: Map<number, { resolve: (val: any) => void }>;
  envelopeListeners: Set<(envelope: any) => void>;
  reqId: number;
  sim: ReturnType<typeof createHostSimProxy>;
  hostChannel: Record<string, any>;
  _seenReplaySignalIds: Set<string>;
  _loggedFallbackSend?: boolean;

  constructor(channel: any = null, options: Record<string, any> = {}) {
    if (
      channel &&
      typeof channel === 'object' &&
      !channel.send &&
      !channel.sendClientInput &&
      !channel.inboundQueue
    ) {
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
    this.fallbackSubController = new HostServerFallbackSubController();

    this.active = false;
    this.cachedSnapshot = new Float32Array(448);
    this.boostPadEdgeTracker = createBoostPadEdgeTracker();
    const initialBufferMode = options.startAsMatch
      ? REPLAY_BUFFER_MODES.COUNTDOWN_MATCH
      : REPLAY_BUFFER_MODES.COUNTUP_FIFO;
    this.hostReplayRingBuffer = new ReplayRingBuffer({
      mode: initialBufferMode,
      capacityTicks: options.replayCapacityTicks,
    });
    this.lastServerTick = 0;
    this.lastGoal = 0;
    this.lastRoomState = null;
    this._seenReplaySignalIds = new Set();

    this.headerViewInstance = null;
    this.pendingRequests = new Map();
    this.envelopeListeners = new Set();
    this.reqId = 0;

    this.sim = createHostSimProxy(this);
    this.hostChannel = channel || this._createDefaultHostChannel();
    this.channelMap.set(this.hostChannel, 'host');
    this.channelIdToChannel.set('host', this.hostChannel);
  }

  get fallbackSim() {
    return this.fallbackSubController.sim;
  }
  get fallbackPhysics() {
    return this.fallbackSubController.physicsManager;
  }
  get fallbackSession() {
    return this.fallbackSubController.sessionManager;
  }
  get fallbackManager() {
    return this.fallbackSubController.matchManager;
  }
  get fallbackDataHandler() {
    return this.fallbackSubController.dataHandler;
  }

  _createDefaultHostChannel() {
    return createDefaultHostChannel(this);
  }

  get channel() {
    return this.hostChannel;
  }
  set channel(ch: Record<string, any>) {
    if (ch && ch !== this.hostChannel) {
      this.hostChannel = ch;
      this.addClientChannel(ch, 'host');
    }
  }

  async init(): Promise<this> {
    if (!this.isWorker) {
      console.warn(
        `[HostServerWorker] Initializing in-memory server fallback (Worker available: ${typeof Worker !== 'undefined'}, forceFallback: ${Boolean(this.options.forceFallback)}).`
      );
      return this._initFallback();
    }

    await spawnAuthoritativeWorkerWithRetry({
      options: this.options,
      getWorker: () => this.worker,
      setWorker: (w) => {
        this.worker = w;
      },
      onMessage: (data) => this._handleWorkerMessage(data),
      sendInitEnvelope: (payload) =>
        this.sendEnvelope(HOST_WORKER_MSG_TYPES.WORKER_INIT, payload),
      onWorkerReady: (res) => {
        this.active = true;
        if (res.snapshot) {
          const copyLen = Math.min(this.cachedSnapshot.length, res.snapshot.length);
          this.cachedSnapshot
            .subarray(0, copyLen)
            .set(
              res.snapshot.subarray
                ? res.snapshot.subarray(0, copyLen)
                : res.snapshot.slice(0, copyLen)
            );
        }
        if (res.tickCount !== undefined) this.lastServerTick = res.tickCount;
        if (res.roomState) {
          this.lastRoomState = res.roomState;
          this.botTunnelManager?.init?.();
          this.botTunnelManager?.syncFromRoomState?.(res.roomState);
        }
      },
      onFallbackToMainThread: async () => {
        this.isWorker = false;
        await this._initFallback();
      },
    });
    return this;
  }

  async _initFallback(): Promise<this> {
    const res = await this.fallbackSubController.init(this.options, this.hostChannel);
    this.active = true;
    this.cachedSnapshot.subarray(0, res.snapshot.length).set(res.snapshot);
    this.lastServerTick = res.serverTick;
    this.lastRoomState = res.roomState;
    this.botTunnelManager?.init?.();
    this.botTunnelManager?.syncFromRoomState?.(this.lastRoomState);
    return this;
  }

  addEnvelopeListener(fn: (envelope: any) => void): () => void {
    if (typeof fn === 'function') {
      this.envelopeListeners.add(fn);
      return () => this.envelopeListeners.delete(fn);
    }
    return () => {};
  }

  _notifyEnvelopeListeners(envelope: any): void {
    for (const listener of this.envelopeListeners) {
      try {
        listener(envelope);
      } catch (err) {
        console.warn('[HostServerWorker] Error in envelope listener:', err);
      }
    }
  }

  _handleWorkerMessage(data: any): void {
    if (!data) return;

    if (data.type && data.payload !== undefined) {
      if (data.type === HOST_WORKER_MSG_TYPES.ROOM_STATE_SYNC) {
        this.lastRoomState = data.payload;
        this.botTunnelManager?.syncFromRoomState?.(data.payload);
      }
      if (data.seq && this.pendingRequests.has(data.seq)) {
        const req = this.pendingRequests.get(data.seq)!;
        this.pendingRequests.delete(data.seq);
        req.resolve(data.payload);
      }
      this._notifyEnvelopeListeners(data);
    }

    switch (data.type) {
      case 'channel_packet': {
        const { channelId, packet } = data;
        if (channelId === 'host') {
          processHostLoopbackChannelPacket(this, packet);
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

  sendEnvelope(
    type: string,
    payload: Record<string, any> = {},
    transfer: Transferable[] = [],
    seqOverride: number | null = null
  ) {
    if (type === HOST_WORKER_MSG_TYPES.MATCH_START_REQUEST) {
      this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
      this.hostReplayRingBuffer?.clear();
      this._seenReplaySignalIds?.clear();
    } else if (type === HOST_WORKER_MSG_TYPES.ROOM_CREATE) {
      this.hostReplayRingBuffer?.configureMode?.(
        payload.startAsMatch
          ? REPLAY_BUFFER_MODES.COUNTDOWN_MATCH
          : REPLAY_BUFFER_MODES.COUNTUP_FIFO,
        payload.replayCapacityTicks || null
      );
      this.hostReplayRingBuffer?.clear();
      this._seenReplaySignalIds?.clear();
    }
    const seq = seqOverride ?? ++this.reqId;
    const envelope = createWorkerEnvelope(type, payload, seq);
    if (this.isWorker && this.worker) {
      this.worker.postMessage(envelope, transfer);
    } else {
      this.fallbackSubController.routeEnvelope(envelope, (replyEnv) =>
        this._handleWorkerMessage(replyEnv)
      );
    }
    return envelope;
  }

  _postCommand(type: string, data: Record<string, any> = {}, transfer: Transferable[] = []): void {
    if (this.isWorker && this.worker) this.worker.postMessage({ type, ...data }, transfer);
  }

  _sendRequest(type: string, data: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve) => {
      const reqId = ++this.reqId;
      this.pendingRequests.set(reqId, { resolve });
      this._postCommand(type, { reqId, ...data });
    });
  }

  addClientChannel(channel: any, overrideId: string | null = null): string | null {
    if (!channel) return null;
    if (this.channelMap.has(channel)) return this.channelMap.get(channel)!;
    const channelId = overrideId || `peer_${this.nextChannelId++}`;
    this.channels.push(channel);
    this.channelMap.set(channel, channelId);
    this.channelIdToChannel.set(channelId, channel);

    const origPacketReceived = channel.onPacketReceived;
    channel.onPacketReceived = (packet: any) => {
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
        colorSlot: channel.colorSlot ?? 0,
      });
    } else if (this.fallbackDataHandler) {
      this.fallbackDataHandler.registerChannel(channelId, {
        send: (pkt) => {
          if (typeof channel.send === 'function') channel.send(pkt);
        },
      });
    }
    return channelId;
  }

  removeClientChannel(channel: any): void {
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

  ensureCar(carIndex: number, team = 1, visualId = 'octane'): void {
    if (this.isWorker && this.worker) this._postCommand('ensureCar', { carIndex, team, visualId });
    else this.fallbackPhysics?.registerCarEntity(carIndex, team, visualId);
  }

  removeCar(carIndex: number): void {
    if (this.isWorker && this.worker) this._postCommand('removeCar', { carIndex });
    else this.fallbackPhysics?.unregisterCarEntity(carIndex);
  }

  setCarControls(carIndex: number, controls: CarControlsInput): void {
    if (this.isWorker && this.worker) this._postCommand('setCarControls', { carIndex, controls });
    else this.fallbackPhysics?.setDirectCarControls(carIndex, controls);
  }

  pauseMatch(paused = true): void {
    if (this.isWorker && this.worker)
      this._postCommand('pauseMatch', { paused: Boolean(paused) });
    else this.fallbackManager?.setPaused(Boolean(paused));
  }

  requestResumeWithCountdown(countdownSeconds = 5): void {
    if (this.isWorker && this.worker)
      this._postCommand('requestResumeWithCountdown', { countdownSeconds });
    else this.fallbackManager?.lifecycle?.requestResumeWithCountdown?.(countdownSeconds);
  }

  notifyPlayerJoined(
    entityId: number,
    name: string,
    role = 'player',
    channelId: string | null = null,
    visualId = 'octane',
    colorSlot = 0,
    hitboxId: string | null = null,
    paintFinish?: string,
    boostVisual?: string,
    boostAudio?: string
  ): void {
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
        boostAudio,
      });
    } else {
      this.fallbackManager?.assignPlayerSlot(
        chId,
        name,
        role,
        typeof entityId === 'number' && entityId >= 0 ? entityId % 2 : null,
        { visualId, hitboxId, colorSlot, paintFinish, boostVisual, boostAudio },
        colorSlot
      );
    }
  }

  private _resetHostReplayTracking(): void {
    this.hostReplayRingBuffer?.clear();
    this._seenReplaySignalIds?.clear();
  }

  startMatch(durationSeconds?: number): void {
    this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this._resetHostReplayTracking();
    if (this.isWorker && this.worker) this._postCommand('startMatch', { durationSeconds });
    else this.fallbackManager?.startMatch(durationSeconds);
  }

  forceStartMatch(durationSeconds?: number): void {
    this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this._resetHostReplayTracking();
    if (this.isWorker && this.worker) this._postCommand('forceStartMatch', { durationSeconds });
    else this.fallbackManager?.forceStartMatch(durationSeconds);
  }

  initiateMatchPrepare(durationSeconds?: number): void {
    this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this._resetHostReplayTracking();
    if (this.isWorker && this.worker) this._postCommand('initiateMatchPrepare', { durationSeconds });
    else this.fallbackManager?.initiateMatchPrepare(durationSeconds);
  }

  setGameMode(gameMode: string, durationSeconds: number | null = null): void {
    if (this.isWorker && this.worker) this._postCommand('setGameMode', { gameMode, durationSeconds });
    else this.fallbackManager?.setGameMode(gameMode, durationSeconds);
  }

  setBotFillMode(botFillMode: string): void {
    if (this.isWorker && this.worker) this._postCommand('setBotFillMode', { botFillMode });
    else this.fallbackManager?.setBotFillMode(botFillMode);
  }

  addBotPlayer(team = 1, botName: string | null = null, visualId = 'octane'): void {
    if (this.isWorker && this.worker) this._postCommand('addBotPlayer', { team, botName, visualId });
    else this.fallbackManager?.addBotPlayer(team, botName, visualId);
  }

  setLoadout(
    sessionId: string | null,
    visualId: string,
    colorSlot = 0,
    hitboxId: string | null = null,
    extraOrPaintFinish: any = null,
    boostVisualArg: string | null = null,
    boostAudioArg: string | null = null
  ): void {
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
      this.fallbackManager?.updatePlayerLoadout(
        sessionId || 'host',
        visualId,
        colorSlot,
        hitboxId,
        extraLoadout
      );
    }
  }

  switchRoleTeam(sessionId: string | null, role: string, team: number): void {
    if (this.isWorker && this.worker) this._postCommand('switchRoleTeam', { sessionId, role, team });
    else this.fallbackManager?.switchPlayerRoleOrTeam(sessionId || 'host', role, team);
  }

  setSkipReplayByDefault(enabled: boolean): void {
    if (this.isWorker && this.worker)
      this._postCommand('setSkipReplayByDefault', { enabled: Boolean(enabled) });
    else if (this.fallbackManager) this.fallbackManager.domain.skipReplayByDefault = Boolean(enabled);
  }

  setDisableGoalReset(disabled: boolean): void {
    if (this.isWorker && this.worker)
      this._postCommand('setDisableGoalReset', { disabled: Boolean(disabled) });
    else if (this.fallbackManager) this.fallbackManager.domain.trainingDisableGoalReset = Boolean(disabled);
  }

  startTrainingMode(options: Record<string, any> = {}): void {
    this.hostReplayRingBuffer?.configureMode?.(
      REPLAY_BUFFER_MODES.COUNTUP_FIFO,
      options.replayCapacityTicks || null
    );
    if (this.isWorker && this.worker) this._postCommand('startTrainingMode', options);
    else this.fallbackManager?.startTrainingMode(options);
  }

  configureTrainingRuleset(options: Record<string, any> = {}): void {
    if (typeof options.fifoDurationSeconds === 'number' && options.fifoDurationSeconds > 0) {
      this.hostReplayRingBuffer?.configureMode(
        REPLAY_BUFFER_MODES.COUNTUP_FIFO,
        Math.round(options.fifoDurationSeconds * 120)
      );
    }
    if (this.isWorker && this.worker) this._postCommand('configureTrainingRuleset', options);
    else this.fallbackManager?.configureTrainingRuleset(options);
  }

  enterStateOnlyMode(stateSnapshot?: Float32Array | number[] | null, cursorTick?: number): void {
    const snapCopy = stateSnapshot ? Array.from<number>(stateSnapshot as any) : null;
    if (this.isWorker && this.worker)
      this._postCommand('enterStateOnlyMode', { stateSnapshot: snapCopy, cursorTick });
    else this.fallbackManager?.enterStateOnlyMode(stateSnapshot, cursorTick);
  }

  beginInterveneCountdown(countdownSeconds = 3, stateSnapshot?: Float32Array | number[] | null): void {
    const snapCopy = stateSnapshot ? Array.from<number>(stateSnapshot as any) : null;
    if (this.isWorker && this.worker)
      this._postCommand('beginInterveneCountdown', { countdownSeconds, stateSnapshot: snapCopy });
    else this.fallbackManager?.beginInterveneCountdown(countdownSeconds, stateSnapshot);
  }

  resumePhysicsFromState(stateSnapshot?: Float32Array | number[] | null, resumeTick?: number): void {
    const snapCopy = stateSnapshot ? Array.from<number>(stateSnapshot as any) : null;
    if (this.isWorker && this.worker)
      this._postCommand('resumePhysicsFromState', { stateSnapshot: snapCopy, resumeTick });
    else this.fallbackManager?.resumePhysicsFromState(stateSnapshot, resumeTick);
  }

  setLobbyMode(enabled = true, options: Record<string, any> = {}) {
    if (enabled) {
      this.hostReplayRingBuffer?.configureMode?.(
        REPLAY_BUFFER_MODES.COUNTUP_FIFO,
        options.replayCapacityTicks || null
      );
    }
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.LOBBY_MODE_SET, {
      enabled: Boolean(enabled),
      ...options,
    });
  }

  enterLobbyMode(options: Record<string, any> = {}) {
    return this.setLobbyMode(true, { forceEnterLobby: true, ...options });
  }

  setGhostCarConfig(
    carIndex: number,
    interactWithBall = false,
    interactWithCars = false,
    opacity?: number
  ) {
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.GHOST_CAR_CONFIG, {
      carIndex,
      interactWithBall: Boolean(interactWithBall),
      interactWithCars: Boolean(interactWithCars),
      opacity,
    });
  }

  enterPodiumMode(winner = 0) {
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.PODIUM_ENTER, { winner });
  }

  requestReplayWindow(count = 360): Promise<any> {
    return new Promise((resolve) => {
      const seq = ++this.reqId;
      this.pendingRequests.set(seq, { resolve });
      this.sendEnvelope(HOST_WORKER_MSG_TYPES.REPLAY_WINDOW_REQUEST, { reqId: seq, count }, [], seq);
    });
  }

  requestFullReplayExport(): Promise<any> {
    return new Promise((resolve) => {
      const seq = ++this.reqId;
      this.pendingRequests.set(seq, { resolve });
      this.sendEnvelope(HOST_WORKER_MSG_TYPES.REPLAY_FULL_EXPORT_REQUEST, { reqId: seq }, [], seq);
    });
  }

  configureDiagnosticFleet(enabled = true, anchorMode = 'z_hover'): void {
    if (this.isWorker && this.worker) {
      this._postCommand('configureDiagnosticFleet', { enabled: Boolean(enabled), anchorMode });
    }
  }

  update(): void {
    if (!this.isWorker) {
      const res = this.fallbackSubController.step();
      if (res) {
        this.cachedSnapshot.subarray(0, res.snapshot.length).set(res.snapshot);
        this.lastServerTick = res.serverTick;
        this.lastRoomState = res.roomState;
        this.botTunnelManager?.syncFromRoomState?.(this.lastRoomState);
        this.botTunnelManager?.onServerPhysicsFrame?.(
          this.cachedSnapshot,
          this.lastServerTick,
          res.matchState
        );
        this.hostReplayRingBuffer?.recordFrame(this.lastServerTick, this.cachedSnapshot);
      }
    }
  }

  destroy(): void {
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
    this.fallbackSubController.destroy();
    this.channels = [];
    this.channelMap.clear();
    this.channelIdToChannel.clear();
    this.pendingRequests.clear();
    this.envelopeListeners.clear();
  }
}

export default AuthoritativeServerHost;
