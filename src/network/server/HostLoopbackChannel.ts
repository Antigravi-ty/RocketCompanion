/**
 * src/network/server/HostLoopbackChannel.ts
 * Loopback transport channel with NetworkSimulator impairment support for local host sessions.
 */

import { NetworkSimulator } from '../transport/webrtc/NetworkSimulator.ts';
import { InputPacketCodec } from '../protocol/InputPacketCodec.ts';
import type { HostSimProxyPort } from './HostSimProxy.ts';

export function createDefaultHostChannel(
  hostWorker: HostSimProxyPort,
  options: Record<string, any> = {}
) {
  const simulator = new NetworkSimulator({
    ...options,
    isLoopback: true,
  });

  const ch: Record<string, any> = {
    isLoopback: true,
    transportMode: 'loopback',
    simulator,
    get stats() {
      return simulator.stats;
    },
    get extraUplinkMs() {
      return simulator.extraUplinkMs;
    },
    set extraUplinkMs(v: number) {
      simulator.setExtraUplinkLatency(v);
    },
    get extraDownlinkMs() {
      return simulator.extraDownlinkMs;
    },
    set extraDownlinkMs(v: number) {
      simulator.setExtraDownlinkLatency(v);
    },
    get extraRttMs() {
      return simulator.extraRttMs;
    },
    get extraLatencyMs() {
      return simulator.extraLatencyMs;
    },
    set extraLatencyMs(v: number) {
      simulator.setExtraLatency(v);
    },
    get jitterMs() {
      return simulator.jitterMs;
    },
    set jitterMs(v: number) {
      simulator.setJitter(v);
    },
    get packetLossRate() {
      return simulator.packetLossRate;
    },
    set packetLossRate(v: number) {
      simulator.setPacketLossRate(v);
    },
    get baseMeasuredRttMs() {
      return simulator.baseMeasuredRttMs;
    },
    get measuredRttMs() {
      return simulator.measuredRttMs;
    },
    get measuredJitterMs() {
      return simulator.measuredJitterMs;
    },
    get latencyMs() {
      return simulator.latencyMs;
    },
    get rttMs() {
      return simulator.rttMs;
    },
    set rttMs(val: number) {
      simulator.rttMs = val;
    },
    setExtraUplinkLatency: (uplinkMs: number) => simulator.setExtraUplinkLatency(uplinkMs),
    setExtraDownlinkLatency: (downlinkMs: number) => simulator.setExtraDownlinkLatency(downlinkMs),
    setAsymmetricLatency: (uplinkMs: number, downlinkMs: number) =>
      simulator.setAsymmetricLatency(uplinkMs, downlinkMs),
    setExtraLatency: (latencyMs: number) => simulator.setExtraLatency(latencyMs),
    setLatency: (latencyMs: number) => simulator.setLatency(latencyMs),
    setJitter: (jitterMs: number) => simulator.setJitter(jitterMs),
    setRtt: (rttMs: number) => simulator.setRtt(rttMs),
    setPacketLossRate: (rate: number) => simulator.setPacketLossRate(rate),
    setBurstDrop: (periodMs: number, durationMs: number, enabled?: boolean) =>
      simulator.setBurstDrop(periodMs, durationMs, enabled),
    setBurstDropEnabled: (enabled: boolean) => simulator.setBurstDropEnabled(enabled),
    toggleBurstDrop: (forceEnabled?: boolean) => simulator.toggleBurstDrop(forceEnabled),
    triggerBlackout: (durationMs: number, nowMs?: number) =>
      simulator.triggerBlackout(durationMs, nowMs),
    clearBlackout: () => simulator.clearBlackout(),
    forceDropNextInput: (count = 5) => simulator.forceDropNextInput(count),
    dropSinglePacket: () => simulator.dropSinglePacket(),
    onPacketReceived: null as ((payload: any) => void) | null,
    onMessage: null as ((payload: any) => void) | null,
    onColorChange: null as ((msg: any) => void) | null,
    send: (packet: any, nowMs = performance.now()): boolean => {
      return simulator.scheduleSend(
        packet,
        (clonedPacket: any) => {
          if (hostWorker.isWorker && hostWorker.worker) {
            hostWorker._postCommand('clientInput', {
              channelId: 'host',
              packet: clonedPacket,
              timestamp: nowMs,
            });
            return true;
          }
          if (hostWorker.fallbackDataHandler) {
            if (!hostWorker._loggedFallbackSend) {
              hostWorker._loggedFallbackSend = true;
              console.info(
                '[HostLoopbackChannel] Routing host loopback packets through in-memory fallbackDataHandler.'
              );
            }
            hostWorker.fallbackDataHandler.handleIncomingPacket('host', clonedPacket, nowMs);
            return true;
          }
          return false;
        },
        nowMs
      );
    },
    sendClientInput: (packet: any, nowMs = performance.now()): boolean => {
      let buf = packet;
      if (
        !(packet instanceof Uint8Array) &&
        !(packet instanceof ArrayBuffer) &&
        typeof packet !== 'string'
      ) {
        if (packet?.history) {
          buf = InputPacketCodec.encode(
            packet.carIndex ?? 0,
            packet.targetTick ?? packet.tick,
            packet.history,
            nowMs
          );
        } else if (packet?.controls) {
          buf = InputPacketCodec.encode(
            packet.carIndex ?? 0,
            packet.tick,
            [{ tick: packet.tick, controls: packet.controls }],
            nowMs
          );
        }
      }
      const sent = ch.send(buf, nowMs);
      if (nowMs - simulator.lastPingSentTime > simulator.pingIntervalMs) {
        simulator.lastPingSentTime = nowMs;
        simulator.stats.pingsSent++;
        ch.send(
          JSON.stringify({ type: 'ping', sendTime: nowMs, rtt: Math.round(ch.rttMs) }),
          nowMs
        );
      }
      return sent;
    },
    sendServerState: (packet: any, nowMs = performance.now()): boolean => {
      return ch.send(packet, nowMs);
    },
    receiveClientPackets: (nowMs = performance.now()) => {
      return simulator.drainInboundQueue(nowMs);
    },
    receiveServerPackets: (nowMs = performance.now()) => {
      return simulator.drainInboundQueue(nowMs);
    },
    reset: () => {
      simulator.reset();
    },
    destroy: () => {
      simulator.reset();
    },
  };
  return ch;
}

export function deliverToHostLoopback(hostChannel: Record<string, any> | null, packet: any): boolean {
  if (!hostChannel) return false;
  const now = performance.now();
  const simulator = hostChannel.simulator;

  if (simulator) {
    simulator.stats.packetsReceived++;

    if (typeof packet === 'string') {
      try {
        const msg = JSON.parse(packet);
        if (msg.type === 'color_change') {
          hostChannel.onColorChange?.(msg);
          return true;
        }
        if (msg.type === 'ping') {
          const pongMsg = JSON.stringify({ type: 'pong', sendTime: msg.sendTime });
          deliverToHostLoopback(hostChannel, pongMsg);
          return true;
        }
        if (msg.type === 'pong') {
          simulator.handlePong(msg.sendTime, now);
          return true;
        }
      } catch (err: any) {
        console.warn(
          '[HostLoopbackChannel] Non-JSON string payload received, forwarding raw:',
          err?.message || err
        );
      }
    }

    return simulator.receivePayload(
      packet,
      (delivered: any) => {
        hostChannel.onPacketReceived?.(delivered);
        hostChannel.onMessage?.(delivered);
      },
      now
    );
  }

  if (!hostChannel._loggedMockFallback) {
    hostChannel._loggedMockFallback = true;
    console.warn(
      '[HostLoopbackChannel] hostChannel.simulator is missing; using direct mock channel queue fallback.'
    );
  }
  if (hostChannel.packetLossRate > 0 && Math.random() < hostChannel.packetLossRate) {
    return false;
  }
  const cloned = NetworkSimulator.clonePayload(packet);
  const delay = hostChannel.extraLatencyMs ?? 0;
  const deliverAt = delay > 0 ? now + delay : 0;
  if (hostChannel.inboundQueue) {
    if (deliverAt === 0) {
      hostChannel.inboundQueue.push(cloned);
    } else {
      hostChannel.inboundQueue.push({ payload: cloned, deliverAt });
    }
  }
  if (deliverAt === 0) {
    hostChannel.onPacketReceived?.(cloned);
    hostChannel.onMessage?.(cloned);
  } else {
    setTimeout(() => {
      hostChannel.onPacketReceived?.(cloned);
      hostChannel.onMessage?.(cloned);
    }, delay);
  }
  return true;
}
