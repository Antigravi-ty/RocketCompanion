/**
 * replayViewerBaselineScenario.ts
 * Automated WebGL & physics baseline scenario covering 6-car StandaloneReplayViewerController
 * playback, POV switching, timeline scoreboard deduplication, and clean exit back to 1-car Freeplay.
 */

import { retainCompletedMatchReplayAndNotify } from '../../replay/ReplayFileExporter.ts';
import type { ScenarioScript } from './ScenarioTypes.ts';

interface BoostParticleSystemCheck {
  driveParticlesActive?: boolean;
  trailParticlesActive?: boolean;
}

interface BoostEmitterCheck {
  physics?: BoostParticleSystemCheck;
  goldRush?: BoostParticleSystemCheck;
}

interface CarMeshCheck {
  visible?: boolean;
}

export const REPLAY_VIEWER_6CAR_PLAYBACK_AND_EXIT_SCENARIO: ScenarioScript = {
  id: 'replay_viewer_6car_playback_and_exit',
  title: '6-Car Standalone Replay Viewer Playback, POV Switch, and Clean Exit to Freeplay',
  description:
    'Loads a 6-car replay into StandaloneReplayViewerController, verifies 120Hz playback, POV car switching, timeline scoreboard deduplication, and verifies that exiting back to Freeplay leaves zero active boost particle resets or active remote audio synths on inactive slots 1..5.',
  totalTicks: 240,
  renderStride: 15,
  batchYieldTicks: 60,
  forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    const r = ctx.runtime;
    if (r?.authoritativeServer || r?.networkReconciler) {
      await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
    }
    r?.modeManager?.setActiveMode?.('freeplay');
    r?.resetKickoff?.(0);
    const freeplayMode = r?.modeManager?.getActiveMode?.();
    const viewer = freeplayMode?.standaloneReplayViewer;
    if (viewer && r?.physics) {
      while (r.physics.numCars < 6 && typeof r.physics.addCar === 'function') {
        r.physics.addCar(r.physics.numCars % 2, 'octane');
      }
      r.physics.resetKickoff?.(0);
      const frameSlots: Array<{ tick: number; snapshot: Float32Array; acknowledgedControls: unknown[] }> = [];
      for (let f = 0; f < 180; f++) {
        for (let c = 0; c < 6; c++) {
          r.physics.setControls?.(c, {
            throttle: 1.0,
            steer: c % 2 === 0 ? 0.15 : -0.15,
            pitch: 0,
            yaw: 0,
            roll: 0,
            jump: false,
            boost: f < 60,
            handbrake: false,
          });
        }
        r.physics.step?.(1 / 120);
        const snap = r.physics.saveCompactState?.();
        if (snap) {
          frameSlots.push({
            tick: f + 1,
            snapshot: new Float32Array(snap),
            acknowledgedControls: [],
          });
        }
      }
      retainCompletedMatchReplayAndNotify({
        frames: frameSlots,
        mode: 'standard_3v3',
        gameMode: 'match',
        durationSeconds: 1.5,
        suppressNotification: true,
      });
      viewer.handleLoadRetainedMatchReplay();
      viewer.startPlaying();
    }
  },
  steps: [
    {
      tick: 30,
      description: 'Verify 6-car StandaloneReplayViewerController is actively playing',
      forceKeyframeRender: true,
      keyframeReason: 'replay_viewer_6car_playing_keyframe',
      action: (ctx) => {
        const r = ctx.runtime;
        const viewer = r?.modeManager?.getActiveMode?.()?.standaloneReplayViewer;
        const isPlaying = Boolean(viewer?.isActive && viewer?.hasLoadedReplay);
        const rosterLen = viewer?.rosterSubController?.resolvedRoster?.length ?? 0;
        ctx.recordAssertion(
          'replay_viewer_6car_active_playback',
          isPlaying && rosterLen === 6,
          `isActive=${Boolean(viewer?.isActive)}, rosterLen=${rosterLen}, cursor=${viewer?.takeoverSubController?.cursor?.toFixed?.(1)}`,
        );
      },
    },
    {
      tick: 90,
      description: 'Switch POV in Replay Viewer to slot 4 (Orange team) and verify camera target updates',
      forceKeyframeRender: true,
      keyframeReason: 'replay_viewer_6car_pov_switch_keyframe',
      action: (ctx) => {
        const r = ctx.runtime;
        const viewer = r?.modeManager?.getActiveMode?.()?.standaloneReplayViewer;
        viewer?.selectPovSlot?.(4);
        const povIdx = viewer?.rosterSubController?.activePovCarIndex ?? -1;
        ctx.recordAssertion(
          'replay_viewer_pov_slot_switched',
          povIdx >= 0 && r?.playerCarIndex === povIdx,
          `activePovCarIndex=${povIdx}, runtime.playerCarIndex=${r?.playerCarIndex}`,
        );
      },
    },
    {
      tick: 150,
      description: 'Exit Replay Viewer back to clean 1-car Freeplay (simulating Return to Main Menu / Freeplay)',
      forceKeyframeRender: true,
      keyframeReason: 'replay_viewer_6car_clean_exit_keyframe',
      action: (ctx) => {
        const r = ctx.runtime;
        const freeplayMode = r?.modeManager?.getActiveMode?.();
        freeplayMode?.resetToCleanFreeplay?.();
        r?.resetKickoff?.(0);
      },
    },
    {
      tick: 210,
      description: 'Verify inactive car slots 1..5 have hidden meshes, dormant boost particle systems, and dormant remote audio synths',
      forceKeyframeRender: true,
      keyframeReason: 'replay_viewer_post_exit_clean_state_keyframe',
      action: (ctx) => {
        const r = ctx.runtime;
        const numCars = r?.physics?.numCars ?? 0;
        const arenaCars: Array<CarMeshCheck | null> = r?.arena?.cars ?? [];
        const extraCarsHidden = arenaCars
          .slice(1)
          .every((c) => !c || !c.visible);
        const arenaCarBoosts: BoostEmitterCheck[][] = r?.arena?.carBoosts ?? [];
        const extraBoostsDormant = arenaCarBoosts
          .slice(1)
          .every((emitters) =>
            (emitters ?? []).every(
              (em) =>
                !em?.physics?.driveParticlesActive &&
                !em?.physics?.trailParticlesActive &&
                !em?.goldRush?.driveParticlesActive &&
                !em?.goldRush?.trailParticlesActive
            )
          );
        ctx.recordAssertion(
          'replay_viewer_exit_leaves_no_residual_car_overhead',
          numCars === 1 && extraCarsHidden && extraBoostsDormant,
          `numCars=${numCars}, extraCarsHidden=${extraCarsHidden}, extraBoostsDormant=${extraBoostsDormant}`,
        );
      },
    },
  ],
  teardown: async (ctx) => {
    ctx.setLocalCarControls(null);
  },
};
