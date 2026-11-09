import { useSubsystemIsolationLabStore } from '../../runtimeUiPort.ts';
import type { LabTabContext, LabTabController } from './LabTabTypes.ts';
import {
  PROBE_BOOST_SLOT,
  PROBE_QE_SLOT,
  type ProbeControllerState,
  parkDevTestLabProbes,
  setupDevTestLabProbes,
  stepDevTestLabProbes,
  updateDevTestLabProbeParameters,
} from './probeKinematicsPipeline.ts';

export type ProbeCameraTarget = 'player' | 'boost_probe' | 'qe_probe';

export class ProbesLabTab implements LabTabController {
  readonly tabId = 'probes' as const;
  private ctx: LabTabContext | null = null;
  private probeState: ProbeControllerState | null = null;

  onActivate(ctx: LabTabContext): void {
    this.ctx = ctx;
    this.syncConfiguration(true);
  }

  onDeactivate(): void {
    const sceneTarget = this.ctx?.runtime;
    if (sceneTarget?.physics) {
      parkDevTestLabProbes(sceneTarget.physics, sceneTarget.arena);
    }
    this.probeState = null;
    this.applyCameraTarget('player');
    this.ctx = null;
  }

  onPhysicsTick(_dt: number): boolean {
    const sim = this.ctx?.runtime?.physics;
    const store = useSubsystemIsolationLabStore.getState();
    if (!store.probesEnabled || !sim) {
      return true;
    }

    if (!this.probeState) {
      this.syncConfiguration(false);
    }
    const stepOutput = stepDevTestLabProbes(sim, this.probeState);
    if (stepOutput) {
      this.probeState = stepOutput.nextState;
      if (this.probeState.tickCounter % 4 === 0) {
        const { telemetry } = stepOutput;
        store.updateLiveTelemetry({
          probeBoostZ: telemetry.posZ,
          probeBoostVz: telemetry.velZ,
          probeBoostPhase: telemetry.phase,
          probeBoostHoldTicks: telemetry.holdCounter,
          probeRollDir: telemetry.rollDir,
        });
      }
    }
    return true;
  }

  syncConfiguration(forceRestart = false): void {
    const sceneTarget = this.ctx?.runtime;
    const sim = sceneTarget?.physics;
    const arena = sceneTarget?.arena;
    const store = useSubsystemIsolationLabStore.getState();
    if (!sim || store.activeTab !== 'probes') return;

    if (store.probesEnabled) {
      if (!forceRestart && this.probeState && sim.numCars > PROBE_QE_SLOT) {
        this.probeState = updateDevTestLabProbeParameters(
          sim,
          this.probeState,
          store.probeBaseAltitudeZ,
          store.probePeakAltitudeZ,
          store.probeOffsetX,
          store.probeOffsetY,
          store.probeOffsetZ,
          arena
        );
      } else {
        this.probeState = setupDevTestLabProbes(
          sim,
          arena,
          store.probeBaseAltitudeZ,
          store.probePeakAltitudeZ,
          store.probeOffsetX,
          store.probeOffsetY,
          store.probeOffsetZ
        );
      }
      store.updateLiveTelemetry({
        probeBoostZ: this.probeState?.effectiveBaseZ ?? store.probeBaseAltitudeZ,
        probeBoostVz: 0,
        probeBoostPhase: 'CLIMB_TO_PEAK',
        probeBoostHoldTicks: 0,
        probeRollDir: 1,
      });
      sceneTarget?.interpolator?.sync?.();
    } else {
      parkDevTestLabProbes(sim, arena);
      this.probeState = null;
      if (store.probeCameraTarget !== 'player') {
        this.applyCameraTarget('player');
      }
    }
  }

  applyCameraTarget(target: ProbeCameraTarget): void {
    const sceneTarget = this.ctx?.runtime;
    if (!sceneTarget) return;
    const nextIdx =
      target === 'boost_probe' ? PROBE_BOOST_SLOT : target === 'qe_probe' ? PROBE_QE_SLOT : 0;
    sceneTarget.playerCarIndex = nextIdx;
    if (sceneTarget.arena) {
      sceneTarget.arena.playerCarIndex = nextIdx;
    }
  }
}
