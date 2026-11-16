export function isFastestModeEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get('fastest') === '1';
}
