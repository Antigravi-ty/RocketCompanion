import {
  DYNAMIC_TRAINING_DEFAULT_FOLDER,
  generateDynamicUuid,
  relinkDynamicShotChain,
  sortDynamicShotsByPrevLink,
  summarizeDynamicStateSession,
  type DynamicTrainingPackRecord,
  type DynamicTrainingShotRef,
  type DynamicTrainingShotStats,
  type DynamicTrainingStateSession,
  type DynamicTrainingStateSessionSummary,
} from '../config/dynamicTrainingPackTypes';

const DB_NAME = 'rc-dynamic-training-db';
const DB_VERSION = 1;
const STORE_SESSIONS = 'state_sessions';
const STORE_PACKS = 'dynamic_packs';
const STORE_STATS = 'shot_stats';

const memSessions = new Map<string, DynamicTrainingStateSession>();
const memPacks = new Map<string, DynamicTrainingPackRecord>();
const memStats = new Map<string, DynamicTrainingShotStats>();

function openDynamicDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains(STORE_PACKS)) {
          db.createObjectStore(STORE_PACKS, { keyPath: 'metadata.uuid' });
        }
        if (!db.objectStoreNames.contains(STORE_STATS)) {
          db.createObjectStore(STORE_STATS, { keyPath: 'shotId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openDynamicDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as T) ?? null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function idbPut<T>(storeName: string, value: T): Promise<void> {
  const db = await openDynamicDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDynamicDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDynamicDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        db.close();
        resolve(Array.isArray(req.result) ? (req.result as T[]) : []);
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}

export async function saveDynamicStateSession(session: DynamicTrainingStateSession): Promise<void> {
  memSessions.set(session.sessionId, session);
  await idbPut(STORE_SESSIONS, session);
}

export async function loadDynamicStateSession(
  sessionId: string
): Promise<DynamicTrainingStateSession | null> {
  const cached = memSessions.get(sessionId);
  if (cached) return cached;
  const fromDb = await idbGet<DynamicTrainingStateSession>(STORE_SESSIONS, sessionId);
  if (fromDb) memSessions.set(sessionId, fromDb);
  return fromDb;
}

export async function listDynamicStateSessionSummaries(): Promise<
  DynamicTrainingStateSessionSummary[]
> {
  const fromDb = await idbGetAll<DynamicTrainingStateSession>(STORE_SESSIONS);
  for (const s of fromDb) memSessions.set(s.sessionId, s);
  return Array.from(memSessions.values())
    .map(summarizeDynamicStateSession)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDynamicStateSession(sessionId: string): Promise<void> {
  memSessions.delete(sessionId);
  await idbDelete(STORE_SESSIONS, sessionId);
}

export async function saveDynamicPack(pack: DynamicTrainingPackRecord): Promise<DynamicTrainingPackRecord> {
  const orderedShots = relinkDynamicShotChain(sortDynamicShotsByPrevLink(pack.shots));
  const normalized: DynamicTrainingPackRecord = {
    metadata: {
      ...pack.metadata,
      updatedAt: Date.now(),
      itemCount: orderedShots.length,
    },
    shots: orderedShots,
  };
  memPacks.set(normalized.metadata.uuid, normalized);
  await idbPut(STORE_PACKS, normalized);
  return normalized;
}

export async function loadDynamicPack(uuid: string): Promise<DynamicTrainingPackRecord | null> {
  const cached = memPacks.get(uuid);
  if (cached) return cached;
  const fromDb = await idbGet<DynamicTrainingPackRecord>(STORE_PACKS, uuid);
  if (fromDb) memPacks.set(uuid, fromDb);
  return fromDb;
}

export async function listDynamicPacks(): Promise<DynamicTrainingPackRecord[]> {
  const fromDb = await idbGetAll<DynamicTrainingPackRecord>(STORE_PACKS);
  for (const p of fromDb) memPacks.set(p.metadata.uuid, p);
  return Array.from(memPacks.values()).sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
}

export async function deleteDynamicPack(uuid: string): Promise<void> {
  memPacks.delete(uuid);
  await idbDelete(STORE_PACKS, uuid);
}

export async function ensureCapturedFromReplayPack(): Promise<DynamicTrainingPackRecord> {
  const all = await listDynamicPacks();
  const existing = all.find((p) => p.metadata.folder === DYNAMIC_TRAINING_DEFAULT_FOLDER);
  if (existing) return existing;
  const now = Date.now();
  const fresh: DynamicTrainingPackRecord = {
    metadata: {
      uuid: generateDynamicUuid(),
      title: 'Captured From Replay',
      description: 'Dynamic training shots captured via Intervene From Here.',
      folder: DYNAMIC_TRAINING_DEFAULT_FOLDER,
      creator: 'Local',
      tags: ['replay-capture'],
      createdAt: now,
      updatedAt: now,
      itemCount: 0,
    },
    shots: [],
  };
  return saveDynamicPack(fresh);
}

export async function moveDynamicShotBetweenPacks(
  sourcePackUuid: string,
  targetPackUuid: string,
  shotId: string
): Promise<void> {
  if (sourcePackUuid === targetPackUuid) return;
  const src = await loadDynamicPack(sourcePackUuid);
  const dst = await loadDynamicPack(targetPackUuid);
  if (!src || !dst) return;
  const shot = src.shots.find((s) => s.id === shotId);
  if (!shot) return;

  await saveDynamicPack({
    metadata: src.metadata,
    shots: src.shots.filter((s) => s.id !== shotId),
  });
  const movedShot: DynamicTrainingShotRef = {
    ...shot,
    prevShotId: dst.shots.length > 0 ? dst.shots[dst.shots.length - 1].id : null,
  };
  await saveDynamicPack({
    metadata: dst.metadata,
    shots: [...dst.shots, movedShot],
  });
}

export async function duplicateDynamicShotToPack(
  sourcePackUuid: string,
  targetPackUuid: string,
  shotId: string
): Promise<DynamicTrainingShotRef | null> {
  const src = await loadDynamicPack(sourcePackUuid);
  const dst = await loadDynamicPack(targetPackUuid);
  if (!src || !dst) return null;
  const shot = src.shots.find((s) => s.id === shotId);
  if (!shot) return null;

  const copy: DynamicTrainingShotRef = {
    ...shot,
    id: generateDynamicUuid(),
    name: `${shot.name} (Copy)`,
    prevShotId: dst.shots.length > 0 ? dst.shots[dst.shots.length - 1].id : null,
  };
  await saveDynamicPack({
    metadata: dst.metadata,
    shots: [...dst.shots, copy],
  });
  return copy;
}

export async function countSessionReferencesAcrossPacks(sessionId: string): Promise<number> {
  const packs = await listDynamicPacks();
  let count = 0;
  for (const p of packs) {
    for (const s of p.shots) {
      if (s.sessionId === sessionId) count++;
    }
  }
  return count;
}

export async function saveDynamicShotStats(
  shotId: string,
  stats: DynamicTrainingShotStats
): Promise<void> {
  memStats.set(shotId, stats);
  await idbPut(STORE_STATS, { shotId, ...stats });
}

export async function loadAllDynamicShotStats(): Promise<Record<string, DynamicTrainingShotStats>> {
  const rows = await idbGetAll<DynamicTrainingShotStats & { shotId: string }>(STORE_STATS);
  for (const row of rows) {
    const { shotId, ...rest } = row;
    memStats.set(shotId, rest);
  }
  const out: Record<string, DynamicTrainingShotStats> = {};
  for (const [k, v] of memStats.entries()) out[k] = v;
  return out;
}
