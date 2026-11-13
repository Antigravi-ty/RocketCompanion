/**
 * src/network/server/spectator/InterveneHandoffCoordinator.ts
 * Coordinates multiplayer intervene role authorization (host or trainee client),
 * 4-3-2-1-0 countdown progression, and non-POV policy application at takeover.
 */

import type {
  InterveneAuthorizationRequest,
  InterveneHandoffPhase,
  InterveneHandoffState,
  InterveneNonPovPolicy,
} from '../../protocol/RoomActivityProtocol.ts';
import { MATCH_TICK_RATE } from '../match/matchLoadoutAndSpawnPipeline.ts';

export interface InterveneSystemControlPort {
  enterStateOnlyMode(snap?: Float32Array | number[] | null, cursorTick?: number): void;
  beginInterveneCountdown(sec?: number, snap?: Float32Array | number[] | null): number;
  resumePhysicsFromState(snap?: Float32Array | number[] | null, resumeTick?: number): void;
}

export interface IntervenePhysicsPolicyPort {
  setCarCollisionMask?: (
    carIndex: number,
    interactWithBall: boolean,
    interactWithCars: boolean,
    opacity?: number
  ) => unknown;
  restoreSolidCollisions?: () => void;
  getActiveCarMask?: () => number;
}

export class InterveneHandoffCoordinator {
  private phase: InterveneHandoffPhase = 'idle';
  private authorizedSessionId: string | null = null;
  private targetCarIndex = 0;
  private nonPovPolicy: InterveneNonPovPolicy = 'follow-state';
  private countdownSeconds = 4;
  private countdownRemainingTicks = 0;
  private targetResumeTick = -1;

  getState(): InterveneHandoffState {
    return {
      phase: this.phase,
      authorizedSessionId: this.authorizedSessionId,
      targetCarIndex: this.targetCarIndex,
      nonPovPolicy: this.nonPovPolicy,
      countdownSeconds: this.countdownSeconds,
      countdownRemainingTicks: this.countdownRemainingTicks,
      countdownStepLabel: this.resolveCountdownStepLabel(),
      targetResumeTick: this.targetResumeTick,
    };
  }

  handleRequest(
    req: InterveneAuthorizationRequest,
    systemControl?: InterveneSystemControlPort | null,
    physics?: IntervenePhysicsPolicyPort | null,
    snapshot?: Float32Array | null
  ): InterveneHandoffState {
    switch (req.action) {
      case 'authorize': {
        this.phase = 'authorized';
        this.authorizedSessionId = req.authorizedSessionId ?? 'host';
        this.targetCarIndex = Math.max(0, Math.floor(req.targetCarIndex ?? 0));
        this.nonPovPolicy = req.nonPovPolicy ?? 'follow-state';
        if (typeof req.countdownSeconds === 'number' && Number.isFinite(req.countdownSeconds)) {
          this.countdownSeconds = Math.max(1, Math.min(4, Math.round(req.countdownSeconds)));
        }
        systemControl?.enterStateOnlyMode(snapshot ?? null, req.cursorTick);
        break;
      }
      case 'begin_countdown': {
        if (req.authorizedSessionId !== undefined) {
          this.authorizedSessionId = req.authorizedSessionId;
        }
        if (typeof req.targetCarIndex === 'number') {
          this.targetCarIndex = Math.max(0, Math.floor(req.targetCarIndex));
        }
        if (req.nonPovPolicy) {
          this.nonPovPolicy = req.nonPovPolicy;
        }
        const sec =
          typeof req.countdownSeconds === 'number' && Number.isFinite(req.countdownSeconds)
            ? Math.max(1, Math.min(4, Math.round(req.countdownSeconds)))
            : this.countdownSeconds;
        this.countdownSeconds = sec;
        this.countdownRemainingTicks = Math.max(1, Math.round(sec * MATCH_TICK_RATE));
        this.phase = 'countdown';
        this.targetResumeTick = systemControl?.beginInterveneCountdown(sec, snapshot ?? null) ?? -1;
        break;
      }
      case 'complete': {
        this.completeHandoff(systemControl, physics, snapshot);
        break;
      }
      case 'cancel': {
        this.reset(physics);
        systemControl?.enterStateOnlyMode(snapshot ?? null, req.cursorTick);
        break;
      }
    }
    return this.getState();
  }

  stepCountdownTick(
    systemControl?: InterveneSystemControlPort | null,
    physics?: IntervenePhysicsPolicyPort | null
  ): { transitionedToActive: boolean; state: InterveneHandoffState } {
    if (this.phase !== 'countdown') {
      return { transitionedToActive: false, state: this.getState() };
    }
    if (this.countdownRemainingTicks > 0) {
      this.countdownRemainingTicks -= 1;
    }
    if (this.countdownRemainingTicks <= 0) {
      this.completeHandoff(systemControl, physics, null);
      return { transitionedToActive: true, state: this.getState() };
    }
    return { transitionedToActive: false, state: this.getState() };
  }

  isSessionAuthorizedForCar(sessionId: string, carIndex: number): boolean {
    if (this.phase !== 'active' && this.phase !== 'countdown') {
      return true;
    }
    if (carIndex !== this.targetCarIndex) {
      return this.nonPovPolicy === 'follow-state';
    }
    return this.authorizedSessionId === null || this.authorizedSessionId === sessionId;
  }

  reset(physics?: IntervenePhysicsPolicyPort | null): void {
    this.phase = 'idle';
    this.authorizedSessionId = null;
    this.targetCarIndex = 0;
    this.nonPovPolicy = 'follow-state';
    this.countdownSeconds = 4;
    this.countdownRemainingTicks = 0;
    this.targetResumeTick = -1;
    physics?.restoreSolidCollisions?.();
  }

  private completeHandoff(
    systemControl?: InterveneSystemControlPort | null,
    physics?: IntervenePhysicsPolicyPort | null,
    snapshot?: Float32Array | null
  ): void {
    this.phase = 'active';
    this.countdownRemainingTicks = 0;
    this.applyNonPovPolicy(physics);
    systemControl?.resumePhysicsFromState(
      snapshot ?? null,
      this.targetResumeTick >= 0 ? this.targetResumeTick : undefined
    );
  }

  private applyNonPovPolicy(physics?: IntervenePhysicsPolicyPort | null): void {
    if (!physics?.setCarCollisionMask) return;
    const mask = physics.getActiveCarMask?.() ?? 0xff;
    for (let i = 0; i < 8; i++) {
      if ((mask & (1 << i)) === 0) continue;
      if (i === this.targetCarIndex) {
        physics.setCarCollisionMask(i, true, true, 1);
      } else if (this.nonPovPolicy === 'disappear') {
        physics.setCarCollisionMask(i, false, false, 0);
      } else {
        physics.setCarCollisionMask(i, true, true, 1);
      }
    }
  }

  private resolveCountdownStepLabel(): '4' | '3' | '2' | '1' | '0' | 'idle' {
    if (this.phase === 'idle' || this.phase === 'authorized') return 'idle';
    if (this.phase === 'active') return '0';
    const secLeft = Math.ceil(this.countdownRemainingTicks / MATCH_TICK_RATE);
    if (secLeft >= 4) return '4';
    if (secLeft === 3) return '3';
    if (secLeft === 2) return '2';
    if (secLeft === 1) return '1';
    return '0';
  }
}
