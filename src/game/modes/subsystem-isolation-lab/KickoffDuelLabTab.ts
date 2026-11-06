import { DEFAULT_CAR_CONTROLS } from '../../../ai/experimental/ExperimentalBotAgent.ts';
import { useSubsystemIsolationLabStore } from '../../runtimeUiPort.ts';
import type { LabTabContext, LabTabController } from './LabTabTypes.ts';
import {
  KICKOFF_DUEL_PAIRINGS,
  type KickoffDuelAgentEnsemble,
  type KickoffStepTraceEntry,
  buildCarStepTraceEntry,
  classifyBallOutcome,
  createKickoffDuelHelpers,
  decideCarControlsForModel,
  ensureKickoffDuelModelsLoaded,
  resetSimToKickoffSlotAndSettle,
} from './kickoffDuelSimulationPipeline.ts';
import {
  exportKickoffDuelDiagnosticsData,
  runFullKickoffDuelMatrixBenchmark,
} from './kickoffDuelBenchmarkPipeline.ts';

interface KickoffDuelEpisodeRuntime {
  tick: number;
  slotIndex: number;
  touched: boolean;
  touchTick: number;
  touchWinner: string;
  blueDistAtTouch: number;
  orangeDistAtTouch: number;
  ballSpeedAtTouch: number;
  ballVyAtTouch: number;
  inputsCutOff: boolean;
  cutoffTick: number;
  postCutoffTicks: number;
  blueSteps: KickoffStepTraceEntry[];
  orangeSteps: KickoffStepTraceEntry[];
}

export class KickoffDuelLabTab implements LabTabController {
  readonly tabId = 'kickoff-duel' as const;
  private ctx: LabTabContext | null = null;
  private kickoffDuelHelpers: KickoffDuelAgentEnsemble | null = null;
  private kickoffDuelRuntime: KickoffDuelEpisodeRuntime | null = null;

  onActivate(ctx: LabTabContext): void {
    this.ctx = ctx;
    void this.setupBench();
  }

  onDeactivate(): void {
    this.kickoffDuelRuntime = null;
    this.ctx = null;
  }

  async setupBench(): Promise<void> {
    if (!this.ctx) return;
    const r = this.ctx.runtime;
    if (!r?.physics) return;
    const store = useSubsystemIsolationLabStore.getState();
    const epoch = this.ctx.getSwitchEpoch();

    if (!this.kickoffDuelHelpers) {
      this.kickoffDuelHelpers = createKickoffDuelHelpers(
        store.kickoffDuelChannelMode
      );
    }

    this.startEpisode();

    await r.arena?.ensureOpponent?.();
    await ensureKickoffDuelModelsLoaded([
      store.kickoffDuelBlueModel,
      store.kickoffDuelOrangeModel,
    ]);

    if (
      this.ctx?.getSwitchEpoch() !== epoch ||
      useSubsystemIsolationLabStore.getState().activeTab !== 'kickoff-duel'
    ) {
      return;
    }

    if (r.arena?.cars) {
      if (r.arena.cars[0]) {
        r.arena.cars[0].visible = true;
        r.arena.setCarTeam?.(0, 0);
      }
      if (r.arena.cars[1]) {
        r.arena.cars[1].visible = true;
        r.arena.setCarTeam?.(1, 1);
      }
      for (let i = 2; i < r.arena.cars.length; i++) {
        if (r.arena.cars[i]) r.arena.cars[i].visible = false;
      }
    }

    const mult = Math.max(
      100,
      Math.min(400, Number(store.kickoffDuelSpeedMultiplier) || 100)
    );
    r.interpolator?.setTrainingPhysicsRate?.(Math.round(120 * (mult / 100)));

    this.startEpisode();
  }

  startEpisode(overrideSlotIndex: number | null = null): void {
    const r = this.ctx?.runtime;
    if (!r?.physics) return;
    const store = useSubsystemIsolationLabStore.getState();

    void ensureKickoffDuelModelsLoaded([
      store.kickoffDuelBlueModel,
      store.kickoffDuelOrangeModel,
    ]);

    const slotIdx =
      typeof overrideSlotIndex === 'number'
        ? overrideSlotIndex
        : store.kickoffDuelSlotIndex ?? 0;

    resetSimToKickoffSlotAndSettle(r.physics, slotIdx);
    r.physics.clearEvents?.();
    r.arena?.resetAllCarEffects?.();
    r.interpolator?.sync?.();

    if (this.kickoffDuelHelpers) {
      (this.kickoffDuelHelpers.koV2Blue as any).channelMode =
        store.kickoffDuelChannelMode;
      (this.kickoffDuelHelpers.koV2Orange as any).channelMode =
        store.kickoffDuelChannelMode;
      this.kickoffDuelHelpers.koV2Blue.reset();
      this.kickoffDuelHelpers.koV2Orange.reset();
      this.kickoffDuelHelpers.koV1Blue.resetTracker();
      this.kickoffDuelHelpers.koV1Orange.resetTracker();
      this.kickoffDuelHelpers.expBlue.setBotType(
        store.kickoffDuelBlueModel === 'necto' ? 'necto' : 'nexto'
      );
      this.kickoffDuelHelpers.expOrange.setBotType(
        store.kickoffDuelOrangeModel === 'necto' ? 'necto' : 'nexto'
      );
      this.kickoffDuelHelpers.expBlue.reset();
      this.kickoffDuelHelpers.expOrange.reset();
      this.kickoffDuelHelpers.blueCtrl = { ...DEFAULT_CAR_CONTROLS };
      this.kickoffDuelHelpers.orangeCtrl = { ...DEFAULT_CAR_CONTROLS };
    }

    this.kickoffDuelRuntime = {
      tick: 0,
      slotIndex: slotIdx,
      touched: false,
      touchTick: -1,
      touchWinner: 'NONE',
      blueDistAtTouch: 0,
      orangeDistAtTouch: 0,
      ballSpeedAtTouch: 0,
      ballVyAtTouch: 0,
      inputsCutOff: false,
      cutoffTick: -1,
      postCutoffTicks: 0,
      blueSteps: [],
      orangeSteps: [],
    };

    store.updateLiveTelemetry({
      kickoffDuelSlotIndex: slotIdx,
      kickoffDuelPhase: 'APPROACHING',
      kickoffDuelCurrentTick: 0,
      kickoffDuelTouchTick: -1,
      kickoffDuelTouchWinner: 'NONE',
      kickoffDuelInputsCutOff: false,
      kickoffDuelBlueDist: 0,
      kickoffDuelOrangeDist: 0,
      kickoffDuelBallPos: [0, 0, 93.15],
      kickoffDuelBallVel: [0, 0, 0],
      kickoffDuelBallSpeed: 0,
      kickoffDuelBallOutcome: 'Waiting for First Touch...',
      kickoffDuelLiveBlueSteps: [],
      kickoffDuelLiveOrangeSteps: [],
    });
  }

  applySpeedMultiplier(mult: number): void {
    const r = this.ctx?.runtime;
    if (!r) return;
    const m = Math.max(100, Math.min(400, Number(mult) || 100));
    r.interpolator?.setTrainingPhysicsRate?.(Math.round(120 * (m / 100)));
  }

  runMatrixBenchmark(): Promise<void> {
    return runFullKickoffDuelMatrixBenchmark();
  }

  exportDiagnostics(format = 'json', scope = 'all_models_all_slots'): Promise<void> {
    return exportKickoffDuelDiagnosticsData(
      {
        blueSteps: this.kickoffDuelRuntime?.blueSteps || [],
        orangeSteps: this.kickoffDuelRuntime?.orangeSteps || [],
      },
      format,
      scope
    );
  }

  onPhysicsTick(_dt: number): boolean {
    const r = this.ctx?.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    const sim = r?.physics;
    if (
      !sim ||
      sim.numCars < 2 ||
      !this.kickoffDuelRuntime ||
      !this.kickoffDuelHelpers
    ) {
      return true;
    }

    const rt = this.kickoffDuelRuntime;
    const helpers = this.kickoffDuelHelpers;

    const bs = sim.getBallStateView();
    const c0 = sim.getCarStateView(0);
    const c1 = sim.getCarStateView(1);

    const ballMoved =
      Math.hypot(bs.posX, bs.posY, bs.posZ - 93.15) > 0.8 ||
      Math.hypot(bs.velX, bs.velY, bs.velZ) > 5.0;

    if (!rt.touched && ballMoved) {
      rt.touched = true;
      rt.touchTick = rt.tick;
      const d0 = Math.hypot(c0.posX - bs.posX, c0.posY - bs.posY, c0.posZ - bs.posZ);
      const d1 = Math.hypot(c1.posX - bs.posX, c1.posY - bs.posY, c1.posZ - bs.posZ);
      rt.blueDistAtTouch = Math.round(d0);
      rt.orangeDistAtTouch = Math.round(d1);
      rt.ballSpeedAtTouch = Math.round(Math.hypot(bs.velX, bs.velY, bs.velZ));
      rt.ballVyAtTouch = Math.round(bs.velY);

      if (Math.abs(d0 - d1) <= 8.0) {
        rt.touchWinner = 'TIE';
      } else if (d0 < d1) {
        rt.touchWinner = 'BLUE';
      } else {
        rt.touchWinner = 'ORANGE';
      }
    }

    const cutoffDelayTicks = Math.max(
      0,
      Math.round((store.kickoffDuelCutoffDelaySec ?? 0.5) * 120)
    );
    if (
      rt.touched &&
      !rt.inputsCutOff &&
      rt.tick >= rt.touchTick + cutoffDelayTicks
    ) {
      rt.inputsCutOff = true;
      rt.cutoffTick = rt.tick;
    }

    if (rt.inputsCutOff) {
      sim.setControls(0, DEFAULT_CAR_CONTROLS);
      sim.setControls(1, DEFAULT_CAR_CONTROLS);
      rt.postCutoffTicks++;
    } else {
      const blueModel = store.kickoffDuelBlueModel || 'ko_v2';
      const orangeModel = store.kickoffDuelOrangeModel || 'ko_v1';
      const decideOpts = {
        nextoScripted: Boolean(store.kickoffDuelNextoScripted),
        channelMode: store.kickoffDuelChannelMode || 'keyboard_coupled',
      };

      const ctrl0 = decideCarControlsForModel(
        sim,
        blueModel,
        0,
        0,
        rt.tick,
        helpers,
        decideOpts
      );
      const ctrl1 = decideCarControlsForModel(
        sim,
        orangeModel,
        1,
        1,
        rt.tick,
        helpers,
        decideOpts
      );

      if (rt.tick % 4 === 0 && rt.blueSteps.length < 120) {
        rt.blueSteps.push(
          buildCarStepTraceEntry(sim, blueModel, 0, rt.tick, helpers, ctrl0)
        );
        rt.orangeSteps.push(
          buildCarStepTraceEntry(sim, orangeModel, 1, rt.tick, helpers, ctrl1)
        );
      }

      sim.setControls(0, ctrl0);
      sim.setControls(1, ctrl1);
    }

    rt.tick++;

    if (
      rt.tick % 4 === 0 ||
      rt.tick === rt.touchTick + 1 ||
      rt.tick === rt.cutoffTick + 1
    ) {
      const d0Now = Math.round(
        Math.hypot(c0.posX - bs.posX, c0.posY - bs.posY, c0.posZ - bs.posZ)
      );
      const d1Now = Math.round(
        Math.hypot(c1.posX - bs.posX, c1.posY - bs.posY, c1.posZ - bs.posZ)
      );
      const bSpd = Math.round(Math.hypot(bs.velX, bs.velY, bs.velZ));
      const outcome = rt.touched
        ? classifyBallOutcome(bs.posX, bs.posY, bs.velX, bs.velY)
        : 'Approaching Ball...';

      let phase = 'APPROACHING';
      if (rt.inputsCutOff) {
        phase = 'INPUTS CUT OFF (OBSERVING BALL)';
      } else if (rt.touched) {
        phase = `POST-TOUCH FOLLOW-THROUGH (${Math.max(0, rt.touchTick + cutoffDelayTicks - rt.tick)}f left)`;
      }

      store.updateLiveTelemetry({
        kickoffDuelPhase: phase,
        kickoffDuelCurrentTick: rt.tick,
        kickoffDuelTouchTick: rt.touchTick,
        kickoffDuelTouchWinner: rt.touchWinner,
        kickoffDuelInputsCutOff: rt.inputsCutOff,
        kickoffDuelBlueDist: rt.touched ? rt.blueDistAtTouch : d0Now,
        kickoffDuelOrangeDist: rt.touched ? rt.orangeDistAtTouch : d1Now,
        kickoffDuelBallPos: [
          Math.round(bs.posX),
          Math.round(bs.posY),
          Math.round(bs.posZ),
        ],
        kickoffDuelBallVel: [
          Math.round(bs.velX),
          Math.round(bs.velY),
          Math.round(bs.velZ),
        ],
        kickoffDuelBallSpeed: bSpd,
        kickoffDuelBallOutcome: outcome,
        kickoffDuelLiveBlueSteps: rt.blueSteps.slice(-16),
        kickoffDuelLiveOrangeSteps: rt.orangeSteps.slice(-16),
      });
    }

    const maxObservationTicks = 180;
    const timedOut = !rt.touched && rt.tick >= 420;
    const finishedObservation =
      rt.inputsCutOff && rt.postCutoffTicks >= maxObservationTicks;

    if ((finishedObservation || timedOut) && store.kickoffDuelAutoCycle) {
      const nextSlot = (rt.slotIndex + 1) % 5;
      if (nextSlot === 0 && store.kickoffDuelAutoCycleAllPairs) {
        const currentPairIdx = KICKOFF_DUEL_PAIRINGS.findIndex(
          (p) =>
            p.blue === store.kickoffDuelBlueModel &&
            p.orange === store.kickoffDuelOrangeModel
        );
        const nextPair =
          KICKOFF_DUEL_PAIRINGS[(currentPairIdx + 1) % KICKOFF_DUEL_PAIRINGS.length];
        store.updateLiveTelemetry({
          kickoffDuelBlueModel: nextPair.blue,
          kickoffDuelOrangeModel: nextPair.orange,
        });
      }
      this.startEpisode(nextSlot);
    }

    return true;
  }
}
