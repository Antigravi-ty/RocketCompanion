/**
 * ReplayFileExporter.js
 * Manages full-match 448-float + 8-car controls + 64B Incident + 64B Signal RC Replay retention,
 * V2 Multi-Track Chunked Binary Container (.rcreplay.gz) background GZIP export with spinning UI feedback,
 * persistent post-match QuickNotification lifecycle, and multi-timeline file parsing for the Replay Viewer.
 */

import { STATE_BUFFER_FLOATS } from '../physics/RocketSimConstants.js';
import { useQuickNotificationStore } from '../ui-core/stores/quickNotificationStore';
import { useReplayViewerStore } from '../ui-core/stores/replayViewerStore';
import {
  RC_REPLAY_MAGIC_V2,
  RC_REPLAY_VERSION_V2,
  RC_REPLAY_STATE_INPUT_STRIDE,
  RC_REPLAY_STATE_BYTES,
  isBinaryRCReplayContainer,
  unpackTrack64ToCarControls,
  decodeIncidentFrom64Bytes,
  decodeSignalFrom64Bytes,
} from './container/RCReplayBinarySchema.js';
import {
  normalizeReplayTracksPayload,
  serializeRCReplayBinaryContainer,
} from './container/RCReplayBinaryEncoder.js';
import { deserializeRCReplayBinaryContainer } from './container/RCReplayBinaryDecoder.js';
import {
  StateInputTimeline,
  IncidentTimeline,
  SignalTimeline,
  synthesizeFallbackSignalsFromIncidents,
} from './container/RCReplayTimelineParser.js';
import { packAndCompressReplayInBackground } from './container/RCReplayCompressionWorkerClient.js';
import { resolveReplayAudioCueForSignal } from './ReplayRingBuffer.js';

export const RC_REPLAY_MAGIC = RC_REPLAY_MAGIC_V2;
export const MATCH_REPLAY_NOTIFICATION_ID = 'match-replay-export';
export const MATCH_REPLAY_SAVING_TASK_ID = 'match-replay-saving-task';
export const MAX_MATCH_REPLAY_FRAMES = 100800; // Up to 14 minutes (5+7m OT) @ 120Hz

let _retainedMatchReplay = null;
let _isExportingReplay = false;

/**
 * Builds rich per-frame slots, Float32Array views, and 3 parallel timelines from 3 binary tracks.
 */
function materializeFramesFromBinaryTracks(tracks, matchInfo = {}) {
  const frameCount = tracks.frameCount;
  const stride = tracks.stateStride || RC_REPLAY_STATE_INPUT_STRIDE;
  const stateInputBytes = tracks.stateInputBytes;
  const incidentBytes = tracks.incidentBytes || new Uint8Array(0);
  const signalBytes = tracks.signalBytes || new Uint8Array(0);
  const incidentCount = Math.floor(incidentBytes.byteLength / 64);
  const signalCount = Math.floor(signalBytes.byteLength / 64);

  const readFrameTick = (idx) => {
    if (idx < 0 || idx >= frameCount) return -1;
    const f32 = new Float32Array(
      stateInputBytes.buffer,
      stateInputBytes.byteOffset + idx * stride,
      1
    );
    return Math.floor(f32[0] || idx);
  };
  const resolveFrameIdxByTick = (targetTick, hintIdx) => {
    if (frameCount <= 0) return 0;
    if (hintIdx >= 0 && hintIdx < frameCount && readFrameTick(hintIdx) === targetTick) {
      return hintIdx;
    }
    if (targetTick > 0) {
      let lo = 0;
      let hi = frameCount - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const midTick = readFrameTick(mid);
        if (midTick === targetTick) return mid;
        if (midTick < targetTick) lo = mid + 1;
        else hi = mid - 1;
      }
      return Math.max(0, Math.min(frameCount - 1, lo));
    }
    return Math.max(0, Math.min(frameCount - 1, hintIdx ?? 0));
  };

  const incidents = new Array(incidentCount);
  const incidentsByFrame = new Map();
  for (let i = 0; i < incidentCount; i++) {
    const inc = decodeIncidentFrom64Bytes(incidentBytes, i * 64);
    const fIdx = resolveFrameIdxByTick(inc.tick, inc.frameIndex ?? 0);
    inc.frameIndex = fIdx;
    incidents[i] = inc;
    let arr = incidentsByFrame.get(fIdx);
    if (!arr) {
      arr = [];
      incidentsByFrame.set(fIdx, arr);
    }
    arr.push(inc);
  }

  const recordedSignals = new Array(signalCount);
  const signalsByFrame = new Map();
  for (let i = 0; i < signalCount; i++) {
    const sig = decodeSignalFrom64Bytes(signalBytes, i * 64);
    recordedSignals[i] = sig;
    const fIdx = Math.max(0, Math.min(Math.max(0, frameCount - 1), sig.frameIndex ?? 0));
    let arr = signalsByFrame.get(fIdx);
    if (!arr) {
      arr = [];
      signalsByFrame.set(fIdx, arr);
    }
    arr.push(sig);
  }

  const frames = new Array(frameCount);
  const frameSlots = new Array(frameCount);
  const isCountUp = matchInfo.mode === 'freeplay' || matchInfo.mode === 'training';

  for (let i = 0; i < frameCount; i++) {
    const byteOff = i * stride;
    const snap = new Float32Array(
      stateInputBytes.buffer,
      stateInputBytes.byteOffset + byteOff,
      STATE_BUFFER_FLOATS
    );
    const controlsBytes = stateInputBytes.subarray(byteOff + RC_REPLAY_STATE_BYTES, byteOff + stride);
    const controls = unpackTrack64ToCarControls(controlsBytes);
    const frameIncidents = incidentsByFrame.get(i) || [];
    const frameSignals = signalsByFrame.get(i) || [];
    const audioEvents = [];

    for (let s = 0; s < frameSignals.length; s++) {
      const cue = resolveReplayAudioCueForSignal(frameSignals[s], isCountUp);
      if (cue) audioEvents.push(cue);
    }

    snap.controls = controls;
    snap.controlsBytes = controlsBytes;
    snap.incidents = frameIncidents;
    snap.signals = frameSignals;
    snap.audioEvents = audioEvents;
    frames[i] = snap;

    frameSlots[i] = {
      frameIndex: i,
      tick: Math.floor(snap[0] || i),
      snapshot: snap,
      controls,
      acknowledgedControls: controls,
      controlsBytes,
      incidents: frameIncidents,
      signals: frameSignals,
      audioEvents,
    };
  }

  let synthesizedSignals = [];
  if (signalCount === 0 && frameCount > 0) {
    console.info(
      `[ReplayFileExporter] Signal track is empty for ${frameCount} frames; synthesizing fallback signals from incidents.`
    );
    synthesizedSignals = synthesizeFallbackSignalsFromIncidents(incidents, frameSlots, matchInfo);
    for (let s = 0; s < synthesizedSignals.length; s++) {
      const sig = synthesizedSignals[s];
      const fIdx = Math.max(0, Math.min(frameCount - 1, sig.frameIndex ?? 0));
      let list = signalsByFrame.get(fIdx);
      if (!list) {
        list = frameSlots[fIdx].signals;
        signalsByFrame.set(fIdx, list);
      }
      list.push(sig);
      const cue = resolveReplayAudioCueForSignal(sig, isCountUp);
      if (cue) frameSlots[fIdx].audioEvents.push(cue);
    }
  }

  const signals = signalCount > 0 ? recordedSignals : synthesizedSignals;

  const stateInputTimeline = new StateInputTimeline({
    bytes: stateInputBytes,
    frameCount,
    stride,
    stateBytes: RC_REPLAY_STATE_BYTES,
    tickRate: 120,
    frames,
    frameSlots,
  });

  const incidentTimeline = new IncidentTimeline({
    bytes: incidentBytes,
    events: incidents,
    byFrameMap: incidentsByFrame,
    frameCount,
  });

  const signalTimeline = new SignalTimeline({
    bytes: signalBytes,
    recordedEvents: recordedSignals,
    synthesizedEvents: synthesizedSignals,
    byFrameMap: signalsByFrame,
    frameCount,
    isCountUp,
    stateInputTimeline,
    incidentTimeline,
  });

  return {
    frames,
    frameSlots,
    incidents,
    signals,
    incidentsByFrame,
    signalsByFrame,
    timelines: {
      stateInput: stateInputTimeline,
      incidents: incidentTimeline.events,
      signals,
      recordedSignals,
      synthesizedSignals,
      stateInputTimeline,
      incidentTimeline,
      signalTimeline,
      stateInputBytes,
      incidentBytes,
      signalBytes,
      incidentsByFrame,
      signalsByFrame,
    },
  };
}

/**
 * Retains a completed match's full 3-track replay data (State+Input, Incidents, Signals)
 * in host/local memory until the next match starts, and triggers a persistent QuickNotification
 * allowing compressed V2 Binary RC Replay export at any time.
 */
export function retainCompletedMatchReplayAndNotify(options = {}) {
  const floatsPerFrame = Number(options.stateFloats) || STATE_BUFFER_FLOATS;
  let tracks = null;

  // Priority 1: Direct binary tracks from Authoritative Worker / WASM Replay Buffer
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
    options.engine.getReplayFrameCount?.() > 0
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
    let rawFrames = [];
    if (Array.isArray(options.frames) && options.frames.length > 0) {
      rawFrames = options.frames;
    } else if (options.ringBuffer && typeof options.ringBuffer.getRecentFrames === 'function') {
      rawFrames = options.ringBuffer.getRecentFrames();
    } else if (Array.isArray(options.ringBuffer?._slots) && options.ringBuffer.size > 0) {
      for (let i = 0; i < options.ringBuffer.size; i++) {
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
      content: `${winnerLabel} (${blueScore}–${orangeScore}) · Export RC Replay (${_retainedMatchReplay.durationSec}s)?`,
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
export function getRetainedMatchReplay() {
  return _retainedMatchReplay;
}

/**
 * Clears the retained match replay buffer and dismisses the persistent notification.
 * Called ONLY when the next match begins.
 */
export function clearRetainedMatchReplayOnMatchStart() {
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
export async function exportRetainedMatchReplayFile(replayObj = _retainedMatchReplay) {
  if (!replayObj) return false;
  const hasFrames = Array.isArray(replayObj.frames) && replayObj.frames.length > 0;
  const hasRawTracks =
    replayObj.stateInputBytes instanceof Uint8Array &&
    replayObj.stateInputBytes.byteLength >= RC_REPLAY_STATE_INPUT_STRIDE;
  if (!hasFrames && !hasRawTracks) {
    return false;
  }
  if (_isExportingReplay) {
    return false;
  }

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

/**
 * Parses an uploaded .rcreplay.gz or .rcreplay File/ArrayBuffer into
 * 3 parallel timelines (State+Input, Incidents, Signals) and per-frame snapshots + slots.
 */
export async function parseRCReplayFile(fileOrBuffer) {
  const buf =
    fileOrBuffer instanceof ArrayBuffer
      ? fileOrBuffer
      : fileOrBuffer instanceof Uint8Array
      ? fileOrBuffer.buffer.slice(fileOrBuffer.byteOffset, fileOrBuffer.byteOffset + fileOrBuffer.byteLength)
      : typeof fileOrBuffer?.arrayBuffer === 'function'
      ? await fileOrBuffer.arrayBuffer()
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
    return deserializeRCReplayBinaryContainer(rawBuffer);
  }

  // Fallback for JSON-structured test fixtures if passed in memory
  console.warn('[ReplayFileExporter] Input is not a binary RCREPLAY v2 container; attempting JSON fixture fallback parse.');
  const jsonText = new TextDecoder().decode(rawBuffer);
  const parsed = JSON.parse(jsonText);
  if (parsed && Array.isArray(parsed.frames)) {
    const frames = parsed.frames.map((arr, idx) => {
      const snap = new Float32Array(STATE_BUFFER_FLOATS);
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
        mode: parsed.mode || 'custom',
        arenaPreset: parsed.arenaPreset ?? 0,
        winner: parsed.winner || 'blue',
        blueScore: parsed.blueScore ?? 0,
        orangeScore: parsed.orangeScore ?? 0,
        durationSec: Number((frames.length / 120).toFixed(2)),
        durationSeconds: parsed.durationSeconds ?? 300,
        roster: Array.isArray(parsed.roster) ? parsed.roster : [],
        loadouts: Array.isArray(parsed.loadouts)
          ? parsed.loadouts
          : Array.isArray(parsed.roster)
          ? parsed.roster
          : [],
        createdAtIso: parsed.createdAtIso || '',
      },
      frames,
      frameSlots,
      timelines: {
        incidents: [],
        signals: [],
      },
    };
  }

  throw new Error('Unrecognized RC Replay file format.');
}

export const MAX_REWINDER_FRAMES = 18000; // 150 seconds @ 120Hz

/**
 * Normalizes in-memory rewinder frame entries and exports a compressed V2 RC Replay file.
 */
export async function exportStateReplayFile(rewinderFrames, options = {}) {
  if (!Array.isArray(rewinderFrames) || rewinderFrames.length === 0) return false;
  const normalizedFrames = [];
  const normalizedSlots = [];
  for (let i = 0; i < rewinderFrames.length; i++) {
    const item = rewinderFrames[i];
    const src =
      item instanceof Float32Array
        ? item
        : item?.compactSnap instanceof Float32Array
        ? item.compactSnap
        : item?.renderState instanceof Float32Array
        ? item.renderState
        : null;
    const snap = new Float32Array(STATE_BUFFER_FLOATS);
    if (src) {
      snap.set(src.subarray(0, Math.min(src.length, STATE_BUFFER_FLOATS)));
    }
    normalizedFrames.push(snap);
    normalizedSlots.push({
      tick: Math.floor(snap[0] || i),
      snapshot: snap,
      controls: item?.controls || null,
      acknowledgedControls: item?.acknowledgedControls || null,
      incidents: Array.isArray(item?.incidents) ? item.incidents : [],
      signals: Array.isArray(item?.signals) ? item.signals : [],
    });
  }

  const normalizedRoster = Array.isArray(options.roster)
    ? options.roster
    : [
        {
          carIndex: 0,
          name: 'Player',
          team: 0,
          isPlayer: true,
        },
      ];

  return exportRetainedMatchReplayFile({
    magic: RC_REPLAY_MAGIC,
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
