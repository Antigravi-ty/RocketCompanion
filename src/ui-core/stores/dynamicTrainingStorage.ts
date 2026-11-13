import type { RCDPack, StateSession } from '../config/dynamicTrainingPackTypes.ts';

const DB_NAME = 'rc-dynamic-training-db';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_PACKS = 'packs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PACKS)) {
        db.createObjectStore(STORE_PACKS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

function txPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function loadAllRcdData(): Promise<{
  packs: RCDPack[];
  sessions: StateSession[];
}> {
  try {
    const db = await openDb();
    const tx = db.transaction([STORE_PACKS, STORE_SESSIONS], 'readonly');
    const [packs, sessions] = await Promise.all([
      txPromise<RCDPack[]>(tx.objectStore(STORE_PACKS).getAll()),
      txPromise<StateSession[]>(tx.objectStore(STORE_SESSIONS).getAll()),
    ]);
    db.close();
    return { packs: packs ?? [], sessions: sessions ?? [] };
  } catch {
    return { packs: [], sessions: [] };
  }
}

export async function putRcdPack(pack: RCDPack): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_PACKS, 'readwrite');
    await txPromise(tx.objectStore(STORE_PACKS).put(pack));
    db.close();
  } catch {
    // Ignore storage errors in headless/private environments
  }
}

export async function removeRcdPack(packId: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_PACKS, 'readwrite');
    await txPromise(tx.objectStore(STORE_PACKS).delete(packId));
    db.close();
  } catch {
    // Ignore storage errors
  }
}

export async function putStateSession(session: StateSession): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    await txPromise(tx.objectStore(STORE_SESSIONS).put(session));
    db.close();
  } catch {
    // Ignore storage errors
  }
}

export async function removeStateSession(sessionId: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_SESSIONS, 'readwrite');
    await txPromise(tx.objectStore(STORE_SESSIONS).delete(sessionId));
    db.close();
  } catch {
    // Ignore storage errors
  }
}
