import React, { useState, useEffect } from 'react';
import {
  Film,
  Camera,
  Clock,
  Eye,
  RotateCcw,
  Download,
  Check,
  Sliders,
  Play,
  Pause,
  FastForward,
  FileJson,
  FileSpreadsheet,
  Copy,
  Crosshair,
} from 'lucide-react';
import {
  REPLAY_DIRECTOR_CONFIG,
  DEFAULT_REPLAY_DIRECTOR_CONFIG,
  updateReplayDirectorConfig,
  resetReplayDirectorConfig,
  subscribeReplayDirectorConfig,
} from '../../replay/ReplayFrameInterpolator.js';
import {
  getActiveReplayTimelineController,
  subscribeActiveReplayTimelineController,
  exportActiveReplayDirectorDiagnosticPattern,
} from '../../replay/ReplayTimelineController.js';
import { useHudStore } from '../../stores/hudStore';
import { useDevTestLabStore } from '../../stores/devTestLabStore';
import { SliderControl } from '../primitives/SliderControl';
import { UnderlineTabs } from '../primitives/UnderlineTabs';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';

export interface ReplayDirectorTunerFloatingWindowProps {
  isLight?: boolean;
  active?: boolean;
}

type DirectorTabId = 'framing' | 'lookahead' | 'slowmo';

export const ReplayDirectorTunerFloatingWindow: React.FC<ReplayDirectorTunerFloatingWindowProps> = ({
  isLight = false,
}) => {
  const [activeTab, setActiveTab] = useState<DirectorTabId>('framing');
  const [cfg, setCfg] = useState(() => ({ ...REPLAY_DIRECTOR_CONFIG }));
  const [copied, setCopied] = useState(false);
  const [copiedFrameSnap, setCopiedFrameSnap] = useState(false);
  const [exportedFileMsg, setExportedFileMsg] = useState<string | null>(null);
  const [, setTickRevision] = useState(0);

  const matchPhase = useHudStore((s) => s.matchPhase);
  const replayProgress = useHudStore((s) => s.replayProgress);
  const replayFrameIndex = useHudStore((s) => s.replayFrameIndex);
  const replayTotalFrames = useHudStore((s) => s.replayTotalFrames);
  const replayPaused = useHudStore((s) => s.replayPaused);
  const replayPersistent = useHudStore((s) => s.replayPersistent);
  const replaySpeed = useHudStore((s) => s.replaySpeed);
  const onReplaySeekNormalized = useHudStore((s) => s.onReplaySeekNormalized);
  const onReplayTogglePause = useHudStore((s) => s.onReplayTogglePause);
  const onReplayCycleSpeed = useHudStore((s) => s.onReplayCycleSpeed);

  const devGoalReplayPhase = useDevTestLabStore((s) => s.goalReplayPhase);
  const devGoalReplayCursor = useDevTestLabStore((s) => s.goalReplayPlaybackCursor);
  const devGoalReplayTotal = useDevTestLabStore((s) => s.goalReplayPlaybackTotal);
  const devGoalReplayPaused = useDevTestLabStore((s) => s.goalReplayPaused);
  const devGoalReplaySpeed = useDevTestLabStore((s) => s.goalReplaySpeed);
  const devRuntimeHandlers = useDevTestLabStore((s) => s.runtimeHandlers);

  useEffect(() => {
    const unsubCfg = subscribeReplayDirectorConfig((next: typeof REPLAY_DIRECTOR_CONFIG) => {
      setCfg({ ...next });
    });
    const unsubCtrl = subscribeActiveReplayTimelineController(() => {
      setTickRevision((r) => r + 1);
    });
    const interval = setInterval(() => {
      const ctrl = getActiveReplayTimelineController();
      if (ctrl && ctrl.isActive) {
        setTickRevision((r) => r + 1);
      }
    }, 100);
    return () => {
      unsubCfg();
      unsubCtrl();
      clearInterval(interval);
    };
  }, []);

  const activeCtrl = getActiveReplayTimelineController();
  const isDevLabReplaying = devGoalReplayPhase === 'replaying';
  const isHudGoalReplay = matchPhase === 'replay';
  const isGoalReplayActive = Boolean(
    (activeCtrl && activeCtrl.isActive) || isHudGoalReplay || isDevLabReplaying
  );
  const isPausePlayScrubActive = Boolean(
    isGoalReplayActive &&
      (activeCtrl?.isPersistent ||
        activeCtrl?.isPaused ||
        activeCtrl?.isScrubbing ||
        replayPersistent ||
        replayPaused ||
        devGoalReplayPaused)
  );

  const liveSnapshot =
    activeCtrl && activeCtrl.isActive ? activeCtrl.getCurrentFrameDiagnosticSnapshot() : null;

  const effectiveFrameIdx =
    liveSnapshot?.replayFrameIndex ??
    (isDevLabReplaying ? devGoalReplayCursor : replayFrameIndex) ??
    0;
  const effectiveTotalFrames =
    liveSnapshot?.totalReplayFrames ??
    (isDevLabReplaying ? devGoalReplayTotal : replayTotalFrames) ??
    1;
  const effectiveFrameId = liveSnapshot?.frameId ?? effectiveFrameIdx;
  const effectivePaused = activeCtrl?.isPaused ?? (isDevLabReplaying ? devGoalReplayPaused : replayPaused);
  const effectiveSpeed = activeCtrl?.playbackSpeed ?? (isDevLabReplaying ? devGoalReplaySpeed : replaySpeed) ?? 1.0;
  const effectiveProgress01 =
    effectiveTotalFrames > 1
      ? Math.max(0, Math.min(1, effectiveFrameIdx / (effectiveTotalFrames - 1)))
      : replayProgress || 0;

  const handleTogglePauseScrub = () => {
    if (isDevLabReplaying && devRuntimeHandlers.onGoalReplayTogglePause) {
      devRuntimeHandlers.onGoalReplayTogglePause();
    } else if (onReplayTogglePause) {
      onReplayTogglePause();
    } else if (activeCtrl && activeCtrl.isActive) {
      activeCtrl.togglePause();
    } else {
      console.warn('[ReplayDirectorTuner] handleTogglePauseScrub ignored: no active goal replay session.');
    }
    setTickRevision((r) => r + 1);
  };

  const handleCycleSpeed = () => {
    if (isDevLabReplaying && devRuntimeHandlers.onGoalReplayCycleSpeed) {
      devRuntimeHandlers.onGoalReplayCycleSpeed();
    } else if (onReplayCycleSpeed) {
      onReplayCycleSpeed();
    } else if (activeCtrl && activeCtrl.isActive) {
      activeCtrl.cyclePlaybackSpeed();
    } else {
      console.warn('[ReplayDirectorTuner] handleCycleSpeed ignored: no active goal replay session.');
    }
    setTickRevision((r) => r + 1);
  };

  const handleScrubNormalized = (norm01: number) => {
    if (isDevLabReplaying && devRuntimeHandlers.onGoalReplaySeekNormalized) {
      devRuntimeHandlers.onGoalReplaySeekNormalized(norm01);
    } else if (onReplaySeekNormalized) {
      onReplaySeekNormalized(norm01);
    } else if (activeCtrl && activeCtrl.isActive) {
      activeCtrl.seekToNormalized(norm01);
    } else {
      console.warn('[ReplayDirectorTuner] handleScrubNormalized ignored: no active goal replay session.');
    }
    setTickRevision((r) => r + 1);
  };

  const handleExportPattern = (format: 'json' | 'csv') => {
    if (!isPausePlayScrubActive) return;
    const res = exportActiveReplayDirectorDiagnosticPattern(format);
    if (res?.filename) {
      setExportedFileMsg(`Exported ${res.filename}`);
      setTimeout(() => setExportedFileMsg(null), 3200);
    }
  };

  const handleCopyFrameDiagnostic = () => {
    if (!isPausePlayScrubActive || !liveSnapshot) return;
    const payload = {
      schema: 'RocketCompanion.ReplayDirectorSingleFrameDiagnostic.v1',
      exportedAt: new Date().toISOString(),
      directorConfig: { ...REPLAY_DIRECTOR_CONFIG },
      frameDiagnostic: liveSnapshot,
    };
    const json = JSON.stringify(payload, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(json).catch((err) => {
        console.warn('[ReplayDirectorTuner] Failed to copy frame diagnostic JSON to clipboard:', err);
      });
    }
    setCopiedFrameSnap(true);
    setTimeout(() => setCopiedFrameSnap(false), 1800);
  };

  const handleParamChange = (key: keyof typeof REPLAY_DIRECTOR_CONFIG, val: number) => {
    updateReplayDirectorConfig({ [key]: val });
    setCfg({ ...REPLAY_DIRECTOR_CONFIG });
  };

  const handleResetAll = () => {
    resetReplayDirectorConfig();
    setCfg({ ...REPLAY_DIRECTOR_CONFIG });
  };

  const handleCopyJson = () => {
    const json = JSON.stringify(REPLAY_DIRECTOR_CONFIG, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(json).catch((err) => {
        console.warn('[ReplayDirectorTuner] Failed to copy director config JSON to clipboard:', err);
      });
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const cardBg = isLight
    ? 'bg-neutral-50 border-neutral-200 text-neutral-800'
    : 'bg-neutral-850/60 border-neutral-700/60 text-neutral-200';
  const subPanelBg = isLight
    ? 'bg-white border-neutral-200'
    : 'bg-neutral-900/60 border-neutral-800/80';
  const mutedText = isLight ? 'text-neutral-500' : 'text-neutral-400';

  const tabs = [
    {
      id: 'framing',
      label: 'Corridor & Damping',
      icon: <Camera className="h-3.5 w-3.5" />,
    },
    {
      id: 'lookahead',
      label: '2-Touch Lookahead',
      icon: <Eye className="h-3.5 w-3.5" />,
    },
    {
      id: 'slowmo',
      label: 'Slow-Mo Windows',
      icon: <Clock className="h-3.5 w-3.5" />,
    },
  ];

  return (
    <div className="flex flex-col gap-2.5 select-none">
      {/* Header Summary Card */}
      <div className={`p-2.5 rounded-xl border flex flex-col gap-1.5 ${cardBg}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Film className="h-4 w-4 text-amber-400 shrink-0" />
            <span className="font-bold text-xs truncate">
              Replay Director AutoCam & Slow-Mo Tuner
            </span>
          </div>
          <Badge variant="amber" size="sm" isLight={isLight} className="font-mono text-[10px]">
            LIVE CONFIG
          </Badge>
        </div>
        <p className={`text-[10px] leading-relaxed ${mutedText}`}>
          Real-time tuning for <code>REPLAY_DIRECTOR_CONFIG</code> in{' '}
          <code>ReplayFrameInterpolator.js</code>. Adjust damping rates, corridor distances, 2-touch
          anticipation, and slow-motion plateaus while watching Goal Replays in Free Play, Match, or
          Dev Test Lab.
        </p>

        <div className="flex items-center justify-between gap-1.5 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleResetAll}
            isLight={isLight}
            className="gap-1 py-1 text-[10px]"
          >
            <RotateCcw className="h-3 w-3 text-amber-400 shrink-0" />
            <span>Reset Defaults</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleCopyJson}
            isLight={isLight}
            className="gap-1 py-1 text-[10px]"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                <span>Copied JSON!</span>
              </>
            ) : (
              <>
                <Download className="h-3 w-3 text-sky-400 shrink-0" />
                <span>Copy Config JSON</span>
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Live Goal Replay Diagnostic Pattern & Camera Pose Export Card */}
      <div className={`p-2.5 rounded-xl border flex flex-col gap-2 ${cardBg}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Crosshair className="h-3.5 w-3.5 text-sky-400 shrink-0" />
            <span className="font-semibold text-[11px] truncate">
              Goal Replay Pattern & Camera Orientation Export
            </span>
          </div>
          <Badge
            variant={
              isPausePlayScrubActive
                ? 'emerald'
                : isGoalReplayActive
                ? 'amber'
                : 'neutral'
            }
            size="sm"
            isLight={isLight}
            className="font-mono text-[9.5px] uppercase shrink-0"
          >
            {isPausePlayScrubActive
              ? 'SCRUB / EXPORT READY'
              : isGoalReplayActive
              ? 'REPLAYING (PRESS P)'
              : 'WAITING FOR GOAL REPLAY'}
          </Badge>
        </div>

        {isGoalReplayActive ? (
          <div className={`p-2 rounded-lg border flex flex-col gap-1.5 font-mono text-[10px] ${subPanelBg}`}>
            <div className="flex items-center justify-between gap-2">
              <span>
                Frame ID: <b className="text-amber-400">#{effectiveFrameId}</b> · Replay Idx:{' '}
                <b className="text-sky-400">
                  {effectiveFrameIdx}/{Math.max(1, effectiveTotalFrames - 1)}
                </b>{' '}
                ({(effectiveFrameIdx / 120).toFixed(2)}s)
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={handleTogglePauseScrub}
                  className="px-2 py-0.5 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-100 text-[10px] font-bold flex items-center gap-1 cursor-pointer"
                >
                  {effectivePaused ? <Play className="h-2.5 w-2.5 text-emerald-400" /> : <Pause className="h-2.5 w-2.5 text-amber-400" />}
                  <span>{effectivePaused ? '[P] Play' : '[P] Pause / Scrub'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleCycleSpeed}
                  className="px-1.5 py-0.5 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-sky-300 text-[10px] font-bold flex items-center gap-1 cursor-pointer"
                >
                  <FastForward className="h-2.5 w-2.5" />
                  <span>{effectiveSpeed}x</span>
                </button>
              </div>
            </div>

            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round(effectiveProgress01 * 1000)}
              onChange={(e) => handleScrubNormalized(Number(e.target.value) / 1000)}
              className="w-full h-1.5 accent-amber-400 cursor-pointer"
            />

            {liveSnapshot && (
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 pt-0.5 text-[9.5px] border-t border-neutral-700/40">
                <span>
                  Cam Eye (UU):{' '}
                  <b>
                    [{Math.round(liveSnapshot.cameraPose.dampedEyeUnreal[0])},{' '}
                    {Math.round(liveSnapshot.cameraPose.dampedEyeUnreal[1])},{' '}
                    {Math.round(liveSnapshot.cameraPose.dampedEyeUnreal[2])}]
                  </b>
                </span>
                <span>
                  LookAt (UU):{' '}
                  <b>
                    [{Math.round(liveSnapshot.cameraPose.dampedTargetUnreal[0])},{' '}
                    {Math.round(liveSnapshot.cameraPose.dampedTargetUnreal[1])},{' '}
                    {Math.round(liveSnapshot.cameraPose.dampedTargetUnreal[2])}]
                  </b>
                </span>
                <span>
                  Yaw / Pitch / Dist:{' '}
                  <b className="text-emerald-400">
                    {liveSnapshot.cameraPose.yawDeg.toFixed(1)}° / {liveSnapshot.cameraPose.pitchDeg.toFixed(1)}° /{' '}
                    {Math.round(liveSnapshot.cameraPose.distanceToTarget)}u
                  </b>
                </span>
                <span>
                  Ball Pos / Focus:{' '}
                  <b>
                    [{Math.round(liveSnapshot.ball.pos[0])}, {Math.round(liveSnapshot.ball.pos[1])},{' '}
                    {Math.round(liveSnapshot.ball.pos[2])}] · C{liveSnapshot.lookahead.activeTouchCarIndex}
                    {liveSnapshot.lookahead.nextTouchCarIndex >= 0
                      ? `→C${liveSnapshot.lookahead.nextTouchCarIndex}`
                      : ''}
                  </b>
                </span>
              </div>
            )}
          </div>
        ) : (
          <p className={`text-[10px] leading-snug ${mutedText}`}>
            During a Goal Replay, press <b>[P]</b> (or use the timeline scrubber) to activate Pause / Play / Scrub mode.
            Once active, you can export the full replay pattern &amp; camera orientation trajectory with{' '}
            <code>frameId</code> for every frame.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              disabled={!isPausePlayScrubActive}
              onClick={() => handleExportPattern('json')}
              isLight={isLight}
              className="gap-1 px-2.5 py-1 text-[10px] font-bold"
              title={
                isPausePlayScrubActive
                  ? 'Export full Goal Replay pattern, camera pose trajectory, and Frame IDs as JSON'
                  : 'Available during Goal Replay when Pause / Play / Scrub ([P]) is activated'
              }
            >
              <FileJson className="h-3 w-3 shrink-0" />
              <span>Export Pattern JSON</span>
            </Button>

            <Button
              variant="secondary"
              size="sm"
              disabled={!isPausePlayScrubActive}
              onClick={() => handleExportPattern('csv')}
              isLight={isLight}
              className="gap-1 px-2 py-1 text-[10px]"
              title={
                isPausePlayScrubActive
                  ? 'Export per-frame camera pose + ball/car trajectory with Frame IDs as CSV'
                  : 'Available during Goal Replay when Pause / Play / Scrub ([P]) is activated'
              }
            >
              <FileSpreadsheet className="h-3 w-3 text-emerald-400 shrink-0" />
              <span>Export Pattern CSV</span>
            </Button>
          </div>

          <Button
            variant="secondary"
            size="sm"
            disabled={!isPausePlayScrubActive || !liveSnapshot}
            onClick={handleCopyFrameDiagnostic}
            isLight={isLight}
            className="gap-1 px-2 py-1 text-[10px]"
            title="Copy current frame camera pose, ball/car state, and Frame ID to clipboard"
          >
            {copiedFrameSnap ? (
              <>
                <Check className="h-3 w-3 text-emerald-400 shrink-0" />
                <span>Copied Frame #{effectiveFrameId}!</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3 text-amber-400 shrink-0" />
                <span>Copy Frame #{effectiveFrameId}</span>
              </>
            )}
          </Button>
        </div>

        {exportedFileMsg && (
          <div className="text-[10px] font-mono text-emerald-400 px-1 truncate">
            ✓ {exportedFileMsg}
          </div>
        )}
      </div>

      {/* Sub-navigation Tabs */}
      <UnderlineTabs
        tabs={tabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as DirectorTabId)}
        isLight={isLight}
      />

      {/* Tab 1: Corridor & Damping */}
      {activeTab === 'framing' && (
        <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 ${subPanelBg}`}>
          <div className="flex items-center justify-between border-b border-neutral-700/30 pb-1">
            <span className="text-[11px] font-semibold flex items-center gap-1.5 text-amber-400">
              <Sliders className="h-3.5 w-3.5" />
              <span>Smoothing & Transition Damping</span>
            </span>
            <span className={`text-[10px] font-mono ${mutedText}`}>1/s exp decay</span>
          </div>

          <SliderControl
            label={`Eye Translation Damping (${cfg.eyeDampingRate.toFixed(1)} /s)`}
            description={`Camera position smoothing rate (default ${DEFAULT_REPLAY_DIRECTOR_CONFIG.eyeDampingRate})`}
            value={cfg.eyeDampingRate}
            min={0.5}
            max={15.0}
            step={0.1}
            unit="/s"
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('eyeDampingRate', v)}
          />

          <SliderControl
            label={`Gaze LookAt Damping (${cfg.gazeDampingRate.toFixed(1)} /s)`}
            description={`Camera pan/tilt aim smoothing rate (default ${DEFAULT_REPLAY_DIRECTOR_CONFIG.gazeDampingRate})`}
            value={cfg.gazeDampingRate}
            min={1.0}
            max={20.0}
            step={0.25}
            unit="/s"
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('gazeDampingRate', v)}
          />

          <SliderControl
            label={`Striker Switch Cross-Fade (${(cfg.strikerSwitchDampingRate ?? 4.2).toFixed(1)} /s)`}
            description="Smooths target & standoff transition when active touch car switches (lower = gentler switch)"
            value={cfg.strikerSwitchDampingRate ?? 4.2}
            min={0.5}
            max={15.0}
            step={0.2}
            unit="/s"
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('strikerSwitchDampingRate', v)}
          />

          <div className="flex items-center justify-between border-b border-neutral-700/30 pb-1 pt-1">
            <span className="text-[11px] font-semibold flex items-center gap-1.5 text-sky-400">
              <Camera className="h-3.5 w-3.5" />
              <span>Corridor & Goal-Box Distances (UU)</span>
            </span>
            <span className={`text-[10px] font-mono ${mutedText}`}>Unreal Units</span>
          </div>

          <SliderControl
            label={`Corridor Back Dist Start (${Math.round(cfg.corridorBackDistStart)} UU)`}
            description="Follow distance behind composite midpoint at start of replay"
            value={cfg.corridorBackDistStart}
            min={300}
            max={1800}
            step={20}
            unit="UU"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('corridorBackDistStart', v)}
          />

          <SliderControl
            label={`Corridor Back Dist End (${Math.round(cfg.corridorBackDistEnd)} UU)`}
            description="Follow distance behind composite midpoint near goal"
            value={cfg.corridorBackDistEnd}
            min={250}
            max={1500}
            step={20}
            unit="UU"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('corridorBackDistEnd', v)}
          />

          <SliderControl
            label={`Corridor Lateral Side Offset (${Math.round(cfg.corridorSideDistBase)} UU)`}
            description="Lateral offset toward open interior of the arena"
            value={cfg.corridorSideDistBase}
            min={0}
            max={1400}
            step={25}
            unit="UU"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('corridorSideDistBase', v)}
          />

          <SliderControl
            label={`Goal-Box Showcase Settle Dist (${Math.round(cfg.goalBoxShowcaseDist)} UU)`}
            description="Hovering distance in front of the goal line as the ball enters the net"
            value={cfg.goalBoxShowcaseDist}
            min={500}
            max={2400}
            step={50}
            unit="UU"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('goalBoxShowcaseDist', v)}
          />
        </div>
      )}

      {/* Tab 2: 2-Touch Lookahead & Car Weight */}
      {activeTab === 'lookahead' && (
        <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 ${subPanelBg}`}>
          <div className="flex items-center justify-between border-b border-neutral-700/30 pb-1">
            <span className="text-[11px] font-semibold flex items-center gap-1.5 text-emerald-400">
              <Eye className="h-3.5 w-3.5" />
              <span>Two-Touch Lookahead & Striker Weighting</span>
            </span>
          </div>

          <SliderControl
            label={`Striker Car Midpoint Max Weight (${Math.round(cfg.carMidpointMaxWeight * 100)}%)`}
            description="Max weight of active touch car in Car-Ball composite midpoint (0% = pure ball cam)"
            value={cfg.carMidpointMaxWeight}
            min={0.0}
            max={0.75}
            step={0.02}
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('carMidpointMaxWeight', v)}
          />

          <SliderControl
            label={`Post-Touch Striker Hold (${cfg.touchHoldAfterSeconds.toFixed(2)}s)`}
            description="How long to continue framing the current striker after ball impact before switching to T2"
            value={cfg.touchHoldAfterSeconds}
            min={0.0}
            max={1.2}
            step={0.05}
            unit="s"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('touchHoldAfterSeconds', v)}
          />

          <SliderControl
            label={`2-Touch Lookahead Horizon (${cfg.twoTouchLookaheadSeconds.toFixed(2)}s)`}
            description="Maximum lookahead window to anticipate the next scoring-team touch (T2)"
            value={cfg.twoTouchLookaheadSeconds}
            min={0.5}
            max={5.0}
            step={0.1}
            unit="s"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('twoTouchLookaheadSeconds', v)}
          />

          <SliderControl
            label={`2-Touch Anticipation Weight (${Math.round(cfg.twoTouchAnticipationWeight * 100)}%)`}
            description="How strongly the camera pre-leans toward the upcoming 2nd touch (T2)"
            value={cfg.twoTouchAnticipationWeight}
            min={0.0}
            max={0.65}
            step={0.02}
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('twoTouchAnticipationWeight', v)}
          />
        </div>
      )}

      {/* Tab 3: Slow-Motion Windows */}
      {activeTab === 'slowmo' && (
        <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 ${subPanelBg}`}>
          <div className="flex items-center justify-between border-b border-neutral-700/30 pb-1">
            <span className="text-[11px] font-semibold flex items-center gap-1.5 text-amber-400">
              <Clock className="h-3.5 w-3.5" />
              <span>1. Final Touch Impact Slow-Mo Window</span>
            </span>
          </div>

          <SliderControl
            label={`Pre-Last-Touch Window (${cfg.lastTouchSlowMoPreSeconds.toFixed(2)}s)`}
            description="Slow-mo start before final scoring touch"
            value={cfg.lastTouchSlowMoPreSeconds}
            min={0.0}
            max={2.0}
            step={0.05}
            unit="s"
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('lastTouchSlowMoPreSeconds', v)}
          />

          <SliderControl
            label={`Post-Last-Touch Window (${cfg.lastTouchSlowMoPostSeconds.toFixed(2)}s)`}
            description="Slow-mo hold after final scoring touch"
            value={cfg.lastTouchSlowMoPostSeconds}
            min={0.0}
            max={1.5}
            step={0.05}
            unit="s"
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('lastTouchSlowMoPostSeconds', v)}
          />

          <SliderControl
            label={`Last-Touch Speed Scale (${Math.round(cfg.lastTouchSlowMoScale * 100)}%)`}
            description="Playback speed multiplier during final touch plateau (1.0 = disable slow-mo)"
            value={cfg.lastTouchSlowMoScale}
            min={0.2}
            max={1.0}
            step={0.05}
            editable={true}
            showStepper={true}
            colorScheme="amber"
            isLight={isLight}
            onChange={(v) => handleParamChange('lastTouchSlowMoScale', v)}
          />

          <div className="flex items-center justify-between border-b border-neutral-700/30 pb-1 pt-1">
            <span className="text-[11px] font-semibold flex items-center gap-1.5 text-sky-400">
              <Clock className="h-3.5 w-3.5" />
              <span>2. Goal-Line Crossing Slow-Mo Window</span>
            </span>
          </div>

          <SliderControl
            label={`Pre-Goal-Line Window (${cfg.goalLineSlowMoPreSeconds.toFixed(2)}s)`}
            description="Slow-mo start before ball crosses the goal line"
            value={cfg.goalLineSlowMoPreSeconds}
            min={0.0}
            max={1.5}
            step={0.05}
            unit="s"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('goalLineSlowMoPreSeconds', v)}
          />

          <SliderControl
            label={`Post-Goal-Line Window (${cfg.goalLineSlowMoPostSeconds.toFixed(2)}s)`}
            description="Slow-mo hold after ball crosses the goal line"
            value={cfg.goalLineSlowMoPostSeconds}
            min={0.0}
            max={1.5}
            step={0.05}
            unit="s"
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('goalLineSlowMoPostSeconds', v)}
          />

          <SliderControl
            label={`Goal-Line Speed Scale (${Math.round(cfg.goalLineSlowMoScale * 100)}%)`}
            description="Playback speed multiplier during goal-line crossing plateau (1.0 = disable)"
            value={cfg.goalLineSlowMoScale}
            min={0.2}
            max={1.0}
            step={0.05}
            editable={true}
            showStepper={true}
            colorScheme="neutral"
            isLight={isLight}
            onChange={(v) => handleParamChange('goalLineSlowMoScale', v)}
          />
        </div>
      )}
    </div>
  );
};

export default ReplayDirectorTunerFloatingWindow;
