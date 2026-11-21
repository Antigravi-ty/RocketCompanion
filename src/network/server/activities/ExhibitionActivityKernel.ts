import {
  ACTIVITY_IDS,
  REPLICATION_MODES,
  resolvePacketFlagsForActivity,
} from '../../protocol/ReplicationBusProtocol.ts';
import type { MatchSessionAdmin } from '../match/MatchSessionAdmin.ts';

export interface ExhibitionKernelContext {
  matchManager: MatchSessionAdmin | null | undefined;
  stateSummary?: Record<string, unknown> | null;
}

export class ExhibitionActivityKernel {
  readonly id = ACTIVITY_IDS.EXHIBITION;
  readonly defaultReplicationMode = REPLICATION_MODES.CONTINUOUS;
  readonly defaultPacketFlags = resolvePacketFlagsForActivity(
    ACTIVITY_IDS.EXHIBITION,
    REPLICATION_MODES.CONTINUOUS,
    true
  );

  onMount(ctx: ExhibitionKernelContext): void {
    if (ctx.matchManager?.systemControl?.isStateOnlyMode) {
      ctx.matchManager.systemControl.clear();
      ctx.matchManager.domain.applySystemControlState('resume', ctx.matchManager.domain.matchTick);
    }
    const duration =
      typeof ctx.stateSummary?.durationSeconds === 'number'
        ? ctx.stateSummary.durationSeconds
        : undefined;
    ctx.matchManager?.lifecycle.startMatch(duration);
  }

  onUnmount(_ctx: ExhibitionKernelContext): void {}

  getStateSummary(ctx: ExhibitionKernelContext): Record<string, unknown> {
    const snap = ctx.matchManager?.getSnapshot();
    return {
      activityId: this.id,
      isExhibition: true,
      state: snap?.state ?? 'KICKOFF',
      blueScore: snap?.blueScore ?? 0,
      orangeScore: snap?.orangeScore ?? 0,
      clockSecondsRemaining: snap?.clockSecondsRemaining ?? 0,
    };
  }
}
