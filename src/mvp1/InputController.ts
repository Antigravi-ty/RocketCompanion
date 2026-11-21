import type { CarControlInput } from './protocol.ts';

export interface InputCallbacks {
  onControlsChange: (input: CarControlInput) => void;
  onResetKickoff: () => void;
  onExportTelemetry: () => void;
}

export class InputController {
  private readonly pressed = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private ballCam = true;
  private readonly callbacks: InputCallbacks;
  private readonly boundKeyDown: (e: KeyboardEvent) => void;
  private readonly boundKeyUp: (e: KeyboardEvent) => void;
  private readonly boundMouseDown: (e: MouseEvent) => void;
  private readonly boundMouseUp: (e: MouseEvent) => void;
  private readonly boundContextMenu: (e: MouseEvent) => void;
  private readonly boundBlur: () => void;

  constructor(callbacks: InputCallbacks) {
    this.callbacks = callbacks;
    this.boundKeyDown = (e) => this.handleKeyDown(e);
    this.boundKeyUp = (e) => this.handleKeyUp(e);
    this.boundMouseDown = (e) => this.handleMouseDown(e);
    this.boundMouseUp = (e) => this.handleMouseUp(e);
    this.boundContextMenu = (e) => this.handleContextMenu(e);
    this.boundBlur = () => this.handleBlur();
  }

  attach(): void {
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('mousedown', this.boundMouseDown);
    window.addEventListener('mouseup', this.boundMouseUp);
    window.addEventListener('contextmenu', this.boundContextMenu);
    window.addEventListener('blur', this.boundBlur);
    this.emitControls();
  }

  detach(): void {
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    window.removeEventListener('mousedown', this.boundMouseDown);
    window.removeEventListener('mouseup', this.boundMouseUp);
    window.removeEventListener('contextmenu', this.boundContextMenu);
    window.removeEventListener('blur', this.boundBlur);
  }

  toggleBallCam(): void {
    this.ballCam = !this.ballCam;
    this.emitControls();
  }

  getSnapshot(): CarControlInput {
    const w = this.pressed.has('KeyW') ? 1 : 0;
    const s = this.pressed.has('KeyS') ? 1 : 0;
    const a = this.pressed.has('KeyA') ? 1 : 0;
    const d = this.pressed.has('KeyD') ? 1 : 0;
    const q = this.pressed.has('KeyQ') ? 1 : 0;
    const e = this.pressed.has('KeyE') ? 1 : 0;

    return {
      throttle: w - s,
      steer: d - a,
      pitch: s - w,
      yaw: d - a,
      roll: e - q,
      jump: this.pressed.has('ArrowRight') || this.pressed.has('Slash') || this.mouseButtons.has(2),
      boost:
        this.pressed.has('ArrowLeft') || this.pressed.has('Period') || this.mouseButtons.has(0),
      handbrake: this.pressed.has('ShiftLeft'),
      ballCam: this.ballCam,
    };
  }

  private emitControls(): void {
    this.callbacks.onControlsChange(this.getSnapshot());
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const code = event.code;
    if (
      code === 'Space' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Slash' ||
      code === 'Period' ||
      code === 'F10'
    ) {
      event.preventDefault();
    }

    if (event.repeat) return;

    if (code === 'Space') {
      this.ballCam = !this.ballCam;
      this.emitControls();
      return;
    }

    if (code === 'KeyR') {
      this.callbacks.onResetKickoff();
      return;
    }

    if (code === 'KeyT' || code === 'F10') {
      this.callbacks.onExportTelemetry();
      return;
    }

    this.pressed.add(code);
    this.emitControls();
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (this.pressed.delete(event.code)) {
      this.emitControls();
    }
  }

  private handleMouseDown(event: MouseEvent): void {
    if (event.button !== 0 && event.button !== 2) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest('button, a, input, select, textarea')) return;
    if (!this.mouseButtons.has(event.button)) {
      this.mouseButtons.add(event.button);
      this.emitControls();
    }
  }

  private handleMouseUp(event: MouseEvent): void {
    if (this.mouseButtons.delete(event.button)) {
      this.emitControls();
    }
  }

  private handleContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && target.tagName === 'CANVAS') {
      event.preventDefault();
    }
  }

  private handleBlur(): void {
    if (this.pressed.size > 0 || this.mouseButtons.size > 0) {
      this.pressed.clear();
      this.mouseButtons.clear();
      this.emitControls();
    }
  }
}
