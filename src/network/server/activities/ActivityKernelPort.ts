/**
 * src/network/server/activities/ActivityKernelPort.ts
 * Narrow interface and context port for hot-swappable room activity kernels
 * (Freeplay, Match, Replay & Intervene, and Developer Sandbox).
 */

import type {
  RoomActivityId,
  RoomActivitySwitchPayload,
} from '../../protocol/RoomActivityProtocol.ts';
import type { MatchSessionAdmin } from '../match/MatchSessionAdmin.ts';
import type { PhysicsEngineManager } from '../PhysicsEngineManager.ts';

export interface ActivityKernelContext {
  readonly matchManager: MatchSessionAdmin | null | undefined;
  readonly physicsManager: PhysicsEngineManager | null | undefined;
  readonly syncRoomState: () => void;
}

export interface ActivityKernelPort {
  readonly activityId: RoomActivityId;
  readonly modeFlags: number;
  onEnter(ctx: ActivityKernelContext, payload: RoomActivitySwitchPayload): void;
  onExit(ctx: ActivityKernelContext): void;
  onStepTick(ctx: ActivityKernelContext): void;
  getCustomSummary(): Record<string, unknown> | null;
}
