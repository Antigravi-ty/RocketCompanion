/**
 * src/network/server/activities/TrainingGhostBallRelay.ts
 * Host Relay coordinator for Ghost Mode multi-ball state distribution in Multiplayer Training.
 * Host receives 1 local ball state per Ghost-enabled client and broadcasts other peers' balls.
 */

export interface GhostBallStateSnapshot {
  ownerPeerId: string;
  tick: number;
  pos: [number, number, number];
  vel: [number, number, number];
  angVel?: [number, number, number];
}

export class TrainingGhostBallRelay {
  private enabled = false;
  private readonly peerBalls = new Map<string, GhostBallStateSnapshot>();

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.peerBalls.clear();
    }
  }

  submitClientBallState(peerId: string, state: Omit<GhostBallStateSnapshot, 'ownerPeerId'>): void {
    if (!this.enabled || !peerId) return;
    this.peerBalls.set(peerId, {
      ownerPeerId: peerId,
      tick: state.tick,
      pos: [...state.pos],
      vel: [...state.vel],
      angVel: state.angVel ? [...state.angVel] : undefined,
    });
  }

  removePeer(peerId: string): void {
    this.peerBalls.delete(peerId);
  }

  buildRelayBroadcastForPeer(targetPeerId: string): GhostBallStateSnapshot[] {
    if (!this.enabled) return [];
    const out: GhostBallStateSnapshot[] = [];
    for (const [ownerId, ball] of this.peerBalls.entries()) {
      if (ownerId !== targetPeerId) {
        out.push(ball);
      }
    }
    return out;
  }

  getAllBalls(): GhostBallStateSnapshot[] {
    return [...this.peerBalls.values()];
  }

  clear(): void {
    this.peerBalls.clear();
  }
}
