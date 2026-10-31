import { audioConfig } from '../../../ui-core/config/audioConfig.js';

/**
 * AudioStage.js
 * Evaluates focus policies and executes the GameAudioSubsystem tick.
 */
export class AudioStage {
  constructor(runtime) {
    this.runtime = runtime;
  }

  execute(context) {
    const r = this.runtime;

    const continueOnBlur = audioConfig.get('continueAudioOnLostFocus');
    const isHidden = typeof document !== 'undefined' && (!document.hasFocus() || document.hidden);
    let hasBlockingOverlay = false;
    if (r.openOverlays && r.openOverlays.size > 0) {
      for (const n of r.openOverlays) {
        if (n !== 'trajectory') {
          hasBlockingOverlay = true;
          break;
        }
      }
    }

    context.continueOnBlur = continueOnBlur;
    context.isHidden = isHidden;
    context.hasBlockingOverlay = hasBlockingOverlay;

    r.audioSubsystem?.update?.(context);

    if (r.profiler) r.profiler.mark();
  }
}
