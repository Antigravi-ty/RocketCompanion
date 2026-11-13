/**
 * src/network/transport/webrtc/AdaptiveReplicationPacer.ts
 * Adaptive bitrate / send-rate throttling and dual-mode (continuous vs sparse 2Hz)
 * pacing controller for WebRTC DataChannel replication.
 */

import { REPLICATION_MODES, type ReplicationMode } from '../../protocol/ReplicationBusProtocol.ts';

export const SPARSE_PING_INTERVAL_MS = 500;
export const HIGH_WATER_BUFFERED_BYTES = 65536;
export const LOW_WATER_BUFFERED_BYTES = 16384;

export interface AdaptivePacerOptions {
  baseHz?: number;
  minHz?: number;
  maxHz?: number;
  sparsePingIntervalMs?: number;
}

export class AdaptiveReplicationPacer {
  private mode: ReplicationMode = REPLICATION_MODES.CONTINUOUS;
  private baseHz: number;
  private readonly minHz: number;
  private readonly maxHz: number;
  private readonly sparsePingIntervalMs: number;
  private effectiveHz: number;
  private lastSnapshotSentMs = -Infinity;
  private lastSparsePingSentMs = -Infinity;
  private congestionLevel = 0;

  constructor(options: AdaptivePacerOptions = {}) {
    this.baseHz = options.baseHz ?? 120;
    this.minHz = options.minHz ?? 30;
    this.maxHz = options.maxHz ?? 120;
    this.sparsePingIntervalMs = options.sparsePingIntervalMs ?? SPARSE_PING_INTERVAL_MS;
    this.effectiveHz = Math.min(this.maxHz, Math.max(this.minHz, this.baseHz));
  }

  getMode(): ReplicationMode {
    return this.mode;
  }

  setMode(mode: ReplicationMode): void {
    this.mode = mode;
    if (mode === REPLICATION_MODES.CONTINUOUS) {
      this.lastSnapshotSentMs = -Infinity;
    }
  }

  getEffectiveHz(): number {
    return this.mode === REPLICATION_MODES.SPARSE ? 2 : this.effectiveHz;
  }

  getCongestionLevel(): number {
    return this.congestionLevel;
  }

  updateNetworkHealth(rttMs: number, packetLossRate: number, bufferedAmountBytes: number): void {
    const isCongested =
      bufferedAmountBytes > HIGH_WATER_BUFFERED_BYTES || rttMs > 180 || packetLossRate > 0.05;
    const isHealthy =
      bufferedAmountBytes < LOW_WATER_BUFFERED_BYTES && rttMs < 90 && packetLossRate < 0.01;

    if (isCongested) {
      this.congestionLevel = Math.min(2, this.congestionLevel + 1);
    } else if (isHealthy) {
      this.congestionLevel = Math.max(0, this.congestionLevel - 1);
    }

    if (this.congestionLevel === 0) {
      this.effectiveHz = Math.min(this.maxHz, this.baseHz);
    } else if (this.congestionLevel === 1) {
      this.effectiveHz = Math.max(this.minHz, Math.min(60, this.baseHz));
    } else {
      this.effectiveHz = this.minHz;
    }
  }

  shouldSendSnapshot(nowMs: number, bufferedAmountBytes = 0): boolean {
    if (this.mode === REPLICATION_MODES.SPARSE) {
      return false;
    }
    if (bufferedAmountBytes > HIGH_WATER_BUFFERED_BYTES * 2) {
      return false;
    }
    const intervalMs = 1000 / this.effectiveHz;
    if (nowMs - this.lastSnapshotSentMs >= intervalMs * 0.9) {
      this.lastSnapshotSentMs = nowMs;
      return true;
    }
    return false;
  }

  shouldSendSparsePing(nowMs: number): boolean {
    if (this.mode !== REPLICATION_MODES.SPARSE) {
      return false;
    }
    if (nowMs - this.lastSparsePingSentMs >= this.sparsePingIntervalMs) {
      this.lastSparsePingSentMs = nowMs;
      return true;
    }
    return false;
  }

  private adaptiveSendDivisor = 1;
  private lastAdaptiveEvalMs = 0;

  evaluateAdaptiveSendDivisor(
    bufferedBytes: number,
    rttMs: number,
    packetLossRate: number,
    nowMs = performance.now()
  ): number {
    if (nowMs - this.lastAdaptiveEvalMs < 250) return this.adaptiveSendDivisor;
    this.lastAdaptiveEvalMs = nowMs;
    if (bufferedBytes > HIGH_WATER_BUFFERED_BYTES || rttMs > 180 || packetLossRate > 0.08) {
      this.adaptiveSendDivisor = 4;
    } else if (bufferedBytes > LOW_WATER_BUFFERED_BYTES || rttMs > 100 || packetLossRate > 0.03) {
      this.adaptiveSendDivisor = 2;
    } else {
      this.adaptiveSendDivisor = 1;
    }
    return this.adaptiveSendDivisor;
  }
}
