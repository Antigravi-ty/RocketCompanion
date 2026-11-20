/**
 * scripts/testBulkAssetChannel.ts
 * Wave 1 (W1-09) unit tests for Channel 4 (BulkAssetChannel):
 * 1. Chunked transfer & byte-exact reassembly + COMPLETE_ACK
 * 2. 64-bit FNV-1a fileHash verification & corruption ABORT
 * 3. bufferedAmount backpressure throttling & onBufferedAmountLow resume
 * 4. FreeplayRewinderController slice encode/transfer/apply roundtrip
 * 5. Reserved Ghost Trajectory & Replay File transfers
 * 6. Physical isolation in DataChannelTransport ('game_bulk' vs 'game_net'/'game_ctrl')
 * 7. Abort & maxAssetBytes guard
 */

import assert from 'node:assert/strict';
import {
  BULK_ABORT_REASONS,
  computeBulkFileHash64,
} from '../src/network/protocol/BulkAssetProtocol.ts';
import {
  BulkAssetChannel,
  type BulkRawTransportPort,
} from '../src/network/transport/webrtc/BulkAssetChannel.ts';
import { DataChannelTransport } from '../src/network/transport/webrtc/DataChannelTransport.ts';
import { NetworkSimulator } from '../src/network/transport/webrtc/NetworkSimulator.ts';
import { CrossTabSignaling } from '../src/network/transport/webrtc/CrossTabSignaling.ts';
import { P2PWebRTCChannel } from '../src/network/transport/P2PWebRTCChannel.ts';
import { FreeplayRewinderController } from '../src/replay/FreeplayRewinderController.ts';
import type { RewinderFrameEntry } from '../src/replay/replayDataPayloadPipeline.ts';

function createLinkedPair(options?: {
  chunkBytes?: number;
  highWaterMarkBytes?: number;
  lowWaterMarkBytes?: number;
  maxAssetBytes?: number;
  onFrameAtoB?: (bytes: Uint8Array) => Uint8Array;
  simulateBackpressure?: boolean;
}) {
  const chA = new BulkAssetChannel({
    chunkBytes: options?.chunkBytes ?? 4096,
    highWaterMarkBytes: options?.highWaterMarkBytes ?? 32 * 1024,
    lowWaterMarkBytes: options?.lowWaterMarkBytes ?? 8 * 1024,
    maxAssetBytes: options?.maxAssetBytes,
    ackTimeoutMs: 5000,
    backpressurePollMs: 10,
  });
  const chB = new BulkAssetChannel({
    chunkBytes: options?.chunkBytes ?? 4096,
    highWaterMarkBytes: options?.highWaterMarkBytes ?? 32 * 1024,
    lowWaterMarkBytes: options?.lowWaterMarkBytes ?? 8 * 1024,
    maxAssetBytes: options?.maxAssetBytes,
    ackTimeoutMs: 5000,
    backpressurePollMs: 10,
  });

  let bufferedA = 0;
  let lowCbA: (() => void) | null = null;
  let lowThresholdA = 8 * 1024;

  const portA: BulkRawTransportPort = {
    isOpen: () => true,
    getBufferedAmount: () => bufferedA,
    setBufferedAmountLowThreshold: (bytes) => {
      lowThresholdA = bytes;
    },
    onBufferedAmountLow: (cb) => {
      lowCbA = cb;
    },
    sendBytes: (bytes) => {
      if (options?.simulateBackpressure) {
        bufferedA += bytes.byteLength;
      }
      const delivered = options?.onFrameAtoB ? options.onFrameAtoB(bytes) : bytes;
      queueMicrotask(() => chB.handleIncomingRaw(delivered));
      return true;
    },
  };

  const portB: BulkRawTransportPort = {
    isOpen: () => true,
    getBufferedAmount: () => 0,
    sendBytes: (bytes) => {
      queueMicrotask(() => chA.handleIncomingRaw(bytes));
      return true;
    },
  };

  chA.attachTransportPort(portA);
  chB.attachTransportPort(portB);

  return {
    chA,
    chB,
    drainBufferedA: (newAmount = 0) => {
      bufferedA = newAmount;
      if (bufferedA <= lowThresholdA) {
        lowCbA?.();
      }
    },
    getBufferedA: () => bufferedA,
  };
}

async function testChunkedTransferAndHash(): Promise<void> {
  const { chA, chB } = createLinkedPair({ chunkBytes: 4096 });
  const payload = new Uint8Array(65537);
  for (let i = 0; i < payload.byteLength; i++) {
    payload[i] = (i * 31 + 7) & 0xff;
  }

  let receivedPayload: Uint8Array | null = null;
  let receivedHash = '';
  chB.onAssetReceived = (ev) => {
    receivedPayload = ev.payload;
    receivedHash = ev.fileHashHex;
  };

  const res = await chA.sendAsset({
    assetKind: 'training_pack',
    payload,
    meta: { fileName: 'aerial-pack.json' },
  });

  assert.equal(res.acknowledged, true);
  assert.equal(res.totalBytes, payload.byteLength);
  assert.equal(res.totalChunks, Math.ceil(payload.byteLength / 4096));
  assert.ok(receivedPayload !== null);
  assert.equal(receivedHash, computeBulkFileHash64(payload).hex);
  assert.deepEqual(receivedPayload, payload);

  chA.dispose();
  chB.dispose();
  console.log('[PASS] 1. Chunked transfer & 64-bit fileHash verification');
}

async function testCorruptionRejectedByFileHash(): Promise<void> {
  let chunkFramesSeen = 0;
  const { chA, chB } = createLinkedPair({
    chunkBytes: 1024,
    onFrameAtoB: (bytes) => {
      // Corrupt 1 byte in the second frame (first CHUNK frame after MANIFEST)
      chunkFramesSeen++;
      if (chunkFramesSeen === 2) {
        const corrupted = new Uint8Array(bytes);
        corrupted[corrupted.byteLength - 1] ^= 0xff;
        return corrupted;
      }
      return bytes;
    },
  });

  let receiverGotAsset = false;
  let receiverErrReason: number | null = null;
  chB.onAssetReceived = () => {
    receiverGotAsset = true;
  };
  chB.onTransferError = (err) => {
    receiverErrReason = err.reasonCode;
  };

  const payload = new Uint8Array(3000).fill(0x5a);
  await assert.rejects(() => chA.sendAsset({ assetKind: 'replay_file', payload }), /aborted/i);

  assert.equal(receiverGotAsset, false);
  assert.equal(receiverErrReason, BULK_ABORT_REASONS.HASH_MISMATCH);

  chA.dispose();
  chB.dispose();
  console.log('[PASS] 2. Corrupted chunk rejected via fileHash mismatch ABORT');
}

async function testBackpressureThrottling(): Promise<void> {
  const { chA, chB, drainBufferedA } = createLinkedPair({
    chunkBytes: 2048,
    highWaterMarkBytes: 4096,
    lowWaterMarkBytes: 1024,
    simulateBackpressure: true,
  });

  let sawThrottled = false;
  chA.onProgress = (p) => {
    if (p.throttled) {
      sawThrottled = true;
      setTimeout(() => drainBufferedA(0), 15);
    }
  };

  let receivedSize = 0;
  chB.onAssetReceived = (ev) => {
    receivedSize = ev.totalBytes;
  };

  const payload = new Uint8Array(12 * 1024).fill(0x33);
  const res = await chA.sendAsset({ assetKind: 'replay_file', payload });
  assert.equal(sawThrottled, true);
  assert.equal(res.acknowledged, true);
  assert.equal(receivedSize, payload.byteLength);

  chA.dispose();
  chB.dispose();
  console.log('[PASS] 3. bufferedAmount backpressure throttling & low-watermark resume');
}

async function testFreeplayRewinderSliceRoundtrip(): Promise<void> {
  const { chA, chB } = createLinkedPair({ chunkBytes: 1024 });

  const senderRewinder = new FreeplayRewinderController(null, null);
  const receiverRewinder = new FreeplayRewinderController(null, null);

  const syntheticFrames: RewinderFrameEntry[] = [];
  for (let i = 0; i < 6; i++) {
    const compactSnap = new Float32Array(16);
    compactSnap[0] = i * 10.5;
    compactSnap[1] = i * 2.25;
    const renderState = new Float32Array(16);
    renderState[0] = i * 10.5;
    syntheticFrames.push({
      compactSnap,
      renderState,
      controls: { throttle: i % 2 === 0 ? 1 : -0.5, boost: i === 3 },
      acknowledgedControls: [{ carIndex: 0, controls: { throttle: 1 } }],
      incidents: i === 2 ? [{ type: 1, tick: 120 + i }] : [],
      signals: [],
      audioEvents: [],
      hadTouch: i === 2,
      lastTouchTick: i >= 2 ? 122 : -1,
    });
  }
  senderRewinder.rewinderFrames = syntheticFrames;
  senderRewinder.rewinderCursor = 3;

  let applied = false;
  chB.onAssetReceived = (ev) => {
    assert.equal(ev.assetKind, 'rewinder_slice');
    applied = receiverRewinder.applyIncomingRewinderSliceBytes(ev.payload);
  };

  await senderRewinder.sendRewinderSliceToBulkChannel(chA, {
    startFrame: 1,
    endFrame: 5,
    interveneFromHere: true,
    meta: { roomId: 'room-rewinder-test', tickRate: 120 },
  });

  assert.equal(applied, true);
  assert.equal(receiverRewinder.rewinderFrames.length, 4);
  assert.equal(receiverRewinder.rewinderCursor, 3);
  assert.equal(receiverRewinder.rewinderFrames[1].hadTouch, true);
  assert.equal(receiverRewinder.rewinderFrames[1].lastTouchTick, 122);
  assert.equal(receiverRewinder.rewinderFrames[1].incidents.length, 1);
  assert.ok(Math.abs(receiverRewinder.rewinderFrames[2].compactSnap[0] - 31.5) < 1e-4);

  chA.dispose();
  chB.dispose();
  console.log('[PASS] 4. FreeplayRewinderController slice encode/Channel-4/apply roundtrip');
}

async function testReservedGhostAndReplayDescriptors(): Promise<void> {
  const { chA, chB } = createLinkedPair({ chunkBytes: 2048 });
  const receivedKinds: string[] = [];
  const receivedFiles: string[] = [];

  chB.onAssetReceived = (ev) => {
    receivedKinds.push(ev.assetKind);
    receivedFiles.push(ev.meta.fileName ?? '');
  };

  await chA.sendGhostTrajectory({
    carIndex: 1,
    playerName: 'CoachBot',
    tickRate: 120,
    frameCount: 240,
    trajectoryBytes: new Uint8Array(5000).fill(0x11),
  });

  await chA.sendReplayFile({
    fileName: 'match-3v3.rcreplay.gz',
    tickRate: 120,
    frameCount: 3600,
    durationSec: 30,
    compressedBytes: new Uint8Array(9000).fill(0x22),
  });

  assert.deepEqual(receivedKinds, ['ghost_trajectory', 'replay_file']);
  assert.deepEqual(receivedFiles, ['CoachBot-ghost.rcghost', 'match-3v3.rcreplay.gz']);

  chA.dispose();
  chB.dispose();
  console.log('[PASS] 5. Reserved Ghost Trajectory & Replay File Channel-4 transfers');
}

async function testDataChannelTransportIsolation(): Promise<void> {
  const simulator = new NetworkSimulator();
  const signaling = new CrossTabSignaling();
  const transport = new DataChannelTransport({ simulator, signaling });

  const fakeBulkDc = {
    label: 'game_bulk',
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    binaryType: 'arraybuffer',
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    onbufferedamountlow: null,
    send: () => undefined,
  } as unknown as RTCDataChannel;

  transport.bindDataChannel(fakeBulkDc);
  assert.equal(transport.dataChannel, null);
  assert.equal(transport.controlDataChannel, null);
  assert.equal(transport.bulkChannel.isOpen, true);

  const p2p = new P2PWebRTCChannel();
  assert.ok(p2p.bulkAssetChannel instanceof BulkAssetChannel);

  transport.bulkChannel.dispose();
  console.log(
    '[PASS] 6. DataChannelTransport physically isolates game_bulk from game_net/game_ctrl'
  );
}

async function testAbortAndSizeLimit(): Promise<void> {
  const { chA, chB } = createLinkedPair({ maxAssetBytes: 1024 });
  await assert.rejects(
    () =>
      chA.sendAsset({
        assetKind: 'replay_file',
        payload: new Uint8Array(2048),
      }),
    /exceeds maxAssetBytes/i
  );

  const p = chA.sendAsset({
    assetKind: 'training_pack',
    payload: new Uint8Array(512),
  });
  chA.abortTransfer(1, BULK_ABORT_REASONS.CANCELLED);
  await assert.rejects(() => p, /aborted/i);

  chA.dispose();
  chB.dispose();
  console.log('[PASS] 7. Size limit guard & transfer abort');
}

async function main(): Promise<void> {
  await testChunkedTransferAndHash();
  await testCorruptionRejectedByFileHash();
  await testBackpressureThrottling();
  await testFreeplayRewinderSliceRoundtrip();
  await testReservedGhostAndReplayDescriptors();
  await testDataChannelTransportIsolation();
  await testAbortAndSizeLimit();
  console.log('\nAll W1-09 BulkAssetChannel tests PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
