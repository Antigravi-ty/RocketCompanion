import { createBoostPadEdgeTracker, type BoostPadEdgeTracker, type CarControlsInput } from '../protocol/GlobalPayloadCodec.ts';
import { createHostSimProxy, type HostSimRestoreStateResult } from './HostSimProxy.ts';
import {
  HOST_WORKER_MSG_TYPES,
  createWorkerEnvelope,
  type WorkerEnvelope,
} from '../protocol/HostWorkerProtocol.ts';
import type { WorkerRoomStateSummary, HostWorkerInitOptions } from './HostWorkerMessageRouter.ts';
import {
  HostServerFallbackSubController,
  spawnAuthoritativeWorkerWithRetry,
  prewarmAuthoritativeServerWorker,
} from './HostServerFallbackSubController.ts';
import {
  HostClientChannelRegistry,
  type HostClientChannelPort,
  type HostWorkerEnvelopeMessage,
} from './HostClientChannelRegistry.ts';
import { ReplayRingBuffer, REPLAY_BUFFER_MODES } from '../../replay/ReplayRingBuffer.ts';
import { BotTunnelManager, prewarmBotInferenceWorker } from '../bot/BotTunnelManager.ts';
import type { ArenaHeaderView } from '../../physics/RocketSimStateViews.ts';
import type { ExtraLoadoutConfig } from './match/matchLoadoutAndSpawnPipeline.ts';
import type { AuthoritativePhysicsSimPort } from './authoritativePhysicsStepPipeline.ts';

export type { HostClientChannelPort, HostWorkerEnvelopeMessage };

export interface AuthoritativeServerHostOptions extends HostWorkerInitOptions {
  forceFallback?: boolean;
  replayCapacityTicks?: number | null;
  fifoDurationSeconds?: number;
}

export class AuthoritativeServerHost {
  static async prewarmWorkers(): Promise<{ serverWorker: boolean; botWorker: boolean }> {
    const [serverWorker, botWorker] = await Promise.all([
      prewarmAuthoritativeServerWorker().catch(() => false),
      prewarmBotInferenceWorker().catch(() => false),
    ]);
    return { serverWorker, botWorker };
  }

  options: AuthoritativeServerHostOptions;
  channelRegistry: HostClientChannelRegistry;
  isWorker: boolean;
  worker: Worker | null = null;
  botTunnelManager: BotTunnelManager;
  fallbackSubController = new HostServerFallbackSubController();
  active = false;
  cachedSnapshot = new Float32Array(448);
  boostPadEdgeTracker: BoostPadEdgeTracker = createBoostPadEdgeTracker();
  hostReplayRingBuffer: ReplayRingBuffer;
  lastServerTick = 0;
  lastGoal = 0;
  lastRoomState: Partial<WorkerRoomStateSummary> | null = null;
  headerViewInstance: ArenaHeaderView | null = null;
  sim: ReturnType<typeof createHostSimProxy>;
  _seenReplaySignalIds = new Set<string>();
  _loggedFallbackSend?: boolean;

  constructor(
    channel: HostClientChannelPort | AuthoritativeServerHostOptions | null = null,
    options: AuthoritativeServerHostOptions = {}
  ) {
    if (
      channel &&
      typeof channel === 'object' &&
      !('send' in channel && typeof channel.send === 'function') &&
      !('sendClientInput' in channel && typeof channel.sendClientInput === 'function') &&
      !('inboundQueue' in channel && Array.isArray(channel.inboundQueue))
    ) {
      options = channel as AuthoritativeServerHostOptions;
      channel = null;
    }
    this.options = { ...options };
    this.isWorker = typeof Worker !== 'undefined' && !options.forceFallback;
    this.botTunnelManager = new BotTunnelManager(this);

    const initialBufferMode = options.startAsMatch
      ? REPLAY_BUFFER_MODES.COUNTDOWN_MATCH
      : REPLAY_BUFFER_MODES.COUNTUP_FIFO;
    this.hostReplayRingBuffer = new ReplayRingBuffer({
      mode: initialBufferMode,
      capacityTicks: options.replayCapacityTicks ?? undefined,
    });

    this.sim = createHostSimProxy(this);
    this.channelRegistry = new HostClientChannelRegistry(
      this,
      channel as HostClientChannelPort | null
    );
  }

  get fallbackSim(): AuthoritativePhysicsSimPort | null {
    return this.fallbackSubController.sim as unknown as AuthoritativePhysicsSimPort | null;
  }
  get fallbackPhysics() { return this.fallbackSubController.physicsManager; }
  get fallbackSession() { return this.fallbackSubController.sessionManager; }
  get fallbackManager() { return this.fallbackSubController.matchManager; }
  get fallbackDataHandler() { return this.fallbackSubController.dataHandler; }

  get hostChannel(): HostClientChannelPort { return this.channelRegistry.hostChannel; }
  get channel(): HostClientChannelPort { return this.channelRegistry.hostChannel; }
  set channel(ch: HostClientChannelPort) {
    if (ch && ch !== this.channelRegistry.hostChannel) {
      this.channelRegistry.hostChannel = ch;
      this.addClientChannel(ch, 'host');
    }
  }

  routeFallbackEnvelope(
    envelope: WorkerEnvelope,
    onReply: (replyEnv: HostWorkerEnvelopeMessage) => void
  ): void {
    this.fallbackSubController.routeEnvelope(envelope, onReply);
  }

  async init(): Promise<this> {
    if (!this.isWorker) {
      return this._initFallback();
    }

    await spawnAuthoritativeWorkerWithRetry({
      options: this.options,
      getWorker: () => this.worker,
      setWorker: (w) => { this.worker = w; },
      onMessage: (data) => this._handleWorkerMessage(data as HostWorkerEnvelopeMessage),
      sendInitEnvelope: (payload) => this.sendEnvelope(HOST_WORKER_MSG_TYPES.WORKER_INIT, payload),
      onWorkerReady: (res) => {
        this.active = true;
        if (res.snapshot) {
          const snapArr = res.snapshot instanceof Float32Array ? res.snapshot : new Float32Array(res.snapshot);
          const copyLen = Math.min(this.cachedSnapshot.length, snapArr.length);
          this.cachedSnapshot.subarray(0, copyLen).set(snapArr.subarray(0, copyLen));
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
    const res = await this.fallbackSubController.init(this.options, this.channelRegistry.hostChannel);
    this.active = true;
    this.cachedSnapshot.subarray(0, res.snapshot.length).set(res.snapshot);
    this.lastServerTick = res.serverTick;
    this.lastRoomState = res.roomState;
    this.botTunnelManager?.init?.();
    this.botTunnelManager?.syncFromRoomState?.(this.lastRoomState);
    return this;
  }

  addEnvelopeListener(fn: (envelope: HostWorkerEnvelopeMessage) => void): () => void {
    return this.channelRegistry.addEnvelopeListener(fn);
  }

  _handleWorkerMessage(data: HostWorkerEnvelopeMessage | null | undefined): void {
    this.channelRegistry.handleWorkerMessage(this, data);
  }

  sendEnvelope(
    type: string,
    payload: AuthoritativeServerHostOptions = {},
    transfer: Transferable[] = [],
    seqOverride: number | null = null
  ): WorkerEnvelope {
    return this.channelRegistry.sendEnvelope(this, type, payload, transfer, seqOverride);
  }

  _postCommand(type: string, data: Record<string, unknown> = {}, transfer: Transferable[] = []): void {
    if (this.isWorker && this.worker) {
      this.worker.postMessage({ type, ...data }, transfer);
    } else {
      this.fallbackSubController.routeEnvelope(
        createWorkerEnvelope(type, data, 0),
        (replyEnv) => this._handleWorkerMessage(replyEnv)
      );
    }
  }

  _sendRequest(type: string, data: Record<string, unknown> = {}): Promise<HostSimRestoreStateResult> {
    return this.channelRegistry.sendRequest(
      (cmdType, cmdData) => this._postCommand(cmdType, cmdData),
      type,
      data
    );
  }

  addClientChannel(channel: HostClientChannelPort | null | undefined, overrideId: string | null = null): string | null {
    return this.channelRegistry.addClientChannel(
      channel,
      overrideId,
      this.isWorker,
      this.worker,
      (type, data) => this._postCommand(type, data),
      this.fallbackDataHandler
    );
  }

  removeClientChannel(channel: HostClientChannelPort): void {
    this.channelRegistry.removeClientChannel(
      channel,
      this.isWorker,
      this.worker,
      (type, data) => this._postCommand(type, data),
      this.fallbackDataHandler,
      this.fallbackManager
    );
  }

  ensureCar(carIndex: number, team = 1, visualId = 'octane'): void {
    this._postCommand('ensureCar', { carIndex, team, visualId });
  }

  removeCar(carIndex: number): void {
    this._postCommand('removeCar', { carIndex });
  }

  setCarControls(carIndex: number, controls: CarControlsInput): void {
    this._postCommand('setCarControls', { carIndex, controls });
  }

  pauseMatch(paused = true): void {
    this._postCommand('pauseMatch', { paused: Boolean(paused) });
  }

  requestResumeWithCountdown(countdownSeconds = 5): void {
    this._postCommand('requestResumeWithCountdown', { countdownSeconds });
  }

  notifyPlayerJoined(
    entityId: number, name: string, role = 'player', channelId: string | null = null,
    visualId = 'octane', colorSlot = 0, hitboxId: string | null = null,
    paintFinish?: string, boostVisual?: string, boostAudio?: string
  ): void {
    const chId = channelId || (entityId === 0 ? 'host' : `peer_${entityId}`);
    this._postCommand('notifyPlayerJoined', {
      entityId, name, role, channelId: chId, visualId, colorSlot, hitboxId, paintFinish, boostVisual, boostAudio,
    });
  }

  private _resetHostReplayTracking(): void {
    this.hostReplayRingBuffer?.clear();
    this._seenReplaySignalIds?.clear();
  }

  startMatch(durationSeconds?: number): void {
    this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this._resetHostReplayTracking();
    this._postCommand('startMatch', { durationSeconds });
  }

  forceStartMatch(durationSeconds?: number): void {
    this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this._resetHostReplayTracking();
    this._postCommand('forceStartMatch', { durationSeconds });
  }

  initiateMatchPrepare(durationSeconds?: number): void {
    this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTDOWN_MATCH);
    this._resetHostReplayTracking();
    this._postCommand('initiateMatchPrepare', { durationSeconds });
  }

  setGameMode(gameMode: string, durationSeconds: number | null = null): void {
    this._postCommand('setGameMode', { gameMode, durationSeconds });
  }

  setBotFillMode(botFillMode: string): void {
    this._postCommand('setBotFillMode', { botFillMode });
  }

  addBotPlayer(team = 1, botName: string | null = null, visualId = 'octane'): void {
    this._postCommand('addBotPlayer', { team, botName, visualId });
  }

  setLoadout(
    sessionId: string | null, visualId: string, colorSlot = 0, hitboxId: string | null = null,
    extraOrPaintFinish: ExtraLoadoutConfig | string | null = null,
    boostVisualArg: string | null = null, boostAudioArg: string | null = null
  ): void {
    const extraLoadout: ExtraLoadoutConfig | null =
      extraOrPaintFinish && typeof extraOrPaintFinish === 'object'
        ? extraOrPaintFinish
        : extraOrPaintFinish !== null || boostVisualArg !== null || boostAudioArg !== null
          ? {
              paintFinish: typeof extraOrPaintFinish === 'string' ? extraOrPaintFinish : undefined,
              boostVisual: boostVisualArg ?? undefined,
              boostAudio: boostAudioArg ?? undefined,
            }
          : null;
    this._postCommand('setLoadout', { sessionId, visualId, colorSlot, hitboxId, extraLoadout });
  }

  switchRoleTeam(sessionId: string | null, role: string, team: number): void {
    this._postCommand('switchRoleTeam', { sessionId, role, team });
  }

  setSkipReplayByDefault(enabled: boolean): void {
    this._postCommand('setSkipReplayByDefault', { enabled: Boolean(enabled) });
  }

  setDisableGoalReset(disabled: boolean): void {
    this._postCommand('setDisableGoalReset', { disabled: Boolean(disabled) });
  }

  startTrainingMode(options: AuthoritativeServerHostOptions = {}): void {
    this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTUP_FIFO, options.replayCapacityTicks || null);
    this._postCommand('startTrainingMode', options);
  }

  configureTrainingRuleset(options: AuthoritativeServerHostOptions = {}): void {
    if (typeof options.fifoDurationSeconds === 'number' && options.fifoDurationSeconds > 0) {
      this.hostReplayRingBuffer?.configureMode(
        REPLAY_BUFFER_MODES.COUNTUP_FIFO, Math.round(options.fifoDurationSeconds * 120)
      );
    }
    this._postCommand('configureTrainingRuleset', options);
  }

  enterStateOnlyMode(stateSnapshot?: Float32Array | number[] | null, cursorTick?: number): void {
    const snapCopy = stateSnapshot ? Array.from<number>(stateSnapshot) : null;
    this._postCommand('enterStateOnlyMode', { stateSnapshot: snapCopy, cursorTick });
  }

  beginInterveneCountdown(countdownSeconds = 3, stateSnapshot?: Float32Array | number[] | null): void {
    const snapCopy = stateSnapshot ? Array.from<number>(stateSnapshot) : null;
    this._postCommand('beginInterveneCountdown', { countdownSeconds, stateSnapshot: snapCopy });
  }

  resumePhysicsFromState(stateSnapshot?: Float32Array | number[] | null, resumeTick?: number): void {
    const snapCopy = stateSnapshot ? Array.from<number>(stateSnapshot) : null;
    this._postCommand('resumePhysicsFromState', { stateSnapshot: snapCopy, resumeTick });
  }

  setLobbyMode(enabled = true, options: AuthoritativeServerHostOptions = {}): WorkerEnvelope {
    if (enabled) {
      this.hostReplayRingBuffer?.configureMode?.(REPLAY_BUFFER_MODES.COUNTUP_FIFO, options.replayCapacityTicks || null);
    }
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.LOBBY_MODE_SET, { enabled: Boolean(enabled), ...options });
  }

  enterLobbyMode(options: AuthoritativeServerHostOptions = {}): WorkerEnvelope {
    return this.setLobbyMode(true, { forceEnterLobby: true, ...options });
  }

  setGhostCarConfig(carIndex: number, interactWithBall = false, interactWithCars = false, opacity?: number): WorkerEnvelope {
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.GHOST_CAR_CONFIG, {
      carIndex, interactWithBall: Boolean(interactWithBall), interactWithCars: Boolean(interactWithCars), opacity,
    });
  }

  enterPodiumMode(winner = 0): WorkerEnvelope {
    return this.sendEnvelope(HOST_WORKER_MSG_TYPES.PODIUM_ENTER, { winner });
  }

  requestReplayWindow(count = 360): Promise<unknown> {
    return new Promise((resolve) => {
      const seq = ++this.channelRegistry.reqId;
      this.channelRegistry.pendingRequests.set(seq, { resolve });
      this.sendEnvelope(HOST_WORKER_MSG_TYPES.REPLAY_WINDOW_REQUEST, { reqId: seq, count }, [], seq);
    });
  }

  requestFullReplayExport(): Promise<unknown> {
    return new Promise((resolve) => {
      const seq = ++this.channelRegistry.reqId;
      this.channelRegistry.pendingRequests.set(seq, { resolve });
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
        this.botTunnelManager?.onServerPhysicsFrame?.(this.cachedSnapshot, this.lastServerTick, res.matchState);
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
    this.channelRegistry.destroy();
  }
}

export default AuthoritativeServerHost;
