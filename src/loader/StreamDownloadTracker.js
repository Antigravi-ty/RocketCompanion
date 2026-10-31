/**
 * src/loader/StreamDownloadTracker.js
 * High-precision asset download and byte-stream progress tracking subsystem.
 *
 * Provides:
 * 1. Byte-accurate ReadableStream chunk monitoring.
 * 2. Pre-download memory buffer cache for "download-first, parse-later" workflows.
 * 3. Dynamic total byte calculation and progress dispatch.
 */

import { resolveAssetPath } from '../utils/AssetResponseValidator.js';

export class StreamDownloadTracker {
  constructor(onProgressUpdate = null) {
    this.onProgressUpdate = onProgressUpdate;
    this.totalBytes = 0;
    this.loadedBytes = 0;
    this.trackedFiles = new Map();
    this.bufferCache = new Map();
  }

  /**
   * Pre-register expected files to give an accurate initial estimate of total byte size.
   * @param {Array<{ url: string, size?: number }>} fileEstimates
   */
  registerExpectedFiles(fileEstimates = []) {
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
  async fetchBuffer(rawUrl, options = {}) {
    const url = resolveAssetPath(rawUrl);
    if (this.bufferCache.has(url)) {
      return this.bufferCache.get(url);
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`[StreamDownloadTracker] HTTP ${res.status} fetching "${url}"`);
    }

    const contentLength = res.headers.get('content-length');
    const headerTotal = contentLength ? parseInt(contentLength, 10) : 0;
    const existing = this.trackedFiles.get(url);

    if (headerTotal > 0) {
      const prevEst = existing?.total || 0;
      this.totalBytes = this.totalBytes - prevEst + headerTotal;
      this.trackedFiles.set(url, { loaded: existing?.loaded || 0, total: headerTotal });
    }

    // Fallback if ReadableStream is unavailable
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buffer = await res.arrayBuffer();
      const actualSize = buffer.byteLength;
      if (!headerTotal) {
        const prevEst = existing?.total || 0;
        this.totalBytes = this.totalBytes - prevEst + actualSize;
      }
      this.loadedBytes += actualSize;
      this.trackedFiles.set(url, { loaded: actualSize, total: actualSize });
      this.bufferCache.set(url, buffer);
      this._notify(url, actualSize, actualSize);
      return buffer;
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    const activeTotal = headerTotal || existing?.total || 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;

        const prevLoaded = existing?.loaded || 0;
        const delta = received - prevLoaded;
        if (existing) existing.loaded = received;
        this.loadedBytes += delta;

        this._notify(url, received, activeTotal);
      }
    } finally {
      reader.releaseLock();
    }

    // Concatenate chunks into contiguous ArrayBuffer
    const fullBuffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      fullBuffer.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const arrayBuffer = fullBuffer.buffer;
    this.bufferCache.set(url, arrayBuffer);
    return arrayBuffer;
  }

  /**
   * Retrieves a previously downloaded buffer from cache.
   * @param {string} url
   * @returns {ArrayBuffer|null}
   */
  getCachedBuffer(url) {
    return this.bufferCache.get(url) || null;
  }

  /**
   * Checks whether a given buffer is already downloaded.
   * @param {string} url
   * @returns {boolean}
   */
  hasCachedBuffer(url) {
    return this.bufferCache.has(url);
  }

  /**
   * Releases cached ArrayBuffers to free memory after all initialization completes.
   */
  clearCache() {
    this.bufferCache.clear();
  }

  _notify(activeUrl = '', currentLoaded = 0, currentTotal = 0) {
    if (!this.onProgressUpdate) return;
    const overallRatio = this.totalBytes > 0 ? Math.min(1, this.loadedBytes / this.totalBytes) : 0;
    this.onProgressUpdate({
      overallRatio,
      loadedBytes: this.loadedBytes,
      totalBytes: this.totalBytes,
      activeUrl,
      currentLoaded,
      currentTotal
    });
  }
}
