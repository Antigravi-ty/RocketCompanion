/**
 * src/network/GlobalPayloadCodec.js
 * Ultra-fast Binary Serialization & Deserialization for Shared Global Payloads.
 *
 * Wire Protocol Specification:
 * [0] Flag Byte (8-bit bitmask):
 *     - Bit 0 (0x01): FLAG_PHYSICS   - Physics state snapshot & acknowledged user inputs.
 *     - Bit 1 (0x02): FLAG_SIGNAL    - Authoritative signals (0x80..0xBF) & command ACKs.
 *     - Bit 2 (0x04): FLAG_ALL_RTT   - 5-second interval all-user RTT telemetry table.
 *     - Bits 3..7:    Reserved for future extensible packet types.
 *
 * [1..] Section 1: Physics State (if FLAG_PHYSICS):
 *     - tick (uint32 BE, 4 bytes)
 *     - ackCount (uint8, 1 byte, 0..6)
 *     - ackCount * 4 bytes: [carIndex (uint8), packedControls (3 bytes)]
 *     - snapHeader (uint16 BE, 2 bytes):
 *       - Sparse 448-float mode (0xA800 | activeCarMask):
 *         - Header (0..3) + Ball (4..21) = 22 floats (88 bytes)
 *         - Boost Pads 34-bit active bitmask = 5 bytes (uint32 BE pads 0..31 + uint8 pads 32..33)
 *         - Extended Arena Header (410..415) = 6 floats (24 bytes)
 *         - Active Car Slots = activeCarCount * 44 floats (40 car + 4 extended floats)
 *       - Dense fallback mode: snapFloatsCount * 4 bytes (IEEE 754 float32 array)
 *
 * [...] Section 2: Match Signals (if FLAG_SIGNAL):
 *     - signalCount (uint8, 1 byte)
 *     - signalCount * 15 bytes:
 *       - signalId (uint16 BE, 2 bytes)
 *       - signalType (uint8, 1 byte, 0x80..0xBF Server Signal)
 *       - frameId (uint32 BE, 4 bytes)
 *       - param1 (uint32 BE, 4 bytes)
 *       - param2 (uint32 BE, 4 bytes)
 *
 * [...] Section 3: All-User RTT Table (if FLAG_ALL_RTT):
 *     - Fixed 6-player slots (12 bytes = 6 * uint16 BE):
 *       RTT in milliseconds for car indices 0..5 (0xFFFF if slot unoccupied).
 *     - spectatorCount (uint8, 1 byte)
 *     - spectatorCount * 3 bytes: [spectatorId (uint8), rttMs (uint16 BE)]
 */

import { InputPacketCodec } from './InputPacketCodec.js';
import {
  NUM_BOOST_PADS,
  BOOST_PAD_STATES_OFFSET,
  BOOST_PAD_STATE_STRIDE,
  BOOST_PAD_TIMEOUT_BIG,
  BOOST_PAD_TIMEOUT_SMALL,
  INCIDENT_EVENT_TYPES,
  SIGNAL_EVENT_TYPES,
  CLIENT_COMMAND_TYPES,
  isIncidentEvent,
  isServerSignal,
  isClientCommand
} from '../../physics/RocketSimConstants.js';

export {
  INCIDENT_EVENT_TYPES,
  SIGNAL_EVENT_TYPES,
  CLIENT_COMMAND_TYPES,
  isIncidentEvent,
  isServerSignal,
  isClientCommand
};

export const MATCH_SIGNALS = SIGNAL_EVENT_TYPES;

export const PAYLOAD_FLAGS = Object.freeze({
  PHYSICS: 1 << 0,   // 0x01
  SIGNAL: 1 << 1,    // 0x02
  ALL_RTT: 1 << 2,   // 0x04
  RESERVED_3: 1 << 3,
  RESERVED_4: 1 << 4,
  RESERVED_5: 1 << 5,
  RESERVED_6: 1 << 6,
  RESERVED_7: 1 << 7
});

export const SIGNAL_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(MATCH_SIGNALS).map(([k, v]) => [v, k]))
);

export const SPARSE_SNAPSHOT_MAGIC_MASK = 0xA800;
export const BOOST_PAD_BITMASK_BYTES = 5;

export function packBoostPadBitmask(snap) {
  let low = 0;
  let high = 0;
  if (snap && snap.length >= BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE) {
    for (let i = 0; i < 32; i++) {
      if (snap[BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE] > 0.5) {
        low |= (1 << i);
      }
    }
    for (let i = 32; i < NUM_BOOST_PADS; i++) {
      if (snap[BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE] > 0.5) {
        high |= (1 << (i - 32));
      }
    }
  } else {
    low = 0xFFFFFFFF;
    high = 0x03;
  }
  return { low: low >>> 0, high: high & 0x03 };
}

export function unpackBoostPadBitmaskIntoSnapshot(low, high, stateSnapshot) {
  const uLow = low >>> 0;
  const uHigh = high & 0x03;
  for (let i = 0; i < 32; i++) {
    const isActive = (uLow & (1 << i)) !== 0;
    const base = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
    stateSnapshot[base] = isActive ? 1.0 : 0.0;
    stateSnapshot[base + 1] = isActive ? 0.0 : (i < 6 ? BOOST_PAD_TIMEOUT_BIG : BOOST_PAD_TIMEOUT_SMALL);
  }
  for (let i = 32; i < NUM_BOOST_PADS; i++) {
    const isActive = (uHigh & (1 << (i - 32))) !== 0;
    const base = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
    stateSnapshot[base] = isActive ? 1.0 : 0.0;
    stateSnapshot[base + 1] = isActive ? 0.0 : BOOST_PAD_TIMEOUT_SMALL;
  }
}

export function createBoostPadEdgeTracker() {
  return {
    initialized: false,
    lastTick: -1,
    prevActive: new Uint8Array(NUM_BOOST_PADS),
    deactivatedAtTick: new Int32Array(NUM_BOOST_PADS).fill(-1)
  };
}

export function seedBoostPadEdgeTrackerFromSnapshot(tracker, stateSnapshot, tick = 0) {
  if (!tracker || !stateSnapshot || stateSnapshot.length < BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE) {
    return;
  }
  const safeTick = Math.max(0, Math.floor(tick || stateSnapshot[0] || 0));
  for (let i = 0; i < NUM_BOOST_PADS; i++) {
    const base = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
    const fullTimeout = i < 6 ? BOOST_PAD_TIMEOUT_BIG : BOOST_PAD_TIMEOUT_SMALL;
    const isActive = stateSnapshot[base] > 0.5 ? 1 : 0;
    tracker.prevActive[i] = isActive;
    if (isActive === 1) {
      tracker.deactivatedAtTick[i] = -1;
      stateSnapshot[base + 1] = 0.0;
    } else {
      const rawCooldown = stateSnapshot[base + 1];
      const clampedCooldown = (Number.isFinite(rawCooldown) && rawCooldown > 0 && rawCooldown <= fullTimeout)
        ? rawCooldown
        : fullTimeout;
      const elapsedTicks = Math.round(Math.max(0, fullTimeout - clampedCooldown) * 120);
      tracker.deactivatedAtTick[i] = safeTick - elapsedTicks;
      stateSnapshot[base + 1] = clampedCooldown;
    }
  }
  tracker.initialized = true;
  tracker.lastTick = safeTick;
}

export function applyBoostPadEdgeCooldowns(stateSnapshot, tick = 0, tracker = null) {
  if (!stateSnapshot || stateSnapshot.length < BOOST_PAD_STATES_OFFSET + NUM_BOOST_PADS * BOOST_PAD_STATE_STRIDE || !tracker) {
    return stateSnapshot;
  }
  const safeTick = Math.max(0, Math.floor(tick || stateSnapshot[0] || 0));
  const isResetOrFirst = !tracker.initialized || safeTick < tracker.lastTick;

  for (let i = 0; i < NUM_BOOST_PADS; i++) {
    const base = BOOST_PAD_STATES_OFFSET + i * BOOST_PAD_STATE_STRIDE;
    const fullTimeout = i < 6 ? BOOST_PAD_TIMEOUT_BIG : BOOST_PAD_TIMEOUT_SMALL;
    const isActive = stateSnapshot[base] > 0.5 ? 1 : 0;

    if (isResetOrFirst) {
      tracker.prevActive[i] = isActive;
      if (isActive === 1) {
        tracker.deactivatedAtTick[i] = -1;
        stateSnapshot[base + 1] = 0.0;
      } else {
        tracker.deactivatedAtTick[i] = safeTick;
        stateSnapshot[base + 1] = fullTimeout;
      }
    } else if (isActive === 1) {
      tracker.prevActive[i] = 1;
      tracker.deactivatedAtTick[i] = -1;
      stateSnapshot[base + 1] = 0.0;
    } else {
      if (tracker.prevActive[i] === 1 || tracker.deactivatedAtTick[i] < 0) {
        tracker.prevActive[i] = 0;
        tracker.deactivatedAtTick[i] = safeTick;
        stateSnapshot[base + 1] = fullTimeout;
      } else {
        const timeoutTicks = Math.round(fullTimeout * 120);
        const elapsedTicks = Math.max(0, safeTick - tracker.deactivatedAtTick[i]);
        if (timeoutTicks > 0 && elapsedTicks >= timeoutTicks) {
          const cycleRemainderTicks = elapsedTicks % timeoutTicks;
          tracker.deactivatedAtTick[i] = safeTick - cycleRemainderTicks;
          stateSnapshot[base + 1] = Math.max(0.0, fullTimeout - cycleRemainderTicks / 120.0);
        } else {
          const elapsedSeconds = elapsedTicks / 120.0;
          stateSnapshot[base + 1] = Math.max(0.0, fullTimeout - elapsedSeconds);
        }
      }
    }
  }

  tracker.initialized = true;
  tracker.lastTick = safeTick;
  return stateSnapshot;
}

function resolveActiveCarMaskForEncode(physics = {}) {
  if (typeof physics.activeCarMask === 'number' && physics.activeCarMask > 0) {
    return physics.activeCarMask & 0xFF;
  }
  const ackList = physics.acknowledgedControls || [];
  if (ackList.length > 0) {
    let mask = 0;
    for (let i = 0; i < ackList.length; i++) {
      const idx = ackList[i]?.carIndex;
      if (typeof idx === 'number' && idx >= 0 && idx < 8) {
        mask |= (1 << idx);
      }
    }
    if (mask > 0) return mask & 0xFF;
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
      const fLenSq = fx * fx + fy * fy + fz * fz;
      if (fLenSq > 0.01) {
        mask |= (1 << c);
      }
    }
    if (mask > 0) return mask & 0xFF;
    return ((1 << Math.max(1, numCars)) - 1) & 0xFF;
  }
  return 0x01;
}

export function maskToActiveCarIndices(mask) {
  const indices = [];
  const safeMask = (mask || 0) & 0xFF;
  for (let c = 0; c < 8; c++) {
    if ((safeMask & (1 << c)) !== 0) {
      indices.push(c);
    }
  }
  return indices;
}

export class GlobalPayloadCodec {
  static encode(payload = {}) {
    let flagByte = 0;
    const hasPhysics = Boolean(payload.physics && payload.physics.stateSnapshot);
    const signals = payload.signals || [];
    const hasSignals = signals.length > 0;
    const hasAllUserRtt = Boolean(payload.allUserRtt);

    if (hasPhysics) flagByte |= PAYLOAD_FLAGS.PHYSICS;
    if (hasSignals) flagByte |= PAYLOAD_FLAGS.SIGNAL;
    if (hasAllUserRtt) flagByte |= PAYLOAD_FLAGS.ALL_RTT;

    let totalSize = 1;

    let physicsByteSize = 0;
    let snapFloats = 0;
    let ackCount = 0;
    let useSparseEncoding = false;
    let hasReplayDirectorTelemetry = false;
    let activeCarMask = 0;
    let activeCarList = [];
    if (hasPhysics) {
      snapFloats = payload.physics.stateSnapshot.length;
      ackCount = Math.min(8, (payload.physics.acknowledgedControls || []).length);
      if (snapFloats === 448) {
        useSparseEncoding = true;
        activeCarMask = resolveActiveCarMaskForEncode(payload.physics);
        activeCarList = maskToActiveCarIndices(activeCarMask);
        hasReplayDirectorTelemetry =
          (activeCarMask & (1 << 7)) === 0 &&
          Math.abs((payload.physics.stateSnapshot[302] || 0) - 1337.5) <= 0.01;
        const encodedFloats =
          28 + activeCarList.length * 44 + (hasReplayDirectorTelemetry ? 12 : 0);
        physicsByteSize = 4 + 1 + (ackCount * 4) + 2 + BOOST_PAD_BITMASK_BYTES + (encodedFloats * 4);
      } else {
        physicsByteSize = 4 + 1 + (ackCount * 4) + 2 + (snapFloats * 4);
      }
      totalSize += physicsByteSize;
    }

    let signalsByteSize = 0;
    if (hasSignals) {
      signalsByteSize = 1 + (signals.length * 15);
      totalSize += signalsByteSize;
    }

    let rttByteSize = 0;
    const spectators = payload.allUserRtt?.spectators || [];
    if (hasAllUserRtt) {
      rttByteSize = 12 + 1 + (spectators.length * 3);
      totalSize += rttByteSize;
    }

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    view.setUint8(0, flagByte);
    let offset = 1;

    if (hasPhysics) {
      view.setUint32(offset, payload.physics.tick || 0, false);
      offset += 4;
      view.setUint8(offset, ackCount);
      offset += 1;

      const ackList = payload.physics.acknowledgedControls || [];
      for (let i = 0; i < ackCount; i++) {
        const item = ackList[i] || {};
        const carIndex = item.carIndex ?? i;
        const ctrl = item.controls || {};
        const [b0, b1, b2] = InputPacketCodec.packTickControls(ctrl);
        view.setUint8(offset, carIndex);
        view.setUint8(offset + 1, b0);
        view.setUint8(offset + 2, b1);
        view.setUint8(offset + 3, b2);
        offset += 4;
      }

      const snap = payload.physics.stateSnapshot;
      if (useSparseEncoding) {
        const headerFlags =
          SPARSE_SNAPSHOT_MAGIC_MASK |
          (hasReplayDirectorTelemetry ? 0x0100 : 0) |
          (activeCarMask & 0xFF);
        view.setUint16(offset, headerFlags, false);
        offset += 2;
        // 1. Header (0..3) + Ball (4..21) = 22 floats
        for (let i = 0; i < 22; i++) {
          view.setFloat32(offset, snap[i], false);
          offset += 4;
        }
        // 2. Boost pads 34-bit active bitmask (5 bytes: uint32 BE for pads 0..31 + uint8 for pads 32..33)
        const padMask = packBoostPadBitmask(snap);
        view.setUint32(offset, padMask.low, false);
        offset += 4;
        view.setUint8(offset, padMask.high);
        offset += 1;
        // 3. Extended Arena header (410..415) = 6 floats
        for (let i = 410; i < 416; i++) {
          view.setFloat32(offset, snap[i], false);
          offset += 4;
        }
        // 4. Active Car Slots only: 40 car floats + 4 extended jump/airTime floats per active slot
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
        // 5. Optional Embedded Replay Director Telemetry block (snap[302..313] = 12 floats)
        if (hasReplayDirectorTelemetry) {
          for (let f = 0; f < 12; f++) {
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
        view.setUint16(offset, (s.signalId || 0) & 0xFFFF, false);
        view.setUint8(offset + 2, s.signalType);
        view.setUint32(offset + 3, s.frameId || 0, false);
        view.setUint32(offset + 7, s.param1 || 0, false);
        view.setUint32(offset + 11, s.param2 || 0, false);
        offset += 15;
      }
    }

    if (hasAllUserRtt) {
      const players = payload.allUserRtt.players || [];
      for (let i = 0; i < 6; i++) {
        const rtt = players[i];
        const val = (typeof rtt === 'number' && rtt >= 0) ? Math.min(65534, Math.round(rtt)) : 0xFFFF;
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

  static decode(bufferInput, byteOffset = 0) {
    if (!bufferInput) return null;

    let view;
    if (bufferInput instanceof DataView) {
      view = bufferInput;
    } else if (bufferInput instanceof Uint8Array) {
      view = new DataView(bufferInput.buffer, bufferInput.byteOffset, bufferInput.byteLength);
    } else if (bufferInput instanceof ArrayBuffer) {
      view = new DataView(bufferInput);
    } else {
      return null;
    }

    if (view.byteLength < byteOffset + 1) return null;

    let offset = byteOffset;
    const flagByte = view.getUint8(offset);
    offset += 1;

    const result = {
      flagByte,
      hasPhysics: Boolean(flagByte & PAYLOAD_FLAGS.PHYSICS),
      hasSignals: Boolean(flagByte & PAYLOAD_FLAGS.SIGNAL),
      hasAllUserRtt: Boolean(flagByte & PAYLOAD_FLAGS.ALL_RTT),
      physics: null,
      signals: [],
      allUserRtt: null
    };

    if (result.hasPhysics) {
      if (view.byteLength < offset + 7) return result;
      const tick = view.getUint32(offset, false);
      offset += 4;
      const ackCount = view.getUint8(offset);
      offset += 1;

      const acknowledgedControls = [];
      for (let i = 0; i < ackCount; i++) {
        if (view.byteLength < offset + 4) break;
        const carIndex = view.getUint8(offset);
        const b0 = view.getUint8(offset + 1);
        const b1 = view.getUint8(offset + 2);
        const b2 = view.getUint8(offset + 3);
        const controls = InputPacketCodec.unpackTickControls(b0, b1, b2);
        acknowledgedControls.push({ carIndex, controls });
        offset += 4;
      }

      if (view.byteLength >= offset + 2) {
        const snapHeader = view.getUint16(offset, false);
        offset += 2;
        if ((snapHeader & 0xFE00) === SPARSE_SNAPSHOT_MAGIC_MASK) {
          const hasReplayDirectorTelemetry = (snapHeader & 0x0100) !== 0;
          const activeCarMask = snapHeader & 0xFF;
          const activeCarIndices = maskToActiveCarIndices(activeCarMask);
          const encodedFloats =
            28 + activeCarIndices.length * 44 + (hasReplayDirectorTelemetry ? 12 : 0);
          if (view.byteLength >= offset + BOOST_PAD_BITMASK_BYTES + (encodedFloats * 4)) {
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
            const boostPadMaskHigh = view.getUint8(offset) & 0x03;
            offset += 1;
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
              for (let f = 0; f < 12; f++) {
                stateSnapshot[302 + f] = view.getFloat32(offset, false);
                offset += 4;
              }
            }
            if (maxSlotSpan > 0) {
              stateSnapshot[2] = maxSlotSpan;
            }
            result.physics = {
              tick,
              activeCarMask,
              activeCarIndices,
              boostPadMaskLow,
              boostPadMaskHigh,
              acknowledgedControls,
              stateSnapshot
            };
          }
        } else {
          const snapFloats = snapHeader;
          if (view.byteLength >= offset + (snapFloats * 4)) {
            const stateSnapshot = new Float32Array(snapFloats);
            for (let i = 0; i < snapFloats; i++) {
              stateSnapshot[i] = view.getFloat32(offset, false);
              offset += 4;
            }
            let activeCarMask = 0;
            for (let i = 0; i < acknowledgedControls.length; i++) {
              const c = acknowledgedControls[i]?.carIndex;
              if (typeof c === 'number' && c >= 0 && c < 8) activeCarMask |= (1 << c);
            }
            if (activeCarMask === 0 && snapFloats >= 3) {
              const n = Math.min(8, Math.max(1, Math.round(stateSnapshot[2] || 1)));
              activeCarMask = ((1 << n) - 1) & 0xFF;
            }
            result.physics = {
              tick,
              activeCarMask,
              activeCarIndices: maskToActiveCarIndices(activeCarMask),
              acknowledgedControls,
              stateSnapshot
            };
          }
        }
      }
    }

    if (result.hasSignals) {
      if (view.byteLength >= offset + 1) {
        const count = view.getUint8(offset);
        offset += 1;
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
            param2
          });
          offset += 15;
        }
      }
    }

    if (result.hasAllUserRtt) {
      if (view.byteLength >= offset + 13) {
        const players = [];
        for (let i = 0; i < 6; i++) {
          const val = view.getUint16(offset, false);
          players.push(val === 0xFFFF ? null : val);
          offset += 2;
        }
        const spectatorCount = view.getUint8(offset);
        offset += 1;

        const spectators = [];
        for (let i = 0; i < spectatorCount; i++) {
          if (view.byteLength < offset + 3) break;
          const id = view.getUint8(offset);
          const rtt = view.getUint16(offset + 1, false);
          spectators.push({ id, rtt });
          offset += 3;
        }

        result.allUserRtt = {
          players,
          spectators
        };
      }
    }

    return result;
  }
}
