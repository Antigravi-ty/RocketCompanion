/**
 * SignalingMultiRelayTransportPool.ts
 * Stateful SubController managing concurrent staggered signaling relay transports,
 * per-relay bounded auto-reconnect, match-phase relay convergence, and routed E2EE frame dispatch.
 */

import { MqttWebSocketClient } from './MqttWebSocketClient.ts';
import { SupabaseRealtimeSignalingClient } from './SupabaseRealtimeSignalingClient.ts';
import {
  getSignalingRelays,
  type SignalingRelaySpec,
} from './signalingRelayConfig.ts';
import {
  computeConnectivityMaskFromRelayIds,
  createSignalingRelayTransport,
  getSlotBitForRelayId,
  resolveCoHostedEdgeBridgeUrlForRelay,
  type RelayTransportClient,
  type RelayTransportFactoryContext,
} from './signalingRelaySlotRegistry.ts';
import type { DeterministicRoomContext } from './SignalingCryptoSession.ts';
import {
  SignalingRelayHealthSupervisor,
  getSignalingRelayMatchPolicy,
  type SignalingPoolHealthSnapshot,
  type SignalingRelayMatchPolicy,
} from './SignalingRelayLifecyclePolicy.ts';

export type {
  RelayTransportClient,
  RelayTransportFactoryContext,
  SignalingPoolHealthSnapshot,
  SignalingRelayMatchPolicy,
};

export interface SignalingRelayLaunchHooks {
  role: string;
  peerId: string;
  roomId: string;
  playerName: string;
  roomContext: DeterministicRoomContext;
  allowedMask?: number;
  isSkipLaunch?: () => boolean;
  onFirstRelayOpen: (info: { relayId: string; relayLabel: string; topicHash: string }) => void;
  onRelayConnected?: (relayId: string) => void;
  onRelayHealthChanged?: (snapshot: SignalingPoolHealthSnapshot) => void;
  onFrameReceived: (relayId: string, frame: Record<string, unknown>) => void;
  onAllRelaysClosed: (lastClosedRelayId: string) => void;
  onAllRelaysFailed: (finalError: Error) => void;
}

export class SignalingMultiRelayTransportPool {
  transports = new Map<string, RelayTransportClient>();
  relayConfigs = new Map<string, SignalingRelaySpec>();
  activeRelayId: string | null = null;
  readonly healthSupervisor = new SignalingRelayHealthSupervisor();

  private pausedMatchRelays = new Set<string>();
  private lastHooks: SignalingRelayLaunchHooks | null = null;
  private staggerTimers: Array<ReturnType<typeof setTimeout>> = [];
  private isCleanedUp = false;

  get activeClient(): RelayTransportClient | null {
    if (this.activeRelayId && this.transports.has(this.activeRelayId)) {
      return this.transports.get(this.activeRelayId) || null;
    }
    for (const transport of this.transports.values()) {
      if (transport.isConnected) return transport;
    }
    return null;
  }

  getRelayLabel(relayId: string | null | undefined): string | null {
    if (relayId && this.relayConfigs.has(relayId)) {
      return this.relayConfigs.get(relayId)!.label;
    }
    if (this.activeRelayId && this.relayConfigs.has(this.activeRelayId)) {
      return this.relayConfigs.get(this.activeRelayId)!.label;
    }
    for (const [id, transport] of this.transports.entries()) {
      if (transport.isConnected && this.relayConfigs.has(id)) {
        return this.relayConfigs.get(id)!.label;
      }
    }
    return relayId || null;
  }

  getConnectedRelayIds(): string[] {
    const ids: string[] = [];
    for (const [relayId, transport] of this.transports.entries()) {
      if (transport.isConnected) {
        ids.push(relayId);
      }
    }
    return ids;
  }

  getConnectedConnectivityMask(): number {
    return computeConnectivityMaskFromRelayIds(this.getConnectedRelayIds());
  }

  getHealthSnapshot(): SignalingPoolHealthSnapshot {
    return this.healthSupervisor.getSnapshot(this.getConnectedConnectivityMask());
  }

  private emitHealthSnapshot(): void {
    this.lastHooks?.onRelayHealthChanged?.(this.getHealthSnapshot());
  }

  getBestRelayIdForBridge(preferredRelayId: string | null = null): string | null {
    if (preferredRelayId) {
      const pref = this.transports.get(preferredRelayId);
      if (pref && pref.isConnected) return preferredRelayId;
    }
    let bestId: string | null = null;
    let bestRtt = Number.POSITIVE_INFINITY;
    for (const [id, transport] of this.transports.entries()) {
      if (!transport.isConnected) continue;
      const rtt =
        typeof (transport as MqttWebSocketClient | SupabaseRealtimeSignalingClient).loopbackRttMs ===
          'number' &&
        (transport as MqttWebSocketClient | SupabaseRealtimeSignalingClient).loopbackRttMs > 0
          ? (transport as MqttWebSocketClient | SupabaseRealtimeSignalingClient).loopbackRttMs
          : 500;
      if (rtt < bestRtt) {
        bestRtt = rtt;
        bestId = id;
      }
    }
    return bestId || this.activeRelayId;
  }

  sendOnRelay(relayId: string, payload: Record<string, unknown>, qos = 0): boolean {
    const transport = this.transports.get(relayId);
    if (!transport || !transport.isConnected) return false;
    return (transport as MqttWebSocketClient).send(payload, qos);
  }

  async sendBridgeOnRelay(relayId: string, payload: Record<string, unknown>): Promise<boolean> {
    const targetId = this.getBestRelayIdForBridge(relayId);
    if (!targetId) return false;
    const transport = this.transports.get(targetId);
    if (!transport || !transport.isConnected) return false;

    const frameWithMsgId = {
      ...payload,
      _brgMsgId:
        payload._brgMsgId ||
        `${targetId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    if (transport instanceof SupabaseRealtimeSignalingClient) {
      const res = await transport.sendBridge(frameWithMsgId);
      return res.ok;
    }

    if (transport instanceof MqttWebSocketClient) {
      const relayCfg = this.relayConfigs.get(targetId);
      const edgeUrl = resolveCoHostedEdgeBridgeUrlForRelay(
        targetId,
        relayCfg?.edgeFunctionBridgeUrl
      );
      if (edgeUrl) {
        try {
          await fetch(`${edgeUrl}?action=logs`, { method: 'GET' });
        } catch {
          // Ignore Edge warmup ping failure; EMQX Rule Engine or warm listener will handle
        }
      }
      return transport.sendBridge(frameWithMsgId, undefined, 1);
    }

    return false;
  }

  sendRoutedFrame(
    wrapper: Record<string, unknown>,
    preferredRelayId: string | null = null,
    qos = 1
  ): boolean {
    const routeRelayId = preferredRelayId || this.activeRelayId;
    if (routeRelayId && this.transports.has(routeRelayId)) {
      const transport = this.transports.get(routeRelayId)!;
      if (transport.isConnected) {
        return (transport as MqttWebSocketClient).send(wrapper, qos);
      }
    }

    let sentAny = false;
    for (const transport of this.transports.values()) {
      if (transport.isConnected) {
        if ((transport as MqttWebSocketClient).send(wrapper, qos)) {
          sentAny = true;
        }
      }
    }
    return sentAny;
  }

  closeRedundantRelays(winningRelayId: string): void {
    this.activeRelayId = winningRelayId;
    for (const [id, transport] of this.transports.entries()) {
      if (id !== winningRelayId) {
        this.healthSupervisor.markPausedInMatch(id);
        try {
          transport.close();
        } catch (_) {
          // Ignore close error
        }
        this.transports.delete(id);
      }
    }
    this.emitHealthSnapshot();
  }

  applyMatchPhaseRelayConvergence(
    activePlayerRelayIds: Set<string>,
    policy: SignalingRelayMatchPolicy = getSignalingRelayMatchPolicy()
  ): void {
    if (this.isCleanedUp || this.lastHooks?.role !== 'host') return;
    const allProbedIds = Array.from(this.relayConfigs.keys());
    const keepIds = this.healthSupervisor.resolveMatchPhaseRelaysToKeep(
      allProbedIds,
      activePlayerRelayIds,
      policy
    );

    for (const [id, transport] of this.transports.entries()) {
      if (!keepIds.has(id)) {
        this.pausedMatchRelays.add(id);
        this.healthSupervisor.markPausedInMatch(id);
        try {
          transport.close();
        } catch (_) {
          // Ignore
        }
        this.transports.delete(id);
      }
    }
    this.emitHealthSnapshot();
  }

  restoreLobbyRelays(): void {
    if (this.isCleanedUp || !this.lastHooks) return;
    const hooks = this.lastHooks;
    for (const relayId of Array.from(this.pausedMatchRelays)) {
      this.pausedMatchRelays.delete(relayId);
      const relay = this.relayConfigs.get(relayId);
      if (relay) {
        this.launchSingleRelay(relay, hooks, 4500);
      }
    }
    this.emitHealthSnapshot();
  }

  async connectStaggered(timeoutMs: number, hooks: SignalingRelayLaunchHooks): Promise<void> {
    this.cleanup();
    this.isCleanedUp = false;
    this.lastHooks = hooks;

    const allRelays = getSignalingRelays();
    if (allRelays.length === 0) {
      const noProfileErr = new Error(
        'No signaling profile loaded. Please import a .rctbnspib credential bundle in Settings → Advanced.'
      );
      hooks.onAllRelaysFailed(noProfileErr);
      throw noProfileErr;
    }

    const effectiveMask =
      hooks.role === 'host' && typeof hooks.allowedMask === 'number' && (hooks.allowedMask & 0x0f) !== 0
        ? hooks.allowedMask & 0x0f
        : 0x0f;
    this.healthSupervisor.setProbedMask(effectiveMask);

    const filteredRelays = allRelays.filter((relay) => {
      if (hooks.role !== 'host') return true;
      const bit = getSlotBitForRelayId(relay.id);
      if (bit === 0) return true;
      return (effectiveMask & bit) !== 0;
    });
    const relays = filteredRelays.length > 0 ? filteredRelays : allRelays;

    for (const relay of relays) {
      this.relayConfigs.set(relay.id, relay);
      this.healthSupervisor.registerRelay(relay.id, relay.label);
    }

    return new Promise((resolve, reject) => {
      let anyConnected = false;
      let failedCount = 0;
      const totalRelays = relays.length;
      let globalTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const settleFirstSuccess = (relayId: string) => {
        if (anyConnected || this.isCleanedUp) return;
        anyConnected = true;
        if (globalTimeoutHandle) {
          clearTimeout(globalTimeoutHandle);
          globalTimeoutHandle = null;
        }
        if (!this.activeRelayId) {
          this.activeRelayId = relayId;
        }
        hooks.onFirstRelayOpen({
          relayId,
          relayLabel: this.relayConfigs.get(relayId)?.label || relayId,
          topicHash: hooks.roomContext.topicHash,
        });
        resolve();
      };

      const recordRelayFailure = (err: unknown) => {
        failedCount++;
        if (!anyConnected && failedCount >= totalRelays) {
          if (globalTimeoutHandle) {
            clearTimeout(globalTimeoutHandle);
            globalTimeoutHandle = null;
          }
          const finalErr =
            err instanceof Error ? err : new Error('All signaling relays failed to connect');
          hooks.onAllRelaysFailed(finalErr);
          reject(finalErr);
        }
      };

      if (timeoutMs > 0) {
        globalTimeoutHandle = setTimeout(() => {
          if (!anyConnected && !this.isCleanedUp) {
            const timeoutErr = new Error(
              `Signaling connection timed out after ${timeoutMs}ms across all relays`
            );
            hooks.onAllRelaysFailed(timeoutErr);
            reject(timeoutErr);
          }
        }, timeoutMs);
      }

      for (const relay of relays) {
        const delay = Math.max(0, relay.staggerDelayMs || 0);
        const launch = () => {
          if (this.isCleanedUp || hooks.isSkipLaunch?.()) return;
          const perRelayTimeout = Math.min(timeoutMs || 5000, relay.connectTimeoutMs || 4500);
          this.launchSingleRelay(
            relay,
            hooks,
            perRelayTimeout,
            () => settleFirstSuccess(relay.id),
            recordRelayFailure
          );
        };

        if (delay === 0) {
          launch();
        } else {
          const timer = setTimeout(launch, delay);
          this.staggerTimers.push(timer);
        }
      }
    });
  }

  private launchSingleRelay(
    relay: SignalingRelaySpec,
    hooks: SignalingRelayLaunchHooks,
    perRelayTimeout: number,
    onSuccess?: () => void,
    onFailure?: (err: unknown) => void
  ): void {
    if (this.isCleanedUp) return;

    const existing = this.transports.get(relay.id);
    if (existing) {
      if (existing.isConnected) return;
      try {
        existing.close();
      } catch (_) {
        // Ignore
      }
      this.transports.delete(relay.id);
    }

    this.healthSupervisor.markConnecting(relay.id);
    const transport = createSignalingRelayTransport(relay, hooks);
    this.transports.set(relay.id, transport);

    transport.on('message', (msg?: Record<string, unknown>) => {
      if (!this.isCleanedUp && msg) {
        hooks.onFrameReceived(relay.id, msg);
      }
    });

    transport.on('close', () => {
      this.handleRelayClosed(relay.id, hooks);
    });

    transport
      .connect(perRelayTimeout)
      .then(() => {
        if (this.isCleanedUp) {
          transport.close();
          return;
        }
        this.healthSupervisor.markConnected(relay.id);
        onSuccess?.();
        hooks.onRelayConnected?.(relay.id);
        this.emitHealthSnapshot();
      })
      .catch((err: unknown) => {
        onFailure?.(err);
        this.handleRelayClosed(relay.id, hooks);
      });
  }

  private handleRelayClosed(relayId: string, hooks: SignalingRelayLaunchHooks): void {
    if (this.isCleanedUp || this.pausedMatchRelays.has(relayId)) return;

    let anyStillOpen = false;
    for (const [id, transport] of this.transports.entries()) {
      if (id !== relayId && transport.isConnected) {
        anyStillOpen = true;
        if (this.activeRelayId === relayId) {
          this.activeRelayId = id;
        }
        break;
      }
    }

    this.healthSupervisor.handleRelayDisconnected(
      relayId,
      anyStillOpen,
      (retryId) => {
        if (this.isCleanedUp) return;
        const relay = this.relayConfigs.get(retryId);
        if (relay) {
          this.launchSingleRelay(relay, hooks, relay.connectTimeoutMs || 4500);
        }
      },
      () => {
        this.emitHealthSnapshot();
      }
    );

    if (!anyStillOpen && !this.isCleanedUp) {
      this.emitHealthSnapshot();
      hooks.onAllRelaysClosed(relayId);
    }
  }

  cleanup(): void {
    this.isCleanedUp = true;
    this.healthSupervisor.dispose();
    this.pausedMatchRelays.clear();
    for (const timer of this.staggerTimers) {
      clearTimeout(timer);
    }
    this.staggerTimers.length = 0;

    for (const transport of this.transports.values()) {
      try {
        transport.close();
      } catch (_) {
        // Ignore close error
      }
    }
    this.transports.clear();
    this.activeRelayId = null;
  }
}
