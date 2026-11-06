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
  applyKickoffSpawnsToSim,
  buildMatchRosterMetadata,
  buildRosterSnapshot,
  type MatchPlayerSlot,
  type MatchSpectatorSlot,
  type DisconnectedPlayerSlot,
  type PlayerLoadoutOptions,
  type MatchRosterMetadataEntry,
  type RosterSnapshot,
} from './matchLoadoutAndSpawnPipeline.ts';
import {
  applyCosmeticsToExistingPlayerSlot,
  createNewPlayerSlotInfo,
  executePlayerSessionRemoval,
  executePlayerSessionReclaim,
  executePlayerRoleOrTeamSwitch,
} from './matchSessionRoleSwitchPipeline.ts';
import {
  rollTeamBotLoadout,
  syncRosterCarsWithPhysicsEngine,
  registerAssignedPlayerWithSessionAndPhysics,
  applyLobbyExistingPlayerTeamSwitch,
  executeBotFillPolicyOnRoster,
} from './matchRosterPhysicsAndBotPipeline.ts';
import { type MatchDomainState, resolveMaxPlayersForGameMode } from './MatchDomainState.ts';

export interface MatchRosterHostPort {
  readonly domain: MatchDomainState;
  readonly physicsManager: any;
  readonly sessionManager: any;
  readonly dataHandler: any;
  dispatchSignal(signalType: number, frameId: number, param1?: number, param2?: number): any;
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
    const { domain, sessionManager } = this.host;
    return buildRosterSnapshot({
      players: domain.players,
      spectators: domain.spectators,
      sessionManager,
      gameMode: domain.gameMode,
      botFillMode: domain.botFillMode,
      clockDuration: domain.clockDuration,
      clockSecondsRemaining: domain.clockSecondsRemaining,
      blueScore: domain.blueScore,
      orangeScore: domain.orangeScore,
    });
  }

  broadcastRosterUpdate(): void {
    const { dataHandler, domain } = this.host;
    if (!dataHandler || typeof dataHandler.broadcast !== 'function') return;
    if (this.applyingBotFillPolicy) return;
    try {
      dataHandler.broadcast(
        JSON.stringify({
          type: 'roster_update',
          roomId: domain.roomId,
          gameMode: domain.gameMode,
          botFillMode: domain.botFillMode,
          durationSeconds: domain.clockDuration,
          state: domain.state,
          roster: this.buildRosterSnapshot(),
        })
      );
    } catch (err) {
      console.warn('[MatchRosterSubController] Failed to broadcast roster_update:', err);
    }
  }

  setGameMode(gameMode: string, durationSeconds: number | null = null): void {
    const { domain } = this.host;
    if (gameMode === '1v1' || gameMode === '2v2' || gameMode === '3v3') {
      domain.gameMode = gameMode;
      domain.maxPlayers = resolveMaxPlayersForGameMode(gameMode);
    }
    if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      domain.clockDuration = durationSeconds;
      if (domain.state === MATCH_STATES.LOBBY) domain.clockSecondsRemaining = durationSeconds;
    }
    if (
      domain.state !== MATCH_STATES.LOBBY &&
      (domain.botFillMode === 'auto_fill' || domain.botFillMode === 'bots_vs_humans')
    ) {
      this.applyBotFillPolicy();
    } else {
      this.broadcastRosterUpdate();
    }
  }

  setBotFillMode(botFillMode = 'no_bots'): void {
    const { domain } = this.host;
    const valid = ['no_bots', 'auto_fill', 'bots_vs_humans', 'custom'];
    if (valid.includes(botFillMode)) domain.botFillMode = botFillMode;
    if (domain.state !== MATCH_STATES.LOBBY) this.applyBotFillPolicy();
    else this.broadcastRosterUpdate();
  }

  rollBotLoadoutForTeam(team = 0): Record<string, any> {
    return rollTeamBotLoadout(this.host.domain.botsLoadoutConfig, this.players.values(), team);
  }

  addBotPlayer(
    preferredTeam = 1,
    botName: string | null = null,
    visualId: string | Record<string, any> | null = null
  ): MatchPlayerSlot | any {
    if (this.players.size >= 6) return null;
    let botIdx = 1;
    while (this.players.has(`bot_${botIdx}`)) botIdx++;
    const sid = `bot_${botIdx}`;
    const resolvedName = botName || `Nexto #${botIdx}`;
    const rolled = this.rollBotLoadoutForTeam(preferredTeam ?? 1);
    const loadout =
      visualId && typeof visualId === 'object'
        ? { ...rolled, ...visualId }
        : visualId
          ? { ...rolled, visualId }
          : rolled;
    return this.assignPlayerSlot(sid, resolvedName, 'player', preferredTeam, loadout, loadout.colorSlot);
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
          this.assignPlayerSlot(sid, name, role, team, loadout, colorSlot),
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
      lobbyPhysicsActive: domain.lobbyPhysicsActive,
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
    const boostAmount = domain.state === MATCH_STATES.LOBBY || domain.isTrainingMode ? 100.0 : 33.33;
    applyKickoffSpawnsToSim(
      physicsManager?.sim,
      physicsManager?.activeCarIndices,
      this.players.values(),
      boostAmount
    );
  }

  assignPlayerSlot(
    sessionId: string,
    playerName = 'Player',
    role = 'player',
    preferredTeam: number | null = null,
    loadoutOptions: PlayerLoadoutOptions | string | number = {},
    colorSlotArg: number | null = null
  ): any {
    const { domain, sessionManager, physicsManager } = this.host;
    const isBotSession = sessionId === 'bot' || String(sessionId).startsWith('bot_');
    const resolved = resolveNormalizedSlotLoadout(loadoutOptions, colorSlotArg, isBotSession);
    const { normalizedLoadout } = resolved;

    if (this.players.has(sessionId)) {
      const existing = this.players.get(sessionId)!;
      if (typeof normalizedLoadout.blueColorSlot === 'number') {
        existing.blueColorSlot = normalizedLoadout.blueColorSlot;
      }
      if (typeof normalizedLoadout.orangeColorSlot === 'number') {
        existing.orangeColorSlot = normalizedLoadout.orangeColorSlot;
      }
      if (playerName && playerName !== 'Player') {
        existing.name = playerName;
        const s = sessionManager?.getSession(sessionId);
        if (s) s.playerName = playerName;
      }
      if (
        !isBotSession &&
        (preferredTeam === 0 || preferredTeam === 1) &&
        existing.team !== preferredTeam &&
        domain.state === MATCH_STATES.LOBBY
      ) {
        applyLobbyExistingPlayerTeamSwitch({
          sessionId,
          existing,
          preferredTeam,
          requestedColorSlot: normalizedLoadout.colorSlot,
          players: this.players,
          sessionManager,
          physicsManager,
          matchTick: domain.matchTick,
          dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
        });
      }
      applyCosmeticsToExistingPlayerSlot(existing, resolved);

      if (
        !isBotSession &&
        !this.applyingBotFillPolicy &&
        domain.state !== MATCH_STATES.LOBBY &&
        (domain.botFillMode === 'auto_fill' || domain.botFillMode === 'bots_vs_humans')
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

    registerAssignedPlayerWithSessionAndPhysics({
      sessionId,
      playerInfo,
      state: domain.state,
      lobbyMode: domain.lobbyMode,
      isTrainingMode: domain.isTrainingMode,
      matchTick: domain.matchTick,
      sessionManager,
      physicsManager,
      dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
    });

    if (
      (clearedAutoFillBots ||
        domain.botFillMode === 'auto_fill' ||
        domain.botFillMode === 'bots_vs_humans') &&
      !isBotSession &&
      !this.applyingBotFillPolicy &&
      domain.state !== MATCH_STATES.LOBBY
    ) {
      this.applyBotFillPolicy();
    }

    this.broadcastRosterUpdate();

    if (
      !this.applyingBotFillPolicy &&
      domain.autoStartWhenFull &&
      this.players.size >= domain.maxPlayers &&
      domain.state === MATCH_STATES.LOBBY
    ) {
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
      state: domain.state,
      botFillMode: domain.botFillMode,
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
  ): any {
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
      assignPlayerSlot: (sid, name, role, team) => this.assignPlayerSlot(sid, name, role, team),
      dispatchSignal: (t, f, p1, p2) => this.host.dispatchSignal(t, f, p1, p2),
      broadcastRosterUpdate: () => this.broadcastRosterUpdate(),
    });
  }

  updatePlayerLoadout(
    sessionId: string,
    visualIdOrPackedParam1: string | number,
    colorSlotOrPackedParam2: number | null = null,
    explicitHitbox: string | number | null = null,
    extraLoadout: Record<string, any> | null = null
  ): MatchPlayerSlot | null {
    const { domain, physicsManager } = this.host;
    const player = this.players.get(sessionId);
    if (!player) return null;

    const packedLoadout = resolveUpdatedPlayerLoadout(
      player,
      sessionId,
      visualIdOrPackedParam1,
      colorSlotOrPackedParam2,
      explicitHitbox,
      extraLoadout
    );

    const canHotSwapNow =
      domain.state === MATCH_STATES.LOBBY ||
      domain.state === MATCH_STATES.PREPARE ||
      domain.state === MATCH_STATES.KICKOFF ||
      domain.isTrainingMode;

    if (canHotSwapNow && physicsManager && player.entityId >= 0) {
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
  ): any {
    const { domain, sessionManager, physicsManager, dataHandler } = this.host;
    return executePlayerRoleOrTeamSwitch({
      sessionId,
      targetRole,
      targetTeam,
      players: this.players,
      spectators: this.spectators,
      roomId: domain.roomId,
      gameMode: domain.gameMode,
      botFillMode: domain.botFillMode,
      clockDuration: domain.clockDuration,
      clockSecondsRemaining: domain.clockSecondsRemaining,
      blueScore: domain.blueScore,
      orangeScore: domain.orangeScore,
      matchTick: domain.matchTick,
      state: domain.state,
      isTrainingMode: domain.isTrainingMode,
      sessionManager,
      physicsManager,
      dataHandler,
      isApplyingBotFillPolicy: () => this.applyingBotFillPolicy,
      setApplyingBotFillPolicy: (v) => {
        this.applyingBotFillPolicy = v;
      },
      removePlayerSession: (sid) => this.removePlayerSession(sid),
      assignPlayerSlot: (sid, name, role, team, loadout) =>
        this.assignPlayerSlot(sid, name, role, team, loadout),
      applyBotFillPolicy: () => this.applyBotFillPolicy(),
      buildRosterSnapshot: () => this.buildRosterSnapshot(),
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
