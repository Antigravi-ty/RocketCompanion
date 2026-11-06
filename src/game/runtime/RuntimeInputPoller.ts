import { useAppStore } from '../runtimeUiPort.ts';
import { getEffectiveGamepad } from '../../ui-core/config/inputBindings.ts';
import {
  ExperimentalBotAgent,
  ensureExperimentalEngine,
} from '../../ai/experimental/ExperimentalBotAgent.ts';
import { NEUTRAL_CAR_CONTROLS } from '../../network/client/PredictionHistoryBuffer.ts';
import type { RocketSimPhysicsEngine } from '../../physics/RocketSimPhysicsEngine.ts';
import type { CarControlsInput } from '../../network/protocol/GlobalPayloadCodec.ts';
import type { GamepadController } from '../../input/GamepadController.ts';
import type { KeyboardMouseController } from '../../input/KeyboardMouseController.ts';
import type { CameraManager } from '../../camera/CameraManager.ts';
import type { RuntimeMatchState } from './RuntimeMatchState.ts';
import type { PredictionReconciler } from '../../network/client/PredictionReconciler.ts';

export interface ActiveCarTeamSlot {
  carIndex: number;
  team: number;
}

export interface ActiveModeCarListPort {
  id?: string;
  activeCarsList?: ActiveCarTeamSlot[];
  rosterController?: {
    activeCarsList?: ActiveCarTeamSlot[];
  } | null;
}

export interface RuntimeInputPollerHostPort {
  readonly modeManager: { getActiveMode(): ActiveModeCarListPort | null } | null;
  readonly physics: RocketSimPhysicsEngine | null;
  readonly arena?: { readonly carTeams?: ArrayLike<number> } | null;
  readonly networkManager?: {
    readonly sessionCoordinator?: {
      readonly networkReconciler: PredictionReconciler | null;
    };
    readonly rosterSyncCoordinator?: {
      readonly participantTeams?: ReadonlyMap<number, number>;
    };
  } | null;
  readonly teamAssignment?: { playerTeam: number; opponentTeam: number } | null;
  readonly playerCarIndex: number;
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

function normalizeTeamBit(rawTeam: unknown): 0 | 1 | null {
  if (rawTeam === 1 || rawTeam === 'orange') return 1;
  if (rawTeam === 0 || rawTeam === 'blue') return 0;
  return null;
}

function resolveFallbackCarTeam(
  pollerHost: RuntimeInputPollerHostPort,
  cIdx: number,
  localCarIndex: number,
  onlineLocalTeam: 0 | 1 | null,
): 0 | 1 {
  const fromParticipantMap = normalizeTeamBit(
    pollerHost.networkManager?.rosterSyncCoordinator?.participantTeams?.get(cIdx),
  );
  if (fromParticipantMap !== null) return fromParticipantMap;

  if (cIdx === localCarIndex && onlineLocalTeam !== null) {
    return onlineLocalTeam;
  }

  const fromPhysicsSpec = normalizeTeamBit(pollerHost.physics?._carSpecs?.[cIdx]?.team);
  if (fromPhysicsSpec !== null) return fromPhysicsSpec;

  const fromArena = normalizeTeamBit(pollerHost.arena?.carTeams?.[cIdx]);
  if (fromArena !== null) return fromArena;

  if (pollerHost.teamAssignment) {
    if (cIdx === localCarIndex) {
      const pt = normalizeTeamBit(pollerHost.teamAssignment.playerTeam);
      if (pt !== null) return pt;
    } else if (cIdx === 1 && pollerHost.botCoordinator?.isBotMatch) {
      const ot = normalizeTeamBit(pollerHost.teamAssignment.opponentTeam);
      if (ot !== null) return ot;
    }
  }

  return cIdx % 2 === 1 ? 1 : 0;
}

function resolveTouchActiveCarsAndTeam(
  pollerHost: RuntimeInputPollerHostPort,
  carIndex: number,
): { team: number; activeCars: ActiveCarTeamSlot[] | null } {
  const activeCarsList = pollerHost.modeManager?.getActiveMode?.()?.rosterController?.activeCarsList;
  if (activeCarsList && activeCarsList.length > 0) {
    const found = activeCarsList.find((c) => c.carIndex === carIndex);
    const team = found ? (found.team === 1 ? 1 : 0) : carIndex % 2;
    return { team, activeCars: activeCarsList };
  }

  const appState = useAppStore ? useAppStore.getState() : null;
  const onlineSession = appState?.onlineSession;
  const onlineLocalTeam = normalizeTeamBit(onlineSession?.localTeam);
  const peers = onlineSession?.connectedPeers ?? appState?.connectedPeers;
  const participantTeams = pollerHost.networkManager?.rosterSyncCoordinator?.participantTeams;

  const byCar = new Map<number, 0 | 1>();

  if (participantTeams instanceof Map && participantTeams.size > 0) {
    for (const [cIdx, rawTeam] of participantTeams.entries()) {
      if (typeof cIdx !== 'number' || cIdx < 0 || cIdx >= 6) continue;
      const norm = normalizeTeamBit(rawTeam);
      if (norm !== null) {
        byCar.set(cIdx, norm);
      }
    }
  }

  if (Array.isArray(peers) && peers.length > 0) {
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i] as Record<string, unknown> | null | undefined;
      if (!p || p.isSpectator || p.role === 'spectator' || p.team === 'spectator' || p.team === 2) {
        continue;
      }
      const cIdx =
        typeof p.entityId === 'number'
          ? p.entityId
          : typeof p.carIndex === 'number'
            ? p.carIndex
            : -1;
      if (cIdx < 0 || cIdx >= 6) continue;
      const peerTeam =
        normalizeTeamBit(p.team) ??
        resolveFallbackCarTeam(pollerHost, cIdx, carIndex, onlineLocalTeam);
      byCar.set(cIdx, peerTeam);
    }
  }

  const resolvedSelfTeam =
    byCar.get(carIndex) ?? resolveFallbackCarTeam(pollerHost, carIndex, carIndex, onlineLocalTeam);

  if (byCar.size > 0) {
    byCar.set(carIndex, resolvedSelfTeam);
    const activeCars: ActiveCarTeamSlot[] = Array.from(byCar.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([cIdx, t]) => ({ carIndex: cIdx, team: t }));
    return { team: resolvedSelfTeam, activeCars };
  }

  const physics = pollerHost.physics;
  if (physics) {
    const activeCars: ActiveCarTeamSlot[] = [];
    const maxCars = Math.min(6, Math.max(physics.numCars || 0, physics._carSpecs?.length || 0));
    for (let c = 0; c < maxCars; c++) {
      const isActive =
        typeof physics.isCarSlotActive === 'function'
          ? physics.isCarSlotActive(c)
          : Boolean(physics._carSpecs?.[c]);
      if (!isActive && c !== carIndex) continue;
      const t =
        c === carIndex
          ? resolvedSelfTeam
          : resolveFallbackCarTeam(pollerHost, c, carIndex, onlineLocalTeam);
      activeCars.push({ carIndex: c, team: t });
    }
    if (activeCars.length > 0) {
      return { team: resolvedSelfTeam, activeCars };
    }
  }

  return { team: resolvedSelfTeam, activeCars: null };
}

function isClosestTeamCarToKickoff(
  pollerHost: RuntimeInputPollerHostPort,
  carIndex: number,
  team: number,
  activeCars: ActiveCarTeamSlot[] | null,
): boolean {
  if (!Array.isArray(activeCars) || activeCars.length <= 2) return true;
  const myView = pollerHost.physics?.getCarStateView?.(carIndex);
  if (!myView) return true;
  const myDist = Math.hypot(myView.posX, myView.posY);
  for (let i = 0; i < activeCars.length; i++) {
    const entry = activeCars[i];
    if (entry.carIndex === carIndex || entry.team !== team) continue;
    const otherView = pollerHost.physics?.getCarStateView?.(entry.carIndex);
    if (!otherView || otherView.isDemoed) continue;
    const d = Math.hypot(otherView.posX, otherView.posY);
    if (d < myDist - 10 || (Math.abs(d - myDist) <= 10 && entry.carIndex < carIndex)) {
      return false;
    }
  }
  return true;
}

/**
 * RuntimeInputPoller
 * Stateful SubController owning gamepad button debounce state and touch AI agent state,
 * polling keyboard/gamepad/touch-agent inputs through a narrow RuntimeInputPollerHostPort.
 */
export class RuntimeInputPoller {
  private readonly host: RuntimeInputPollerHostPort;
  public lastGamepadId: string | null = null;
  public lastGamepadButton8 = false;
  public gamepadSettingsJustClosed = false;
  private _touchInputAgentInstance: ExperimentalBotAgent | null = null;
  private _touchAgentKickoffStep = 0;

  constructor(host: RuntimeInputPollerHostPort) {
    this.host = host;
  }

  private _resolveTouchAgentControls(
    agentType: string,
    isKickoff: boolean,
  ): CarControlsInput {
    const host = this.host;
    const carIndex = host.playerCarIndex ?? 0;
    const { team, activeCars } = resolveTouchActiveCarsAndTeam(host, carIndex);

    if (!this._touchInputAgentInstance) {
      this._touchInputAgentInstance = new ExperimentalBotAgent(agentType, carIndex, team);
      ensureExperimentalEngine(agentType);
    } else {
      this._touchInputAgentInstance.carIndex = carIndex;
      this._touchInputAgentInstance.team = team;
      if (this._touchInputAgentInstance.botType !== agentType) {
        this._touchInputAgentInstance.setBotType(agentType);
      }
    }

    const agent = this._touchInputAgentInstance;
    if (isKickoff) {
      this._touchAgentKickoffStep = 0;
      agent.reset();
      return NEUTRAL_CAR_CONTROLS;
    }

    const simState = host.physics?.state;
    if (!simState) {
      return NEUTRAL_CAR_CONTROLS;
    }

    const kickoffStep = this._touchAgentKickoffStep || 0;
    const isPrimaryKickoff = isClosestTeamCarToKickoff(host, carIndex, team, activeCars);
    const ko = agent.getKickoffControls(simState, kickoffStep, isPrimaryKickoff) as
      | CarControlsInput
      | null
      | undefined;
    let ctrl: CarControlsInput | null | undefined;
    if (ko) {
      ctrl = ko;
      agent.overrideControls(ko);
    } else if (agent.tickSkipCounter <= 0) {
      const pads = host.physics?.getPads?.() || [];
      ctrl = agent.decideSync(simState, pads, activeCars || []) as CarControlsInput;
      agent.tickSkipCounter = agent.tickSkip - 1;
    } else {
      agent.tickSkipCounter--;
      ctrl = agent.action as CarControlsInput;
    }
    this._touchAgentKickoffStep = kickoffStep + 1;
    return ctrl || NEUTRAL_CAR_CONTROLS;
  }

  public pollInputs(commitPhysicsStep = true): boolean {
    const host = this.host;
    if (!host.gamepad || !host.keyboard || !host.physics) return false;
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

    if (shouldToggleMatch) host.gamepad.capturing = true;
    let padReading = host.gamepad.read();
    if (shouldToggleMatch) host.gamepad.capturing = false;

    if (this.gamepadSettingsJustClosed) {
      this.gamepadSettingsJustClosed = [0, 1, 8, 9].some((i) => pad?.buttons[i]?.pressed);
      if (this.gamepadSettingsJustClosed) padReading = NEUTRAL_CAR_CONTROLS;
    }

    const kbReading = host.keyboard.read();
    const activeDevice = host.gamepad.active() ? 'gamepad' : 'keyboard';
    const rawControls = activeDevice === 'gamepad' ? padReading : kbReading;
    const isFreeCamActive = Boolean(host.camera?.isFreeCam);
    const isKickoff = host.match?.state?.phase === 'kickoff';

    const touchMode = Boolean(appState?.touchMode);
    const touchInputAgent = appState?.touchInputAgent || 'none';

    let effectiveControls: CarControlsInput;
    if (isFreeCamActive || isKickoff) {
      if (isKickoff && (touchInputAgent === 'necto' || touchInputAgent === 'nexto')) {
        this._resolveTouchAgentControls(touchInputAgent, true);
      }
      effectiveControls = NEUTRAL_CAR_CONTROLS;
    } else if (touchInputAgent === 'necto' || touchInputAgent === 'nexto') {
      effectiveControls = commitPhysicsStep
        ? this._resolveTouchAgentControls(touchInputAgent, false)
        : ((this._touchInputAgentInstance?.action as CarControlsInput | undefined) ||
          NEUTRAL_CAR_CONTROLS);
    } else if (touchMode && touchInputAgent === 'none') {
      effectiveControls = NEUTRAL_CAR_CONTROLS;
    } else {
      effectiveControls = rawControls;
    }

    const hasFocus =
      typeof document !== 'undefined' && !document.hidden && document.hasFocus();

    const camDynamics = host.cameraSubsystem?.cameraDynamics;
    if (camDynamics) {
      camDynamics.lookX = hasFocus
        ? Math.min(
            Math.max(
              host.keyboard.cameraLook.x +
                (this.gamepadSettingsJustClosed ? 0 : host.gamepad.cameraLook.x),
              -1,
            ),
            1,
          )
        : 0;
      camDynamics.lookY = hasFocus
        ? Math.min(
            Math.max(
              host.keyboard.cameraLook.y +
                (this.gamepadSettingsJustClosed ? 0 : host.gamepad.cameraLook.y),
              -1,
            ),
            1,
          )
        : 0;
    }

    if (!commitPhysicsStep) {
      return true;
    }

    const reconciler = host.networkManager?.sessionCoordinator?.networkReconciler ?? null;
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
          host.playerCarIndex,
          normalizedEffective,
        ) as CarControlsInput | null) || normalizedEffective;
    }

    host.playerThrottle = car0Controls.throttle ?? 0;
    host.playerControls = car0Controls;
    host.physics.setControls(host.playerCarIndex, car0Controls);

    if (host.botCoordinator) {
      host.botCoordinator.stepAuthoritativeBotControls(isKickoff);
    }

    if (reconciler?.historyBuffer.lastRemoteControls) {
      const numCars = Math.min(host.physics.numCars, 8);
      for (let c = 0; c < numCars; c++) {
        if (c !== host.playerCarIndex) {
          const remote = reconciler.historyBuffer.lastRemoteControls.get(c) as
            | ({ controls?: CarControlsInput } & CarControlsInput)
            | undefined;
          const remoteCtrl = remote?.controls ? remote.controls : remote || NEUTRAL_CAR_CONTROLS;
          host.physics.setControls(c, remoteCtrl);
        }
      }
    }
    return true;
  }
}
