import {
  releaseDiagnosticFleetIfEnabled,
  type WorkerRouterContext,
} from './workerReplayAndDiagnosticsRouter.ts';

/**
 * Narrow-waist router for direct physics/training mutators, car entity lifecycle,
 * state snapshot save/restore, and legacy match admin commands.
 */
export function routeTrainingAndPhysicsMessage(
  workerCtx: WorkerRouterContext,
  type: string,
  payload: Record<string, any>,
  syncRoomState: () => void,
  emitRaw: ((msg: any, transfer?: Transferable[]) => void) | null | undefined
): boolean {
  const { sim, physicsManager, matchManager } = workerCtx;

  switch (type) {
    case 'ensureCar':
      physicsManager?.registerCarEntity(
        payload.carIndex,
        payload.team ?? payload.carIndex % 2,
        payload.visualId || 'octane'
      );
      return true;

    case 'removeCar': {
      const targetCarIdx = payload.carIndex;
      if (matchManager && typeof targetCarIdx === 'number') {
        for (const [sid, p] of Array.from(matchManager.roster.players.entries())) {
          if (p.entityId === targetCarIdx && sid !== 'host') {
            matchManager.roster.removePlayerSession(sid);
          }
        }
      }
      physicsManager?.unregisterCarEntity(targetCarIdx);
      return true;
    }

    case 'setCarControls':
      physicsManager?.setDirectCarControls(payload.carIndex, payload.controls);
      return true;

    case 'setCarState':
      sim?.setCarState?.(payload.carIndex, payload.state || payload.stateObj);
      return true;

    case 'setBallState':
      sim?.setBallState?.(payload.ballState || payload.state);
      return true;

    case 'controlBall':
      sim?.controlBall?.(payload.carIndex ?? 0, payload.mode ?? payload.actionId ?? 0);
      return true;

    case 'setCarCollisionMask':
    case 'setGhostCarConfig':
      physicsManager?.setCarCollisionMask(
        payload.carIndex,
        Boolean(payload.interactWithBall),
        Boolean(payload.interactWithCars),
        payload.opacity
      );
      return true;

    case 'setLobbyMode':
      if (matchManager) {
        if (payload.enabled !== false) matchManager.lifecycle.enterLobbyMode(payload);
        else physicsManager?.setLobbyGhostMode(false);
      }
      return true;

    case 'setCarLinearFactorAndGravity':
      sim?.setCarLinearFactorAndGravity?.(
        payload.carIndex,
        payload.fx ?? 1,
        payload.fy ?? 1,
        payload.fz ?? 1,
        payload.gravityScale ?? 1
      );
      return true;

    case 'setArenaMutators':
      sim?.setArenaMutators?.(payload.mutators || payload);
      return true;

    case 'resetGoalLatch':
      physicsManager?.resetGoalLatch();
      return true;

    case 'pauseMatch':
      matchManager?.lifecycle.setPaused(Boolean(payload.paused));
      return true;

    case 'requestResumeWithCountdown':
      matchManager?.lifecycle.requestResumeWithCountdown(Number(payload.countdownSeconds ?? 5));
      return true;

    case 'startTrainingMode':
      matchManager?.lifecycle.startTrainingMode(payload);
      return true;

    case 'configureTrainingRuleset':
      matchManager?.configureTrainingRuleset(payload);
      return true;

    case 'enterStateOnlyMode':
      matchManager?.enterStateOnlyMode(payload?.stateSnapshot ?? null, payload?.cursorTick);
      return true;

    case 'beginInterveneCountdown':
      matchManager?.beginInterveneCountdown(
        payload?.countdownSeconds ?? 3,
        payload?.stateSnapshot ?? null
      );
      return true;

    case 'resumePhysicsFromState':
      matchManager?.resumePhysicsFromState(payload?.stateSnapshot ?? null, payload?.resumeTick);
      return true;

    case 'startMatch':
      releaseDiagnosticFleetIfEnabled(workerCtx, matchManager, physicsManager);
      matchManager?.lifecycle.startMatch(payload?.durationSeconds);
      return true;

    case 'forceStartMatch':
      releaseDiagnosticFleetIfEnabled(workerCtx, matchManager, physicsManager);
      matchManager?.lifecycle.forceStartMatch(payload?.durationSeconds);
      return true;

    case 'initiateMatchPrepare':
      releaseDiagnosticFleetIfEnabled(workerCtx, matchManager, physicsManager);
      matchManager?.lifecycle.initiateMatchPrepare(payload?.durationSeconds);
      return true;

    case 'setGameMode':
      if (payload?.gameMode)
        matchManager?.roster.setGameMode(payload.gameMode, payload.durationSeconds);
      syncRoomState();
      return true;

    case 'setBotFillMode':
      if (payload?.botFillMode) matchManager?.roster.setBotFillMode(payload.botFillMode);
      syncRoomState();
      return true;

    case 'addBotPlayer':
      matchManager?.roster.addBotPlayer(
        payload?.team ?? 1,
        payload?.botName ?? null,
        payload?.visualId || 'octane'
      );
      return true;

    case 'setLoadout':
      matchManager?.roster.updatePlayerLoadout(
        payload.sessionId || 'host',
        payload.visualId || 'octane',
        payload.colorSlot ?? 0,
        payload.hitboxId ?? null,
        payload.extraLoadout ?? null
      );
      return true;

    case 'switchRoleTeam':
      matchManager?.roster.switchPlayerRoleOrTeam(
        payload.sessionId || 'host',
        payload.role || 'player',
        payload.team ?? 0
      );
      syncRoomState();
      return true;

    case 'setSkipReplayByDefault':
      if (matchManager) matchManager.domain.skipReplayByDefault = Boolean(payload.enabled);
      return true;

    case 'setDisableGoalReset':
      if (matchManager) matchManager.domain.trainingDisableGoalReset = Boolean(payload.disabled);
      return true;

    case 'setUnlimitedBoost':
      sim?.setUnlimitedBoost(Boolean(payload.enabled));
      return true;

    case 'setCarUnlimitedBoost':
      sim?.setCarUnlimitedBoost?.(Number(payload.carIndex) || 0, Boolean(payload.enabled));
      return true;

    case 'setCarBoostCollectable':
      sim?.setCarBoostCollectable?.(Number(payload.carIndex) || 0, Boolean(payload.collectable));
      return true;

    case 'setCarBoostRecharge':
      sim?.setCarBoostRecharge?.(
        Number(payload.carIndex) || 0,
        Boolean(payload.enabled),
        Number(payload.rechargePerSecond ?? 10.0),
        Number(payload.rechargeDelay ?? 0.25)
      );
      return true;

    case 'resetKickoff':
      physicsManager?.resetKickoff(payload.seed || 0);
      if (matchManager && physicsManager) {
        matchManager.domain.matchTick = physicsManager.currentTick;
      }
      return true;

    case 'restoreState': {
      const { state, reqId } = payload;
      if (sim && state) sim.restoreState(state);
      const snap = sim ? (sim.saveCompactState ? sim.saveCompactState() : sim.saveState()) : null;
      const tickCount = sim ? Math.floor(sim.getHeaderView().tickCount) : 0;
      if (matchManager && sim) {
        matchManager.domain.matchTick = tickCount;
      }
      emitRaw?.({
        type: 'requestResponse',
        reqId,
        result: { snapshot: snap, tickCount },
      });
      return true;
    }

    case 'saveState': {
      const { reqId } = payload;
      const snap = sim ? (sim.saveCompactState ? sim.saveCompactState() : sim.saveState()) : null;
      const tickCount = sim ? Math.floor(sim.getHeaderView().tickCount) : 0;
      emitRaw?.({
        type: 'requestResponse',
        reqId,
        result: { snapshot: snap, tickCount },
      });
      return true;
    }

    default:
      return false;
  }
}
