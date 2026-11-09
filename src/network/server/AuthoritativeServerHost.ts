import {
  createBoostPadEdgeTracker,
  type BoostPadEdgeTracker,
} from '../protocol/boostPadBitmaskPipeline.ts';
import type { CarControlsInput } from '../protocol/GlobalPayloadCodec.ts';
import { createHostSimProxy, type HostSimRestoreStateResult } from './HostSimProxy.ts';
import { createDefaultHostChannel } from './HostLoopbackChannel.ts';
import {
  HOST_WORKER_MSG_TYPES as MSG,
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
import { ReplayRingBuffer, REPLAY_BUFFER_MODES as RBM } from '../../replay/ReplayRingBuffer.ts';
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
    ch: HostClientChannelPort | AuthoritativeServerHostOptions | null = null,
    opts: AuthoritativeServerHostOptions = {}
  ) {
    if (
      ch &&
      typeof ch === 'object' &&
      !('send' in ch && typeof ch.send === 'function') &&
      !('sendClientInput' in ch && typeof ch.sendClientInput === 'function') &&
      !('inboundQueue' in ch && Array.isArray(ch.inboundQueue))
    ) {
      opts = ch as AuthoritativeServerHostOptions;
      ch = null;
    }
    this.options = { ...opts };
    this.isWorker = typeof Worker !== 'undefined' && !opts.forceFallback;
    const serverRef = this;
    this.botTunnelManager = new BotTunnelManager(serverRef, {
      forceInProcess: Boolean(opts.forceFallback),
    });
    this.hostReplayRingBuffer = new ReplayRingBuffer({
      mode: opts.startAsMatch ? RBM.COUNTDOWN_MATCH : RBM.COUNTUP_FIFO,
      capacityTicks: opts.replayCapacityTicks ?? undefined,
    });
    this.sim = createHostSimProxy(this);
    const initialChannel = (ch as HostClientChannelPort | null) || createDefaultHostChannel(this);
    this.channelRegistry = new HostClientChannelRegistry(initialChannel);
  }

  get fallbackSim(): AuthoritativePhysicsSimPort | null {
    return this.fallbackSubController.sim as unknown as AuthoritativePhysicsSimPort | null;
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
  get hostChannel(): HostClientChannelPort {
    return this.channelRegistry.hostChannel;
  }
  get channel(): HostClientChannelPort {
    return this.channelRegistry.hostChannel;
  }
  set channel(ch: HostClientChannelPort) {
    if (ch && ch !== this.channelRegistry.hostChannel) {
      this.channelRegistry.hostChannel = ch;
      this.addClientChannel(ch, 'host');
    }
  }

  private _applySyncedSnapshot(
    snap: Float32Array | number[] | null | undefined,
    tick: number | undefined,
    roomState: Partial<WorkerRoomStateSummary> | null | undefined
  ): void {
    this.active = true;
    if (snap) {
      const arr = snap instanceof Float32Array ? snap : new Float32Array(snap);
      const len = Math.min(this.cachedSnapshot.length, arr.length);
      this.cachedSnapshot.subarray(0, len).set(arr.subarray(0, len));
    }
    if (tick !== undefined) this.lastServerTick = tick;
    if (roomState) {
      this.lastRoomState = roomState;
      this.botTunnelManager?.init?.();
      this.botTunnelManager?.syncFromRoomState?.(roomState);
    }
  }

  async init(): Promise<this> {
    if (!this.isWorker) return this._initFallback();
    const onMessage = (d: unknown) => this._handleWorkerMessage(d as HostWorkerEnvelopeMessage);
    const onWorkerReady = (r: {
      snapshot?: Float32Array | number[] | null;
      tickCount?: number;
      roomState?: Partial<WorkerRoomStateSummary> | null;
    }) => this._applySyncedSnapshot(r.snapshot, r.tickCount, r.roomState);
    const onFallbackToMainThread = async () => {
      this.isWorker = false;
      await this._initFallback();
    };
    await spawnAuthoritativeWorkerWithRetry({
      options: this.options,
      getWorker: () => this.worker,
      setWorker: (w) => {
        this.worker = w;
      },
      onMessage,
      sendInitEnvelope: (p) => this.sendEnvelope(MSG.WORKER_INIT, p),
      onWorkerReady,
      onFallbackToMainThread,
    });
    return this;
  }

  async _initFallback(): Promise<this> {
    const res = await this.fallbackSubController.init(
      this.options,
      this.channelRegistry.hostChannel
    );
    this._applySyncedSnapshot(res.snapshot, res.serverTick, res.roomState);
    return this;
  }

  addEnvelopeListener(fn: (env: HostWorkerEnvelopeMessage) => void): () => void {
    const reg = this.channelRegistry;
    return reg.addEnvelopeListener(fn);
  }

  _handleWorkerMessage(data: HostWorkerEnvelopeMessage | null | undefined): void {
    const reg = this.channelRegistry;
    reg.handleWorkerMessage(this, data);
  }

  sendEnvelope(
    type: string,
    payload: AuthoritativeServerHostOptions = {},
    transfer: Transferable[] = [],
    seq: number | null = null
  ): WorkerEnvelope {
    const reg = this.channelRegistry;
    return reg.sendEnvelope(this, type, payload, transfer, seq);
  }

  _postCommand(
    type: string,
    data: Record<string, unknown> = {},
    transfer: Transferable[] = []
  ): void {
    if (this.isWorker && this.worker) this.worker.postMessage({ type, ...data }, transfer);
    else
      this.fallbackSubController.routeEnvelope(createWorkerEnvelope(type, data, 0), (r) =>
        this._handleWorkerMessage(r)
      );
  }

  _sendRequest(
    type: string,
    data: Record<string, unknown> = {}
  ): Promise<HostSimRestoreStateResult> {
    const reg = this.channelRegistry;
    return reg.sendRequest((t, d) => this._postCommand(t, d), type, data);
  }

  addClientChannel(
    ch: HostClientChannelPort | null | undefined,
    id: string | null = null
  ): string | null {
    return this.channelRegistry.addClientChannel(
      ch,
      id,
      this.isWorker,
      this.worker,
      (t, d) => this._postCommand(t, d),
      this.fallbackDataHandler
    );
  }

  removeClientChannel(ch: HostClientChannelPort): void {
    this.channelRegistry.removeClientChannel(
      ch,
      this.isWorker,
      this.worker,
      (t, d) => this._postCommand(t, d),
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
  }

  private _resetHostReplayTracking(): void {
    this.hostReplayRingBuffer?.configureMode?.(RBM.COUNTDOWN_MATCH);
    this.hostReplayRingBuffer?.clear();
    this._seenReplaySignalIds?.clear();
  }

  startMatch(durationSeconds?: number): void {
    this._resetHostReplayTracking();
    this._postCommand('startMatch', { durationSeconds });
  }
  forceStartMatch(durationSeconds?: number): void {
    this._resetHostReplayTracking();
    this._postCommand('forceStartMatch', { durationSeconds });
  }
  initiateMatchPrepare(durationSeconds?: number): void {
    this._resetHostReplayTracking();
    this._postCommand('initiateMatchPrepare', { durationSeconds });
  }
  setGameMode(gameMode: string, durationSeconds: number | null = null): void {
    this._postCommand('setGameMode', { gameMode, durationSeconds });
  }
  setBotFillMode(botFillMode: string, botType?: string): void {
    this._postCommand('setBotFillMode', { botFillMode, botType });
  }
  addBotPlayer(
    team = 1,
    botName: string | null = null,
    visualId: string | ExtraLoadoutConfig = 'octane',
    botType?: string
  ): void {
    this._postCommand('addBotPlayer', { team, botName, visualId, botType });
  }

  setLoadout(
    sessionId: string | null,
    visualId: string,
    colorSlot = 0,
    hitboxId: string | null = null,
    extra: ExtraLoadoutConfig | string | null = null,
    boostVisual: string | null = null,
    boostAudio: string | null = null
  ): void {
    const extraLoadout: ExtraLoadoutConfig | null =
      extra && typeof extra === 'object'
        ? extra
        : extra !== null || boostVisual !== null || boostAudio !== null
          ? {
              paintFinish: typeof extra === 'string' ? extra : undefined,
              boostVisual: boostVisual ?? undefined,
              boostAudio: boostAudio ?? undefined,
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

  startTrainingMode(opts: AuthoritativeServerHostOptions = {}): void {
    this.hostReplayRingBuffer?.configureMode?.(RBM.COUNTUP_FIFO, opts.replayCapacityTicks || null);
    this._postCommand('startTrainingMode', opts);
  }

  configureTrainingRuleset(opts: AuthoritativeServerHostOptions = {}): void {
    if (typeof opts.fifoDurationSeconds === 'number' && opts.fifoDurationSeconds > 0) {
      this.hostReplayRingBuffer?.configureMode(
        RBM.COUNTUP_FIFO,
        Math.round(opts.fifoDurationSeconds * 120)
      );
    }
    this._postCommand('configureTrainingRuleset', opts);
  }

  enterStateOnlyMode(s?: Float32Array | number[] | null, cursorTick?: number): void {
    this._postCommand('enterStateOnlyMode', {
      stateSnapshot: s ? Array.from<number>(s) : null,
      cursorTick,
    });
  }
  beginInterveneCountdown(countdownSeconds = 3, s?: Float32Array | number[] | null): void {
    this._postCommand('beginInterveneCountdown', {
      countdownSeconds,
      stateSnapshot: s ? Array.from<number>(s) : null,
    });
  }
  resumePhysicsFromState(s?: Float32Array | number[] | null, resumeTick?: number): void {
    this._postCommand('resumePhysicsFromState', {
      stateSnapshot: s ? Array.from<number>(s) : null,
      resumeTick,
    });
  }

  setLobbyMode(enabled = true, opts: AuthoritativeServerHostOptions = {}): WorkerEnvelope {
    if (enabled)
      this.hostReplayRingBuffer?.configureMode?.(
        RBM.COUNTUP_FIFO,
        opts.replayCapacityTicks || null
      );
    return this.sendEnvelope(MSG.LOBBY_MODE_SET, { enabled: Boolean(enabled), ...opts });
  }

  enterLobbyMode(opts: AuthoritativeServerHostOptions = {}): WorkerEnvelope {
    return this.setLobbyMode(true, { forceEnterLobby: true, ...opts });
  }

  setGhostCarConfig(
    carIndex: number,
    interactWithBall = false,
    interactWithCars = false,
    opacity?: number
  ): WorkerEnvelope {
    return this.sendEnvelope(MSG.GHOST_CAR_CONFIG, {
      carIndex,
      interactWithBall: Boolean(interactWithBall),
      interactWithCars: Boolean(interactWithCars),
      opacity,
    });
  }

  enterPodiumMode(winner = 0): WorkerEnvelope {
    return this.sendEnvelope(MSG.PODIUM_ENTER, { winner });
  }

  private _sendPendingReq(
    type: string,
    extra: AuthoritativeServerHostOptions = {}
  ): Promise<unknown> {
    return new Promise((resolve) => {
      const seq = ++this.channelRegistry.reqId;
      this.channelRegistry.pendingRequests.set(seq, { resolve });
      this.sendEnvelope(type, { reqId: seq, ...extra }, [], seq);
    });
  }

  requestReplayWindow(count = 360): Promise<unknown> {
    return this._sendPendingReq(MSG.REPLAY_WINDOW_REQUEST, { count });
  }
  requestFullReplayExport(): Promise<unknown> {
    return this._sendPendingReq(MSG.REPLAY_FULL_EXPORT_REQUEST);
  }

  configureDiagnosticFleet(enabled = true, anchorMode = 'z_hover'): void {
    this._postCommand('configureDiagnosticFleet', { enabled: Boolean(enabled), anchorMode });
  }

  update(): void {
    if (!this.isWorker) {
      const res = this.fallbackSubController.step();
      if (res) {
        this._applySyncedSnapshot(res.snapshot, res.serverTick, res.roomState);
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
      this.sendEnvelope(MSG.WORKER_DESTROY, {});
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
