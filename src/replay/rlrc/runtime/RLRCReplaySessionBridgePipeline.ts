/**
 * RLRCReplaySessionBridgePipeline.ts
 * Pure telemetry formatting, binary pack download helper, POV slot resolver,
 * and HUD match-state synchronization for RLRCReplaySessionController.
 */

import type { BoostPadDescriptor } from '../../../ai/experimental/experimentalMultiCarObsPipeline.ts';
import {
  hudStore,
  setNameTagRuntimeState,
  useReplayToRcsImporterStore,
} from '../../../game/runtimeUiPort.ts';
import { packAndCompressReplayInBackground } from '../../container/RCReplayCompressionWorkerClient.ts';
import type { ReplayScoreboardRuntimePort } from '../../ReplayScoreboardSynchronizer.ts';
import type { RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import type {
  RLRCFrame120Hz,
  RLRCInterpolationMethod,
  RLRCNonPovInterventionMode,
  RLRCPlayerSlotMeta,
  RLRCSynthesizedCarControls,
  RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import { DEFAULT_NEUTRAL_CAR_CONTROLS } from './RLRCInterveneFrameStateBuilder.ts';

export interface RLRCBridgeInputDevicePort {
  readonly controls?: Partial<RLRCSynthesizedCarControls>;
  readonly active?: () => boolean;
  readonly read?: () => Partial<RLRCSynthesizedCarControls> | null | undefined;
  readonly getControls?: (carIdx?: number) => Partial<RLRCSynthesizedCarControls> | null | undefined;
}

export interface RLRCBridgeBotCoordinatorPort {
  readonly runtime?: { readonly bot?: { readonly id?: string } | null } | null;
  readonly resetBotState?: () => void;
  readonly resetAllBots?: () => void;
  readonly decideControlsForSlot?: (
    slotIndex: number,
    team: RLRCTeamIndex,
    state: Float32Array,
    dt: number
  ) => Partial<RLRCSynthesizedCarControls> | null | undefined;
}

export interface RLRCBridgeRuntimePort {
  readonly playerControls?: Partial<RLRCSynthesizedCarControls> | null;
  readonly keyboard?: RLRCBridgeInputDevicePort | null;
  readonly gamepad?: RLRCBridgeInputDevicePort | null;
  readonly botCoordinator?: RLRCBridgeBotCoordinatorPort | null;
  readonly physics?: {
    readonly isCarSlotActive?: (slotIndex: number) => boolean;
    readonly getPads?: () => ReadonlyArray<BoostPadDescriptor>;
  } | null;
}

export function normalizeSynthesizedControls(
  raw: Partial<RLRCSynthesizedCarControls> | null | undefined
): RLRCSynthesizedCarControls {
  if (!raw) return DEFAULT_NEUTRAL_CAR_CONTROLS;
  return {
    throttle: Number(raw.throttle) || 0,
    steer: Number(raw.steer) || 0,
    pitch: Number(raw.pitch) || 0,
    yaw: Number(raw.yaw) || 0,
    roll: Number(raw.roll) || 0,
    jump: Boolean(raw.jump),
    boost: Boolean(raw.boost),
    handbrake: Boolean(raw.handbrake),
  };
}

function isNonNeutralControls(raw: Partial<RLRCSynthesizedCarControls> | null | undefined): boolean {
  return Boolean(
    raw &&
      (Number(raw.throttle) ||
        Number(raw.steer) ||
        Number(raw.pitch) ||
        Number(raw.yaw) ||
        Number(raw.roll) ||
        raw.jump ||
        raw.boost ||
        raw.handbrake)
  );
}

export function mapUiInterpolationMethod(raw: string): RLRCInterpolationMethod {
  return raw === 'linear' || raw === 'linear-slerp' ? 'linear' : 'hermite-clamped';
}

export function mapUiNonPovMode(raw: string): RLRCNonPovInterventionMode {
  if (raw === 'disappear') return 'disappear';
  if (raw === 'no-input') return 'no-input';
  if (raw === 'nexto' || raw === 'necto' || raw === 'bot-takeover') return 'bot-takeover';
  return 'follow-state';
}

export function syncRLRCNameTagRoster(
  roster: readonly RLRCPlayerSlotMeta[],
  activePovSlotIndex: number = roster[0]?.slotIndex ?? 0
): void {
  setNameTagRuntimeState({
    isMultiplayerOrMultiCarMode: roster.length > 1,
    focusedCarIndex: activePovSlotIndex,
    carEntries: roster.map((r) => ({
      carIndex: r.slotIndex,
      name: r.userName,
      username: r.userName,
      team: r.team,
      isBot: false,
      isLocalPlayer: r.slotIndex === activePovSlotIndex,
    })),
  });
}

export function resolveRLRCPovSlotSelection(
  roster: readonly RLRCPlayerSlotMeta[],
  slotKey: number,
  runtime: ReplayScoreboardRuntimePort | null
): { key: number; meta: RLRCPlayerSlotMeta; slot: number; povTeam: RLRCTeamIndex } | null {
  const key = Math.max(1, Math.min(6, Math.round(slotKey)));
  const mappedSlot = (runtime as { _lastHudSlotCarMap?: Record<number, number> } | null)
    ?._lastHudSlotCarMap?.[key];
  const teamTarget: RLRCTeamIndex = key <= 3 ? 0 : 1;
  const teamOffset = key <= 3 ? key - 1 : key - 4;
  const teamRoster = roster.filter((r) => r.team === teamTarget);
  const meta =
    (typeof mappedSlot === 'number'
      ? roster.find((r) => r.slotIndex === mappedSlot)
      : undefined) ??
    teamRoster[teamOffset] ??
    roster.find((r) => r.slotIndex === key - 1) ??
    roster[0];
  if (!meta) return null;
  return {
    key,
    meta,
    slot: meta.slotIndex,
    povTeam: meta.team === 1 ? 1 : 0,
  };
}

export function syncRLRCFrameHudMatchState(
  frame: RLRCFrame120Hz,
  roster: readonly RLRCPlayerSlotMeta[],
  activePovSlotIndex: number,
  isIntervening: boolean,
  prevHudKey: string
): string {
  const meta = roster.find((r) => r.slotIndex === activePovSlotIndex) ?? roster[0];
  const localTeam: RLRCTeamIndex = isIntervening && meta?.team === 1 ? 1 : 0;
  const isOvertime = Boolean(frame.isOvertime);
  const blueScore = Math.max(0, frame.blueScore | 0);
  const orangeScore = Math.max(0, frame.orangeScore | 0);
  const sec = Math.max(0, Math.round(frame.secondsRemaining || 0));
  const kickoffCountdown = Math.max(0, Math.min(3, frame.roundCountdownNumber | 0));
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

export function readLiveRuntimePlayerControls(
  runtime: ReplayScoreboardRuntimePort | null,
  activePovSlotIndex: number
): RLRCSynthesizedCarControls {
  if (!runtime) return DEFAULT_NEUTRAL_CAR_CONTROLS;
  const bridgeRuntime = runtime as unknown as RLRCBridgeRuntimePort;
  const livePlayerControls = bridgeRuntime.playerControls;
  if (isNonNeutralControls(livePlayerControls)) {
    return normalizeSynthesizedControls(livePlayerControls);
  }

  const pad = bridgeRuntime.gamepad;
  const padCandidate =
    pad?.getControls?.(activePovSlotIndex) ??
    (pad?.active?.() ? (pad.controls ?? pad.read?.()) : undefined);
  if (isNonNeutralControls(padCandidate)) return normalizeSynthesizedControls(padCandidate);

  const kb = bridgeRuntime.keyboard;
  const kbCandidate = kb?.getControls?.(activePovSlotIndex) ?? kb?.read?.() ?? kb?.controls;
  if (isNonNeutralControls(kbCandidate)) return normalizeSynthesizedControls(kbCandidate);

  return normalizeSynthesizedControls(livePlayerControls);
}

export function publishConvertedSessionTelemetry(
  converted: RLRCConvertedReplaySession,
  fileName: string,
  clampedCursor: number,
  activePovSlotIndex: number
): void {
  syncRLRCNameTagRoster(converted.roster, activePovSlotIndex);
  const totalFrames = Math.max(0, converted.frames120Hz.length - 1);
  const incidentMarkers = converted.bookmarks
    .filter((b) => b.kind === 'goal' || b.kind === 'demolish')
    .map((b) => ({
      frameIndex: b.frameIndex120Hz,
      type: b.kind === 'goal' ? 0x0e : 0x03,
      carIndex: Math.max(0, b.slotIndex),
      team: (b.team === 1 ? 1 : 0) as 0 | 1,
      label: b.label,
    }));

  const signalMarkers = converted.bookmarks
    .filter((b) => b.kind === 'user-mark' || b.kind === 'kickoff' || b.kind === 'ue-keyframe')
    .map((b) => ({
      frameIndex: b.frameIndex120Hz,
      type: b.kind === 'user-mark' ? 0x91 : 0x87,
      param1: b.sourceFrame30Hz,
      param2: b.slotIndex,
      synthesized: false,
      label: b.label,
    }));

  useReplayToRcsImporterStore.getState().updateLiveTelemetry({
    viewerState: 'paused',
    loadedFileName: fileName,
    totalFrames,
    sourceFrameCount: converted.header.sourceFrameCount,
    sourceRecordFps: converted.header.recordFps,
    cursorFrame: clampedCursor,
    targetFrame: clampedCursor,
    stateTrackCount: converted.frames120Hz.length,
    incidentTrackCount: incidentMarkers.length,
    signalTrackCount: signalMarkers.length,
    recordedSignalCount: signalMarkers.length,
    synthesizedSignalCount: 0,
    incidentMarkers,
    signalMarkers,
    trackDeltaSummary: {
      part1CrcValid: converted.header.part1CrcValid,
      part2CrcValid: converted.header.part2CrcValid,
      replayId: converted.header.replayId,
      mapName: converted.header.mapName,
      date: converted.header.date,
      sourceFrameCount: converted.header.sourceFrameCount,
      upsampledFrameCount: converted.frames120Hz.length,
      mappedPropertyCount: converted.roster.length,
      trackDeltaOnlyPropertyCount: converted.bookmarks.length,
      unmappedPropertyNames: converted.roster.map(
        (r) => `[Slot ${r.slotIndex + 1}] ${r.userName} (${r.visualId} / ${r.hitboxId})`
      ),
    },
    activePovCarIndex: activePovSlotIndex,
    activePovSlotKey: activePovSlotIndex + 1,
    activePovTeam: converted.roster[activePovSlotIndex]?.team ?? 0,
    isLoadingReplay: false,
    errorMessage: null,
  });
}

export async function downloadRcsReplayPack(
  session: RLRCConvertedReplaySession,
  loadedFileName: string | null
): Promise<void> {
  const rosterMeta = session.roster.map((r) => ({
    carIndex: r.slotIndex,
    entityId: r.slotIndex,
    team: r.team,
    name: r.userName,
    username: r.userName,
    visualId: r.visualId,
    hitboxId: r.hitboxId,
    ...(r.primaryColorHex ? { colorHex: r.primaryColorHex } : {}),
  }));
  const incidents = session.bookmarks
    .filter((b) => b.kind === 'goal' || b.kind === 'demolish')
    .map((b) => ({
      type: b.kind === 'goal' ? 0x0e : 0x03,
      tick: b.frameIndex120Hz,
      frameIndex: b.frameIndex120Hz,
      carIndex: Math.max(0, b.slotIndex),
      team: b.team === 1 ? 1 : 0,
    }));

  const packed = await packAndCompressReplayInBackground({
    mode: 'match',
    tickRate: 120,
    durationSeconds: Math.round(session.header.durationSeconds || 300),
    winner: session.header.orangeScore > session.header.blueScore ? 'orange' : 'blue',
    blueScore: session.header.blueScore,
    orangeScore: session.header.orangeScore,
    roster: rosterMeta,
    loadouts: rosterMeta,
    stateInputBytes: session.containerPacket.stateInputTrackBytes,
    incidents,
  });

  if (typeof document !== 'undefined') {
    const baseName = (loadedFileName || 'replay').replace(/\.(replay|rcreplay\.gz|rcreplay|rlrc)$/i, '');
    const ext = packed.compressed ? '.rcreplay.gz' : '.rcreplay';
    const blob = new Blob([packed.buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}
