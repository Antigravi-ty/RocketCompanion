/**
 * ReplayFileExporter.ts
 * Manages full-match 448-float + 8-car controls + 64B Incident + 64B Signal RC Replay retention,
 * V2 Multi-Track Chunked Binary Container (.rcreplay.gz) background GZIP export with spinning UI feedback,
 * persistent post-match QuickNotification lifecycle, and multi-timeline file parsing for the Replay Viewer.
 */

import { STATE_BUFFER_FLOATS } from '../physics/RocketSimConstants.ts';
import {
  useQuickNotificationStore,
  useReplayViewerStore,
} from '../game/runtimeUiPort.ts';
import {
  RC_REPLAY_MAGIC_V2,
  RC_REPLAY_VERSION_V2,
  RC_REPLAY_STATE_INPUT_STRIDE,
  isBinaryRCReplayContainer,
  type DecodedReplayFrameSlot,
  type DecodedIncidentEvent,
  type DecodedSignalEvent,
  type ReplaySnapshotFloat32Array,
} from './container/RCReplayBinarySchema.ts';
import {
  normalizeReplayTracksPayload,
  type NormalizedReplayTracksPayload,
} from './container/RCReplayBinaryEncoder.ts';
import {
  deserializeRCReplayBinaryContainerAsync,
} from './container/RCReplayBinaryDecoder.ts';
import { materializeFramesFromBinaryTracks } from './container/RCReplayTrackMaterializer.ts';
import { packAndCompressReplayInBackground } from './container/RCReplayCompressionWorkerClient.ts';

export const MATCH_REPLAY_NOTIFICATION_ID = 'match-replay-export';
export const MATCH_REPLAY_SAVING_TASK_ID = 'match-replay-saving-task';
export const MAX_MATCH_REPLAY_FRAMES = 100800; // Up to 14 minutes (5+7m OT) @ 120Hz

export interface RetainedMatchReplay {
  magic: string;
  version: number;
  stateFloats: number;
  tickRate: number;
  frameCount: number;
  incidentCount?: number;
  signalCount?: number;
  durationSec: number;
  durationSeconds: number;
  winner: string;
  blueScore: number;
  orangeScore: number;
  winReason?: number;
  mode: string;
  gameMode?: string;
  arenaPreset: number;
  roster: Array<Record<string, unknown>>;
  loadouts: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown> | null;
  createdAtIso: string;
  frames: ReplaySnapshotFloat32Array[];
  frameSlots?: DecodedReplayFrameSlot[];
  slots?: Array<Record<string, unknown>>;
  incidents?: DecodedIncidentEvent[];
  signals?: DecodedSignalEvent[];
  timelines?: Record<string, unknown>;
  stateInputBytes?: Uint8Array;
  incidentBytes?: Uint8Array;
  signalBytes?: Uint8Array;
  [key: string]: unknown;
}

export type ReplayRawFrameSlotItem =
  | Float32Array
  | {
      tick?: number;
      snapshot?: Float32Array | null;
      compactSnap?: Float32Array | null;
      renderState?: Float32Array | null;
      controls?: unknown;
      acknowledgedControls?: unknown;
      incidents?: Array<Record<string, unknown>>;
      signals?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

export interface RetainCompletedMatchReplayOptions {
  stateFloats?: number;
  stateInputBytes?: Uint8Array;
  incidentBytes?: Uint8Array;
  signalBytes?: Uint8Array;
  engine?: {
    extractWasmReplayTracks?: () => NormalizedReplayTracksPayload;
    getReplayFrameCount?: () => number;
  } | null;
  packedFrames?: Float32Array | null;
  frames?: Array<ReplayRawFrameSlotItem | null>;
  ringBuffer?: {
    getRecentFrames?: () => Array<ReplayRawFrameSlotItem | null>;
    _slots?: Array<ReplayRawFrameSlotItem | null | undefined>;
    size?: number;
    getFrameAt?: (idx: number) => ReplayRawFrameSlotItem | null | undefined;
  } | null;
  fallbackState?: Float32Array | null;
  incidents?: Array<Record<string, unknown>>;
  signals?: Array<Record<string, unknown>>;
  winner?: string;
  winnerTeam?: number | string;
  blueScore?: number;
  orangeScore?: number;
  winReason?: number;
  mode?: string;
  gameMode?: string;
  arenaPreset?: number;
  durationSeconds?: number;
  roster?: Array<Record<string, unknown>> | { players?: Array<Record<string, unknown>> } | null;
  loadouts?: Array<Record<string, unknown>>;
  createdAtIso?: string;
  suppressNotification?: boolean;
}

let _retainedMatchReplay: RetainedMatchReplay | null = null;
let _isExportingReplay = false;

/**
 * Retains a completed match's full 3-track replay data (State+Input, Incidents, Signals)
 * in host/local memory until the next match starts, and triggers a persistent QuickNotification
 * allowing compressed V2 Binary RC Replay export at any time.
 */
export function retainCompletedMatchReplayAndNotify(
  options: RetainCompletedMatchReplayOptions = {}
): RetainedMatchReplay | null {
  const floatsPerFrame = Number(options.stateFloats) || STATE_BUFFER_FLOATS;
  let tracks: NormalizedReplayTracksPayload | null = null;

  if (
    options.stateInputBytes instanceof Uint8Array &&
    options.stateInputBytes.byteLength >= RC_REPLAY_STATE_INPUT_STRIDE
  ) {
    tracks = normalizeReplayTracksPayload({
      stateInputBytes: options.stateInputBytes,
      incidentBytes: options.incidentBytes,
      signalBytes: options.signalBytes,
    });
  } else if (
    options.engine &&
    typeof options.engine.extractWasmReplayTracks === 'function' &&
    (options.engine.getReplayFrameCount?.() ?? 0) > 0
  ) {
    tracks = options.engine.extractWasmReplayTracks();
  } else if (options.packedFrames instanceof Float32Array && options.packedFrames.length >= floatsPerFrame) {
    const count = Math.floor(options.packedFrames.length / floatsPerFrame);
    const rawSlots = new Array(count);
    for (let i = 0; i < count; i++) {
      const snap = new Float32Array(STATE_BUFFER_FLOATS);
      const slice = options.packedFrames.subarray(i * floatsPerFrame, (i + 1) * floatsPerFrame);
      snap.set(slice.subarray(0, Math.min(slice.length, STATE_BUFFER_FLOATS)));
      rawSlots[i] = { tick: Math.floor(snap[0] || i), snapshot: snap };
    }
    tracks = normalizeReplayTracksPayload({
      slots: rawSlots,
      incidents: options.incidents,
      signals: options.signals,
    });
  } else {
    let rawFrames: ReplayRawFrameSlotItem[] = [];
    if (Array.isArray(options.frames) && options.frames.length > 0) {
      rawFrames = options.frames.filter((f): f is ReplayRawFrameSlotItem => f !== null);
    } else if (options.ringBuffer && typeof options.ringBuffer.getRecentFrames === 'function') {
      rawFrames = options.ringBuffer.getRecentFrames().filter((f): f is ReplayRawFrameSlotItem => f !== null);
    } else if (Array.isArray(options.ringBuffer?._slots) && (options.ringBuffer.size ?? 0) > 0) {
      for (let i = 0; i < (options.ringBuffer.size ?? 0); i++) {
        const slot = options.ringBuffer.getFrameAt?.(i);
        if (slot) rawFrames.push(slot);
      }
    }

    if (rawFrames.length === 0 && options.fallbackState instanceof Float32Array) {
      console.warn(
        '[ReplayFileExporter] Replay ring buffer and frame tracks were empty; falling back to single-frame fallbackState snapshot.'
      );
      const snap = new Float32Array(STATE_BUFFER_FLOATS);
      snap.set(options.fallbackState.subarray(0, Math.min(options.fallbackState.length, STATE_BUFFER_FLOATS)));
      rawFrames.push({ tick: Math.floor(snap[0] || 0), snapshot: snap });
    }

    if (rawFrames.length > 0) {
      tracks = normalizeReplayTracksPayload({
        slots: rawFrames,
        incidents: options.incidents,
        signals: options.signals,
      });
    }
  }

  if (!tracks || tracks.frameCount === 0) return null;

  let winner = options.winner;
  if (!winner) {
    if (options.winnerTeam === 0 || options.winnerTeam === 'BLUE' || options.winnerTeam === 'blue') {
      winner = 'blue';
    } else if (options.winnerTeam === 1 || options.winnerTeam === 'ORANGE' || options.winnerTeam === 'orange') {
      winner = 'orange';
    } else if (options.winnerTeam === 2 || options.winnerTeam === 'DRAW' || options.winnerTeam === 'draw') {
      winner = 'draw';
    } else {
      const b = Number(options.blueScore ?? 0);
      const o = Number(options.orangeScore ?? 0);
      winner = b > o ? 'blue' : o > b ? 'orange' : 'draw';
    }
  } else {
    winner = String(winner).toLowerCase();
  }

  const blueScore = Number(options.blueScore ?? 0);
  const orangeScore = Number(options.orangeScore ?? 0);
  const mode = options.mode || options.gameMode || 'exhibition';
  const createdAtIso = options.createdAtIso || new Date().toISOString();

  const materialized = materializeFramesFromBinaryTracks(tracks, {
    mode,
    winner,
    blueScore,
    orangeScore,
    winReason: options.winReason ?? 0,
    durationSeconds: options.durationSeconds ?? 300,
  });

  const normalizedRoster = Array.isArray(options.roster)
    ? options.roster
    : Array.isArray(options.roster?.players)
      ? options.roster.players
      : [];
  const normalizedLoadouts = Array.isArray(options.loadouts)
    ? options.loadouts
    : normalizedRoster;

  useReplayViewerStore.getState().updateLiveTelemetry({ hasRetainedMatch: true });
  _retainedMatchReplay = {
    magic: RC_REPLAY_MAGIC_V2,
    version: RC_REPLAY_VERSION_V2,
    stateFloats: STATE_BUFFER_FLOATS,
    tickRate: 120,
    frameCount: tracks.frameCount,
    incidentCount: tracks.incidentCount,
    signalCount: tracks.signalCount,
    durationSec: Number((tracks.frameCount / 120).toFixed(2)),
    durationSeconds: options.durationSeconds ?? 300,
    winner,
    blueScore,
    orangeScore,
    winReason: options.winReason ?? 0,
    mode,
    arenaPreset: options.arenaPreset ?? 0,
    roster: normalizedRoster,
    loadouts: normalizedLoadouts,
    createdAtIso,
    frames: materialized.frames,
    frameSlots: materialized.frameSlots,
    incidents: materialized.incidents,
    signals: materialized.signals,
    timelines: materialized.timelines,
    stateInputBytes: tracks.stateInputBytes,
    incidentBytes: tracks.incidentBytes,
    signalBytes: tracks.signalBytes,
  };

  if (options.suppressNotification) {
    return _retainedMatchReplay;
  }

  const winnerLabel =
    winner === 'blue' ? 'Blue Wins' : winner === 'orange' ? 'Orange Wins' : 'Match Complete';

  try {
    useQuickNotificationStore.getState().pushNotification({
      id: MATCH_REPLAY_NOTIFICATION_ID,
      type: 'persistent',
      tone: 'info',
      icon: 'download',
      duration: 0,
      content: `${winnerLabel} (${blueScore}-${orangeScore}) · Export RC Replay (${_retainedMatchReplay.durationSec}s)?`,
      buttons: [
        {
          key: 'export-rcreplay',
          label: 'Export .rcreplay.gz',
          icon: 'download',
          color: 'sky',
          dismissOnClick: false,
          onClick: () => {
            exportRetainedMatchReplayFile();
          },
        },
      ],
    });
  } catch (err) {
    console.warn('[ReplayFileExporter] Failed to push persistent replay notification:', err);
  }

  return _retainedMatchReplay;
}

/**
 * Returns the currently retained match replay buffer (if any).
 */
export function getRetainedMatchReplay(): RetainedMatchReplay | null {
  return _retainedMatchReplay;
}

/**
 * Clears the retained match replay buffer and dismisses the persistent notification.
 * Called ONLY when the next match begins.
 */
export function clearRetainedMatchReplayOnMatchStart(): void {
  _retainedMatchReplay = null;
  useReplayViewerStore.getState().updateLiveTelemetry({ hasRetainedMatch: false });
  try {
    useQuickNotificationStore.getState().dismissNotification(MATCH_REPLAY_NOTIFICATION_ID);
  } catch (err) {
    console.warn('[ReplayFileExporter] Failed to dismiss match replay notification:', err);
  }
}

/**
 * Asynchronously packs and GZIP-compresses the replay in a background Worker (without blocking the main thread),
 * shows a spinning ongoing status in the foreground UI while saving, and triggers browser download.
 */
export async function exportRetainedMatchReplayFile(
  replayObj: RetainedMatchReplay | null = _retainedMatchReplay
): Promise<boolean> {
  if (!replayObj) return false;
  const hasFrames = Array.isArray(replayObj.frames) && replayObj.frames.length > 0;
  const hasRawTracks =
    replayObj.stateInputBytes instanceof Uint8Array &&
    replayObj.stateInputBytes.byteLength >= RC_REPLAY_STATE_INPUT_STRIDE;
  if (!hasFrames && !hasRawTracks) return false;
  if (_isExportingReplay) return false;

  _isExportingReplay = true;
  const notifStore = useQuickNotificationStore.getState();

  try {
    notifStore.pushOngoingNotification({
      id: MATCH_REPLAY_SAVING_TASK_ID,
      content: 'Saving & compressing RC Replay (.rcreplay.gz) in background...',
      icon: 'loader-2',
      isSpinningIcon: true,
      tone: 'info',
    });
  } catch (err) {
    console.warn('[ReplayFileExporter] Failed to push ongoing export notification:', err);
  }

  try {
    const packedResult = await packAndCompressReplayInBackground(replayObj);
    const stamp = (replayObj.createdAtIso || new Date().toISOString())
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const modeSlug = replayObj.mode || replayObj.gameMode || 'match';
    const bScore = replayObj.blueScore ?? 0;
    const oScore = replayObj.orangeScore ?? 0;
    const baseFilename = `rc-replay-${modeSlug}-${bScore}-${oScore}-${stamp}`;

    const isGzip = Boolean(packedResult.compressed);
    const filename = isGzip ? `${baseFilename}.rcreplay.gz` : `${baseFilename}.rcreplay`;
    const mimeType = isGzip ? 'application/gzip' : 'application/octet-stream';
    const blob = new Blob([packedResult.buffer], { type: mimeType });

    if (typeof document !== 'undefined') {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    const kbSize = ((packedResult.compressedByteLength || blob.size) / 1024).toFixed(1);
    try {
      notifStore.completeOngoingNotification(MATCH_REPLAY_SAVING_TASK_ID, {
        content: `RC Replay saved (${kbSize} KB)`,
        icon: 'check-circle-2',
        tone: 'success',
        autoDismissMs: 2200,
      });
    } catch (err) {
      console.warn('[ReplayFileExporter] Failed to complete ongoing export notification:', err);
    }

    return true;
  } catch (err) {
    console.warn('[ReplayFileExporter] Background replay export failed:', err);
    try {
      notifStore.dismissOngoingNotification(MATCH_REPLAY_SAVING_TASK_ID);
    } catch (dismissErr) {
      console.warn('[ReplayFileExporter] Failed to dismiss ongoing export notification after failure:', dismissErr);
    }
    return false;
  } finally {
    _isExportingReplay = false;
  }
}

export interface ParsedRCReplayResult {
  version?: number; metadata?: Record<string, unknown> | null;
  frames: ReplaySnapshotFloat32Array[]; frameSlots?: DecodedReplayFrameSlot[];
  timelines?: Record<string, unknown>; [key: string]: unknown;
}

export interface ExportStateReplayOptions {
  roster?: Array<Record<string, unknown>>; loadouts?: Array<Record<string, unknown>>;
  durationSeconds?: number; winner?: string; blueScore?: number; orangeScore?: number;
  arenaPreset?: number; mode?: string;
}

/**
 * Parses an uploaded .rcreplay.gz or .rcreplay File/ArrayBuffer into
 * 3 parallel timelines (State+Input, Incidents, Signals) and per-frame snapshots + slots.
 */
export async function parseRCReplayFile(
  fileOrBuffer: ArrayBuffer | Uint8Array | Blob | { arrayBuffer?: () => Promise<ArrayBuffer> } | unknown,
): Promise<ParsedRCReplayResult> {
  const buf: ArrayBuffer | null =
    fileOrBuffer instanceof ArrayBuffer
      ? fileOrBuffer
      : fileOrBuffer instanceof Uint8Array
      ? (fileOrBuffer.buffer.slice(
          fileOrBuffer.byteOffset,
          fileOrBuffer.byteOffset + fileOrBuffer.byteLength
        ) as ArrayBuffer)
      : typeof (fileOrBuffer as { arrayBuffer?: () => Promise<ArrayBuffer> })?.arrayBuffer === 'function'
      ? await (fileOrBuffer as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()
      : null;

  if (!buf || buf.byteLength === 0) {
    throw new Error('Empty replay file.');
  }

  const headerBytes = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  const isGzip = headerBytes.length >= 2 && headerBytes[0] === 0x1f && headerBytes[1] === 0x8b;

  let rawBuffer = buf;
  if (isGzip) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Browser does not support GZIP DecompressionStream.');
    }
    const ds = new DecompressionStream('gzip');
    if (typeof Blob !== 'undefined' && typeof Blob.prototype.stream === 'function') {
      const decompressedStream = new Blob([buf]).stream().pipeThrough(ds);
      rawBuffer = await new Response(decompressedStream).arrayBuffer();
    } else {
      const readPromise = new Response(ds.readable).arrayBuffer();
      const writer = ds.writable.getWriter();
      await writer.write(new Uint8Array(buf));
      await writer.close();
      rawBuffer = await readPromise;
    }
  }

  if (isBinaryRCReplayContainer(rawBuffer)) {
    return (await deserializeRCReplayBinaryContainerAsync(rawBuffer)) as unknown as ParsedRCReplayResult;
  }

  console.warn('[ReplayFileExporter] Input is not a binary RCREPLAY v2 container; attempting JSON fixture fallback parse.');
  const jsonText = new TextDecoder().decode(rawBuffer);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  if (parsed && Array.isArray(parsed.frames)) {
    const frames: ReplaySnapshotFloat32Array[] = parsed.frames.map((arr: ArrayLike<number>) => {
      const snap = new Float32Array(STATE_BUFFER_FLOATS) as ReplaySnapshotFloat32Array;
      if (Array.isArray(arr) || arr instanceof Float32Array) {
        for (let k = 0; k < Math.min(arr.length, STATE_BUFFER_FLOATS); k++) {
          snap[k] = Number(arr[k]) || 0;
        }
      }
      snap.controls = [];
      snap.incidents = [];
      snap.signals = [];
      snap.audioEvents = [];
      return snap;
    });
    const frameSlots = frames.map((snap, idx) => ({
      frameIndex: idx,
      tick: Math.floor(snap[0] || idx),
      snapshot: snap,
      controls: [],
      incidents: [],
      signals: [],
      audioEvents: [],
    }));
    return {
      version: 2,
      metadata: {
        mode: (parsed.mode as string) || 'custom',
        arenaPreset: (parsed.arenaPreset as number) ?? 0,
        winner: (parsed.winner as string) || 'blue',
        blueScore: (parsed.blueScore as number) ?? 0,
        orangeScore: (parsed.orangeScore as number) ?? 0,
        durationSec: Number((frames.length / 120).toFixed(2)),
        durationSeconds: (parsed.durationSeconds as number) ?? 300,
        roster: Array.isArray(parsed.roster) ? parsed.roster : [],
        loadouts: Array.isArray(parsed.loadouts)
          ? parsed.loadouts
          : Array.isArray(parsed.roster)
          ? parsed.roster
          : [],
        createdAtIso: (parsed.createdAtIso as string) || '',
      },
      frames,
      frameSlots,
      timelines: { incidents: [], signals: [] },
    };
  }

  throw new Error('Unrecognized RC Replay file format.');
}

export const MAX_REWINDER_FRAMES = 3600; // 30 seconds @ 120Hz FIFO rolling window

/**
 * Normalizes in-memory rewinder frame entries and exports a compressed V2 RC Replay file.
 */
export async function exportStateReplayFile(
  rewinderFrames: ReplayRawFrameSlotItem[],
  options: ExportStateReplayOptions = {}
): Promise<boolean> {
  if (!Array.isArray(rewinderFrames) || rewinderFrames.length === 0) return false;
  const normalizedFrames: ReplaySnapshotFloat32Array[] = [];
  const normalizedSlots: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rewinderFrames.length; i++) {
    const item = rewinderFrames[i];
    const objItem = !(item instanceof Float32Array) ? item : null;
    const src =
      item instanceof Float32Array
        ? item
        : objItem?.compactSnap instanceof Float32Array
        ? objItem.compactSnap
        : objItem?.renderState instanceof Float32Array
        ? objItem.renderState
        : null;
    const snap = new Float32Array(STATE_BUFFER_FLOATS) as ReplaySnapshotFloat32Array;
    if (src) {
      snap.set(src.subarray(0, Math.min(src.length, STATE_BUFFER_FLOATS)));
    }
    normalizedFrames.push(snap);
    normalizedSlots.push({
      tick: Math.floor(snap[0] || i),
      snapshot: snap,
      controls: objItem?.controls || null,
      acknowledgedControls: objItem?.acknowledgedControls || null,
      incidents: Array.isArray(objItem?.incidents) ? objItem.incidents : [],
      signals: Array.isArray(objItem?.signals) ? objItem.signals : [],
    });
  }

  const normalizedRoster = Array.isArray(options.roster)
    ? options.roster
    : [{ carIndex: 0, name: 'Player', team: 0, isPlayer: true }];

  return exportRetainedMatchReplayFile({
    magic: RC_REPLAY_MAGIC_V2,
    version: 2,
    stateFloats: STATE_BUFFER_FLOATS,
    tickRate: 120,
    frameCount: normalizedFrames.length,
    durationSec: Number((normalizedFrames.length / 120).toFixed(2)),
    durationSeconds: options.durationSeconds ?? 300,
    winner: options.winner || 'draw',
    blueScore: options.blueScore ?? 0,
    orangeScore: options.orangeScore ?? 0,
    arenaPreset: options.arenaPreset ?? 0,
    roster: normalizedRoster,
    loadouts: Array.isArray(options.loadouts) ? options.loadouts : normalizedRoster,
    mode: options.mode || 'state-replay',
    createdAtIso: new Date().toISOString(),
    frames: normalizedFrames,
    slots: normalizedSlots,
  });
}

