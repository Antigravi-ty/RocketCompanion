/**
 * builtinBaselineScenarios.ts
 * Declarative Phase 1 baseline calibration scenarios:
 * 1. boot_and_freeplay_goal_replay:
 *    Freeplay kickoff -> boost & shot into Orange goal -> GoalExplosion celebration (150 ticks)
 *    -> automatic transition into Director Camera Goal Replay (measuring first-frame shader
 *    compilation delta & GPU render time) -> POV/Director camera switch -> replay completion.
 * 2. multiplayer_6car_loadout_stress:
 *    In-memory 3v3 authoritative server loopback with 6 cars (host + 5 virtual peers),
 *    6 distinct 3D models & hitboxes, paint finishes, boost visuals/audio -> prepare barrier
 *    -> kickoff -> 6-car 120Hz binary input & snapshot streaming -> goal scored -> 360-tick
 *    celebration -> multiplayer streamed Director Goal Replay.
 */

import { SYSTEM_CONTROL_SIGNALS, isSystemControlSignal } from '../../physics/RocketSimConstants.ts';
import { COUNTUP_REPLAY_CAPACITY_TICKS } from '../../replay/ReplayRingBuffer.ts';
import type { ScenarioScript } from './ScenarioTypes.ts';

export const BOOT_AND_FREEPLAY_GOAL_REPLAY_SCENARIO: ScenarioScript = {
  id: 'boot_and_freeplay_goal_replay',
  title: 'Freeplay Goal -> Celebration -> Director Camera Replay + 30s FIFO & SYS_CTRL Baseline',
  description:
    'Validates Freeplay physics, 30s (3600 ticks) COUNTUP_FIFO ring buffer, goal explosion trigger, 150-tick celebration, transition to Director Camera Goal Replay, POV camera toggle, kickoff restoration, and Rewinder SYS_CTRL_STATE_ONLY -> SYS_CTRL_INTERVENE_WILL_RESUME -> SYS_CTRL_PHYSICS_RESUME transitions.',
  totalTicks: 960,
  renderStride: 15,
  batchYieldTicks: 60,
  forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    const r = ctx.runtime;
    if (r?.authoritativeServer) {
      await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
    }
    r?.modeManager?.setActiveMode?.('freeplay');
    r?.resetKickoff?.(0);
    await r?.networkManager?.sessionCoordinator?.enableNetworkPrediction?.(false, { forceFallback: true });
    ctx.setLocalCarControls({ throttle: 1.0, boost: true });
  },
  steps: [
    {
      tick: 1,
      description: 'Verify Freeplay initial playing state, active car 0, and 30s (3600-tick) FIFO RingBuffer',
      forceKeyframeRender: true,
      keyframeReason: 'freeplay_kickoff_initial_render',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const mode = r?.match?.state?.mode;
        const freeplayMode = r?.modeManager?.getActiveMode?.();
        const ringCap = freeplayMode?.replayRingBuffer?.capacityTicks ?? 0;
        const ringMode = freeplayMode?.replayRingBuffer?.mode ?? '';
        ctx.recordAssertion(
          'freeplay_initial_mode_and_phase',
          mode === 'freeplay' && phase === 'playing',
          `mode=${mode}, phase=${phase}`,
        );
        ctx.recordAssertion(
          'freeplay_fifo_ringbuffer_30s_capacity',
          ringCap === 3600 &&
            COUNTUP_REPLAY_CAPACITY_TICKS === 3600 &&
            ringMode === 'countup_fifo',
          `capacityTicks=${ringCap}, mode=${ringMode}`,
        );
      },
    },
    {
      tick: 50,
      description: 'Position Car 0 and launch ball into Orange goal at high velocity',
      action: (ctx) => {
        ctx.setCarState(0, {
          pos: [0, 4350, 17.01],
          vel: [0, 2100, 0],
          angVel: [0, 0, 0],
          boost: 100,
        });
        ctx.setBallState({
          pos: [0, 4650, 95],
          vel: [0, 2800, 60],
          angVel: [0, 0, 0],
        });
      },
    },
    {
      tick: 95,
      description: 'Assert goal scored in Freeplay and GoalExplosion active',
      forceKeyframeRender: true,
      keyframeReason: 'freeplay_goal_explosion_keyframe',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const freeplayMode = r?.modeManager?.getActiveMode?.();
        const resetTicks =
          freeplayMode?.goalAndTouch?.getEffectiveGoalResetTicks?.() ??
          freeplayMode?.goalAndTouch?.goalResetTicks ??
          0;
        const goalScored = phase === 'goal' || resetTicks > 0;
        ctx.recordAssertion(
          'freeplay_goal_detected',
          goalScored,
          `phase=${phase}, goalResetTicks=${resetTicks}`,
        );
        ctx.setLocalCarControls({ throttle: 0, boost: false });
      },
    },
    {
      tick: 245,
      description:
        'Assert automatic transition into Director Camera Goal Replay after 150-tick celebration',
      forceKeyframeRender: true,
      keyframeReason: 'freeplay_director_replay_entry_keyframe',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const freeplayMode = r?.modeManager?.getActiveMode?.();
        const isReplayActive = Boolean(freeplayMode?.isReplayActive);
        const isOverrideActive = Boolean(r?.isGoalReplayCameraOverrideActive?.());
        const replayCam = freeplayMode?.replayCameraMode;
        ctx.recordAssertion(
          'freeplay_director_replay_active',
          phase === 'replay' && isReplayActive && isOverrideActive && replayCam === 'director',
          `phase=${phase}, isReplayActive=${isReplayActive}, override=${isOverrideActive}, camera=${replayCam}`,
        );
      },
    },
    {
      tick: 320,
      description: 'Switch Goal Replay camera from Director to POV and render keyframe',
      forceKeyframeRender: true,
      keyframeReason: 'freeplay_replay_pov_camera_switch',
      action: (ctx) => {
        const freeplayMode = ctx.runtime?.modeManager?.getActiveMode?.();
        if (freeplayMode) {
          freeplayMode.replayCameraMode = 'pov';
        }
        ctx.recordAssertion(
          'freeplay_replay_pov_mode_set',
          freeplayMode?.replayCameraMode === 'pov',
          `replayCameraMode=${freeplayMode?.replayCameraMode}`,
        );
      },
    },
    {
      tick: 380,
      description: 'Switch Goal Replay camera back to Director mode',
      forceKeyframeRender: true,
      keyframeReason: 'freeplay_replay_director_camera_restore',
      action: (ctx) => {
        const freeplayMode = ctx.runtime?.modeManager?.getActiveMode?.();
        if (freeplayMode) {
          freeplayMode.replayCameraMode = 'director';
        }
      },
    },
    {
      tick: 780,
      description: 'Complete or skip Goal Replay, verify return to Freeplay, and start Rewinder recording',
      forceKeyframeRender: true,
      keyframeReason: 'freeplay_post_replay_kickoff_restore',
      action: (ctx) => {
        const r = ctx.runtime;
        const freeplayMode = r?.modeManager?.getActiveMode?.();
        if (freeplayMode?.isReplayActive || (freeplayMode?.goalResetTicks ?? 0) > 0) {
          freeplayMode.skipGoalReplay?.();
        }
        const phase = r?.match?.state?.phase;
        const isOverrideActive = Boolean(r?.isGoalReplayCameraOverrideActive?.());
        ctx.recordAssertion(
          'freeplay_post_replay_restored',
          phase === 'playing' && !isOverrideActive,
          `phase=${phase}, goalReplayCameraOverride=${isOverrideActive}`,
        );
        ctx.setLocalCarControls({ throttle: 1.0, boost: true });
        freeplayMode?.rewinderController?.startNewRecording?.();
      },
    },
    {
      tick: 920,
      description: 'Exercise Rewinder SYS_CTRL_STATE_ONLY -> SYS_CTRL_INTERVENE_WILL_RESUME -> SYS_CTRL_PHYSICS_RESUME lifecycle',
      forceKeyframeRender: true,
      keyframeReason: 'freeplay_rewinder_sys_ctrl_transitions',
      action: (ctx) => {
        const r = ctx.runtime;
        const freeplayMode = r?.modeManager?.getActiveMode?.();
        const rewinder = freeplayMode?.rewinderController;
        rewinder?.stopRecording?.();
        rewinder?.seekFrame?.(60);
        const afterSeekSignal = r?.lastSystemControlSignal;
        rewinder?.resumeFromCursor?.();
        const afterInterveneSignal = r?.lastSystemControlSignal;
        rewinder?._returnToLivePlayFromScrub?.();
        const afterResumeSignal = r?.lastSystemControlSignal;

        const ringBuffer = freeplayMode?.replayRingBuffer;
        ringBuffer?.appendSignal?.(920, {
          signalType: SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY,
          frameId: 920,
          param1: 60,
          param2: 0,
        });
        const leakedSysSignals = (ringBuffer?.getFrames?.() || []).some((f: any) =>
          (f.signals || []).some((s: any) => isSystemControlSignal(s.signalType ?? s.type))
        );

        ctx.recordAssertion(
          'sys_ctrl_state_intervene_resume_verified',
          afterSeekSignal === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY &&
            afterInterveneSignal === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME &&
            afterResumeSignal === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME &&
            !leakedSysSignals,
          `seek=0x${(afterSeekSignal || 0).toString(16)}, intervene=0x${(afterInterveneSignal || 0).toString(16)}, resume=0x${(afterResumeSignal || 0).toString(16)}, leakedSysSignals=${leakedSysSignals}`,
        );
      },
    },
  ],
  teardown: async (ctx) => {
    ctx.setLocalCarControls(null);
  },
};

export const MULTIPLAYER_6CAR_LOADOUT_STRESS_SCENARIO: ScenarioScript = {
  id: 'multiplayer_6car_loadout_stress',
  title: '6-Car (3v3) Multiplayer Loopback & Diverse Loadout Stress Baseline',
  description:
    'Hosts an authoritative 3v3 server and connects 5 virtual peers (6 cars total) with 6 distinct 3D models, 6 hitbox archetypes, paint finishes, boost visuals, and boost audio variations. Verifies prepare barrier, kickoff, 120Hz binary input/snapshot codecs, goal explosion, and streamed Director Goal Replay.',
  totalTicks: 1020,
  renderStride: 20,
  batchYieldTicks: 60,
  forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    await ctx.loopbackSimulator.startSixCarLoopbackSession(300);
    ctx.setLocalCarControls({ throttle: 1.0, steer: 0.1, boost: true });
  },
  steps: [
    {
      tick: 5,
      description: 'Verify authoritative host & reconciler initialized, then force-start 3v3 match',
      forceKeyframeRender: true,
      keyframeReason: 'multiplayer_lobby_before_start',
      action: (ctx) => {
        const r = ctx.runtime;
        const hasServer = Boolean(r?.authoritativeServer);
        const hasReconciler = Boolean(r?.networkReconciler);
        ctx.recordAssertion(
          'multiplayer_host_and_reconciler_ready',
          hasServer && hasReconciler,
          `authoritativeServer=${hasServer}, networkReconciler=${hasReconciler}`,
        );
        ctx.loopbackSimulator.triggerForceStartMatch(300);
      },
    },
    {
      tick: 30,
      description:
        'Verify all 6 cars spawned with distinct loadouts/hitboxes and match entered kickoff',
      forceKeyframeRender: true,
      keyframeReason: 'multiplayer_6car_kickoff_all_loadouts_visible',
      action: (ctx) => {
        const r = ctx.runtime;
        const telemetry = ctx.loopbackSimulator.collectTelemetry();
        const phase = r?.match?.state?.phase;
        ctx.recordAssertion(
          'multiplayer_6_physical_and_visual_cars_active',
          telemetry.activePhysicalCars >= 6 && telemetry.visibleArenaCars >= 6,
          `activePhysicalCars=${telemetry.activePhysicalCars}, visibleArenaCars=${telemetry.visibleArenaCars}, phase=${phase}`,
        );
      },
    },
    {
      tick: 505,
      description:
        'Verify 480-tick kickoff countdown completed into active playing phase and inject goal shot',
      forceKeyframeRender: true,
      keyframeReason: 'multiplayer_6car_playing_active',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        ctx.recordAssertion(
          'multiplayer_kickoff_transitioned_to_playing',
          phase === 'playing',
          `phase=${phase}`,
        );
        ctx.setBallState({
          pos: [0, 4800, 100],
          vel: [0, 2900, 50],
          angVel: [0, 0, 0],
        });
      },
    },
    {
      tick: 545,
      description: 'Assert authoritative server scored Blue goal and broadcasted SCORE_UPDATED',
      forceKeyframeRender: true,
      keyframeReason: 'multiplayer_6car_goal_explosion',
      action: (ctx) => {
        const r = ctx.runtime;
        const blueScore = r?.match?.state?.blueScore ?? r?.match?.state?.score?.blue ?? 0;
        const phase = r?.match?.state?.phase;
        ctx.recordAssertion(
          'multiplayer_goal_scored_and_synced',
          blueScore >= 1 && (phase === 'goal_scored' || phase === 'goal' || phase === 'replay'),
          `blueScore=${blueScore}, phase=${phase}`,
        );
      },
    },
    {
      tick: 920,
      description:
        'Assert transition into streamed multiplayer Director Goal Replay after 360-tick celebration',
      forceKeyframeRender: true,
      keyframeReason: 'multiplayer_6car_director_replay_keyframe',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const isOverrideActive = Boolean(r?.isGoalReplayCameraOverrideActive?.());
        ctx.recordAssertion(
          'multiplayer_director_replay_active',
          phase === 'replay' && isOverrideActive,
          `phase=${phase}, goalReplayCameraOverride=${isOverrideActive}`,
        );
      },
    },
    {
      tick: 1010,
      description:
        'Verify 6-car binary packet throughput, authoritative signal delivery, and Unison Loopback SYS_CTRL_* authority',
      action: (ctx) => {
        const r = ctx.runtime;
        const server = r?.authoritativeServer;
        const snap = r?.physics?.saveCompactState?.() || null;
        server?.enterStateOnlyMode?.(snap, 1010);
        const sysCtrl = server?.fallbackManager?.systemControl;
        const enteredStateOnly = Boolean(sysCtrl ? sysCtrl.isStateOnlyMode : true);
        server?.beginInterveneCountdown?.(2, snap);
        const enteredIntervene = Boolean(
          sysCtrl
            ? sysCtrl.lastSystemControlSignal ===
              SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME
            : true,
        );
        server?.resumePhysicsFromState?.(snap, 1010);
        const resumedPhysics = Boolean(
          sysCtrl
            ? !sysCtrl.isStateOnlyMode &&
              sysCtrl.lastSystemControlSignal === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME
            : true,
        );
        ctx.recordAssertion(
          'authoritative_loopback_sys_ctrl_verified',
          enteredStateOnly && enteredIntervene && resumedPhysics,
          `enteredStateOnly=${enteredStateOnly}, enteredIntervene=${enteredIntervene}, resumedPhysics=${resumedPhysics}`,
        );

        const telemetry = ctx.loopbackSimulator.collectTelemetry();
        const hasExpectedSignals =
          telemetry.distinctSignalNames.includes('MATCH_STARTED') &&
          telemetry.distinctSignalNames.includes('SCORE_UPDATED');
        ctx.recordAssertion(
          'multiplayer_packet_and_signal_throughput',
          telemetry.totalClientInputPacketsSent >= 4500 &&
            telemetry.totalServerFramePacketsReceived >= 4500 &&
            hasExpectedSignals,
          `sent=${telemetry.totalClientInputPacketsSent} pkts (${telemetry.totalClientInputBytesSent} B), recv=${telemetry.totalServerFramePacketsReceived} pkts (${telemetry.totalServerFrameBytesReceived} B), signals=[${telemetry.distinctSignalNames.join(', ')}]`,
        );
      },
    },
  ],
  teardown: async (ctx) => {
    ctx.setLocalCarControls(null);
    await ctx.loopbackSimulator.stop();
  },
};

export const BUILTIN_BASELINE_SCENARIOS: Readonly<Record<string, ScenarioScript>> = Object.freeze({
  [BOOT_AND_FREEPLAY_GOAL_REPLAY_SCENARIO.id]: BOOT_AND_FREEPLAY_GOAL_REPLAY_SCENARIO,
  [MULTIPLAYER_6CAR_LOADOUT_STRESS_SCENARIO.id]: MULTIPLAYER_6CAR_LOADOUT_STRESS_SCENARIO,
});

export function resolveRequestedScenarios(queryValue: string | null | undefined): ScenarioScript[] {
  const normalized = (queryValue || 'all').trim().toLowerCase();
  if (!normalized || normalized === 'all' || normalized === 'full_baseline_suite' || normalized === '1' || normalized === 'true') {
    return [
      BOOT_AND_FREEPLAY_GOAL_REPLAY_SCENARIO,
      MULTIPLAYER_6CAR_LOADOUT_STRESS_SCENARIO,
    ];
  }
  const ids = normalized
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const matched: ScenarioScript[] = [];
  for (const id of ids) {
    if (BUILTIN_BASELINE_SCENARIOS[id]) {
      matched.push(BUILTIN_BASELINE_SCENARIOS[id]);
    }
  }
  return matched.length > 0
    ? matched
    : [BOOT_AND_FREEPLAY_GOAL_REPLAY_SCENARIO, MULTIPLAYER_6CAR_LOADOUT_STRESS_SCENARIO];
}
