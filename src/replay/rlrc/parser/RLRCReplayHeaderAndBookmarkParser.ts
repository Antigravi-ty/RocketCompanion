/**
 * RLRCReplayHeaderAndBookmarkParser.ts
 * Parses .replay Part 1 header properties, Part 2 keyframes/tick_marks/tables,
 * dual CRC32 checksums, and converts User marks and Goals into RLRCBookmarkRecord[].
 */

import {
  RLRC_TICK_RATE,
  type RLRCBookmarkKind,
  type RLRCBookmarkRecord,
  type RLRCPlayerSlotMeta,
  type RLRCReplayHeaderMeta,
  type RLRCTeamIndex,
} from '../RLRCReplayTypes.ts';

const RL_CRC_POLY = 0x04c11db7;
const RL_CRC_SEED = 0xefcbf201;
const UTF8 = new TextDecoder('utf-8');
const UTF16 = new TextDecoder('utf-16le');
let sCrcTable: Uint32Array | null = null;

function getRLCrcTable(): Uint32Array {
  if (sCrcTable) return sCrcTable;
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (i << 24) >>> 0;
    for (let b = 0; b < 8; b++) {
      c = (c & 0x80000000) !== 0 ? (((c << 1) >>> 0) ^ RL_CRC_POLY) >>> 0 : (c << 1) >>> 0;
    }
    tbl[i] = c >>> 0;
  }
  sCrcTable = tbl;
  return tbl;
}

export function computeRLReplayCrc32(bytes: Uint8Array, seed: number = RL_CRC_SEED): number {
  const tbl = getRLCrcTable();
  let crc = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (((crc << 8) >>> 0) ^ tbl[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return ~crc >>> 0;
}

export class RLRCByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return Math.max(0, this.bytes.byteLength - this.pos);
  }

  readU8(): number {
    return this.view.getUint8(this.pos++);
  }

  readI32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readU32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readU64String(): string {
    const lo = BigInt(this.readU32());
    const hi = BigInt(this.readU32());
    return ((hi << 32n) | lo).toString();
  }

  readF32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readBytes(len: number): Uint8Array {
    const n = Math.max(0, Math.min(len, this.remaining));
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readUEString(): string {
    const len = this.readI32();
    if (len === 0) return '';
    const raw = len < 0 ? this.readBytes(-len * 2) : this.readBytes(len);
    return (len < 0 ? UTF16 : UTF8).decode(raw).replace(/\0+$/, '');
  }
}

export interface RLRCGoalHeaderEntry {
  frame: number;
  playerName: string;
  playerTeam: RLRCTeamIndex;
}

export interface RLRCHighlightHeaderEntry {
  frame: number;
  carName: string;
  ballName: string;
  goalActorName: string;
}

export interface RLRCPlayerStatHeaderEntry {
  name: string;
  platform: string;
  onlineId: string;
  team: RLRCTeamIndex;
  score: number;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  isBot: boolean;
}

export interface RLRCKeyFrameEntry {
  time: number;
  frame: number;
  bitPosition: number;
}

export interface RLRCDebugInfoEntry {
  frame: number;
  user: string;
  text: string;
}

export interface RLRCTickMarkEntry {
  description: string;
  frame: number;
}

export interface RLRCClassIndexEntry {
  className: string;
  objectIndex: number;
}

export interface RLRCNetCacheProperty {
  objectInd: number;
  streamId: number;
}

export interface RLRCNetCacheNode {
  objectInd: number;
  parentId: number;
  cacheId: number;
  properties: readonly RLRCNetCacheProperty[];
}

export interface RLRCBookmarkBuildOptions {
  frameTimesSeconds?: ArrayLike<number>;
  roster?: readonly Pick<RLRCPlayerSlotMeta, 'slotIndex' | 'userName' | 'team'>[];
  includeKeyframes?: boolean;
  includeKickoffs?: boolean;
}

export interface RLRCParsedReplayHeaderAndBookmarks {
  header: RLRCReplayHeaderMeta;
  part1Length: number;
  part1Crc: number;
  part1CrcValid: boolean;
  part2Length: number;
  part2Crc: number;
  part2CrcValid: boolean;
  majorVersion: number;
  minorVersion: number;
  netVersion: number;
  gameType: string;
  maxChannels: number;
  matchGuid: string;
  buildVersion: string;
  matchStartEpoch: string;
  properties: Readonly<Record<string, unknown>>;
  goals: readonly RLRCGoalHeaderEntry[];
  highlights: readonly RLRCHighlightHeaderEntry[];
  playerStats: readonly RLRCPlayerStatHeaderEntry[];
  levels: readonly string[];
  keyframes: readonly RLRCKeyFrameEntry[];
  netstreamBytes: Uint8Array;
  debugInfo: readonly RLRCDebugInfoEntry[];
  tickMarks: readonly RLRCTickMarkEntry[];
  packages: readonly string[];
  objects: readonly string[];
  names: readonly string[];
  classIndices: readonly RLRCClassIndexEntry[];
  netCache: readonly RLRCNetCacheNode[];
  bookmarks: readonly RLRCBookmarkRecord[];
}

function readTable<T>(r: RLRCByteReader, fn: (reader: RLRCByteReader) => T): T[] {
  const n = r.readI32();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(fn(r));
  return out;
}

function readUEPropertyTree(r: RLRCByteReader): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  while (r.remaining > 0) {
    const name = r.readUEString();
    if (!name || name === 'None') break;
    const kind = r.readUEString();
    const byteLen = r.readI32();
    const arrIdx = r.readI32();
    let val: unknown;

    if (kind === 'IntProperty') val = r.readI32();
    else if (kind === 'FloatProperty') val = r.readF32();
    else if (kind === 'StrProperty' || kind === 'NameProperty') val = r.readUEString();
    else if (kind === 'BoolProperty') val = r.readU8() !== 0;
    else if (kind === 'QWordProperty') val = r.readU64String();
    else if (kind === 'ByteProperty') {
      const enumName = r.readUEString();
      val = { enumName, value: enumName === 'None' ? r.readU8() : r.readUEString() };
    } else if (kind === 'StructProperty') {
      val = { structName: r.readUEString(), fields: readUEPropertyTree(r) };
    } else if (kind === 'ArrayProperty') {
      val = readTable(r, readUEPropertyTree);
    } else {
      val = Array.from(r.readBytes(Math.max(0, byteLen)));
    }

    if (arrIdx > 0 && name in props) {
      const prev = props[name];
      if (Array.isArray(prev)) prev.push(val);
      else props[name] = [prev, val];
    } else {
      props[name] = val;
    }
  }
  return props;
}

export function estimateSourceFrameTimeSeconds(
  frame30: number,
  keyframes: readonly RLRCKeyFrameEntry[],
  fps: number,
  frameTimes?: ArrayLike<number>
): number {
  const f = Math.max(0, Math.trunc(frame30));
  if (frameTimes && frameTimes.length > 0) {
    return Number(frameTimes[Math.min(f, frameTimes.length - 1)]) || 0;
  }
  const rate = fps > 0 ? fps : 30;
  if (keyframes.length === 0) return f / rate;
  if (f <= keyframes[0].frame)
    return Math.max(0, keyframes[0].time - (keyframes[0].frame - f) / rate);
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (f >= a.frame && f <= b.frame) {
      const span = b.frame - a.frame;
      return span <= 0 ? a.time : a.time + ((f - a.frame) / span) * (b.time - a.time);
    }
  }
  const last = keyframes[keyframes.length - 1];
  return last.time + (f - last.frame) / rate;
}

export function estimateFrameIndex120Hz(
  frame30: number,
  keyframes: readonly RLRCKeyFrameEntry[],
  fps: number,
  frameTimes?: ArrayLike<number>
): number {
  const t0 =
    frameTimes && frameTimes.length > 0 ? Number(frameTimes[0]) || 0 : (keyframes[0]?.time ?? 0);
  const t = estimateSourceFrameTimeSeconds(frame30, keyframes, fps, frameTimes);
  return Math.max(0, Math.round((t - t0) * RLRC_TICK_RATE));
}

export function buildRLRCBookmarksFromHeaderAndPart2(
  goals: readonly RLRCGoalHeaderEntry[],
  tickMarks: readonly RLRCTickMarkEntry[],
  keyframes: readonly RLRCKeyFrameEntry[],
  fps: number,
  options?: RLRCBookmarkBuildOptions
): RLRCBookmarkRecord[] {
  const ft = options?.frameTimesSeconds;
  const byName = new Map<string, { slotIndex: number; team: RLRCTeamIndex }>();
  for (const m of options?.roster ?? [])
    byName.set(m.userName.toLowerCase(), { slotIndex: m.slotIndex, team: m.team });

  const out: RLRCBookmarkRecord[] = [];
  const add = (
    kind: RLRCBookmarkKind,
    frame: number,
    label: string,
    slotIndex: number,
    team: RLRCTeamIndex | -1
  ): void => {
    out.push({
      kind,
      frameIndex120Hz: estimateFrameIndex120Hz(frame, keyframes, fps, ft),
      sourceFrame30Hz: frame,
      timeSeconds: estimateSourceFrameTimeSeconds(frame, keyframes, fps, ft),
      label,
      slotIndex,
      team,
    });
  };

  let userIdx = 0;
  for (const m of tickMarks) {
    if (m.description.trim().toLowerCase() === 'user')
      add('user-mark', m.frame, `User Mark #${++userIdx}`, -1, -1);
  }
  for (const g of goals) {
    const hit = byName.get(g.playerName.toLowerCase());
    const team: RLRCTeamIndex = g.playerTeam === 1 ? 1 : 0;
    add(
      'goal',
      g.frame,
      `Goal: ${g.playerName} (${team === 0 ? 'Blue' : 'Orange'})`,
      hit ? hit.slotIndex : -1,
      team
    );
  }
  for (const m of tickMarks) {
    const d = m.description.trim().toLowerCase();
    if (
      (d === 'team0goal' || d === 'team1goal' || d === 'goal') &&
      !goals.some((g) => Math.abs(g.frame - m.frame) <= 90)
    ) {
      const team: RLRCTeamIndex | -1 = d.includes('team0') ? 0 : d.includes('team1') ? 1 : -1;
      add(
        'goal',
        m.frame,
        `Goal (${team === 0 ? 'Blue' : team === 1 ? 'Orange' : 'Match'})`,
        -1,
        team
      );
    }
  }
  if (options?.includeKickoffs) {
    for (const kf of keyframes) {
      if (kf.frame === 0 || goals.some((g) => kf.frame > g.frame && kf.frame - g.frame <= 150)) {
        add('kickoff', kf.frame, `Kickoff @ Frame ${kf.frame}`, -1, -1);
      }
    }
  }
  if (options?.includeKeyframes) {
    for (let i = 0; i < keyframes.length; i++)
      add('ue-keyframe', keyframes[i].frame, `UE KeyFrame #${i + 1}`, -1, -1);
  }
  return out.sort((a, b) => a.sourceFrame30Hz - b.sourceFrame30Hz);
}

export function alignRLRCBookmarksTo120HzFrames(
  bookmarks: readonly RLRCBookmarkRecord[],
  frameTimes: ArrayLike<number>
): RLRCBookmarkRecord[] {
  if (frameTimes.length === 0) return [...bookmarks];
  const t0 = Number(frameTimes[0]) || 0;
  return bookmarks.map((b) => {
    const idx = Math.max(0, Math.min(b.sourceFrame30Hz, frameTimes.length - 1));
    const timeSeconds = Number(frameTimes[idx]) || b.timeSeconds;
    return {
      ...b,
      timeSeconds,
      frameIndex120Hz: Math.max(0, Math.round((timeSeconds - t0) * RLRC_TICK_RATE)),
    };
  });
}

export function parseRLRCReplayHeaderAndBookmarks(
  buffer: ArrayBuffer | Uint8Array,
  options?: RLRCBookmarkBuildOptions
): RLRCParsedReplayHeaderAndBookmarks {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 32) throw new Error('Invalid .replay: buffer < 32B.');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const part1Length = view.getUint32(0, true);
  const part1Crc = view.getUint32(4, true);
  const p2Off = 8 + part1Length;
  if (p2Off + 8 > bytes.byteLength) throw new Error('Invalid .replay: Part 1 out of bounds.');

  const part1Slice = bytes.subarray(8, p2Off);
  const part1CrcValid = computeRLReplayCrc32(part1Slice) === part1Crc;

  const part2Length = view.getUint32(p2Off, true);
  const part2Crc = view.getUint32(p2Off + 4, true);
  if (p2Off + 8 + part2Length > bytes.byteLength)
    throw new Error('Invalid .replay: Part 2 out of bounds.');

  const part2Slice = bytes.subarray(p2Off + 8, p2Off + 8 + part2Length);
  const part2CrcValid = computeRLReplayCrc32(part2Slice) === part2Crc;

  const p1 = new RLRCByteReader(part1Slice);
  const majorVersion = p1.readI32();
  const minorVersion = p1.readI32();
  const netVersion = majorVersion > 865 && minorVersion > 17 ? p1.readI32() : 0;
  const gameType = p1.readUEString();
  const props = readUEPropertyTree(p1);
  const asArr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v : []);

  const goals: RLRCGoalHeaderEntry[] = asArr(props.Goals).map((g) => ({
    frame: Math.max(0, Math.trunc(Number(g?.frame) || 0)),
    playerName: String(g?.PlayerName || 'Player'),
    playerTeam: Number(g?.PlayerTeam) === 1 ? 1 : 0,
  }));

  const highlights: RLRCHighlightHeaderEntry[] = asArr(props.HighLights).map((h) => ({
    frame: Math.max(0, Math.trunc(Number(h?.frame) || 0)),
    carName: String(h?.CarName || ''),
    ballName: String(h?.BallName || ''),
    goalActorName: String(h?.GoalActorName || ''),
  }));

  const playerStats: RLRCPlayerStatHeaderEntry[] = asArr(props.PlayerStats).map((s) => {
    const plat = s?.Platform as Record<string, unknown> | undefined;
    return {
      name: String(s?.Name || 'Player'),
      platform: String(plat?.value || plat?.enumName || 'Unknown'),
      onlineId: String(s?.OnlineID || '0'),
      team: Number(s?.Team) === 1 ? 1 : 0,
      score: Number(s?.Score) || 0,
      goals: Number(s?.Goals) || 0,
      assists: Number(s?.Assists) || 0,
      saves: Number(s?.Saves) || 0,
      shots: Number(s?.Shots) || 0,
      isBot: Boolean(s?.bBot),
    };
  });

  const p2 = new RLRCByteReader(part2Slice);
  const readStr = (r: RLRCByteReader): string => r.readUEString();
  const levels = readTable(p2, readStr);
  const keyframes = readTable(p2, (r) => ({
    time: r.readF32(),
    frame: r.readI32(),
    bitPosition: r.readI32(),
  }));
  const netstreamBytes = p2.readBytes(Math.max(0, p2.readI32()));
  const debugInfo = readTable(p2, (r) => ({
    frame: r.readI32(),
    user: r.readUEString(),
    text: r.readUEString(),
  }));
  const tickMarks = readTable(p2, (r) => ({ description: r.readUEString(), frame: r.readI32() }));
  const packages = readTable(p2, readStr);
  const objects = readTable(p2, readStr);
  const names = readTable(p2, readStr);
  const classIndices = readTable(p2, (r) => ({
    className: r.readUEString(),
    objectIndex: r.readI32(),
  }));
  const netCache = readTable(p2, (r) => ({
    objectInd: r.readI32(),
    parentId: r.readI32(),
    cacheId: r.readI32(),
    properties: readTable(r, (pr) => ({ objectInd: pr.readI32(), streamId: pr.readI32() })),
  }));

  const recordFps = Number(props.RecordFPS) || 30.0;
  const sourceFrameCount = Math.max(0, Math.trunc(Number(props.NumFrames) || 0));
  const totalSeconds = Number(props.TotalSecondsPlayed) || 0;
  const estEnd =
    sourceFrameCount > 0
      ? estimateSourceFrameTimeSeconds(
          sourceFrameCount - 1,
          keyframes,
          recordFps,
          options?.frameTimesSeconds
        ) - (keyframes[0]?.time ?? 0)
      : 0;
  const durationSeconds = totalSeconds > 0 ? totalSeconds : Math.max(0, estEnd);
  const frameCount120Hz = Math.max(0, Math.round(durationSeconds * RLRC_TICK_RATE));
  const blueScore =
    props.Team0Score !== undefined
      ? Number(props.Team0Score)
      : goals.filter((g) => g.playerTeam === 0).length;
  const orangeScore =
    props.Team1Score !== undefined
      ? Number(props.Team1Score)
      : goals.filter((g) => g.playerTeam === 1).length;

  return {
    header: {
      replayId: String(props.Id || ''),
      replayName: String(props.ReplayName || ''),
      mapName: String(props.MapName || ''),
      matchType: String(props.MatchType || ''),
      teamSize: Number(props.TeamSize) || 3,
      recordFps,
      sourceFrameCount,
      frameCount120Hz,
      durationSeconds,
      date: String(props.Date || ''),
      blueScore,
      orangeScore,
      part1CrcValid,
      part2CrcValid,
    },
    part1Length,
    part1Crc,
    part1CrcValid,
    part2Length,
    part2Crc,
    part2CrcValid,
    majorVersion,
    minorVersion,
    netVersion,
    gameType,
    maxChannels: Number(props.MaxChannels) || 2047,
    matchGuid: String(props.MatchGUID || ''),
    buildVersion: String(props.BuildVersion || ''),
    matchStartEpoch: String(props.MatchStartEpoch || '0'),
    properties: props,
    goals,
    highlights,
    playerStats,
    levels,
    keyframes,
    netstreamBytes,
    debugInfo,
    tickMarks,
    packages,
    objects,
    names,
    classIndices,
    netCache,
    bookmarks: buildRLRCBookmarksFromHeaderAndPart2(
      goals,
      tickMarks,
      keyframes,
      recordFps,
      options
    ),
  };
}

export const parseRLReplayBinaryContainer = parseRLRCReplayHeaderAndBookmarks;
