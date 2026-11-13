/**
 * src/network/sync/EntityAuthorityRouter.ts
 * Per-slot entity physics authority router supporting Host-Authoritative,
 * Peer Local-Predicted, Replay Read-Only, and scheduled Intervene Handoff.
 */

export const ENTITY_AUTHORITY_MODE = Object.freeze({
  HOST_AUTHORITATIVE: 0,
  PEER_LOCAL_PREDICTED: 1,
  REPLAY_READ_ONLY: 2,
  INTERVENE_HANDOFF: 3,
} as const);

export type EntityAuthorityMode =
  (typeof ENTITY_AUTHORITY_MODE)[keyof typeof ENTITY_AUTHORITY_MODE];

export interface SlotAuthorityEntry {
  slot: number;
  mode: EntityAuthorityMode;
  ownerPeerId: string | null;
  handoffTargetPeerId: string | null;
  handoffAtTick: number;
  handoffNextMode: EntityAuthorityMode;
}

export class EntityAuthorityRouter {
  private readonly slots = new Map<number, SlotAuthorityEntry>();
  ballAuthorityMode: EntityAuthorityMode = ENTITY_AUTHORITY_MODE.HOST_AUTHORITATIVE;

  setBallAuthority(mode: EntityAuthorityMode): void {
    this.ballAuthorityMode = mode;
  }

  setSlotAuthority(
    slot: number,
    mode: EntityAuthorityMode,
    ownerPeerId: string | null = null
  ): void {
    this.slots.set(slot, {
      slot,
      mode,
      ownerPeerId,
      handoffTargetPeerId: null,
      handoffAtTick: -1,
      handoffNextMode: mode,
    });
  }

  setAllReplayReadOnly(maxSlots = 8): void {
    this.ballAuthorityMode = ENTITY_AUTHORITY_MODE.REPLAY_READ_ONLY;
    for (let slot = 0; slot < maxSlots; slot++) {
      this.setSlotAuthority(slot, ENTITY_AUTHORITY_MODE.REPLAY_READ_ONLY, null);
    }
  }

  scheduleInterveneHandoff(
    slot: number,
    targetPeerId: string,
    handoffAtTick: number,
    nextMode: EntityAuthorityMode = ENTITY_AUTHORITY_MODE.PEER_LOCAL_PREDICTED
  ): void {
    const existing = this.slots.get(slot);
    this.slots.set(slot, {
      slot,
      mode: ENTITY_AUTHORITY_MODE.INTERVENE_HANDOFF,
      ownerPeerId: existing?.ownerPeerId ?? null,
      handoffTargetPeerId: targetPeerId,
      handoffAtTick,
      handoffNextMode: nextMode,
    });
  }

  advanceTick(currentTick: number): number[] {
    const transitionedSlots: number[] = [];
    for (const entry of this.slots.values()) {
      if (
        entry.mode === ENTITY_AUTHORITY_MODE.INTERVENE_HANDOFF &&
        entry.handoffAtTick >= 0 &&
        currentTick >= entry.handoffAtTick
      ) {
        entry.mode = entry.handoffNextMode;
        entry.ownerPeerId = entry.handoffTargetPeerId;
        entry.handoffTargetPeerId = null;
        entry.handoffAtTick = -1;
        transitionedSlots.push(entry.slot);
      }
    }
    return transitionedSlots;
  }

  getSlotAuthority(slot: number): SlotAuthorityEntry {
    return (
      this.slots.get(slot) ?? {
        slot,
        mode: ENTITY_AUTHORITY_MODE.HOST_AUTHORITATIVE,
        ownerPeerId: null,
        handoffTargetPeerId: null,
        handoffAtTick: -1,
        handoffNextMode: ENTITY_AUTHORITY_MODE.HOST_AUTHORITATIVE,
      }
    );
  }

  shouldLocallyPredict(slot: number, localPeerId: string | null): boolean {
    const entry = this.getSlotAuthority(slot);
    if (entry.mode === ENTITY_AUTHORITY_MODE.PEER_LOCAL_PREDICTED) {
      return entry.ownerPeerId === null || entry.ownerPeerId === localPeerId;
    }
    return false;
  }

  shouldApplyRemoteSnapshot(slot: number, localPeerId: string | null): boolean {
    const entry = this.getSlotAuthority(slot);
    if (entry.mode === ENTITY_AUTHORITY_MODE.REPLAY_READ_ONLY) return true;
    if (entry.mode === ENTITY_AUTHORITY_MODE.HOST_AUTHORITATIVE) return true;
    if (entry.mode === ENTITY_AUTHORITY_MODE.INTERVENE_HANDOFF) return true;
    return entry.ownerPeerId !== null && entry.ownerPeerId !== localPeerId;
  }

  buildAuthorityMask(localPeerId: string | null): number {
    let mask = 0;
    for (let slot = 0; slot < 8; slot++) {
      if (this.shouldLocallyPredict(slot, localPeerId)) {
        mask |= 1 << slot;
      }
    }
    return mask;
  }
}
