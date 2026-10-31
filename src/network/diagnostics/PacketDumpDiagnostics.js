import { EstablishedSessionManager } from '../server/EstablishedSessionManager.js';
import {
  GlobalPayloadCodec,
  MATCH_SIGNALS,
  createBoostPadEdgeTracker,
  seedBoostPadEdgeTrackerFromSnapshot,
  applyBoostPadEdgeCooldowns
} from '../protocol/GlobalPayloadCodec.js';
import { GameStateView } from '../../physics/RocketSimStateViews.js';

export function drainAndParseServerPackets(reconciler, incomingPackets, nowMs) {
  let latestPacket = null;
  if (Array.isArray(reconciler.drainedReplayPackets)) {
    reconciler.drainedReplayPackets.length = 0;
  }
  if (!reconciler.boostPadEdgeTracker) {
    reconciler.boostPadEdgeTracker = createBoostPadEdgeTracker();
  }

  for (const rawItem of incomingPackets) {
    let packet = null;

    if (rawItem instanceof Uint8Array || rawItem instanceof ArrayBuffer) {
      reconciler.lastReceivedPacketRaw = rawItem;
      const clientHeader = EstablishedSessionManager.parseClientPacket(rawItem);
      if (clientHeader) {
        if (reconciler.lobbyDualWorldMode && clientHeader.inputBufferSize === 0 && !reconciler._hasServerReportedBuffer) {
          reconciler.metrics.inputBufferSize = reconciler.inputBufferTarget ?? 3;
        } else {
          reconciler.metrics.inputBufferSize = clientHeader.inputBufferSize;
          reconciler._hasServerReportedBuffer = true;
        }

        const extraUplink = Math.max(0, Number(reconciler.channel?.extraUplinkMs ?? reconciler.channel?.extraLatencyMs ?? 0) || 0);
        const extraDownlink = Math.max(0, Number(reconciler.channel?.extraDownlinkMs ?? reconciler.channel?.extraLatencyMs ?? 0) || 0);
        const extraRtt = extraUplink + extraDownlink;

        const isLastQueuedItem = rawItem === incomingPackets[incomingPackets.length - 1];
        if (reconciler.channel?.isLoopback) {
          reconciler.measuredRtt = Math.round(extraRtt);
          if (clientHeader.clientTimestamp > 0 && clientHeader.clientTimestamp > (reconciler._lastProcessedClientTimestamp || 0)) {
            reconciler._lastProcessedClientTimestamp = clientHeader.clientTimestamp;
          }
        } else {
          if (
            isLastQueuedItem &&
            clientHeader.clientTimestamp > 0 &&
            clientHeader.clientTimestamp > (reconciler._lastProcessedClientTimestamp || 0)
          ) {
            reconciler._lastProcessedClientTimestamp = clientHeader.clientTimestamp;
            const sampleRtt = Math.max(0, nowMs - clientHeader.clientTimestamp);
            const isQueueBurst = incomingPackets.length > 3;
            if (sampleRtt < 2000 && Number.isFinite(sampleRtt) && !isQueueBurst) {
              const baseSampleRtt = Math.max(0, sampleRtt - extraRtt);
              if (!Number.isFinite(reconciler._baseMeasuredRtt) || reconciler._baseMeasuredRtt === 0) {
                reconciler._baseMeasuredRtt = baseSampleRtt;
              } else {
                const maxStepUp = Math.max(50, reconciler._baseMeasuredRtt * 2);
                const clampedSample = Math.min(baseSampleRtt, reconciler._baseMeasuredRtt + maxStepUp);
                reconciler._baseMeasuredRtt = reconciler._baseMeasuredRtt * 0.85 + clampedSample * 0.15;
              }
            }
          }
          reconciler.measuredRtt = (reconciler._baseMeasuredRtt || 0) + extraRtt;
          if (reconciler.channel && Number.isFinite(reconciler.measuredRtt)) {
            if (typeof reconciler.channel.rttMs !== 'undefined') {
              reconciler.channel.measuredRttMs = reconciler.measuredRtt;
            }
          }
        }

        const globalPayload = GlobalPayloadCodec.decode(clientHeader.globalPayloadSlice);
        if (globalPayload) {
          const allSignals = (globalPayload.signals && globalPayload.signals.length > 0)
            ? globalPayload.signals
            : (clientHeader.sessionSignals || []);
          if (allSignals.length > 0) {
            if (typeof reconciler.acknowledgeServerSignals === 'function') {
              reconciler.acknowledgeServerSignals(allSignals);
            }
            let hasTransitionSignal = false;
            for (const sig of allSignals) {
              if (!sig) continue;
              if (sig.signalType === MATCH_SIGNALS.COMMAND_ACK) {
                reconciler.resolveClientCommandAck?.(sig.param1);
              }
              if (
                sig.signalType === MATCH_SIGNALS.MATCH_PREPARE ||
                sig.signalType === MATCH_SIGNALS.MATCH_STARTED ||
                sig.signalType === MATCH_SIGNALS.KICKOFF_WILL_START ||
                sig.signalType === MATCH_SIGNALS.MATCH_RETURNED_TO_LOBBY
              ) {
                hasTransitionSignal = true;
              }
            }
            const prevLobbyMode = Boolean(reconciler.lobbyDualWorldMode);
            const pktServerTick =
              globalPayload.hasPhysics && globalPayload.physics && typeof globalPayload.physics.tick === 'number'
                ? globalPayload.physics.tick
                : null;
            reconciler.onSignals?.(allSignals, pktServerTick);
            if (
              hasTransitionSignal ||
              Boolean(reconciler.lobbyDualWorldMode) !== prevLobbyMode ||
              !reconciler.isTimelineSynchronized
            ) {
              latestPacket = null;
            }
          }
          if (globalPayload.allUserRtt) {
            reconciler.metrics.allUserRtt = globalPayload.allUserRtt;
          }
          if (globalPayload.hasPhysics && globalPayload.physics) {
            const physMask = globalPayload.physics.activeCarMask;
            const isStaleLobbyPhysicsInMatch =
              !reconciler.lobbyDualWorldMode &&
              typeof physMask === 'number' &&
              (physMask & 0xC0) !== 0;
            if (!isStaleLobbyPhysicsInMatch) {
              const srvTick = globalPayload.physics.tick;
              if (globalPayload.physics.stateSnapshot) {
                applyBoostPadEdgeCooldowns(
                  globalPayload.physics.stateSnapshot,
                  srvTick,
                  reconciler.boostPadEdgeTracker
                );
              }
              if (reconciler._hasServerReportedBuffer && srvTick > 0) {
                const bufDepth = clientHeader.inputBufferSize | 0;
                const recordedUpTo = bufDepth > 0 ? (srvTick + bufDepth - 1) : (srvTick - 1);
                if (
                  typeof reconciler.lastServerRecordedInputTick !== 'number' ||
                  recordedUpTo > reconciler.lastServerRecordedInputTick
                ) {
                  reconciler.lastServerRecordedInputTick = recordedUpTo;
                }
              }
              packet = {
                serverTick: srvTick,
                activeCarMask: globalPayload.physics.activeCarMask,
                activeCarIndices: globalPayload.physics.activeCarIndices,
                boostPadMaskLow: globalPayload.physics.boostPadMaskLow,
                boostPadMaskHigh: globalPayload.physics.boostPadMaskHigh,
                stateSnapshot: globalPayload.physics.stateSnapshot,
                acknowledgedControls: globalPayload.physics.acknowledgedControls,
                timestamp: clientHeader.serverTimestamp,
                clientHeader,
                globalPayload,
                rawBytes: rawItem
              };
            }
          }
        }
      }
    } else if (rawItem) {
      let parsedItem = rawItem;
      if (typeof rawItem === 'string') {
        try {
          parsedItem = JSON.parse(rawItem);
        } catch (err) {
          console.warn('[PredictionReconciler] Failed to parse datagram string as JSON:', err, rawItem);
        }
      }
      if (parsedItem && typeof parsedItem === 'object') {
        if (parsedItem.serverTick !== undefined) {
          packet = parsedItem;
        } else if (parsedItem.type === 'roster_update') {
          reconciler.onRosterUpdate?.(parsedItem);
          continue;
        } else if (parsedItem.type === 'handshake_response') {
          if (typeof parsedItem.entityId === 'number' && parsedItem.entityId >= 0) {
            reconciler.localCarIndex = parsedItem.entityId;
          }
          if (parsedItem.state === 'lobby') {
            reconciler.setLobbyDualWorldMode?.(true);
            if (parsedItem.initialSnapshot) {
              const snap = new Float32Array(parsedItem.initialSnapshot);
              seedBoostPadEdgeTrackerFromSnapshot(reconciler.boostPadEdgeTracker, snap, parsedItem.serverFrame ?? parsedItem.matchTick ?? 0);
              reconciler.lobbyPrevAuthoritativeState = new Float32Array(snap);
              reconciler.lobbyCurrAuthoritativeState = new Float32Array(snap);
            }
          } else {
            reconciler.setLobbyDualWorldMode?.(false);
            if (parsedItem.initialSnapshot && (parsedItem.serverFrame !== undefined || parsedItem.matchTick !== undefined)) {
              const frame = parsedItem.serverFrame ?? parsedItem.matchTick ?? 0;
              const snap = new Float32Array(parsedItem.initialSnapshot);
              seedBoostPadEdgeTrackerFromSnapshot(reconciler.boostPadEdgeTracker, snap, frame);
              reconciler.syncTimeline(snap, frame, nowMs);
              if (reconciler.interpolator) {
                reconciler.interpolator.sync(nowMs);
              }
            }
          }
          reconciler.onHandshakeResponse?.(parsedItem);
          continue;
        }
      }
    }

    if (packet) {
      if (reconciler.replayPlaybackMode && packet.stateSnapshot && Array.isArray(reconciler.drainedReplayPackets)) {
        reconciler.drainedReplayPackets.push(packet);
      }
      if (!latestPacket || packet.serverTick >= latestPacket.serverTick) {
        latestPacket = packet;
      }
    }
  }

  return latestPacket;
}

export function dumpNetworkPacket(item) {
  if (!item) {
    console.warn('[NetworkPacket] No network packet available to inspect.');
    return null;
  }

  let parsed = null;
  if (item.clientHeader && item.globalPayload) {
    parsed = item;
  } else if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
    const clientHeader = EstablishedSessionManager.parseClientPacket(item);
    const globalPayload = clientHeader?.globalPayloadSlice ? GlobalPayloadCodec.decode(clientHeader.globalPayloadSlice) : null;
    parsed = { clientHeader, globalPayload, rawBytes: item };
  } else if (typeof item === 'object') {
    parsed = item;
  }

  const output = {
    inspectionTimestamp: performance.now(),
    summary: {},
    clientHeader: null,
    signals: [],
    allUserRtt: null,
    physics: null
  };

  if (parsed.clientHeader) {
    const ch = parsed.clientHeader;
    const roundTripMs = ch.clientTimestamp > 0 ? (performance.now() - ch.clientTimestamp).toFixed(2) + ' ms' : 'N/A';
    output.clientHeader = {
      clientTimestamp: ch.clientTimestamp,
      serverTimestamp: ch.serverTimestamp,
      inputBufferSize: ch.inputBufferSize,
      inferredRoundTrip: roundTripMs
    };
    output.summary.inputBufferSize = ch.inputBufferSize;
    output.summary.inferredRtt = roundTripMs;
  }

  const gp = parsed.globalPayload;
  if (gp) {
    if (gp.signals && gp.signals.length > 0) {
      output.signals = gp.signals;
      output.summary.signalsCount = gp.signals.length;
    }
    if (gp.allUserRtt) {
      output.allUserRtt = gp.allUserRtt;
      output.summary.playersRtt = gp.allUserRtt.players;
    }
    if (gp.hasPhysics && gp.physics) {
      const phy = gp.physics;
      output.summary.serverTick = phy.tick;
      output.physics = {
        tick: phy.tick,
        boostPadMaskLow: phy.boostPadMaskLow,
        boostPadMaskHigh: phy.boostPadMaskHigh,
        acknowledgedControls: phy.acknowledgedControls,
        cars: [],
        ball: null
      };

      if (phy.stateSnapshot && phy.stateSnapshot.length > 0) {
        try {
          const gv = new GameStateView();
          gv.attach(phy.stateSnapshot);
          output.physics.ball = {
            pos: { x: +gv.ball.posX.toFixed(2), y: +gv.ball.posY.toFixed(2), z: +gv.ball.posZ.toFixed(2) },
            vel: { x: +gv.ball.velX.toFixed(2), y: +gv.ball.velY.toFixed(2), z: +gv.ball.velZ.toFixed(2) },
            angVel: { x: +gv.ball.angVelX.toFixed(2), y: +gv.ball.angVelY.toFixed(2), z: +gv.ball.angVelZ.toFixed(2) }
          };
          const activeCars = Math.min(8, Math.max(1, gv.header.numCars || 2));
          for (let i = 0; i < activeCars; i++) {
            const car = gv.getCar(i);
            output.physics.cars.push({
              carIndex: i,
              pos: { x: +car.posX.toFixed(2), y: +car.posY.toFixed(2), z: +car.posZ.toFixed(2) },
              vel: { x: +car.velX.toFixed(2), y: +car.velY.toFixed(2), z: +car.velZ.toFixed(2) },
              fwd: { x: +car.fwdX.toFixed(2), y: +car.fwdY.toFixed(2), z: +car.fwdZ.toFixed(2) },
              boost: +car.boost.toFixed(1),
              onGround: Boolean(car.isOnGround),
              supersonic: Boolean(car.isSupersonic)
            });
          }
        } catch (e) {
          console.warn('[PredictionReconciler] Failed to parse car snapshot in diagnostics:', e);
          output.physics.rawSnapshotLength = phy.stateSnapshot.length;
        }
      }
    }
  }

  try {
    console.group(
      `%c[NETWORK PACKET DUMP]%c ServerTick: ${output.summary.serverTick ?? 'N/A'} | InputBuffer: ${output.summary.inputBufferSize ?? 'N/A'} | InferredRTT: ${output.summary.inferredRtt ?? 'N/A'}`,
      'background:#1f6feb;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold',
      'color:#58a6ff;font-weight:bold'
    );
    console.log('Complete Parsed Datagram:', output);
    if (output.clientHeader) {
      console.log('17-byte Client Header:', output.clientHeader);
    }
    if (output.physics) {
      console.log('Authoritative Physics Tick:', output.physics.tick);
      if (output.physics.acknowledgedControls?.length) {
        console.table(output.physics.acknowledgedControls.map((a) => ({ carIndex: a.carIndex, ...a.controls })));
      }
      if (output.physics.cars?.length) {
        console.table(output.physics.cars);
      }
      if (output.physics.ball) {
        console.log('Authoritative Ball State:', output.physics.ball);
      }
    }
    if (output.signals?.length) {
      console.table(output.signals);
    }
    console.groupEnd();
  } catch (err) {
    console.error('[PredictionReconciler] Failed to print packet diagnostics:', err);
  }

  return output;
}
