import {
  DEFAULT_CAR_CONTROLS,
  ExperimentalBotAgent,
  ensureExperimentalEngine,
  multiCarHeuristicDecide,
} from '../../../ai/experimental/ExperimentalBotAgent.ts';
import type { CarControls } from '../../../ai/experimental/experimentalMultiCarObsPipeline.ts';
import type { ArenaBoostPadDescriptor } from '../../../physics/RocketSimSnapshotSerializer.ts';
import type {
  LabPhysicsEnginePort,
  LabRuntimePort,
} from './LabTabTypes.ts';

const INCIDENT_ACTIVE_CARS: Array<{ carIndex: number; team: number }> = [
  { carIndex: 0, team: 0 },
  { carIndex: 1, team: 1 },
];

/**
 * NinetySecDualBotController
 * Owns dual-Nexto AI agent lifecycle, tick-skip throttling, kickoff macro step counter,
 * and wall/ceiling heuristic fallback for the 90s Match Isolation Lab tab.
 */
export class NinetySecDualBotController {
  private botBlue: ExperimentalBotAgent | null = null;
  private botOrange: ExperimentalBotAgent | null = null;
  private botBlueControls: CarControls = { ...DEFAULT_CAR_CONTROLS };
  private botOrangeControls: CarControls = { ...DEFAULT_CAR_CONTROLS };
  private botBlueTickSkip = 0;
  private botOrangeTickSkip = 0;
  private botDecisionEpoch = 0;
  private incidentKickoffStep = 0;

  public incrementEpoch(): void {
    this.botDecisionEpoch++;
  }

  public async ensureLoaded(): Promise<void> {
    if (!this.botBlue) this.botBlue = new ExperimentalBotAgent('nexto', 0, 0);
    if (!this.botOrange) this.botOrange = new ExperimentalBotAgent('nexto', 1, 1);
    await ensureExperimentalEngine('nexto');
  }

  public resetEpoch(): void {
    this.botDecisionEpoch++;
    this.botBlue?.reset?.();
    this.botOrange?.reset?.();
    this.botBlueControls = { ...DEFAULT_CAR_CONTROLS };
    this.botOrangeControls = { ...DEFAULT_CAR_CONTROLS };
    this.botBlueTickSkip = 0;
    this.botOrangeTickSkip = 0;
    this.incidentKickoffStep = 0;
  }

  private stepSingleNextoCar(
    sim: LabPhysicsEnginePort,
    pads: ReadonlyArray<ArenaBoostPadDescriptor>,
    carIdx: number,
    team: number,
    isOrange: boolean
  ): void {
    const bot = isOrange ? this.botOrange : this.botBlue;
    if (!bot) return;
    const car = sim.getCarStateView(carIdx);
    const onWallOrCeiling =
      car &&
      (Math.abs(car.posX) > 3650 ||
        Math.abs(car.posY) > 4750 ||
        car.upZ < 0.82 ||
        car.posZ > 700);
    const ko = !onWallOrCeiling
      ? bot.getKickoffControls(sim.state, this.incidentKickoffStep, true)
      : null;

    let ctrl = isOrange ? this.botOrangeControls : this.botBlueControls;
    let skip = isOrange ? this.botOrangeTickSkip : this.botBlueTickSkip;

    if (ko) {
      ctrl = ko;
      bot.overrideControls(ko);
    } else if (onWallOrCeiling) {
      ctrl = multiCarHeuristicDecide(
        sim.state,
        pads,
        carIdx,
        team,
        INCIDENT_ACTIVE_CARS
      );
    } else if (skip <= 0) {
      ctrl = bot.decideSync(sim.state, pads, INCIDENT_ACTIVE_CARS);
      skip = bot.tickSkip - 1;
    } else {
      skip--;
    }

    if (isOrange) {
      this.botOrangeControls = ctrl;
      this.botOrangeTickSkip = skip;
    } else {
      this.botBlueControls = ctrl;
      this.botBlueTickSkip = skip;
    }
    sim.setControls(carIdx, ctrl);
  }

  public stepDualNextoBots(sim: LabPhysicsEnginePort): void {
    if (!this.botBlue || !this.botOrange) {
      void this.ensureLoaded();
    }
    const pads = sim.getPads();
    this.stepSingleNextoCar(sim, pads, 0, 0, false);
    this.stepSingleNextoCar(sim, pads, 1, 1, true);
    this.incidentKickoffStep++;
  }
}

export function setupTwoCarIncidentArena(
  r: LabRuntimePort | null | undefined
): void {
  if (!r?.physics) return;
  while (r.physics.numCars > 0 && typeof r.physics.removeCar === 'function') {
    r.physics.removeCar(r.physics.numCars - 1);
  }
  r.physics.addCar(0, 'octane');
  r.physics.addCar(1, 'octane');

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
}
