import { computeCombinedVisualAstHash } from '../../../ui-core/manifest/visualFileHash';

const liveFileHashMap = new Map<string, string>();
const hashListeners = new Set<() => void>();
let hasLoadedHashes = false;
let inFlightFetch: Promise<boolean> | null = null;

function notifyHashListeners(): void {
  for (const listener of hashListeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors
    }
  }
}

export function subscribeLiveSubtreeHashes(listener: () => void): () => void {
  hashListeners.add(listener);
  return () => {
    hashListeners.delete(listener);
  };
}

export function ensureLiveSubtreeHashesLoaded(): Promise<boolean> {
  if (hasLoadedHashes) return Promise.resolve(false);
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return Promise.resolve(false);
  }
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = fetch('/__rc_ui_core_hashes', { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) return false;
      const payload = (await res.json()) as { hashes?: Record<string, string> };
      if (!payload?.hashes || typeof payload.hashes !== 'object') return false;
      liveFileHashMap.clear();
      for (const [fileRel, hash] of Object.entries(payload.hashes)) {
        if (typeof hash === 'string') {
          liveFileHashMap.set(fileRel, hash);
        }
      }
      hasLoadedHashes = true;
      notifyHashListeners();
      return true;
    })
    .catch(() => false)
    .finally(() => {
      inFlightFetch = null;
    });

  return inFlightFetch;
}

if (import.meta.hot) {
  import.meta.hot.on(
    'rc-ui-tuner:ui-core-hashes-updated',
    (data: { file?: string; hash?: string | null }) => {
      if (!data?.file) return;
      if (typeof data.hash === 'string') {
        liveFileHashMap.set(data.file, data.hash);
      } else {
        liveFileHashMap.delete(data.file);
      }
      hasLoadedHashes = true;
      notifyHashListeners();
    }
  );
}

export function getLiveFileVisualHash(fileRel: string): string | undefined {
  if (!hasLoadedHashes) {
    void ensureLiveSubtreeHashesLoaded();
  }
  const cleanRel = fileRel.startsWith('src/') ? fileRel : `src/ui-core/${fileRel}`;
  return liveFileHashMap.get(cleanRel);
}

/**
 * Compares recorded `fileVisualHashes` in `uiApprovalLedger.json` against the
 * current on-disk source files fetched from `/__rc_ui_core_hashes`.
 */
export function detectChangedSubtreeFiles(
  recordedHashes?: Record<string, string>
): string[] {
  if (!hasLoadedHashes) {
    void ensureLiveSubtreeHashesLoaded();
  }
  if (!recordedHashes || liveFileHashMap.size === 0) return [];
  const changed: string[] = [];
  for (const [fileRel, recordedHash] of Object.entries(recordedHashes)) {
    const liveHash = liveFileHashMap.get(fileRel);
    if (liveHash && liveHash !== recordedHash) {
      changed.push(fileRel);
    }
  }
  return changed.sort();
}

/**
 * Computes a combined fingerprint of all live files in a surface/variant's subtree
 * so runtime decisions stored in `localStorage` automatically invalidate if any
 * file in the surface's subtree is edited on disk.
 */
export function computeLiveSubtreeCombinedHash(
  recordedHashes?: Record<string, string>,
  fallbackEntryFile?: string
): string {
  if (!hasLoadedHashes) {
    void ensureLiveSubtreeHashesLoaded();
  }
  const liveMap: Record<string, string> = {};
  if (recordedHashes) {
    for (const [fileRel, recordedHash] of Object.entries(recordedHashes)) {
      liveMap[fileRel] = liveFileHashMap.get(fileRel) ?? recordedHash;
    }
  }
  if (fallbackEntryFile) {
    const cleanRel = fallbackEntryFile.startsWith('src/')
      ? fallbackEntryFile
      : `src/ui-core/${fallbackEntryFile}`;
    const liveEntry = liveFileHashMap.get(cleanRel);
    if (liveEntry) {
      liveMap[cleanRel] = liveEntry;
    }
  }
  return computeCombinedVisualAstHash(liveMap);
}
