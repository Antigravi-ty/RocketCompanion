/**
 * src/network/server/match/matchSessionRoleSwitchPipeline.ts
 * Narrow-interface pipeline for disconnected slot reclamation, session removal,
 * role/team switching, and JSON control packet evaluation.
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import { CLIENT_COMMAND_TYPES } from '../../../physics/RocketSimConstants.ts';
import { PLAYER_ROLE_CODES, packLoadoutSignalParam2 } from '../../../ui-core/config/vehicleConstants';
import {
  MATCH_STATES, resolveDefaultColorSlotForTeam,
  type MatchPlayerSlot, type MatchSpectatorSlot, type DisconnectedPlayerSlot, type PlayerLoadoutOptions,
} from './matchLoadoutAndSpawnPipeline.ts';
import type { RosterPhysicsManagerPort, RosterSessionPort } from './matchRosterPhysicsAndBotPipeline.ts';

function popReclaimedPlayerSlotCandidate(
  disconnectedPlayerSlots: Map<number, DisconnectedPlayerSlot>,
  players: Iterable<MatchPlayerSlot>, requestedEntityId: number
): { reclaimed: DisconnectedPlayerSlot | null; entityId: number } {
  let reclaimed: DisconnectedPlayerSlot | null = null;
  if (disconnectedPlayerSlots.size > 0) {
    if (typeof requestedEntityId === 'number' && requestedEntityId >= 0 && disconnectedPlayerSlots.has(requestedEntityId)) {
      reclaimed = disconnectedPlayerSlots.get(requestedEntityId) || null;
      disconnectedPlayerSlots.delete(requestedEntityId);
    } else {
      const firstEntry = disconnectedPlayerSlots.entries().next().value;
      if (firstEntry) { reclaimed = firstEntry[1]; disconnectedPlayerSlots.delete(firstEntry[0]); }
    }
  }
  if (!reclaimed) return { reclaimed: null, entityId: -1 };
  const usedEntityIds = new Set(Array.from(players).map((p) => p.entityId));
  let entityId = reclaimed.entityId;
  if (usedEntityIds.has(entityId) || entityId < 0 || entityId >= 6) {
    entityId = -1;
    for (let i = 0; i < 6; i++) if (!usedEntityIds.has(i)) { entityId = i; break; }
  }
  return { reclaimed, entityId };
}

export interface ClientCommandPayload {
  commandId?: number; commandType: number; param1?: number; param2?: number;
  stateSnapshot?: Float32Array | number[] | null;
}

export interface RoleSwitchDataHandlerPort {
  sendPacket: (sessionId: string, packet: string | Uint8Array) => void;
  broadcast?: (packet: string | Uint8Array, filter?: (id: string) => boolean) => void;
}

export interface ControlPacketPayload {
  type?: string | number; playerName?: string; clientName?: string; role?: string;
  preferredTeam?: number | null; visualId?: string | number; carVisual?: string | number;
  hitboxId?: string | number | null; carHitbox?: string | number | null;
  colorSlot?: number | null; slotId?: number | null;
  blueColorSlot?: number | null; orangeColorSlot?: number | null;
  paintFinish?: string | number; boostVisual?: string | number;
  boostAudio?: string | number; anthemId?: string;
  commandId?: number; commandType?: number; param1?: number; param2?: number;
  ready?: boolean; matchSequence?: number; rtt?: number; sendTime?: number;
  stateSnapshot?: Float32Array | number[] | null;
}

export interface RosterSwitchControllerPort {
  applyingBotFillPolicy: boolean;
  readonly players: Map<string, MatchPlayerSlot>;
  readonly spectators: Map<string, MatchSpectatorSlot>;
  readonly disconnectedPlayerSlots: Map<number, DisconnectedPlayerSlot>;
  readonly host: {
    readonly domain: {
      matchTick: number; state: string;
      applyRosterPolicyConfig: () => { shouldApplyBotFill: boolean; isTrainingMode: boolean };
      buildRosterEnvelope: (sm?: unknown) => { buildHandshakeJson: (p: MatchPlayerSlot | null, snap?: number[] | null) => string };
    };
    readonly sessionManager: RosterSessionPort | null | undefined;
    readonly physicsManager: RosterPhysicsManagerPort | null | undefined;
    readonly dataHandler: RoleSwitchDataHandlerPort | null | undefined;
    dispatchSignal: (type: number, frame: number, p1?: number, p2?: number) => unknown;
    onPlayerSessionRemoved: (sid: string) => void;
  };
  withBotFillGuard<T>(fn: () => T): T;
  removePlayerSession(sid: string): void;
  assignPlayerSlot(
    sid: string, name?: string, role?: string, team?: number | null,
    loadout?: PlayerLoadoutOptions | string | number, colorSlot?: number | null
  ): MatchPlayerSlot | MatchSpectatorSlot | { entityId: number; team: number; role: string; spawnSlot: number } | null;
  applyInPlaceTeamSwitch(sid: string, p: MatchPlayerSlot, targetTeam: number, isTrainingMode: boolean): MatchPlayerSlot;
  applyBotFillPolicy(): void;
  broadcastRosterUpdate(): void;
}

export function executePlayerSessionRemoval(ctrl: RosterSwitchControllerPort, sessionId: string): void {
  const { domain, sessionManager, physicsManager } = ctrl.host;
  const tick = domain.matchTick, player = ctrl.players.get(sessionId);
  if (player) {
    const entityId = player.entityId, wasHuman = !player.isBot;
    if (wasHuman && entityId >= 0) ctrl.disconnectedPlayerSlots.set(entityId, { ...player, disconnectedAtTick: tick });
    ctrl.players.delete(sessionId);
    sessionManager?.unregisterSession?.(sessionId);
    if (physicsManager && entityId >= 0) physicsManager.unregisterCarEntity(entityId);
    ctrl.host.dispatchSignal(MATCH_SIGNALS.PLAYER_LEFT, tick, entityId, player.team ?? 0);
    ctrl.host.onPlayerSessionRemoved(sessionId);
    if (wasHuman && !ctrl.applyingBotFillPolicy && domain.applyRosterPolicyConfig().shouldApplyBotFill) ctrl.applyBotFillPolicy();
    ctrl.broadcastRosterUpdate();
    return;
  }
  if (ctrl.spectators.has(sessionId)) {
    ctrl.spectators.delete(sessionId);
    sessionManager?.unregisterSession?.(sessionId);
    ctrl.host.dispatchSignal(MATCH_SIGNALS.PLAYER_LEFT, tick, -1, 2);
    ctrl.broadcastRosterUpdate();
  }
}

export function executePlayerSessionReclaim(
  ctrl: RosterSwitchControllerPort, sessionId: string, requestedEntityId: number, preferredTeam: number | null
): MatchPlayerSlot | MatchSpectatorSlot | null | undefined {
  const { domain, sessionManager, physicsManager } = ctrl.host;
  if (ctrl.players.has(sessionId)) return ctrl.players.get(sessionId);
  const { reclaimed, entityId } = popReclaimedPlayerSlotCandidate(ctrl.disconnectedPlayerSlots, ctrl.players.values(), requestedEntityId);
  if (!reclaimed) return ctrl.assignPlayerSlot(sessionId, 'Player', 'player', preferredTeam) as MatchPlayerSlot | MatchSpectatorSlot | null;
  if (entityId < 0) return ctrl.assignPlayerSlot(sessionId, reclaimed.name || 'Player', 'spectator') as MatchPlayerSlot | MatchSpectatorSlot | null;
  if (ctrl.spectators.has(sessionId)) ctrl.spectators.delete(sessionId);

  const p: MatchPlayerSlot = { ...reclaimed, sessionId, entityId, carIndex: entityId, ready: true, arenaLoaded: true, isBot: false };
  ctrl.players.set(sessionId, p);
  sessionManager?.registerSession(sessionId, {
    role: 'player', entityId, team: p.team, visualId: p.visualId,
    hitboxId: p.hitboxId, deferPhysicsRegistration: false, playerName: p.name,
  });
  if (physicsManager) {
    const hb = p.hitboxId || p.visualId || 'octane';
    physicsManager.registerCarEntity(entityId, p.team, hb);
    physicsManager.applySignal('HOTSWAP_HITBOX', { carIndex: entityId, hitboxType: hb });
  }
  const tick = domain.matchTick;
  ctrl.host.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, tick, entityId, p.team);
  ctrl.host.dispatchSignal(MATCH_SIGNALS.PLAYER_SLOT_UPDATED, tick, entityId, p.team);
  ctrl.host.dispatchSignal(
    MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED, tick, entityId,
    packLoadoutSignalParam2(p.visualIndex ?? p.visualId, p.colorSlot, p.hitboxIndex ?? p.hitboxId, {
      paintFinish: p.paintFinish || 'metallic', boostVisual: p.boostVisual || 'cartoon', boostAudio: p.boostAudio || 'rush',
    })
  );
  ctrl.broadcastRosterUpdate();
  return p;
}

export function executePlayerRoleOrTeamSwitch(
  ctrl: RosterSwitchControllerPort, sessionId: string, targetRole: string | number, targetTeam: number
): MatchPlayerSlot | MatchSpectatorSlot | null {
  const { domain, sessionManager, dataHandler } = ctrl.host;
  const policyFlags = domain.applyRosterPolicyConfig();
  const cp = ctrl.players.get(sessionId), cs = ctrl.spectators.get(sessionId);
  const name = cp?.name || cs?.name || 'Player';
  const visualId = cp?.visualId || 'fennec', hitboxId = cp?.hitboxId || visualId;
  const colorSlot = cp?.colorSlot ?? resolveDefaultColorSlotForTeam(targetTeam);
  const paintFinish = cp?.paintFinish || 'metallic', boostVisual = cp?.boostVisual || 'cartoon', boostAudio = cp?.boostAudio || 'rush';

  if (targetRole === 'spectator' || targetRole === 2) {
    if (cp) ctrl.removePlayerSession(sessionId);
    const specSlot = ctrl.assignPlayerSlot(sessionId, name, 'spectator', null, {
      visualId, hitboxId, colorSlot, paintFinish, boostVisual, boostAudio,
    }) as MatchSpectatorSlot | null;
    ctrl.host.dispatchSignal(MATCH_SIGNALS.PLAYER_SLOT_UPDATED, domain.matchTick, 65535, PLAYER_ROLE_CODES.SPECTATOR);
    if (dataHandler && sessionId && sessionId !== 'host') {
      dataHandler.sendPacket(sessionId, domain.buildRosterEnvelope(sessionManager).buildHandshakeJson(null));
    }
    return specSlot;
  }

  let teamCount = 0, autoFillBotSid: string | null = null;
  if (targetTeam === 0 || targetTeam === 1) {
    for (const [sid, p] of ctrl.players.entries()) {
      if (sid !== sessionId && p.team === targetTeam) {
        teamCount++;
        if (p.isBot && String(sid).startsWith('bot_fill_') && !autoFillBotSid) autoFillBotSid = sid;
      }
    }
    if (teamCount >= 5 && autoFillBotSid && !ctrl.applyingBotFillPolicy) {
      ctrl.withBotFillGuard(() => { ctrl.removePlayerSession(autoFillBotSid!); teamCount--; });
    }
    if (teamCount >= 5) return cp || cs || null;
  }
  if (cp && cp.team === targetTeam) return cp;

  let updated: MatchPlayerSlot | MatchSpectatorSlot | null = null;
  const hadValidEntity = Boolean(cp && typeof cp.entityId === 'number' && cp.entityId >= 0);
  if (hadValidEntity && cp) {
    updated = ctrl.applyInPlaceTeamSwitch(sessionId, cp, targetTeam, policyFlags.isTrainingMode);
    ctrl.broadcastRosterUpdate();
  } else {
    updated = ctrl.withBotFillGuard(() => {
      if (cs) ctrl.removePlayerSession(sessionId);
      return ctrl.assignPlayerSlot(sessionId, name, 'player', targetTeam, {
        visualId, hitboxId, colorSlot: resolveDefaultColorSlotForTeam(targetTeam === 1 ? 1 : 0),
        paintFinish, boostVisual, boostAudio,
      }) as MatchPlayerSlot | MatchSpectatorSlot | null;
    });
  }

  if (!ctrl.applyingBotFillPolicy && policyFlags.shouldApplyBotFill) ctrl.applyBotFillPolicy();
  if (updated && 'entityId' in updated && updated.entityId >= 0) {
    if (domain.state !== MATCH_STATES.LOBBY || !hadValidEntity) {
      ctrl.host.dispatchSignal(MATCH_SIGNALS.PLAYER_SLOT_UPDATED, domain.matchTick, updated.entityId, updated.team === 1 ? 1 : 0);
    }
    if (!hadValidEntity && dataHandler && sessionId && sessionId !== 'host') {
      dataHandler.sendPacket(sessionId, domain.buildRosterEnvelope(sessionManager).buildHandshakeJson(updated));
    }
  }
  return updated;
}

export function evaluateSessionControlPacket(params: {
  channelId: string; packetType: string | number;
  packetData: ControlPacketPayload | null | undefined;
  roster: {
    assignPlayerSlot: (sid: string, name: string, role: string, preferredTeam: number | null, loadout: PlayerLoadoutOptions) => unknown;
    updatePlayerLoadout: (sid: string, visual: string | number, colorSlot: number | null, hitbox: string | number | null, extra: Record<string, string | number | undefined>) => unknown;
    removePlayerSession: (sid: string) => void;
  };
  dataHandler: RoleSwitchDataHandlerPort | null | undefined;
  sim?: { saveCompactState?: () => Float32Array; saveState?: () => Float32Array } | null;
  sessionManager?: { getSession?: (sid: string) => { updateRtt?: (rtt: number) => void } | null | undefined } | null;
  buildHandshakeJson: (player: MatchPlayerSlot | null, initialSnapshot?: number[] | null) => string;
  handleClientCommand: (channelId: string, cmd: ClientCommandPayload) => void;
}): unknown {
  const { channelId, packetType, packetData: pd, roster, dataHandler, sim, sessionManager, buildHandshakeJson, handleClientCommand } = params;
  if (!pd) return null;
  const type = pd.type || packetType;

  if (type === 'join' || type === 'join_training' || type === 'token' || type === 'handshake_request') {
    const info = roster.assignPlayerSlot(
      channelId, pd.playerName || pd.clientName || 'Player', pd.role || 'player', pd.preferredTeam ?? null,
      {
        visualId: pd.visualId || pd.carVisual || 'fennec', hitboxId: pd.hitboxId || pd.carHitbox || null,
        colorSlot: pd.colorSlot, blueColorSlot: pd.blueColorSlot, orangeColorSlot: pd.orangeColorSlot,
        paintFinish: pd.paintFinish, boostVisual: pd.boostVisual, boostAudio: pd.boostAudio, anthemId: pd.anthemId,
      }
    );
    if (dataHandler && info && typeof info === 'object' && 'visualId' in info) {
      const rawSnap = sim?.saveCompactState ? sim.saveCompactState() : sim?.saveState?.();
      dataHandler.sendPacket(channelId, buildHandshakeJson(info as MatchPlayerSlot, rawSnap ? Array.from<number>(rawSnap) : null));
    }
    return info;
  }

  if (type === 'color_change' || type === 'loadout_change') {
    if (pd.visualId !== undefined || pd.slotId !== undefined || pd.hitboxId !== undefined || pd.paintFinish !== undefined || pd.boostVisual !== undefined || pd.boostAudio !== undefined) {
      roster.updatePlayerLoadout(channelId, pd.visualId ?? 'fennec', pd.slotId ?? null, pd.hitboxId ?? null, {
        paintFinish: pd.paintFinish, boostVisual: pd.boostVisual, boostAudio: pd.boostAudio,
      });
    }
    dataHandler?.broadcast?.(JSON.stringify(pd), (id: string) => id !== channelId);
    return null;
  }
  if (type === 'client_command' && typeof pd.commandType === 'number') { handleClientCommand(channelId, pd as ClientCommandPayload); return null; }
  if (type === 'match_ready_ack') {
    handleClientCommand(channelId, { commandId: pd.commandId ?? 0, commandType: CLIENT_COMMAND_TYPES.CMD_READY_ACK, param1: pd.ready === false ? 0 : 1, param2: 0 });
    return null;
  }
  if (type === 'arena_loaded_ack') {
    handleClientCommand(channelId, { commandId: pd.commandId ?? 0, commandType: CLIENT_COMMAND_TYPES.CMD_ARENA_LOADED_ACK, param1: pd.matchSequence ?? 0, param2: 0 });
    return null;
  }
  if (type === 'ping') {
    if (typeof pd.rtt === 'number') sessionManager?.getSession?.(channelId)?.updateRtt?.(pd.rtt);
    dataHandler?.sendPacket(channelId, JSON.stringify({ type: 'pong', sendTime: pd.sendTime || Date.now(), serverTime: Date.now() }));
    return null;
  }
  if (type === 'leave') { roster.removePlayerSession(channelId); return null; }
  return null;
}
