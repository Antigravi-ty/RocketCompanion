/**
 * RLRCRCReplayV2PayloadPipeline.ts
 * Pure data pipeline mapping between RLRC 120Hz container packets (Header, Roster, Bookmarks, Track 0)
 * and standard RCREPLAY V2 multi-track binary container payloads (Track A State+Input, Track B Incidents, Track C Signals).
 */

import { INCIDENT_EVENT_TYPES } from '../../../physics/RocketSimConstants.ts';
import { unfilterAndUntransposeStateInputTrack } from '../../container/RCReplayBinaryDecoder.ts';
import {
  decodeIncidentFrom64Bytes,
  decodeSignalFrom64Bytes,
  encodeIncidentTo64Bytes,
  encodeSignalTo64Bytes,
  RC_REPLAY_EVENT_STRIDE,
} from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_TICK_RATE,
  RLRC_TRACK0_FRAME_STRIDE_BYTES,
  type RLRCBookmarkRecord,
  type RLRCContainerPacket,
  type RLRCPlayerSlotMeta,
  type RLRCReplayHeaderMeta,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';

export interface RLRCReplayV2ExportPayload {
  readonly mode: string;
  readonly arenaPreset: number;
  readonly tickRate: number;
  readonly frameCount: number;
  readonly durationSec: number;
  readonly durationSeconds: number;
  readonly winner: 'blue' | 'orange' | 'draw';
  readonly blueScore: number;
  readonly orangeScore: number;
  readonly winReason: number;
  readonly createdAtIso: string;
  readonly roster: ReadonlyArray<Record<string, unknown>>;
  readonly loadouts: ReadonlyArray<Record<string, unknown>>;
  readonly directorReplayMeta: {
    readonly rlrcHeader: RLRCReplayHeaderMeta;
    readonly rlrcBookmarks: readonly RLRCBookmarkRecord[];
  };
  readonly stateInputBytes: Uint8Array;
  readonly incidentBytes: Uint8Array;
  readonly signalBytes: Uint8Array;
}

export interface DecodedRCREPLAYV2TracksForRLRC {
  readonly header: RLRCReplayHeaderMeta;
  readonly roster: readonly RLRCPlayerSlotMeta[];
  readonly bookmarks: readonly RLRCBookmarkRecord[];
  readonly stateInputTrackBytes: Uint8Array;
}

export function mapRLRCPacketToRCReplayV2Payload(
  packet: RLRCContainerPacket
): RLRCReplayV2ExportPayload {
  const frameCount = Math.floor(
    packet.stateInputTrackBytes.byteLength / RLRC_TRACK0_FRAME_STRIDE_BYTES
  );

  const incidentBookmarks = packet.bookmarks.filter(
    (b) => b.kind === 'goal' || b.kind === 'demolish'
  );
  const incidentBytes = new Uint8Array(incidentBookmarks.length * RC_REPLAY_EVENT_STRIDE);
  for (let i = 0; i < incidentBookmarks.length; i++) {
    const bm = incidentBookmarks[i];
    const fIdx = Math.max(0, Math.trunc(bm.frameIndex120Hz));
    const carIdx = Math.max(0, bm.slotIndex);
    const teamIdx = bm.team === 1 ? 1 : 0;
    encodeIncidentTo64Bytes(
      {
        type:
          bm.kind === 'goal' ? INCIDENT_EVENT_TYPES.GOAL_SCORED : INCIDENT_EVENT_TYPES.CAR_CAR_DEMO,
        tick: fIdx,
        frameIndex: fIdx,
        carIndex: carIdx,
        primaryId: carIdx,
        team: teamIdx,
        secondaryId: teamIdx,
      },
      incidentBytes,
      i * RC_REPLAY_EVENT_STRIDE,
      fIdx
    );
  }

  const signalBookmarks = packet.bookmarks.filter(
    (b) => b.kind === 'user-mark' || b.kind === 'kickoff' || b.kind === 'ue-keyframe'
  );
  const signalBytes = new Uint8Array(signalBookmarks.length * RC_REPLAY_EVENT_STRIDE);
  for (let i = 0; i < signalBookmarks.length; i++) {
    const bm = signalBookmarks[i];
    const fIdx = Math.max(0, Math.trunc(bm.frameIndex120Hz));
    const sigType = bm.kind === 'user-mark' ? 0x91 : 0x87;
    encodeSignalTo64Bytes(
      {
        signalId: i + 1,
        signalType: sigType,
        type: sigType,
        frameId: fIdx,
        tick: fIdx,
        frameIndex: fIdx,
        param1: Math.max(0, Math.trunc(bm.sourceFrame30Hz)),
        param2: Math.max(0, bm.slotIndex),
      },
      signalBytes,
      i * RC_REPLAY_EVENT_STRIDE,
      fIdx
    );
  }

  const roster = packet.roster.map((r) => ({
    ...r,
    carIndex: r.slotIndex,
    entityId: r.slotIndex,
    name: r.userName,
    username: r.userName,
    colorHex: r.primaryColorHex,
    isSelf: r.slotIndex === 0,
    isPlayer: r.slotIndex === 0,
  }));

  const blueScore = packet.header.blueScore ?? 0;
  const orangeScore = packet.header.orangeScore ?? 0;
  const winner = blueScore > orangeScore ? 'blue' : orangeScore > blueScore ? 'orange' : 'draw';
  const durationSec = Number((frameCount / RLRC_TICK_RATE).toFixed(2));
  const durationSeconds = Math.max(
    1,
    Math.round(packet.header.durationSeconds || durationSec || 300)
  );

  return {
    mode: 'match',
    arenaPreset: 0,
    tickRate: RLRC_TICK_RATE,
    frameCount,
    durationSec,
    durationSeconds,
    winner,
    blueScore,
    orangeScore,
    winReason: 0,
    createdAtIso: packet.header.date || new Date().toISOString(),
    roster,
    loadouts: roster,
    directorReplayMeta: {
      rlrcHeader: packet.header,
      rlrcBookmarks: packet.bookmarks,
    },
    stateInputBytes: packet.stateInputTrackBytes,
    incidentBytes,
    signalBytes,
  };
}

export function extractRLRCTracksFromRCReplayV2Bytes(
  u8: Uint8Array
): DecodedRCREPLAYV2TracksForRLRC {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const metaLength = dv.getUint32(12, true);
  if (16 + metaLength > u8.byteLength) {
    throw new Error('Corrupt RCREPLAY V2 metadata JSON length.');
  }

  const envelope = JSON.parse(new TextDecoder().decode(u8.subarray(16, 16 + metaLength))) as {
    matchInfo?: Record<string, unknown>;
    tracks?: {
      stateInput?: {
        offset: number;
        byteLength: number;
        count: number;
        stride?: number;
        encoding?: string;
      };
      incidents?: { offset: number; byteLength: number; count: number };
      signals?: { offset: number; byteLength: number; count: number };
    };
  };

  const matchInfo = envelope.matchInfo ?? {};
  const tracks = envelope.tracks ?? {};
  const stateToc = tracks.stateInput ?? { offset: 0, byteLength: 0, count: 0 };
  const frameCount = Number(stateToc.count ?? matchInfo.frameCount ?? 0);
  const stateStride = Number(stateToc.stride || RLRC_TRACK0_FRAME_STRIDE_BYTES);
  const rawTrackA =
    frameCount > 0 && stateToc.byteLength > 0
      ? u8.subarray(stateToc.offset, stateToc.offset + stateToc.byteLength)
      : new Uint8Array(0);

  const stateInputTrackBytes =
    stateToc.encoding === 'xor-delta-bytetran-v1'
      ? unfilterAndUntransposeStateInputTrack(rawTrackA, frameCount, stateStride)
      : u8.slice(stateToc.offset, stateToc.offset + stateToc.byteLength);

  const directorMeta = (matchInfo.directorReplayMeta ?? {}) as {
    rlrcHeader?: RLRCReplayHeaderMeta;
    rlrcBookmarks?: readonly RLRCBookmarkRecord[];
  };

  const rawRoster = Array.isArray(matchInfo.roster) ? matchInfo.roster : [];
  const roster: RLRCPlayerSlotMeta[] = rawRoster.map(
    (entry: Record<string, unknown>, idx: number) => {
      const slotIndex =
        typeof entry.slotIndex === 'number'
          ? entry.slotIndex
          : typeof entry.carIndex === 'number'
            ? entry.carIndex
            : idx;
      const team: RLRCTeamIndex = entry.team === 1 || entry.team === 'orange' ? 1 : 0;
      const primaryColor = entry.primaryColorHex ?? entry.colorHex;
      return {
        slotIndex,
        userName: String(
          entry.userName ?? entry.name ?? entry.username ?? `Player ${slotIndex + 1}`
        ),
        team,
        priActorId: typeof entry.priActorId === 'number' ? entry.priActorId : slotIndex + 1,
        bodyProductId: typeof entry.bodyProductId === 'number' ? entry.bodyProductId : 23,
        hitboxId: (typeof entry.hitboxId === 'string'
          ? entry.hitboxId
          : 'hitbox-octane') as RLRCPlayerSlotMeta['hitboxId'],
        visualId: (typeof entry.visualId === 'string'
          ? entry.visualId
          : 'fennec') as RLRCPlayerSlotMeta['visualId'],
        ...(typeof primaryColor === 'string' ? { primaryColorHex: primaryColor } : {}),
        ...(typeof entry.accentColorHex === 'string'
          ? { accentColorHex: entry.accentColorHex }
          : {}),
        ...(entry.cameraSettings && typeof entry.cameraSettings === 'object'
          ? { cameraSettings: entry.cameraSettings as RLRCPlayerSlotMeta['cameraSettings'] }
          : {}),
      };
    }
  );

  const header: RLRCReplayHeaderMeta = directorMeta.rlrcHeader ?? {
    replayId: String(matchInfo.replayId ?? 'RCREPLAY-V2'),
    replayName: String(matchInfo.mode ?? 'match'),
    mapName: 'Stadium_P',
    matchType: String(matchInfo.mode ?? 'match'),
    teamSize: Math.max(1, Math.ceil(Math.max(2, roster.length) / 2)),
    recordFps: 30,
    sourceFrameCount: Math.ceil(frameCount / 4),
    frameCount120Hz: frameCount,
    durationSeconds: Number(
      matchInfo.durationSeconds ?? matchInfo.durationSec ?? frameCount / RLRC_TICK_RATE
    ),
    date: String(matchInfo.createdAtIso ?? ''),
    blueScore: Number(matchInfo.blueScore ?? 0),
    orangeScore: Number(matchInfo.orangeScore ?? 0),
    part1CrcValid: true,
    part2CrcValid: true,
  };

  const bookmarks: RLRCBookmarkRecord[] = Array.isArray(directorMeta.rlrcBookmarks)
    ? [...directorMeta.rlrcBookmarks]
    : [];
  if (!Array.isArray(directorMeta.rlrcBookmarks)) {
    const incToc = tracks.incidents;
    if (incToc && incToc.count > 0 && incToc.byteLength > 0) {
      const incSlice = u8.subarray(incToc.offset, incToc.offset + incToc.byteLength);
      for (let i = 0; i < incToc.count; i++) {
        const inc = decodeIncidentFrom64Bytes(incSlice, i * RC_REPLAY_EVENT_STRIDE);
        if (
          inc.type === INCIDENT_EVENT_TYPES.GOAL_SCORED ||
          inc.type === INCIDENT_EVENT_TYPES.CAR_CAR_DEMO
        ) {
          const fIdx = Math.max(0, inc.frameIndex || inc.tick || 0);
          bookmarks.push({
            kind: inc.type === INCIDENT_EVENT_TYPES.GOAL_SCORED ? 'goal' : 'demolish',
            frameIndex120Hz: fIdx,
            sourceFrame30Hz: Math.floor(fIdx / 4),
            timeSeconds: fIdx / RLRC_TICK_RATE,
            slotIndex: inc.carIndex ?? 0,
            team: inc.team === 1 ? 1 : 0,
            label: inc.type === INCIDENT_EVENT_TYPES.GOAL_SCORED ? 'Goal' : 'Demolish',
          });
        }
      }
    }
    const sigToc = tracks.signals;
    if (sigToc && sigToc.count > 0 && sigToc.byteLength > 0) {
      const sigSlice = u8.subarray(sigToc.offset, sigToc.offset + sigToc.byteLength);
      for (let i = 0; i < sigToc.count; i++) {
        const sig = decodeSignalFrom64Bytes(sigSlice, i * RC_REPLAY_EVENT_STRIDE);
        const fIdx = Math.max(0, sig.frameIndex || sig.tick || 0);
        bookmarks.push({
          kind: sig.signalType === 0x91 ? 'user-mark' : 'kickoff',
          frameIndex120Hz: fIdx,
          sourceFrame30Hz: sig.param1 || Math.floor(fIdx / 4),
          timeSeconds: fIdx / RLRC_TICK_RATE,
          slotIndex: sig.param2 ?? -1,
          team: -1,
          label: sig.signalType === 0x91 ? 'Bookmark' : 'Kickoff',
        });
      }
    }
  }

  return {
    header,
    roster,
    bookmarks,
    stateInputTrackBytes,
  };
}
