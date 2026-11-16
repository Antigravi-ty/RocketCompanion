import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT_DIR } from './gitHeadState.ts';

const HOOK_FILES = ['post-checkout', 'post-merge', 'post-rewrite'];

export function ensureGitHooks(rootDir: string = REPO_ROOT_DIR): boolean {
  const gitDir = resolve(rootDir, '.git');
  const hooksDir = resolve(rootDir, '.githooks');
  if (!fs.existsSync(gitDir) || !fs.existsSync(hooksDir)) {
    return false;
  }

  let configured = false;
  try {
    const current = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (current !== '.githooks') {
      execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
        cwd: rootDir,
        stdio: 'ignore',
      });
      configured = true;
    }
  } catch {
    try {
      execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
        cwd: rootDir,
        stdio: 'ignore',
      });
      configured = true;
    } catch {
      return false;
    }
  }

  if (process.platform !== 'win32') {
    for (const name of HOOK_FILES) {
      const hookPath = resolve(hooksDir, name);
      if (fs.existsSync(hookPath)) {
        try {
          fs.chmodSync(hookPath, 0o755);
        } catch {
          // Ignore chmod errors on read-only filesystems
        }
      }
    }
  }

  return configured;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const changed = ensureGitHooks();
  if (changed) {
    console.log('[git-hooks] Configured git core.hooksPath -> .githooks');
  }
}
