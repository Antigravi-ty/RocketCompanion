import { FreeplayMode } from './FreeplayMode.ts';
import { BotMatchMode } from './BotMatchMode.ts';
import { KickoffTrainingMode } from './KickoffTrainingMode.ts';
import { SubsystemIsolationLabMode } from './SubsystemIsolationLabMode.ts';
import { ExperimentalMultiBotsMode } from './ExperimentalMultiBotsMode.ts';
import { StaticTrainingPackMode } from './static-training/StaticTrainingPackMode.ts';
import type { BaseGameMode } from './BaseGameMode.ts';
import type { FrameContext } from '../pipeline/FramePipeline.ts';

/**
 * GameModeManager.ts
 * Strategy dispatcher for active game session rules and lifecycle state.
 */
export class GameModeManager {
  public runtime: any;
  public modes = new Map<string, BaseGameMode>();
  public activeMode: BaseGameMode;

  constructor(runtime: any) {
    this.runtime = runtime;

    const freeplay = new FreeplayMode(runtime);
    const botMatch = new BotMatchMode(runtime);
    const kickoffTraining = new KickoffTrainingMode(runtime);
    const devTestLab = new SubsystemIsolationLabMode(runtime);
    const expMultiBots = new ExperimentalMultiBotsMode(runtime);
    const staticTrainingPack = new StaticTrainingPackMode(runtime);

    this.modes.set('freeplay', freeplay);
    this.modes.set('replay-viewer', freeplay);
    this.modes.set('match', botMatch);
    this.modes.set('kickoff-training', kickoffTraining);
    this.modes.set('dev-test-lab', devTestLab);
    this.modes.set('exp-multi-bots', expMultiBots);
    this.modes.set('static-training-pack', staticTrainingPack);

    this.activeMode = freeplay;
  }

  public registerMode(mode: BaseGameMode): void {
    this.modes.set(mode.id, mode);
  }

  public setMode(modeId: string): void {
    if (this.activeMode && this.activeMode.id === modeId) return;

    const nextMode = this.modes.get(modeId) || this.modes.get('freeplay')!;
    if (this.activeMode === nextMode && nextMode) {
      nextMode.id = modeId === 'replay-viewer' ? 'replay-viewer' : 'freeplay';
      this.runtime?.tunerPort?.reconcileTrainingScopeForMode?.(modeId);
      if (this.runtime?.keyboard) {
        this.runtime.keyboard.ballControlEnabled =
          nextMode.id === 'freeplay' &&
          !nextMode.standaloneReplayViewer?.hasLoadedReplay &&
          !nextMode.nameTagTunerController?.isActive;
      }
      return;
    }

    if (this.activeMode) {
      this.activeMode.onLeave();
    }

    this.activeMode = nextMode;
    if (this.activeMode && (modeId === 'freeplay' || modeId === 'replay-viewer')) {
      this.activeMode.id = modeId;
    }
    this.runtime?.tunerPort?.reconcileTrainingScopeForMode?.(modeId);
    this.activeMode.onEnter();
  }

  public getActiveMode(): BaseGameMode {
    const desiredId = this.runtime.match?.state?.mode || 'freeplay';
    if (this.activeMode?.id !== desiredId && this.modes.has(desiredId)) {
      this.setMode(desiredId);
    }
    return this.activeMode;
  }

  public update(context: FrameContext | any): void {
    const mode = this.getActiveMode();
    mode?.update(context);
  }

  public onResetKickoff(seed = -1): void {
    const mode = this.getActiveMode();
    mode?.onResetKickoff(seed);
  }
}
