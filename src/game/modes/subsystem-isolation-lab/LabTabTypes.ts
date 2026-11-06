export type IsolationLabTabId =
  | 'probes'
  | 'multi-ghost'
  | 'state-replay'
  | '90s-match'
  | 'goal-replay'
  | 'kickoff-duel'
  | 'demolish-respawn';

export interface LabFrameUpdateContext {
  dt: number;
  alpha: number;
  activeCar?: number;
  playerCarView?: {
    boost: number;
    isBoosting: boolean;
    [key: string]: any;
  } | null;
  [key: string]: any;
}

export interface LabTabContext {
  readonly runtime: any;
  getSwitchEpoch(): number;
  ensureSinglePlayerCarOnly(resetKickoffState?: boolean): void;
  enterPodiumShowcase(winningTeam?: number): void;
  exitPodiumShowcase(): void;
  isPodiumActive(): boolean;
}

export interface LabTabController {
  readonly tabId: IsolationLabTabId;
  onActivate(ctx: LabTabContext): void;
  onDeactivate(): void;
  /**
   * Advances tab-specific simulation logic on a physics tick.
   * Returns false if the main physics engine step should be suppressed for this tick.
   */
  onPhysicsTick(dt: number): boolean | void;
  onAfterPhysicsTick?(): void;
  onRenderFrame?(frameCtx: LabFrameUpdateContext): void;
}
