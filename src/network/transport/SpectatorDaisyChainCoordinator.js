/**
 * SpectatorDaisyChainCoordinator.js
 * Topology coordinator and post-rollback committed snapshot relay buffer for P2P Spectator Daisy-Chaining.
 * Offloads spectator downlink bandwidth from the Authoritative Host onto relay-capable Player clients.
 */

export const DEFAULT_COMMITTED_ROLLBACK_WINDOW_MS = 100;
export const DEFAULT_MAX_SPECTATORS_PER_CLIENT_NODE = 2;

export class SpectatorDaisyChainCoordinator {
  constructor(options = {}) {
    this.hostDirectPlayerThreshold = options.hostDirectPlayerThreshold ?? 4;
    this.maxSpectatorsPerNode = options.maxSpectatorsPerNode ?? DEFAULT_MAX_SPECTATORS_PER_CLIENT_NODE;
    this.rollbackCommitWindowMs = options.rollbackCommitWindowMs ?? DEFAULT_COMMITTED_ROLLBACK_WINDOW_MS;
    this.relayNodes = new Map();
    this.spectatorAssignments = new Map();
  }

  registerRelayNode(peerId, nodeInfo = {}) {
    if (!peerId) return;
    const existing = this.relayNodes.get(peerId);
    this.relayNodes.set(peerId, {
      peerId,
      playerName: nodeInfo.playerName || existing?.playerName || 'Player',
      role: nodeInfo.role || existing?.role || 'player',
      allowSpectatorRelay: nodeInfo.allowSpectatorRelay ?? existing?.allowSpectatorRelay ?? true,
      rttMs: nodeInfo.rttMs ?? existing?.rttMs ?? 20,
      downstreamSpectators: existing?.downstreamSpectators || new Set(),
      updatedAt: Date.now(),
    });
  }

  updateNodeMetrics(peerId, patch = {}) {
    const node = this.relayNodes.get(peerId);
    if (!node) return;
    if (patch.allowSpectatorRelay !== undefined) {
      node.allowSpectatorRelay = Boolean(patch.allowSpectatorRelay);
    }
    if (typeof patch.rttMs === 'number' && Number.isFinite(patch.rttMs)) {
      node.rttMs = patch.rttMs;
    }
    node.updatedAt = Date.now();
  }

  unregisterNode(peerId) {
    if (!peerId) return;
    this.relayNodes.delete(peerId);
    const prevParent = this.spectatorAssignments.get(peerId);
    if (prevParent && this.relayNodes.has(prevParent)) {
      this.relayNodes.get(prevParent).downstreamSpectators.delete(peerId);
    }
    this.spectatorAssignments.delete(peerId);
  }

  selectUpstreamRelayForSpectator(spectatorPeerId, activeHostPlayerCount = 0, hostPeerId = 'host') {
    if (activeHostPlayerCount < this.hostDirectPlayerThreshold) {
      return {
        mode: 'direct_host',
        upstreamPeerId: hostPeerId,
        commitDelayMs: 0,
      };
    }

    let bestCandidate = null;
    let bestScore = Infinity;

    for (const node of this.relayNodes.values()) {
      if (node.peerId === spectatorPeerId) continue;
      if (!node.allowSpectatorRelay) continue;
      if (node.downstreamSpectators.size >= this.maxSpectatorsPerNode) continue;

      const loadPenalty = node.downstreamSpectators.size * 65;
      const rolePenalty = node.role === 'spectator' ? 40 : 0;
      const score = (node.rttMs || 25) + loadPenalty + rolePenalty;
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = node;
      }
    }

    if (!bestCandidate) {
      return {
        mode: 'direct_host',
        upstreamPeerId: hostPeerId,
        commitDelayMs: 0,
      };
    }

    bestCandidate.downstreamSpectators.add(spectatorPeerId);
    this.spectatorAssignments.set(spectatorPeerId, bestCandidate.peerId);

    return {
      mode: 'daisy_chain',
      upstreamPeerId: bestCandidate.peerId,
      upstreamPlayerName: bestCandidate.playerName,
      commitDelayMs: this.rollbackCommitWindowMs,
    };
  }

  clear() {
    this.relayNodes.clear();
    this.spectatorAssignments.clear();
  }
}

export class CommittedFrameDaisyChainBuffer {
  constructor(commitDelayMs = DEFAULT_COMMITTED_ROLLBACK_WINDOW_MS) {
    this.commitDelayMs = commitDelayMs;
    this.pendingSnapshots = [];
  }

  enqueueVerifiedSnapshot(packetBuffer, serverTick, receivedAtMs = performance.now()) {
    if (!packetBuffer) return;
    this.pendingSnapshots.push({
      packetBuffer,
      serverTick,
      receivedAtMs,
    });
    if (this.pendingSnapshots.length > 64) {
      this.pendingSnapshots.shift();
    }
  }

  drainCommittedSnapshots(nowMs = performance.now()) {
    if (this.pendingSnapshots.length === 0) return [];
    const committed = [];
    while (this.pendingSnapshots.length > 0) {
      const head = this.pendingSnapshots[0];
      if (nowMs - head.receivedAtMs >= this.commitDelayMs) {
        committed.push(this.pendingSnapshots.shift());
      } else {
        break;
      }
    }
    return committed;
  }

  clear() {
    this.pendingSnapshots.length = 0;
  }
}
