import { useAppStore } from '../runtimeUiPort.ts';
import { getEffectiveGamepad } from '../../ui-core/config/inputBindings.ts';
import { NEUTRAL_CAR_CONTROLS } from '../../network/client/PredictionHistoryBuffer.ts';
import type { CarControlsInput } from '../../network/protocol/GlobalPayloadCodec.ts';
import type { GamepadController } from '../../input/GamepadController.ts';
import type { KeyboardMouseController } from '../../input/KeyboardMouseController.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';
import {
  TouchInputAgentController,
  type ActiveCarTeamSlot,
  type ActiveModeCarListPort,
  type TouchAgentWorldContext,
} from './TouchInputAgentController.ts';

export type { ActiveCarTeamSlot, ActiveModeCarListPort };

export interface RuntimeInputPollerHostPort extends TouchAgentWorldContext {
  readonly networkReconciler?: PredictionReconciler | null;
  readonly networkManager?: {
    readonly sessionCoordinator?: {
      readonly networkReconciler: PredictionReconciler | null;
    };
    readonly rosterSyncCoordinator?: {
      readonly participantTeams?: ReadonlyMap<number, number>;
    };
  } | null;
  readonly gamepad: GamepadController | null;
  readonly keyboard: KeyboardMouseController | null;
  readonly camera: CameraManager | null;
  readonly match: RuntimeMatchState | null;
  readonly cameraSubsystem?: { cameraDynamics: { lookX: number; lookY: number } | null } | null;
  readonly botCoordinator?: {
    readonly isBotMatch?: boolean;
    stepAuthoritativeBotControls(isKickoff: boolean): void;
  } | null;
  playerThrottle: number;
  playerControls: CarControlsInput;
}

/**
 * RuntimeInputPoller
 * Stateful SubController owning gamepad button debounce state, jump suppression latch,
 * and delegating touch AI agent control synthesis to TouchInputAgentController.
 */
export class RuntimeInputPoller {
  private readonly context: RuntimeInputPollerHostPort;
  public readonly touchAgentController = new TouchInputAgentController();
  public lastGamepadId: string | null = null;
  public lastGamepadButton8 = false;
  public gamepadSettingsJustClosed = false;
  private _suppressJumpUntilReleased = false;

  constructor(context: RuntimeInputPollerHostPort) {
    this.context = context;
  }

  public latchJumpSuppression(): void {
    const ctx = this.context;
    const kbJump = Boolean(ctx.keyboard?.read?.()?.jump);
    const padJump = Boolean(ctx.gamepad?.read?.()?.jump);
    if (kbJump || padJump || Boolean(ctx.playerControls?.jump)) {
      this._suppressJumpUntilReleased = true;
    }
  }

  public pollInputs(commitPhysicsStep = true): boolean {
    const ctx = this.context;
    const { gamepad, keyboard, physics } = ctx;
    if (!gamepad || !keyboard || !physics) return false;
    const pad = getEffectiveGamepad();
    const btn8 = pad?.buttons[8]?.pressed ?? false;
    const padId = pad ? JSON.stringify([pad.id, pad.index]) : null;

    if (padId !== this.lastGamepadId) {
      this.lastGamepadButton8 = btn8;
    }
    this.lastGamepadId = padId;

    const appState = useAppStore ? useAppStore.getState() : null;
    const isMenuOpen = Boolean(appState?.isOpen);
    const shouldToggleMatch = btn8 && !this.lastGamepadButton8 && !isMenuOpen;
    if (shouldToggleMatch) {
      appState?.openMenu?.('play');
    }
    this.lastGamepadButton8 = btn8;

    if (shouldToggleMatch) gamepad.capturing = true;
    let padReading = gamepad.read();
    if (shouldToggleMatch) gamepad.capturing = false;

    if (this.gamepadSettingsJustClosed) {
      this.gamepadSettingsJustClosed = [0, 1, 8, 9].some((i) => pad?.buttons[i]?.pressed);
      if (this.gamepadSettingsJustClosed) padReading = NEUTRAL_CAR_CONTROLS;
    }

    const kbReading = keyboard.read();
    const activeDevice = gamepad.active() ? 'gamepad' : 'keyboard';
    const rawControls = activeDevice === 'gamepad' ? padReading : kbReading;
    const isFreeCamActive = Boolean(ctx.camera?.isFreeCam);
    const phase = ctx.match?.state?.phase;
    const isKickoff = phase === 'kickoff' || phase === 'prepare';
    const currentTick = Math.floor(physics.getHeaderView?.()?.tickCount ?? 0);
    const isKickoffMasked = (ctx.networkReconciler?.kickoffMaskUntilTick ?? -1) > currentTick;
    const isReplayOrFrozenPhase =
      isFreeCamActive ||
      isKickoff ||
      isKickoffMasked ||
      phase === 'replay' ||
      phase === 'podium' ||
      phase === 'ended' ||
      Boolean(ctx.match?.state?.paused) ||
      Boolean(ctx.networkReconciler?.replayPlaybackMode);

    if (!rawControls.jump) {
      this._suppressJumpUntilReleased = false;
    } else if (isReplayOrFrozenPhase) {
      this._suppressJumpUntilReleased = true;
    }

    const touchMode = Boolean(appState?.touchMode);
    const touchInputAgent = appState?.touchInputAgent || 'none';

    let effectiveControls: CarControlsInput;
    if (isFreeCamActive || isKickoff || isKickoffMasked) {
      if (
        (isKickoff || isKickoffMasked) &&
        (touchInputAgent === 'necto' || touchInputAgent === 'nexto')
      ) {
        this.touchAgentController.resolveControls(touchInputAgent, true, ctx);
      }
      effectiveControls = NEUTRAL_CAR_CONTROLS;
    } else if (touchInputAgent === 'necto' || touchInputAgent === 'nexto') {
      effectiveControls = commitPhysicsStep
        ? this.touchAgentController.resolveControls(touchInputAgent, false, ctx)
        : this.touchAgentController.getCachedActionOrNeutral();
    } else if (touchMode && touchInputAgent === 'none') {
      effectiveControls = NEUTRAL_CAR_CONTROLS;
    } else if (this._suppressJumpUntilReleased && rawControls.jump) {
      effectiveControls = { ...rawControls, jump: false };
    } else {
      effectiveControls = rawControls;
    }

    const hasFocus = typeof document !== 'undefined' && !document.hidden && document.hasFocus();

    const camDynamics = ctx.cameraSubsystem?.cameraDynamics;
    if (camDynamics) {
      camDynamics.lookX = hasFocus
        ? Math.min(
            Math.max(
              keyboard.cameraLook.x + (this.gamepadSettingsJustClosed ? 0 : gamepad.cameraLook.x),
              -1
            ),
            1
          )
        : 0;
      camDynamics.lookY = hasFocus
        ? Math.min(
            Math.max(
              keyboard.cameraLook.y + (this.gamepadSettingsJustClosed ? 0 : gamepad.cameraLook.y),
              -1
            ),
            1
          )
        : 0;
    }

    if (!commitPhysicsStep) {
      return true;
    }

    const reconciler = ctx.networkManager?.sessionCoordinator?.networkReconciler ?? null;
    if (reconciler?.shouldSkipLocalStep) {
      reconciler.shouldSkipLocalStep = false;
      return false;
    }

    const normalizedEffective = {
      throttle: effectiveControls.throttle ?? 0,
      steer: effectiveControls.steer ?? 0,
      pitch: effectiveControls.pitch ?? 0,
      yaw: effectiveControls.yaw ?? 0,
      roll: effectiveControls.roll ?? 0,
      jump: Boolean(effectiveControls.jump),
      boost: Boolean(effectiveControls.boost),
      handbrake: Boolean(effectiveControls.handbrake),
    };
    let car0Controls: CarControlsInput = normalizedEffective;
    if (reconciler) {
      car0Controls =
        (reconciler.sampleAndPredictInput(
          ctx.playerCarIndex,
          normalizedEffective
        ) as CarControlsInput | null) || normalizedEffective;
    }

    ctx.playerThrottle = car0Controls.throttle ?? 0;
    ctx.playerControls = car0Controls;
    physics.setControls(ctx.playerCarIndex, car0Controls);

    if (ctx.botCoordinator) {
      ctx.botCoordinator.stepAuthoritativeBotControls(isKickoff);
    }

    if (reconciler?.historyBuffer.lastRemoteControls) {
      const numCars = Math.min(physics.numCars, 8);
      for (let c = 0; c < numCars; c++) {
        if (c !== ctx.playerCarIndex) {
          const remote = reconciler.historyBuffer.lastRemoteControls.get(c) as
            ({ controls?: CarControlsInput } & CarControlsInput) | undefined;
          const remoteCtrl = remote?.controls ? remote.controls : remote || NEUTRAL_CAR_CONTROLS;
          physics.setControls(c, remoteCtrl);
        }
      }
    }
    return true;
  }
}
