import { FreeplayMode } from './FreeplayMode.js';
import { BotMatchMode } from './BotMatchMode.js';
import { KickoffTrainingMode } from './KickoffTrainingMode.js';
import { SubsystemIsolationLabMode } from './SubsystemIsolationLabMode.js';
import { ExperimentalMultiBotsMode } from './ExperimentalMultiBotsMode.js';
import { StaticTrainingPackMode } from './StaticTrainingPackMode.js';

/**
 * GameModeManager.js
 * Strategy dispatcher for active game session rules and lifecycle state.
 */
export class GameModeManager {
  /**
   * @param {object} runtime
   */
  constructor(runtime) {
    this.runtime = runtime;
    this.modes = new Map();

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

  registerMode(mode) {
    this.modes.set(mode.id, mode);
  }

  setMode(modeId) {
    if (this.activeMode && this.activeMode.id === modeId) return;

    const nextMode = this.modes.get(modeId) || this.modes.get('freeplay');
    if (this.activeMode === nextMode && nextMode) {
      nextMode.id = modeId === 'replay-viewer' ? 'replay-viewer' : 'freeplay';
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
    this.activeMode.onEnter();
  }

  getActiveMode() {
    const desiredId = this.runtime.match?.state?.mode || 'freeplay';
    if (this.activeMode?.id !== desiredId && this.modes.has(desiredId)) {
      this.setMode(desiredId);
    }
    return this.activeMode;
  }

  update(context) {
    const mode = this.getActiveMode();
    mode?.update(context);
  }

  onResetKickoff(seed = -1) {
    const mode = this.getActiveMode();
    mode?.onResetKickoff(seed);
  }
}
