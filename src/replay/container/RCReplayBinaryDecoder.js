/**
 * src/replay/container/RCReplayBinaryDecoder.js
 * Column untransposition, XOR-delta unfiltering, and V2 4-section binary container deserializer.
 */

import {
  STATE_BUFFER_FLOATS,
  SIM_OFFSETS,
  CAR_STATE_STRIDE,
  CAR_STATE_OFFSETS,
  INCIDENT_EVENT_TYPES,
  FLIP_RESET_OBJECT_TYPES,
  FLIP_RESET_SUBTYPES,
  FLIP_RESET_SUBTYPE_LABELS,
} from '../../physics/RocketSimConstants.js';
import { resolveReplayAudioCueForSignal } from '../ReplayRingBuffer.js';
import {
  RC_REPLAY_STATE_BYTES,
  RC_REPLAY_STATE_INPUT_STRIDE,
  RC_REPLAY_EVENT_STRIDE,
  isBinaryRCReplayContainer,
  unpackTrack64ToCarControls,
  decodeIncidentFrom64Bytes,
  decodeSignalFrom64Bytes,
} from './RCReplayBinarySchema.js';
import {
  StateInputTimeline,
  IncidentTimeline,
  SignalTimeline,
  synthesizeFallbackSignalsFromIncidents,
} from './RCReplayTimelineParser.js';

function classifyLegacyFlipResetWorldSubType(x, y, z, nx, ny, nz) {
  const absX = Math.abs(x);
  const absY = Math.abs(y);
  const absNx = Math.abs(nx);
  const absNy = Math.abs(ny);
  if (absY >= 5040 && absX <= 960 && z <= 720) {
    if (Math.abs(z - 642) < 100 && absX <= 920) return FLIP_RESET_SUBTYPES.CROSSBAR;
    if (absX >= 800 || absY > 5120) return FLIP_RESET_SUBTYPES.GOALPOST;
  }
  if (nz <= -0.85 || (z >= 1950 && nz <= -0.5)) return FLIP_RESET_SUBTYPES.CEILING;
  if (nz >= 0.85) return FLIP_RESET_SUBTYPES.FLOOR;
  if (nz < -0.15) return FLIP_RESET_SUBTYPES.RAMP_CEILING;
  if (nz > 0.15) return FLIP_RESET_SUBTYPES.RAMP_GROUND;
  if (absNx >= 0.35 && absNy >= 0.35) return FLIP_RESET_SUBTYPES.CORNER_45;
  if (absNy >= absNx) return FLIP_RESET_SUBTYPES.BACKBOARD;
  return FLIP_RESET_SUBTYPES.SIDE_WALL;
}

function enrichLegacyFlipResetIncidentFromFrames(inc, frames) {
  if (!inc || inc.type !== INCIDENT_EVENT_TYPES.FLIP_RESET_GAINED) return;
  const flagObj = (Number(inc.flags ?? 0) >>> 4) & 0xF;
  if (flagObj !== 0) return; // Already carries native WASM m_groundObject classification

  const fIdx = Math.max(0, Math.min(frames.length - 1, inc.frameIndex ?? 0));
  const prevSnap = frames[Math.max(0, fIdx - 1)] || frames[fIdx];
  const carIdx = Math.max(0, Math.min(7, Number(inc.carIndex ?? inc.primaryId ?? 0)));
  const carBase = SIM_OFFSETS.CARS + carIdx * CAR_STATE_STRIDE;

  const cx = prevSnap ? prevSnap[carBase + 0] : Number(inc.carPosX ?? inc.x ?? 0);
  const cy = prevSnap ? prevSnap[carBase + 1] : Number(inc.carPosY ?? inc.y ?? 0);
  const cz = prevSnap ? prevSnap[carBase + 2] : Number(inc.carPosZ ?? inc.z ?? 0);
  const upX = prevSnap ? prevSnap[carBase + CAR_STATE_OFFSETS.UP + 0] : 0;
  const upY = prevSnap ? prevSnap[carBase + CAR_STATE_OFFSETS.UP + 1] : 0;
  const upZ = prevSnap ? prevSnap[carBase + CAR_STATE_OFFSETS.UP + 2] : 1;
  let gnx = prevSnap ? prevSnap[carBase + CAR_STATE_OFFSETS.GROUND_NORMAL + 0] : 0;
  let gny = prevSnap ? prevSnap[carBase + CAR_STATE_OFFSETS.GROUND_NORMAL + 1] : 0;
  let gnz = prevSnap ? prevSnap[carBase + CAR_STATE_OFFSETS.GROUND_NORMAL + 2] : 0;
  if (gnx * gnx + gny * gny + gnz * gnz < 0.1) {
    gnx = upX;
    gny = upY;
    gnz = upZ;
  }

  const bx = prevSnap ? prevSnap[SIM_OFFSETS.BALL + 0] : Number(inc.ballPosX ?? inc.normalX ?? 0);
  const by = prevSnap ? prevSnap[SIM_OFFSETS.BALL + 1] : Number(inc.ballPosY ?? inc.normalY ?? 0);
  const bz = prevSnap ? prevSnap[SIM_OFFSETS.BALL + 2] : Number(inc.ballPosZ ?? inc.normalZ ?? 0);

  const dx = cx - bx;
  const dy = cy - by;
  const dz = cz - bz;
  const distToBall = Math.hypot(dx, dy, dz);
  const invDist = distToBall > 1e-4 ? 1.0 / distToBall : 0;
  const ballToCarDotUp = (dx * invDist) * upX + (dy * invDist) * upY + (dz * invDist) * upZ;

  // In RocketSim, a true ball flip reset requires all 4 wheels on the ball (~110..165 UU center-to-center)
  // AND the car's underside (-up) facing the ball (ballToCar . up > 0.45).
  const isNearWorldBoundary =
    Math.abs(cy) >= 4980 ||
    Math.abs(cx) >= 3960 ||
    cz <= 65 ||
    cz >= 1960;

  const isBallReset = distToBall <= 170.0 && ballToCarDotUp >= 0.45 && !isNearWorldBoundary;
  if (isBallReset) {
    inc.subType = FLIP_RESET_SUBTYPES.BALL;
    inc.resetSubType = FLIP_RESET_SUBTYPES.BALL;
    inc.resetSubTypeName = FLIP_RESET_SUBTYPE_LABELS[FLIP_RESET_SUBTYPES.BALL];
    inc.resetObjectCode = FLIP_RESET_OBJECT_TYPES.BALL;
    inc.resetObjectType = 'ball';
    inc.isBallFlipReset = true;
  } else {
    const worldSub = classifyLegacyFlipResetWorldSubType(cx, cy, cz, gnx, gny, gnz);
    inc.subType = worldSub;
    inc.resetSubType = worldSub;
    inc.resetSubTypeName = FLIP_RESET_SUBTYPE_LABELS[worldSub] || 'other_world';
    inc.resetObjectCode = FLIP_RESET_OBJECT_TYPES.WORLD;
    inc.resetObjectType = 'world';
    inc.isBallFlipReset = false;
  }
}

/**
 * Reverses the 4-byte column transposition + XOR-delta filter back into the contiguous Track A buffer.
 */
export function unfilterAndUntransposeStateInputTrack(filteredBytes, frameCount, stride = RC_REPLAY_STATE_INPUT_STRIDE) {
  if (!filteredBytes || frameCount <= 0 || filteredBytes.byteLength < frameCount * stride) {
    return new Uint8Array(0);
  }
  const totalBytes = frameCount * stride;
  const wordsPerFrame = stride >>> 2;
  const outBytes = new Uint8Array(totalBytes);
  const outU32 = new Uint32Array(outBytes.buffer, outBytes.byteOffset, frameCount * wordsPerFrame);
  const planeSize = frameCount * wordsPerFrame;

  for (let w = 0; w < wordsPerFrame; w++) {
    let prevWord = 0;
    const colBase = w * frameCount;
    for (let f = 0; f < frameCount; f++) {
      const idx = colBase + f;
      const b0 = filteredBytes[idx];
      const b1 = filteredBytes[planeSize + idx];
      const b2 = filteredBytes[planeSize * 2 + idx];
      const b3 = filteredBytes[planeSize * 3 + idx];
      const xorWord = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
      const curWord = (xorWord ^ prevWord) >>> 0;
      prevWord = curWord;
      outU32[f * wordsPerFrame + w] = curWord;
    }
  }
  return outBytes;
}

/**
 * Parses a decompressed V2 Binary Container into 3 parallel timelines
 * (stateInputTimeline, incidentTimeline, signalTimeline) + per-frame composite slots.
 */
export function deserializeRCReplayBinaryContainer(bytesOrBuffer) {
  const u8 =
    bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : new Uint8Array(bytesOrBuffer);

  if (!isBinaryRCReplayContainer(u8)) {
    throw new Error('Invalid RCREPLAY V2 binary header.');
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(8, true);
  const metaLength = dv.getUint32(12, true);
  if (16 + metaLength > u8.byteLength) {
    throw new Error('Corrupt RCREPLAY metadata header length.');
  }

  const metaJsonText = new TextDecoder().decode(u8.subarray(16, 16 + metaLength));
  const headerObj = JSON.parse(metaJsonText);
  const matchInfo = headerObj.matchInfo || {};
  const tracksToc = headerObj.tracks || {};

  // 1. Parse Track A (State + Input Timeline)
  const stateToc = tracksToc.stateInput || {};
  const frameCount = Number(stateToc.count ?? matchInfo.frameCount ?? 0);
  const stateStride = Number(stateToc.stride || RC_REPLAY_STATE_INPUT_STRIDE);
  const rawTrackASlice =
    frameCount > 0 && stateToc.byteLength > 0
      ? u8.subarray(stateToc.offset, stateToc.offset + stateToc.byteLength)
      : new Uint8Array(0);

  const stateInputBytes =
    stateToc.encoding === 'xor-delta-bytetran-v1'
      ? unfilterAndUntransposeStateInputTrack(rawTrackASlice, frameCount, stateStride)
      : new Uint8Array(rawTrackASlice);

  const readFrameTick = (idx) => {
    if (idx < 0 || idx >= frameCount) return -1;
    const f32 = new Float32Array(
      stateInputBytes.buffer,
      stateInputBytes.byteOffset + idx * stateStride,
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

  // 2. Parse Track B (Incident Timeline)
  const incToc = tracksToc.incidents || {};
  const incidentCount = Number(incToc.count ?? 0);
  const incidentStride = Number(incToc.stride || RC_REPLAY_EVENT_STRIDE);
  const incidentBytes =
    incidentCount > 0 && incToc.byteLength > 0
      ? u8.slice(incToc.offset, incToc.offset + incToc.byteLength)
      : new Uint8Array(0);

  const incidents = new Array(incidentCount);
  const incidentsByFrame = new Map();
  for (let i = 0; i < incidentCount; i++) {
    const inc = decodeIncidentFrom64Bytes(incidentBytes, i * incidentStride);
    const fIdx = resolveFrameIdxByTick(inc.tick, inc.frameIndex ?? 0);
    inc.frameIndex = fIdx;
    incidents[i] = inc;
    let list = incidentsByFrame.get(fIdx);
    if (!list) {
      list = [];
      incidentsByFrame.set(fIdx, list);
    }
    list.push(inc);
  }

  // 3. Parse Track C (Signal Timeline)
  const sigToc = tracksToc.signals || {};
  const signalCount = Number(sigToc.count ?? 0);
  const signalStride = Number(sigToc.stride || RC_REPLAY_EVENT_STRIDE);
  const signalBytes =
    signalCount > 0 && sigToc.byteLength > 0
      ? u8.slice(sigToc.offset, sigToc.offset + sigToc.byteLength)
      : new Uint8Array(0);

  const recordedSignals = new Array(signalCount);
  const signalsByFrame = new Map();
  for (let i = 0; i < signalCount; i++) {
    const sig = decodeSignalFrom64Bytes(signalBytes, i * signalStride);
    recordedSignals[i] = sig;
    const fIdx = Math.max(0, Math.min(Math.max(0, frameCount - 1), sig.frameIndex ?? 0));
    let list = signalsByFrame.get(fIdx);
    if (!list) {
      list = [];
      signalsByFrame.set(fIdx, list);
    }
    list.push(sig);
  }

  // Build zero-copy Float32Array(448) views per frame + rich frameSlots with controls, incidents, signals, audioEvents
  const frames = new Array(frameCount);
  const frameSlots = new Array(frameCount);
  const isCountUp = matchInfo.mode === 'freeplay' || matchInfo.mode === 'training';

  for (let i = 0; i < frameCount; i++) {
    const byteOff = i * stateStride;
    const snap = new Float32Array(
      stateInputBytes.buffer,
      stateInputBytes.byteOffset + byteOff,
      STATE_BUFFER_FLOATS
    );
    const controlsBytes = stateInputBytes.subarray(
      byteOff + RC_REPLAY_STATE_BYTES,
      byteOff + stateStride
    );
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

  // Fallback for tick-matched events if frameIndex was 0 on all events
  if (frameCount > 0 && (incidentCount > 0 || signalCount > 0)) {
    const tickToFrameMap = new Map();
    for (let i = 0; i < frameCount; i++) {
      tickToFrameMap.set(frameSlots[i].tick, i);
    }
    for (let i = 0; i < incidentCount; i++) {
      const inc = incidents[i];
      if (inc.frameIndex === 0 && inc.tick > 0 && tickToFrameMap.has(inc.tick)) {
        const trueIdx = tickToFrameMap.get(inc.tick);
        if (trueIdx > 0) {
          const idxInZero = frameSlots[0].incidents.indexOf(inc);
          if (idxInZero !== -1) frameSlots[0].incidents.splice(idxInZero, 1);
          inc.frameIndex = trueIdx;
          frameSlots[trueIdx].incidents.push(inc);
          incidentsByFrame.set(trueIdx, frameSlots[trueIdx].incidents);
        }
      }
    }
    for (let i = 0; i < signalCount; i++) {
      const sig = recordedSignals[i];
      if (sig.frameIndex === 0 && sig.tick > 0 && tickToFrameMap.has(sig.tick)) {
        const trueIdx = tickToFrameMap.get(sig.tick);
        if (trueIdx > 0) {
          const idxInZero = frameSlots[0].signals.indexOf(sig);
          if (idxInZero !== -1) frameSlots[0].signals.splice(idxInZero, 1);
          sig.frameIndex = trueIdx;
          frameSlots[trueIdx].signals.push(sig);
          signalsByFrame.set(trueIdx, frameSlots[trueIdx].signals);
          const cue = resolveReplayAudioCueForSignal(sig, isCountUp);
          if (cue) frameSlots[trueIdx].audioEvents.push(cue);
        }
      }
    }
  }

  if (frameCount > 0 && incidentCount > 0) {
    for (let i = 0; i < incidentCount; i++) {
      enrichLegacyFlipResetIncidentFromFrames(incidents[i], frames);
    }
  }

  // If Track C has 0 recorded signals, synthesize fallback signals from Track B GOAL_SCORED incidents
  let synthesizedSignals = [];
  if (signalCount === 0 && frameCount > 0) {
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
      if (cue) {
        frameSlots[fIdx].audioEvents.push(cue);
      }
    }
  }

  const effectiveSignals = signalCount > 0 ? recordedSignals : synthesizedSignals;

  const stateInputTimeline = new StateInputTimeline({
    bytes: stateInputBytes,
    frameCount,
    stride: stateStride,
    stateBytes: RC_REPLAY_STATE_BYTES,
    tickRate: matchInfo.tickRate || 120,
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
    version,
    metadata: {
      mode: matchInfo.mode || 'match',
      arenaPreset: matchInfo.arenaPreset ?? 0,
      tickRate: matchInfo.tickRate || 120,
      frameCount,
      durationSec: matchInfo.durationSec ?? Number((frameCount / 120).toFixed(2)),
      durationSeconds: matchInfo.durationSeconds ?? 300,
      winner: matchInfo.winner || 'blue',
      blueScore: matchInfo.blueScore ?? 0,
      orangeScore: matchInfo.orangeScore ?? 0,
      winReason: matchInfo.winReason ?? 0,
      createdAtIso: matchInfo.createdAtIso || '',
      roster: matchInfo.roster || [],
      loadouts: matchInfo.loadouts || matchInfo.roster || [],
      directorReplayMeta: matchInfo.directorReplayMeta || null,
      tracks: tracksToc,
    },
    frames,
    frameSlots,
    timelines: {
      stateInput: stateInputTimeline,
      incidents: incidentTimeline.events,
      signals: effectiveSignals,
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
