import { audioConfig } from '../ui-core/config/audioConfig.js';
import { getAudioSlotPool, subsystemState } from './audioContext.js';

export class UIAudioEngine {
  playClick(volume = 1.0) {
    const pool = getAudioSlotPool();
    const buf = subsystemState.buffers.get("sfx_error_no_boost");
    if (!pool || !buf) return;
    const master = audioConfig.get('masterVolume') ?? 1.0;
    const uiClickVol = audioConfig.get('uiClickVolume') ?? 1.0;
    pool.playBuffer(buf, {
      volume: Math.max(0, Math.min(5.0, volume * uiClickVol * master * 0.3)),
      playbackRate: 2.0,
      priority: 1
    });
  }
}
