/**
 * src/network/sync/SyncAuthorityRouter.ts
 * Entity-level physical authority routing (host / peer / replay_readonly / takeover_handoff)
 * and Follow-Host CSR state tracking.
 */

import {
  ACTIVITY_IDS,
  type CsrStateBroadcastPayload,
  type RoomActivitySwitchPayload,
} from '../protocol/ReplicationBusProtocol.ts';

export const ENTITY_AUTHORITY_ROLES = Object.freeze({
  HOST: 'host',
  PEER: 'peer',
  REPLAY_READONLY: 'replay_readonly',
  TAKEOVER_HANDOFF: 'takeover_handoff',
} as const);

export type EntityAuthorityRole =
  (typeof ENTITY_AUTHORITY_ROLES)[keyof typeof ENTITY_AUTHORITY_ROLES];

export interface EntityAuthorityEntry {
  entityKey: string;
  role: EntityAuthorityRole;
  ownerSessionId: string | null;
  handoffTargetSessionId: string | null;
  handoffCountdownTicks: number;
  epoch: number;
}

export class SyncAuthorityRouter {
  private readonly entries = new Map<string, EntityAuthorityEntry>();
  private currentEpoch = 0;
  private followHostEnabled = false;
  private latestCsrSummary: CsrStateBroadcastPayload | null = null;

  getEpoch(): number {
    return this.currentEpoch;
  }

  isFollowHostEnabled(): boolean {
    return this.followHostEnabled;
  }

  setFollowHostEnabled(enabled: boolean): void {
    this.followHostEnabled = Boolean(enabled);
  }

  getLatestCsrSummary(): CsrStateBroadcastPayload | null {
    return this.latestCsrSummary;
  }

  applyCsrBroadcast(summary: CsrStateBroadcastPayload): void {
    if (summary.epoch >= this.currentEpoch) {
      this.latestCsrSummary = summary;
      this.followHostEnabled = Boolean(summary.followHostEnabled);
    }
  }

  setEntityAuthority(
    entityKey: string,
    role: EntityAuthorityRole,
    ownerSessionId: string | null = null
  ): void {
    this.entries.set(entityKey, {
      entityKey,
      role,
      ownerSessionId,
      handoffTargetSessionId: null,
      handoffCountdownTicks: 0,
      epoch: this.currentEpoch,
    });
  }

  getEntityAuthority(entityKey: string): EntityAuthorityEntry | null {
    return this.entries.get(entityKey) ?? null;
  }

  applyActivitySwitch(payload: RoomActivitySwitchPayload): void {
    this.currentEpoch = payload.epoch;
    if (typeof payload.followHostEnabled === 'boolean') {
      this.followHostEnabled = payload.followHostEnabled;
    }

    if (payload.activityId === ACTIVITY_IDS.REPLAY) {
      this.setEntityAuthority('ball', ENTITY_AUTHORITY_ROLES.REPLAY_READONLY, null);
      for (const [key, entry] of this.entries.entries()) {
        if (key !== 'ball') {
          this.entries.set(key, {
            ...entry,
            role: ENTITY_AUTHORITY_ROLES.REPLAY_READONLY,
            handoffTargetSessionId: null,
            handoffCountdownTicks: 0,
            epoch: this.currentEpoch,
          });
        }
      }
    } else if (
      payload.activityId === ACTIVITY_IDS.MATCH ||
      payload.activityId === ACTIVITY_IDS.FREEPLAY
    ) {
      this.setEntityAuthority('ball', ENTITY_AUTHORITY_ROLES.HOST, 'host');
    }

    if (payload.authorityMask) {
      for (const [entityKey, rawRole] of Object.entries(payload.authorityMask)) {
        const role = this.normalizeRole(rawRole);
        const existing = this.entries.get(entityKey);
        this.setEntityAuthority(entityKey, role, existing?.ownerSessionId ?? null);
      }
    }
  }

  beginTakeoverHandoff(
    entityKey: string,
    targetSessionId: string,
    countdownTicks = 480
  ): EntityAuthorityEntry {
    const prev = this.entries.get(entityKey);
    const next: EntityAuthorityEntry = {
      entityKey,
      role: ENTITY_AUTHORITY_ROLES.TAKEOVER_HANDOFF,
      ownerSessionId: prev?.ownerSessionId ?? null,
      handoffTargetSessionId: targetSessionId,
      handoffCountdownTicks: Math.max(0, Math.round(countdownTicks)),
      epoch: this.currentEpoch,
    };
    this.entries.set(entityKey, next);
    return next;
  }

  commitTakeoverHandoff(entityKey: string, nextRole: EntityAuthorityRole = 'peer'): boolean {
    const entry = this.entries.get(entityKey);
    if (!entry || entry.role !== ENTITY_AUTHORITY_ROLES.TAKEOVER_HANDOFF) {
      return false;
    }
    this.entries.set(entityKey, {
      entityKey,
      role: nextRole,
      ownerSessionId: entry.handoffTargetSessionId,
      handoffTargetSessionId: null,
      handoffCountdownTicks: 0,
      epoch: this.currentEpoch,
    });
    return true;
  }

  revertToReplayReadonly(entityKey: string): void {
    this.setEntityAuthority(entityKey, ENTITY_AUTHORITY_ROLES.REPLAY_READONLY, null);
  }

  isEntityReadonly(entityKey: string): boolean {
    const entry = this.entries.get(entityKey);
    return entry?.role === ENTITY_AUTHORITY_ROLES.REPLAY_READONLY;
  }

  canAcceptClientInput(entityKey: string, sessionId: string): boolean {
    const entry = this.entries.get(entityKey);
    if (!entry) return true;
    if (entry.role === ENTITY_AUTHORITY_ROLES.REPLAY_READONLY) return false;
    if (entry.role === ENTITY_AUTHORITY_ROLES.TAKEOVER_HANDOFF) return false;
    if (entry.role === ENTITY_AUTHORITY_ROLES.HOST) return sessionId === 'host';
    return entry.ownerSessionId === null || entry.ownerSessionId === sessionId;
  }

  private normalizeRole(raw: string): EntityAuthorityRole {
    if (
      raw === ENTITY_AUTHORITY_ROLES.HOST ||
      raw === ENTITY_AUTHORITY_ROLES.PEER ||
      raw === ENTITY_AUTHORITY_ROLES.REPLAY_READONLY ||
      raw === ENTITY_AUTHORITY_ROLES.TAKEOVER_HANDOFF
    ) {
      return raw;
    }
    return ENTITY_AUTHORITY_ROLES.HOST;
  }
}
