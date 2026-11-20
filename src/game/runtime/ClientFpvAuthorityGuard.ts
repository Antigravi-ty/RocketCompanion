export type FpvGuardAuthorityMode = 'explicit' | 'fpv_master_slave';

export interface ClientFpvAuthorityUpdateInput {
  authorityEpoch: number;
  activeInputPeerId: string;
  localPeerId: string;
  clientInputEnabled?: boolean;
  authorityMode?: FpvGuardAuthorityMode;
}

export interface ClientFpvAuthorityUpdateResult {
  readonly accepted: boolean;
  readonly preempted: boolean;
  readonly granted: boolean;
  readonly shouldStopLocalPhysics: boolean;
  readonly shouldSnapToAuthoritative: boolean;
  readonly authorityEpoch: number;
  readonly activeInputPeerId: string;
}

export class ClientFpvAuthorityGuard {
  public authorityEpoch = 0;
  public activeInputPeerId = 'host';
  public clientInputEnabled = false;
  public authorityMode: FpvGuardAuthorityMode = 'fpv_master_slave';

  public hasLocalBroadcastAuthority(localPeerId: string): boolean {
    if (!this.clientInputEnabled) return false;
    if (this.activeInputPeerId === 'host') return false;
    if (this.activeInputPeerId === 'any') return true;
    return Boolean(localPeerId) && this.activeInputPeerId === localPeerId;
  }

  public shouldIgnoreLocalInput(localPeerId: string): boolean {
    return !this.hasLocalBroadcastAuthority(localPeerId);
  }

  public canBroadcastLocalFrame(epoch: number, localPeerId: string): boolean {
    return epoch === this.authorityEpoch && this.hasLocalBroadcastAuthority(localPeerId);
  }

  public applyIncomingAuthority(
    input: ClientFpvAuthorityUpdateInput
  ): ClientFpvAuthorityUpdateResult {
    const incomingEpoch = Math.round(input.authorityEpoch);
    if (!Number.isFinite(incomingEpoch) || incomingEpoch < this.authorityEpoch) {
      const hasAuth = this.hasLocalBroadcastAuthority(input.localPeerId);
      return {
        accepted: false,
        preempted: false,
        granted: false,
        shouldStopLocalPhysics: !hasAuth,
        shouldSnapToAuthoritative: false,
        authorityEpoch: this.authorityEpoch,
        activeInputPeerId: this.activeInputPeerId,
      };
    }

    const wasLocalAuth = this.hasLocalBroadcastAuthority(input.localPeerId);
    const nextPeer =
      typeof input.activeInputPeerId === 'string' && input.activeInputPeerId.trim()
        ? input.activeInputPeerId.trim()
        : 'host';

    this.authorityEpoch = incomingEpoch;
    this.activeInputPeerId = nextPeer;
    if (typeof input.clientInputEnabled === 'boolean') {
      this.clientInputEnabled = input.clientInputEnabled;
    }
    if (input.authorityMode === 'explicit' || input.authorityMode === 'fpv_master_slave') {
      this.authorityMode = input.authorityMode;
    }

    const isLocalAuth = this.hasLocalBroadcastAuthority(input.localPeerId);
    const preempted = wasLocalAuth && !isLocalAuth;
    const granted = !wasLocalAuth && isLocalAuth;

    return {
      accepted: true,
      preempted,
      granted,
      shouldStopLocalPhysics: !isLocalAuth,
      shouldSnapToAuthoritative: preempted || (!isLocalAuth && incomingEpoch > 0),
      authorityEpoch: this.authorityEpoch,
      activeInputPeerId: this.activeInputPeerId,
    };
  }

  public reset(): void {
    this.authorityEpoch = 0;
    this.activeInputPeerId = 'host';
    this.clientInputEnabled = false;
    this.authorityMode = 'fpv_master_slave';
  }
}
