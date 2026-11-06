import type { FrameContext } from '../pipeline/FramePipeline.ts';
import type { ReplayTimelineController } from '../../replay/ReplayTimelineController.ts';
import type { ReplayRingBuffer } from '../../replay/ReplayRingBuffer.ts';
import type { StandaloneReplayViewerController } from '../../replay/StandaloneReplayViewerController.ts';
import type { FreeplayRewinderController } from '../../replay/FreeplayRewinderController.ts';
import type { NameTagTunerArenaController } from './NameTagTunerArenaController.ts';
import type { PodiumCelebrationController } from './PodiumCelebrationController.ts';
import type { ExperimentalMultiBotsRosterController } from './experimental-multi-bots/ExperimentalMultiBotsRosterController.ts';
import type { ExperimentalMultiBotsMatchLifecycleController } from './experimental-multi-bots/ExperimentalMultiBotsMatchLifecycleController.ts';
import type { DirectorPreviewSubController } from './freeplay/DirectorPreviewSubController.ts';
import type { FreeplayGoalAndTouchSubController } from './freeplay/FreeplayGoalAndTouchSubController.ts';

export interface ModeReplaySessionPort {
  isReplayActive: boolean;
  replayCameraMode: 'director' | 'pov';
  replayPovCarIndex?: number;
  replayController: ReplayTimelineController;
  replayRingBuffer: ReplayRingBuffer;
}

export interface BaseGameMode {
  goalReplayPhase?: string;
  replayController?: ReplayTimelineController;
  replayRingBuffer?: ReplayRingBuffer;
  goalReplayTimelineController?: ReplayTimelineController | null;
  standaloneReplayViewer?: StandaloneReplayViewerController;
  rewinderController?: FreeplayRewinderController;
  nameTagTunerController?: NameTagTunerArenaController;
  podiumController?: PodiumCelebrationController | null;
  rosterController?: ExperimentalMultiBotsRosterController;
  replaySession?: ModeReplaySessionPort;
  lifecycleController?: ExperimentalMultiBotsMatchLifecycleController;
  directorPreview?: DirectorPreviewSubController;
  goalAndTouch?: FreeplayGoalAndTouchSubController;
  isTestingSingleShot?: boolean;
  isFreeCamTrajectoryTesting?: boolean;
  isGoalReplayActive?(): boolean;
  setReplayCameraMode?(_val: string): void;
  onBeforePhysicsTick?(): boolean;
  onStepPhysicsTick?(): boolean;
  onAfterPhysicsTick?(): void;
  onPhysicsEvent?(_event: any): void;
  skipGoalReplay?(): void;
  applyRosterAndStartMatch?(): Promise<void> | void;
  _applyCameraCarIndex?(_carIdx?: number): void;
  _publishSpawnedCarsTelemetry?(): void;
  getCarControls?(_carIndex: number): any;
  resetToCleanFreeplay?(): void;
  importDirectorDiagnosticPattern?(
    _fileOrInput: unknown,
    _options?: Record<string, unknown>
  ): Promise<boolean>;
  startDirectorPatternPreview?(
    _parsedPattern?: Record<string, any> | null,
    _options?: Record<string, any>
  ): boolean;
  enterDirectorReferenceFreeCamFromHere?(_options?: Record<string, any>): boolean;
  exitDirectorReferenceFreeCam?(): boolean;
  exitDirectorPatternPreview?(): boolean;
  exportRecentHighlightReplay?(
    _durationSeconds?: number,
    _suppressNotification?: boolean
  ): any;
  syncExternalGhostWorld?(
    _worldId: string,
    _prevState: Float32Array | number[],
    _currState: Float32Array | number[],
    _options?: Record<string, any>
  ): void;
}

export class BaseGameMode {
  public id: string;
  public runtime: any;

  constructor(id: string, runtime: any) {
    this.id = id;
    this.runtime = runtime;
  }

  public onEnter(): void {}

  public update(_context: FrameContext | any): void {}

  public onGoal(..._args: any[]): void {}

  public onResetKickoff(_seed = -1): void {}

  public onLeave(): void {}
}
