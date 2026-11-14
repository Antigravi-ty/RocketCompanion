/**
 * dataChannelProbePipeline.ts
 * Extracted simulation-aware packet dispatch, opportunistic ping/pong probing,
 * 16B sparse ping/pong framing, and adaptive replication pacing helpers for DataChannelTransport.
 */

import type { NetworkSimulator, SimulatedPayload } from './NetworkSimulator.ts';
import type { AdaptiveReplicationPacer } from './AdaptiveReplicationPacer.ts';
import {
  PING_PONG_KIND_PING,
  PING_PONG_KIND_PONG,
  encodeSparsePingPong16B,
} from '../../protocol/ReplicationBusProtocol.ts';
import type { TunnelFramerBridgeState } from './tunnelFramerBridge.ts';
import {
  dispatchOpportunisticPing,
  encodeClientInputPayload,
  type ClientInputPacketPayload,
} from './dataChannelFramingPipeline.ts';

export interface ProbeTransportContext {
  readonly simulator: NetworkSimulator;
  readonly pacer: AdaptiveReplicationPacer;
  readonly tunnelBridge: TunnelFramerBridgeState;
  readonly activeDataChannel: RTCDataChannel | null;
  readonly roomBroadcastChannel: BroadcastChannel | null;
  readonly isChannelOpen: boolean;
  readonly transmitViaTunnelOrDataChannel: (
    payload: SimulatedPayload,
    allowBroadcastFallback: boolean,
    reliable?: boolean
  ) => boolean;
}

export function dispatchSimulatedPong(
  ctx: ProbeTransportContext,
  sendTime: number,
  nowMs = performance.now()
): void {
  const pongMsg = JSON.stringify({ type: 'pong', sendTime });
  ctx.simulator.scheduleSend(
    pongMsg,
    (clonedPacket) =>
      ctx.transmitViaTunnelOrDataChannel(
        clonedPacket,
        ctx.isChannelOpen || Boolean(ctx.roomBroadcastChannel),
        false
      ),
    nowMs
  );
}

export function dispatchSimulatedPacket(
  ctx: ProbeTransportContext,
  packet: SimulatedPayload,
  nowMs = performance.now()
): boolean {
  const sim = ctx.simulator;

  if (
    (packet instanceof Uint8Array || packet instanceof ArrayBuffer) &&
    nowMs - sim.lastPingSentTime > sim.pingIntervalMs
  ) {
    sim.lastPingSentTime = nowMs;
    sim.stats.pingsSent++;
    const pingPayload = JSON.stringify({
      type: 'ping',
      sendTime: nowMs,
      rtt: Math.round(sim.rttMs || 0),
    });
    sim.scheduleSend(
      pingPayload,
      (clonedPing) => {
        const msg = typeof clonedPing === 'string' ? clonedPing : pingPayload;
        if (ctx.tunnelBridge.tunnel?.isOpen && ctx.tunnelBridge.remotePeerId) {
          if (ctx.tunnelBridge.tunnel.sendToPeer(ctx.tunnelBridge.remotePeerId, msg, false)) {
            return true;
          }
        }
        return dispatchOpportunisticPing(
          ctx.activeDataChannel,
          ctx.roomBroadcastChannel,
          ctx.isChannelOpen || Boolean(ctx.roomBroadcastChannel),
          nowMs,
          sim.rttMs,
          msg
        );
      },
      nowMs
    );
  }

  return sim.scheduleSend(
    packet,
    (clonedPacket) => ctx.transmitViaTunnelOrDataChannel(clonedPacket, ctx.isChannelOpen, false),
    nowMs
  );
}

export function dispatchSimulatedClientInput(
  ctx: ProbeTransportContext,
  packet: ClientInputPacketPayload,
  nowMs = performance.now()
): boolean {
  const sim = ctx.simulator;
  const buf = encodeClientInputPayload(packet);
  const sent = dispatchSimulatedPacket(ctx, buf, nowMs);
  if (nowMs - sim.lastPingSentTime > sim.pingIntervalMs) {
    sim.lastPingSentTime = nowMs;
    sim.stats.pingsSent++;
    dispatchSimulatedPacket(
      ctx,
      JSON.stringify({ type: 'ping', sendTime: nowMs, rtt: Math.round(sim.rttMs) }),
      nowMs
    );
  }
  return sent;
}

export function dispatchSparsePingPongFrame(
  ctx: ProbeTransportContext,
  kind: typeof PING_PONG_KIND_PING | typeof PING_PONG_KIND_PONG,
  seq: number,
  timestampMs = performance.now(),
  epoch = 0,
  ackTick = 0
): boolean {
  const frame = encodeSparsePingPong16B({ kind, seq, timestampMs, epoch, ackTick });
  return ctx.transmitViaTunnelOrDataChannel(
    frame,
    ctx.isChannelOpen || Boolean(ctx.roomBroadcastChannel),
    false
  );
}

export function evaluateAdaptiveSnapshotReadiness(
  ctx: ProbeTransportContext,
  nowMs = performance.now()
): boolean {
  const dc = ctx.activeDataChannel;
  const buffered = dc ? dc.bufferedAmount : 0;
  const sim = ctx.simulator;
  ctx.pacer.updateNetworkHealth(sim.rttMs || 0, sim.packetLossRate || 0, buffered);
  return ctx.pacer.shouldSendSnapshot(nowMs, buffered);
}
