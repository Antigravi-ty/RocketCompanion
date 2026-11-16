import fs from 'node:fs';
import { resolve } from 'node:path';
import { readCompositeGitHeadState, REPO_ROOT_DIR } from './gitHeadState.ts';

export interface GitCheckoutEvent {
  eventId: string;
  timestamp: number;
  hook: 'post-checkout' | 'post-merge' | 'post-rewrite';
  prevHead: string;
  nextHead: string;
  tauriChanged: boolean;
  depsChanged: boolean;
}

export const CHECKOUT_EVENT_REL_PATH = '.cache/git-checkout-event.json';

export function getCheckoutEventPath(rootDir: string = REPO_ROOT_DIR): string {
  return resolve(rootDir, CHECKOUT_EVENT_REL_PATH);
}

export function readGitCheckoutEvent(rootDir: string = REPO_ROOT_DIR): GitCheckoutEvent | null {
  try {
    const filePath = getCheckoutEventPath(rootDir);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GitCheckoutEvent>;
    if (!parsed || typeof parsed.eventId !== 'string') return null;
    return {
      eventId: parsed.eventId,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
      hook:
        parsed.hook === 'post-merge' || parsed.hook === 'post-rewrite'
          ? parsed.hook
          : 'post-checkout',
      prevHead: typeof parsed.prevHead === 'string' ? parsed.prevHead : '',
      nextHead: typeof parsed.nextHead === 'string' ? parsed.nextHead : '',
      tauriChanged: Boolean(parsed.tauriChanged),
      depsChanged: Boolean(parsed.depsChanged),
    };
  } catch {
    return null;
  }
}

export function isCheckoutLockActive(rootDir: string = REPO_ROOT_DIR): boolean {
  return readCompositeGitHeadState(rootDir).locked;
}

export function ensureCacheDir(rootDir: string = REPO_ROOT_DIR): string {
  const cacheDir = resolve(rootDir, '.cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}
