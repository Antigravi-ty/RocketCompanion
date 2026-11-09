/**
 * RLRCReplayUiAndHudBinder.ts
 * UI store handler binding, ReplayHotkeySubController wiring, upload notification helper,
 * POV slot selection resolver, and HUD match state synchronization for RLRCReplaySessionController.
 */

import {
  hudStore,
  useQuickNotificationStore,
  useReplayToRcsImporterStore,
} from '../../../game/runtimeUiPort.ts';
import type { ReplayHotkeySubController } from '../../ReplayHotkeySubController.ts';
import type { RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import type { RLRCFrame120Hz, RLRCPlayerSlotMeta, RLRCTeamIndex } from '../RLRCReplayTypes.ts';
import type { RLRCInterveneTakeoverSubController } from './RLRCInterveneTakeoverSubController.ts';
import type {
  RLRCPlaybackAudioEdgeSynthesizer,
  RLRCPlaybackAudioRuntimePort,
} from './RLRCPlaybackAudioEdgeSynthesizer.ts';
import type {
  RLRCPlaybackRuntimePort,
  RLRCPlaybackSyncApplier,
} from './RLRCPlaybackSyncApplier.ts';
import {
  downloadRcsReplayPack,
  mapUiNonPovMode,
  syncRLRCNameTagRoster,
} from './RLRCReplaySessionBridgePipeline.ts';

const CONFLICT_MSG =
  '[RLRCReplaySessionController] Replay Importer hotkeys (O/P/[/]/G) claimed by another window.';
const getSt = () => useReplayToRcsImporterStore.getState();
const setTelem: ReturnType<typeof getSt>['updateLiveTelemetry'] = (p) =>
  getSt().updateLiveTelemetry(p);

export interface RLRCSessionUiActionTarget {
  readonly runtime: unknown;
  readonly hasLoadedReplay: boolean;
  readonly session: RLRCConvertedReplaySession | null;
  handleUploadFile: (file: File) => Promise<void> | void;
  exportRcsReplayPack: () => Promise<void> | void;
  startPlaying: () => void;
  pausePlaying: () => void;
  seekFrame: (frameIndex120Hz: number) => void;
  selectPovSlot: (slotKey: number) => void;
  beginScrub: (direction: 'rewinding' | 'forwarding') => void;
  pauseScrub: () => void;
  resumeFromCursor: () => void;
  returnToReplay: () => void;
  handleInterpolationMethodChange: (method: string) => void;
  handleNonPovModeChange: (mode: string) => void;
  clearReplay: () => void;
}

export function bindRLRCSessionUiAndHotkeys(
  hotkeySubController: ReplayHotkeySubController,
  target: RLRCSessionUiActionTarget
): () => void {
  const onUploadRLReplayFile = (f: File) => void target.handleUploadFile(f);
  const onExportRcsReplayPack = () => void target.exportRcsReplayPack();
  const onStartPlaying = () => target.startPlaying();
  const onPausePlaying = () => target.pausePlaying();
  const onSeekFrame = (f: number) => target.seekFrame(f);
  const onSelectPovSlot = (k: number | null) => target.selectPovSlot(k ?? 1);
  const onPushBackwardStart = () => target.beginScrub('rewinding');
  const onPushBackwardStop = () => target.pauseScrub();
  const onPushForwardStart = () => target.beginScrub('forwarding');
  const onPushForwardStop = () => target.pauseScrub();
  const onResumeFromHere = () => target.resumeFromCursor();
  const onReturnToReplay = () => target.returnToReplay();
  const onInterpolationMethodChange = (m: string) => target.handleInterpolationMethodChange(m);
  const onNonPovInterventionModeChange = (m: string) => target.handleNonPovModeChange(m);
  const onClearReplay = () => target.clearReplay();

  getSt().setRuntimeHandlers({
    onUploadRLReplayFile,
    onExportRcsReplayPack,
    onStartPlaying,
    onPausePlaying,
    onSeekFrame,
    onSelectPovSlot,
    onPushBackwardStart,
    onPushBackwardStop,
    onPushForwardStart,
    onPushForwardStop,
    onResumeFromHere,
    onReturnToReplay,
    onInterpolationMethodChange,
    onNonPovInterventionModeChange,
    onClearReplay,
  });

  const getWindowStatus = () => ({
    isWindowOpen: Boolean(getSt().isWindowOpen),
    hasHotkeyPriority: Boolean(getSt().hasHotkeyPriority),
  });
  const getRuntime = () => target.runtime as Record<string, unknown> | null;
  const hasLoadedReplay = () => target.hasLoadedReplay;
  const hasFrames = () => Boolean(target.session && target.session.frames120Hz.length > 0);
  const onHotkeySelectPovSlot = (k: number) => target.selectPovSlot(k);
  const onResumeFromCursor = () => target.resumeFromCursor();
  const onBeginScrub = (dir: 'rewinding' | 'forwarding') => target.beginScrub(dir);
  const onPauseScrub = () => target.pauseScrub();

  hotkeySubController.bindReplayViewerHotkeys({
    getRuntime,
    hasLoadedReplay,
    hasFrames,
    getWindowStatus,
    conflictErrorMessage: CONFLICT_MSG,
    onSelectPovSlot: onHotkeySelectPovSlot,
    onStartPlaying,
    onPausePlaying,
    onResumeFromCursor,
    onBeginScrub,
    onPauseScrub,
  });

  return useReplayToRcsImporterStore.subscribe(() => {
    hotkeySubController.checkWindowOpenAndPriority(getWindowStatus(), CONFLICT_MSG);
  });
}

export function pushRLRCUploadNotification(
  id: 'rlrc-replay-loaded' | 'rlrc-replay-error',
  content: string,
  tone: 'info' | 'error',
  duration: number
): void {
  try {
    useQuickNotificationStore.getState().pushNotification({
      id,
      content,
      type: 'temporary',
      duration,
      tone,
    });
  } catch {
    /* ignore notification schema errors in headless environments */
  }
}

export async function executeRLRCFileUpload(
  file: File,
  loadReplayBuffer: (buf: ArrayBuffer, fileName: string) => void,
  getSession: () => RLRCConvertedReplaySession | null
): Promise<void> {
  setTelem({ isLoadingReplay: true, errorMessage: null });
  try {
    const buf = await file.arrayBuffer();
    loadReplayBuffer(buf, file.name);
    const s = getSession();
    pushRLRCUploadNotification(
      'rlrc-replay-loaded',
      `RL Replay Converted (120Hz): ${file.name} (${s?.frames120Hz.length ?? 0} frames, ${s?.roster.length ?? 0} players).`,
      'info',
      2800
    );
  } catch (err) {
    const errorMessage = `Failed to parse .replay: ${err instanceof Error ? err.message : String(err)}`;
    setTelem({ isLoadingReplay: false, errorMessage });
    pushRLRCUploadNotification('rlrc-replay-error', errorMessage, 'error', 3600);
  }
}

export async function executeRLRCExportPack(
  session: RLRCConvertedReplaySession | null
): Promise<void> {
  if (!session) return;
  setTelem({ isExportingRcsPack: true });
  try {
    await downloadRcsReplayPack(session, getSt().loadedFileName);
  } finally {
    setTelem({ isExportingRcsPack: false });
  }
}

export function resolveSelectedPovSlotState(
  playbackApplier: RLRCPlaybackSyncApplier,
  roster: readonly RLRCPlayerSlotMeta[],
  simPort: RLRCPlaybackRuntimePort | null,
  slotKey: number
): {
  readonly slot: number;
  readonly localTeam: RLRCTeamIndex;
  readonly activePovSlotKey: 1 | 2 | 3 | 4 | 5 | 6;
} | null {
  const resolved = playbackApplier.resolvePovSlotForHudKey(slotKey, simPort);
  const idx = Math.max(0, Math.min(5, Math.round(slotKey) - 1));
  const meta =
    (resolved ? roster.find((r) => r.slotIndex === resolved.slotIndex) : undefined) ??
    roster.find((r) => r.slotIndex === idx) ??
    roster[0];
  if (!meta) return null;
  const slot = meta.slotIndex;
  const localTeam: RLRCTeamIndex = meta.team === 1 ? 1 : 0;
  const activePovSlotKey = resolved?.slotKey ?? playbackApplier.getSlotKeyForCarIndex(slot);
  syncRLRCNameTagRoster(roster, slot);
  hudStore.getState().setMatchState({ localTeam });
  setTelem({
    activePovCarIndex: slot,
    activePovSlotKey,
    activePovTeam: localTeam,
  });
  return { slot, localTeam, activePovSlotKey };
}

export function triggerRLRCInterveneFromCursor(
  session: RLRCConvertedReplaySession | null,
  cursorFrame120Hz: number,
  activePovSlotIndex: number,
  isIntervening: boolean,
  audioEdgeSynthesizer: RLRCPlaybackAudioEdgeSynthesizer,
  interveneController: RLRCInterveneTakeoverSubController
): void {
  if (!session || session.frames120Hz.length === 0) return;
  const st = getSt();
  audioEdgeSynthesizer.reset();
  const opts = {
    povSlotIndex: activePovSlotIndex,
    nonPovMode: mapUiNonPovMode(st.nonPovInterventionMode),
    downCounterSeconds: st.downCounterSec,
  };
  if (isIntervening) interveneController.reinterveneAtLastTargetFrame(opts);
  else interveneController.enterInterveneAtFrame(cursorFrame120Hz, opts);
}

export function resetClearedReplayTelemetry(): void {
  setTelem({
    viewerState: 'idle',
    loadedFileName: null,
    totalFrames: 0,
    cursorFrame: 0,
    targetFrame: 0,
    incidentMarkers: [],
    signalMarkers: [],
    trackDeltaSummary: null,
    errorMessage: null,
  });
}

export function syncRLRCHudMatchState(
  f: RLRCFrame120Hz,
  roster: readonly RLRCPlayerSlotMeta[],
  activePovSlotIndex: number,
  prevHudKey: string
): string {
  const meta = roster.find((r) => r.slotIndex === activePovSlotIndex) ?? roster[0];
  const localTeam: RLRCTeamIndex = meta?.team === 1 ? 1 : 0;
  const isOvertime = Boolean(f.isOvertime);
  const blueScore = Math.max(0, f.blueScore | 0);
  const orangeScore = Math.max(0, f.orangeScore | 0);
  const sec = Math.max(0, Math.round(f.secondsRemaining || 0));
  const kickoffCountdown = Math.max(0, Math.min(3, f.roundCountdownNumber | 0));
  const remainingSeconds = isOvertime ? 0 : sec;
  const overtimeSeconds = isOvertime ? sec : 0;
  const key = [
    localTeam,
    blueScore,
    orangeScore,
    remainingSeconds,
    overtimeSeconds,
    isOvertime,
    kickoffCountdown,
  ].join('|');
  if (key === prevHudKey) return prevHudKey;

  hudStore.getState().setMatchState({
    localTeam,
    blueScore,
    orangeScore,
    remainingSeconds,
    overtimeSeconds,
    isOvertime,
    kickoffCountdown,
    matchPhase: kickoffCountdown > 0 ? 'kickoff' : 'playing',
  });
  return key;
}

export function applyRLRCFrameToSubsystems(params: {
  readonly session: RLRCConvertedReplaySession | null;
  readonly idx: number;
  readonly smoothStep: boolean;
  readonly activePovSlotIndex: number;
  readonly simPort: unknown;
  readonly playbackApplier: RLRCPlaybackSyncApplier;
  readonly audioEdgeSynthesizer: RLRCPlaybackAudioEdgeSynthesizer;
  readonly prevHudKey: string;
}): string {
  const {
    session,
    idx,
    smoothStep,
    activePovSlotIndex,
    simPort,
    playbackApplier,
    audioEdgeSynthesizer,
    prevHudKey,
  } = params;
  const f = session?.frames120Hz[idx];
  if (!f) return prevHudKey;
  playbackApplier.applyFrame120Hz(f, simPort as RLRCPlaybackRuntimePort, {
    smoothStep,
    activePovSlotIndex,
  });
  audioEdgeSynthesizer.stepFrame(f, {
    smoothStep,
    activePovSlotIndex,
    runtime: simPort as RLRCPlaybackAudioRuntimePort,
    bookmarks: session?.bookmarks ?? [],
  });
  return syncRLRCHudMatchState(f, session?.roster ?? [], activePovSlotIndex, prevHudKey);
}

export function stepRLRCPlaybackCursor(params: {
  readonly state: string;
  readonly effectiveFlowPct: number;
  readonly maxF: number;
  readonly prevFrac: number;
  readonly prevCursor: number;
  readonly prevTick: number;
  readonly applyFrame: (idx: number, smoothStep: boolean) => void;
  readonly pausePlaying: () => void;
}): {
  readonly stepped: boolean;
  readonly frac: number;
  readonly cursorFrame120Hz: number;
  readonly tick: number;
} {
  const {
    state,
    effectiveFlowPct,
    maxF,
    prevFrac,
    prevCursor,
    prevTick,
    applyFrame,
    pausePlaying,
  } = params;
  if (state !== 'playing' && state !== 'forwarding' && state !== 'rewinding') {
    return { stepped: false, frac: prevFrac, cursorFrame120Hz: prevCursor, tick: prevTick };
  }
  const spd = Math.max(0.01, (Number(effectiveFlowPct) || 100) / 100);
  const dir = state === 'rewinding' ? -1 : 1;
  const frac = Math.max(
    0,
    Math.min(maxF, prevFrac + dir * (state === 'playing' ? spd : Math.max(1.5, spd * 2)))
  );
  const next = Math.round(frac);
  let tick = prevTick;
  if (next !== prevCursor) {
    applyFrame(next, dir > 0);
    const done = (dir > 0 && next >= maxF) || (dir < 0 && next <= 0);
    tick = (prevTick + 1) & 3;
    if (done || tick === 0) setTelem({ cursorFrame: next, targetFrame: next });
    if (done) pausePlaying();
  }
  return { stepped: true, frac, cursorFrame120Hz: next, tick };
}
