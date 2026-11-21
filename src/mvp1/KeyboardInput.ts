export interface Mvp1ControlsState {
  throttle: number;
  steer: number;
  pitch: number;
  yaw: number;
  roll: number;
  jump: boolean;
  boost: boolean;
  handbrake: boolean;
  ballCam: boolean;
}

export class KeyboardInputReader {
  private readonly pressed = new Set<string>();
  public ballCam = true;
  private onResetKickoff: (() => void) | null = null;
  private onToggleClient30Fps: (() => void) | null = null;

  constructor(callbacks?: {
    onResetKickoff?: () => void;
    onToggleClient30Fps?: () => void;
  }) {
    this.onResetKickoff = callbacks?.onResetKickoff ?? null;
    this.onToggleClient30Fps = callbacks?.onToggleClient30Fps ?? null;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.pressed.add(e.code);
    if (e.code === 'KeyC') {
      this.ballCam = !this.ballCam;
    } else if (e.code === 'KeyR') {
      this.onResetKickoff?.();
    } else if (e.code === 'KeyF') {
      this.onToggleClient30Fps?.();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.code);
  };

  private handleBlur = (): void => {
    this.pressed.clear();
  };

  public sample(): Mvp1ControlsState {
    const has = (code: string) => this.pressed.has(code);

    const forward = (has('KeyW') || has('ArrowUp') ? 1 : 0) - (has('KeyS') || has('ArrowDown') ? 1 : 0);
    const turn = (has('KeyD') || has('ArrowRight') ? 1 : 0) - (has('KeyA') || has('ArrowLeft') ? 1 : 0);
    const roll = (has('KeyE') ? 1 : 0) - (has('KeyQ') ? 1 : 0);

    return {
      throttle: forward,
      steer: turn,
      pitch: forward,
      yaw: turn,
      roll,
      jump: has('Space') || has('Slash'),
      boost: has('ShiftLeft') || has('Period'),
      handbrake: has('ShiftRight') || has('KeyX'),
      ballCam: this.ballCam,
    };
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
  }
}
