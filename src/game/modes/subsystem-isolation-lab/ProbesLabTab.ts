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
    const runtime = this.ctx?.runtime;
    if (runtime?.physics) {
      parkDevTestLabProbes(runtime.physics, runtime.arena);
    }
    this.probeState = null;
    this.applyCameraTarget('player');
    this.ctx = null;
  }

  onPhysicsTick(_dt: number): boolean {
    const runtime = this.ctx?.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    if (!store.probesEnabled || !runtime?.physics) {
      return true;
    }

    if (!this.probeState) {
      this.syncConfiguration(false);
    }
    const stepOutput = stepDevTestLabProbes(runtime.physics, this.probeState);
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
    const runtime = this.ctx?.runtime;
    const store = useSubsystemIsolationLabStore.getState();
    if (!runtime?.physics || store.activeTab !== 'probes') return;

    if (store.probesEnabled) {
      if (!forceRestart && this.probeState && runtime.physics.numCars > PROBE_QE_SLOT) {
        this.probeState = updateDevTestLabProbeParameters(
          runtime.physics,
          this.probeState,
          store.probeBaseAltitudeZ,
          store.probePeakAltitudeZ,
          store.probeOffsetX,
          store.probeOffsetY,
          store.probeOffsetZ,
          runtime.arena
        );
      } else {
        this.probeState = setupDevTestLabProbes(
          runtime.physics,
          runtime.arena,
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
      runtime.interpolator?.sync?.();
    } else {
      parkDevTestLabProbes(runtime.physics, runtime.arena);
      this.probeState = null;
      if (store.probeCameraTarget !== 'player') {
        this.applyCameraTarget('player');
      }
    }
  }

  applyCameraTarget(target: ProbeCameraTarget): void {
    const runtime = this.ctx?.runtime;
    if (!runtime) return;
    runtime.playerCarIndex =
      target === 'boost_probe'
        ? PROBE_BOOST_SLOT
        : target === 'qe_probe'
          ? PROBE_QE_SLOT
          : 0;
    if (runtime.arena) {
      runtime.arena.playerCarIndex = runtime.playerCarIndex;
    }
  }
}
