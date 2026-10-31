/**
 * src/replay/container/RCReplayBinaryEncoder.js
 * Track normalization, XOR-delta column transposition, and V2 4-section binary container serializer.
 */

import {
  STATE_BUFFER_FLOATS,
  MAX_CARS,
} from '../../physics/RocketSimConstants.js';
import {
  RC_REPLAY_MAGIC_V2,
  RC_REPLAY_VERSION_V2,
  RC_REPLAY_STATE_BYTES,
  RC_REPLAY_CONTROLS_BYTES,
  RC_REPLAY_STATE_INPUT_STRIDE,
  RC_REPLAY_EVENT_STRIDE,
  MAGIC_BYTES,
  packCarControlsToTrack64,
  encodeIncidentTo64Bytes,
  encodeSignalTo64Bytes,
} from './RCReplayBinarySchema.js';
import { synthesizeFallbackSignalsFromIncidents } from './RCReplayTimelineParser.js';

/**
 * Applies XOR-delta + 4-byte column transposition on Track A (State + Input)
 * so GZIP achieves ultra-high compression ratios on floating-point state streams.
 */
export function filterAndTransposeStateInputTrack(rawTrackBytes, frameCount, stride = RC_REPLAY_STATE_INPUT_STRIDE) {
  if (!rawTrackBytes || frameCount <= 0 || rawTrackBytes.byteLength < frameCount * stride) {
    return new Uint8Array(0);
  }
  const totalBytes = frameCount * stride;
  const wordsPerFrame = stride >>> 2; // 464 words
  const srcU32 = new Uint32Array(rawTrackBytes.buffer, rawTrackBytes.byteOffset, frameCount * wordsPerFrame);

  const outBytes = new Uint8Array(totalBytes);
  const planeSize = frameCount * wordsPerFrame;

  for (let w = 0; w < wordsPerFrame; w++) {
    let prevWord = 0;
    const colBase = w * frameCount;
    for (let f = 0; f < frameCount; f++) {
      const curWord = srcU32[f * wordsPerFrame + w];
      const xorWord = (curWord ^ prevWord) >>> 0;
      prevWord = curWord;

      const idx = colBase + f;
      outBytes[idx] = xorWord & 0xff;
      outBytes[planeSize + idx] = (xorWord >>> 8) & 0xff;
      outBytes[planeSize * 2 + idx] = (xorWord >>> 16) & 0xff;
      outBytes[planeSize * 3 + idx] = (xorWord >>> 24) & 0xff;
    }
  }
  return outBytes;
}

function resolveFrameIndexFromTrackBytes(stateInputBytes, frameCount, stride, targetTick, hintFrameIndex = 0) {
  if (frameCount <= 0) return 0;
  const readTick = (idx) => {
    const f32 = new Float32Array(
      stateInputBytes.buffer,
      stateInputBytes.byteOffset + idx * stride,
      1
    );
    return Math.floor(f32[0] || idx);
  };
  if (
    hintFrameIndex >= 0 &&
    hintFrameIndex < frameCount &&
    readTick(hintFrameIndex) === targetTick
  ) {
    return hintFrameIndex;
  }
  let lo = 0;
  let hi = frameCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midTick = readTick(mid);
    if (midTick === targetTick) return mid;
    if (midTick < targetTick) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(frameCount - 1, lo));
}

/**
 * Normalizes any replay source (WASM tracks, ReplayRingBuffer, or frames array)
 * into the 3 raw binary tracks + metadata.
 */
export function normalizeReplayTracksPayload(replayObj = {}) {
  const stride = RC_REPLAY_STATE_INPUT_STRIDE;

  // Case 1: Already has raw binary tracks (e.g., extracted directly from WASM or V2 container)
  if (
    replayObj.stateInputBytes instanceof Uint8Array &&
    replayObj.stateInputBytes.byteLength >= stride
  ) {
    const frameCount = Math.floor(replayObj.stateInputBytes.byteLength / stride);
    const stateInputSlice = replayObj.stateInputBytes.subarray(0, frameCount * stride);
    let incidentBytes =
      replayObj.incidentBytes instanceof Uint8Array ? replayObj.incidentBytes : new Uint8Array(0);
    const incidentCount = Math.floor(incidentBytes.byteLength / RC_REPLAY_EVENT_STRIDE);
    if (incidentCount > 0 && frameCount > 0) {
      let clonedIncidents = null;
      for (let i = 0; i < incidentCount; i++) {
        const byteOff = i * RC_REPLAY_EVENT_STRIDE;
        const u32 = new Uint32Array(
          incidentBytes.buffer,
          incidentBytes.byteOffset + byteOff,
          16
        );
        const tick = u32[1];
        const rawFrameIdx = u32[15];
        if (tick > 0) {
          const resolvedIdx = resolveFrameIndexFromTrackBytes(
            stateInputSlice,
            frameCount,
            stride,
            tick,
            rawFrameIdx
          );
          if (resolvedIdx !== rawFrameIdx) {
            if (!clonedIncidents) {
              clonedIncidents = new Uint8Array(incidentBytes);
            }
            const dstU32 = new Uint32Array(
              clonedIncidents.buffer,
              clonedIncidents.byteOffset + byteOff,
              16
            );
            dstU32[15] = resolvedIdx >>> 0;
          }
        }
      }
      if (clonedIncidents) {
        incidentBytes = clonedIncidents;
      }
    }
    const signalBytes =
      replayObj.signalBytes instanceof Uint8Array ? replayObj.signalBytes : new Uint8Array(0);
    return {
      frameCount,
      stateStride: stride,
      incidentCount,
      signalCount: Math.floor(signalBytes.byteLength / RC_REPLAY_EVENT_STRIDE),
      stateInputBytes: stateInputSlice,
      incidentBytes,
      signalBytes,
    };
  }

  // Case 2: Normalize from slots/frames + incidents/signals arrays
  const rawSlots = Array.isArray(replayObj.slots) && replayObj.slots.length > 0
    ? replayObj.slots
    : Array.isArray(replayObj.frames)
    ? replayObj.frames
    : [];

  const frameCount = rawSlots.length;
  const stateInputBytes = new Uint8Array(frameCount * stride);
  const collectedIncidents = [];
  const collectedSignals = [];
  const seenSignalKeys = new Set();

  for (let i = 0; i < frameCount; i++) {
    const item = rawSlots[i];
    const snap =
      item instanceof Float32Array
        ? item
        : item?.snapshot instanceof Float32Array
        ? item.snapshot
        : item?.compactSnap instanceof Float32Array
        ? item.compactSnap
        : item?.state instanceof Float32Array
        ? item.state
        : item?.renderState instanceof Float32Array
        ? item.renderState
        : null;

    const frameByteOff = i * stride;
    if (snap) {
      const dstF32 = new Float32Array(
        stateInputBytes.buffer,
        stateInputBytes.byteOffset + frameByteOff,
        STATE_BUFFER_FLOATS
      );
      dstF32.set(snap.subarray(0, Math.min(snap.length, STATE_BUFFER_FLOATS)));
    }

    const ctrlSlice = stateInputBytes.subarray(frameByteOff + RC_REPLAY_STATE_BYTES, frameByteOff + stride);
    if (item?.controlsBytes instanceof Uint8Array && item.controlsBytes.byteLength >= 24) {
      ctrlSlice.set(item.controlsBytes.subarray(0, Math.min(64, item.controlsBytes.byteLength)));
    } else if (Array.isArray(item?.acknowledgedControls)) {
      for (let c = 0; c < item.acknowledgedControls.length; c++) {
        const entry = item.acknowledgedControls[c];
        if (!entry) continue;
        if (typeof entry.carIndex === 'number' && entry.controls) {
          packCarControlsToTrack64(ctrlSlice, entry.carIndex, entry.controls);
        } else if (c < MAX_CARS && typeof entry === 'object') {
          packCarControlsToTrack64(ctrlSlice, c, entry);
        }
      }
    } else if (Array.isArray(item?.controls)) {
      for (let c = 0; c < Math.min(MAX_CARS, item.controls.length); c++) {
        if (item.controls[c]) {
          packCarControlsToTrack64(ctrlSlice, c, item.controls[c]);
        }
      }
    } else if (item?.controls && typeof item.controls === 'object') {
      packCarControlsToTrack64(ctrlSlice, 0, item.controls);
    }

    const tick = item?.tick ?? (snap ? Math.floor(snap[0] || i) : i);

    if (Array.isArray(item?.incidents)) {
      for (let j = 0; j < item.incidents.length; j++) {
        const inc = item.incidents[j];
        if (inc) {
          collectedIncidents.push({ ...inc, tick: inc.tick ?? tick, frameIndex: i });
        }
      }
    }

    if (Array.isArray(item?.signals)) {
      for (let j = 0; j < item.signals.length; j++) {
        const sig = item.signals[j];
        if (!sig) continue;
        const dedupKey =
          sig.signalId && sig.signalId > 0
            ? `id_${sig.signalId}`
            : `t_${sig.signalType}_${sig.frameId ?? tick}_${sig.param1 ?? 0}_${sig.param2 ?? 0}`;
        if (seenSignalKeys.has(dedupKey)) continue;
        seenSignalKeys.add(dedupKey);
        collectedSignals.push({
          ...sig,
          frameId: sig.frameId ?? tick,
          frameIndex: i,
        });
      }
    }
  }

  // Also merge top-level incidents / signals if provided separately
  if (Array.isArray(replayObj.incidents) && collectedIncidents.length === 0) {
    for (let i = 0; i < replayObj.incidents.length; i++) {
      if (replayObj.incidents[i]) collectedIncidents.push(replayObj.incidents[i]);
    }
  }
  if (Array.isArray(replayObj.signals) && collectedSignals.length === 0) {
    for (let i = 0; i < replayObj.signals.length; i++) {
      const sig = replayObj.signals[i];
      if (!sig) continue;
      const dedupKey =
        sig.signalId && sig.signalId > 0
          ? `id_${sig.signalId}`
          : `t_${sig.signalType}_${sig.frameId ?? 0}_${sig.param1 ?? 0}_${sig.param2 ?? 0}`;
      if (seenSignalKeys.has(dedupKey)) continue;
      seenSignalKeys.add(dedupKey);
      collectedSignals.push(sig);
    }
  }

  // If no explicit signals were recorded, synthesize Track C signals from GOAL_SCORED incidents / match boundaries
  if (collectedSignals.length === 0 && frameCount > 0 && collectedIncidents.length > 0) {
    const synthSlots = new Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      const item = rawSlots[i];
      const snap = item instanceof Float32Array ? item : item?.snapshot || item?.compactSnap;
      synthSlots[i] = { tick: item?.tick ?? (snap ? Math.floor(snap[0] || i) : i) };
    }
    const synthSignals = synthesizeFallbackSignalsFromIncidents(collectedIncidents, synthSlots, {
      mode: replayObj.mode || replayObj.gameMode || 'match',
      winner: replayObj.winner || 'blue',
      winReason: replayObj.winReason ?? 0,
    });
    for (let s = 0; s < synthSignals.length; s++) {
      collectedSignals.push(synthSignals[s]);
    }
  }

  const incidentBytes = new Uint8Array(collectedIncidents.length * RC_REPLAY_EVENT_STRIDE);
  for (let i = 0; i < collectedIncidents.length; i++) {
    encodeIncidentTo64Bytes(
      collectedIncidents[i],
      incidentBytes,
      i * RC_REPLAY_EVENT_STRIDE,
      collectedIncidents[i].frameIndex ?? 0
    );
  }

  const signalBytes = new Uint8Array(collectedSignals.length * RC_REPLAY_EVENT_STRIDE);
  for (let i = 0; i < collectedSignals.length; i++) {
    encodeSignalTo64Bytes(
      collectedSignals[i],
      signalBytes,
      i * RC_REPLAY_EVENT_STRIDE,
      collectedSignals[i].frameIndex ?? 0
    );
  }

  return {
    frameCount,
    stateStride: stride,
    incidentCount: collectedIncidents.length,
    signalCount: collectedSignals.length,
    stateInputBytes,
    incidentBytes,
    signalBytes,
  };
}

/**
 * Packs a normalized replay payload into the 4-section binary container (Uint8Array).
 */
export function serializeRCReplayBinaryContainer(replayObj = {}, options = {}) {
  const tracks = normalizeReplayTracksPayload(replayObj);
  const useDeltaTranspose = options.deltaTranspose !== false;

  const encodedTrackA = useDeltaTranspose
    ? filterAndTransposeStateInputTrack(tracks.stateInputBytes, tracks.frameCount, tracks.stateStride)
    : tracks.stateInputBytes;
  const encodedTrackB = tracks.incidentBytes;
  const encodedTrackC = tracks.signalBytes;

  const normalizedRoster = Array.isArray(replayObj.roster)
    ? replayObj.roster
    : Array.isArray(replayObj.roster?.players)
      ? replayObj.roster.players
      : [];
  const normalizedLoadouts = Array.isArray(replayObj.loadouts)
    ? replayObj.loadouts
    : normalizedRoster;
  const buildMetaJson = (trackAOffset, trackBOffset, trackCOffset) => ({
    magic: RC_REPLAY_MAGIC_V2,
    version: RC_REPLAY_VERSION_V2,
    format: 'multi-track-binary-v2',
    matchInfo: {
      mode: replayObj.mode || replayObj.gameMode || 'match',
      arenaPreset: replayObj.arenaPreset ?? 0,
      tickRate: replayObj.tickRate || 120,
      frameCount: tracks.frameCount,
      durationSec: Number((tracks.frameCount / (replayObj.tickRate || 120)).toFixed(2)),
      durationSeconds: replayObj.durationSeconds ?? 300,
      winner: replayObj.winner || 'blue',
      blueScore: replayObj.blueScore ?? 0,
      orangeScore: replayObj.orangeScore ?? 0,
      winReason: replayObj.winReason ?? 0,
      createdAtIso: replayObj.createdAtIso || new Date().toISOString(),
      roster: normalizedRoster,
      loadouts: normalizedLoadouts,
      ...(replayObj.directorReplayMeta ? { directorReplayMeta: replayObj.directorReplayMeta } : {}),
    },
    tracks: {
      stateInput: {
        offset: trackAOffset,
        byteLength: encodedTrackA.byteLength,
        count: tracks.frameCount,
        stride: tracks.stateStride,
        stateFloats: STATE_BUFFER_FLOATS,
        controlsBytes: RC_REPLAY_CONTROLS_BYTES,
        encoding: useDeltaTranspose ? 'xor-delta-bytetran-v1' : 'raw',
      },
      incidents: {
        offset: trackBOffset,
        byteLength: encodedTrackB.byteLength,
        count: tracks.incidentCount,
        stride: RC_REPLAY_EVENT_STRIDE,
        encoding: 'physics-event-64b',
      },
      signals: {
        offset: trackCOffset,
        byteLength: encodedTrackC.byteLength,
        count: tracks.signalCount,
        stride: RC_REPLAY_EVENT_STRIDE,
        encoding: 'signal-event-64b-dedup',
      },
    },
  });

  const encoder = new TextEncoder();
  const draftMetaBytes = encoder.encode(JSON.stringify(buildMetaJson(0, 0, 0)));
  let headerAndMetaAligned = (16 + draftMetaBytes.byteLength + 7) & ~7;
  let trackAOffset = headerAndMetaAligned;
  let trackBOffset = (trackAOffset + encodedTrackA.byteLength + 7) & ~7;
  let trackCOffset = (trackBOffset + encodedTrackB.byteLength + 7) & ~7;

  let finalMetaBytes = encoder.encode(JSON.stringify(buildMetaJson(trackAOffset, trackBOffset, trackCOffset)));
  headerAndMetaAligned = (16 + finalMetaBytes.byteLength + 7) & ~7;
  if (headerAndMetaAligned !== trackAOffset) {
    trackAOffset = headerAndMetaAligned;
    trackBOffset = (trackAOffset + encodedTrackA.byteLength + 7) & ~7;
    trackCOffset = (trackBOffset + encodedTrackB.byteLength + 7) & ~7;
    finalMetaBytes = encoder.encode(JSON.stringify(buildMetaJson(trackAOffset, trackBOffset, trackCOffset)));
  }

  const totalContainerBytes = (trackCOffset + encodedTrackC.byteLength + 7) & ~7;
  const container = new Uint8Array(totalContainerBytes);
  const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);

  // 0. 16-Byte Fixed Header + Metadata JSON (padded with spaces 0x20 to 8-byte boundary)
  container.set(MAGIC_BYTES, 0);
  dv.setUint32(8, RC_REPLAY_VERSION_V2, true);
  dv.setUint32(12, finalMetaBytes.byteLength, true);
  container.fill(0x20, 16, trackAOffset);
  container.set(finalMetaBytes, 16);

  // 1. Track A: State + User Input
  if (encodedTrackA.byteLength > 0) {
    container.set(encodedTrackA, trackAOffset);
  }

  // 2. Track B: Incidents
  if (encodedTrackB.byteLength > 0) {
    container.set(encodedTrackB, trackBOffset);
  }

  // 3. Track C: Signals
  if (encodedTrackC.byteLength > 0) {
    container.set(encodedTrackC, trackCOffset);
  }

  return container;
}
