/**
 * src/network/server/match/MatchRosterSubController.ts
 * Stateful SubController owning player/spectator rosters, disconnected slot reclamation,
 * spawn/color slot allocation, cosmetic loadouts, and bot fill policies.
 */

import { MATCH_SIGNALS } from '../../protocol/GlobalPayloadCodec.ts';
import {
  MATCH_STATES,
  resolveNormalizedSlotLoadout,
  resolveUpdatedPlayerLoadout,
  computeNormalizedTeamSpawnSlots,
  applyKickoffSpawnsToSim,
  buildMatchRosterMetadata,
  type MatchPlayerSlot,
  type MatchSpectatorSlot,
  type DisconnectedPlayerSlot,
  type PlayerLoadoutOptions,
  type MatchRosterMetadataEntry,
  type RosterSnapshot,
} from './matchLoadoutAndSpawnPipeline.ts';
import {
  resolveCosmeticsPatchForExistingPlayerSlot,
  createNewPlayerSlotInfo,
  executePlayerSessionRemoval,
  executePlayerSessionReclaim,
  executePlayerRoleOrTeamSwitch,
  type RoleSwitchDataHandlerPort,
} from './matchSessionRoleSwitchPipeline.ts';
import {
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
import type { RosterSessionManagerPort } from './matchLoadoutAndSpawnPipeline.ts';

export interface RosterDataHandlerPort extends RoleSwitchDataHandlerPort {
  broadcast?: (packet: string | Uint8Array, filter?: (id: string) => boolean) => void;
}

export interface MatchRosterHostPort {
  readonly domain: MatchDomainState;
  readonly physicsManager: RosterPhysicsManagerPort | null | undefined;
  readonly sessionManager: (RosterSessionPort & RosterSessionManagerPort & {
    getSession?: (sessionId: string) => {
      team?: number;
      playerName?: string;
      rttMs?: number;
      entityId: number;
      role?: string;
      deferPhysicsRegistration?: boolean;
    } | null | undefined;
  }) | null | undefined;
  readonly dataHandler: RosterDataHandlerPort | null | undefined;
  dispatchSignal(signalType: number, frameId: number, param1?: number, param2?: number): unknown;
  onPlayerSessionRemoved(sessionId: string): void;
  onLobbyAutoStartTriggered(): void;
}

export class MatchRosterSubController {
  readonly host: MatchRosterHostPort;
  applyingBotFillPolicy = false;

  constructor(host: MatchRosterHostPort) {
    this.host = host;
  }

  get players(): Map<string, MatchPlayerSlot> {
    return this.host.domain.players;
  }
  get spectators(): Map<string, MatchSpectatorSlot> {
    return this.host.domain.spectators;
  }
  get disconnectedPlayerSlots(): Map<number, DisconnectedPlayerSlot> {
    return this.host.domain.disconnectedPlayerSlots;
  }

  getMatchRosterMetadata(): MatchRosterMetadataEntry[] {
    return buildMatchRosterMetadata(this.players.values());
  }

  buildRosterSnapshot(): RosterSnapshot {
    return this.host.domain.buildRosterEnvelope(this.host.sessionManager).roster;
  }

  broadcastRosterUpdate(): void {
    const { domain, dataHandler, sessionManager } = this.host;
    if (!dataHandler || typeof dataHandler.broadcast !== 'function') return;
    if (this.applyingBotFillPolicy) return;
    try {
      dataHandler.broadcast(domain.buildRosterEnvelope(sessionManager).rosterUpdateJson);
    } catch (err) {
      console.warn('[MatchRosterSubController] Failed to broadcast roster_update:', err);
    }
  }

  setGameMode(gameMode: string, durationSeconds: number | null = null): void {
    const { shouldApplyBotFill } = this.host.domain.applyRosterPolicyConfig({
      gameMode,
      durationSeconds,
    });
    if (shouldApplyBotFill) this.applyBotFillPolicy();
    else this.broadcastRosterUpdate();
  }

  setBotFillMode(botFillMode = 'no_bots'): void {
    const { shouldApplyBotFill } = this.host.domain.applyRosterPolicyConfig({ botFillMode });
    if (shouldApplyBotFill) this.applyBotFillPolicy();
    else this.broadcastRosterUpdate();
  }

  rollBotLoadoutForTeam(team = 0): PlayerLoadoutOptions {
    return rollTeamBotLoadout(this.host.domain.botsLoadoutConfig, this.players.values(), team);
  }

  addBotPlayer(
    preferredTeam = 1,
    botName: string | null = null,
    visualId: string | PlayerLoadoutOptions | null = null
  ): MatchPlayerSlot | MatchSpectatorSlot | { entityId: number; team: number; role: string; spawnSlot: number } | null {
    if (this.players.size >= 6) return null;
    let botIdx = 1;
    while (this.players.has(`bot_${botIdx}`)) botIdx++;
    const sid = `bot_${botIdx}`;
    const resolvedName = botName || `Nexto #${botIdx}`;
    const rolled = this.rollBotLoadoutForTeam(preferredTeam ?? 1);
    const loadout: PlayerLoadoutOptions =
      visualId && typeof visualId === 'object'
        ? { ...rolled, ...visualId }
        : visualId
          ? { ...rolled, visualId }
          : rolled;
    return this.assignPlayerSlot(sid, resolvedName, 'player', preferredTeam, loadout, loadout.colorSlot ?? null);
  }

  applyBotFillPolicy(): void {
    if (this.applyingBotFillPolicy) return;
    const { domain } = this.host;
    this.applyingBotFillPolicy = true;
    try {
      executeBotFillPolicyOnRoster({
        players: this.players,
        botFillMode: domain.botFillMode,
        maxPlayers: domain.maxPlayers,
        botsLoadoutConfig: domain.botsLoadoutConfig,
        removePlayerSession: (sid) => this.removePlayerSession(sid),
        switchPlayerRoleOrTeam: (sid, role, team) => this.switchPlayerRoleOrTeam(sid, role, team),
        assignPlayerSlot: (sid, name, role, team, loadout, colorSlot) =>
          this.assignPlayerSlot(sid, name, role, team, loadout, colorSlot ?? null),
      });
    } finally {
      this.applyingBotFillPolicy = false;
    }
    this.broadcastRosterUpdate();
  }

  syncRosterPhysicsEntities(): void {
    const { domain, physicsManager, sessionManager } = this.host;
    syncRosterCarsWithPhysicsEngine({
      players: this.players,
      physicsManager,
      sessionManager,
      lobbyPhysicsActive: domain.applyRosterPolicyConfig().lobbyPhysicsActive,
    });
  }

  applyPendingHitboxSwaps(): void {
    const physicsManager = this.host.physicsManager;
    if (!physicsManager) return;
    for (const p of this.players.values()) {
      if (p.pendingVisualId && p.entityId >= 0) {
        physicsManager.applySignal('HOTSWAP_HITBOX', {
          carIndex: p.entityId,
          hitboxType: p.pendingVisualId,
        });
        p.pendingVisualId = null;
      }
    }
  }

  applyRosterKickoffSpawns(): void {
    const { domain, physicsManager } = this.host;
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
  ): MatchPlayerSlot | MatchSpectatorSlot | { entityId: number; team: number; role: string; spawnSlot: number } | null {
    const { domain, sessionManager, physicsManager } = this.host;
    const isBotSession = sessionId === 'bot' || String(sessionId).startsWith('bot_');
    const resolved = resolveNormalizedSlotLoadout(loadoutOptions, colorSlotArg, isBotSession);
    const { normalizedLoadout } = resolved;

    if (this.players.has(sessionId)) {
      const existing = this.players.get(sessionId)!;
      const basePatch: Partial<MatchPlayerSlot> = {};
      if (typeof normalizedLoadout.blueColorSlot === 'number') {
        basePatch.blueColorSlot = normalizedLoadout.blueColorSlot;
      }
      if (typeof normalizedLoadout.orangeColorSlot === 'number') {
        basePatch.orangeColorSlot = normalizedLoadout.orangeColorSlot;
      }
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
          requestedColorSlot: normalizedLoadout.colorSlot,
          players: this.players,
          sessionManager,
          physicsManager,
        });
        domain.updatePlayerSlot(sessionId, teamPatch);
        computeNormalizedTeamSpawnSlots(this.players.values());
        if (typeof existing.entityId === 'number' && existing.entityId >= 0) {
          this.host.dispatchSignal(
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

    let clearedAutoFillBots = false;
    if (role !== 'spectator' && !isBotSession && !this.applyingBotFillPolicy) {
      const prevApplying = this.applyingBotFillPolicy;
      this.applyingBotFillPolicy = true;
      try {
        for (const [sid, p] of Array.from(this.players.entries())) {
          if (p.isBot && String(sid).startsWith('bot_fill_')) {
            this.removePlayerSession(sid);
            clearedAutoFillBots = true;
          }
        }
      } finally {
        this.applyingBotFillPolicy = prevApplying;
      }
    }

    if (role === 'spectator' || this.players.size >= domain.maxPlayers) {
      this.spectators.set(sessionId, {
        sessionId,
        name: playerName,
        role: 'spectator',
        ready: true,
        arenaLoaded: true,
      });
      sessionManager?.registerSession(sessionId, { role: 'spectator', entityId: -1, playerName });
      this.host.dispatchSignal(MATCH_SIGNALS.PLAYER_JOINED, domain.matchTick, -1, 2);
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
      dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
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
      this.host.onLobbyAutoStartTriggered();
    }

    return playerInfo;
  }

  removePlayerSession(sessionId: string): void {
    const { domain, sessionManager, physicsManager } = this.host;
    executePlayerSessionRemoval({
      sessionId,
      players: this.players,
      spectators: this.spectators,
      disconnectedPlayerSlots: this.disconnectedPlayerSlots,
      matchTick: domain.matchTick,
      shouldRunActiveMatchBotFill: domain.applyRosterPolicyConfig().shouldApplyBotFill,
      applyingBotFillPolicy: this.applyingBotFillPolicy,
      sessionManager,
      physicsManager,
      dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
      onPlayerSessionRemoved: (sid) => this.host.onPlayerSessionRemoved(sid),
      applyBotFillPolicy: () => this.applyBotFillPolicy(),
      broadcastRosterUpdate: () => this.broadcastRosterUpdate(),
    });
  }

  reclaimPlayerSession(
    sessionId: string,
    requestedEntityId = -1,
    preferredTeam: number | null = null
  ): MatchPlayerSlot | MatchSpectatorSlot | null | undefined {
    const { domain, sessionManager, physicsManager } = this.host;
    return executePlayerSessionReclaim({
      sessionId,
      requestedEntityId,
      preferredTeam,
      players: this.players,
      spectators: this.spectators,
      disconnectedPlayerSlots: this.disconnectedPlayerSlots,
      matchTick: domain.matchTick,
      sessionManager,
      physicsManager,
      assignPlayerSlot: (sid, name, role, team) =>
        this.assignPlayerSlot(sid, name, role, team) as MatchPlayerSlot | MatchSpectatorSlot | null,
      dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
      broadcastRosterUpdate: () => this.broadcastRosterUpdate(),
    });
  }

  updatePlayerLoadout(
    sessionId: string,
    visualIdOrPackedParam1: string | number,
    colorSlotOrPackedParam2: number | null = null,
    explicitHitbox: string | number | null = null,
    extraLoadout: Record<string, string | number | undefined> | null = null
  ): MatchPlayerSlot | null {
    const { domain, physicsManager } = this.host;
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

    this.host.dispatchSignal(
      MATCH_SIGNALS.PLAYER_LOADOUT_UPDATED,
      domain.matchTick,
      player.entityId,
      packedLoadout
    );
    this.broadcastRosterUpdate();
    return player;
  }

  switchPlayerRoleOrTeam(
    sessionId: string,
    targetRole: string | number = 'player',
    targetTeam = 0
  ): MatchPlayerSlot | MatchSpectatorSlot | null {
    const { domain, sessionManager, physicsManager, dataHandler } = this.host;
    const policyFlags = domain.applyRosterPolicyConfig();
    return executePlayerRoleOrTeamSwitch({
      sessionId,
      targetRole,
      targetTeam,
      players: this.players,
      spectators: this.spectators,
      matchTick: domain.matchTick,
      state: domain.state,
      shouldRunActiveMatchBotFill: policyFlags.shouldApplyBotFill,
      dataHandler,
      isApplyingBotFillPolicy: () => this.applyingBotFillPolicy,
      setApplyingBotFillPolicy: (v) => {
        this.applyingBotFillPolicy = v;
      },
      removePlayerSession: (sid) => this.removePlayerSession(sid),
      assignPlayerSlot: (sid, name, role, team, loadout) =>
        this.assignPlayerSlot(sid, name, role, team, loadout) as MatchPlayerSlot | MatchSpectatorSlot | null,
      applyInPlaceTeamSwitch: (currentPlayer, nextTeam) => {
        const patch = resolveInPlacePlayerTeamSwitchPatch({
          sessionId,
          currentPlayer,
          targetTeam: nextTeam,
          players: this.players,
          state: domain.state,
          isTrainingMode: policyFlags.isTrainingMode,
          matchTick: domain.matchTick,
          sessionManager,
          physicsManager,
          dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
        });
        return domain.updatePlayerSlot(sessionId, patch) || currentPlayer;
      },
      applyBotFillPolicy: () => this.applyBotFillPolicy(),
      buildHandshakePacketJson: (player) =>
        domain.buildRosterEnvelope(sessionManager).buildHandshakeJson(player),
      broadcastRosterUpdate: () => this.broadcastRosterUpdate(),
      dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
    });
  }

  clear(): void {
    this.players.clear();
    this.spectators.clear();
    this.disconnectedPlayerSlots.clear();
  }
}
