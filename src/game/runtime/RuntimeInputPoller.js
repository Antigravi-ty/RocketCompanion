import { useAppStore } from '../../ui-core/stores/appStore';
import { getEffectiveGamepad } from '../../ui-core/config/InputBindings.js';
import {
  ExperimentalBotAgent,
  ensureExperimentalEngine,
} from '../../ai/experimental/ExperimentalBotAgent.js';

const BOT_CAR_INDEX = 1;

function resolveTouchActiveCarsAndTeam(runtime, carIndex) {
  const activeMode = runtime.modeManager?.getActiveMode?.();
  if (activeMode?.activeCarsList?.length > 0) {
    const found = activeMode.activeCarsList.find((c) => c.carIndex === carIndex);
    const team = found ? (found.team === 1 ? 1 : 0) : (carIndex % 2);
    return { team, activeCars: activeMode.activeCarsList };
  }

  const appState = useAppStore ? useAppStore.getState() : null;
  const peers = appState?.connectedPeers;
  if (Array.isArray(peers) && peers.length > 0) {
    const activeCars = [];
    let resolvedTeam = null;
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i];
      if (!p || p.isSpectator) continue;
      const cIdx = typeof p.entityId === 'number' ? p.entityId : typeof p.carIndex === 'number' ? p.carIndex : -1;
      if (cIdx < 0 || cIdx >= 6) continue;
      const t = p.team === 1 ? 1 : p.team === 0 ? 0 : cIdx % 2;
      activeCars.push({ carIndex: cIdx, team: t });
      if (cIdx === carIndex) {
        resolvedTeam = t;
      }
    }
    if (activeCars.length > 0) {
      const team = resolvedTeam !== null ? resolvedTeam : (carIndex % 2);
      if (!activeCars.some((c) => c.carIndex === carIndex)) {
        activeCars.push({ carIndex, team });
      }
      return { team, activeCars };
    }
  }

  return { team: carIndex % 2, activeCars: null };
}

function isClosestTeamCarToKickoff(runtime, carIndex, team, activeCars) {
  if (!Array.isArray(activeCars) || activeCars.length <= 2) return true;
  const myView = runtime.physics?.getCarStateView?.(carIndex);
  if (!myView) return true;
  const myDist = Math.hypot(myView.posX, myView.posY);
  for (let i = 0; i < activeCars.length; i++) {
    const entry = activeCars[i];
    if (entry.carIndex === carIndex || entry.team !== team) continue;
    const otherView = runtime.physics?.getCarStateView?.(entry.carIndex);
    if (!otherView || otherView.isDemoed) continue;
    const d = Math.hypot(otherView.posX, otherView.posY);
    if (d < myDist - 10 || (Math.abs(d - myDist) <= 10 && entry.carIndex < carIndex)) {
      return false;
    }
  }
  return true;
}

function resolveTouchAgentControls(runtime, agentType, isKickoff) {
  const carIndex = runtime.playerCarIndex ?? 0;
  const { team, activeCars } = resolveTouchActiveCarsAndTeam(runtime, carIndex);

  if (!runtime._touchInputAgentInstance) {
    runtime._touchInputAgentInstance = new ExperimentalBotAgent(agentType, carIndex, team);
    ensureExperimentalEngine(agentType);
  } else {
    runtime._touchInputAgentInstance.carIndex = carIndex;
    runtime._touchInputAgentInstance.team = team;
    if (runtime._touchInputAgentInstance.botType !== agentType) {
      runtime._touchInputAgentInstance.setBotType(agentType);
    }
  }

  const agent = runtime._touchInputAgentInstance;
  if (isKickoff) {
    runtime._touchAgentKickoffStep = 0;
    agent.reset();
    return runtime.neutralControls;
  }

  const simState = runtime.physics?.state;
  if (!simState) {
    return runtime.neutralControls;
  }

  const kickoffStep = runtime._touchAgentKickoffStep || 0;
  const isPrimaryKickoff = isClosestTeamCarToKickoff(runtime, carIndex, team, activeCars);
  const ko = agent.getKickoffControls(simState, kickoffStep, isPrimaryKickoff);
  let ctrl;
  if (ko) {
    ctrl = ko;
    agent.overrideControls(ko);
  } else if (agent.tickSkipCounter <= 0) {
    const pads = runtime.physics?.getPads?.() || [];
    ctrl = agent.decideSync(simState, pads, activeCars);
    agent.tickSkipCounter = agent.tickSkip - 1;
  } else {
    agent.tickSkipCounter--;
    ctrl = agent.action;
  }
  runtime._touchAgentKickoffStep = kickoffStep + 1;
  return ctrl || runtime.neutralControls;
}

export function pollRuntimeInputs(runtime, commitPhysicsStep = true) {
  const pad = getEffectiveGamepad();
  const btn8 = pad?.buttons[8]?.pressed ?? false;
  const padId = pad ? JSON.stringify([pad.id, pad.index]) : null;

  if (padId !== runtime.lastGamepadId) {
    runtime.lastGamepadButton8 = btn8;
  }
  runtime.lastGamepadId = padId;

  const appState = useAppStore ? useAppStore.getState() : null;
  const isMenuOpen = Boolean(appState?.isOpen);
  const shouldToggleMatch =
    btn8 && !runtime.lastGamepadButton8 && !isMenuOpen;
  if (shouldToggleMatch) {
    if (runtime.gameUI) {
      runtime.gameUI.openMenu('play');
    }
  }
  runtime.lastGamepadButton8 = btn8;

  if (shouldToggleMatch) runtime.gamepad.capturing = true;
  let padReading = runtime.gamepad.read();
  if (shouldToggleMatch) runtime.gamepad.capturing = false;

  if (runtime.gamepadSettingsJustClosed) {
    runtime.gamepadSettingsJustClosed = [0, 1, 8, 9].some(i => pad?.buttons[i]?.pressed);
    if (runtime.gamepadSettingsJustClosed) padReading = runtime.neutralControls;
  }

  const kbReading = runtime.keyboard.read();
  const activeDevice = runtime.gamepad.active() ? 'gamepad' : 'keyboard';
  const rawControls = activeDevice === 'gamepad' ? padReading : kbReading;
  const isFreeCamActive = Boolean(runtime.camera?.isFreeCam);
  const isKickoff = runtime.match?.state?.phase === 'kickoff';

  const touchMode = Boolean(appState?.touchMode);
  const touchInputAgent = appState?.touchInputAgent || 'none';

  let effectiveControls;
  if (isFreeCamActive || isKickoff) {
    if (isKickoff && (touchInputAgent === 'necto' || touchInputAgent === 'nexto')) {
      resolveTouchAgentControls(runtime, touchInputAgent, true);
    }
    effectiveControls = runtime.neutralControls;
  } else if (touchInputAgent === 'necto' || touchInputAgent === 'nexto') {
    effectiveControls = commitPhysicsStep
      ? resolveTouchAgentControls(runtime, touchInputAgent, false)
      : (runtime._touchInputAgentInstance?.action || runtime.neutralControls);
  } else if (touchMode && touchInputAgent === 'none') {
    effectiveControls = runtime.neutralControls;
  } else {
    effectiveControls = rawControls;
  }

  const hasFocus =
    typeof document !== 'undefined' && !document.hidden && document.hasFocus();

  runtime.cameraDynamics.lookX = hasFocus
    ? Math.min(Math.max(runtime.keyboard.cameraLook.x + (runtime.gamepadSettingsJustClosed ? 0 : runtime.gamepad.cameraLook.x), -1), 1)
    : 0;
  runtime.cameraDynamics.lookY = hasFocus
    ? Math.min(Math.max(runtime.keyboard.cameraLook.y + (runtime.gamepadSettingsJustClosed ? 0 : runtime.gamepad.cameraLook.y), -1), 1)
    : 0;

  if (!commitPhysicsStep) {
    return true;
  }

  if (runtime.networkReconciler?.shouldSkipLocalStep) {
    runtime.networkReconciler.shouldSkipLocalStep = false;
    return false;
  }

  let car0Controls = effectiveControls;
  if (runtime.networkReconciler) {
    car0Controls = runtime.networkReconciler.sampleAndPredictInput(runtime.playerCarIndex, effectiveControls) || effectiveControls;
  }

  runtime.playerThrottle = car0Controls.throttle;
  runtime.playerControls = car0Controls;
  runtime.physics.setControls(runtime.playerCarIndex, car0Controls);

  if (runtime.authoritativeServer && runtime.isBotMatch && runtime.match?.state?.mode === 'match' && !runtime.isBotPaused) {
    if (isKickoff) {
      runtime.botKickoffStep = 0;
      runtime.botControls = runtime.neutralControls;
      runtime.authoritativeServer.setCarControls(BOT_CAR_INDEX, runtime.botControls);
      runtime.physics.setControls(BOT_CAR_INDEX, runtime.botControls);
    } else {
      const kickoffControls = runtime.bot?.getKickoffControls?.(runtime.physics.state, runtime.botKickoffStep);
      if (kickoffControls) {
        runtime.botControls = kickoffControls;
        runtime.bot?.overrideControls?.(kickoffControls);
      } else if (runtime.botTickSkip <= 0) {
        runtime.scheduleBotDecision();
      }
      runtime.botKickoffStep++;
      if (!kickoffControls && runtime.botTickSkip > 0) {
        runtime.botTickSkip--;
      }
      runtime.authoritativeServer.setCarControls(BOT_CAR_INDEX, runtime.botControls);
      runtime.physics.setControls(BOT_CAR_INDEX, runtime.botControls);
    }
  } else if (
    runtime.networkReconciler &&
    runtime.networkReconciler.lastRemoteControls
  ) {
    const numCars = Math.min(runtime.physics.numCars, 8);
    for (let c = 0; c < numCars; c++) {
      if (c !== runtime.playerCarIndex) {
        const remote = runtime.networkReconciler.lastRemoteControls.get(c);
        const remoteCtrl = remote?.controls ? remote.controls : (remote || runtime.neutralControls);
        runtime.physics.setControls(c, remoteCtrl);
      }
    }
  }
  return true;
}
