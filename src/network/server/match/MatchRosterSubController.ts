/**
 * src/network/server/match/MatchRosterSubController.ts
 * Stateful SubController owning player/spectator rosters, disconnected slot reclamation,
 * spawn/color slot allocation, cosmetic loadouts, and bot fill policies.
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import {
  MATCH_STATES,
  resolveNormalizedSlotLoadout,
  resolveCosmeticsPatchForExistingPlayerSlot,
  resolveUpdatedPlayerLoadout,
  computeNormalizedTeamSpawnSlots,
  applyKickoffSpawnsToSim,
  type MatchPlayerSlot,
  type MatchSpectatorSlot,
  type DisconnectedPlayerSlot,
  type PlayerLoadoutOptions,
  type MatchRosterMetadataEntry,
  type RosterSnapshot,
  type RosterSessionManagerPort,
} from './matchLoadoutAndSpawnPipeline.ts';
import { buildMatchRosterMetadata } from './MatchRosterPolicyState.ts';
import {
  executePlayerSessionRemoval,
  executePlayerSessionReclaim,
  executePlayerRoleOrTeamSwitch,
  type RoleSwitchDataHandlerPort,
} from './matchSessionRoleSwitchPipeline.ts';
import {
  createNewPlayerSlotInfo,
  rollTeamBotLoadout,
  syncRosterCarsWithPhysicsEngine,
  registerAssignedPlayerWithSessionAndPhysics,
  resolveLobbyExistingPlayerTeamSwitchPatch,
  resolveInPlacePlayerTeamSwitchPatch,
  executeBotFillPolicyOnRoster,
  type RosterPhysicsManagerPort,
  type RosterSessionPort,
} from './matchRosterPhysicsAndBotPipeline.ts';
import type { MatchDomainState } from './MatchDomainState.ts';

export interface RosterDataHandlerPort extends RoleSwitchDataHandlerPort {
  broadcast?: (packet: string | Uint8Array, filter?: (id: string) => boolean) => void;
}

export interface MatchRosterHostPort {
  readonly domain: MatchDomainState;
  readonly physicsManager: RosterPhysicsManagerPort | null | undefined;
  readonly sessionManager:
    | (RosterSessionPort &
        RosterSessionManagerPort & {
          getSession?: (sessionId: string) =>
            | {
                team?: number;
                playerName?: string;
                rttMs?: number;
                entityId: number;
                role?: string;
                deferPhysicsRegistration?: boolean;
              }
            | null
            | undefined;
        })
    | null
    | undefined;
  readonly dataHandler: RosterDataHandlerPort | null | undefined;
  dispatchSignal(signalType: number, frameId: number, param1?: number, param2?: number): unknown;
  onPlayerSessionRemoved(sessionId: string): void;
  onLobbyAutoStartTriggered(): void;
}

export class MatchRosterSubController {
  readonly deps: MatchRosterHostPort;
  applyingBotFillPolicy = false;

  constructor(deps: MatchRosterHostPort) {
    this.deps = deps;
  }

  get players(): Map<string, MatchPlayerSlot> {
    return this.deps.domain.players;
  }
  get spectators(): Map<string, MatchSpectatorSlot> {
    return this.deps.domain.spectators;
  }
  get disconnectedPlayerSlots(): Map<number, DisconnectedPlayerSlot> {
    return this.deps.domain.disconnectedPlayerSlots;
  }

  getMatchRosterMetadata(): MatchRosterMetadataEntry[] {
    return buildMatchRosterMetadata(this.players.values());
  }

  buildRosterSnapshot(): RosterSnapshot {
    const { domain, sessionManager } = this.deps;
    return domain.buildRosterEnvelope(sessionManager).roster;
  }

  withBotFillGuard<T>(fn: () => T): T {
    const prev = this.applyingBotFillPolicy;
    this.applyingBotFillPolicy = true;
    try {
      return fn();
    } finally {
      this.applyingBotFillPolicy = prev;
    }
  }

  clearAutoFillBots(): boolean {
    return this.withBotFillGuard(() => {
      let cleared = false;
      for (const [sid, p] of Array.from(this.players.entries())) {
        if (p.isBot && String(sid).startsWith('bot_fill_')) {
          this.removePlayerSession(sid);
          cleared = true;
        }
      }
      return cleared;
    });
  }

  broadcastRosterUpdate(): void {
    const { domain, dataHandler, sessionManager } = this.deps;
    if (!dataHandler || typeof dataHandler.broadcast !== 'function' || this.applyingBotFillPolicy)
      return;
    try {
      dataHandler.broadcast(domain.buildRosterEnvelope(sessionManager).rosterUpdateJson);
    } catch (err) {
      console.warn('[MatchRosterSubController] Failed to broadcast roster_update:', err);
    }
  }

  setGameMode(gameMode: string, durationSeconds: number | null = null): void {
    const { shouldApplyBotFill } = this.deps.domain.applyRosterPolicyConfig({
      gameMode,
      durationSeconds,
    });
    if (shouldApplyBotFill) this.applyBotFillPolicy();
    else this.broadcastRosterUpdate();
  }

  setBotFillMode(botFillMode = 'no_bots', botType?: string): void {
    const { shouldApplyBotFill } = this.deps.domain.applyRosterPolicyConfig({
      botFillMode,
      botType,
    });
    if (shouldApplyBotFill) this.applyBotFillPolicy();
    else this.broadcastRosterUpdate();
  }

  rollBotLoadoutForTeam(team = 0): PlayerLoadoutOptions {
    return rollTeamBotLoadout(this.deps.domain.botsLoadoutConfig, this.players.values(), team);
  }

  addBotPlayer(
    preferredTeam = 1,
    botName: string | null = null,
    visualId: string | PlayerLoadoutOptions | null = null,
    botType?: string
  ):
    | MatchPlayerSlot
    | MatchSpectatorSlot
    | { entityId: number; team: number; role: string; spawnSlot: number }
    | null {
    if (this.players.size >= 6) return null;
    const { domain } = this.deps;
    if (domain.botFillMode === 'no_bots') domain.botFillMode = 'custom';
    let botIdx = 1;
    while (this.players.has(`bot_${botIdx}`)) botIdx++;
    const resolvedBotType =
      botType ||
      (visualId && typeof visualId === 'object' ? visualId.botType : undefined) ||
      domain.defaultBotType ||
      'nexto';
    const botLabel = resolvedBotType.charAt(0).toUpperCase() + resolvedBotType.slice(1);
    const sid = `bot_${botIdx}`,
      resolvedName = botName || `${botLabel} #${botIdx}`;
    const rolled = { ...this.rollBotLoadoutForTeam(preferredTeam ?? 1), botType: resolvedBotType };
    const loadout: PlayerLoadoutOptions =
      visualId && typeof visualId === 'object'
        ? { ...rolled, ...visualId, botType: resolvedBotType }
        : visualId
          ? { ...rolled, visualId }
          : rolled;
    return this.assignPlayerSlot(
      sid,
      resolvedName,
      'player',
      preferredTeam,
      loadout,
      loadout.colorSlot ?? null
    );
  }

  applyBotFillPolicy(): void {
    if (this.applyingBotFillPolicy) return;
    const { domain } = this.deps;
    this.withBotFillGuard(() => {
      executeBotFillPolicyOnRoster({
        players: this.players,
        botFillMode: domain.botFillMode,
        maxPlayers: domain.maxPlayers,
        defaultBotType: domain.defaultBotType,
        botsLoadoutConfig: domain.botsLoadoutConfig,
        removePlayerSession: (sid) => this.removePlayerSession(sid),
        switchPlayerRoleOrTeam: (sid, role, team) => this.switchPlayerRoleOrTeam(sid, role, team),
        assignPlayerSlot: (sid, name, role, team, loadout, colorSlot) =>
          this.assignPlayerSlot(sid, name, role, team, loadout, colorSlot ?? null),
      });
    });
    this.broadcastRosterUpdate();
  }

  syncRosterPhysicsEntities(): void {
    const { domain, physicsManager, sessionManager } = this.deps;
    syncRosterCarsWithPhysicsEngine({
      players: this.players,
      physicsManager,
      sessionManager,
      lobbyPhysicsActive: domain.applyRosterPolicyConfig().lobbyPhysicsActive,
    });
  }

  applyPendingHitboxSwaps(): void {
    const pm = this.deps.physicsManager;
    if (!pm) return;
    for (const p of this.players.values()) {
      if (p.pendingVisualId && p.entityId >= 0) {
        pm.applySignal('HOTSWAP_HITBOX', { carIndex: p.entityId, hitboxType: p.pendingVisualId });
        p.pendingVisualId = null;
      }
    }
  }

  applyRosterKickoffSpawns(): void {
    const { domain, physicsManager } = this.deps;
    applyKickoffSpawnsToSim(
      physicsManager?.sim,
      physicsManager ? new Set(physicsManager.activeCarIndices) : null,
      this.players.values(),
      domain.applyRosterPolicyConfig().kickoffBoostAmount
    );
  }

  assignPlayerSlot(
    sessionId: string,
    playerName = 'Player',
    role = 'player',
    preferredTeam: number | null = null,
    loadoutOptions: PlayerLoadoutOptions | string | number = {},
    colorSlotArg: number | null = null
  ):
    | MatchPlayerSlot
    | MatchSpectatorSlot
    | { entityId: number; team: number; role: string; spawnSlot: number }
    | null {
    const { domain, sessionManager, physicsManager, dispatchSignal, onLobbyAutoStartTriggered } =
      this.deps;
    const isBotSession = sessionId === 'bot' || String(sessionId).startsWith('bot_');
    const resolved = resolveNormalizedSlotLoadout(loadoutOptions, colorSlotArg, isBotSession);
    const nl = resolved.normalizedLoadout;

    if (this.players.has(sessionId)) {
      const existing = this.players.get(sessionId)!;
      const basePatch: Partial<MatchPlayerSlot> = {};
      if (typeof nl.blueColorSlot === 'number') basePatch.blueColorSlot = nl.blueColorSlot;
      if (typeof nl.orangeColorSlot === 'number') basePatch.orangeColorSlot = nl.orangeColorSlot;
      if (playerName && playerName !== 'Player') {
        basePatch.name = playerName;
        const s = sessionManager?.getSession?.(sessionId);
        if (s) s.playerName = playerName;
      }
      domain.updatePlayerSlot(sessionId, basePatch);

      if (
        !isBotSession &&
        (preferredTeam === 0 || preferredTeam === 1) &&
        existing.team !== preferredTeam &&
        domain.state === MATCH_STATES.LOBBY
      ) {
        const teamPatch = resolveLobbyExistingPlayerTeamSwitchPatch({
          sessionId,
          existing,
          preferredTeam,
          requestedColorSlot: nl.colorSlot,
          players: this.players,
          sessionManager,
          physicsManager,
        });
        domain.updatePlayerSlot(sessionId, teamPatch);
        computeNormalizedTeamSpawnSlots(this.players.values());
        if (typeof existing.entityId === 'number' && existing.entityId >= 0) {
          dispatchSignal(
            MATCH_SIGNALS.PLAYER_SLOT_UPDATED,
            domain.matchTick,
            existing.entityId,
            existing.team
          );
        }
      }
      domain.updatePlayerSlot(
        sessionId,
        resolveCosmeticsPatchForExistingPlayerSlot(existing, resolved)
      );
      if (
        !isBotSession &&
        !this.applyingBotFillPolicy &&
        domain.applyRosterPolicyConfig().shouldApplyBotFill
      ) {
        this.applyBotFillPolicy();
      }
      this.broadcastRosterUpdate();
      return existing;
    }

    if (this.spectators.has(sessionId) && role === 'spectator') {
      const existing = this.spectators.get(sessionId)!;
      if (playerName && playerName !== 'Player') existing.name = playerName;
      this.broadcastRosterUpdate();
      return existing;
    }

    const clearedAutoFillBots =
      role !== 'spectator' && !isBotSession && !this.applyingBotFillPolicy
        ? this.clearAutoFillBots()
        : false;

    if (role === 'spectator' || this.players.size >= domain.maxPlayers) {
      this.spectators.set(sessionId, {
        sessionId,
        name: playerName,
        role: 'spectator',
        ready: true,
        arenaLoaded: true,
      });
      sessionManager?.registerSession(sessionId, { role: 'spectator', entityId: -1, playerName });
      dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, domain.matchTick, -1, 2);
      return { entityId: -1, team: -1, role: 'spectator', spawnSlot: -1 };
    }

    const playerInfo = createNewPlayerSlotInfo(
      sessionId,
      playerName,
      preferredTeam,
      this.players.values(),
      resolved,
      isBotSession
    );
    this.players.set(sessionId, playerInfo);

    const policyFlags = domain.applyRosterPolicyConfig();
    registerAssignedPlayerWithSessionAndPhysics({
      sessionId,
      playerInfo,
      state: domain.state,
      lobbyMode: policyFlags.lobbyMode,
      isTrainingMode: policyFlags.isTrainingMode,
      matchTick: domain.matchTick,
      sessionManager,
      physicsManager,
      dispatchSignal: (t, f, p1, p2) => dispatchSignal(t, f, p1, p2),
    });

    if (
      (clearedAutoFillBots || policyFlags.shouldApplyBotFill) &&
      !isBotSession &&
      !this.applyingBotFillPolicy &&
      domain.state !== MATCH_STATES.LOBBY
    ) {
      this.applyBotFillPolicy();
    }
    this.broadcastRosterUpdate();
    if (!this.applyingBotFillPolicy && domain.applyRosterPolicyConfig().shouldAutoStartLobby) {
      onLobbyAutoStartTriggered();
    }
    return playerInfo;
  }

  removePlayerSession(sessionId: string): void {
    executePlayerSessionRemoval(this, sessionId);
  }

  reclaimPlayerSession(
    sessionId: string,
    requestedEntityId = -1,
    preferredTeam: number | null = null
  ): MatchPlayerSlot | MatchSpectatorSlot | null | undefined {
    return executePlayerSessionReclaim(this, sessionId, requestedEntityId, preferredTeam);
  }

  updatePlayerLoadout(
    sessionId: string,
    visualIdOrPackedParam1: string | number,
    colorSlotOrPackedParam2: number | null = null,
    explicitHitbox: string | number | null = null,
    extraLoadout: Record<string, string | number | undefined> | null = null
  ): MatchPlayerSlot | null {
    const { domain, physicsManager, dispatchSignal } = this.deps;
    const player = this.players.get(sessionId);
    if (!player) return null;

    const { patch, packedLoadout } = resolveUpdatedPlayerLoadout(
      player,
      sessionId,
      visualIdOrPackedParam1,
      colorSlotOrPackedParam2,
      explicitHitbox,
      extraLoadout
    );
    domain.updatePlayerSlot(sessionId, patch);

    if (domain.applyRosterPolicyConfig().canHotSwapNow && physicsManager && player.entityId >= 0) {
      physicsManager.applySignal('HOTSWAP_HITBOX', {
        carIndex: player.entityId,
        hitboxType: player.hitboxId,
      });
      player.pendingVisualId = null;
    } else {
      player.pendingVisualId = player.hitboxId;
    }

    dispatchSignal(
      MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
      domain.matchTick,
      player.entityId,
      packedLoadout
    );
    this.broadcastRosterUpdate();
    return player;
  }

  applyInPlaceTeamSwitch(
    sessionId: string,
    currentPlayer: MatchPlayerSlot,
    targetTeam: number,
    isTrainingMode: boolean
  ): MatchPlayerSlot {
    const { domain, sessionManager, physicsManager, dispatchSignal } = this.deps;
    const patch = resolveInPlacePlayerTeamSwitchPatch({
      sessionId,
      currentPlayer,
      targetTeam,
      players: this.players,
      state: domain.state,
      isTrainingMode,
      matchTick: domain.matchTick,
      sessionManager,
      physicsManager,
      dispatchSignal: (t, f, p1, p2) => dispatchSignal(t, f, p1, p2),
    });
    return domain.updatePlayerSlot(sessionId, patch) || currentPlayer;
  }

  switchPlayerRoleOrTeam(
    sessionId: string,
    targetRole: string | number = 'player',
    targetTeam = 0
  ): MatchPlayerSlot | MatchSpectatorSlot | null {
    return executePlayerRoleOrTeamSwitch(this, sessionId, targetRole, targetTeam);
  }

  clear(): void {
    this.players.clear();
    this.spectators.clear();
    this.disconnectedPlayerSlots.clear();
  }
}
