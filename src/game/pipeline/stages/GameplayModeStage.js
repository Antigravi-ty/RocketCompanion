import { useAppStore } from '../../../ui-core/stores/appStore';

/**
 * GameplayModeStage.js
 * Delegates rule logic to the active GameMode strategy and synchronizes UI match status.
 */
export class GameplayModeStage {
  constructor(runtime) {
    this.runtime = runtime;
  }

  execute(context) {
    const r = this.runtime;

    // 1. Cache dynamics for mode manager & downstream presentation/audio
    const playerCarView = r.interpolator?.getCurrCarStateView(r.playerCarIndex);
    context.playerCarView = playerCarView;
    context.isSupersonic = Boolean(playerCarView?.isSupersonic && !playerCarView?.isDemoed);
    context.curBoost = playerCarView?.boost ?? 0;

    // 2. Delegate rules to mode manager
    r.modeManager?.update?.(context);

    // 3. Container dataset & UI Mode sync
    if (r.container && r.container.dataset.gameMode !== r.match.state.mode) {
      r.container.dataset.gameMode = r.match.state.mode;
      if (useAppStore && typeof useAppStore.getState === 'function') {
        useAppStore.getState().setMatchMode(r.match.state.mode);
      }
    }

    if (r.profiler) r.profiler.mark();
  }
}
