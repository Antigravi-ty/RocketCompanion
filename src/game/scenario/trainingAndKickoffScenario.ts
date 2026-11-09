/**
 * trainingAndKickoffScenario.ts
 * Automated scenario covering FreePlay, Static Training Pack (Mirror/Variation/Editor/Goal),
 * and Kickoff Training PPO (Ghost timeline, Same/Opposite, Easy-Learning, Solid Duel, Realistic).
 */

import { multiDiscreteToControls } from '../../ai/kickoffEpisodePrimitives.ts';
import type { KickoffTrainingMode } from '../modes/KickoffTrainingMode.ts';
import type { StaticTrainingPackMode } from '../modes/static-training/StaticTrainingPackMode.ts';
import { useKickoffTrainingStore, useStaticTrainingPackStore } from '../runtimeUiPort.ts';
import type { ScenarioRuntimePort, ScenarioScript, ScenarioStepContext } from './ScenarioTypes.ts';

interface TrainingRuntimeView extends ScenarioRuntimePort {
  matchPort?: {
    startStaticTrainingPack?(): void;
    startKickoffTraining?(): void;
    returnToFreeplay?(unlimitedBoost?: boolean): void;
  };
  modeManager: ScenarioRuntimePort['modeManager'] & { setMode?(mode: string): void };
}

const asRuntime = (ctx: ScenarioStepContext) => ctx.runtime as unknown as TrainingRuntimeView;
const getStaticMode = (ctx: ScenarioStepContext): StaticTrainingPackMode | null => {
  const m = ctx.runtime?.modeManager?.getActiveMode?.() as { id?: string } | undefined;
  return m?.id === 'static-training-pack' ? (m as unknown as StaticTrainingPackMode) : null;
};
const getKickoffMode = (ctx: ScenarioStepContext): KickoffTrainingMode | null => {
  const m = ctx.runtime?.modeManager?.getActiveMode?.() as { id?: string } | undefined;
  return m?.id === 'kickoff-training' ? (m as unknown as KickoffTrainingMode) : null;
};
const getStaticStore = () => useStaticTrainingPackStore.getState();
const getKickoffStore = () => useKickoffTrainingStore.getState();
const switchMode = (
  r: TrainingRuntimeView,
  mode: 'freeplay' | 'static-training-pack' | 'kickoff-training'
) => {
  if (mode === 'static-training-pack' && r.matchPort?.startStaticTrainingPack)
    return r.matchPort.startStaticTrainingPack();
  if (mode === 'kickoff-training' && r.matchPort?.startKickoffTraining)
    return r.matchPort.startKickoffTraining();
  if (mode === 'freeplay' && r.matchPort?.returnToFreeplay)
    return r.matchPort.returnToFreeplay(true);
  if (r.match?.state) r.match.state.mode = mode;
  r.modeManager?.setMode?.(mode);
  if (mode === 'freeplay') r.resetKickoff?.(0);
};
const kfStep = (
  tick: number,
  keyframeReason: string,
  description: string,
  action: (ctx: ScenarioStepContext) => void | Promise<void>
) => ({ tick, forceKeyframeRender: true, keyframeReason, description, action });

export const TRAINING_AND_KICKOFF_SCENARIO: ScenarioScript = {
  id: 'training_and_kickoff',
  title: 'FreePlay -> Static Training Pack -> Kickoff PPO & Ghost Trajectory',
  description:
    'Validates FreePlay, Static Training Pack (shot timer, mirror flip, Kevpert variation, goal reset, Editor FreeCam/trajectory), and Kickoff PPO SafeTensors with Ghost trajectory comparison.',
  totalTicks: 900,
  renderStride: 15,
  batchYieldTicks: 60,
  forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    const r = asRuntime(ctx);
    if (r?.authoritativeServer || r?.networkReconciler) {
      await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
    }
    switchMode(r, 'freeplay');
    await getStaticStore().initStore('normal');
    ctx.setLocalCarControls({ throttle: 1.0, boost: true });
  },
  steps: [
    kfStep(
      1,
      'training_suite_freeplay_entry',
      'Verify FreePlay single-player local authority and initial car/ball state',
      (ctx) => {
        const r = asRuntime(ctx);
        const mode = r?.match?.state?.mode;
        const single = !r?.authoritativeServer && !r?.networkReconciler;
        const n = r?.physics?.numCars ?? 0;
        ctx.recordAssertion(
          'freeplay_single_player_pipeline_active',
          mode === 'freeplay' && single && n === 1,
          `mode=${mode}, single=${single}, n=${n}`
        );
      }
    ),
    kfStep(
      20,
      'static_training_pack_mode_enter',
      'Transition into Static Training Pack mode and stage a shot',
      (ctx) => {
        const r = asRuntime(ctx);
        ctx.setLocalCarControls(null);
        const s = getStaticStore();
        s.setDownCounterEnabled(false);
        s.setShotMirrored(false);
        s.setVariationToggles({ enableCustomVariationOverride: false, enableFToMirror: true });
        switchMode(r, 'static-training-pack');
        const m = getStaticMode(ctx);
        const ok = Boolean(s.activePack && s.activePack.items.length > 0);
        ctx.recordAssertion(
          'static_training_pack_loaded_and_staged',
          r?.match?.state?.mode === 'static-training-pack' &&
            ok &&
            m?.playPhase === 'waiting-input',
          `mode=${r?.match?.state?.mode}, pack=${ok}, phase=${m?.playPhase}`
        );
      }
    ),
    kfStep(
      35,
      'static_training_mirror_shot_verified',
      'Verify Mirror Shot (enableFToMirror) reflects car and ball X across X=0',
      (ctx) => {
        const m = getStaticMode(ctx);
        const s = getStaticStore();
        const base = m?._getCurrentShotConfig();
        if (base && Math.abs(base.car.location?.[0] ?? 0) < 10) {
          base.car.location = [-850, -2200, 17.01];
          base.car.headingYaw = 1.25;
          base.ball.location = [420, 1200, 93.15];
        }
        m?.reloadCurrentShot();
        const cx0 = m?.stagedShot?.car?.location?.[0] ?? 0;
        const bx0 = m?.stagedShot?.ball?.location?.[0] ?? 0;
        s.toggleShotMirror();
        const mir = getStaticStore().isShotMirrored;
        const cx1 = m?.stagedShot?.car?.location?.[0] ?? 0;
        const bx1 = m?.stagedShot?.ball?.location?.[0] ?? 0;
        const ok =
          mir && Math.abs(cx1 + cx0) < 1e-2 && Math.abs(bx1 + bx0) < 1e-2 && Math.abs(cx0) > 10;
        ctx.recordAssertion(
          'static_training_mirror_shot_flipped',
          ok,
          `mir=${mir}, carX=${cx0.toFixed(1)}->${cx1.toFixed(1)}, ballX=${bx0.toFixed(1)}->${bx1.toFixed(1)}`
        );
        s.toggleShotMirror();
      }
    ),
    {
      tick: 50,
      description: 'Verify Kevpert variation preset & custom perturbation on shot reload',
      action: (ctx) => {
        const m = getStaticMode(ctx);
        const s = getStaticStore();
        s.applyKevpertVariationPreset('F3');
        s.setCustomVariation({
          ballLocationModifierXY: [0, 0],
          ballHeightModifierZ: [180, 180],
          boostLimitOverride: 42,
        });
        m?.reloadCurrentShot();
        const vShot = m?.stagedShot;
        const bz0 = m?._getCurrentShotConfig()?.ball?.location?.[2] ?? 93.15;
        const bz1 = vShot?.ball?.location?.[2] ?? 0;
        const boost = vShot?.car?.initialBoost ?? -1;
        ctx.recordAssertion(
          'static_training_kevpert_variation_applied',
          Math.abs(bz1 - (bz0 + 180)) < 1.0 && boost === 42 && vShot?.car?.unlimitedBoost === false,
          `baseZ=${bz0.toFixed(1)}, varZ=${bz1.toFixed(1)}, boost=${boost}`
        );
        s.setVariationToggles({ enableCustomVariationOverride: false });
        m?.reloadCurrentShot();
      },
    },
    kfStep(
      65,
      'static_training_editor_freecam_and_trajectory',
      'Verify Edit Mode, Editor FreeCam toggle, and trajectory preview',
      (ctx) => {
        const r = asRuntime(ctx);
        const m = getStaticMode(ctx);
        const s = getStaticStore();
        s.setSessionMode('edit');
        s.enterItemEditMode(s.currentShotIndex);
        s.setEditSubMode('car-heading');
        const camOvr = Boolean(
          r?.camera?.isEditorOverrideActive || r?.camera?.currentMode === 'editor'
        );
        s.setEditSubMode('free-cam');
        const freeCam = Boolean(r?.camera?.isFreeCam);
        m?.toggleFreeCamTrajectoryTest();
        const traj = Boolean(m?.isFreeCamTrajectoryTesting);
        ctx.recordAssertion(
          'static_training_editor_freecam_and_trajectory_active',
          camOvr && freeCam && traj,
          `camOvr=${camOvr}, freeCam=${freeCam}, traj=${traj}`
        );
      }
    ),
    {
      tick: 85,
      description: 'Stop trajectory test, return to Play mode, and launch shot',
      action: (ctx) => {
        const m = getStaticMode(ctx);
        m?.stopFreeCamTrajectoryTest();
        getStaticStore().setSessionMode('play');
        if (m?.stagedShot) {
          m.stagedShot.timeoutSeconds = 8;
          m.simulationController.setTimeoutSeconds(8);
        }
        ctx.setLocalCarControls({ throttle: 1.0, boost: true });
      },
    },
    {
      tick: 115,
      description: 'Verify shot launched into live phase, timer counting down, then inject goal',
      action: (ctx) => {
        const sc = getStaticMode(ctx)?.simulationController;
        const rem = sc?.remainingTimeoutTicks ?? 960;
        ctx.recordAssertion(
          'static_training_shot_launched_and_timer_counting',
          Boolean(sc?.playPhase === 'live' && rem < 960 && rem > 0),
          `phase=${sc?.playPhase}, rem=${rem}/960`
        );
        ctx.setBallState({ pos: [0, 4820, 95], vel: [0, 2900, 40], angVel: [0, 0, 0] });
      },
    },
    kfStep(
      155,
      'static_training_goal_and_reset_verified',
      'Verify goal scored in Static Training Pack, skip replay, and verify shot reset',
      (ctx) => {
        const m = getStaticMode(ctx);
        const sc = m?.simulationController;
        const goal =
          sc?.playPhase === 'goal' || (sc?.goalResetTicks ?? 0) > 0 || Boolean(m?.isReplayActive);
        ctx.setLocalCarControls(null);
        m?.skipGoalReplay();
        const resetOk = sc?.playPhase === 'waiting-input' && !m?.isReplayActive;
        ctx.recordAssertion(
          'static_training_goal_scored_and_reset_verified',
          Boolean(goal && resetOk),
          `goal=${goal}, postSkip=${sc?.playPhase}, replay=${m?.isReplayActive}`
        );
      }
    ),
    kfStep(
      180,
      'kickoff_training_mode_enter_and_ppo_ready',
      'Transition into Kickoff Training mode, await Ghost Sim + PPO weights, and verify timeline',
      async (ctx) => {
        const r = asRuntime(ctx);
        ctx.setLocalCarControls(null);
        switchMode(r, 'kickoff-training');
        const km = getKickoffMode(ctx);
        await km?.episodeController?.waitForReady?.();
        km?.selectSpawn(0);
        const ks = getKickoffStore();
        const stepsLen = ks.timeline?.steps?.length ?? 0;
        const barsLen = ks.timeline?.noteBars?.length ?? 0;
        const aiTouch = ks.aiTouchTick ?? -1;
        const gVis = Boolean(km?.ghostVisuals?.ghostCarRoot?.visible);
        ctx.recordAssertion(
          'kickoff_ppo_timeline_and_ghost_initialized',
          r?.match?.state?.mode === 'kickoff-training' &&
            stepsLen > 20 &&
            barsLen > 0 &&
            aiTouch > 50 &&
            gVis,
          `mode=${r?.match?.state?.mode}, steps=${stepsLen}, bars=${barsLen}, aiTouch=${aiTouch}, ghostVis=${gVis}`
        );
      }
    ),
    {
      tick: 190,
      description: 'Start Kickoff Training Instant episode with throttle + boost',
      action: (ctx) => {
        ctx.setLocalCarControls({ throttle: 1.0, boost: true });
      },
    },
    kfStep(
      445,
      'kickoff_ppo_ghost_trajectory_and_touch_verified',
      'Verify PPO Ghost touched ball and recorded trajectory points, then trigger player touch',
      (ctx) => {
        const km = getKickoffMode(ctx);
        const ks = getKickoffStore();
        const pts = km?.ghostVisuals?.ghostTrajectoryCount ?? 0;
        if (!ks.playerTouchTick) {
          ctx.setCarState(0, {
            pos: [0, -140, 17.01],
            vel: [0, 2200, 0],
            angVel: [0, 0, 0],
            boost: 50,
          });
          ctx.setBallState({ pos: [0, 0, 93.15], vel: [0, 650, 0], angVel: [0, 0, 0] });
        }
        ctx.recordAssertion(
          'kickoff_ppo_ghost_trajectory_and_episode_stepped',
          ks.episodeTick >= 240 && pts > 0,
          `epTick=${ks.episodeTick}, pts=${pts}, aiTouch=${ks.aiTouchTick}`
        );
      }
    ),
    {
      tick: 460,
      description:
        'Verify player touch delta vs PPO AI touch recorded, then switch to Easy-Learning',
      action: (ctx) => {
        const ks = getKickoffStore();
        const ok =
          typeof ks.playerTouchTick === 'number' &&
          ks.playerTouchTick > 0 &&
          typeof ks.lastDeltaTicks === 'number';
        ctx.recordAssertion(
          'kickoff_player_touch_delta_vs_ai_recorded',
          ok,
          `pTouch=${ks.playerTouchTick}, aiTouch=${ks.aiTouchTick}, delta=${ks.lastDeltaTicks}`
        );
        ctx.setLocalCarControls(null);
        ks.setGhostPlacement('opposite');
        ks.setSubMode('easy-learning');
      },
    },
    kfStep(
      470,
      'kickoff_easy_learning_mismatch_pause',
      'Verify Easy-Learning pauses on mismatch, then feed required PPO action for step 0',
      (ctx) => {
        const ks = getKickoffStore();
        ctx.recordAssertion(
          'kickoff_easy_learning_pauses_on_mismatch',
          String(ks.phase) === 'paused-mismatch' && !ks.isInputMatching,
          `phase=${ks.phase}, match=${ks.isInputMatching}, req=${ks.requiredKeyStr}`
        );
        const act = ks.timeline?.steps?.[0]?.action;
        ctx.setLocalCarControls(
          act ? multiDiscreteToControls(act) : { throttle: 1.0, boost: true }
        );
      }
    ),
    kfStep(
      473,
      'kickoff_solid_opponent_duel_mode',
      'Verify Easy-Learning resumed on matching input, then switch to Solid Opponent duel',
      (ctx) => {
        const r = asRuntime(ctx);
        const ks = getKickoffStore();
        ctx.recordAssertion(
          'kickoff_easy_learning_resumed_on_matching_input',
          ks.phase === 'running' && ks.episodeTick > 0,
          `phase=${ks.phase}, epTick=${ks.episodeTick}`
        );
        ks.setSubMode('instant');
        ks.setGhostPlacement('opposite');
        ks.setGhostModeEnabled(false);
        ks.setSpawnIndex(1);
        ctx.setLocalCarControls({ throttle: 1.0, boost: true });
        const n = r?.physics?.numCars ?? 0;
        const gVis = Boolean(getKickoffMode(ctx)?.ghostVisuals?.ghostCarRoot?.visible);
        ctx.recordAssertion(
          'kickoff_solid_physical_opponent_spawned',
          n >= 2 && !gVis,
          `n=${n}, ghostVis=${gVis}`
        );
      }
    ),
    kfStep(
      615,
      'kickoff_solid_opponent_ppo_driven_verified',
      'Verify Solid Opponent Car 1 visible and driven toward ball by PPO agent, then test Realistic countdown',
      (ctx) => {
        const r = asRuntime(ctx);
        const c0 = r?.physics?.getCarStateView?.(0);
        const c1 = r?.physics?.getCarStateView?.(1);
        const d0 = c0 ? Math.hypot(c0.posX, c0.posY) : 9999;
        const d1 = c1 ? Math.hypot(c1.posX, c1.posY) : 9999;
        const oppVis = Boolean(r?.arena?.cars?.[1]?.visible);
        ctx.recordAssertion(
          'kickoff_solid_ppo_agent_drove_opponent_car',
          oppVis && d0 < 3000 && d1 < 3000,
          `oppVis=${oppVis}, d0=${d0.toFixed(1)}, d1=${d1.toFixed(1)}`
        );
        const ks = getKickoffStore();
        ks.setGhostModeEnabled(true);
        ks.setGhostPlacement('same');
        ks.setRealisticWaitTicks(120);
        ks.setSubMode('realistic' as never);
      }
    ),
    {
      tick: 630,
      description: 'Verify Realistic kickoff mode enters countdown phase',
      action: (ctx) => {
        const r = asRuntime(ctx);
        const ks = getKickoffStore();
        ctx.recordAssertion(
          'kickoff_realistic_countdown_active',
          ks.phase === 'countdown' &&
            r?.match?.state?.phase === 'kickoff' &&
            ks.countdownRemainingTicks > 0,
          `ko=${ks.phase}, match=${r?.match?.state?.phase}, rem=${ks.countdownRemainingTicks}`
        );
      },
    },
    kfStep(
      765,
      'kickoff_realistic_countdown_unfreeze',
      'Verify Realistic 120-tick countdown completed into running phase',
      (ctx) => {
        const r = asRuntime(ctx);
        const ks = getKickoffStore();
        ctx.recordAssertion(
          'kickoff_realistic_countdown_transitioned_to_running',
          ks.phase === 'running' && r?.match?.state?.phase === 'playing' && ks.episodeTick > 0,
          `ko=${ks.phase}, match=${r?.match?.state?.phase}, tick=${ks.episodeTick}`
        );
      }
    ),
    kfStep(
      860,
      'training_suite_return_to_freeplay',
      'Return cleanly from Kickoff Training to FreePlay and verify Ghost and Car 1 are hidden',
      (ctx) => {
        const r = asRuntime(ctx);
        const km = getKickoffMode(ctx);
        switchMode(r, 'freeplay');
        const mode = r?.match?.state?.mode;
        const n = r?.physics?.numCars ?? 0;
        const gHid = !km?.ghostVisuals?.ghostCarRoot?.visible;
        const c1Hid = !r?.arena?.cars?.[1]?.visible;
        ctx.recordAssertion(
          'training_suite_clean_return_to_freeplay',
          mode === 'freeplay' && n === 1 && gHid && c1Hid,
          `mode=${mode}, n=${n}, gHid=${gHid}, c1Hid=${c1Hid}`
        );
      }
    ),
  ],
  teardown: async (ctx) => {
    ctx.setLocalCarControls(null);
  },
};
