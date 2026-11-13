import type { Texture, TextureLoader } from 'three';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface RetryLoadOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

function appendRetryParam(url: string, attempt: number): string {
  if (attempt <= 0) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}__rc_retry=${attempt}_${Date.now()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);

    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function fetchWithTimeoutAndRetry(
  url: string,
  init: RequestInit = {},
  options: RetryLoadOptions = {}
): Promise<Response> {
  const { timeoutMs = 15000, retries = 2, retryDelayMs = 250 } = options;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const targetUrl = appendRetryParam(url, attempt);
    const controller =
      !init.signal && typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const res = await fetch(
        targetUrl,
        controller ? { ...init, signal: controller.signal } : init
      );
      if (timer) clearTimeout(timer);
      return res;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await delay(retryDelayMs * (attempt + 1));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function loadGltfWithTimeoutAndRetry(
  loader: GLTFLoader,
  url: string,
  options: RetryLoadOptions = {}
): Promise<GLTF> {
  const { timeoutMs = 20000, retries = 2, retryDelayMs = 300 } = options;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const targetUrl = appendRetryParam(url, attempt);
    try {
      return await withTimeout(loader.loadAsync(targetUrl), timeoutMs, targetUrl);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await delay(retryDelayMs * (attempt + 1));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function loadTextureWithTimeoutAndRetry(
  loader: TextureLoader,
  url: string,
  options: RetryLoadOptions = {}
): Promise<Texture> {
  const { timeoutMs = 10000, retries = 2, retryDelayMs = 250 } = options;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const targetUrl = appendRetryParam(url, attempt);
    try {
      return await withTimeout(loader.loadAsync(targetUrl), timeoutMs, targetUrl);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await delay(retryDelayMs * (attempt + 1));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
