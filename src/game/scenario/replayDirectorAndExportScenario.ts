import { INCIDENT_EVENT_TYPES, MATCH_SIGNALS, SYSTEM_CONTROL_SIGNALS } from '../../physics/RocketSimConstants.ts';
import { retainCompletedMatchReplayAndNotify, parseRCReplayFile } from '../../replay/ReplayFileExporter.ts';
import { serializeRCReplayBinaryContainer } from '../../replay/container/RCReplayBinaryEncoder.ts';
import { packAndCompressReplayInBackground } from '../../replay/container/RCReplayCompressionWorkerClient.ts';
import { hudStore, useAppStore, useReplayViewerStore } from '../runtimeUiPort.ts';
import type { ScenarioScript, ScenarioStepContext } from './ScenarioTypes.ts';

interface DirectorPoseProbe {
  eyeX?: number; eyeY?: number; eyeZ?: number; targetX?: number; targetY?: number; targetZ?: number;
}

interface StandaloneViewerProbe {
  isActive?: boolean; hasLoadedReplay?: boolean; frames?: ArrayLike<Float32Array>;
  incidentTimeline?: { count?: number } | null; signalTimeline?: { count?: number } | null;
  rosterSubController?: { resolvedRoster: Array<{ slotKey: number; carIndex: number; team: number }>; activePovCarIndex: number };
  takeoverSubController?: { cursor?: number };
  causalSyncController?: { causalHybridEngine?: { enabled?: boolean; freeCarSet?: Set<number> } };
  getViewerState?: () => string; handleUploadFile?: (file: File) => Promise<void>;
  startPlaying?: () => void; seekFrame?: (frameIndex: number) => void;
  selectPovSlot?: (slotKey: number) => void; resumeFromCursor?: () => void;
}

interface FreeplayModeProbe {
  replayController?: {
    sessionState?: { isActive?: boolean; isPaused?: boolean };
    directorCameraState?: DirectorPoseProbe | null;
    ensureSuffixCameraPlan?: () => unknown;
    setPaused?: (paused: boolean) => boolean;
  } | null;
  directorPreview?: { isReplayActive?: boolean; replayCameraMode?: string } | null;
  goalAndTouch?: { goalResetTicks?: number; getEffectiveGoalResetTicks?: () => number } | null;
  standaloneReplayViewer?: StandaloneViewerProbe | null;
  isGoalReplayActive?: () => boolean;
  enterDirectorReferenceFreeCamFromHere?: (opts?: { fov?: number }) => boolean;
  exitDirectorReferenceFreeCam?: () => boolean;
  skipGoalReplay?: () => void;
  resetToCleanFreeplay?: () => void;
}

const getMode = (ctx: ScenarioStepContext) => ctx.runtime?.modeManager?.getActiveMode?.() as FreeplayModeProbe | undefined;

function isPoseFinite(p: DirectorPoseProbe | null | undefined): boolean {
  return Boolean(
    p && Number.isFinite(p.eyeX) && Number.isFinite(p.eyeY) && Number.isFinite(p.eyeZ) &&
    Number.isFinite(p.targetX) && Number.isFinite(p.targetY) && Number.isFinite(p.targetZ)
  );
}

export const REPLAY_DIRECTOR_AND_EXPORT_SCENARIO: ScenarioScript = {
  id: 'replay_director_and_export_lifecycle',
  title: 'Goal Replay Director -> .rcreplay.gz Export/Import -> Viewer Takeover -> Exit',
  description: 'Goal Replay Director multi-view, .rcreplay.gz binary export/import, Viewer takeover countdown, causal hybrid physics intervention, and clean FreePlay exit.',
  totalTicks: 820, renderStride: 15, batchYieldTicks: 60, forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    const r = ctx.runtime;
    if (r?.authoritativeServer || r?.networkReconciler) {
      await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
    }
    r?.modeManager?.setActiveMode?.('freeplay');
    r?.resetKickoff?.(0);
    ctx.setLocalCarControls({ throttle: 1.0, boost: true });
  },
  steps: [
    {
      tick: 20, description: 'Launch Car 0 and ball into Orange goal',
      action: (ctx) => {
        ctx.setCarState(0, { pos: [0, 4350, 17.01], vel: [0, 2100, 0], angVel: [0, 0, 0], boost: 100 });
        ctx.setBallState({ pos: [0, 4650, 95], vel: [0, 2800, 60], angVel: [0, 0, 0] });
      },
    },
    {
      tick: 65, forceKeyframeRender: true, keyframeReason: 'director_goal_celebration',
      description: 'Verify Goal Scored celebration active',
      action: (ctx) => {
        const mode = getMode(ctx);
        const ticks = mode?.goalAndTouch?.getEffectiveGoalResetTicks?.() ?? mode?.goalAndTouch?.goalResetTicks ?? 0;
        const phase = ctx.runtime?.match?.state?.phase;
        ctx.recordAssertion('director_bench_goal_celebration_active', phase === 'goal' || ticks > 0, `phase=${phase}, ticks=${ticks}`);
        ctx.setLocalCarControls({ throttle: 0, boost: false });
      },
    },
    {
      tick: 220, forceKeyframeRender: true, keyframeReason: 'director_cinematic_replay',
      description: 'Verify Director Camera Goal Replay with suffix plan and finite pose',
      action: (ctx) => {
        const r = ctx.runtime;
        const mode = getMode(ctx);
        const active = Boolean(mode?.isGoalReplayActive?.() || mode?.directorPreview?.isReplayActive);
        const ovr = Boolean(r?.isGoalReplayCameraOverrideActive?.());
        const cam = mode?.directorPreview?.replayCameraMode;
        const plan = Boolean(mode?.replayController?.ensureSuffixCameraPlan?.());
        const poseOk = isPoseFinite(mode?.replayController?.directorCameraState);
        ctx.recordAssertion(
          'director_bench_replay_and_pose_valid',
          r?.match?.state?.phase === 'replay' && active && ovr && cam === 'director' && plan && poseOk,
          `phase=${r?.match?.state?.phase}, active=${active}, ovr=${ovr}, cam=${cam}, plan=${plan}, poseOk=${poseOk}`,
        );
      },
    },
    {
      tick: 260, forceKeyframeRender: true, keyframeReason: 'director_pov_camera',
      description: 'Switch Goal Replay camera to POV mode via HUD callback',
      action: (ctx) => {
        hudStore.getState().onReplayToggleCameraMode?.();
        const cam = getMode(ctx)?.directorPreview?.replayCameraMode;
        const ovr = Boolean(ctx.runtime?.isGoalReplayCameraOverrideActive?.());
        ctx.recordAssertion('director_bench_pov_switch_verified', cam === 'pov' && !ovr, `cam=${cam}, ovr=${ovr}`);
      },
    },
    {
      tick: 290, forceKeyframeRender: true, keyframeReason: 'director_reference_freecam',
      description: 'Enter Reference FreeCam and exit back to Director mode',
      action: (ctx) => {
        const mode = getMode(ctx);
        hudStore.getState().onReplayToggleCameraMode?.();
        const entered = Boolean(mode?.enterDirectorReferenceFreeCamFromHere?.());
        const freeDuring = Boolean(useAppStore.getState().isFreeCam);
        const paused = Boolean(mode?.replayController?.sessionState?.isPaused);
        const exited = Boolean(mode?.exitDirectorReferenceFreeCam?.());
        mode?.replayController?.setPaused?.(false);
        const freeAfter = Boolean(useAppStore.getState().isFreeCam);
        const ovrAfter = Boolean(ctx.runtime?.isGoalReplayCameraOverrideActive?.());
        ctx.recordAssertion(
          'director_bench_reference_freecam_roundtrip',
          entered && freeDuring && paused && exited && !freeAfter && ovrAfter,
          `entered=${entered}, freeDuring=${freeDuring}, paused=${paused}, exited=${exited}, freeAfter=${freeAfter}, ovrAfter=${ovrAfter}`,
        );
      },
    },
    {
      tick: 330, description: 'Hold Jump during active Goal Replay',
      action: (ctx) => { ctx.setLocalCarControls({ throttle: 1.0, boost: true, jump: true }); },
    },
    {
      tick: 340, forceKeyframeRender: true, keyframeReason: 'director_skip_replay',
      description: 'Skip Goal Replay while holding Jump',
      action: (ctx) => {
        getMode(ctx)?.skipGoalReplay?.();
        const phase = ctx.runtime?.match?.state?.phase;
        const ovr = Boolean(ctx.runtime?.isGoalReplayCameraOverrideActive?.());
        ctx.recordAssertion('director_bench_skip_replay_restored_playing', phase === 'playing' && !ovr, `phase=${phase}, ovr=${ovr}`);
      },
    },
    {
      tick: 350, description: 'Verify no spontaneous jump after replay skip',
      action: (ctx) => {
        const cv = ctx.runtime?.physics?.getCarStateView?.(0);
        const ok = Boolean(cv && !cv.isJumping && cv.posZ < 28);
        ctx.recordAssertion('director_bench_no_spontaneous_jump_after_skip', ok, `isJumping=${cv?.isJumping}, posZ=${cv?.posZ?.toFixed?.(2)}`);
        ctx.setLocalCarControls({ throttle: 0, boost: false, jump: false });
      },
    },
    {
      tick: 380, forceKeyframeRender: true, keyframeReason: 'rcreplay_export_import',
      description: 'Serialize and GZIP-compress a 4-car 180-frame replay into .rcreplay.gz and load into Viewer',
      action: async (ctx) => {
        const r = ctx.runtime;
        const viewer = getMode(ctx)?.standaloneReplayViewer;
        if (!r?.physics || !viewer) return;
        while (r.physics.numCars < 4 && typeof r.physics.addCar === 'function') {
          r.physics.addCar(r.physics.numCars % 2, 'fennec');
        }
        r.physics.resetKickoff?.(0);

        const slots: Array<{
          tick: number; snapshot: Float32Array;
          acknowledgedControls: Array<{ carIndex: number; controls: Record<string, unknown> }>;
          incidents: Array<Record<string, unknown>>; signals: Array<Record<string, unknown>>;
        }> = [];

        for (let f = 0; f < 180; f++) {
          const ack: Array<{ carIndex: number; controls: Record<string, unknown> }> = [];
          for (let c = 0; c < 4; c++) {
            const ctrl = { throttle: 1.0, steer: c % 2 === 0 ? 0.1 : -0.1, pitch: 0, yaw: 0, roll: 0, jump: false, boost: f < 60, handbrake: false };
            r.physics.setControls?.(c, ctrl);
            ack.push({ carIndex: c, controls: ctrl });
          }
          r.physics.step?.(1 / 120);
          const snap = r.physics.saveCompactState?.();
          if (snap) {
            slots.push({
              tick: f + 1, snapshot: new Float32Array(snap), acknowledgedControls: ack,
              incidents: f === 60 ? [{ type: INCIDENT_EVENT_TYPES.GOAL_SCORED, tick: 61, frameIndex: 60, carIndex: 0, team: 0, speedKph: 108.5 }] : [],
              signals: f === 60 ? [{ signalId: 1, signalType: MATCH_SIGNALS.SCORE_UPDATED, frameId: 61, param1: 1, param2: 0 }] : [],
            });
          }
        }

        const retained = retainCompletedMatchReplayAndNotify({
          frames: slots, mode: 'standard_2v2', gameMode: 'match', durationSeconds: 1.5,
          blueScore: 1, orangeScore: 0, winner: 'blue',
          roster: [
            { carIndex: 0, team: 0, name: 'BlueOne', visualId: 'fennec', isSelf: true },
            { carIndex: 1, team: 1, name: 'OrangeOne', visualId: 'octane', isSelf: false },
            { carIndex: 2, team: 0, name: 'BlueTwo', visualId: 'dominus', isSelf: false },
            { carIndex: 3, team: 1, name: 'OrangeTwo', visualId: 'insidio', isSelf: false },
          ],
          suppressNotification: true,
        });

        const raw = serializeRCReplayBinaryContainer({ slots, ...(retained || {}) });
        const magicOk = raw.byteLength > 24 && raw[0] === 0x52 && raw[1] === 0x43 && raw[2] === 0x52 && raw[3] === 0x45;
        const packed = await packAndCompressReplayInBackground(retained!);
        const bytes = new Uint8Array(packed.buffer);
        const gzipOk = Boolean(packed.compressed) && bytes.byteLength > 32 && bytes[0] === 0x1f && bytes[1] === 0x8b;
        const parsed = await parseRCReplayFile(packed.buffer);
        await viewer.handleUploadFile?.(new File([packed.buffer], 'bench.rcreplay.gz', { type: 'application/gzip' }));
        viewer.startPlaying?.();

        const rosterLen = viewer.rosterSubController?.resolvedRoster?.length ?? 0;
        const incCount = viewer.incidentTimeline?.count ?? 0;
        const sigCount = viewer.signalTimeline?.count ?? 0;
        ctx.recordAssertion(
          'rcreplay_binary_export_gzip_and_viewer_load',
          magicOk && gzipOk && parsed.frames.length === 180 && Boolean(viewer.isActive && viewer.hasLoadedReplay) && (viewer.frames?.length ?? 0) === 180 && rosterLen === 4 && incCount >= 1 && sigCount >= 1,
          `magic=${magicOk}, gzip=${gzipOk} (${bytes.byteLength}B), frames=${viewer.frames?.length ?? 0}, roster=${rosterLen}, inc=${incCount}, sig=${sigCount}`,
        );
      },
    },
    {
      tick: 430, forceKeyframeRender: true, keyframeReason: 'viewer_seek_and_pov_switch',
      description: 'Seek frame 140 and switch POV slot in Viewer',
      action: (ctx) => {
        const r = ctx.runtime;
        const viewer = getMode(ctx)?.standaloneReplayViewer;
        viewer?.seekFrame?.(140);
        const seekSig = r?.lastSystemControlSignal;
        viewer?.selectPovSlot?.(4);
        const povIdx = viewer?.rosterSubController?.activePovCarIndex ?? -1;
        const cursor = Math.round(viewer?.takeoverSubController?.cursor ?? -1);
        ctx.recordAssertion(
          'viewer_seek_and_pov_switch_verified',
          seekSig === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_STATE_ONLY && cursor === 140 && povIdx >= 0 && r?.playerCarIndex === povIdx,
          `seekSig=0x${(seekSig || 0).toString(16)}, cursor=${cursor}, pov=${povIdx}, player=${r?.playerCarIndex}`,
        );
      },
    },
    {
      tick: 450, forceKeyframeRender: true, keyframeReason: 'viewer_takeover_preroll',
      description: 'Trigger Takeover pre-roll countdown',
      action: (ctx) => {
        const viewer = getMode(ctx)?.standaloneReplayViewer;
        useReplayViewerStore.getState().setDownCounterSec(0);
        viewer?.resumeFromCursor?.();
        const vState = viewer?.getViewerState?.();
        const sig = ctx.runtime?.lastSystemControlSignal;
        ctx.recordAssertion(
          'viewer_takeover_preroll_countdown_started',
          vState === 'preroll-countdown' && sig === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_INTERVENE_WILL_RESUME,
          `state=${vState}, sig=0x${(sig || 0).toString(16)}`,
        );
        ctx.setLocalCarControls({ throttle: 1.0, steer: -0.25, boost: true });
      },
    },
    {
      tick: 590, forceKeyframeRender: true, keyframeReason: 'viewer_live_intervention',
      description: 'Verify live causal hybrid physics intervention',
      action: (ctx) => {
        const r = ctx.runtime;
        const viewer = getMode(ctx)?.standaloneReplayViewer;
        const vState = viewer?.getViewerState?.();
        const povIdx = viewer?.rosterSubController?.activePovCarIndex ?? 0;
        const eng = viewer?.causalSyncController?.causalHybridEngine;
        const hybrid = Boolean(eng?.enabled && eng?.freeCarSet?.has(povIdx));
        const sig = r?.lastSystemControlSignal;
        const cv = r?.physics?.getCarStateView?.(povIdx);
        const speed = Math.hypot(cv?.velX ?? 0, cv?.velY ?? 0, cv?.velZ ?? 0);
        ctx.recordAssertion(
          'viewer_takeover_live_physics_intervening',
          vState === 'intervening' && hybrid && sig === SYSTEM_CONTROL_SIGNALS.SYS_CTRL_PHYSICS_RESUME && speed > 50,
          `state=${vState}, hybrid=${hybrid}, sig=0x${(sig || 0).toString(16)}, speed=${speed.toFixed(1)}`,
        );
      },
    },
    {
      tick: 700, forceKeyframeRender: true, keyframeReason: 'viewer_clean_exit',
      description: 'Exit Replay Viewer back to FreePlay',
      action: (ctx) => {
        getMode(ctx)?.resetToCleanFreeplay?.();
        ctx.runtime?.resetKickoff?.(0);
      },
    },
    {
      tick: 760, forceKeyframeRender: true, keyframeReason: 'viewer_post_exit_clean',
      description: 'Verify clean 1-car FreePlay restoration',
      action: (ctx) => {
        const r = ctx.runtime;
        const viewer = getMode(ctx)?.standaloneReplayViewer;
        const vState = viewer?.getViewerState?.() ?? 'idle';
        const numCars = r?.physics?.numCars ?? 0;
        const hidden = (r?.arena?.cars ?? []).slice(1).every((c) => !c || !c.visible);
        const dormant = (r?.arena?.carBoosts ?? []).slice(1).every((emList) =>
          (emList ?? []).every((em) => !em?.physics?.driveParticlesActive && !em?.physics?.trailParticlesActive && !em?.goldRush?.driveParticlesActive && !em?.goldRush?.trailParticlesActive)
        );
        ctx.recordAssertion(
          'viewer_clean_exit_to_1car_freeplay_verified',
          vState === 'idle' && !viewer?.isActive && r?.match?.state?.mode === 'freeplay' && numCars === 1 && hidden && dormant,
          `state=${vState}, mode=${r?.match?.state?.mode}, cars=${numCars}, hidden=${hidden}, dormant=${dormant}`,
        );
      },
    },
  ],
  teardown: async (ctx) => { ctx.setLocalCarControls(null); },
};
