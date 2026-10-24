/**
 * StaticTrainingPackCodec.ts
 * GZIP archive compression/decompression, .RCSPack export/import, and single-shot .json codec.
 */

import {
  type StaticTrainingPackMetadata,
  type StaticTrainingShotItem,
  type RCSPackArchive,
  generateUUID,
  createDefaultShotItem,
  cloneShotItem,
} from './StaticTrainingPackTypes';

export async function compressGzipBytes(rawBytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(rawBytes as unknown as BufferSource);
      writer.close();
      const resp = new Response(cs.readable);
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      console.warn('[StaticTrainingPackCodec] GZIP compression fallback to raw UTF-8:', err);
    }
  } else {
    console.warn('[StaticTrainingPackCodec] CompressionStream is undefined; falling back to uncompressed UTF-8 bytes.');
  }
  return rawBytes;
}

export async function decompressGzipOrText(bytes: Uint8Array): Promise<string> {
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (isGzip) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes as unknown as BufferSource);
      writer.close();
      const resp = new Response(ds.readable);
      return await resp.text();
    }
    console.warn('[StaticTrainingPackCodec] GZIP magic header detected (0x1f8b) but DecompressionStream is undefined; falling back to TextDecoder.');
  }
  return new TextDecoder().decode(bytes);
}

export function sanitizeFileSegment(text: string): string {
  return (
    (text || 'TrainingPack')
      .trim()
      .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'TrainingPack'
  );
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/**
 * Exports a Static Training Pack as a compressed `<Title>_<UUID>.RCSPack` file
 * containing embedded metadata and ordered items.
 */
export async function exportStaticTrainingPackRCSPack(
  metadata: StaticTrainingPackMetadata,
  items: StaticTrainingShotItem[]
): Promise<string> {
  const archive: RCSPackArchive = {
    format: 'RCSPack',
    version: 1,
    category: 'static-training-pack',
    metadata: {
      ...metadata,
      itemCount: items.length,
    },
    items: items.map((it, idx) => cloneShotItem(it, idx)),
  };

  const jsonStr = JSON.stringify(archive);
  const rawBytes = new TextEncoder().encode(jsonStr);
  const compressedBytes = await compressGzipBytes(rawBytes);

  const safeTitle = sanitizeFileSegment(metadata.title);
  const filename = `${safeTitle}_${metadata.uuid}.RCSPack`;
  const blob = new Blob([compressedBytes as unknown as BlobPart], {
    type: 'application/octet-stream',
  });
  triggerBrowserDownload(blob, filename);
  return filename;
}

/**
 * Decodes a `.RCSPack` file payload into normalized metadata and shot items.
 */
export async function decodeRCSPackFilePayload(
  file: File
): Promise<{ metadata: StaticTrainingPackMetadata; items: StaticTrainingShotItem[] }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const text = await decompressGzipOrText(bytes);
  const parsed = JSON.parse(text);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid .RCSPack archive payload');
  }

  const rawMeta = parsed.metadata || {};
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const now = Date.now();
  const uuid =
    typeof rawMeta.uuid === 'string' && rawMeta.uuid.trim().length > 0
      ? rawMeta.uuid.trim()
      : generateUUID();

  const items = rawItems.map((it: any, idx: number) => cloneShotItem(it, idx));
  if (items.length === 0) {
    items.push(createDefaultShotItem(0));
  }

  const metadata: StaticTrainingPackMetadata = {
    uuid,
    title:
      typeof rawMeta.title === 'string' && rawMeta.title.trim()
        ? rawMeta.title.trim()
        : 'Imported Pack',
    description: typeof rawMeta.description === 'string' ? rawMeta.description : '',
    createdAt: Number(rawMeta.createdAt) || now,
    updatedAt: now,
    itemCount: items.length,
  };

  return { metadata, items };
}

/**
 * Exports a single shot item as a standalone `.json` file.
 */
export function exportSingleShotItemToJson(
  item: StaticTrainingShotItem,
  packTitle = 'Pack'
): string {
  const payload = {
    format: 'RCStaticShotItem',
    version: 1,
    exportedAt: Date.now(),
    shot: cloneShotItem(item, item.index),
  };
  const jsonStr = JSON.stringify(payload, null, 2);
  const safePack = sanitizeFileSegment(packTitle);
  const filename = `${safePack}_shot_${(item.index ?? 0) + 1}.json`;
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  triggerBrowserDownload(blob, filename);
  return filename;
}

/**
 * Parses a single shot item from a `.json` file.
 */
export async function parseSingleShotItemFromJsonFile(
  file: File,
  targetIndex = 0
): Promise<StaticTrainingShotItem> {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const rawShot = parsed?.shot || parsed;
  if (!rawShot || typeof rawShot !== 'object' || (!rawShot.car && !rawShot.ball)) {
    throw new Error('Invalid shot item JSON format');
  }
  return cloneShotItem(rawShot, targetIndex);
}
