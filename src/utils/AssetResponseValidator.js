/**
 * AssetResponseValidator.js
 * Pure HTTP/Fetch asset path resolution and response validation utility with zero dependency on game or audio layers.
 */

export function resolveAssetPath(path) {
  if (!path) return '';
  if (/^(?:https?:|\/\/|blob:|data:)/.test(path)) return path;
  const base =
    (typeof window !== 'undefined' && window.__ASSET_BASE__) ||
    (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) ||
    '';
  const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return cleanBase ? cleanBase + cleanPath : cleanPath;
}

export function validateAssetResponse(res, url, expectedType = 'binary') {
  const contentType = res.headers.get('content-type') || '';
  const isHtml = contentType.toLowerCase().includes('text/html');
  const isMissingHeader = Boolean(res.headers.get('x-asset-missing'));

  if (!res.ok || isHtml || isMissingHeader) {
    let reason = `HTTP ${res.status} ${res.statusText || ''}`.trim();
    if (isHtml) {
      reason += ' (Server returned text/html SPA fallback — file does not exist on disk)';
    }
    const error = new Error(`[Asset Missing] Failed to load "${url}": ${reason}`);
    error.assetUrl = url;
    error.status = res.status;
    error.isAssetError = true;
    error.isHtmlFallback = isHtml;
    return { ok: false, error, reason };
  }

  return { ok: true, error: null };
}

export function formatMatchTime(seconds, ceil = false) {
  const t = Math.max(0, ceil ? Math.ceil(seconds) : Math.floor(seconds));
  const m = Math.floor(t / 60);
  const s = String(t % 60).padStart(2, '0');
  return `${m}:${s}`;
}
