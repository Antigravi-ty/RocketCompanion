/**
 * RLRCWasmReplayBridge.ts
 * Streaming WASM bridge for UE3 .replay / RCREPLAY V2 decoding and zero-copy touch timeline analysis.
 */

import {
  getLoadedRocketSimWasmModule,
  type RocketSimWasmModule,
} from '../../physics/RocketSimWasm.ts';
import type { ReplayTouchEvent } from '../ReplayDirectorGazeSolver.ts';
import type { ReplayReboundEvent } from '../replayTouchLookaheadPipeline.ts';
import { resolveRLRCVehicleLoadout } from './catalog/RLRCVehicleLoadoutCatalog.ts';
import { buildRLRCContainerPacket } from './container/RLRCBinaryContainerCodec.ts';
import { createLazyTrack0FramesView } from './container/RLRCTrack0TimelineBatchPacker.ts';
import {
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCBookmarkKind,
  type RLRCBookmarkRecord,
  type RLRCInterpolationMethod,
  type RLRCPlayerSlotMeta,
  type RLRCReplayHeaderMeta,
  type RLRCTeamIndex,
} from './RLRCReplayTypes.ts';

const STREAM_CHUNK_BYTES = 512 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8');

const CODE_TO_BOOKMARK_KIND: Readonly<Record<number, RLRCBookmarkKind>> = Object.freeze({
  1: 'user-mark',
  2: 'goal',
  3: 'kickoff',
  4: 'demolish',
  5: 'ue-keyframe',
  6: 'save',
});

export interface WasmDecodedReplayResult {
  readonly header: RLRCReplayHeaderMeta;
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly bookmarks: readonly RLRCBookmarkRecord[];
  readonly stateInputTrackBytes: Uint8Array;
}

export interface WasmTouchAnalysisPodResult {
  readonly touchEvents: ReplayTouchEvent[];
  readonly reboundEvents: ReplayReboundEvent[];
  readonly lastScoringTouchFrameIdx: number;
  readonly goalLineFrameIdx: number;
  readonly resolvedScorerCarIndex: number;
  readonly openingCarIndex: number;
  readonly resolvedLateralBias: number;
  readonly initialSettledCarPos: { carIndex: number; x: number; y: number; z: number } | null;
}

export function decodeReplayBytesViaWasm(
  bytes: Uint8Array,
  interpolationMethod: RLRCInterpolationMethod = 'hermite-clamped',
  synthesizeControls = true
): WasmDecodedReplayResult | null {
  const mod: RocketSimWasmModule | null = getLoadedRocketSimWasmModule();
  if (!mod || bytes.byteLength < 16) return null;

  const interpMode = interpolationMethod === 'linear' ? 1 : 0;
  const synthFlag = synthesizeControls ? 1 : 0;
  let frameCount = 0;

  if (bytes.byteLength <= STREAM_CHUNK_BYTES) {
    const ptr = mod._physics_allocReplayImportBuffer(bytes.byteLength);
    if (!ptr) return null;
    mod.HEAPU8.set(bytes, ptr);
    frameCount = mod._physics_decodeImportedReplayStream(bytes.byteLength, interpMode, synthFlag);
  } else {
    mod._physics_beginReplayImportStream(bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += STREAM_CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + STREAM_CHUNK_BYTES);
      const chunkLen = end - offset;
      const chunkPtr = mod._physics_allocReplayImportChunkBuffer(chunkLen);
      if (!chunkPtr) return null;
      mod.HEAPU8.set(bytes.subarray(offset, end), chunkPtr);
      if (mod._physics_commitReplayImportChunk(offset, chunkLen) < 0) return null;
    }
    frameCount = mod._physics_finalizeReplayImportStream(interpMode, synthFlag);
  }

  if (frameCount <= 0) return null;

  const hdrPtr = mod._physics_getReplayCodecHeaderPtr();
  const dv = new DataView(mod.HEAPU8.buffer);
  const statusCode = dv.getInt32(hdrPtr + 12, true);
  if (statusCode < 0) return null;

  const actualFrames = dv.getUint32(hdrPtr + 16, true);
  const sourceFrameCount = dv.getUint32(hdrPtr + 20, true);
  const recordFps = dv.getFloat32(hdrPtr + 28, true) || 30;
  const durationSeconds = dv.getFloat32(hdrPtr + 32, true);
  const rosterCount = Math.min(6, dv.getUint32(hdrPtr + 44, true));
  const blueScore = dv.getUint32(hdrPtr + 48, true);
  const orangeScore = dv.getUint32(hdrPtr + 52, true);
  const part1CrcValid = dv.getUint32(hdrPtr + 72, true) !== 0;
  const part2CrcValid = dv.getUint32(hdrPtr + 76, true) !== 0;

  const header: RLRCReplayHeaderMeta = {
    replayId: '',
    replayName: 'WASM Decoded Replay',
    mapName: 'Stadium_P',
    matchType: 'Online',
    teamSize: Math.max(1, Math.ceil(rosterCount / 2)),
    recordFps,
    sourceFrameCount,
    frameCount120Hz: actualFrames,
    durationSeconds,
    date: '',
    blueScore,
    orangeScore,
    part1CrcValid,
    part2CrcValid,
  };

  const rosterPtr = mod._physics_getReplayRosterPtr();
  const roster: RLRCPlayerSlotMeta[] = [];
  for (let i = 0; i < rosterCount; i++) {
    const base = rosterPtr + i * 64;
    const slotIndex = dv.getUint32(base, true);
    const team = (dv.getUint32(base + 4, true) & 1) as RLRCTeamIndex;
    const priActorId = dv.getUint32(base + 8, true);
    const bodyProductId = dv.getUint32(base + 12, true);
    const nameLen = Math.min(11, mod.HEAPU8[base + 52]);
    const userName =
      nameLen > 0
        ? UTF8_DECODER.decode(mod.HEAPU8.subarray(base + 53, base + 53 + nameLen))
        : `Player ${slotIndex + 1}`;
    const loadout = resolveRLRCVehicleLoadout(bodyProductId);
    roster.push({
      slotIndex,
      userName,
      team,
      priActorId,
      bodyProductId: loadout.bodyProductId,
      hitboxId: loadout.hitboxId,
      visualId: loadout.visualId,
      cameraSettings: {
        fov: dv.getFloat32(base + 32, true),
        height: dv.getFloat32(base + 36, true),
        pitch: dv.getFloat32(base + 40, true),
        distance: dv.getFloat32(base + 44, true),
        stiffness: dv.getFloat32(base + 48, true),
        swivelSpeed: 4.0,
        transitionSpeed: 1.0,
      },
    });
  }

  const bmCount = mod._physics_getReplayBookmarkCount();
  const bmPtr = mod._physics_getReplayBookmarkTrackPtr();
  const bookmarks: RLRCBookmarkRecord[] = [];
  if (bmPtr && bmCount > 0) {
    for (let i = 0; i < bmCount; i++) {
      const base = bmPtr + i * 64;
      const frameIndex120Hz = dv.getUint32(base, true);
      const sourceFrame30Hz = dv.getUint32(base + 4, true);
      const timeSeconds = dv.getFloat32(base + 8, true);
      const kindCode = mod.HEAPU8[base + 12];
      const slotIndex = dv.getInt8(base + 13);
      const rawTeam = dv.getInt8(base + 14);
      const labelLen = Math.min(48, mod.HEAPU8[base + 15]);
      const label =
        labelLen > 0
          ? UTF8_DECODER.decode(mod.HEAPU8.subarray(base + 16, base + 16 + labelLen))
          : 'Bookmark';
      bookmarks.push({
        kind: CODE_TO_BOOKMARK_KIND[kindCode] ?? 'user-mark',
        frameIndex120Hz,
        sourceFrame30Hz,
        timeSeconds,
        label,
        slotIndex,
        team: rawTeam === 0 || rawTeam === 1 ? rawTeam : -1,
      });
    }
  }

  const trackPtr = mod._physics_getReplayStateTrackPtr();
  const trackBytesLen = actualFrames * RLRC_TRACK0_FRAME_STRIDE_BYTES;
  const stateInputTrackBytes = new Uint8Array(trackBytesLen);
  stateInputTrackBytes.set(mod.HEAPU8.subarray(trackPtr, trackPtr + trackBytesLen));

  return {
    header,
    roster,
    bookmarks,
    stateInputTrackBytes,
  };
}

export function buildSessionFromWasmResult(
  decoded: WasmDecodedReplayResult,
  interpolationMethod: RLRCInterpolationMethod
) {
  const frames120Hz = createLazyTrack0FramesView(decoded.stateInputTrackBytes);
  const containerPacket = buildRLRCContainerPacket({
    header: decoded.header,
    roster: decoded.roster,
    bookmarks: decoded.bookmarks,
    frames120Hz,
    stateInputTrackBytes: decoded.stateInputTrackBytes,
  });
  return {
    header: decoded.header,
    roster: decoded.roster,
    bookmarks: decoded.bookmarks,
    frames120Hz,
    containerPacket,
    parserOutput: null,
    interpolationMethod,
  };
}

export function analyzeExternalFramesTouchTimelineViaWasm(
  frames: ReadonlyArray<{ snapshot?: Float32Array | number[] }>,
  scoringTeam: number,
  isNetworkStreamed: boolean,
  watchAllTouches: boolean,
  scorerCarIndex: number,
  carTeamMask: number
): WasmTouchAnalysisPodResult | null {
  const mod = getLoadedRocketSimWasmModule();
  if (!mod || frames.length === 0) return null;

  const strideFloats = 448;
  const bufPtr = mod._physics_allocTouchExternalSnapshotsBuffer(frames.length, strideFloats);
  if (!bufPtr) return null;

  const baseFloatIdx = bufPtr >>> 2;
  const heapF32 = mod.HEAPF32;
  for (let i = 0; i < frames.length; i++) {
    const snap = frames[i]?.snapshot;
    const dst = baseFloatIdx + i * strideFloats;
    if (snap && snap.length > 0) {
      const copyLen = Math.min(strideFloats, snap.length);
      for (let k = 0; k < copyLen; k++) {
        heapF32[dst + k] = snap[k] || 0;
      }
    }
  }

  mod._physics_analyzeExternalTouchSnapshots(
    frames.length,
    strideFloats,
    scoringTeam,
    isNetworkStreamed ? 1 : 0,
    watchAllTouches ? 1 : 0,
    scorerCarIndex,
    carTeamMask >>> 0
  );

  const dv = new DataView(mod.HEAPU8.buffer);
  const sumPtr = mod._physics_getReplayTouchAnalysisSummaryPtr();
  const touchCount = dv.getUint32(sumPtr, true);
  const reboundCount = dv.getUint32(sumPtr + 4, true);
  const lastScoringTouchFrameIdx = dv.getInt32(sumPtr + 8, true);
  const goalLineFrameIdx = dv.getInt32(sumPtr + 12, true);
  const resolvedScorerCarIndex = dv.getInt32(sumPtr + 16, true);
  const openingCarIndex = dv.getInt32(sumPtr + 20, true);
  const resolvedLateralBias = dv.getFloat32(sumPtr + 24, true);
  const hasSettled = dv.getUint32(sumPtr + 28, true) !== 0;
  const initialSettledCarPos = hasSettled
    ? {
        carIndex: dv.getInt32(sumPtr + 32, true),
        x: dv.getFloat32(sumPtr + 36, true),
        y: dv.getFloat32(sumPtr + 40, true),
        z: dv.getFloat32(sumPtr + 44, true),
      }
    : null;

  const touchEvents: ReplayTouchEvent[] = [];
  const touchPtr = mod._physics_getReplayTouchEventsPtr();
  if (touchPtr && touchCount > 0) {
    for (let i = 0; i < touchCount; i++) {
      const b = touchPtr + i * 32;
      touchEvents.push({
        frameIndex: dv.getUint32(b, true),
        tick: dv.getUint32(b + 4, true),
        carIndex: dv.getUint32(b + 8, true),
        team: dv.getUint32(b + 12, true),
        ballX: dv.getFloat32(b + 16, true),
        ballY: dv.getFloat32(b + 20, true),
        ballZ: dv.getFloat32(b + 24, true),
      });
    }
  }

  const reboundEvents: ReplayReboundEvent[] = [];
  const rbPtr = mod._physics_getReplayReboundEventsPtr();
  if (rbPtr && reboundCount > 0) {
    for (let i = 0; i < reboundCount; i++) {
      const b = rbPtr + i * 32;
      reboundEvents.push({
        frameIndex: dv.getUint32(b, true),
        tick: dv.getUint32(b + 4, true),
        ballX: dv.getFloat32(b + 8, true),
        ballY: dv.getFloat32(b + 12, true),
        ballZ: dv.getFloat32(b + 16, true),
        normX: dv.getFloat32(b + 20, true),
        normY: dv.getFloat32(b + 24, true),
      });
    }
  }

  return {
    touchEvents,
    reboundEvents,
    lastScoringTouchFrameIdx,
    goalLineFrameIdx,
    resolvedScorerCarIndex,
    openingCarIndex,
    resolvedLateralBias,
    initialSettledCarPos,
  };
}
