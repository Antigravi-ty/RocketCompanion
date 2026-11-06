/**
 * wasmReplayTrackExtractor.ts
 * Pure WASM memory view extractor for replay state, incident, and signal byte tracks.
 */

export interface ExtractedWasmReplayTracks {
  frameCount: number;
  stateStride: number;
  incidentCount: number;
  signalCount: number;
  stateInputBytes: Uint8Array;
  incidentBytes: Uint8Array;
  signalBytes: Uint8Array;
}

export function getWasmReplayFrameByOffset(
  wasmModule: Record<string, any> | null | undefined,
  stateLen: number,
  ticksAgo = 0
): Float32Array | null {
  const ptr = wasmModule?._physics_getReplayFramePtr?.(ticksAgo) || 0;
  if (!ptr || !wasmModule?.HEAPF32?.buffer) return null;
  return new Float32Array(wasmModule.HEAPF32.buffer, ptr, stateLen);
}

export function getWasmReplayFrameByIndex(
  wasmModule: Record<string, any> | null | undefined,
  stateLen: number,
  frameIndex = 0
): Float32Array | null {
  const ptr = wasmModule?._physics_getReplayFramePtrByIndex?.(frameIndex) || 0;
  if (!ptr || !wasmModule?.HEAPF32?.buffer) return null;
  return new Float32Array(wasmModule.HEAPF32.buffer, ptr, stateLen);
}

export function getWasmReplayControlsByIndex(
  wasmModule: Record<string, any> | null | undefined,
  frameIndex = 0
): Uint8Array | null {
  const ptr = wasmModule?._physics_getReplayControlsPtrByIndex?.(frameIndex) || 0;
  if (!ptr || !wasmModule?.HEAPU8?.buffer) return null;
  return new Uint8Array(wasmModule.HEAPU8.buffer, ptr, 64);
}

export function getWasmReplayStateTrackBytes(
  wasmModule: Record<string, any> | null | undefined,
  frameCount: number,
  stateStride: number
): Uint8Array {
  const ptr = wasmModule?._physics_getReplayStateTrackPtr?.() || 0;
  if (!ptr || frameCount <= 0 || stateStride <= 0 || !wasmModule?.HEAPU8?.buffer) {
    return new Uint8Array(0);
  }
  return new Uint8Array(wasmModule.HEAPU8.buffer, ptr, frameCount * stateStride);
}

export function getWasmReplayIncidentTrackBytes(
  wasmModule: Record<string, any> | null | undefined,
  incidentCount: number
): Uint8Array {
  const ptr = wasmModule?._physics_getReplayIncidentTrackPtr?.() || 0;
  if (!ptr || incidentCount <= 0 || !wasmModule?.HEAPU8?.buffer) {
    return new Uint8Array(0);
  }
  return new Uint8Array(wasmModule.HEAPU8.buffer, ptr, incidentCount * 64);
}

export function getWasmReplaySignalTrackBytes(
  wasmModule: Record<string, any> | null | undefined,
  signalCount: number
): Uint8Array {
  const ptr = wasmModule?._physics_getReplaySignalTrackPtr?.() || 0;
  if (!ptr || signalCount <= 0 || !wasmModule?.HEAPU8?.buffer) {
    return new Uint8Array(0);
  }
  return new Uint8Array(wasmModule.HEAPU8.buffer, ptr, signalCount * 64);
}

export function extractWasmReplayTracks(
  wasmModule: Record<string, any> | null | undefined,
  frameCount: number,
  stateStride: number,
  incidentCount: number,
  signalCount: number
): ExtractedWasmReplayTracks {
  const stateView = getWasmReplayStateTrackBytes(wasmModule, frameCount, stateStride);
  const incidentView = getWasmReplayIncidentTrackBytes(wasmModule, incidentCount);
  const signalView = getWasmReplaySignalTrackBytes(wasmModule, signalCount);

  const stateInputBytes = new Uint8Array(stateView.byteLength);
  if (stateView.byteLength > 0) stateInputBytes.set(stateView);

  const incidentBytes = new Uint8Array(incidentView.byteLength);
  if (incidentView.byteLength > 0) incidentBytes.set(incidentView);

  const signalBytes = new Uint8Array(signalView.byteLength);
  if (signalView.byteLength > 0) signalBytes.set(signalView);

  return {
    frameCount,
    stateStride,
    incidentCount,
    signalCount,
    stateInputBytes,
    incidentBytes,
    signalBytes,
  };
}
