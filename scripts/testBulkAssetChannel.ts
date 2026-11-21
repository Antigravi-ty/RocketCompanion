#!/usr/bin/env node
/**
 * scripts/testBulkAssetChannel.ts
 * Unit & integration tests for Channel 4 (Bulk / Asset):
 * 1. BulkAssetProtocol binary chunk & control frame roundtrip + FNV-1a fileHash
 * 2. Multi-chunk transfer, reassembly, fileHash verification, and COMPLETE_ACK
 * 3. bufferedAmount backpressure throttling & low-watermark resume
 * 4. fileHash corruption detection & HASH_MISMATCH_NACK rejection
 * 5. FreeplayRewinderController history slice export -> Channel 4 transfer -> import & state restore
 * 6. Reserved Ghost trajectory & Replay file transfers
 * 7. DataChannelTransport 'game_bulk' physical isolation from 'game_net' and 'game_ctrl'
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  BULK_FRAME_TYPES,
  computeBulkFileHash,
  decodeBulkAssetFrame,
  encodeBulkChunkFrame,
  encodeBulkControlFrame,
  formatBulkFileHashHex,
  isBulkAssetFrame,
} from '../src/network/protocol/BulkAssetProtocol.ts';
import {
  BulkAssetChannel,
  type BulkAssetTransportSink,
  type BulkTransferError,
  type BulkTransferProgress,
  type ReceivedBulkAsset,
} from '../src/network/transport/BulkAssetChannel.ts';
import { DataChannelTransport } from '../src/network/transport/webrtc/DataChannelTransport.ts';
import { NetworkSimulator } from '../src/network/transport/webrtc/NetworkSimulator.ts';
import { CrossTabSignaling } from '../src/network/transport/webrtc/CrossTabSignaling.ts';
import {
  decodeRewinderSlice,
  encodeRewinderSlice,
} from '../src/replay/rewinderBulkSliceCodec.ts';
import type { RewinderFrameEntry } from '../src/replay/replayDataPayloadPipeline.ts';

function makeDeterministicPayload(byteLength: number, seed = 17): Uint8Array {
  const buf = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    buf[i] = (i * 31 + seed) & 0xff;
  }
  return buf;
}

function makeMockRewinderFrames(count: number): RewinderFrameEntry[] {
  const frames: RewinderFrameEntry[] = [];
  for (let i = 0; i < count; i++) {
    const compactSnap = new Float32Array(24);
    compactSnap[0] = i + 1;
    compactSnap[1] = 100 + i * 2.5;
    compactSnap[2] = -200 + i * 1.5;
    const renderState = new Float32Array(32);
    renderState[0] = i + 1;
    renderState[1] = 0.5 * i;
    frames.push({
      compactSnap,
      renderState,
      controls: {
        throttle: 1,
        steer: i % 2 === 0 ? 0.25 : -0.25,
        boost: i % 3 === 0,
        jump: false,
      },
      acknowledgedControls: [{ carIndex: 0, throttle: 1, steer: 0 }],
      incidents: i === 5 ? [{ type: 1, tick: i + 1 }] : [],
      hadTouch: i === 5,
      lastTouchTick: i >= 5 ? 6 : -1,
    });
  }
  return frames;
}

export async function runBulkAssetChannelTests(): Promise<void> {
  // 1. Protocol codec roundtrip & fileHash
  {
    const sample = makeDeterministicPayload(128, 7);
    const hash = computeBulkFileHash(sample);
    assert.ok(formatBulkFileHashHex(hash).startsWith('0x'));
    assert.equal(formatBulkFileHashHex(hash).length, 10);

    const metaBytes = new TextEncoder().encode(JSON.stringify({ fileName: 'test.rcreplay' }));
    const frame = encodeBulkChunkFrame({
      transferId: 42,
      assetKind: 'replay_file',
      chunkIndex: 0,
      totalChunks: 3,
      totalBytes: 384,
      fileHash: hash,
      metadataBytes: metaBytes,
      payload: sample,
    });
    assert.equal(isBulkAssetFrame(frame), true);
    const decoded = decodeBulkAssetFrame(frame);
    assert.ok(decoded && decoded.frameType === BULK_FRAME_TYPES.CHUNK);
    assert.equal(decoded.transferId, 42);
    assert.equal(decoded.assetKind, 'replay_file');
    assert.equal(decoded.chunkIndex, 0);
    assert.equal(decoded.totalChunks, 3);
    assert.equal(decoded.totalBytes, 384);
    assert.equal(decoded.fileHash, hash);
    assert.deepEqual(decoded.metadataBytes, metaBytes);
    assert.deepEqual(decoded.payload, sample);

    const ackFrame = encodeBulkControlFrame(BULK_FRAME_TYPES.COMPLETE_ACK, 42, hash, 0);
    const decodedAck = decodeBulkAssetFrame(ackFrame);
    assert.ok(decodedAck && decodedAck.frameType === BULK_FRAME_TYPES.COMPLETE_ACK);
    assert.equal(decodedAck.transferId, 42);
    assert.equal(decodedAck.fileHash, hash);
  }

  // 2. Multi-chunk transfer + reassembly + fileHash verification + COMPLETE_ACK
  {
    const sender = new BulkAssetChannel({
      chunkSizeBytes: 1024,
      maxChunksPerPump: 64,
    });
    const receiver = new BulkAssetChannel({
      chunkSizeBytes: 1024,
      maxChunksPerPump: 64,
    });

    const senderToReceiverSink: BulkAssetTransportSink = {
      sendFrame: (frame) => receiver.handleIncomingFrame(frame),
      getBufferedAmount: () => 0,
      isReady: () => true,
    };
    const receiverToSenderSink: BulkAssetTransportSink = {
      sendFrame: (frame) => sender.handleIncomingFrame(frame),
      getBufferedAmount: () => 0,
      isReady: () => true,
    };

    sender.setTransportSink(senderToReceiverSink);
    receiver.setTransportSink(receiverToSenderSink);

    const receivedAssets: ReceivedBulkAsset[] = [];
    const ackedTransfers: number[] = [];
    const sendProgress: BulkTransferProgress[] = [];
    receiver.onAssetReceived = (asset) => receivedAssets.push(asset);
    sender.onTransferAcked = (ev) => ackedTransfers.push(ev.transferId);
    sender.onProgress = (p) => sendProgress.push(p);

    const payload = makeDeterministicPayload(10 * 1024 + 333, 99);
    const txId = sender.sendReplayFile(payload, {
      fileName: 'match_3v3.rcreplay',
      format: 'rcreplay',
      totalFrames: 600,
      durationSeconds: 10,
      arenaPreset: 0,
    });

    assert.equal(receivedAssets.length, 1);
    assert.equal(receivedAssets[0].transferId, txId);
    assert.equal(receivedAssets[0].kind, 'replay_file');
    assert.deepEqual(receivedAssets[0].payload, payload);
    assert.equal(receivedAssets[0].fileHash, computeBulkFileHash(payload));
    assert.equal((receivedAssets[0].metadata as { fileName: string }).fileName, 'match_3v3.rcreplay');
    assert.deepEqual(ackedTransfers, [txId]);
    assert.equal(sendProgress.length, 11);
    assert.equal(sender.stats.chunksSent, 11);
    assert.equal(receiver.stats.chunksReceived, 11);

    sender.dispose();
    receiver.dispose();
  }

  // 3. bufferedAmount backpressure throttling & low-watermark resume
  {
    let simulatedBuffered = 0;
    const forwardedFrames: Uint8Array[] = [];
    const sender = new BulkAssetChannel({
      chunkSizeBytes: 1024,
      highWaterMarkBytes: 4096,
      lowWaterMarkBytes: 1024,
      maxChunksPerPump: 16,
    });
    const receiver = new BulkAssetChannel({ chunkSizeBytes: 1024 });

    sender.setTransportSink({
      sendFrame: (frame) => {
        forwardedFrames.push(frame);
        simulatedBuffered += frame.byteLength;
        return true;
      },
      getBufferedAmount: () => simulatedBuffered,
      isReady: () => true,
    });
    receiver.setTransportSink({
      sendFrame: (frame) => sender.handleIncomingFrame(frame),
      getBufferedAmount: () => 0,
      isReady: () => true,
    });

    const receivedAssets: ReceivedBulkAsset[] = [];
    receiver.onAssetReceived = (asset) => receivedAssets.push(asset);

    const largePayload = makeDeterministicPayload(12 * 1024, 55);
    sender.sendGhostTrajectory(largePayload, {
      carIndex: 2,
      playerName: 'GhostDucky',
      team: 1,
      startTick: 100,
      endTick: 400,
      tickCount: 300,
      roleFlag: 'ghost',
    });

    assert.ok(sender.stats.backpressurePauses >= 1, 'Expected at least 1 backpressure pause');
    assert.ok(sender.getPendingOutgoingCount() === 1, 'Transfer should remain queued while backpressured');
    assert.equal(sender.isBackpressured(), true);

    while (sender.getPendingOutgoingCount() > 0) {
      simulatedBuffered = 0;
      sender.notifyBufferedAmountLow();
    }

    for (const f of forwardedFrames) {
      receiver.handleIncomingFrame(f);
    }

    assert.equal(receivedAssets.length, 1);
    assert.equal(receivedAssets[0].kind, 'ghost_trajectory');
    assert.deepEqual(receivedAssets[0].payload, largePayload);

    sender.dispose();
    receiver.dispose();
  }

  // 4. fileHash corruption detection & HASH_MISMATCH_NACK
  {
    const sender = new BulkAssetChannel({ chunkSizeBytes: 512, maxChunksPerPump: 16 });
    const receiver = new BulkAssetChannel({ chunkSizeBytes: 512 });

    const senderErrors: BulkTransferError[] = [];
    const receiverErrors: BulkTransferError[] = [];
    const receivedAssets: ReceivedBulkAsset[] = [];

    sender.onTransferError = (err) => senderErrors.push(err);
    receiver.onTransferError = (err) => receiverErrors.push(err);
    receiver.onAssetReceived = (asset) => receivedAssets.push(asset);

    let chunkCounter = 0;
    sender.setTransportSink({
      sendFrame: (frame) => {
        const copy = new Uint8Array(frame);
        if (chunkCounter === 1) {
          copy[copy.byteLength - 1] ^= 0xff;
        }
        chunkCounter++;
        return receiver.handleIncomingFrame(copy);
      },
      getBufferedAmount: () => 0,
      isReady: () => true,
    });
    receiver.setTransportSink({
      sendFrame: (frame) => sender.handleIncomingFrame(frame),
      getBufferedAmount: () => 0,
      isReady: () => true,
    });

    const payload = makeDeterministicPayload(2048, 13);
    sender.sendTrainingPack(payload, {
      packId: 'pack-1',
      packName: 'Aerials',
      shotCount: 10,
      schemaVersion: 1,
    });

    assert.equal(receivedAssets.length, 0, 'Corrupted asset must NOT be delivered');
    assert.equal(receiverErrors.length, 1);
    assert.equal(receiverErrors[0].reason, 'hash_mismatch');
    assert.equal(senderErrors.length, 1);
    assert.equal(senderErrors[0].reason, 'hash_mismatch');
    assert.equal(receiver.stats.hashMismatches, 1);

    sender.dispose();
    receiver.dispose();
  }

  // 5. FreeplayRewinder slice export -> Channel 4 transfer -> decode & verify
  {
    const hostFrames = makeMockRewinderFrames(12);
    const encoded = encodeRewinderSlice(hostFrames, {
      startFrame: 2,
      endFrame: 10,
      cursorFrame: 7,
      targetFrame: 7,
      arenaPreset: 0,
    });

    const hostBulk = new BulkAssetChannel({ chunkSizeBytes: 512, maxChunksPerPump: 64 });
    const clientBulk = new BulkAssetChannel({ chunkSizeBytes: 512 });

    hostBulk.setTransportSink({
      sendFrame: (frame) => clientBulk.handleIncomingFrame(frame),
      getBufferedAmount: () => 0,
      isReady: () => true,
    });
    clientBulk.setTransportSink({
      sendFrame: (frame) => hostBulk.handleIncomingFrame(frame),
      getBufferedAmount: () => 0,
      isReady: () => true,
    });

    let decodedSlice: ReturnType<typeof decodeRewinderSlice> = null;
    clientBulk.onAssetReceived = (asset) => {
      if (asset.kind === 'rewinder_slice') {
        decodedSlice = decodeRewinderSlice(asset.payload);
      }
    };

    const txId = hostBulk.sendRewinderSlice(encoded.payload, encoded.metadata);
    assert.ok(txId > 0);
    assert.ok(decodedSlice !== null);
    assert.equal(decodedSlice.frames.length, 8);
    assert.equal(decodedSlice.cursorFrame, 5);
    assert.equal(decodedSlice.frames[3].hadTouch, true);
    assert.equal(decodedSlice.frames[3].incidents[0].type, 1);
    assert.deepEqual(
      Array.from(decodedSlice.frames[0].compactSnap),
      Array.from(hostFrames[2].compactSnap)
    );

    hostBulk.dispose();
    clientBulk.dispose();
  }

  // 6. DataChannelTransport 'game_bulk' physical isolation
  {
    const signaling = new CrossTabSignaling({ roomId: 'bulk-isolation-test' });
    const transport = new DataChannelTransport({
      simulator: new NetworkSimulator({}),
      signaling,
    });

    let deliveredNonBulkPackets = 0;
    transport.onPacketDelivered = () => {
      deliveredNonBulkPackets++;
    };

    const receivedBulk: ReceivedBulkAsset[] = [];
    transport.bulkChannel.onAssetReceived = (asset) => receivedBulk.push(asset);

    const mockBulkDc = {
      label: 'game_bulk',
      readyState: 'open',
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      binaryType: 'arraybuffer',
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as ((ev: unknown) => void) | null,
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      onbufferedamountlow: null as (() => void) | null,
      send: (data: Uint8Array) => {
        mockBulkDc.onmessage?.({ data });
      },
    } as unknown as RTCDataChannel;

    transport.bindDataChannel(mockBulkDc);
    (mockBulkDc.onopen as (() => void) | null)?.();

    assert.equal(transport.isBulkChannelOpen, true);
    assert.equal(transport.dataChannel, null, 'game_bulk must NOT overwrite game_net dataChannel');
    assert.equal(transport.controlDataChannel, null, 'game_bulk must NOT overwrite game_ctrl');

    const payload = makeDeterministicPayload(4096, 33);
    transport.bulkChannel.sendReplayFile(payload, {
      fileName: 'isolated.rlrc',
      format: 'rlrc',
      totalFrames: 120,
      durationSeconds: 2,
    });

    assert.equal(receivedBulk.length, 1);
    assert.deepEqual(receivedBulk[0].payload, payload);
    assert.equal(deliveredNonBulkPackets, 0, 'Channel 4 traffic must not leak into Channel 1');

    transport.bulkChannel.dispose();
    signaling.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runBulkAssetChannelTests()
    .then(() => {
      console.log('=== BULK ASSET CHANNEL TESTS PASSED ===');
    })
    .catch((err) => {
      console.error('[FAIL]', err);
      process.exit(1);
    });
}
