/**
 * src/network/protocol/VNextSchemaHash.ts
 * Wave 2 (`feat/protocol-schema-alignment`):
 * Deterministic 4-byte HEX schemaHash computed from canonical binary field descriptor tables.
 * Replaces manual v1/v2 version numbers so any 1-bit layout mismatch is rejected immediately.
 */

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

export function fnv1a32Byte(hash: number, byte: number): number {
  const xored = (hash ^ (byte & 0xff)) >>> 0;
  return Math.imul(xored, FNV1A_PRIME) >>> 0;
}

export function fnv1a32Uint32(hash: number, value: number): number {
  let h = fnv1a32Byte(hash, value & 0xff);
  h = fnv1a32Byte(h, (value >>> 8) & 0xff);
  h = fnv1a32Byte(h, (value >>> 16) & 0xff);
  h = fnv1a32Byte(h, (value >>> 24) & 0xff);
  return h >>> 0;
}

export function fnv1a32String(hash: number, text: string): number {
  let h = hash >>> 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h = fnv1a32Byte(h, code & 0xff);
    if (code > 0xff) {
      h = fnv1a32Byte(h, (code >>> 8) & 0xff);
    }
  }
  return fnv1a32Byte(h, 0);
}

export function computeSchemaHashFromLayout(layoutFields: readonly string[]): number {
  let h = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < layoutFields.length; i++) {
    h = fnv1a32String(h, layoutFields[i]);
  }
  const normalized = h >>> 0;
  return normalized === 0 ? 1 : normalized;
}

export function formatSchemaHashHex(hash: number): string {
  return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export const VNEXT_CHANNEL1_SCHEMA_LAYOUT = Object.freeze([
  'vnext.ch1.worldframe',
  'schemaHash:u32',
  'txSeq:u32',
  'metadataHash:u32',
  'activityMode:u8',
  'playbackState:u8',
  'phase:u8',
  'flags:u16',
  'simTick:u32',
  'replayFrameIndex:u32',
  'replayTotalFrames:u32',
  'clockSeconds:f32',
  'playbackSpeed:f32',
  'blueScore:u16',
  'orangeScore:u16',
  'focusedCarIndex:i8',
  'cameraMode:u8',
  'timestampMs:f64',
  'opt.fpvAuthority:authorityEpoch:u32,activeInputPeerSlot:u8,authorityMode:u8',
  'opt.training:shotIndex:u16,shotResetSeq:u32,countdownSeconds:f32,remainingTimeoutSeconds:f32',
  'opt.cameraPose:eye:f32x3,target:f32x3,fovDeg:f32',
  'opt.globalPayload:physics+signals+allUserRtt',
] as const);

export const VNEXT_CHANNEL2_SCHEMA_LAYOUT = Object.freeze([
  'vnext.ch2.rostermanifest',
  'schemaHash:u32',
  'metadataHash:u32',
  'manifestVersion:u16',
  'activityId:str',
  'arenaPreset:str',
  'matchDurationSeconds:u16',
  'replayTotalFrames:u32',
  'telestratorAllowed:u8',
  'entryCount:u8',
  'entry:carIndex:u8,slotKey:u8,team:u8,teamSlotIndex:u8,roleFlag:u8,isBot:u8,colorSlot:u8,ghostOpacity:f32,strings',
  'opt.trainingMeta:packId,packName,shotIndex,totalShots,shotName,shotResetSeq,boostPolicy,ghostModeEnabled',
] as const);

export const VNEXT_CHANNEL1_SCHEMA_HASH: number = computeSchemaHashFromLayout(
  VNEXT_CHANNEL1_SCHEMA_LAYOUT
);

export const VNEXT_CHANNEL2_SCHEMA_HASH: number = computeSchemaHashFromLayout(
  VNEXT_CHANNEL2_SCHEMA_LAYOUT
);
