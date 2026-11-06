import {
  InputPacketCodec, type PiggybackedSignalAck, type PiggybackedClientCommand, type UnpackedCarControls,
} from '../protocol/InputPacketCodec.ts';
import { EstablishedSessionManager, type ParsedClientPacketHeader } from '../server/EstablishedSessionManager.ts';
import {
  GlobalPayloadCodec, MATCH_SIGNALS, createBoostPadEdgeTracker, seedBoostPadEdgeTrackerFromSnapshot,
  applyBoostPadEdgeCooldowns, type BoostPadEdgeTracker, type DecodedGlobalPayload, type MatchSignalDescriptor,
} from '../protocol/GlobalPayloadCodec.ts';
import { dumpNetworkPacket, type DumpedNetworkPacket, type InspectablePacketInput } from '../diagnostics/PacketDumpDiagnostics.ts';
import type { CarControls, LocalClientInputBuffer } from './PredictionHistoryBuffer.ts';
import type { ReconcilerMetrics, TelemetryChannelPort, TelemetrySimPort } from './NetworkTelemetryCollector.ts';

export interface ParsedReconcilerPacket extends InspectablePacketInput {
  serverTick: number; activeCarMask?: number; activeCarIndices?: number[];
  boostPadMaskLow?: number; boostPadMaskHigh?: number; stateSnapshot: Float32Array;
  acknowledgedControls?: Array<{ carIndex: number; controls: UnpackedCarControls }>;
  timestamp?: number; clientHeader?: ParsedClientPacketHeader; globalPayload?: DecodedGlobalPayload;
  rawBytes?: Uint8Array | ArrayBuffer;
}

export interface PendingSignalAckEntry { signalId: number; signalType: number; remainingSends: number; }
export interface PendingClientCommandEntry { commandId: number; commandType: number; param1: number; param2: number; remainingSends: number; }

export interface OutboundInputContext {
  channel: TelemetryChannelPort | null | undefined;
  localCarIndex: number; redundantHistoryCount: number; enableRedundantInputs: boolean;
  redundantHistoryTicks: number; tickDtMs: number; lastServerRecordedInputTick: number;
  clientInputRingBuffer: LocalClientInputBuffer;
  getPreviousCommittedControls: (tick: number, carIndex: number) => CarControls;
}

export interface FlushPendingControlContext {
  channel: TelemetryChannelPort | null | undefined; sim: TelemetrySimPort | null | undefined;
  lastAckedServerTick: number; localCarIndex: number; neutralControls: Readonly<CarControls>;
  replayPlaybackMode: boolean; localSkipReplayReady: boolean;
}

export interface DrainServerPacketsContext {
  channel: TelemetryChannelPort | null | undefined;
  lobbyDualWorldMode: boolean; hostLobbyMode: boolean; replayPlaybackMode: boolean;
  inputBufferTarget: number; metrics: ReconcilerMetrics; boostPadEdgeTracker: BoostPadEdgeTracker;
  isTimelineSynchronized: () => boolean;
  onSignals: ((signals: MatchSignalDescriptor[], packetServerTick: number | null) => void) | null;
  onRosterUpdate: ((msg: Record<string, unknown>) => void) | null;
  onHandshakeResponse: ((msg: Record<string, unknown>) => void) | null;
  setLocalCarIndex: (entityId: number) => void;
  setLobbyDualWorldMode: (enabled: boolean) => void;
  setLobbyAuthoritativeSnapshots: (prev: Float32Array, curr: Float32Array) => void;
  syncTimelineFromHandshake: (snap: Float32Array, frame: number, nowMs: number) => void;
}

export class ReconcilerControlMessenger {
  pendingSignalAcks: Map<number, PendingSignalAckEntry> = new Map();
  pendingClientCommands: Map<number, PendingClientCommandEntry> = new Map();
  nextClientCommandId = 0;

  hasServerReportedBuffer = false;
  lastServerRecordedInputTick = -1;
  lastProcessedClientTimestamp = 0;
  baseMeasuredRtt = 0;
  measuredRtt = 0;
  lastReceivedPacketRaw: Uint8Array | ArrayBuffer | null = null;
  lastParsedPacket: ParsedReconcilerPacket | null = null;
  pendingDumpNextPacket = false;
  onNextDumpResolve: ((dumped: DumpedNetworkPacket | null) => void) | null = null;
  drainedReplayPackets: ParsedReconcilerPacket[] = [];

  constructor(initialServerRecordedInputTick = -1) {
    this.lastServerRecordedInputTick = initialServerRecordedInputTick;
  }

  resetTimelineCounters(initialServerRecordedInputTick: number): void {
    this.hasServerReportedBuffer = false;
    this.lastServerRecordedInputTick = initialServerRecordedInputTick;
    this.drainedReplayPackets.length = 0;
  }

  receiveChannelPackets(
    channel: TelemetryChannelPort | null | undefined,
    nowMs: number
  ): unknown[] | null {
    if (typeof channel?.receiveClientPackets === 'function')
      return channel.receiveClientPackets(nowMs);
    if (typeof channel?.receiveServerPackets === 'function')
      return channel.receiveServerPackets(nowMs);
    if (Array.isArray(channel?.inboundQueue)) return channel.inboundQueue.splice(0);
    return null;
  }

  triggerDumpNextPacket(): Promise<DumpedNetworkPacket | null> {
    this.pendingDumpNextPacket = true;
    return new Promise((resolve) => {
      this.onNextDumpResolve = resolve;
    });
  }

  dumpPacket(
    packetOrRaw: InspectablePacketInput | Uint8Array | ArrayBuffer | null = null
  ): DumpedNetworkPacket | null {
    return dumpNetworkPacket(
      packetOrRaw || this.lastParsedPacket || this.lastReceivedPacketRaw
    );
  }

  recordLatestParsedPacket(packet: ParsedReconcilerPacket): void {
    this.lastParsedPacket = packet;
    if (this.pendingDumpNextPacket) {
      this.pendingDumpNextPacket = false;
      const dumped = this.dumpPacket(packet);
      if (typeof this.onNextDumpResolve === 'function') {
        this.onNextDumpResolve(dumped);
        this.onNextDumpResolve = null;
      }
    }
  }

  updateLobbyAuthoritativeSnapshots(
    lobbyDualWorldMode: boolean,
    packet: ParsedReconcilerPacket | null | undefined,
    prev: Float32Array | null,
    curr: Float32Array | null
  ): { prev: Float32Array | null; curr: Float32Array | null } {
    if (!lobbyDualWorldMode || !packet?.stateSnapshot || packet.stateSnapshot.length < 410) {
      return { prev, curr };
    }
    if (!curr || curr.length !== packet.stateSnapshot.length) {
      return {
        prev: new Float32Array(packet.stateSnapshot),
        curr: new Float32Array(packet.stateSnapshot),
      };
    }
    prev!.set(curr);
    curr.set(packet.stateSnapshot);
    return { prev, curr };
  }

  acknowledgeSignal(signalId: number, signalType: number, repeatCount = 8): void {
    if (typeof signalId !== 'number' || signalId <= 0) return;
    const existing = this.pendingSignalAcks.get(signalId);
    if (existing) {
      existing.remainingSends = Math.max(existing.remainingSends, repeatCount);
      return;
    }
    this.pendingSignalAcks.set(signalId, {
      signalId: signalId & 0xffff,
      signalType: signalType & 0xff,
      remainingSends: repeatCount,
    });
  }

  acknowledgeServerSignals(signals: MatchSignalDescriptor[] | null | undefined): void {
    if (!Array.isArray(signals)) return;
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      if (!s) continue;
      if (s.signalType === 0x9f && typeof s.param1 === 'number') {
        this.pendingClientCommands.delete(s.param1);
      }
      if (typeof s.signalId === 'number' && s.signalId > 0 && typeof s.signalType === 'number') {
        this.acknowledgeSignal(s.signalId, s.signalType, 6);
      }
    }
  }

  enqueueClientCommand(
    commandType: number,
    param1 = 0,
    param2 = 0,
    maxSends = 60
  ): number {
    this.nextClientCommandId = ((this.nextClientCommandId || 0) % 65535) + 1;
    const commandId = this.nextClientCommandId;
    this.pendingClientCommands.set(commandId, {
      commandId,
      commandType: commandType & 0xff,
      param1: param1 & 0xffff,
      param2: param2 & 0xffff,
      remainingSends: maxSends,
    });
    return commandId;
  }

  resolveClientCommandAck(commandId: number): void {
    if (typeof commandId === 'number' && commandId > 0) {
      this.pendingClientCommands.delete(commandId);
    }
  }

  collectPiggybackAcksAndCommands(): {
    acks: PiggybackedSignalAck[];
    commands: PiggybackedClientCommand[];
  } {
    const acks: PiggybackedSignalAck[] = [];
    if (this.pendingSignalAcks.size > 0) {
      for (const [sigId, item] of this.pendingSignalAcks.entries()) {
        acks.push({ signalId: item.signalId, signalType: item.signalType });
        item.remainingSends--;
        if (item.remainingSends <= 0) {
          this.pendingSignalAcks.delete(sigId);
        }
        if (acks.length >= 32) break;
      }
    }

    const commands: PiggybackedClientCommand[] = [];
    if (this.pendingClientCommands.size > 0) {
      for (const [cmdId, cmd] of this.pendingClientCommands.entries()) {
        commands.push({
          commandId: cmd.commandId,
          commandType: cmd.commandType,
          param1: cmd.param1,
          param2: cmd.param2,
        });
        cmd.remainingSends--;
        if (cmd.remainingSends <= 0) {
          this.pendingClientCommands.delete(cmdId);
        }
        if (commands.length >= 16) break;
      }
    }

    return { acks, commands };
  }

  sendOutboundInputForTick(
    ctx: OutboundInputContext,
    tick: number,
    carIndex: number = ctx.localCarIndex,
    controls: CarControls | null = null,
    nowMs = performance.now()
  ): void {
    const isRedundantEnabled =
      ctx.redundantHistoryCount > 1 || Boolean(ctx.enableRedundantInputs);
    const { acks, commands } = this.collectPiggybackAcksAndCommands();
    let outboundPacket: Uint8Array;
    if (isRedundantEnabled) {
      const maxHistoryLimit = Math.max(
        ctx.redundantHistoryCount,
        ctx.redundantHistoryTicks || 12,
        Math.ceil((ctx.channel?.rttMs || 0) / ctx.tickDtMs) + 6
      );
      const serverRecordedTick = ctx.lastServerRecordedInputTick;
      const unackedCount =
        typeof serverRecordedTick === 'number' &&
        serverRecordedTick >= 0 &&
        tick > serverRecordedTick
          ? tick - serverRecordedTick
          : maxHistoryLimit;
      const historyLimit = Math.max(1, Math.min(maxHistoryLimit, unackedCount));
      const redundantWindow = ctx.clientInputRingBuffer.getRecentWindow(
        tick,
        historyLimit,
        carIndex
      );
      outboundPacket = InputPacketCodec.encode(
        carIndex,
        tick,
        redundantWindow,
        nowMs,
        acks,
        commands
      );
    } else {
      const ctrl = controls || ctx.getPreviousCommittedControls(tick + 1, carIndex);
      const singleWindow = [{ tick, carIndex, controls: { ...ctrl } }];
      outboundPacket = InputPacketCodec.encode(
        carIndex,
        tick,
        singleWindow,
        nowMs,
        acks,
        commands
      );
    }

    if (typeof ctx.channel?.sendClientInput === 'function') {
      ctx.channel.sendClientInput(outboundPacket, nowMs);
    } else if (typeof ctx.channel?.send === 'function') {
      ctx.channel.send(outboundPacket, nowMs);
    }
  }

  flushPendingControlPackets(
    ctx: FlushPendingControlContext,
    nowMs = performance.now()
  ): void {
    const hasAcks = this.pendingSignalAcks.size > 0;
    const hasCommands = this.pendingClientCommands.size > 0;
    const wantSkipReplayJump = Boolean(ctx.replayPlaybackMode && ctx.localSkipReplayReady);
    if (!hasAcks && !hasCommands && !wantSkipReplayJump) return;
    const currentTick = Math.floor(
      ctx.sim?.getHeaderView?.()?.tickCount ?? ctx.lastAckedServerTick ?? 0
    );
    const { acks, commands } = this.collectPiggybackAcksAndCommands();
    if (acks.length === 0 && commands.length === 0 && !wantSkipReplayJump) return;
    const singleWindow = [
      {
        tick: currentTick,
        carIndex: ctx.localCarIndex,
        controls: {
          ...ctx.neutralControls,
          jump: wantSkipReplayJump,
        },
      },
    ];
    const outboundPacket = InputPacketCodec.encode(
      ctx.localCarIndex,
      currentTick,
      singleWindow,
      nowMs,
      acks,
      commands
    );
    if (typeof ctx.channel?.sendClientInput === 'function') {
      ctx.channel.sendClientInput(outboundPacket, nowMs);
    } else if (typeof ctx.channel?.send === 'function') {
      ctx.channel.send(outboundPacket, nowMs);
    }
  }

  drainAndParseServerPackets(
    ctx: DrainServerPacketsContext,
    incomingPackets: unknown[],
    nowMs: number
  ): ParsedReconcilerPacket | null {
    let latestPacket: ParsedReconcilerPacket | null = null;
    this.drainedReplayPackets.length = 0;
    const boostPadTracker = ctx.boostPadEdgeTracker || createBoostPadEdgeTracker();

    for (const rawItem of incomingPackets) {
      let packet: ParsedReconcilerPacket | null = null;

      if (rawItem instanceof Uint8Array || rawItem instanceof ArrayBuffer) {
        this.lastReceivedPacketRaw = rawItem;
        const clientHeader = EstablishedSessionManager.parseClientPacket(rawItem);
        if (clientHeader) {
          if (
            ctx.lobbyDualWorldMode &&
            clientHeader.inputBufferSize === 0 &&
            !this.hasServerReportedBuffer
          ) {
            ctx.metrics.inputBufferSize = ctx.inputBufferTarget ?? 3;
          } else {
            ctx.metrics.inputBufferSize = clientHeader.inputBufferSize;
            this.hasServerReportedBuffer = true;
          }

          const extraUplink = Math.max(
            0,
            Number(ctx.channel?.extraUplinkMs ?? ctx.channel?.extraLatencyMs ?? 0) || 0
          );
          const extraDownlink = Math.max(
            0,
            Number(ctx.channel?.extraDownlinkMs ?? ctx.channel?.extraLatencyMs ?? 0) || 0
          );
          const extraRtt = extraUplink + extraDownlink;

          const isLastQueuedItem = rawItem === incomingPackets[incomingPackets.length - 1];
          if (ctx.channel?.isLoopback) {
            this.measuredRtt = Math.round(extraRtt);
            if (
              clientHeader.clientTimestamp > 0 &&
              clientHeader.clientTimestamp > this.lastProcessedClientTimestamp
            ) {
              this.lastProcessedClientTimestamp = clientHeader.clientTimestamp;
            }
          } else {
            if (
              isLastQueuedItem &&
              clientHeader.clientTimestamp > 0 &&
              clientHeader.clientTimestamp > this.lastProcessedClientTimestamp
            ) {
              this.lastProcessedClientTimestamp = clientHeader.clientTimestamp;
              const sampleRtt = Math.max(0, nowMs - clientHeader.clientTimestamp);
              const isQueueBurst = incomingPackets.length > 3;
              if (sampleRtt < 2000 && Number.isFinite(sampleRtt) && !isQueueBurst) {
                const baseSampleRtt = Math.max(0, sampleRtt - extraRtt);
                if (!Number.isFinite(this.baseMeasuredRtt) || this.baseMeasuredRtt === 0) {
                  this.baseMeasuredRtt = baseSampleRtt;
                } else {
                  const maxStepUp = Math.max(50, this.baseMeasuredRtt * 2);
                  const clampedSample = Math.min(baseSampleRtt, this.baseMeasuredRtt + maxStepUp);
                  this.baseMeasuredRtt = this.baseMeasuredRtt * 0.85 + clampedSample * 0.15;
                }
              }
            }
            this.measuredRtt = (this.baseMeasuredRtt || 0) + extraRtt;
            if (ctx.channel && Number.isFinite(this.measuredRtt)) {
              if (typeof ctx.channel.rttMs !== 'undefined') {
                ctx.channel.measuredRttMs = this.measuredRtt;
              }
            }
          }

          const globalPayload = GlobalPayloadCodec.decode(clientHeader.globalPayloadSlice);
          if (globalPayload) {
            const allSignals =
              globalPayload.signals && globalPayload.signals.length > 0
                ? globalPayload.signals
                : clientHeader.sessionSignals || [];
            if (allSignals.length > 0) {
              this.acknowledgeServerSignals(allSignals);
              let hasTransitionSignal = false;
              for (const sig of allSignals) {
                if (!sig) continue;
                if (sig.signalType === MATCH_SIGNALS.COMMAND_ACK && typeof sig.param1 === 'number') {
                  this.resolveClientCommandAck(sig.param1);
                }
                if (
                  sig.signalType === MATCH_SIGNALS.MATCH_PREPARE ||
                  sig.signalType === MATCH_SIGNALS.MATCH_STARTED ||
                  sig.signalType === MATCH_SIGNALS.KICKOFF_WILL_START
                ) {
                  hasTransitionSignal = true;
                }
              }
              const prevLobbyMode = Boolean(ctx.lobbyDualWorldMode);
              const pktServerTick =
                globalPayload.hasPhysics &&
                globalPayload.physics &&
                typeof globalPayload.physics.tick === 'number'
                  ? globalPayload.physics.tick
                  : null;
              ctx.onSignals?.(allSignals, pktServerTick);
              if (
                hasTransitionSignal ||
                Boolean(ctx.lobbyDualWorldMode) !== prevLobbyMode ||
                !ctx.isTimelineSynchronized()
              ) {
                latestPacket = null;
              }
            }
            if (globalPayload.allUserRtt) {
              ctx.metrics.allUserRtt = globalPayload.allUserRtt;
            }
            if (globalPayload.hasPhysics && globalPayload.physics) {
              const physMask = globalPayload.physics.activeCarMask;
              const isStaleLobbyPhysicsInMatch =
                !ctx.lobbyDualWorldMode &&
                !ctx.hostLobbyMode &&
                !ctx.channel?.isLoopback &&
                typeof physMask === 'number' &&
                (physMask & 0xc0) !== 0;
              if (!isStaleLobbyPhysicsInMatch) {
                const srvTick = globalPayload.physics.tick;
                if (globalPayload.physics.stateSnapshot) {
                  applyBoostPadEdgeCooldowns(
                    globalPayload.physics.stateSnapshot,
                    srvTick,
                    boostPadTracker
                  );
                }
                if (this.hasServerReportedBuffer && srvTick > 0) {
                  const bufDepth = clientHeader.inputBufferSize | 0;
                  const recordedUpTo = bufDepth > 0 ? srvTick + bufDepth - 1 : srvTick - 1;
                  if (
                    typeof this.lastServerRecordedInputTick !== 'number' ||
                    recordedUpTo > this.lastServerRecordedInputTick
                  ) {
                    this.lastServerRecordedInputTick = recordedUpTo;
                  }
                }
                packet = {
                  serverTick: srvTick,
                  activeCarMask: globalPayload.physics.activeCarMask,
                  activeCarIndices: globalPayload.physics.activeCarIndices,
                  boostPadMaskLow: globalPayload.physics.boostPadMaskLow,
                  boostPadMaskHigh: globalPayload.physics.boostPadMaskHigh,
                  stateSnapshot: globalPayload.physics.stateSnapshot,
                  acknowledgedControls: globalPayload.physics.acknowledgedControls,
                  timestamp: clientHeader.serverTimestamp,
                  clientHeader,
                  globalPayload,
                  rawBytes: rawItem,
                };
              }
            }
          }
        }
      } else if (rawItem) {
        let parsedItem: unknown = rawItem;
        if (typeof rawItem === 'string') {
          try {
            parsedItem = JSON.parse(rawItem);
          } catch (err) {
            console.warn(
              '[PredictionReconciler] Failed to parse datagram string as JSON:',
              err,
              rawItem
            );
          }
        }
        if (parsedItem && typeof parsedItem === 'object') {
          const obj = parsedItem as Record<string, unknown>;
          if (typeof obj.serverTick === 'number') {
            packet = obj as unknown as ParsedReconcilerPacket;
          } else if (obj.type === 'roster_update') {
            ctx.onRosterUpdate?.(obj);
            continue;
          } else if (obj.type === 'handshake_response') {
            if (typeof obj.entityId === 'number' && obj.entityId >= 0) {
              ctx.setLocalCarIndex(obj.entityId);
            }
            const initSnap = obj.initialSnapshot as ArrayLike<number> | undefined;
            const frame =
              (typeof obj.serverFrame === 'number' ? obj.serverFrame : undefined) ??
              (typeof obj.matchTick === 'number' ? obj.matchTick : 0);
            if (obj.state === 'lobby') {
              ctx.setLobbyDualWorldMode(true);
              if (initSnap) {
                const snap = new Float32Array(initSnap);
                seedBoostPadEdgeTrackerFromSnapshot(boostPadTracker, snap, frame);
                ctx.setLobbyAuthoritativeSnapshots(new Float32Array(snap), new Float32Array(snap));
              }
            } else {
              ctx.setLobbyDualWorldMode(false);
              if (
                initSnap &&
                (obj.serverFrame !== undefined || obj.matchTick !== undefined)
              ) {
                const snap = new Float32Array(initSnap);
                seedBoostPadEdgeTrackerFromSnapshot(boostPadTracker, snap, frame);
                ctx.syncTimelineFromHandshake(snap, frame, nowMs);
              }
            }
            ctx.onHandshakeResponse?.(obj);
            continue;
          }
        }
      }

      if (packet) {
        if (ctx.replayPlaybackMode && packet.stateSnapshot) {
          this.drainedReplayPackets.push(packet);
        }
        if (!latestPacket || packet.serverTick >= latestPacket.serverTick) {
          latestPacket = packet;
        }
      }
    }

    return latestPacket;
  }
}
