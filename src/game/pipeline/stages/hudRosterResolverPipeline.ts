export interface RosterTeamEntry {
  carIndex: number;
  name: string;
  isSelf: boolean;
  isBot?: boolean;
}

export interface ResolvedModeRosterEntries {
  blueEntries: RosterTeamEntry[];
  orangeEntries: RosterTeamEntry[];
  isSpectatingNoHuman: boolean;
  detectedLocalTeam: number | null;
}

export interface ReplayViewerRosterEntryInput {
  carIndex: number;
  name?: string;
  isSelf?: boolean;
  team?: number;
}

export interface ExpSpawnedCarRosterInput {
  carIndex: number;
  isPlayer?: boolean;
  botType?: string;
  keyNumber?: number;
  name?: string;
  team?: number;
}

export interface RawRosterPlayerInput {
  carIndex?: number;
  entityId?: number;
  team?: number | string;
  role?: string;
  isLocal?: boolean;
  isLocalPlayer?: boolean;
  peerId?: string;
  sessionId?: string;
  isBot?: boolean;
  botType?: string;
  username?: string;
  name?: string;
  playerName?: string;
}

export interface ConnectedPeerRosterInput {
  id?: string;
  carIndex?: number;
  entityId?: number;
  team?: number | string;
  role?: string;
  isSelf?: boolean;
  name?: string;
  username?: string;
  isBot?: boolean;
  botType?: string;
}

export interface HudRosterSourceContext {
  matchMode: string;
  isReplayViewerLoaded: boolean;
  replayViewerState?: string;
  replayViewerActivePovTeam?: number;
  replayViewerLocalTeam?: number;
  replayViewerActivePovCarIndex?: number;
  replayViewerResolvedRoster?: ReadonlyArray<ReplayViewerRosterEntryInput>;
  expPlayerParticipation?: string;
  expSpawnedCars?: ReadonlyArray<ExpSpawnedCarRosterInput>;
  rawRosterSnapshot?:
    ReadonlyArray<RawRosterPlayerInput> | { players?: ReadonlyArray<RawRosterPlayerInput> } | null;
  replayTimelineCarEntries?: ReadonlyArray<RawRosterPlayerInput>;
  connectedPeers?: ReadonlyArray<ConnectedPeerRosterInput>;
  localPeerId?: string | null;
  localCarIdx?: number;
  participantTeams?: ReadonlyMap<number, number> | null;
  arenaCarTeams?: ArrayLike<number> | null;
  localPlayerName?: string;
  carNamesByIndex?: ReadonlyMap<number, string> | null;
  activeBotName?: string;
  numCars?: number;
}

export function resolveModeRosterEntries(
  source: HudRosterSourceContext
): ResolvedModeRosterEntries {
  const blueEntries: RosterTeamEntry[] = [];
  const orangeEntries: RosterTeamEntry[] = [];
  let isSpectatingNoHuman = false;
  let detectedLocalTeam: number | null = null;

  if (source.isReplayViewerLoaded) {
    const viewerState = source.replayViewerState;
    const isReplayViewerIntervening =
      viewerState === 'preroll-countdown' || viewerState === 'intervening';
    isSpectatingNoHuman = !isReplayViewerIntervening;
    detectedLocalTeam = isReplayViewerIntervening
      ? (source.replayViewerActivePovTeam ?? source.replayViewerLocalTeam ?? 0)
      : (source.replayViewerLocalTeam ?? 0);
    const roster = Array.isArray(source.replayViewerResolvedRoster)
      ? source.replayViewerResolvedRoster
      : [];
    for (const c of roster) {
      const item: RosterTeamEntry = {
        carIndex: c.carIndex,
        name: c.name || `Car ${c.carIndex + 1}`,
        isSelf: isReplayViewerIntervening
          ? c.carIndex === source.replayViewerActivePovCarIndex
          : Boolean(c.isSelf),
      };
      if (c.team === 1) orangeEntries.push(item);
      else blueEntries.push(item);
    }
  } else if (source.matchMode === 'exp-multi-bots') {
    const rawCars = source.expSpawnedCars || [];
    isSpectatingNoHuman = source.expPlayerParticipation === 'none';
    if (source.expPlayerParticipation === 'orange') detectedLocalTeam = 1;
    else if (source.expPlayerParticipation === 'blue') detectedLocalTeam = 0;

    const sameBotCounts: Record<string, number> = {};
    for (const c of rawCars) {
      if (!c.isPlayer) {
        const bt = String(c.botType || 'necto').toLowerCase();
        sameBotCounts[bt] = (sameBotCounts[bt] || 0) + 1;
      }
    }

    for (const c of rawCars) {
      const bt = String(c.botType || 'necto');
      const capBot = bt.charAt(0).toUpperCase() + bt.slice(1).toLowerCase();
      const defaultName = c.isPlayer
        ? 'Player'
        : (sameBotCounts[bt.toLowerCase()] || 0) > 1
          ? `${capBot} #${c.keyNumber || c.carIndex + 1}`
          : capBot;
      const isSelf = Boolean(c.isPlayer);
      if (isSelf) detectedLocalTeam = c.team === 1 ? 1 : 0;
      const item: RosterTeamEntry = {
        carIndex: c.carIndex,
        name: c.name || defaultName,
        isSelf,
        isBot: !c.isPlayer,
      };
      if (c.team === 1) orangeEntries.push(item);
      else blueEntries.push(item);
    }
  } else if (source.matchMode === 'match' || source.matchMode === 'online-warmup') {
    const rawRoster = source.rawRosterSnapshot;
    const rawPlayers =
      rawRoster && !Array.isArray(rawRoster) && 'players' in rawRoster
        ? rawRoster.players
        : undefined;
    const rosterSnap: ReadonlyArray<RawRosterPlayerInput> = Array.isArray(rawPlayers)
      ? rawPlayers
      : Array.isArray(rawRoster)
        ? rawRoster
        : Array.isArray(source.replayTimelineCarEntries)
          ? source.replayTimelineCarEntries
          : [];
    const peers = source.connectedPeers || [];
    const localPeerId = source.localPeerId;
    const localCarIdx = source.localCarIdx ?? 0;

    if (rosterSnap.length > 0) {
      const sortedRoster = [...rosterSnap].sort(
        (a: RawRosterPlayerInput, b: RawRosterPlayerInput) => {
          const ca = typeof a?.carIndex === 'number' ? a.carIndex : (a?.entityId ?? 0);
          const cb = typeof b?.carIndex === 'number' ? b.carIndex : (b?.entityId ?? 0);
          return ca - cb;
        }
      );
      for (const p of sortedRoster) {
        const cIdx =
          typeof p?.carIndex === 'number'
            ? p.carIndex
            : typeof p?.entityId === 'number'
              ? p.entityId
              : -1;
        if (p.team === 'spectator' || p.role === 'spectator' || cIdx < 0) continue;
        const isOrange = p.team === 1 || p.team === 'orange';
        const isSelf = Boolean(
          p.isLocal ||
          p.isLocalPlayer ||
          (localPeerId && (p.peerId === localPeerId || p.sessionId === localPeerId)) ||
          cIdx === localCarIdx
        );
        if (isSelf) detectedLocalTeam = isOrange ? 1 : 0;
        const isBot = Boolean(
          p.isBot || p.botType || String(p.peerId || p.sessionId || '').startsWith('bot')
        );
        const item: RosterTeamEntry = {
          carIndex: cIdx,
          name: p.username || p.name || p.playerName || `Player ${cIdx + 1}`,
          isSelf,
          isBot,
        };
        if (isOrange) orangeEntries.push(item);
        else blueEntries.push(item);
      }
    } else if (
      peers.length > 0 ||
      (source.participantTeams instanceof Map && source.participantTeams.size > 0)
    ) {
      const combinedByCar = new Map<number, RosterTeamEntry & { team: number }>();
      const selfTeam =
        source.participantTeams?.get?.(localCarIdx) ??
        source.arenaCarTeams?.[localCarIdx] ??
        localCarIdx % 2;
      const selfName =
        source.localPlayerName ||
        source.carNamesByIndex?.get?.(localCarIdx) ||
        `Player ${localCarIdx + 1}`;
      combinedByCar.set(localCarIdx, {
        carIndex: localCarIdx,
        name: selfName,
        team: selfTeam === 1 || (selfTeam as unknown) === 'orange' ? 1 : 0,
        isSelf: true,
        isBot: false,
      });

      let fallbackIdx = 0;
      for (const p of peers) {
        if (p.team === 'spectator' || p.role === 'spectator') continue;
        const cIdx =
          typeof p.carIndex === 'number'
            ? p.carIndex
            : typeof p.entityId === 'number'
              ? p.entityId
              : fallbackIdx++;
        const isSelf = Boolean(
          p.isSelf || (localPeerId && p.id === localPeerId) || cIdx === localCarIdx
        );
        const isOrange =
          p.team === 1 ||
          p.team === 'orange' ||
          (p.team === undefined && (source.participantTeams?.get?.(cIdx) ?? cIdx % 2) === 1);
        combinedByCar.set(cIdx, {
          carIndex: cIdx,
          name: p.name || p.username || source.carNamesByIndex?.get?.(cIdx) || `Player ${cIdx + 1}`,
          team: isOrange ? 1 : 0,
          isSelf,
          isBot: Boolean(p.isBot || p.botType),
        });
      }

      if (source.participantTeams instanceof Map) {
        for (const [cIdx, tVal] of source.participantTeams.entries()) {
          if (typeof cIdx === 'number' && cIdx >= 0 && cIdx < 8 && !combinedByCar.has(cIdx)) {
            const cName = source.carNamesByIndex?.get?.(cIdx) || `Player ${cIdx + 1}`;
            combinedByCar.set(cIdx, {
              carIndex: cIdx,
              name: cName,
              team: tVal === 1 ? 1 : 0,
              isSelf: cIdx === localCarIdx,
              isBot: /^(necto|nexto|bot\b)/i.test(String(cName)),
            });
          }
        }
      }

      const orderedEntries = Array.from(combinedByCar.values()).sort(
        (a, b) => a.carIndex - b.carIndex
      );
      for (const entry of orderedEntries) {
        if (entry.isSelf) detectedLocalTeam = entry.team === 1 ? 1 : 0;
        const item: RosterTeamEntry = {
          carIndex: entry.carIndex,
          name: entry.name,
          isSelf: entry.isSelf,
          isBot: Boolean(entry.isBot),
        };
        if (entry.team === 1) orangeEntries.push(item);
        else blueEntries.push(item);
      }
    } else {
      const botNameRaw = String(source.activeBotName || 'Necto');
      const botDisplay = botNameRaw.charAt(0).toUpperCase() + botNameRaw.slice(1);
      const selfName = source.localPlayerName || 'Player';
      blueEntries.push({ carIndex: 0, name: selfName, isSelf: true, isBot: false });
      detectedLocalTeam = 0;
      if ((source.numCars ?? 2) >= 2) {
        orangeEntries.push({ carIndex: 1, name: botDisplay, isSelf: false, isBot: true });
      }
    }
  } else if (source.matchMode === 'dev-test-lab') {
    const numCars = source.numCars ?? 1;
    blueEntries.push({ carIndex: 0, name: 'Player', isSelf: true, isBot: false });
    detectedLocalTeam = 0;
    if (numCars >= 2) {
      orangeEntries.push({ carIndex: 1, name: 'Bot', isSelf: false, isBot: true });
    }
  }

  return { blueEntries, orangeEntries, isSpectatingNoHuman, detectedLocalTeam };
}
