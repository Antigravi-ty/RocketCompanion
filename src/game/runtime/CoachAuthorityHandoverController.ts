export type CoachAuthorityMode = 'host_only' | 'client_only' | 'fpv_master_slave';

export interface CoachControlInputSample {
  throttle?: number;
  steer?: number;
  jump?: boolean | number;
  boost?: boolean | number;
  handbrake?: boolean | number;
}

export interface CoachAuthorityStepResult {
  readonly changed: boolean;
  readonly action: 'none' | 'reclaim_to_host' | 'grant_to_client';
  readonly authorityEpoch: number;
  readonly activeInputPeerId: string;
  readonly clientInputEnabled: boolean;
  readonly authorityMode: 'explicit' | 'fpv_master_slave';
}

export const DEFAULT_IDLE_HANDOVER_MS = 300;
const AXIS_DEADZONE = 0.05;

export function hasActiveCoachControlInput(
  controls: CoachControlInputSample | null | undefined
): boolean {
  if (!controls) return false;
  return Boolean(
    Math.abs(controls.throttle ?? 0) > AXIS_DEADZONE ||
      Math.abs(controls.steer ?? 0) > AXIS_DEADZONE ||
      controls.jump ||
      controls.boost ||
      controls.handbrake
  );
}

export function normalizeCoachAuthorityMode(
  mode: CoachAuthorityMode | 'explicit' | undefined,
  clientInputEnabled: boolean
): CoachAuthorityMode {
  if (mode === 'host_only' || mode === 'client_only' || mode === 'fpv_master_slave') {
    return mode;
  }
  if (mode === 'explicit') {
    return clientInputEnabled ? 'client_only' : 'host_only';
  }
  return 'fpv_master_slave';
}

export class CoachAuthorityHandoverController {
  public authorityEpoch = 0;
  public activeInputPeerId = 'host';
  public targetPeerId = 'any';
  public clientInputEnabled = false;
  public authorityMode: CoachAuthorityMode = 'fpv_master_slave';
  public idleHandoverMs = DEFAULT_IDLE_HANDOVER_MS;
  private lastHostInputAtMs = 0;

  public configure(opts: {
    clientInputEnabled?: boolean;
    targetPeerId?: string;
    authorityMode?: CoachAuthorityMode | 'explicit';
    idleHandoverMs?: number;
  }): {
    authorityEpoch: number;
    activeInputPeerId: string;
    authorityMode: 'explicit' | 'fpv_master_slave';
    clientInputEnabled: boolean;
  } {
    if (typeof opts.idleHandoverMs === 'number' && Number.isFinite(opts.idleHandoverMs)) {
      this.idleHandoverMs = Math.max(0, opts.idleHandoverMs);
    }
    if (typeof opts.clientInputEnabled === 'boolean') {
      this.clientInputEnabled = opts.clientInputEnabled;
    }
    if (typeof opts.targetPeerId === 'string' && opts.targetPeerId && opts.targetPeerId !== 'host') {
      this.targetPeerId = opts.targetPeerId;
    }
    if (opts.authorityMode !== undefined) {
      this.authorityMode = normalizeCoachAuthorityMode(opts.authorityMode, this.clientInputEnabled);
    }
    this.authorityEpoch += 1;
    const shouldGrant =
      this.clientInputEnabled &&
      this.authorityMode !== 'host_only' &&
      opts.targetPeerId !== 'host';
    this.activeInputPeerId = shouldGrant ? this.targetPeerId || 'any' : 'host';
    this.lastHostInputAtMs = 0;
    return {
      authorityEpoch: this.authorityEpoch,
      activeInputPeerId: this.activeInputPeerId,
      authorityMode: this.getWireAuthorityMode(),
      clientInputEnabled: this.clientInputEnabled,
    };
  }

  public getWireAuthorityMode(): 'explicit' | 'fpv_master_slave' {
    return this.authorityMode === 'fpv_master_slave' ? 'fpv_master_slave' : 'explicit';
  }

  public isEpochValid(epoch: number): boolean {
    return epoch === this.authorityEpoch;
  }

  public step(params: {
    nowMs: number;
    controls: CoachControlInputSample | null | undefined;
    hasTargetPeer?: boolean;
  }): CoachAuthorityStepResult {
    const { nowMs, controls, hasTargetPeer = true } = params;

    if (this.authorityMode === 'host_only') {
      if (this.activeInputPeerId !== 'host') {
        this.authorityEpoch += 1;
        this.activeInputPeerId = 'host';
        return this.buildResult(true, 'reclaim_to_host');
      }
      return this.buildResult(false, 'none');
    }

    if (this.authorityMode === 'client_only') {
      if (this.clientInputEnabled && hasTargetPeer && this.activeInputPeerId === 'host') {
        this.authorityEpoch += 1;
        this.activeInputPeerId = this.targetPeerId || 'any';
        return this.buildResult(true, 'grant_to_client');
      }
      return this.buildResult(false, 'none');
    }

    const hostActive = hasActiveCoachControlInput(controls);
    if (hostActive) {
      this.lastHostInputAtMs = nowMs;
      if (this.activeInputPeerId !== 'host') {
        this.authorityEpoch += 1;
        this.activeInputPeerId = 'host';
        return this.buildResult(true, 'reclaim_to_host');
      }
      return this.buildResult(false, 'none');
    }

    if (this.clientInputEnabled && hasTargetPeer && this.activeInputPeerId === 'host') {
      if (this.lastHostInputAtMs === 0) {
        this.lastHostInputAtMs = nowMs;
        return this.buildResult(false, 'none');
      }
      if (nowMs - this.lastHostInputAtMs >= this.idleHandoverMs) {
        this.authorityEpoch += 1;
        this.activeInputPeerId = this.targetPeerId || 'any';
        return this.buildResult(true, 'grant_to_client');
      }
    }

    return this.buildResult(false, 'none');
  }

  public reset(): void {
    this.authorityEpoch = 0;
    this.activeInputPeerId = 'host';
    this.targetPeerId = 'any';
    this.clientInputEnabled = false;
    this.authorityMode = 'fpv_master_slave';
    this.lastHostInputAtMs = 0;
  }

  private buildResult(
    changed: boolean,
    action: 'none' | 'reclaim_to_host' | 'grant_to_client'
  ): CoachAuthorityStepResult {
    return {
      changed,
      action,
      authorityEpoch: this.authorityEpoch,
      activeInputPeerId: this.activeInputPeerId,
      clientInputEnabled: this.clientInputEnabled,
      authorityMode: this.getWireAuthorityMode(),
    };
  }
}
