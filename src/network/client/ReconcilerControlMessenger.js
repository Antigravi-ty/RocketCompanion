/**
 * src/network/ReconcilerControlMessenger.js
 * Piggybacked signal ACK queuing, reliable client command retransmission,
 * and outbound input packet dispatch for PredictionReconciler.
 */

import { InputPacketCodec } from '../protocol/InputPacketCodec.js';

export function acknowledgeReconcilerSignal(reconciler, signalId, signalType, repeatCount = 8) {
  if (typeof signalId !== 'number' || signalId <= 0) return;
  if (!reconciler.pendingSignalAcks) reconciler.pendingSignalAcks = new Map();
  const existing = reconciler.pendingSignalAcks.get(signalId);
  if (existing) {
    existing.remainingSends = Math.max(existing.remainingSends, repeatCount);
    return;
  }
  reconciler.pendingSignalAcks.set(signalId, {
    signalId: signalId & 0xFFFF,
    signalType: signalType & 0xFF,
    remainingSends: repeatCount
  });
}

export function acknowledgeReconcilerServerSignals(reconciler, signals) {
  if (!Array.isArray(signals)) return;
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (!s) continue;
    if (s.signalType === 0x9F && typeof s.param1 === 'number') {
      reconciler.pendingClientCommands.delete(s.param1);
    }
    if (typeof s.signalId === 'number' && s.signalId > 0 && typeof s.signalType === 'number') {
      acknowledgeReconcilerSignal(reconciler, s.signalId, s.signalType, 6);
    }
  }
}

export function enqueueReconcilerClientCommand(reconciler, commandType, param1 = 0, param2 = 0, maxSends = 60) {
  if (!reconciler.pendingClientCommands) reconciler.pendingClientCommands = new Map();
  reconciler.nextClientCommandId = ((reconciler.nextClientCommandId || 0) % 65535) + 1;
  const commandId = reconciler.nextClientCommandId;
  reconciler.pendingClientCommands.set(commandId, {
    commandId,
    commandType: commandType & 0xFF,
    param1: param1 & 0xFFFF,
    param2: param2 & 0xFFFF,
    remainingSends: maxSends
  });
  return commandId;
}

export function collectPiggybackAcksAndCommands(reconciler) {
  const acks = [];
  if (reconciler.pendingSignalAcks && reconciler.pendingSignalAcks.size > 0) {
    for (const [sigId, item] of reconciler.pendingSignalAcks.entries()) {
      acks.push({ signalId: item.signalId, signalType: item.signalType });
      item.remainingSends--;
      if (item.remainingSends <= 0) {
        reconciler.pendingSignalAcks.delete(sigId);
      }
      if (acks.length >= 32) break;
    }
  }

  const commands = [];
  if (reconciler.pendingClientCommands && reconciler.pendingClientCommands.size > 0) {
    for (const [cmdId, cmd] of reconciler.pendingClientCommands.entries()) {
      commands.push({
        commandId: cmd.commandId,
        commandType: cmd.commandType,
        param1: cmd.param1,
        param2: cmd.param2
      });
      cmd.remainingSends--;
      if (cmd.remainingSends <= 0) {
        reconciler.pendingClientCommands.delete(cmdId);
      }
      if (commands.length >= 16) break;
    }
  }

  return { acks, commands };
}

export function sendReconcilerOutboundInputForTick(reconciler, tick, carIndex = reconciler.localCarIndex, controls = null, nowMs = performance.now()) {
  const isRedundantEnabled = (reconciler.redundantHistoryCount > 1) || Boolean(reconciler.enableRedundantInputs);
  const { acks, commands } = collectPiggybackAcksAndCommands(reconciler);
  let outboundPacket;
  if (isRedundantEnabled) {
    const maxHistoryLimit = Math.max(
      reconciler.redundantHistoryCount,
      reconciler.redundantHistoryTicks || 12,
      Math.ceil((reconciler.channel?.rttMs || 0) / reconciler.tickDtMs) + 6
    );
    const serverRecordedTick = reconciler.lastServerRecordedInputTick;
    const unackedCount =
      typeof serverRecordedTick === 'number' && serverRecordedTick >= 0 && tick > serverRecordedTick
        ? (tick - serverRecordedTick)
        : maxHistoryLimit;
    const historyLimit = Math.max(1, Math.min(maxHistoryLimit, unackedCount));
    const redundantWindow = reconciler.clientInputRingBuffer.getRedundantWindow(
      tick,
      historyLimit,
      carIndex
    );
    outboundPacket = InputPacketCodec.encode(carIndex, tick, redundantWindow, nowMs, acks, commands);
  } else {
    const ctrl = controls || reconciler.getPreviousCommittedControls(tick + 1, carIndex);
    const singleWindow = [{ tick, carIndex, controls: { ...ctrl } }];
    outboundPacket = InputPacketCodec.encode(carIndex, tick, singleWindow, nowMs, acks, commands);
  }

  if (typeof reconciler.channel?.sendClientInput === 'function') {
    reconciler.channel.sendClientInput(outboundPacket, nowMs);
  } else if (typeof reconciler.channel?.send === 'function') {
    reconciler.channel.send(outboundPacket, nowMs);
  }
}

export function flushReconcilerPendingControlPackets(reconciler, nowMs = performance.now()) {
  const hasAcks = reconciler.pendingSignalAcks && reconciler.pendingSignalAcks.size > 0;
  const hasCommands = reconciler.pendingClientCommands && reconciler.pendingClientCommands.size > 0;
  const wantSkipReplayJump = Boolean(reconciler.replayPlaybackMode && reconciler.localSkipReplayReady);
  if (!hasAcks && !hasCommands && !wantSkipReplayJump) return;
  const currentTick = Math.floor(reconciler.sim?.getHeaderView?.()?.tickCount ?? reconciler.lastAckedServerTick ?? 0);
  const { acks, commands } = collectPiggybackAcksAndCommands(reconciler);
  if (acks.length === 0 && commands.length === 0 && !wantSkipReplayJump) return;
  const singleWindow = [
    {
      tick: currentTick,
      carIndex: reconciler.localCarIndex,
      controls: {
        ...reconciler.neutralControls,
        jump: wantSkipReplayJump,
      },
    },
  ];
  const outboundPacket = InputPacketCodec.encode(reconciler.localCarIndex, currentTick, singleWindow, nowMs, acks, commands);
  if (typeof reconciler.channel?.sendClientInput === 'function') {
    reconciler.channel.sendClientInput(outboundPacket, nowMs);
  } else if (typeof reconciler.channel?.send === 'function') {
    reconciler.channel.send(outboundPacket, nowMs);
  }
}
