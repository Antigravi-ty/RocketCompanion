/**
 * RLRCRCReplayV2PayloadPipeline.ts
 * Maps RLRC 120Hz container packets to/from RCREPLAY V2 binary payloads.
 */

import { EXTENDED_STATE_OFFSETS as EXT, INCIDENT_EVENT_TYPES, MATCH_SIGNALS } from '../../../physics/RocketSimConstants.ts';
import { unfilterAndUntransposeStateInputTrack } from '../../container/RCReplayBinaryDecoder.ts';
import {
  decodeIncidentFrom64Bytes,
  decodeSignalFrom64Bytes,
  encodeIncidentTo64Bytes,
  encodeSignalTo64Bytes,
  RC_REPLAY_EVENT_STRIDE,
} from '../../container/RCReplayBinarySchema.ts';
import {
  RLRC_STATE_FLOATS_PER_FRAME as FLOATS_PER_FRAME,
  RLRC_TICK_RATE,
  RLRC_TRACK0_FRAME_STRIDE_BYTES as STRIDE,
  type RLRCBookmarkRecord,
  type RLRCContainerPacket,
  type RLRCPlayerSlotMeta,
  type RLRCReplayHeaderMeta,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';
import { RLRC_TRACK0_META_OFFSETS as M } from './RLRCTrack0FrameSlotPacker.ts';

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

function buildTrackCSignals(
  t0: Uint8Array,
  frameCount: number,
  bookmarks: readonly RLRCBookmarkRecord[]
): { signalBytes: Uint8Array; initialClockSeconds: number } {
  const sigs: Array<{ signalType: number; frameIndex: number; param1: number; param2: number }> = [];
  const push = (signalType: number, frameIndex: number, param1: number, param2 = 0) => {
    sigs.push({ signalType, frameIndex, param1, param2 });
  };
  let initialClockSeconds = 300;
  let [prevSec, prevOt, prevCd, prevBlue, prevOrange] = [-1, false, -1, 0, 0];

  for (let f = 0; f < frameCount; f++) {
    const f32 = new Float32Array(t0.buffer, t0.byteOffset + f * STRIDE, FLOATS_PER_FRAME);
    const hasMeta = Math.round(f32[M.MAGIC_TAG]) === M.MAGIC_VALUE;
    const sec = Math.max(0, Math.round(f32[hasMeta ? M.SECONDS_REMAINING : EXT.IS_SIMULATION_FROZEN]));
    const mFlags = Math.round(f32[hasMeta ? M.MATCH_FLAGS : EXT.POSSESSION_STATE]);
    const isOt = (mFlags & 1) !== 0;
    const cd = (mFlags >>> 1) & 0xff;
    const bScore = Math.max(0, Math.round(f32[hasMeta ? M.BLUE_SCORE : EXT.POSSESSION_BLUE_POINTS]));
    const oScore = Math.max(0, Math.round(f32[hasMeta ? M.ORANGE_SCORE : EXT.POSSESSION_ORANGE_POINTS]));

    if (f === 0) {
      initialClockSeconds = sec > 0 ? sec : 300;
      push(MATCH_SIGNALS.MATCH_INITIALIZED, 0, initialClockSeconds, 0);
      push(cd > 0 ? MATCH_SIGNALS.KICKOFF_WILL_START : MATCH_SIGNALS.KICKOFF_START, 0, cd, 0);
      [prevSec, prevOt, prevCd, prevBlue, prevOrange] = [sec, isOt, cd, bScore, oScore];
      continue;
    }

    if (bScore !== prevBlue || oScore !== prevOrange) {
      push(MATCH_SIGNALS.SCORE_UPDATED, f, bScore, oScore);
      [prevBlue, prevOrange] = [bScore, oScore];
    }
    if (cd > 0 && prevCd === 0) push(MATCH_SIGNALS.KICKOFF_WILL_START, f, cd, 0);
    else if (cd === 0 && prevCd > 0) push(MATCH_SIGNALS.KICKOFF_START, f, 0, 0);
    if (isOt && !prevOt) push(MATCH_SIGNALS.OVERTIME_START, f, 0, 1);
    if (sec !== prevSec) push(MATCH_SIGNALS.CLOCK_UPDATED_SECONDS, f, sec, isOt ? 1 : 0);
    [prevSec, prevOt, prevCd] = [sec, isOt, cd];
  }

  for (const bm of bookmarks) {
    if (bm.kind !== 'kickoff') continue;
    const f = Math.max(0, Math.trunc(bm.frameIndex120Hz));
    const near = sigs.some(
      (s) =>
        Math.abs(s.frameIndex - f) <= 12 &&
        (s.signalType === MATCH_SIGNALS.KICKOFF_WILL_START || s.signalType === MATCH_SIGNALS.KICKOFF_START)
    );
    if (!near) push(MATCH_SIGNALS.KICKOFF_START, f, Math.max(0, Math.trunc(bm.sourceFrame30Hz)), Math.max(0, bm.slotIndex));
  }

  sigs.sort((a, b) => a.frameIndex - b.frameIndex);
  const signalBytes = new Uint8Array(sigs.length * RC_REPLAY_EVENT_STRIDE);
  for (let i = 0; i < sigs.length; i++) {
    const { signalType, frameIndex: f, param1, param2 } = sigs[i];
    const sig = { signalId: i + 1, signalType, type: signalType, frameId: f, tick: f, frameIndex: f, param1, param2 };
    encodeSignalTo64Bytes(sig, signalBytes, i * RC_REPLAY_EVENT_STRIDE, f);
  }
  return { signalBytes, initialClockSeconds };
}

export function mapRLRCPacketToRCReplayV2Payload(packet: RLRCContainerPacket): RLRCReplayV2ExportPayload {
  const frameCount = Math.floor(packet.stateInputTrackBytes.byteLength / STRIDE);
  const incBms = packet.bookmarks.filter((b) => b.kind === 'goal' || b.kind === 'demolish');
  const incidentBytes = new Uint8Array(incBms.length * RC_REPLAY_EVENT_STRIDE);
  for (let i = 0; i < incBms.length; i++) {
    const bm = incBms[i];
    const f = Math.max(0, Math.trunc(bm.frameIndex120Hz));
    const c = Math.max(0, bm.slotIndex);
    const t = bm.team === 1 ? 1 : 0;
    const type = bm.kind === 'goal' ? INCIDENT_EVENT_TYPES.GOAL_SCORED : INCIDENT_EVENT_TYPES.CAR_CAR_DEMO;
    const inc = { type, tick: f, frameIndex: f, carIndex: c, primaryId: c, team: t, secondaryId: t };
    encodeIncidentTo64Bytes(inc, incidentBytes, i * RC_REPLAY_EVENT_STRIDE, f);
  }

  const { signalBytes, initialClockSeconds } = buildTrackCSignals(
    packet.stateInputTrackBytes,
    frameCount,
    packet.bookmarks
  );

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

  return {
    mode: 'match',
    arenaPreset: 0,
    tickRate: RLRC_TICK_RATE,
    frameCount,
    durationSec: Number((frameCount / RLRC_TICK_RATE).toFixed(2)),
    durationSeconds: initialClockSeconds,
    winner,
    blueScore,
    orangeScore,
    winReason: 0,
    createdAtIso: packet.header.date || new Date().toISOString(),
    roster,
    loadouts: roster,
    directorReplayMeta: { rlrcHeader: packet.header, rlrcBookmarks: packet.bookmarks },
    stateInputBytes: packet.stateInputTrackBytes,
    incidentBytes,
    signalBytes,
  };
}

export function extractRLRCTracksFromRCReplayV2Bytes(u8: Uint8Array): DecodedRCREPLAYV2TracksForRLRC {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const metaLen = dv.getUint32(12, true);
  if (16 + metaLen > u8.byteLength) throw new Error('Corrupt RCREPLAY V2 metadata JSON length.');

  const env = JSON.parse(new TextDecoder().decode(u8.subarray(16, 16 + metaLen))) as {
    matchInfo?: Record<string, unknown>;
    tracks?: Record<string, { offset: number; byteLength: number; count: number; stride?: number; encoding?: string }>;
  };

  const m = env.matchInfo ?? {};
  const tracks = env.tracks ?? {};
  const st = tracks.stateInput ?? { offset: 0, byteLength: 0, count: 0 };
  const frameCount = Number(st.count ?? m.frameCount ?? 0);
  const stride = Number(st.stride || STRIDE);
  const rawTrackA = frameCount > 0 && st.byteLength > 0 ? u8.subarray(st.offset, st.offset + st.byteLength) : new Uint8Array(0);
  const stateInputTrackBytes =
    st.encoding === 'xor-delta-bytetran-v1'
      ? unfilterAndUntransposeStateInputTrack(rawTrackA, frameCount, stride)
      : u8.slice(st.offset, st.offset + st.byteLength);

  const dirMeta = (m.directorReplayMeta ?? {}) as {
    rlrcHeader?: RLRCReplayHeaderMeta;
    rlrcBookmarks?: readonly RLRCBookmarkRecord[];
  };

  const rawRoster = Array.isArray(m.roster) ? m.roster : [];
  const roster: RLRCPlayerSlotMeta[] = rawRoster.map((e: Record<string, unknown>, idx: number) => {
    const slotIndex = typeof e.slotIndex === 'number' ? e.slotIndex : typeof e.carIndex === 'number' ? e.carIndex : idx;
    const team: RLRCTeamIndex = e.team === 1 || e.team === 'orange' ? 1 : 0;
    const pColor = e.primaryColorHex ?? e.colorHex;
    return {
      slotIndex,
      userName: String(e.userName ?? e.name ?? e.username ?? `Player ${slotIndex + 1}`),
      team,
      priActorId: typeof e.priActorId === 'number' ? e.priActorId : slotIndex + 1,
      bodyProductId: typeof e.bodyProductId === 'number' ? e.bodyProductId : 23,
      hitboxId: (typeof e.hitboxId === 'string' ? e.hitboxId : 'hitbox-octane') as RLRCPlayerSlotMeta['hitboxId'],
      visualId: (typeof e.visualId === 'string' ? e.visualId : 'fennec') as RLRCPlayerSlotMeta['visualId'],
      ...(typeof pColor === 'string' ? { primaryColorHex: pColor } : {}),
      ...(typeof e.accentColorHex === 'string' ? { accentColorHex: e.accentColorHex } : {}),
      ...(e.cameraSettings && typeof e.cameraSettings === 'object'
        ? { cameraSettings: e.cameraSettings as RLRCPlayerSlotMeta['cameraSettings'] }
        : {}),
    };
  });

  const header: RLRCReplayHeaderMeta = dirMeta.rlrcHeader ?? {
    replayId: String(m.replayId ?? 'RCREPLAY-V2'),
    replayName: String(m.mode ?? 'match'),
    mapName: 'Stadium_P',
    matchType: String(m.mode ?? 'match'),
    teamSize: Math.max(1, Math.ceil(Math.max(2, roster.length) / 2)),
    recordFps: 30,
    sourceFrameCount: Math.ceil(frameCount / 4),
    frameCount120Hz: frameCount,
    durationSeconds: Number(m.durationSeconds ?? m.durationSec ?? frameCount / RLRC_TICK_RATE),
    date: String(m.createdAtIso ?? ''),
    blueScore: Number(m.blueScore ?? 0),
    orangeScore: Number(m.orangeScore ?? 0),
    part1CrcValid: true,
    part2CrcValid: true,
  };

  const bookmarks: RLRCBookmarkRecord[] = Array.isArray(dirMeta.rlrcBookmarks) ? [...dirMeta.rlrcBookmarks] : [];
  if (!Array.isArray(dirMeta.rlrcBookmarks)) {
    const incToc = tracks.incidents;
    if (incToc && incToc.count > 0 && incToc.byteLength > 0) {
      const incSlice = u8.subarray(incToc.offset, incToc.offset + incToc.byteLength);
      for (let i = 0; i < incToc.count; i++) {
        const inc = decodeIncidentFrom64Bytes(incSlice, i * RC_REPLAY_EVENT_STRIDE);
        if (inc.type === INCIDENT_EVENT_TYPES.GOAL_SCORED || inc.type === INCIDENT_EVENT_TYPES.CAR_CAR_DEMO) {
          const f = Math.max(0, inc.frameIndex || inc.tick || 0);
          const isGoal = inc.type === INCIDENT_EVENT_TYPES.GOAL_SCORED;
          bookmarks.push({
            kind: isGoal ? 'goal' : 'demolish',
            frameIndex120Hz: f,
            sourceFrame30Hz: Math.floor(f / 4),
            timeSeconds: f / RLRC_TICK_RATE,
            slotIndex: inc.carIndex ?? 0,
            team: inc.team === 1 ? 1 : 0,
            label: isGoal ? 'Goal' : 'Demolish',
          });
        }
      }
    }
    const sigToc = tracks.signals;
    if (sigToc && sigToc.count > 0 && sigToc.byteLength > 0) {
      const sigSlice = u8.subarray(sigToc.offset, sigToc.offset + sigToc.byteLength);
      for (let i = 0; i < sigToc.count; i++) {
        const sig = decodeSignalFrom64Bytes(sigSlice, i * RC_REPLAY_EVENT_STRIDE);
        if (sig.signalType === MATCH_SIGNALS.KICKOFF_START || sig.signalType === MATCH_SIGNALS.KICKOFF_WILL_START) {
          const f = Math.max(0, sig.frameIndex || sig.tick || 0);
          bookmarks.push({
            kind: 'kickoff',
            frameIndex120Hz: f,
            sourceFrame30Hz: sig.param1 || Math.floor(f / 4),
            timeSeconds: f / RLRC_TICK_RATE,
            slotIndex: sig.param2 ?? -1,
            team: -1,
            label: 'Kickoff',
          });
        }
      }
    }
  }

  return { header, roster, bookmarks, stateInputTrackBytes };
}
