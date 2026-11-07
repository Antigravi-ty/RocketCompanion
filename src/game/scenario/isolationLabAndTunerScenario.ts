/**
 * isolationLabAndTunerScenario.ts
 * Automated scenario script for Branch A (Entity/Suspension/Tuner Calibration & Sandboxes).
 */

import { HITBOX_PRESETS } from '../../ui-core/config/vehiclePresets';
import { FENNEC_DESCRIPTOR, getVehicleDescriptor } from '../../ui-core/config/vehicleTunerConfig';
import {
  useExperimentalMultiBotsStore,
  useRewinderStore,
  useSubsystemIsolationLabStore,
} from '../runtimeUiPort.ts';
import type { ScenarioScript, ScenarioStepContext } from './ScenarioTypes.ts';

interface ScenarioWheelRigLike {
  steer?: { position?: { x: number; y: number; z: number } };
}

interface ScenarioArenaExtendedPort {
  carTeams?: number[];
  carWheels?: Array<ScenarioWheelRigLike[] | null>;
  isThrowbackStadiumActive?: boolean;
  environment?: {
    setThrowbackStadiumActive?: (enabled: boolean, showCollision?: boolean) => Promise<void>;
  } | null;
  swapCarVisual?: (carIndex: number, visual: string) => boolean;
  refreshCustomVehicle?: (vehicleId?: string) => void;
  setCarTeam?: (carIndex: number, teamIndex: number) => void;
}

interface ScenarioMatchPortHost {
  matchPort?: {
    startDevTestLab?: () => void;
    startExpMultiBots?: () => void;
    returnToFreeplay?: (unlimitedBoost?: boolean) => void;
  };
}

const eq = (a: number | undefined, b: number, eps = 0.05): boolean =>
  typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= eps;

function verifyGoldenDescriptorsAndRig(ctx: ScenarioStepContext): void {
  const f = FENNEC_DESCRIPTOR;
  const fWheelsOk =
    eq(f.wheelAnchors?.[0]?.[0], 48.55) && eq(f.wheelAnchors?.[0]?.[1], 26.9291) &&
    eq(f.wheelAnchors?.[0]?.[2], 12.5) && eq(f.wheelAnchors?.[2]?.[0], -36.68) &&
    eq(f.wheelAnchors?.[2]?.[1], 28.6221) && eq(f.wheelAnchors?.[2]?.[2], 15.0);
  const fSusOk =
    eq(f.suspensionHeights?.[0], -4.5) && eq(f.suspensionHeights?.[1], -4.5) &&
    eq(f.suspensionHeights?.[2], -2.0) && eq(f.suspensionHeights?.[3], -2.0);
  const fBoostOk =
    eq(f.boostOutlets?.[0]?.[0], -57.97) && eq(f.boostOutlets?.[0]?.[1], 10.57) &&
    eq(f.boostOutlets?.[0]?.[2], 19.62) && eq(f.boostNozzleParams?.x, -57.87) &&
    eq(f.boostNozzleParams?.y, 8.97) && eq(f.boostNozzleParams?.z, 19.62);
  const fColorsOk =
    f.colors?.default?.primary === 16734742 &&
    f.colors?.default?.realisticPrimary === 16555020 &&
    f.colors?.default?.pearl === 16724660;

  ctx.recordAssertion(
    'fennec_descriptor_golden_calibration',
    Boolean(fWheelsOk && fSusOk && fBoostOk && fColorsOk),
    `wheels=${fWheelsOk}, sus=${fSusOk}, boost=${fBoostOk}, colors=${fColorsOk}`,
  );

  const ins = getVehicleDescriptor('insidio');
  const ryza = getVehicleDescriptor('ryza');
  const insOk =
    ins?.hitboxPreset === 'hitbox-hybrid' &&
    eq(ins?.wheelAnchors?.[0]?.[0], 48.8139) && eq(ins?.suspensionHeights?.[0], -4.5);
  const ryzaOk =
    ryza?.hitboxPreset === 'hitbox-octane' &&
    eq(ryza?.wheelAnchors?.[0]?.[0], 50.25) && eq(ryza?.suspensionHeights?.[0], -4.5);
  const hitboxesOk =
    Object.keys(HITBOX_PRESETS).length === 6 &&
    eq(HITBOX_PRESETS['hitbox-octane']?.length, 120.507) &&
    eq(HITBOX_PRESETS['hitbox-dominus']?.length, 130.427) &&
    eq(HITBOX_PRESETS['hitbox-plank']?.length, 131.32) &&
    eq(HITBOX_PRESETS['hitbox-breakout']?.length, 133.992) &&
    eq(HITBOX_PRESETS['hitbox-hybrid']?.length, 129.519) &&
    eq(HITBOX_PRESETS['hitbox-merc']?.length, 123.22);

  ctx.recordAssertion(
    'insidio_ryza_and_6_hitboxes_golden',
    Boolean(insOk && ryzaOk && hitboxesOk),
    `insidio=${insOk}, ryza=${ryzaOk}, hitboxes=${hitboxesOk}`,
  );

  const arena = ctx.runtime.arena as unknown as ScenarioArenaExtendedPort | null;
  arena?.swapCarVisual?.(0, 'fennec');
  arena?.refreshCustomVehicle?.('fennec');
  arena?.setCarTeam?.(0, 0);

  const carTeamsBound = Array.isArray(arena?.carTeams) && arena?.carTeams[0] === 0;
  const wheels0 = arena?.carWheels?.[0];
  const steerFr = wheels0?.[0]?.steer?.position;
  const steerRr = wheels0?.[2]?.steer?.position;
  const rigWheelsOk =
    Boolean(steerFr && steerRr) &&
    eq(steerFr?.x, 48.55, 0.2) && eq(steerFr?.z, 26.9291, 0.2) &&
    eq(steerRr?.x, -36.68, 0.2) && eq(steerRr?.z, 28.6221, 0.2);

  const swappedInsidio = Boolean(arena?.swapCarVisual?.(0, 'insidio'));
  const insidioSteerX = arena?.carWheels?.[0]?.[0]?.steer?.position?.x;
  const swappedBackFennec = Boolean(arena?.swapCarVisual?.(0, 'fennec'));

  ctx.recordAssertion(
    'arena_rig_geometry_and_car_teams_bound',
    Boolean(carTeamsBound && rigWheelsOk && swappedInsidio && eq(insidioSteerX, 48.8139, 0.2) && swappedBackFennec),
    `carTeams=${carTeamsBound}, rigWheels=${rigWheelsOk}, insidioX=${insidioSteerX?.toFixed?.(2)}`,
  );
}

export const ISOLATION_LAB_AND_TUNER_SCENARIO: ScenarioScript = {
  id: 'isolation_lab_and_tuner_baseline',
  title: 'Vehicle Tuner Golden Calibration + 7 Isolation Lab Tabs + Experimental Multi-Bots',
  description:
    'Verifies 65f1538d golden calibration for Fennec/Insidio/Ryza/Hitboxes and live ArenaWorld rig geometry, steps through all 7 SubsystemIsolationLabMode tabs, and exercises ExperimentalMultiBotsMode.',
  totalTicks: 900,
  renderStride: 20,
  batchYieldTicks: 60,
  forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    const r = ctx.runtime;
    if (r?.authoritativeServer || r?.networkReconciler) {
      await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
    }
    useSubsystemIsolationLabStore.setState({ activeTab: 'probes', selectedTab: 'probes', probesEnabled: true });
    (r as unknown as ScenarioMatchPortHost)?.matchPort?.startDevTestLab?.();
  },
  steps: [
    {
      tick: 5,
      description: 'Verify golden descriptors, Arena rig geometry, and Throwback toggle',
      forceKeyframeRender: true,
      keyframeReason: 'tuner_and_rig_calibration_check',
      action: async (ctx) => {
        verifyGoldenDescriptorsAndRig(ctx);
        const arena = ctx.runtime.arena as unknown as ScenarioArenaExtendedPort | null;
        if (arena?.environment?.setThrowbackStadiumActive) {
          await arena.environment.setThrowbackStadiumActive(true, false);
          const on = Boolean(arena.isThrowbackStadiumActive);
          await arena.environment.setThrowbackStadiumActive(false, false);
          const off = !arena.isThrowbackStadiumActive;
          ctx.recordAssertion('arena_throwback_and_driftwoods_toggle', on && off, `on=${on}, off=${off}`);
        }
      },
    },
    {
      tick: 80,
      description: 'Tab 1 (Probes): Verify Car 6 Boost Hover and Car 7 Q/E Air Roll kinematics',
      forceKeyframeRender: true,
      keyframeReason: 'isolation_lab_tab1_probes',
      action: (ctx) => {
        const s = useSubsystemIsolationLabStore.getState();
        const c6 = ctx.runtime.physics?.getCarStateView?.(6);
        const c7 = ctx.runtime.physics?.getCarStateView?.(7);
        const validPhase = ['CLIMB_TO_PEAK', 'FALL_BELOW_BASE', 'RECOVER_AND_HOLD'].includes(s.probeBoostPhase);
        const coordsOk =
          Boolean(c6 && c7) && eq(c6?.posX, -2500, 15) && eq(c6?.posY, -400, 15) &&
          eq(c7?.posX, -2500, 15) && eq(c7?.posY, 400, 15) && (c6?.posZ ?? 0) > 500;
        ctx.recordAssertion('lab_tab1_probes_kinematics_active', Boolean(s.activeTab === 'probes' && validPhase && coordsOk), `tab=${s.activeTab}, phase=${s.probeBoostPhase}, c6Z=${c6?.posZ?.toFixed?.(1)}`);
      },
    },
    {
      tick: 90,
      description: 'Tab 2 (Multi-Ghost): Activate multi-ghost tab',
      action: () => useSubsystemIsolationLabStore.getState().setActiveTab('multi-ghost'),
    },
    {
      tick: 150,
      description: 'Tab 2 (Multi-Ghost): Verify parallel ghost worlds and switchActiveWorld',
      forceKeyframeRender: true,
      keyframeReason: 'isolation_lab_tab2_multi_ghost',
      action: (ctx) => {
        const store = useSubsystemIsolationLabStore.getState();
        store.switchActiveWorld();
        const idx = useSubsystemIsolationLabStore.getState().activeWorldIndex;
        ctx.recordAssertion('lab_tab2_multi_ghost_world_switch', store.activeTab === 'multi-ghost' && idx === 1, `tab=${store.activeTab}, idx=${idx}`);
      },
    },
    {
      tick: 160,
      description: 'Tab 3 (State-Replay): Activate state-replay tab and start recording',
      action: (ctx) => {
        useSubsystemIsolationLabStore.getState().setActiveTab('state-replay');
        useRewinderStore.getState().setRewinderDownCounterSec(0);
        useRewinderStore.getState().runtimeHandlers.onRewinderStartRecording?.();
        ctx.setLocalCarControls({ throttle: 1.0, boost: true });
      },
    },
    {
      tick: 300,
      description: 'Tab 3 (State-Replay): Pause recording, seek frame, and trigger preroll',
      forceKeyframeRender: true,
      keyframeReason: 'isolation_lab_tab3_state_replay_scrub',
      action: (ctx) => {
        const rw = useRewinderStore.getState();
        rw.runtimeHandlers.onRewinderStopRecording?.();
        const rec = useRewinderStore.getState().rewinderRecordedFrames;
        rw.runtimeHandlers.onRewinderSeekFrame?.(130);
        const seek = useRewinderStore.getState().rewinderState;
        rw.runtimeHandlers.onRewinderResumeFromHere?.();
        const pre = useRewinderStore.getState().rewinderState;
        ctx.recordAssertion('lab_tab3_state_replay_record_seek_preroll', rec >= 130 && seek === 'paused-scrub' && pre === 'preroll-countdown', `rec=${rec}, seek=${seek}, preroll=${pre}`);
      },
    },
    {
      tick: 320,
      description: 'Tab 4 (90s-Match): Activate 90s-match tab and start stationary match',
      action: () => {
        const s = useSubsystemIsolationLabStore.getState();
        s.setActiveTab('90s-match');
        s.runtimeHandlers.onStartIncidentMatch?.('stationary');
      },
    },
    {
      tick: 360,
      description: 'Tab 4 (90s-Match): Trigger score_blue action and verify incident state',
      forceKeyframeRender: true,
      keyframeReason: 'isolation_lab_tab4_90s_match',
      action: (ctx) => {
        const store = useSubsystemIsolationLabStore.getState();
        store.runtimeHandlers.onTriggerIncidentAction?.('score_blue');
        const phys = ctx.runtime.physics as unknown as { getBallStateView?: () => { posY: number } | null } | null;
        const bView = phys?.getBallStateView?.();
        ctx.recordAssertion('lab_tab4_90s_match_active_and_shot_launched', Boolean(store.incidentMatchActive && bView && bView.posY > 4500), `active=${store.incidentMatchActive}, ballY=${bView?.posY?.toFixed?.(1)}`);
      },
    },
    {
      tick: 390,
      description: 'Tab 5 (Goal-Replay): Activate goal-replay tab and trigger instant_kickoff_goal',
      action: () => {
        const store = useSubsystemIsolationLabStore.getState();
        store.setGoalReplayPostGoalSec(0);
        store.setActiveTab('goal-replay');
        store.runtimeHandlers.onGoalReplayTriggerScenario?.('instant_kickoff_goal');
      },
    },
    {
      tick: 435,
      description: 'Tab 5 (Goal-Replay): Verify goal replay playback active and Podium entry/exit',
      forceKeyframeRender: true,
      keyframeReason: 'isolation_lab_tab5_goal_replay_and_podium',
      action: (ctx) => {
        const store = useSubsystemIsolationLabStore.getState();
        const phase = store.goalReplayPhase;
        store.runtimeHandlers.onEnterPodiumTest?.(0);
        const podiumIn = useSubsystemIsolationLabStore.getState().podiumActive;
        store.runtimeHandlers.onExitPodiumTest?.();
        const podiumOut = !useSubsystemIsolationLabStore.getState().podiumActive;
        ctx.recordAssertion('lab_tab5_goal_replay_and_podium_verified', (phase === 'replaying' || phase === 'post-goal-delay') && podiumIn && podiumOut, `phase=${phase}, in=${podiumIn}, out=${podiumOut}`);
      },
    },
    {
      tick: 450,
      description: 'Tab 6 (Kickoff-Duel): Activate kickoff-duel tab and start episode on Slot 0',
      action: () => {
        const store = useSubsystemIsolationLabStore.getState();
        store.setActiveTab('kickoff-duel');
        store.runtimeHandlers.onKickoffDuelRestart?.(0);
      },
    },
    {
      tick: 530,
      description: 'Tab 6 (Kickoff-Duel): Verify dual kickoff agents step and approach the ball',
      forceKeyframeRender: true,
      keyframeReason: 'isolation_lab_tab6_kickoff_duel',
      action: (ctx) => {
        const s = useSubsystemIsolationLabStore.getState();
        const ok = s.kickoffDuelCurrentTick >= 40 && s.kickoffDuelBlueDist < 4600;
        ctx.recordAssertion('lab_tab6_kickoff_duel_progression', s.activeTab === 'kickoff-duel' && ok, `tick=${s.kickoffDuelCurrentTick}, dist=${s.kickoffDuelBlueDist}`);
      },
    },
    {
      tick: 540,
      description: 'Tab 7 (Demolish-Respawn): Activate demolish-respawn, demolish, and select Slot 2',
      action: () => {
        const store = useSubsystemIsolationLabStore.getState();
        store.setActiveTab('demolish-respawn');
        store.triggerDemolishNow();
        store.selectDemolishRespawnSlot(2);
      },
    },
    {
      tick: 575,
      description: 'Tab 7 (Demolish-Respawn): Verify demolished state, ghost wheel Y, and respawn',
      forceKeyframeRender: true,
      keyframeReason: 'isolation_lab_tab7_demolish_respawn',
      action: (ctx) => {
        const store = useSubsystemIsolationLabStore.getState();
        const demo = store.demolishRespawnIsDemolished;
        const slot = store.demolishRespawnSelectedSlot;
        const wheelYs = store.demolishRespawnWheelLocalY;
        store.forceRespawnNow();
        ctx.recordAssertion('lab_tab7_demolish_respawn_and_ghost_wheels', demo && slot === 2 && Array.isArray(wheelYs) && wheelYs.length === 4, `demo=${demo}, slot=${slot}, wheels=[${wheelYs.join(',')}]`);
      },
    },
    {
      tick: 600,
      description: 'Switch to ExperimentalMultiBotsMode (exp-multi-bots) with 2v2 bots roster',
      action: async (ctx) => {
        const expStore = useExperimentalMultiBotsStore.getState();
        expStore.setDisableGoalReplay(true);
        expStore.applyPresetRoster('2v2-bots');
        expStore.setSlotBotType(0, 0, 'heuristic');
        expStore.setSlotBotType(0, 1, 'heuristic');
        expStore.setSlotBotType(1, 0, 'heuristic');
        expStore.setSlotBotType(1, 1, 'heuristic');
        (ctx.runtime as unknown as ScenarioMatchPortHost)?.matchPort?.startExpMultiBots?.();
        const activeMode = ctx.runtime.modeManager.getActiveMode() as unknown as {
          applyRosterAndStartMatch?: () => Promise<void>;
        };
        await activeMode?.applyRosterAndStartMatch?.();
      },
    },
    {
      tick: 640,
      description: 'Verify ExperimentalMultiBotsMode roster spawned 4 cars and trigger score_blue',
      forceKeyframeRender: true,
      keyframeReason: 'exp_multi_bots_active_roster',
      action: (ctx) => {
        const expStore = useExperimentalMultiBotsStore.getState();
        const n = expStore.spawnedCars.length;
        const active = expStore.matchActive;
        expStore.triggerSandboxAction('score_blue');
        ctx.recordAssertion('exp_multi_bots_roster_and_match_active', active && n === 4 && (ctx.runtime.physics?.numCars ?? 0) >= 4, `active=${active}, spawned=${n}, physCars=${ctx.runtime.physics?.numCars}`);
      },
    },
    {
      tick: 710,
      description: 'Verify ExperimentalMultiBotsMode scored Blue goal and updated score telemetry',
      forceKeyframeRender: true,
      keyframeReason: 'exp_multi_bots_goal_scored',
      action: (ctx) => {
        const expStore = useExperimentalMultiBotsStore.getState();
        ctx.recordAssertion('exp_multi_bots_blue_goal_recorded', expStore.blueScore >= 1, `blue=${expStore.blueScore}, orange=${expStore.orangeScore}`);
      },
    },
    {
      tick: 880,
      description: 'Return cleanly from ExperimentalMultiBotsMode to Freeplay baseline',
      forceKeyframeRender: true,
      keyframeReason: 'return_to_freeplay_after_sandboxes',
      action: (ctx) => {
        (ctx.runtime as unknown as ScenarioMatchPortHost)?.matchPort?.returnToFreeplay?.(true);
        const mode = ctx.runtime.match?.state?.mode;
        ctx.recordAssertion('sandbox_return_to_freeplay_clean', mode === 'freeplay', `mode=${mode}`);
      },
    },
  ],
  teardown: async (ctx) => {
    ctx.setLocalCarControls(null);
  },
};
