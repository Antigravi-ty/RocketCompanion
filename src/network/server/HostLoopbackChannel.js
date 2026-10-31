import { ArenaHeaderView } from '../../physics/RocketSimStateViews.js';
import { NetworkSimulator } from '../transport/webrtc/NetworkSimulator.js';
import { InputPacketCodec } from '../protocol/InputPacketCodec.js';

export function createHostSimProxy(hostWorker) {
  const sim = {
    isUnlimitedBoost: false,
    get numCars() {
      if (!hostWorker.isWorker && hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.numCars;
      }
      const hdr = sim.getHeaderView();
      return hdr?.numCars ?? (hostWorker.options.isBotMatch || hostWorker.options.numCars >= 2 ? 2 : 1);
    },
    _carUnlimitedBoost: {},
    _carBoostCollectable: {},
    _carBoostRecharge: {},
    setUnlimitedBoost: (enabled) => {
      const flag = Boolean(enabled);
      sim.isUnlimitedBoost = flag;
      for (let i = 0; i < 8; i++) sim._carUnlimitedBoost[i] = flag;
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('setUnlimitedBoost', { enabled: flag });
      } else if (hostWorker.fallbackSim) {
        hostWorker.fallbackSim.setUnlimitedBoost(flag);
      }
    },
    getUnlimitedBoost: () => {
      if (!hostWorker.isWorker && hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.getUnlimitedBoost();
      }
      return Boolean(sim.isUnlimitedBoost);
    },
    setCarUnlimitedBoost: (carIndex, enabled) => {
      const idx = Number(carIndex) || 0;
      const flag = Boolean(enabled);
      sim._carUnlimitedBoost[idx] = flag;
      if (idx === 0) sim.isUnlimitedBoost = flag;
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('setCarUnlimitedBoost', { carIndex: idx, enabled: flag });
      } else if (hostWorker.fallbackSim) {
        hostWorker.fallbackSim.setCarUnlimitedBoost?.(idx, flag);
      }
    },
    getCarUnlimitedBoost: (carIndex = 0) => {
      const idx = Number(carIndex) || 0;
      if (!hostWorker.isWorker && hostWorker.fallbackSim?.getCarUnlimitedBoost) {
        return hostWorker.fallbackSim.getCarUnlimitedBoost(idx);
      }
      if (idx in sim._carUnlimitedBoost) return Boolean(sim._carUnlimitedBoost[idx]);
      return Boolean(sim.isUnlimitedBoost);
    },
    setCarBoostCollectable: (carIndex, collectable) => {
      const idx = Number(carIndex) || 0;
      const flag = Boolean(collectable);
      sim._carBoostCollectable[idx] = flag;
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('setCarBoostCollectable', { carIndex: idx, collectable: flag });
      } else if (hostWorker.fallbackSim) {
        hostWorker.fallbackSim.setCarBoostCollectable?.(idx, flag);
      }
    },
    getCarBoostCollectable: (carIndex = 0) => {
      const idx = Number(carIndex) || 0;
      if (!hostWorker.isWorker && hostWorker.fallbackSim?.getCarBoostCollectable) {
        return hostWorker.fallbackSim.getCarBoostCollectable(idx);
      }
      if (idx in sim._carBoostCollectable) return Boolean(sim._carBoostCollectable[idx]);
      return true;
    },
    setCarBoostRecharge: (carIndex, enabled, rechargePerSecond = 10.0, rechargeDelay = 0.25) => {
      const idx = Number(carIndex) || 0;
      const cfg = {
        enabled: Boolean(enabled),
        rechargePerSecond: Number(rechargePerSecond),
        rechargeDelay: Number(rechargeDelay),
      };
      sim._carBoostRecharge[idx] = cfg;
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('setCarBoostRecharge', { carIndex: idx, ...cfg });
      } else if (hostWorker.fallbackSim) {
        hostWorker.fallbackSim.setCarBoostRecharge?.(idx, cfg.enabled, cfg.rechargePerSecond, cfg.rechargeDelay);
      }
    },
    getCarBoostRechargeEnabled: (carIndex = 0) => {
      const idx = Number(carIndex) || 0;
      if (!hostWorker.isWorker && hostWorker.fallbackSim?.getCarBoostRechargeEnabled) {
        return hostWorker.fallbackSim.getCarBoostRechargeEnabled(idx);
      }
      return Boolean(sim._carBoostRecharge[idx]?.enabled);
    },
    getCarBoostRechargePerSecond: (carIndex = 0) => {
      const idx = Number(carIndex) || 0;
      if (!hostWorker.isWorker && hostWorker.fallbackSim?.getCarBoostRechargePerSecond) {
        return hostWorker.fallbackSim.getCarBoostRechargePerSecond(idx);
      }
      return sim._carBoostRecharge[idx]?.rechargePerSecond ?? 10.0;
    },
    getCarBoostRechargeDelay: (carIndex = 0) => {
      const idx = Number(carIndex) || 0;
      if (!hostWorker.isWorker && hostWorker.fallbackSim?.getCarBoostRechargeDelay) {
        return hostWorker.fallbackSim.getCarBoostRechargeDelay(idx);
      }
      return sim._carBoostRecharge[idx]?.rechargeDelay ?? 0.25;
    },
    restoreState: (state) => {
      if (state) {
        const arr = state instanceof Float32Array ? state : new Float32Array(state);
        const copyLen = Math.min(arr.length, hostWorker.cachedSnapshot.length);
        hostWorker.cachedSnapshot.subarray(0, copyLen).set(arr.subarray(0, copyLen));
        const tickVal = arr.length <= 512
          ? Math.floor(arr[0])
          : new Uint32Array(arr.buffer, arr.byteOffset, 1)[0];
        if (tickVal >= 0 && !Number.isNaN(tickVal)) {
          hostWorker.lastServerTick = tickVal;
        }
      }
      if (hostWorker.isWorker && hostWorker.worker) {
        return hostWorker._sendRequest('restoreState', {
          state: state instanceof Float32Array ? Array.from(state) : state
        }).then((res) => {
          if (res.snapshot) {
            const snapArr = res.snapshot instanceof Float32Array ? res.snapshot : new Float32Array(res.snapshot);
            const copyLen = Math.min(snapArr.length, hostWorker.cachedSnapshot.length);
            hostWorker.cachedSnapshot.subarray(0, copyLen).set(snapArr.subarray(0, copyLen));
          }
          if (res.tickCount !== undefined) hostWorker.lastServerTick = res.tickCount;
          return hostWorker.cachedSnapshot;
        });
      } else if (hostWorker.fallbackSim) {
        const res = hostWorker.fallbackSim.restoreState(state);
        hostWorker.lastServerTick = Math.floor(hostWorker.fallbackSim.getHeaderView().tickCount);
        return res;
      }
    },
    saveState: (targetBuf) => {
      if (!hostWorker.isWorker && hostWorker.fallbackSim) {
        return typeof hostWorker.fallbackSim.saveCompactState === 'function'
          ? hostWorker.fallbackSim.saveCompactState(targetBuf)
          : hostWorker.fallbackSim.saveState(targetBuf);
      }
      if (targetBuf) {
        const copyLen = Math.min(targetBuf.length, hostWorker.cachedSnapshot.length);
        targetBuf.subarray(0, copyLen).set(hostWorker.cachedSnapshot.subarray(0, copyLen));
        return targetBuf;
      }
      return new Float32Array(hostWorker.cachedSnapshot);
    },
    saveCompactState: (targetBuf) => sim.saveState(targetBuf),
    getHeaderView: () => {
      if (!hostWorker.isWorker && hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.getHeaderView();
      }
      if (!hostWorker.headerViewInstance) {
        hostWorker.headerViewInstance = new ArenaHeaderView();
      }
      if (hostWorker.cachedSnapshot && hostWorker.cachedSnapshot.length > 0) {
        hostWorker.headerViewInstance.attach(hostWorker.cachedSnapshot);
        return hostWorker.headerViewInstance;
      }
      return { tickCount: hostWorker.lastServerTick, numCars: (hostWorker.options.isBotMatch || hostWorker.options.numCars >= 2) ? 2 : 1 };
    },
    resetKickoff: (seed) => {
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('resetKickoff', { seed });
      } else if (hostWorker.fallbackPhysics) {
        hostWorker.fallbackPhysics.resetKickoff(seed);
      }
    },
    resetGoalLatch: () => {
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('resetGoalLatch', {});
      } else if (hostWorker.fallbackPhysics) {
        hostWorker.fallbackPhysics.resetGoalLatch();
      }
    },
    setCarState: (carIndex, stateObj) => {
      if (hostWorker.isWorker && hostWorker.worker) {
        const serialized = stateObj instanceof Float32Array ? Array.from(stateObj) : stateObj;
        hostWorker._postCommand('setCarState', { carIndex, state: serialized, stateObj: serialized });
        return 1;
      }
      if (hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.setCarState(carIndex, stateObj);
      }
      return 0;
    },
    setCarCollisionMask: (carIndex, interactWithBall = true, interactWithCars = true) => {
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('setCarCollisionMask', {
          carIndex,
          interactWithBall: Boolean(interactWithBall),
          interactWithCars: Boolean(interactWithCars)
        });
        return 1;
      }
      if (hostWorker.fallbackPhysics) {
        hostWorker.fallbackPhysics.setCarCollisionMask(carIndex, interactWithBall, interactWithCars);
        return 1;
      }
      if (hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.setCarCollisionMask(carIndex, interactWithBall, interactWithCars);
      }
      return 0;
    },
    setCarLinearFactorAndGravity: (carIndex, fx = 1, fy = 1, fz = 1, gravityScale = 1) => {
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('setCarLinearFactorAndGravity', { carIndex, fx, fy, fz, gravityScale });
        return 1;
      }
      if (hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.setCarLinearFactorAndGravity(carIndex, fx, fy, fz, gravityScale);
      }
      return 0;
    },
    setArenaMutators: (mutators) => {
      if (hostWorker.isWorker && hostWorker.worker) {
        hostWorker._postCommand('setArenaMutators', { mutators });
        return true;
      } else if (hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.setArenaMutators(mutators);
      }
      return false;
    },
    pollGoal: () => {
      if (!hostWorker.isWorker && hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.pollGoal();
      }
      const g = hostWorker.lastGoal;
      hostWorker.lastGoal = 0;
      return g;
    },
    getStateSnapshotSize: () => {
      if (!hostWorker.isWorker && hostWorker.fallbackSim) {
        return hostWorker.fallbackSim.getStateSnapshotSize();
      }
      return hostWorker.cachedSnapshot.length || 448;
    }
  };
  return sim;
}

export function createDefaultHostChannel(hostWorker, options = {}) {
  const simulator = new NetworkSimulator({
    ...options,
    isLoopback: true
  });

  const ch = {
    isLoopback: true,
    transportMode: 'loopback',
    simulator,
    get stats() { return simulator.stats; },
    set stats(val) { simulator.stats = val; },
    get inboundQueue() { return simulator.inboundQueue; },
    set inboundQueue(val) { simulator.inboundQueue = val; },
    get outboundQueue() { return simulator.outboundQueue; },
    set outboundQueue(val) { simulator.outboundQueue = val; },
    get extraUplinkMs() { return simulator.extraUplinkMs; },
    set extraUplinkMs(v) { simulator.setExtraUplinkLatency(v); },
    get extraDownlinkMs() { return simulator.extraDownlinkMs; },
    set extraDownlinkMs(v) { simulator.setExtraDownlinkLatency(v); },
    get extraRttMs() { return simulator.extraRttMs; },
    get extraLatencyMs() { return simulator.extraLatencyMs; },
    set extraLatencyMs(v) { simulator.setExtraLatency(v); },
    get jitterMs() { return simulator.jitterMs; },
    set jitterMs(v) { simulator.setJitter(v); },
    get packetLossRate() { return simulator.packetLossRate; },
    set packetLossRate(v) { simulator.setPacketLossRate(v); },
    get baseMeasuredRttMs() { return simulator.baseMeasuredRttMs; },
    set baseMeasuredRttMs(v) { simulator.baseMeasuredRttMs = v; },
    get measuredRttMs() { return simulator.measuredRttMs; },
    set measuredRttMs(v) { simulator.measuredRttMs = v; },
    get measuredJitterMs() { return simulator.measuredJitterMs; },
    set measuredJitterMs(v) { simulator.measuredJitterMs = v; },
    get lastPingSentTime() { return simulator.lastPingSentTime; },
    set lastPingSentTime(v) { simulator.lastPingSentTime = v; },
    get pingIntervalMs() { return simulator.pingIntervalMs; },
    set pingIntervalMs(v) { simulator.pingIntervalMs = v; },
    get dropNextPacket() { return simulator.dropNextPacket; },
    set dropNextPacket(v) { simulator.dropNextPacket = v; },
    get packetsToDrop() { return simulator.packetsToDrop; },
    set packetsToDrop(v) { simulator.packetsToDrop = v; },
    get latencyMs() { return simulator.latencyMs; },
    get rttMs() { return simulator.rttMs; },
    set rttMs(val) { simulator.rttMs = val; },
    setExtraUplinkLatency: (uplinkMs) => simulator.setExtraUplinkLatency(uplinkMs),
    setExtraDownlinkLatency: (downlinkMs) => simulator.setExtraDownlinkLatency(downlinkMs),
    setAsymmetricLatency: (uplinkMs, downlinkMs) => simulator.setAsymmetricLatency(uplinkMs, downlinkMs),
    setExtraLatency: (latencyMs) => simulator.setExtraLatency(latencyMs),
    setLatency: (latencyMs) => simulator.setLatency(latencyMs),
    setJitter: (jitterMs) => simulator.setJitter(jitterMs),
    setRtt: (rttMs) => simulator.setRtt(rttMs),
    setPacketLossRate: (rate) => simulator.setPacketLossRate(rate),
    setBurstDrop: (periodMs, durationMs, enabled) => simulator.setBurstDrop(periodMs, durationMs, enabled),
    setBurstDropEnabled: (enabled) => simulator.setBurstDropEnabled(enabled),
    toggleBurstDrop: (forceEnabled) => simulator.toggleBurstDrop(forceEnabled),
    triggerBlackout: (durationMs, nowMs) => simulator.triggerBlackout(durationMs, nowMs),
    clearBlackout: () => simulator.clearBlackout(),
    forceDropNextInput: (count = 5) => simulator.forceDropNextInput(count),
    dropSinglePacket: () => simulator.dropSinglePacket(),
    onPacketReceived: null,
    onMessage: null,
    onColorChange: null,
    send: (packet, nowMs = performance.now()) => {
      return simulator.scheduleSend(
        packet,
        (clonedPacket) => {
          if (hostWorker.isWorker && hostWorker.worker) {
            hostWorker._postCommand('clientInput', { channelId: 'host', packet: clonedPacket, timestamp: nowMs });
            return true;
          }
          if (hostWorker.fallbackDataHandler) {
            if (!hostWorker._loggedFallbackSend) {
              hostWorker._loggedFallbackSend = true;
              console.info('[HostLoopbackChannel] Routing host loopback packets through in-memory fallbackDataHandler.');
            }
            hostWorker.fallbackDataHandler.handleIncomingPacket('host', clonedPacket, nowMs);
            return true;
          }
          return false;
        },
        nowMs
      );
    },
    sendClientInput: (packet, nowMs = performance.now()) => {
      let buf = packet;
      if (!(packet instanceof Uint8Array) && !(packet instanceof ArrayBuffer) && typeof packet !== 'string') {
        if (packet?.history) {
          buf = InputPacketCodec.encode(packet.carIndex ?? 0, packet.targetTick ?? packet.tick, packet.history, nowMs);
        } else if (packet?.controls) {
          buf = InputPacketCodec.encode(packet.carIndex ?? 0, packet.tick, [{ tick: packet.tick, controls: packet.controls }], nowMs);
        }
      }
      const sent = ch.send(buf, nowMs);
      if (nowMs - simulator.lastPingSentTime > simulator.pingIntervalMs) {
        simulator.lastPingSentTime = nowMs;
        simulator.stats.pingsSent++;
        ch.send(JSON.stringify({ type: 'ping', sendTime: nowMs, rtt: Math.round(ch.rttMs) }), nowMs);
      }
      return sent;
    },
    sendServerState: (packet, nowMs = performance.now()) => {
      return ch.send(packet, nowMs);
    },
    receiveClientPackets: (nowMs = performance.now()) => {
      return simulator.drainInboundQueue(nowMs);
    },
    receiveServerPackets: (nowMs = performance.now()) => {
      return simulator.drainInboundQueue(nowMs);
    },
    reset: () => {
      simulator.reset();
    },
    destroy: () => {
      simulator.reset();
    }
  };
  return ch;
}

export function deliverToHostLoopback(hostChannel, packet) {
  if (!hostChannel) return false;
  const now = performance.now();
  const simulator = hostChannel.simulator;

  if (simulator) {
    simulator.stats.packetsReceived++;

    if (typeof packet === 'string') {
      try {
        const msg = JSON.parse(packet);
        if (msg.type === 'color_change') {
          hostChannel.onColorChange?.(msg);
          return true;
        }
        if (msg.type === 'ping') {
          const pongMsg = JSON.stringify({ type: 'pong', sendTime: msg.sendTime });
          deliverToHostLoopback(hostChannel, pongMsg);
          return true;
        }
        if (msg.type === 'pong') {
          simulator.handlePong(msg.sendTime, now);
          return true;
        }
      } catch (err) {
        console.warn("[HostLoopbackChannel] Non-JSON string payload received, forwarding raw:", err?.message || err);
      }
    }

    return simulator.receivePayload(
      packet,
      (delivered) => {
        hostChannel.onPacketReceived?.(delivered);
        hostChannel.onMessage?.(delivered);
      },
      now
    );
  }

  // Fallback for custom mock channels without a NetworkSimulator instance
  if (!hostChannel._loggedMockFallback) {
    hostChannel._loggedMockFallback = true;
    console.warn('[HostLoopbackChannel] hostChannel.simulator is missing; using direct mock channel queue fallback.');
  }
  if (hostChannel.packetLossRate > 0 && Math.random() < hostChannel.packetLossRate) {
    return false;
  }
  const cloned = NetworkSimulator.clonePayload(packet);
  const delay = hostChannel.extraLatencyMs ?? 0;
  const deliverAt = delay > 0 ? now + delay : 0;
  if (hostChannel.inboundQueue) {
    if (deliverAt === 0) {
      hostChannel.inboundQueue.push(cloned);
    } else {
      hostChannel.inboundQueue.push({ payload: cloned, deliverAt });
    }
  }
  if (deliverAt === 0) {
    hostChannel.onPacketReceived?.(cloned);
    hostChannel.onMessage?.(cloned);
  } else {
    setTimeout(() => {
      hostChannel.onPacketReceived?.(cloned);
      hostChannel.onMessage?.(cloned);
    }, delay);
  }
  return true;
}
