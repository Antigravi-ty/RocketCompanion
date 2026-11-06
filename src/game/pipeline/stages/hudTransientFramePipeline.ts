/**
 * hudTransientFramePipeline.ts
 * Pure data operator transforming (physicsState, camera, roster) into a HudTransientFramePayload
 * including 6-slot EdgeRosterHudState, 2D pitch mini-map coordinates, and 3D name-tag screen projections.
 */
import * as THREE from 'three';
import { assignTeamSlotKeys } from '../../../replay/container/RCReplayTimelineParser.ts';
import { getExpCarDisplayName } from '../../modes/experimental-multi-bots/ExperimentalMultiBotsMatchMath.ts';

const PITCH_HALF_WIDTH_UU = 4096;
const PITCH_HALF_LENGTH_UU = 5120;
const PITCH_MINIMAP_SPAN_X_PCT = 44;
const PITCH_MINIMAP_SPAN_Y_PCT = 43.5;
const UU_PER_SECOND_TO_KPH = 0.036;

export interface CarHudTelemetry {
  boostAmount: number;
  isDemolished: boolean;
  demoRespawnRemainingSec: number;
  demolishedAtMs: number;
}

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

export interface HudRosterSourceContext {
  matchMode: string;
  isReplayViewerLoaded: boolean;
  replayViewerState?: string;
  replayViewerActivePovTeam?: number;
  replayViewerLocalTeam?: number;
  replayViewerActivePovCarIndex?: number;
  replayViewerResolvedRoster?: ReadonlyArray<any>;
  expPlayerParticipation?: string;
  expSpawnedCars?: ReadonlyArray<any>;
  rawRosterSnapshot?: any;
  replayTimelineCarEntries?: ReadonlyArray<any>;
  connectedPeers?: ReadonlyArray<any>;
  localPeerId?: string | null;
  localCarIdx?: number;
  participantTeams?: ReadonlyMap<number, number> | null;
  arenaCarTeams?: ArrayLike<number> | null;
  localPlayerName?: string;
  carNamesByIndex?: ReadonlyMap<number, string> | null;
  activeBotName?: string;
  numCars?: number;
}

export interface HudTransientPhysicsStateInput {
  ballPosX?: number;
  ballPosY?: number;
  ballPosZ?: number;
  ballVelX?: number;
  ballVelY?: number;
  ballVelZ?: number;
  carPositions?: ReadonlyArray<{
    carIndex: number;
    posX: number;
    posY: number;
    posZ: number;
  }>;
  resolveCarTelemetry: (carIndex: number) => CarHudTelemetry;
}

export interface HudTransientCameraInput {
  activeCameraCar: number;
  replayCameraMode?: string;
  perspectiveCamera?: THREE.Camera | null;
  viewportWidthPx?: number;
  viewportHeightPx?: number;
}

export interface HudTransientRosterInput {
  blueEntries: readonly RosterTeamEntry[];
  orangeEntries: readonly RosterTeamEntry[];
  detectedLocalTeam: number | null;
  isSpectatingNoHuman: boolean;
  choreographySignal?: string;
  matchPhase?: string;
  localSkipReplayReady?: boolean;
  acknowledgedJumpByCar?: ReadonlyMap<number, boolean>;
}

export interface HudTransientPlayerSlotPayload {
  slotKey: number;
  carIndex?: number;
  team: 'left' | 'right';
  name: string;
  boostAmount: number;
  exists: boolean;
  isSelf: boolean;
  isFocusedPov: boolean;
  isDemolished: boolean;
  demoRespawnRemainingSec: number;
  demoRespawnTotalSec: number;
  demolishedAtMs: number;
  replaySkipReady: boolean;
}

export interface HudTransientMiniMapPayload {
  ballX: number;
  ballY: number;
  ballNormX: number;
  ballNormY: number;
  ballHitKph: number;
  isFlipped: boolean;
}

export interface HudTransientNameTagProjection2D {
  carIndex: number;
  screenX: number;
  screenY: number;
  ndcZ: number;
  visible: boolean;
}

export interface HudTransientFramePayload {
  localTeam: 0 | 1;
  slotKeyToCarIndex: Record<number, number>;
  rosterPatch: {
    viewMode: 'player-live' | 'goal-replay' | 'spectator';
    focusedSlotKey: number | null;
    leftPlayers: HudTransientPlayerSlotPayload[];
    rightPlayers: HudTransientPlayerSlotPayload[];
  };
  miniMap: HudTransientMiniMapPayload;
  nameTagProjections: HudTransientNameTagProjection2D[];
}

const _scratchProjVec = new THREE.Vector3();

export function resolveModeRosterEntries(
  source: HudRosterSourceContext,
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
      if (c.team === 1) {
        orangeEntries.push(item);
      } else {
        blueEntries.push(item);
      }
    }
  } else if (source.matchMode === 'exp-multi-bots') {
    const rawCars = source.expSpawnedCars || [];
    isSpectatingNoHuman = source.expPlayerParticipation === 'none';
    if (source.expPlayerParticipation === 'orange') {
      detectedLocalTeam = 1;
    } else if (source.expPlayerParticipation === 'blue') {
      detectedLocalTeam = 0;
    }

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
      if (isSelf) {
        detectedLocalTeam = c.team === 1 ? 1 : 0;
      }
      const item: RosterTeamEntry = {
        carIndex: c.carIndex,
        name: c.name || defaultName,
        isSelf,
        isBot: !c.isPlayer,
      };
      if (c.team === 1) {
        orangeEntries.push(item);
      } else {
        blueEntries.push(item);
      }
    }
  } else if (source.matchMode === 'match' || source.matchMode === 'online-warmup') {
    const rawRoster = source.rawRosterSnapshot;
    const rosterSnap = Array.isArray(rawRoster?.players)
      ? rawRoster.players
      : Array.isArray(rawRoster)
        ? rawRoster
        : Array.isArray(source.replayTimelineCarEntries)
          ? source.replayTimelineCarEntries
          : [];
    const peers = source.connectedPeers || [];
    const localPeerId = source.localPeerId;
    const localCarIdx = source.localCarIdx ?? 0;

    if (rosterSnap.length > 0) {
      const sortedRoster = [...rosterSnap].sort((a: any, b: any) => {
        const ca = typeof a?.carIndex === 'number' ? a.carIndex : (a?.entityId ?? 0);
        const cb = typeof b?.carIndex === 'number' ? b.carIndex : (b?.entityId ?? 0);
        return ca - cb;
      });
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
            cIdx === localCarIdx,
        );
        if (isSelf) {
          detectedLocalTeam = isOrange ? 1 : 0;
        }
        const isBot = Boolean(
          p.isBot ||
            p.botType ||
            String(p.peerId || p.sessionId || '').startsWith('bot'),
        );
        const item: RosterTeamEntry = {
          carIndex: cIdx,
          name: p.username || p.name || p.playerName || `Player ${cIdx + 1}`,
          isSelf,
          isBot,
        };
        if (isOrange) {
          orangeEntries.push(item);
        } else {
          blueEntries.push(item);
        }
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
          p.isSelf || (localPeerId && p.id === localPeerId) || cIdx === localCarIdx,
        );
        const isOrange =
          p.team === 1 ||
          p.team === 'orange' ||
          (p.team === undefined &&
            (source.participantTeams?.get?.(cIdx) ?? cIdx % 2) === 1);
        combinedByCar.set(cIdx, {
          carIndex: cIdx,
          name:
            p.name ||
            p.username ||
            source.carNamesByIndex?.get?.(cIdx) ||
            `Player ${cIdx + 1}`,
          team: isOrange ? 1 : 0,
          isSelf,
          isBot: Boolean(p.isBot || p.botType),
        });
      }

      if (source.participantTeams instanceof Map) {
        for (const [cIdx, tVal] of source.participantTeams.entries()) {
          if (
            typeof cIdx === 'number' &&
            cIdx >= 0 &&
            cIdx < 8 &&
            !combinedByCar.has(cIdx)
          ) {
            const cName =
              source.carNamesByIndex?.get?.(cIdx) || `Player ${cIdx + 1}`;
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
        (a, b) => a.carIndex - b.carIndex,
      );
      for (const entry of orderedEntries) {
        if (entry.isSelf) {
          detectedLocalTeam = entry.team === 1 ? 1 : 0;
        }
        const item: RosterTeamEntry = {
          carIndex: entry.carIndex,
          name: entry.name,
          isSelf: entry.isSelf,
          isBot: Boolean(entry.isBot),
        };
        if (entry.team === 1) {
          orangeEntries.push(item);
        } else {
          blueEntries.push(item);
        }
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

  return {
    blueEntries,
    orangeEntries,
    isSpectatingNoHuman,
    detectedLocalTeam,
  };
}

export function computeMiniMapCoordinates(
  ballPosX = 0,
  ballPosY = 0,
  ballVelX = 0,
  ballVelY = 0,
  ballVelZ = 0,
  localTeam: 0 | 1 = 0,
): HudTransientMiniMapPayload {
  const clampedX = Math.max(-PITCH_HALF_WIDTH_UU, Math.min(PITCH_HALF_WIDTH_UU, ballPosX));
  const clampedY = Math.max(-PITCH_HALF_LENGTH_UU, Math.min(PITCH_HALF_LENGTH_UU, ballPosY));
  const ballX = 50 + (clampedX / PITCH_HALF_WIDTH_UU) * PITCH_MINIMAP_SPAN_X_PCT;
  const ballY = 50 - (clampedY / PITCH_HALF_LENGTH_UU) * PITCH_MINIMAP_SPAN_Y_PCT;
  const ballSpeedUu = Math.hypot(ballVelX, ballVelY, ballVelZ);
  const ballHitKph = Math.round(ballSpeedUu * UU_PER_SECOND_TO_KPH);

  return {
    ballX,
    ballY,
    ballNormX: ballX / 100,
    ballNormY: ballY / 100,
    ballHitKph,
    isFlipped: localTeam === 1,
  };
}

export function projectNameTagScreenPositions(
  carPositions: ReadonlyArray<{ carIndex: number; posX: number; posY: number; posZ: number }> | undefined,
  perspectiveCamera: THREE.Camera | null | undefined,
  viewportWidthPx = 1920,
  viewportHeightPx = 1080,
): HudTransientNameTagProjection2D[] {
  if (!carPositions || carPositions.length === 0 || !perspectiveCamera) {
    return [];
  }
  const projections: HudTransientNameTagProjection2D[] = [];
  for (const car of carPositions) {
    _scratchProjVec.set(car.posX, car.posZ, car.posY).project(perspectiveCamera);
    const visible = _scratchProjVec.z >= -1 && _scratchProjVec.z <= 1;
    projections.push({
      carIndex: car.carIndex,
      screenX: (_scratchProjVec.x * 0.5 + 0.5) * viewportWidthPx,
      screenY: (-_scratchProjVec.y * 0.5 + 0.5) * viewportHeightPx,
      ndcZ: _scratchProjVec.z,
      visible,
    });
  }
  return projections;
}

export function buildHudTransientFramePayload(
  physicsState: HudTransientPhysicsStateInput,
  camera: HudTransientCameraInput,
  roster: HudTransientRosterInput,
): HudTransientFramePayload {
  const { blueEntries, orangeEntries, detectedLocalTeam, isSpectatingNoHuman } = roster;
  const localInOrange = orangeEntries.some((e) => e.isSelf);
  const localInBlue = blueEntries.some((e) => e.isSelf);
  const localTeam: 0 | 1 =
    detectedLocalTeam === 1 || localInOrange
      ? 1
      : detectedLocalTeam === 0 || localInBlue
        ? 0
        : 0;

  const leftEntries = localTeam === 1 ? orangeEntries : blueEntries;
  const rightEntries = localTeam === 1 ? blueEntries : orangeEntries;
  const leftLabelPrefix = localTeam === 1 ? 'Orange' : 'Blue';
  const rightLabelPrefix = localTeam === 1 ? 'Blue' : 'Orange';

  const { rightStartKey, leftSlotKeys, rightSlotKeys, slotKeyToCarIndex } =
    assignTeamSlotKeys([...leftEntries], [...rightEntries]);

  const sig = roster.choreographySignal || 'kickoff-will-start';
  const isGoalReplayView =
    sig === 'goal-replay-started' ||
    sig === 'goal-replay-will-end' ||
    roster.matchPhase === 'replay';

  const viewMode: 'player-live' | 'goal-replay' | 'spectator' = isGoalReplayView
    ? 'goal-replay'
    : isSpectatingNoHuman
      ? 'spectator'
      : 'player-live';

  const activeCameraCar = camera.activeCameraCar;
  let focusedSlotKey: number | null = null;

  const buildSideSlot = (
    idx: number,
    side: 'left' | 'right',
    slotKeyRaw: number,
    labelPrefix: string,
    entry: RosterTeamEntry | undefined,
  ): HudTransientPlayerSlotPayload => {
    const slotKey = Math.min(6, Math.max(1, slotKeyRaw));
    if (!entry) {
      return {
        slotKey,
        team: side,
        name: `${labelPrefix} #${slotKey}`,
        boostAmount: 0,
        exists: false,
        isSelf: false,
        isFocusedPov: false,
        isDemolished: false,
        demoRespawnRemainingSec: 0,
        demoRespawnTotalSec: 3.0,
        demolishedAtMs: 0,
        replaySkipReady: false,
      };
    }

    const tel = physicsState.resolveCarTelemetry(entry.carIndex);
    const isFocused =
      isGoalReplayView && camera.replayCameraMode === 'director'
        ? false
        : viewMode === 'player-live'
          ? Boolean(entry.isSelf || entry.carIndex === activeCameraCar)
          : entry.carIndex === activeCameraCar;
    if (isFocused) {
      focusedSlotKey = slotKey;
    }

    const replaySkipReady = isGoalReplayView
      ? Boolean(
          entry.isBot ||
            (entry.isSelf && roster.localSkipReplayReady) ||
            roster.acknowledgedJumpByCar?.get(entry.carIndex),
        )
      : false;

    return {
      slotKey,
      carIndex: entry.carIndex,
      team: side,
      name: entry.name,
      boostAmount: tel.boostAmount,
      exists: true,
      isSelf: entry.isSelf,
      isFocusedPov: isFocused,
      isDemolished: tel.isDemolished,
      demoRespawnRemainingSec: tel.demoRespawnRemainingSec,
      demoRespawnTotalSec: 3.0,
      demolishedAtMs: tel.demolishedAtMs,
      replaySkipReady,
    };
  };

  const leftPlayers = [0, 1, 2, 3, 4].map((idx) =>
    buildSideSlot(idx, 'left', leftSlotKeys[idx] ?? idx + 1, leftLabelPrefix, leftEntries[idx]),
  );

  const rightPlayers = [0, 1, 2, 3, 4].map((idx) =>
    buildSideSlot(
      idx,
      'right',
      rightSlotKeys[idx] ?? rightStartKey + idx,
      rightLabelPrefix,
      rightEntries[idx],
    ),
  );

  const miniMap = computeMiniMapCoordinates(
    physicsState.ballPosX ?? 0,
    physicsState.ballPosY ?? 0,
    physicsState.ballVelX ?? 0,
    physicsState.ballVelY ?? 0,
    physicsState.ballVelZ ?? 0,
    localTeam,
  );

  const nameTagProjections = projectNameTagScreenPositions(
    physicsState.carPositions,
    camera.perspectiveCamera,
    camera.viewportWidthPx,
    camera.viewportHeightPx,
  );

  return {
    localTeam,
    slotKeyToCarIndex,
    rosterPatch: {
      viewMode,
      focusedSlotKey,
      leftPlayers,
      rightPlayers,
    },
    miniMap,
    nameTagProjections,
  };
}
