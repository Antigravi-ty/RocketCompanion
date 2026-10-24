/**
 * StaticTrainingPackStorage.ts
 * Path-keyed IndexedDB Virtual Filesystem (VFS) for Static Training Packs.
 *
 * VFS Top-Level Namespaces:
 * 1. /static-training-pack/<uuid>/metadata
 *    /static-training-pack/<uuid>/items/<index>
 * 2. /replay/<uuid> (Reserved for pre-compressed Replay storage)
 * 3. /dynamic-training-pack/<uuid> (Reserved for pre-compressed Dynamic Training Pack storage)
 */

import {
  type EditSubMode,
  type StaticTrainingCarConfig,
  type StaticTrainingBallConfig,
  type StaticTrainingShotItem,
  type StaticTrainingPackMetadata,
  type RCSPackArchive,
  EDIT_SUB_MODES_ORDER,
  generateUUID,
  createDefaultShotItem,
  cloneShotItem,
  createStarterShots,
} from './StaticTrainingPackTypes';
import {
  exportStaticTrainingPackRCSPack,
  decodeRCSPackFilePayload,
  exportSingleShotItemToJson,
  parseSingleShotItemFromJsonFile,
} from './StaticTrainingPackCodec';

export {
  type EditSubMode,
  type StaticTrainingCarConfig,
  type StaticTrainingBallConfig,
  type StaticTrainingShotItem,
  type StaticTrainingPackMetadata,
  type RCSPackArchive,
  EDIT_SUB_MODES_ORDER,
  generateUUID,
  createDefaultShotItem,
  cloneShotItem,
  exportStaticTrainingPackRCSPack,
  exportSingleShotItemToJson,
  parseSingleShotItemFromJsonFile,
};

interface VfsNodeRecord {
  path: string;
  category: 'static-training-pack' | 'replay' | 'dynamic-training-pack';
  uuid: string;
  nodeType: 'metadata' | 'item' | 'blob';
  index?: number;
  updatedAt: number;
  data: any;
}

const VFS_DB_NAME = 'rc-virtual-fs-db';
const VFS_DB_VERSION = 1;
const VFS_STORE_NAME = 'vfs_nodes';

const memoryVfsFallback = new Map<string, VfsNodeRecord>();

export function buildMetaPath(uuid: string): string {
  return `/static-training-pack/${uuid}/metadata`;
}

export function buildItemPath(uuid: string, index: number): string {
  return `/static-training-pack/${uuid}/items/${index}`;
}

function openVfsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    console.warn('[StaticTrainingPackStorage] IndexedDB is undefined in this environment; using in-memory VFS fallback.');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(VFS_DB_NAME, VFS_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(VFS_STORE_NAME)) {
          const store = db.createObjectStore(VFS_STORE_NAME, { keyPath: 'path' });
          store.createIndex('by_category', 'category', { unique: false });
          store.createIndex('by_uuid', 'uuid', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.warn('[StaticTrainingPackStorage] IndexedDB open failed, using memory fallback:', req.error);
        resolve(null);
      };
    } catch (err) {
      console.warn('[StaticTrainingPackStorage] IndexedDB exception, using memory fallback:', err);
      resolve(null);
    }
  });
}

async function vfsPutNodes(nodes: VfsNodeRecord[]): Promise<void> {
  for (const node of nodes) {
    memoryVfsFallback.set(node.path, node);
  }
  const db = await openVfsDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(VFS_STORE_NAME, 'readwrite');
      const store = tx.objectStore(VFS_STORE_NAME);
      for (const node of nodes) {
        store.put(node);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        console.warn('[StaticTrainingPackStorage] vfsPutNodes IndexedDB transaction failed, retaining nodes in memory fallback:', tx.error);
        db.close();
        resolve();
      };
    } catch (err) {
      console.warn('[StaticTrainingPackStorage] vfsPutNodes IndexedDB exception, retaining nodes in memory fallback:', err);
      db.close();
      resolve();
    }
  });
}

async function vfsGetAllByCategory(
  category: 'static-training-pack' | 'replay' | 'dynamic-training-pack'
): Promise<VfsNodeRecord[]> {
  const db = await openVfsDb();
  if (!db) {
    return Array.from(memoryVfsFallback.values()).filter((n) => n.category === category);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(VFS_STORE_NAME, 'readonly');
      const store = tx.objectStore(VFS_STORE_NAME);
      const idx = store.index('by_category');
      const req = idx.getAll(category);
      req.onsuccess = () => {
        const res = Array.isArray(req.result) ? (req.result as VfsNodeRecord[]) : [];
        db.close();
        resolve(res);
      };
      req.onerror = () => {
        console.warn(`[StaticTrainingPackStorage] vfsGetAllByCategory("${category}") failed, falling back to memoryVfsFallback:`, req.error);
        db.close();
        resolve(Array.from(memoryVfsFallback.values()).filter((n) => n.category === category));
      };
    } catch (err) {
      console.warn(`[StaticTrainingPackStorage] vfsGetAllByCategory("${category}") exception, falling back to memoryVfsFallback:`, err);
      db.close();
      resolve(Array.from(memoryVfsFallback.values()).filter((n) => n.category === category));
    }
  });
}

async function vfsGetByUuid(uuid: string): Promise<VfsNodeRecord[]> {
  const db = await openVfsDb();
  if (!db) {
    return Array.from(memoryVfsFallback.values()).filter((n) => n.uuid === uuid);
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(VFS_STORE_NAME, 'readonly');
      const store = tx.objectStore(VFS_STORE_NAME);
      const idx = store.index('by_uuid');
      const req = idx.getAll(uuid);
      req.onsuccess = () => {
        const res = Array.isArray(req.result) ? (req.result as VfsNodeRecord[]) : [];
        db.close();
        resolve(res);
      };
      req.onerror = () => {
        console.warn(`[StaticTrainingPackStorage] vfsGetByUuid("${uuid}") failed, falling back to memoryVfsFallback:`, req.error);
        db.close();
        resolve(Array.from(memoryVfsFallback.values()).filter((n) => n.uuid === uuid));
      };
    } catch (err) {
      console.warn(`[StaticTrainingPackStorage] vfsGetByUuid("${uuid}") exception, falling back to memoryVfsFallback:`, err);
      db.close();
      resolve(Array.from(memoryVfsFallback.values()).filter((n) => n.uuid === uuid));
    }
  });
}

async function vfsDeleteByUuid(uuid: string): Promise<void> {
  for (const [k, v] of memoryVfsFallback.entries()) {
    if (v.uuid === uuid) memoryVfsFallback.delete(k);
  }
  const db = await openVfsDb();
  if (!db) return;
  const records = await vfsGetByUuid(uuid);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(VFS_STORE_NAME, 'readwrite');
      const store = tx.objectStore(VFS_STORE_NAME);
      for (const rec of records) {
        store.delete(rec.path);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        console.warn(`[StaticTrainingPackStorage] vfsDeleteByUuid("${uuid}") IndexedDB transaction failed:`, tx.error);
        db.close();
        resolve();
      };
    } catch (err) {
      console.warn(`[StaticTrainingPackStorage] vfsDeleteByUuid("${uuid}") IndexedDB exception:`, err);
      db.close();
      resolve();
    }
  });
}

/**
 * Lists all Static Training Pack metadata records sorted by updatedAt descending.
 * Seeds a default starter pack if the VFS is completely empty on first launch.
 */
export async function listStaticTrainingPacks(): Promise<StaticTrainingPackMetadata[]> {
  const records = await vfsGetAllByCategory('static-training-pack');
  const metas = records
    .filter((r) => r.nodeType === 'metadata' && r.data?.uuid)
    .map((r) => r.data as StaticTrainingPackMetadata)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (metas.length > 0) {
    return metas;
  }

  const starter = await seedDefaultStarterPack();
  return [starter];
}

export async function seedDefaultStarterPack(): Promise<StaticTrainingPackMetadata> {
  const uuid = 'starter-aerial-striker-pack';
  const now = Date.now();
  const shots = createStarterShots(uuid);
  const meta: StaticTrainingPackMetadata = {
    uuid,
    title: 'Fundamentals: Striker & Aerials',
    description:
      'Starter static training pack featuring a midfield volley, a suspended kickoff-state aerial, and a backboard read.',
    createdAt: now,
    updatedAt: now,
    itemCount: shots.length,
  };

  await saveStaticTrainingPackFull(meta, shots);
  return meta;
}

export async function loadStaticTrainingPackByUuid(uuid: string): Promise<{
  metadata: StaticTrainingPackMetadata | null;
  items: StaticTrainingShotItem[];
}> {
  const records = await vfsGetByUuid(uuid);
  let metadata: StaticTrainingPackMetadata | null = null;
  const items: StaticTrainingShotItem[] = [];

  for (const rec of records) {
    if (rec.nodeType === 'metadata' && rec.data) {
      metadata = rec.data as StaticTrainingPackMetadata;
    } else if (rec.nodeType === 'item' && rec.data) {
      items.push(cloneShotItem(rec.data, rec.index ?? rec.data.index ?? 0));
    }
  }

  items.sort((a, b) => a.index - b.index);
  items.forEach((it, idx) => {
    it.index = idx;
  });

  return { metadata, items };
}

/**
 * Saves an entire Static Training Pack (metadata + all items) into the IndexedDB VFS.
 */
export async function saveStaticTrainingPackFull(
  metadata: StaticTrainingPackMetadata,
  items: StaticTrainingShotItem[]
): Promise<void> {
  await vfsDeleteByUuid(metadata.uuid);
  const now = Date.now();
  const normalizedItems = items.map((item, idx) => {
    const cloned = cloneShotItem(item, idx);
    cloned.index = idx;
    return cloned;
  });

  const updatedMeta: StaticTrainingPackMetadata = {
    ...metadata,
    itemCount: normalizedItems.length,
    updatedAt: now,
  };

  const nodes: VfsNodeRecord[] = [
    {
      path: buildMetaPath(updatedMeta.uuid),
      category: 'static-training-pack',
      uuid: updatedMeta.uuid,
      nodeType: 'metadata',
      updatedAt: now,
      data: updatedMeta,
    },
    ...normalizedItems.map((it, idx) => ({
      path: buildItemPath(updatedMeta.uuid, idx),
      category: 'static-training-pack' as const,
      uuid: updatedMeta.uuid,
      nodeType: 'item' as const,
      index: idx,
      updatedAt: now,
      data: it,
    })),
  ];

  await vfsPutNodes(nodes);
}

/**
 * Commits a single edited shot item (upon exiting Item Edit Mode) to IndexedDB VFS.
 */
export async function saveSingleStaticTrainingShotItem(
  uuid: string,
  index: number,
  item: StaticTrainingShotItem,
  metadata?: StaticTrainingPackMetadata | null
): Promise<void> {
  const now = Date.now();
  const cloned = cloneShotItem(item, index);
  const nodes: VfsNodeRecord[] = [
    {
      path: buildItemPath(uuid, index),
      category: 'static-training-pack',
      uuid,
      nodeType: 'item',
      index,
      updatedAt: now,
      data: cloned,
    },
  ];

  if (metadata) {
    const updatedMeta: StaticTrainingPackMetadata = {
      ...metadata,
      updatedAt: now,
    };
    nodes.push({
      path: buildMetaPath(uuid),
      category: 'static-training-pack',
      uuid,
      nodeType: 'metadata',
      updatedAt: now,
      data: updatedMeta,
    });
  }

  await vfsPutNodes(nodes);
}

export async function deleteStaticTrainingPackByUuid(uuid: string): Promise<void> {
  await vfsDeleteByUuid(uuid);
}

/**
 * Imports a `.RCSPack` file (compressed or uncompressed JSON) and persists it into the VFS.
 */
export async function importStaticTrainingPackFromFile(
  file: File
): Promise<{ metadata: StaticTrainingPackMetadata; items: StaticTrainingShotItem[] }> {
  const { metadata, items } = await decodeRCSPackFilePayload(file);
  await saveStaticTrainingPackFull(metadata, items);
  return { metadata, items };
}
