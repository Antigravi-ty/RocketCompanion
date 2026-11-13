import {
  generateDynamicUuid,
  relinkDynamicShotChain,
  sortDynamicShotsByPrevLink,
  type DynamicTrainingPackMetadata,
  type DynamicTrainingPackRecord,
  type DynamicTrainingShotRef,
  type DynamicTrainingStateSession,
  type RCDPackArchive,
} from './dynamicTrainingPackTypes';

export function buildRcdPackArchive(
  pack: DynamicTrainingPackRecord,
  sessionMap: ReadonlyMap<string, DynamicTrainingStateSession>
): RCDPackArchive {
  const orderedShots = relinkDynamicShotChain(sortDynamicShotsByPrevLink(pack.shots));
  const includedSessionIds = new Set<string>();
  const sessions: DynamicTrainingStateSession[] = [];

  for (const shot of orderedShots) {
    if (includedSessionIds.has(shot.sessionId)) continue;
    const sess = sessionMap.get(shot.sessionId);
    if (sess) {
      includedSessionIds.add(shot.sessionId);
      sessions.push(sess);
    }
  }

  return {
    format: 'RCDPack',
    version: 1,
    category: 'dynamic-training-pack',
    metadata: {
      ...pack.metadata,
      itemCount: orderedShots.length,
    },
    shots: orderedShots,
    sessions,
  };
}

export function encodeRcdPackToJson(
  pack: DynamicTrainingPackRecord,
  sessionMap: ReadonlyMap<string, DynamicTrainingStateSession>
): string {
  const archive = buildRcdPackArchive(pack, sessionMap);
  return JSON.stringify(archive);
}

export function decodeRcdPackFromJson(rawJson: string): {
  pack: DynamicTrainingPackRecord;
  sessions: DynamicTrainingStateSession[];
} {
  const parsed = JSON.parse(rawJson) as Partial<RCDPackArchive> | null;
  if (!parsed || parsed.format !== 'RCDPack' || parsed.category !== 'dynamic-training-pack') {
    throw new Error('Invalid .RCDPack archive: missing RCDPack header');
  }

  const now = Date.now();
  const rawMeta = parsed.metadata ?? ({} as Partial<DynamicTrainingPackMetadata>);
  const rawShots = Array.isArray(parsed.shots) ? parsed.shots : [];
  const rawSessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];

  const shots = relinkDynamicShotChain(sortDynamicShotsByPrevLink(rawShots as DynamicTrainingShotRef[]));
  const metadata: DynamicTrainingPackMetadata = {
    uuid: typeof rawMeta.uuid === 'string' && rawMeta.uuid ? rawMeta.uuid : generateDynamicUuid(),
    title: typeof rawMeta.title === 'string' && rawMeta.title ? rawMeta.title : 'Imported Dynamic Pack',
    description: typeof rawMeta.description === 'string' ? rawMeta.description : '',
    folder: typeof rawMeta.folder === 'string' && rawMeta.folder ? rawMeta.folder : 'imported',
    creator: typeof rawMeta.creator === 'string' ? rawMeta.creator : undefined,
    tags: Array.isArray(rawMeta.tags) ? rawMeta.tags : undefined,
    createdAt: typeof rawMeta.createdAt === 'number' ? rawMeta.createdAt : now,
    updatedAt: now,
    itemCount: shots.length,
  };

  return {
    pack: { metadata, shots },
    sessions: rawSessions as DynamicTrainingStateSession[],
  };
}

export async function encodeRcdPackToGzipBytes(
  pack: DynamicTrainingPackRecord,
  sessionMap: ReadonlyMap<string, DynamicTrainingStateSession>
): Promise<Uint8Array> {
  const rawJson = encodeRcdPackToJson(pack, sessionMap);
  const utf8 = new TextEncoder().encode(rawJson);
  if (typeof CompressionStream === 'undefined') {
    return utf8;
  }
  const stream = new Blob([utf8]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function decodeRcdPackFromFileBytes(bytes: ArrayBuffer | Uint8Array): Promise<{
  pack: DynamicTrainingPackRecord;
  sessions: DynamicTrainingStateSession[];
}> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isGzip = view.length >= 2 && view[0] === 0x1f && view[1] === 0x8b;
  if (isGzip && typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([view as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    return decodeRcdPackFromJson(text);
  }
  const text = new TextDecoder().decode(view);
  return decodeRcdPackFromJson(text);
}
