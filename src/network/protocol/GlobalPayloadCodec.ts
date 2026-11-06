/**
 * src/network/protocol/GlobalPayloadCodec.ts
 * Ultra-fast Binary Serialization & Deserialization for Shared Global Payloads.
 */

import {
  InputPacketCodec,
  type CarControlsInput,
  type UnpackedCarControls,
} from './InputPacketCodec.ts';
import {
  INCIDENT_EVENT_TYPES,
  SYSTEM_CONTROL_SIGNALS,
  SIGNAL_EVENT_TYPES,
  CLIENT_COMMAND_TYPES,
  isIncidentEvent,
  isServerSignal,
  isSystemControlSignal,
  isClientCommand,
} from '../../physics/RocketSimConstants.ts';
import {
  BOOST_PAD_BITMASK_BYTES,
  packBoostPadBitmask,
  unpackBoostPadBitmaskIntoSnapshot,
  createBoostPadEdgeTracker,
  seedBoostPadEdgeTrackerFromSnapshot,
  applyBoostPadEdgeCooldowns,
  type BoostPadBitmask,
  type BoostPadEdgeTracker,
} from './boostPadBitmaskPipeline.ts';

export {
  INCIDENT_EVENT_TYPES,
  SYSTEM_CONTROL_SIGNALS,
  SIGNAL_EVENT_TYPES,
  CLIENT_COMMAND_TYPES,
  isIncidentEvent,
  isServerSignal,
  isSystemControlSignal,
  isClientCommand,
  BOOST_PAD_BITMASK_BYTES,
  packBoostPadBitmask,
  unpackBoostPadBitmaskIntoSnapshot,
  createBoostPadEdgeTracker,
  seedBoostPadEdgeTrackerFromSnapshot,
  applyBoostPadEdgeCooldowns,
  type BoostPadBitmask,
  type BoostPadEdgeTracker,
  type CarControlsInput,
  type UnpackedCarControls,
};

export const MATCH_SIGNALS = SIGNAL_EVENT_TYPES;

export const PAYLOAD_FLAGS = Object.freeze({
  PHYSICS: 1 << 0,
  SIGNAL: 1 << 1,
  ALL_RTT: 1 << 2,
  RESERVED_3: 1 << 3,
  RESERVED_4: 1 << 4,
  RESERVED_5: 1 << 5,
  RESERVED_6: 1 << 6,
  RESERVED_7: 1 << 7,
});

export const SIGNAL_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(MATCH_SIGNALS).map(([k, v]) => [v, k]))
);

export const SPARSE_SNAPSHOT_MAGIC_MASK = 0xa800;

export interface GlobalPhysicsSection {
  tick: number;
  activeCarMask?: number;
  activeCarIndices?: number[];
  boostPadMaskLow?: number;
  boostPadMaskHigh?: number;
  acknowledgedControls?: Array<{
    carIndex: number;
    controls: CarControlsInput;
  }>;
  stateSnapshot: Float32Array | number[];
}

export interface AcknowledgedCarControlEntry {
  carIndex: number;
  controls: CarControlsInput;
}

export interface MatchIncidentPayload {
  type?: number;
  tick?: number;
  carIndex?: number;
  primaryId?: number;
  secondaryId?: number;
  team?: number;
  x?: number;
  y?: number;
  z?: number;
  signalId?: number;
  signalType?: number;
  name?: string;
  frameId?: number;
  param1?: number;
  param2?: number;
  [key: string]: any;
}

export interface GlobalSignalEntry {
  signalId?: number;
  signalType: number;
  name?: string;
  frameId?: number;
  param1?: number;
  param2?: number;
  expiresAtTick?: number | null;
}

export type MatchSignalDescriptor = GlobalSignalEntry;

export interface SpectatorRttEntry {
  id: number;
  rtt: number;
}

export interface AllUserRttSection {
  players?: Array<number | null | undefined>;
  spectators?: SpectatorRttEntry[];
}

export interface GlobalPayloadEncodeInput {
  physics?: GlobalPhysicsSection | null;
  signals?: GlobalSignalEntry[];
  allUserRtt?: AllUserRttSection | null;
}

export interface DecodedGlobalPayload {
  flagByte: number;
  hasPhysics: boolean;
  hasSignals: boolean;
  hasAllUserRtt: boolean;
  physics: {
    tick: number;
    activeCarMask: number;
    activeCarIndices: number[];
    boostPadMaskLow?: number;
    boostPadMaskHigh?: number;
    acknowledgedControls: Array<{
      carIndex: number;
      controls: UnpackedCarControls;
    }>;
    stateSnapshot: Float32Array;
  } | null;
  signals: Array<{
    signalId: number;
    signalType: number;
    name: string;
    frameId: number;
    param1: number;
    param2: number;
  }>;
  allUserRtt: {
    players: Array<number | null>;
    spectators: SpectatorRttEntry[];
  } | null;
}

function resolveActiveCarMaskForEncode(physics: Partial<GlobalPhysicsSection> = {}): number {
  if (typeof physics.activeCarMask === 'number' && physics.activeCarMask > 0) {
    return physics.activeCarMask & 0xff;
  }
  const ackList = physics.acknowledgedControls || [];
  if (ackList.length > 0) {
    let mask = 0;
    for (let i = 0; i < ackList.length; i++) {
      const idx = ackList[i]?.carIndex;
      if (typeof idx === 'number' && idx >= 0 && idx < 8) mask |= 1 << idx;
    }
    if (mask > 0) return mask & 0xff;
  }
  const snap = physics.stateSnapshot;
  if (snap && snap.length >= 448) {
    const numCars = Math.min(8, Math.max(0, Math.round(snap[2] || 0)));
    let mask = 0;
    for (let c = 0; c < numCars; c++) {
      const base = 22 + c * 40;
      const fx = snap[base + 3];
      const fy = snap[base + 4];
      const fz = snap[base + 5];
      if (fx * fx + fy * fy + fz * fz > 0.01) mask |= 1 << c;
    }
    if (mask > 0) return mask & 0xff;
    return ((1 << Math.max(1, numCars)) - 1) & 0xff;
  }
  return 0x01;
}

export function maskToActiveCarIndices(mask?: number | null): number[] {
  const indices: number[] = [];
  const safeMask = (mask || 0) & 0xff;
  for (let c = 0; c < 8; c++) {
    if ((safeMask & (1 << c)) !== 0) indices.push(c);
  }
  return indices;
}

export class GlobalPayloadCodec {
  static encode(payload: GlobalPayloadEncodeInput = {}): Uint8Array {
    let flagByte = 0;
    const physics = payload.physics;
    const hasPhysics = Boolean(physics && physics.stateSnapshot);
    const signals = payload.signals || [];
    const hasSignals = signals.length > 0;
    const hasAllUserRtt = Boolean(payload.allUserRtt);

    if (hasPhysics) flagByte |= PAYLOAD_FLAGS.PHYSICS;
    if (hasSignals) flagByte |= PAYLOAD_FLAGS.SIGNAL;
    if (hasAllUserRtt) flagByte |= PAYLOAD_FLAGS.ALL_RTT;

    let totalSize = 1;
    let snapFloats = 0;
    let ackCount = 0;
    let useSparseEncoding = false;
    let hasReplayDirectorTelemetry = false;
    let activeCarMask = 0;
    let activeCarList: number[] = [];

    if (hasPhysics && physics) {
      snapFloats = physics.stateSnapshot.length;
      ackCount = Math.min(8, (physics.acknowledgedControls || []).length);
      if (snapFloats === 448) {
        useSparseEncoding = true;
        activeCarMask = resolveActiveCarMaskForEncode(physics);
        activeCarList = maskToActiveCarIndices(activeCarMask);
        hasReplayDirectorTelemetry =
          (activeCarMask & (1 << 7)) === 0 &&
          Math.abs((physics.stateSnapshot[302] || 0) - 1337.5) <= 0.01;
        const encodedFloats =
          28 + activeCarList.length * 44 + (hasReplayDirectorTelemetry ? 27 : 0);
        totalSize += 4 + 1 + ackCount * 4 + 2 + BOOST_PAD_BITMASK_BYTES + encodedFloats * 4;
      } else {
        totalSize += 4 + 1 + ackCount * 4 + 2 + snapFloats * 4;
      }
    }
    if (hasSignals) totalSize += 1 + signals.length * 15;
    const spectators = payload.allUserRtt?.spectators || [];
    if (hasAllUserRtt) totalSize += 12 + 1 + spectators.length * 3;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    view.setUint8(0, flagByte);
    let offset = 1;

    if (hasPhysics && physics) {
      view.setUint32(offset, physics.tick || 0, false);
      offset += 4;
      view.setUint8(offset, ackCount);
      offset += 1;

      const ackList = physics.acknowledgedControls || [];
      for (let i = 0; i < ackCount; i++) {
        const item = ackList[i] || { carIndex: i, controls: {} };
        const [b0, b1, b2] = InputPacketCodec.packTickControls(item.controls || {});
        view.setUint8(offset, item.carIndex ?? i);
        view.setUint8(offset + 1, b0);
        view.setUint8(offset + 2, b1);
        view.setUint8(offset + 3, b2);
        offset += 4;
      }

      const snap = physics.stateSnapshot;
      if (useSparseEncoding) {
        const headerFlags =
          SPARSE_SNAPSHOT_MAGIC_MASK |
          (hasReplayDirectorTelemetry ? 0x0100 : 0) |
          (activeCarMask & 0xff);
        view.setUint16(offset, headerFlags, false);
        offset += 2;
        for (let i = 0; i < 22; i++) {
          view.setFloat32(offset, snap[i], false);
          offset += 4;
        }
        const padMask = packBoostPadBitmask(snap);
        view.setUint32(offset, padMask.low, false);
        offset += 4;
        view.setUint8(offset, padMask.high);
        offset += 1;
        for (let i = 410; i < 416; i++) {
          view.setFloat32(offset, snap[i], false);
          offset += 4;
        }
        for (let idx = 0; idx < activeCarList.length; idx++) {
          const c = activeCarList[idx];
          const carBase = 22 + c * 40;
          for (let f = 0; f < 40; f++) {
            view.setFloat32(offset, snap[carBase + f], false);
            offset += 4;
          }
          const extBase = 416 + c * 4;
          for (let f = 0; f < 4; f++) {
            view.setFloat32(offset, snap[extBase + f], false);
            offset += 4;
          }
        }
        if (hasReplayDirectorTelemetry) {
          for (let f = 0; f < 27; f++) {
            view.setFloat32(offset, snap[302 + f] || 0, false);
            offset += 4;
          }
        }
      } else {
        view.setUint16(offset, snapFloats, false);
        offset += 2;
        for (let i = 0; i < snapFloats; i++) {
          view.setFloat32(offset, snap[i], false);
          offset += 4;
        }
      }
    }

    if (hasSignals) {
      view.setUint8(offset, signals.length);
      offset += 1;
      for (let i = 0; i < signals.length; i++) {
        const s = signals[i];
        view.setUint16(offset, (s.signalId || 0) & 0xffff, false);
        view.setUint8(offset + 2, s.signalType);
        view.setUint32(offset + 3, s.frameId || 0, false);
        view.setUint32(offset + 7, s.param1 || 0, false);
        view.setUint32(offset + 11, s.param2 || 0, false);
        offset += 15;
      }
    }

    if (hasAllUserRtt && payload.allUserRtt) {
      const players = payload.allUserRtt.players || [];
      for (let i = 0; i < 6; i++) {
        const rtt = players[i];
        const val = typeof rtt === 'number' && rtt >= 0 ? Math.min(65534, Math.round(rtt)) : 0xffff;
        view.setUint16(offset, val, false);
        offset += 2;
      }
      view.setUint8(offset, spectators.length);
      offset += 1;
      for (let i = 0; i < spectators.length; i++) {
        const sp = spectators[i];
        view.setUint8(offset, sp.id ?? i);
        view.setUint16(offset + 1, Math.min(65534, Math.max(0, Math.round(sp.rtt ?? 0))), false);
        offset += 3;
      }
    }

    return uint8;
  }

  static decode(
    bufferInput: ArrayBuffer | Uint8Array | DataView | null | undefined,
    byteOffset = 0
  ): DecodedGlobalPayload | null {
    if (!bufferInput) return null;
    const view =
      bufferInput instanceof DataView
        ? bufferInput
        : bufferInput instanceof Uint8Array
          ? new DataView(bufferInput.buffer, bufferInput.byteOffset, bufferInput.byteLength)
          : bufferInput instanceof ArrayBuffer
            ? new DataView(bufferInput)
            : null;
    if (!view || view.byteLength < byteOffset + 1) return null;

    let offset = byteOffset;
    const flagByte = view.getUint8(offset++);
    const result: DecodedGlobalPayload = {
      flagByte,
      hasPhysics: Boolean(flagByte & PAYLOAD_FLAGS.PHYSICS),
      hasSignals: Boolean(flagByte & PAYLOAD_FLAGS.SIGNAL),
      hasAllUserRtt: Boolean(flagByte & PAYLOAD_FLAGS.ALL_RTT),
      physics: null,
      signals: [],
      allUserRtt: null,
    };

    if (result.hasPhysics) {
      if (view.byteLength < offset + 7) return result;
      const tick = view.getUint32(offset, false);
      offset += 4;
      const ackCount = view.getUint8(offset++);
      const acknowledgedControls: Array<{
        carIndex: number;
        controls: UnpackedCarControls;
      }> = [];
      for (let i = 0; i < ackCount; i++) {
        if (view.byteLength < offset + 4) break;
        const carIndex = view.getUint8(offset);
        const controls = InputPacketCodec.unpackTickControls(
          view.getUint8(offset + 1),
          view.getUint8(offset + 2),
          view.getUint8(offset + 3)
        );
        acknowledgedControls.push({ carIndex, controls });
        offset += 4;
      }

      if (view.byteLength >= offset + 2) {
        const snapHeader = view.getUint16(offset, false);
        offset += 2;
        if ((snapHeader & 0xfe00) === SPARSE_SNAPSHOT_MAGIC_MASK) {
          const hasReplayDirectorTelemetry = (snapHeader & 0x0100) !== 0;
          const activeCarMask = snapHeader & 0xff;
          const activeCarIndices = maskToActiveCarIndices(activeCarMask);
          const telemetryFloats = hasReplayDirectorTelemetry
            ? view.byteLength >=
              offset + BOOST_PAD_BITMASK_BYTES + (28 + activeCarIndices.length * 44 + 27) * 4
              ? 27
              : 12
            : 0;
          const encodedFloats = 28 + activeCarIndices.length * 44 + telemetryFloats;
          if (view.byteLength >= offset + BOOST_PAD_BITMASK_BYTES + encodedFloats * 4) {
            const stateSnapshot = new Float32Array(448);
            for (let c = 0; c < 8; c++) {
              const carBase = 22 + c * 40;
              stateSnapshot[carBase + 0] = -5500;
              stateSnapshot[carBase + 1] = c * 300;
              stateSnapshot[carBase + 2] = -500;
              stateSnapshot[carBase + 3] = 1;
              stateSnapshot[carBase + 7] = 1;
              stateSnapshot[carBase + 11] = 1;
              stateSnapshot[416 + c * 4 + 2] = -1;
            }
            for (let i = 0; i < 22; i++) {
              stateSnapshot[i] = view.getFloat32(offset, false);
              offset += 4;
            }
            const boostPadMaskLow = view.getUint32(offset, false);
            offset += 4;
            const boostPadMaskHigh = view.getUint8(offset++) & 0x03;
            unpackBoostPadBitmaskIntoSnapshot(boostPadMaskLow, boostPadMaskHigh, stateSnapshot);
            for (let i = 410; i < 416; i++) {
              stateSnapshot[i] = view.getFloat32(offset, false);
              offset += 4;
            }
            let maxSlotSpan = 0;
            for (let idx = 0; idx < activeCarIndices.length; idx++) {
              const c = activeCarIndices[idx];
              if (c + 1 > maxSlotSpan) maxSlotSpan = c + 1;
              const carBase = 22 + c * 40;
              for (let f = 0; f < 40; f++) {
                stateSnapshot[carBase + f] = view.getFloat32(offset, false);
                offset += 4;
              }
              const extBase = 416 + c * 4;
              for (let f = 0; f < 4; f++) {
                stateSnapshot[extBase + f] = view.getFloat32(offset, false);
                offset += 4;
              }
            }
            if (hasReplayDirectorTelemetry) {
              for (let f = 0; f < telemetryFloats; f++) {
                stateSnapshot[302 + f] = view.getFloat32(offset, false);
                offset += 4;
              }
            }
            if (maxSlotSpan > 0) stateSnapshot[2] = maxSlotSpan;
            result.physics = {
              tick,
              activeCarMask,
              activeCarIndices,
              boostPadMaskLow,
              boostPadMaskHigh,
              acknowledgedControls,
              stateSnapshot,
            };
          }
        } else {
          const snapFloats = snapHeader;
          if (view.byteLength >= offset + snapFloats * 4) {
            const stateSnapshot = new Float32Array(snapFloats);
            for (let i = 0; i < snapFloats; i++) {
              stateSnapshot[i] = view.getFloat32(offset, false);
              offset += 4;
            }
            let activeCarMask = 0;
            for (let i = 0; i < acknowledgedControls.length; i++) {
              const c = acknowledgedControls[i]?.carIndex;
              if (typeof c === 'number' && c >= 0 && c < 8) activeCarMask |= 1 << c;
            }
            if (activeCarMask === 0 && snapFloats >= 3) {
              const n = Math.min(8, Math.max(1, Math.round(stateSnapshot[2] || 1)));
              activeCarMask = ((1 << n) - 1) & 0xff;
            }
            result.physics = {
              tick,
              activeCarMask,
              activeCarIndices: maskToActiveCarIndices(activeCarMask),
              acknowledgedControls,
              stateSnapshot,
            };
          }
        }
      }
    }

    if (result.hasSignals && view.byteLength >= offset + 1) {
      const count = view.getUint8(offset++);
      for (let i = 0; i < count; i++) {
        if (view.byteLength < offset + 15) break;
        const signalId = view.getUint16(offset, false);
        const signalType = view.getUint8(offset + 2);
        const frameId = view.getUint32(offset + 3, false);
        const param1 = view.getUint32(offset + 7, false);
        const param2 = view.getUint32(offset + 11, false);
        result.signals.push({
          signalId,
          signalType,
          name: SIGNAL_NAMES[signalType] || `SIGNAL_0x${signalType.toString(16).toUpperCase()}`,
          frameId,
          param1,
          param2,
        });
        offset += 15;
      }
    }

    if (result.hasAllUserRtt && view.byteLength >= offset + 13) {
      const players: Array<number | null> = [];
      for (let i = 0; i < 6; i++) {
        const val = view.getUint16(offset, false);
        players.push(val === 0xffff ? null : val);
        offset += 2;
      }
      const spectatorCount = view.getUint8(offset++);
      const spectators: SpectatorRttEntry[] = [];
      for (let i = 0; i < spectatorCount; i++) {
        if (view.byteLength < offset + 3) break;
        spectators.push({
          id: view.getUint8(offset),
          rtt: view.getUint16(offset + 1, false),
        });
        offset += 3;
      }
      result.allUserRtt = { players, spectators };
    }

    return result;
  }
}
