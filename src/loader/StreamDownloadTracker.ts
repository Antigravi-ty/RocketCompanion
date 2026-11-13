/**
 * src/loader/StreamDownloadTracker.ts
 * High-precision asset download and byte-stream progress tracking subsystem.
 *
 * Provides:
 * 1. Byte-accurate ReadableStream chunk monitoring.
 * 2. Pre-download memory buffer cache for "download-first, parse-later" workflows.
 * 3. Dynamic total byte calculation and progress dispatch.
 */

import { resolveAssetPath } from '../utils/AssetResponseValidator.ts';
import type { StreamDownloadProgressInfo } from './types.ts';

export interface ExpectedAssetFileEstimate {
  url: string;
  size?: number;
}

export interface TrackedFileByteState {
  loaded: number;
  total: number;
}

export class StreamDownloadTracker {
  bufferCache: Map<string, ArrayBuffer>;
  loadedBytes: number;
  onProgressUpdate: ((info: StreamDownloadProgressInfo) => void) | null;
  totalBytes: number;
  trackedFiles: Map<string, TrackedFileByteState>;

  constructor(onProgressUpdate: ((info: StreamDownloadProgressInfo) => void) | null = null) {
    this.onProgressUpdate = onProgressUpdate;
    this.totalBytes = 0;
    this.loadedBytes = 0;
    this.trackedFiles = new Map<string, TrackedFileByteState>();
    this.bufferCache = new Map<string, ArrayBuffer>();
  }

  /**
   * Pre-register expected files to give an accurate initial estimate of total byte size.
   * @param {Array<{ url: string, size?: number }>} fileEstimates
   */
  registerExpectedFiles(fileEstimates: ReadonlyArray<ExpectedAssetFileEstimate> = []): void {
    for (const { url, size } of fileEstimates) {
      if (!url) continue;
      const resolvedUrl = resolveAssetPath(url);
      const initialSize = size && size > 0 ? size : 256 * 1024;
      this.trackedFiles.set(resolvedUrl, { loaded: 0, total: initialSize });
      this.totalBytes += initialSize;
    }
    this._notify();
  }

  /**
   * Fetches an asset with streaming byte progress and stores the ArrayBuffer in memory cache.
   * @param {string} rawUrl Resource URL
   * @param {RequestInit} [options]
   * @returns {Promise<ArrayBuffer>}
   */
  async fetchBuffer(rawUrl: string, options: RequestInit = {}): Promise<ArrayBuffer> {
    const url = resolveAssetPath(rawUrl);
    const cached = this.bufferCache.get(url);
    if (cached !== undefined) {
      return cached;
    }

    const maxAttempts = options.signal ? 1 : 3;
    let lastErr: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const requestUrl =
        attempt === 0
          ? url
          : `${url}${url.includes('?') ? '&' : '?'}__rc_retry=${attempt}_${Date.now()}`;
      const controller =
        !options.signal && typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 20000) : null;

      try {
        const res = await fetch(
          requestUrl,
          controller ? { ...options, signal: controller.signal } : options
        );
        if (!res.ok) {
          throw new Error(`[StreamDownloadTracker] HTTP ${res.status} fetching "${url}"`);
        }

        const contentLength = res.headers.get('content-length');
        const headerTotal = contentLength ? parseInt(contentLength, 10) : 0;
        let trackedEntry = this.trackedFiles.get(url);

        if (headerTotal > 0) {
          const prevEst = trackedEntry?.total || 0;
          this.totalBytes = this.totalBytes - prevEst + headerTotal;
          trackedEntry = { loaded: trackedEntry?.loaded || 0, total: headerTotal };
          this.trackedFiles.set(url, trackedEntry);
        } else if (!trackedEntry) {
          trackedEntry = { loaded: 0, total: 0 };
          this.trackedFiles.set(url, trackedEntry);
        }

        if (!res.body || typeof res.body.getReader !== 'function') {
          const buffer = await res.arrayBuffer();
          const actualSize = buffer.byteLength;
          if (!headerTotal) {
            const prevEst = trackedEntry.total || 0;
            this.totalBytes = this.totalBytes - prevEst + actualSize;
          }
          const delta = actualSize - trackedEntry.loaded;
          trackedEntry.loaded = actualSize;
          trackedEntry.total = actualSize;
          this.loadedBytes += delta;
          this.bufferCache.set(url, buffer);
          this._notify(url, actualSize, actualSize);
          return buffer;
        }

        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        const activeTotal = headerTotal || trackedEntry.total || 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;

            const prevLoaded = trackedEntry.loaded || 0;
            const delta = received - prevLoaded;
            trackedEntry.loaded = received;
            if (!headerTotal && received > trackedEntry.total) {
              this.totalBytes += received - trackedEntry.total;
              trackedEntry.total = received;
            }
            this.loadedBytes += delta;

            this._notify(url, received, activeTotal || trackedEntry.total);
          }
        } finally {
          reader.releaseLock();
        }

        const fullBuffer = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          fullBuffer.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const arrayBuffer = fullBuffer.buffer;
        this.bufferCache.set(url, arrayBuffer);
        return arrayBuffer;
      } catch (err) {
        lastErr = err;
        if (attempt + 1 < maxAttempts) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Retrieves a previously downloaded buffer from cache.
   * @param {string} url
   * @returns {ArrayBuffer|null}
   */
  getCachedBuffer(url: string): ArrayBuffer | null {
    return this.bufferCache.get(url) || null;
  }

  /**
   * Checks whether a given buffer is already downloaded.
   * @param {string} url
   * @returns {boolean}
   */
  hasCachedBuffer(url: string): boolean {
    return this.bufferCache.has(url);
  }

  /**
   * Releases cached ArrayBuffers to free memory after all initialization completes.
   */
  clearCache(): void {
    this.bufferCache.clear();
  }

  _notify(activeUrl = '', currentLoaded = 0, currentTotal = 0): void {
    if (!this.onProgressUpdate) return;
    const overallRatio = this.totalBytes > 0 ? Math.min(1, this.loadedBytes / this.totalBytes) : 0;
    this.onProgressUpdate({
      overallRatio,
      loadedBytes: this.loadedBytes,
      totalBytes: this.totalBytes,
      activeUrl,
      currentLoaded,
      currentTotal,
    });
  }
}
