/**
 * src/network/protocol/VNextRosterManifestCodec.ts
 * Wave 2 (`feat/protocol-schema-alignment`):
 * Channel 2 Low-Frequency RosterManifest & Mode Context binary codec + deterministic metadataHash.
 */

import {
  VNEXT_CHANNEL2_SCHEMA_HASH,
  fnv1a32Byte,
  fnv1a32String,
  fnv1a32Uint32,
  formatSchemaHashHex,
} from './VNextSchemaHash.ts';

export type VNextRosterRoleFlag = 'player' | 'bot' | 'ghost';

const ROLE_FLAGS: readonly VNextRosterRoleFlag[] = ['player', 'bot', 'ghost'];

export interface VNextRosterEntry {
  carIndex: number;
  slotKey: number;
  team: 0 | 1;
  teamSlotIndex: number;
  name: string;
  roleFlag: VNextRosterRoleFlag;
  isBot: boolean;
  botType: string | null;
  visualId: string;
  hitboxId: string;
  colorSlot: number;
  colorHex: string;
  paintFinish: string;
  decalId: string;
  boostVisual: string;
  boostAudio: string;
  anthemId: string | null;
  ghostOpacity: number;
}

export interface VNextTrainingManifestMeta {
  packId: string;
  packName: string;
  shotIndex: number;
  totalShots: number;
  shotName: string;
  shotResetSeq: number;
  boostPolicy: string;
  ghostModeEnabled: boolean;
}

export interface VNextRosterManifest {
  manifestVersion: number;
  metadataHash: number;
  activityId: string;
  arenaPreset: string;
  matchDurationSeconds: number;
  replayTotalFrames: number;
  telestratorAllowed: boolean;
  entries: VNextRosterEntry[];
  trainingMeta?: VNextTrainingManifestMeta | null;
}

export type VNextRosterManifestInput = Omit<VNextRosterManifest, 'metadataHash'> & {
  metadataHash?: number;
};

export function computeRosterMetadataHash(
  manifest: Omit<VNextRosterManifest, 'metadataHash'>
): number {
  let h = 0x811c9dc5;
  h = fnv1a32Uint32(h, manifest.manifestVersion >>> 0);
  h = fnv1a32String(h, String(manifest.activityId));
  h = fnv1a32String(h, manifest.arenaPreset);
  h = fnv1a32Uint32(h, manifest.matchDurationSeconds >>> 0);
  h = fnv1a32Uint32(h, manifest.replayTotalFrames >>> 0);
  h = fnv1a32Byte(h, manifest.telestratorAllowed ? 1 : 0);
  h = fnv1a32Byte(h, manifest.entries.length);

  for (let i = 0; i < manifest.entries.length; i++) {
    const e = manifest.entries[i];
    h = fnv1a32Byte(h, e.carIndex);
    h = fnv1a32Byte(h, e.slotKey);
    h = fnv1a32Byte(h, e.team);
    h = fnv1a32Byte(h, e.teamSlotIndex);
    h = fnv1a32String(h, e.name);
    h = fnv1a32String(h, e.roleFlag);
    h = fnv1a32Byte(h, e.isBot ? 1 : 0);
    h = fnv1a32String(h, e.botType ?? '');
    h = fnv1a32String(h, e.visualId);
    h = fnv1a32String(h, e.hitboxId);
    h = fnv1a32Byte(h, e.colorSlot);
    h = fnv1a32String(h, e.colorHex);
    h = fnv1a32String(h, e.paintFinish);
    h = fnv1a32String(h, e.decalId);
    h = fnv1a32String(h, e.boostVisual);
    h = fnv1a32String(h, e.boostAudio);
    h = fnv1a32String(h, e.anthemId ?? '');
    h = fnv1a32Uint32(h, Math.round((e.ghostOpacity ?? 1) * 1000));
  }

  if (manifest.trainingMeta) {
    const t = manifest.trainingMeta;
    h = fnv1a32Byte(h, 1);
    h = fnv1a32String(h, t.packId);
    h = fnv1a32String(h, t.packName);
    h = fnv1a32Uint32(h, t.shotIndex);
    h = fnv1a32Uint32(h, t.totalShots);
    h = fnv1a32String(h, t.shotName);
    h = fnv1a32Uint32(h, t.shotResetSeq);
    h = fnv1a32String(h, t.boostPolicy);
    h = fnv1a32Byte(h, t.ghostModeEnabled ? 1 : 0);
  } else {
    h = fnv1a32Byte(h, 0);
  }

  const normalized = h >>> 0;
  return normalized === 0 ? 1 : normalized;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 512) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.byteLength) return;
    let nextCap = this.buf.byteLength * 2;
    while (nextCap < this.pos + extra) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos++, v & 0xff);
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, false);
    this.pos += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, false);
    this.pos += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, false);
    this.pos += 4;
  }

  str(s: string | null | undefined): void {
    if (!s) {
      this.u16(0);
      return;
    }
    const encoded = textEncoder.encode(s);
    const len = Math.min(0xffff, encoded.byteLength);
    this.u16(len);
    this.ensure(len);
    this.buf.set(encoded.subarray(0, len), this.pos);
    this.pos += len;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class ByteReader {
  private readonly view: DataView;
  private readonly u8Arr: Uint8Array;
  pos = 0;

  constructor(input: ArrayBuffer | Uint8Array | DataView) {
    if (input instanceof DataView) {
      this.view = input;
      this.u8Arr = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else if (input instanceof Uint8Array) {
      this.view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      this.u8Arr = input;
    } else {
      this.view = new DataView(input);
      this.u8Arr = new Uint8Array(input);
    }
  }

  get byteLength(): number {
    return this.view.byteLength;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, false);
    this.pos += 4;
    return v;
  }

  str(): string {
    const len = this.u16();
    if (len === 0) return '';
    const slice = this.u8Arr.subarray(this.pos, this.pos + len);
    this.pos += len;
    return textDecoder.decode(slice);
  }
}

export class VNextRosterManifestCodec {
  static encode(input: VNextRosterManifestInput): Uint8Array {
    const metadataHash = input.metadataHash ?? computeRosterMetadataHash(input);
    const w = new ByteWriter(512);
    w.u32(VNEXT_CHANNEL2_SCHEMA_HASH);
    w.u32(metadataHash);
    w.u16(input.manifestVersion);
    w.str(String(input.activityId));
    w.str(input.arenaPreset);
    w.u16(input.matchDurationSeconds);
    w.u32(input.replayTotalFrames);
    w.u8(input.telestratorAllowed ? 1 : 0);
    w.u8(input.entries.length);

    for (let i = 0; i < input.entries.length; i++) {
      const e = input.entries[i];
      w.u8(e.carIndex);
      w.u8(e.slotKey);
      w.u8(e.team);
      w.u8(e.teamSlotIndex);
      const roleIdx = ROLE_FLAGS.indexOf(e.roleFlag);
      w.u8(roleIdx >= 0 ? roleIdx : 0);
      w.u8(e.isBot ? 1 : 0);
      w.u8(e.colorSlot);
      w.f32(e.ghostOpacity ?? 1);
      w.str(e.name);
      w.str(e.botType ?? '');
      w.str(e.visualId);
      w.str(e.hitboxId);
      w.str(e.colorHex);
      w.str(e.paintFinish);
      w.str(e.decalId);
      w.str(e.boostVisual);
      w.str(e.boostAudio);
      w.str(e.anthemId ?? '');
    }

    if (input.trainingMeta) {
      const t = input.trainingMeta;
      w.u8(1);
      w.str(t.packId);
      w.str(t.packName);
      w.u16(t.shotIndex);
      w.u16(t.totalShots);
      w.str(t.shotName);
      w.u32(t.shotResetSeq);
      w.str(t.boostPolicy);
      w.u8(t.ghostModeEnabled ? 1 : 0);
    } else {
      w.u8(0);
    }

    return w.finish();
  }

  static decode(input: ArrayBuffer | Uint8Array | DataView): VNextRosterManifest {
    const r = new ByteReader(input);
    if (r.byteLength < 18) {
      throw new Error(`[VNextRosterManifestCodec] Truncated manifest: ${r.byteLength}`);
    }
    const schemaHash = r.u32();
    if (schemaHash !== VNEXT_CHANNEL2_SCHEMA_HASH) {
      throw new Error(
        `[VNextRosterManifestCodec] schemaHash mismatch: got ${formatSchemaHashHex(schemaHash)}, expected ${formatSchemaHashHex(VNEXT_CHANNEL2_SCHEMA_HASH)}`
      );
    }

    const metadataHash = r.u32();
    const manifestVersion = r.u16();
    const activityId = r.str();
    const arenaPreset = r.str();
    const matchDurationSeconds = r.u16();
    const replayTotalFrames = r.u32();
    const telestratorAllowed = r.u8() !== 0;
    const entryCount = r.u8();

    const entries: VNextRosterEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
      const carIndex = r.u8();
      const slotKey = r.u8();
      const team = (r.u8() === 1 ? 1 : 0) as 0 | 1;
      const teamSlotIndex = r.u8();
      const roleFlag = ROLE_FLAGS[r.u8()] ?? 'player';
      const isBot = r.u8() !== 0;
      const colorSlot = r.u8();
      const ghostOpacity = r.f32();
      const name = r.str();
      const rawBotType = r.str();
      const visualId = r.str();
      const hitboxId = r.str();
      const colorHex = r.str();
      const paintFinish = r.str();
      const decalId = r.str();
      const boostVisual = r.str();
      const boostAudio = r.str();
      const rawAnthem = r.str();
      entries.push({
        carIndex,
        slotKey,
        team,
        teamSlotIndex,
        name,
        roleFlag,
        isBot,
        botType: rawBotType || null,
        visualId,
        hitboxId,
        colorSlot,
        colorHex,
        paintFinish,
        decalId,
        boostVisual,
        boostAudio,
        anthemId: rawAnthem || null,
        ghostOpacity,
      });
    }

    const hasTraining = r.u8() !== 0;
    let trainingMeta: VNextTrainingManifestMeta | null = null;
    if (hasTraining) {
      trainingMeta = {
        packId: r.str(),
        packName: r.str(),
        shotIndex: r.u16(),
        totalShots: r.u16(),
        shotName: r.str(),
        shotResetSeq: r.u32(),
        boostPolicy: r.str(),
        ghostModeEnabled: r.u8() !== 0,
      };
    }

    return {
      manifestVersion,
      metadataHash,
      activityId,
      arenaPreset,
      matchDurationSeconds,
      replayTotalFrames,
      telestratorAllowed,
      entries,
      trainingMeta,
    };
  }
}
