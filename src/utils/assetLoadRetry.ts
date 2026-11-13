import type { Texture, TextureLoader } from 'three';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface AssetRetryOptions {
  timeoutMs?: number;
  maxAttempts?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Asset load timed out after ${timeoutMs}ms: "${label}"`));
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function appendRetryParam(url: string, attempt: number): string {
  if (attempt <= 1) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}__rc_retry=${attempt}_${Date.now()}`;
}

export async function loadGltfWithRetry(
  loader: GLTFLoader,
  url: string,
  options: AssetRetryOptions = {}
): Promise<GLTF> {
  const timeoutMs = options.timeoutMs ?? 12000;
  const maxAttempts = options.maxAttempts ?? 2;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const targetUrl = appendRetryParam(url, attempt);
    try {
      return await withTimeout(loader.loadAsync(targetUrl), timeoutMs, url);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to load GLTF: "${url}"`);
}

export async function loadTextureWithRetry(
  loader: TextureLoader,
  url: string,
  options: AssetRetryOptions = {}
): Promise<Texture> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxAttempts = options.maxAttempts ?? 2;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const targetUrl = appendRetryParam(url, attempt);
    try {
      return await withTimeout(loader.loadAsync(targetUrl), timeoutMs, url);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to load texture: "${url}"`);
}
