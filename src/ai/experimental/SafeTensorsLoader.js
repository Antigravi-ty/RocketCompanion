/**
 * SafeTensorsLoader.js
 * Zero-dependency, zero-copy SafeTensors binary format parser and weight cache
 * for native Web (TypedArray) neural network policy inference.
 *
 * SafeTensors specification:
 * - Bytes [0..7]: uint64 little-endian byte length N of the UTF-8 JSON header
 * - Bytes [8..8+N-1]: UTF-8 JSON object mapping tensor names to { dtype, shape, data_offsets: [start, end] }
 * - Bytes [8+N..]: Contiguous little-endian tensor data buffer
 */

import { validateAssetResponse, resolveAssetPath } from '../../utils/AssetResponseValidator.js';

export const EXPERIMENTAL_MODEL_URLS = Object.freeze({
  necto: '/assets/models/experimental/necto_policy.safetensors',
  nexto: '/assets/models/experimental/nexto_policy.safetensors',
  ko_v2: '/assets/models/experimental/kickoff_v2_policy.safetensors',
  ko_v1: '/assets/models/experimental/kickoff_v1_policy.safetensors',
});

const _modelCache = new Map();
const _loadingPromises = new Map();

/**
 * Parses an ArrayBuffer in SafeTensors format into zero-copy Float32Array views.
 * @param {ArrayBuffer} buffer
 * @returns {{ metadata: Object, tensors: Object<string, { shape: number[], dtype: string, data: Float32Array }> }}
 */
export function parseSafeTensorsBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) {
    throw new Error(`[SafeTensorsLoader] Invalid buffer (byteLength=${buffer?.byteLength ?? 0}).`);
  }

  const view = new DataView(buffer);
  const headerLenLow = view.getUint32(0, true);
  const headerLenHigh = view.getUint32(4, true);
  if (headerLenHigh !== 0 || headerLenLow <= 0 || 8 + headerLenLow > buffer.byteLength) {
    throw new Error(`[SafeTensorsLoader] Corrupt SafeTensors header length: ${headerLenLow}.`);
  }

  const headerBytes = new Uint8Array(buffer, 8, headerLenLow);
  const headerStr = new TextDecoder('utf-8').decode(headerBytes).trim();
  const headerJson = JSON.parse(headerStr);

  const dataBaseOffset = 8 + headerLenLow;
  const metadata = headerJson.__metadata__ || {};
  const tensors = {};

  for (const [name, info] of Object.entries(headerJson)) {
    if (name === '__metadata__') continue;
    const { dtype, shape, data_offsets: offsets } = info;
    if (!Array.isArray(offsets) || offsets.length !== 2) {
      throw new Error(`[SafeTensorsLoader] Missing data_offsets for tensor "${name}".`);
    }
    const startByte = dataBaseOffset + offsets[0];
    const endByte = dataBaseOffset + offsets[1];
    const byteLength = endByte - startByte;

    if (startByte < dataBaseOffset || endByte > buffer.byteLength || byteLength < 0) {
      throw new Error(`[SafeTensorsLoader] Out-of-bounds offsets for tensor "${name}".`);
    }

    if (dtype === 'F32') {
      const floatCount = byteLength / 4;
      const data =
        startByte % 4 === 0
          ? new Float32Array(buffer, startByte, floatCount)
          : new Float32Array(buffer.slice(startByte, endByte));
      tensors[name] = { shape, dtype, data };
    }
  }

  return { metadata, tensors };
}

/**
 * Loads and caches a SafeTensors policy file by model ID ('necto' | 'nexto') or URL.
 * @param {'necto'|'nexto'} modelId
 * @param {string} [customUrl]
 */
export async function loadExperimentalPolicySafeTensors(modelId, customUrl = null) {
  const rawUrl = customUrl || EXPERIMENTAL_MODEL_URLS[modelId];
  if (!rawUrl) {
    throw new Error(`[SafeTensorsLoader] Unknown experimental modelId "${modelId}".`);
  }
  const url = resolveAssetPath(rawUrl);

  if (_modelCache.has(modelId)) {
    return _modelCache.get(modelId);
  }
  if (_loadingPromises.has(modelId)) {
    return _loadingPromises.get(modelId);
  }

  const promise = (async () => {
    try {
      if (typeof fetch === 'function') {
        const res = await fetch(url);
        const check = validateAssetResponse(res, url, 'binary');
        if (!check.ok) {
          throw check.error;
        }
        const buf = await res.arrayBuffer();
        const parsed = parseSafeTensorsBuffer(buf);
        _modelCache.set(modelId, parsed);
        return parsed;
      }
      throw new Error('[SafeTensorsLoader] Global fetch API is unavailable.');
    } finally {
      _loadingPromises.delete(modelId);
    }
  })();

  _loadingPromises.set(modelId, promise);
  return promise;
}

/**
 * Injects a pre-parsed SafeTensors object into the runtime cache (useful for Node/headless verification).
 * @param {'necto'|'nexto'} modelId
 * @param {Object} parsedSafeTensors
 */
export function registerCachedSafeTensors(modelId, parsedSafeTensors) {
  _modelCache.set(modelId, parsedSafeTensors);
}

/**
 * Synchronously retrieves cached SafeTensors weights if already loaded.
 * @param {'necto'|'nexto'} modelId
 */
export function getCachedSafeTensors(modelId) {
  return _modelCache.get(modelId) || null;
}
