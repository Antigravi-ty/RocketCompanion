#!/usr/bin/env node
/**
 * scripts/env/tmpfsGuard.mjs
 *
 * Manages tmpfs offloading (/tmp/rc-cache) to keep OverlayFS footprint minimal,
 * writes/verifies /tmp/.rc-env-sentinel, detects container snapshot /tmp resets,
 * prints actionable restore commands, and supports --auto-restore.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CACHE_ROOT = process.env.RC_TMPFS_CACHE_DIR || '/tmp/rc-cache';
export const SENTINEL_PATH = process.env.RC_TMPFS_SENTINEL || '/tmp/.rc-env-sentinel';
export const DEFAULT_REPLAY_FIXTURE = '/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay';
export const PNPM_VERSION = process.env.RC_PNPM_VERSION || '10.28.2';
export const OVERLAY_BUDGET_MB = Number(process.env.RC_OVERLAY_BUDGET_MB || 100);

export function sanitizeNodeOptions(nodeOptions = process.env.NODE_OPTIONS || '') {
  return String(nodeOptions)
    .replace(/(?:^|\s)(?:--require|-r)(?:=|\s+)global-agent\/bootstrap(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getPnpmEnv(baseEnv = process.env, cacheRoot = DEFAULT_CACHE_ROOT) {
  const env = { ...baseEnv };
  const cleanedNodeOpts = sanitizeNodeOptions(env.NODE_OPTIONS || '');
  if (cleanedNodeOpts) {
    env.NODE_OPTIONS = cleanedNodeOpts;
  } else {
    delete env.NODE_OPTIONS;
  }
  env.npm_config_update_notifier = 'false';
  env.pnpm_config_update_notifier = 'false';
  env.NO_UPDATE_NOTIFIER = '1';
  env.npm_config_store_dir = env.npm_config_store_dir || path.join(cacheRoot, 'pnpm-store');
  env.npm_config_cache_dir = env.npm_config_cache_dir || path.join(cacheRoot, 'pnpm-cache');
  env.XDG_CACHE_HOME = env.XDG_CACHE_HOME || path.join(cacheRoot, 'xdg-cache');
  env.XDG_DATA_HOME = env.XDG_DATA_HOME || path.join(cacheRoot, 'xdg-data');
  env.XDG_STATE_HOME = env.XDG_STATE_HOME || path.join(cacheRoot, 'xdg-state');
  return env;
}

export function hasPopulatedDir(dirPath, ignoreNames = new Set(['.vite', '.cache'])) {
  try {
    if (!fs.existsSync(dirPath)) return false;
    const entries = fs.readdirSync(dirPath);
    return entries.some((name) => !ignoreNames.has(name));
  } catch {
    return false;
  }
}

export function hasPopulatedNodeModules(repoRoot) {
  const nmDir = path.join(repoRoot, 'node_modules');
  return (
    fs.existsSync(path.join(nmDir, '.modules.yaml')) &&
    hasPopulatedDir(nmDir)
  );
}

export function getManagedSymlinks(repoRoot, cacheRoot = DEFAULT_CACHE_ROOT) {
  const entries = [
    { rel: 'node_modules', target: path.join(cacheRoot, 'node_modules'), required: true },
    { rel: 'node_modules/.vite', target: path.join(cacheRoot, 'vite-cache'), required: false, parentMustExist: true },
    { rel: '.vite', target: path.join(cacheRoot, 'vite-cache'), required: false },
    { rel: 'dist', target: path.join(cacheRoot, 'dist'), required: false },
    { rel: 'public', target: path.join(cacheRoot, 'public'), required: true, isSubmodule: true },
  ];
  if (fs.existsSync(path.join(repoRoot, 'src-tauri'))) {
    entries.push({ rel: 'src-tauri/target', target: path.join(cacheRoot, 'tauri-target'), required: false });
  }
  if (fs.existsSync(path.join(repoRoot, 'crates'))) {
    entries.push({ rel: 'crates/target', target: path.join(cacheRoot, 'wasm-target'), required: false });
  }
  return entries;
}

export function measureDirSizeMB(dirPath) {
  try {
    // du -sm does not follow symlinks (-P is default), so symlinked /tmp targets count ~0 MB on OverlayFS
    const out = execFileSync('du', ['-sm', dirPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const first = Number(out.split(/\s+/)[0]);
    return Number.isFinite(first) ? first : null;
  } catch {
    return null;
  }
}

export function getBaselinePath(repoRoot) {
  return path.join(repoRoot, '.git', 'rc-overlay-baseline.json');
}

export function readBaseline(repoRoot) {
  const p = getBaselinePath(repoRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function recordBaselineIfMissing(repoRoot) {
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) return null;
  const p = getBaselinePath(repoRoot);
  const existing = readBaseline(repoRoot);
  if (existing && typeof existing.baselineMB === 'number') return existing;
  const sizeMB = measureDirSizeMB(repoRoot);
  const payload = {
    baselineMB: sizeMB ?? 0,
    budgetMB: OVERLAY_BUDGET_MB,
    recordedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // Ignore if .git is read-only
  }
  return payload;
}

export function readSentinel(sentinelPath = SENTINEL_PATH) {
  if (!fs.existsSync(sentinelPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
  } catch {
    return null;
  }
}

function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function findReplayFixture(repoRoot) {
  const candidates = [
    process.env.RC_REPLAY_PATH,
    DEFAULT_REPLAY_FIXTURE,
    path.join(DEFAULT_CACHE_ROOT, 'rc-replay-3v3.rcreplay'),
    '/workspace/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay',
    path.resolve(repoRoot, '../rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function hasCommand(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function inspectTmpfsState(repoRoot, cacheRoot = DEFAULT_CACHE_ROOT) {
  const sentinel = readSentinel(SENTINEL_PATH);
  const baseline = readBaseline(repoRoot);
  const currentOverlayMB = measureDirSizeMB(repoRoot);
  const symlinks = getManagedSymlinks(repoRoot, cacheRoot).map((entry) => {
    const fullPath = path.join(repoRoot, entry.rel);
    const lst = lstatSafe(fullPath);
    if (!lst) {
      return { ...entry, fullPath, status: 'missing', linkTarget: null };
    }
    if (lst.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(fullPath);
      const targetExists = fs.existsSync(fullPath);
      return {
        ...entry,
        fullPath,
        status: targetExists ? 'ok' : 'dangling',
        linkTarget,
      };
    }
    return { ...entry, fullPath, status: 'real-dir', linkTarget: null };
  });

  const danglingSymlinks = symlinks.filter((s) => s.status === 'dangling');
  const realDirs = symlinks.filter((s) => s.status === 'real-dir');
  const viteCacheDir = path.join(cacheRoot, 'vite-cache');
  const cargoTargetDir = process.env.CARGO_TARGET_DIR || path.join(cacheRoot, 'cargo-target');
  const chromeUserDataDir = path.join(cacheRoot, 'chrome-userdata');
  const replayFixture = findReplayFixture(repoRoot);
  const pnpmInTmpfs = fs.existsSync(path.join(cacheRoot, 'pnpm-global', 'bin', 'pnpm'));
  const pnpmOk = hasCommand('pnpm') || pnpmInTmpfs;

  const missingFromSentinel = [];
  if (sentinel) {
    if (sentinel.viteCacheDir && !fs.existsSync(sentinel.viteCacheDir)) {
      missingFromSentinel.push(`Vite cache (${sentinel.viteCacheDir})`);
    }
    if (sentinel.cargoTargetDir && !fs.existsSync(sentinel.cargoTargetDir)) {
      missingFromSentinel.push(`CARGO_TARGET_DIR (${sentinel.cargoTargetDir})`);
    }
    if (sentinel.replayFixturePresent && sentinel.replayFixturePath && !fs.existsSync(sentinel.replayFixturePath)) {
      missingFromSentinel.push(`.rcreplay fixture (${sentinel.replayFixturePath})`);
    }
  }

  const tmpfsResetDetected =
    danglingSymlinks.length > 0 ||
    (Boolean(baseline) && !sentinel) ||
    missingFromSentinel.length > 0;

  const restoreCommands = [
    'node scripts/env/doctor.mjs --auto-restore',
    'pnpm run env:setup',
  ];
  if (fs.existsSync(path.join(repoRoot, 'src-tauri'))) {
    restoreCommands.push('pnpm run env:setup:rust');
  }
  if (!replayFixture) {
    restoreCommands.push('pnpm run replay:generate-ducky');
  }

  return {
    repoRoot,
    cacheRoot,
    sentinelPath: SENTINEL_PATH,
    sentinelExists: Boolean(sentinel),
    sentinel,
    baseline,
    currentOverlayMB,
    overlayBudgetMB: OVERLAY_BUDGET_MB,
    overlayWithinBudget:
      currentOverlayMB === null ? true : currentOverlayMB <= OVERLAY_BUDGET_MB,
    symlinks,
    danglingSymlinks,
    realDirs,
    viteCacheDir,
    viteCacheExists: fs.existsSync(viteCacheDir),
    cargoTargetDir,
    cargoTargetExists: fs.existsSync(cargoTargetDir),
    chromeUserDataDir,
    replayFixture,
    pnpmOk,
    pnpmInTmpfs,
    missingFromSentinel,
    tmpfsResetDetected,
    restoreCommands,
  };
}

function ensureGitExclude(repoRoot, relPaths) {
  const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.dirname(excludePath))) return;
  let content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const lines = new Set(content.split(/\r?\n/).filter(Boolean));
  let changed = false;
  for (const rel of relPaths) {
    if (!lines.has(rel)) {
      content += (content && !content.endsWith('\n') ? '\n' : '') + rel + '\n';
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(excludePath, content, 'utf8');
  }
}

export function syncPublicSubmoduleToTmpfs(repoRoot, cacheRoot = DEFAULT_CACHE_ROOT) {
  const gitmodulesPath = path.join(repoRoot, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) return false;

  let subUrl = '';
  try {
    subUrl = execFileSync('git', ['config', '--file', '.gitmodules', '--get', 'submodule.public.url'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return false;
  }
  if (!subUrl) return false;

  if (subUrl.startsWith('../')) {
    try {
      const originUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .trim()
        .replace(/\/+$/, '');
      const parentUrl = originUrl.slice(0, originUrl.lastIndexOf('/'));
      subUrl = `${parentUrl}/${subUrl.slice(3)}`;
    } catch {
      // Keep original subUrl if origin.url unavailable
    }
  }

  let pinnedSha = '';
  try {
    pinnedSha = execFileSync('git', ['rev-parse', '-q', '--verify', 'HEAD:public'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    // Ignore
  }

  const tmpPublicDir = path.join(cacheRoot, 'public');
  const repoPublicDir = path.join(repoRoot, 'public');
  const gitTimeoutMs = Number(process.env.RC_GIT_TIMEOUT_MS || 180_000);
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  let tmpValid = false;
  let currentHead = '';
  if (fs.existsSync(path.join(tmpPublicDir, '.git'))) {
    try {
      currentHead = execFileSync('git', ['-C', tmpPublicDir, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      tmpValid = Boolean(currentHead);
    } catch {
      tmpValid = false;
    }
  }

  if (!tmpValid) {
    fs.rmSync(tmpPublicDir, { recursive: true, force: true });
    let fetchedPinnedDirectly = false;
    if (pinnedSha) {
      console.log(`[tmpfsGuard] Fetching public/ submodule (${pinnedSha.slice(0, 8)}) into ${tmpPublicDir} (tmpfs)...`);
      try {
        fs.mkdirSync(tmpPublicDir, { recursive: true });
        execFileSync('git', ['-C', tmpPublicDir, 'init', '-q'], { env: gitEnv });
        execFileSync('git', ['-C', tmpPublicDir, 'remote', 'add', 'origin', subUrl], { env: gitEnv });
        execFileSync('git', ['-C', tmpPublicDir, 'fetch', '--depth', '1', 'origin', pinnedSha], {
          stdio: 'inherit',
          env: gitEnv,
          timeout: gitTimeoutMs,
        });
        execFileSync('git', ['-C', tmpPublicDir, 'checkout', '-q', '--detach', 'FETCH_HEAD'], {
          stdio: 'inherit',
          env: gitEnv,
        });
        fetchedPinnedDirectly = true;
      } catch {
        fs.rmSync(tmpPublicDir, { recursive: true, force: true });
      }
    }
    if (!fetchedPinnedDirectly) {
      console.log(`[tmpfsGuard] Cloning public/ submodule into ${tmpPublicDir} (tmpfs)...`);
      execFileSync('git', ['clone', '--depth', '1', '--single-branch', subUrl, tmpPublicDir], {
        stdio: 'inherit',
        env: gitEnv,
        timeout: gitTimeoutMs,
      });
    }
  } else if (pinnedSha && currentHead !== pinnedSha) {
    let hasPinned = false;
    try {
      execFileSync('git', ['-C', tmpPublicDir, 'cat-file', '-e', `${pinnedSha}^{commit}`], {
        stdio: 'ignore',
      });
      hasPinned = true;
    } catch {
      hasPinned = false;
    }
    if (!hasPinned) {
      try {
        execFileSync('git', ['-C', tmpPublicDir, 'fetch', '--depth', '1', 'origin', pinnedSha], {
          stdio: 'inherit',
          env: gitEnv,
          timeout: gitTimeoutMs,
        });
      } catch {
        try {
          execFileSync('git', ['-C', tmpPublicDir, 'fetch', '--all', '--tags', '--prune'], {
            stdio: 'inherit',
            env: gitEnv,
            timeout: gitTimeoutMs,
          });
        } catch {
          // Ignore
        }
      }
    }
    try {
      execFileSync('git', ['-C', tmpPublicDir, 'checkout', '-q', '--detach', pinnedSha], {
        stdio: 'ignore',
      });
    } catch {
      // Ignore
    }
  }

  // Replace OverlayFS public/ and .git/modules/public with symlink to tmpfs
  const lst = lstatSafe(repoPublicDir);
  if (lst) {
    if (lst.isSymbolicLink()) {
      if (fs.readlinkSync(repoPublicDir) !== tmpPublicDir) {
        fs.unlinkSync(repoPublicDir);
        fs.symlinkSync(tmpPublicDir, repoPublicDir, 'dir');
      }
    } else {
      fs.rmSync(repoPublicDir, { recursive: true, force: true });
      fs.symlinkSync(tmpPublicDir, repoPublicDir, 'dir');
    }
  } else {
    fs.symlinkSync(tmpPublicDir, repoPublicDir, 'dir');
  }

  const gitModulesPublic = path.join(repoRoot, '.git', 'modules', 'public');
  if (fs.existsSync(gitModulesPublic)) {
    fs.rmSync(gitModulesPublic, { recursive: true, force: true });
  }

  try {
    execFileSync('git', ['config', 'submodule.public.update', 'none'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'submodule.public.active', 'false'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', ['update-index', '--assume-unchanged', 'public'], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    // Ignore
  }

  return true;
}

export function ensureTmpfsLayout(repoRoot, cacheRoot = DEFAULT_CACHE_ROOT) {
  recordBaselineIfMissing(repoRoot);

  const dirs = [
    cacheRoot,
    path.join(cacheRoot, 'node_modules'),
    path.join(cacheRoot, 'vite-cache'),
    path.join(cacheRoot, 'dist'),
    path.join(cacheRoot, 'tauri-target'),
    path.join(cacheRoot, 'wasm-target'),
    path.join(cacheRoot, 'cargo-target'),
    path.join(cacheRoot, 'cargo-home'),
    path.join(cacheRoot, 'rustup-home'),
    path.join(cacheRoot, 'pnpm-store'),
    path.join(cacheRoot, 'pnpm-cache'),
    path.join(cacheRoot, 'chrome-userdata'),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  const managed = getManagedSymlinks(repoRoot, cacheRoot);
  for (const entry of managed) {
    if (entry.isSubmodule) {
      continue;
    }
    if (entry.parentMustExist && !fs.existsSync(path.dirname(path.join(repoRoot, entry.rel)))) {
      continue;
    }
    const fullPath = path.join(repoRoot, entry.rel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.mkdirSync(entry.target, { recursive: true });

    const lst = lstatSafe(fullPath);
    if (lst) {
      if (lst.isSymbolicLink()) {
        const currentTarget = fs.readlinkSync(fullPath);
        if (currentTarget === entry.target && fs.existsSync(entry.target)) {
          continue;
        }
        fs.unlinkSync(fullPath);
      } else {
        // Real directory/file on OverlayFS: migrate contents to tmpfs target, then replace with symlink
        try {
          execFileSync('cp', ['-a', `${fullPath}/.`, `${entry.target}/`], { stdio: 'ignore' });
        } catch {
          // Best-effort copy (e.g. empty dir)
        }
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    }
    fs.symlinkSync(entry.target, fullPath, 'dir');
  }

  ensureGitExclude(
    repoRoot,
    managed.filter((m) => !m.isSubmodule).map((m) => m.rel)
  );

  return writeSentinel(repoRoot, cacheRoot);
}

export function writeSentinel(repoRoot, cacheRoot = DEFAULT_CACHE_ROOT) {
  const baseline = readBaseline(repoRoot);
  const replayFixture = findReplayFixture(repoRoot);
  const payload = {
    version: 1,
    repoRoot,
    cacheRoot,
    pnpmGlobalDir: path.join(cacheRoot, 'pnpm-global'),
    pnpmStoreDir: path.join(cacheRoot, 'pnpm-store'),
    pnpmCacheDir: path.join(cacheRoot, 'pnpm-cache'),
    viteCacheDir: path.join(cacheRoot, 'vite-cache'),
    cargoTargetDir: process.env.CARGO_TARGET_DIR || path.join(cacheRoot, 'cargo-target'),
    cargoHomeDir: process.env.CARGO_HOME || path.join(cacheRoot, 'cargo-home'),
    rustupHomeDir: process.env.RUSTUP_HOME || path.join(cacheRoot, 'rustup-home'),
    chromeUserDataDir: path.join(cacheRoot, 'chrome-userdata'),
    replayFixturePath: replayFixture || DEFAULT_REPLAY_FIXTURE,
    replayFixturePresent: Boolean(replayFixture),
    overlayBaselineMB: baseline?.baselineMB ?? null,
    symlinks: getManagedSymlinks(repoRoot, cacheRoot).map((s) => ({
      rel: s.rel,
      target: s.target,
    })),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SENTINEL_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export function installPnpmToTmpfs(cacheRoot = DEFAULT_CACHE_ROOT) {
  const pnpmPrefix = path.join(cacheRoot, 'pnpm-global');
  const pnpmBin = path.join(pnpmPrefix, 'bin', 'pnpm');
  const npmCache = path.join(cacheRoot, 'npm-cache');
  const pnpmStore = path.join(cacheRoot, 'pnpm-store');
  const pnpmCache = path.join(cacheRoot, 'pnpm-cache');
  fs.mkdirSync(pnpmPrefix, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });
  fs.mkdirSync(pnpmStore, { recursive: true });
  fs.mkdirSync(pnpmCache, { recursive: true });

  if (!fs.existsSync(pnpmBin)) {
    console.log(`[tmpfsGuard] Installing pnpm@${PNPM_VERSION} into ${pnpmPrefix} (tmpfs)...`);
    execFileSync(
      'npm',
      ['install', '-g', `pnpm@${PNPM_VERSION}`, '--prefix', pnpmPrefix, '--force', '--no-audit', '--no-fund'],
      {
        stdio: 'inherit',
        env: { ...getPnpmEnv(process.env, cacheRoot), NPM_CONFIG_CACHE: npmCache },
      }
    );
    fs.rmSync(npmCache, { recursive: true, force: true });
  }

  // Install tiny self-healing wrapper in /usr/local/bin if writable, else ~/.local/bin
  let binDir = '/usr/local/bin';
  try {
    fs.accessSync(binDir, fs.constants.W_OK);
  } catch {
    binDir = path.join(process.env.HOME || '/root', '.local', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
  }

  const wrapperPath = path.join(binDir, 'pnpm');
  const pnpxWrapperPath = path.join(binDir, 'pnpx');
  const wrapperScript = `#!/usr/bin/env bash
set -euo pipefail
CACHE_ROOT="\${RC_TMPFS_CACHE_DIR:-${cacheRoot}}"
REAL_PREFIX="\${CACHE_ROOT}/pnpm-global"
REAL_PNPM="\${REAL_PREFIX}/bin/pnpm"
export PNPM_HOME="\${REAL_PREFIX}/bin"
export XDG_CACHE_HOME="\${XDG_CACHE_HOME:-\${CACHE_ROOT}/xdg-cache}"
export XDG_DATA_HOME="\${XDG_DATA_HOME:-\${CACHE_ROOT}/xdg-data}"
export XDG_STATE_HOME="\${XDG_STATE_HOME:-\${CACHE_ROOT}/xdg-state}"
export npm_config_store_dir="\${npm_config_store_dir:-\${CACHE_ROOT}/pnpm-store}"
export npm_config_cache_dir="\${npm_config_cache_dir:-\${CACHE_ROOT}/pnpm-cache}"
export CARGO_TARGET_DIR="\${CARGO_TARGET_DIR:-\${CACHE_ROOT}/cargo-target}"
export npm_config_update_notifier="\${npm_config_update_notifier:-false}"
export pnpm_config_update_notifier="\${pnpm_config_update_notifier:-false}"
export NO_UPDATE_NOTIFIER="\${NO_UPDATE_NOTIFIER:-1}"

if [ -n "\${NODE_OPTIONS:-}" ]; then
  CLEAN_NODE_OPTIONS="\$(printf '%s' "\$NODE_OPTIONS" | sed -E 's/(^|[[:space:]])(--require|-r)(=|[[:space:]]+)global-agent\\/bootstrap([[:space:]]|$)/ /g; s/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+\$//')"
  if [ -n "\$CLEAN_NODE_OPTIONS" ]; then
    export NODE_OPTIONS="\$CLEAN_NODE_OPTIONS"
  else
    unset NODE_OPTIONS
  fi
fi

if [ ! -x "\$REAL_PNPM" ]; then
  echo "[pnpm-tmpfs] /tmp reset detected; reinstalling pnpm@${PNPM_VERSION} into \${REAL_PREFIX}..." >&2
  mkdir -p "\$REAL_PREFIX" "\${CACHE_ROOT}/npm-cache" "\${CACHE_ROOT}/pnpm-store" "\${CACHE_ROOT}/pnpm-cache"
  NPM_CONFIG_CACHE="\${CACHE_ROOT}/npm-cache" npm install -g "pnpm@${PNPM_VERSION}" --prefix "\$REAL_PREFIX" --force --no-audit --no-fund >&2
  rm -rf "\${CACHE_ROOT}/npm-cache" 2>/dev/null || true
fi

if [ -f "scripts/env/tmpfsGuard.mjs" ] && [ -z "\${RC_TMPFS_GUARD_SKIP:-}" ]; then
  RC_TMPFS_GUARD_SKIP=1 node scripts/env/tmpfsGuard.mjs --ensure >/dev/null 2>&1 || true
  case "\${1:-}" in
    env:*|install|i) ;;
    *)
      if [ ! -f "node_modules/.modules.yaml" ] || [ ! -d "public" ]; then
        echo "[pnpm-tmpfs] /tmp cache incomplete (node_modules or public/ missing). Run: node scripts/env/doctor.mjs --auto-restore" >&2
      fi
      ;;
  esac
fi

exec "\$REAL_PNPM" "\$@"
`;
  fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });

  const pnpxScript = `#!/usr/bin/env bash
CACHE_ROOT="\${RC_TMPFS_CACHE_DIR:-${cacheRoot}}"
REAL_PNPX="\${CACHE_ROOT}/pnpm-global/bin/pnpx"
if [ ! -x "\$REAL_PNPX" ]; then
  "${wrapperPath}" --version >/dev/null 2>&1 || true
fi
exec "\$REAL_PNPX" "\$@"
`;
  fs.writeFileSync(pnpxWrapperPath, pnpxScript, { mode: 0o755 });
  return { pnpmBin, wrapperPath, binDir };
}

export function autoRestoreTmpfs(repoRoot, { withRust = false, cacheRoot = DEFAULT_CACHE_ROOT } = {}) {
  console.log('[tmpfsGuard] Running --auto-restore...');
  ensureTmpfsLayout(repoRoot, cacheRoot);

  if (!hasCommand('pnpm') || !fs.existsSync(path.join(cacheRoot, 'pnpm-global', 'bin', 'pnpm'))) {
    installPnpmToTmpfs(cacheRoot);
  }

  const publicReady =
    fs.existsSync(path.join(repoRoot, 'public', 'camera.wasm')) ||
    fs.existsSync(path.join(repoRoot, 'public', 'wasm'));
  const publicLst = lstatSafe(path.join(repoRoot, 'public'));
  if (!publicReady || !publicLst?.isSymbolicLink()) {
    syncPublicSubmoduleToTmpfs(repoRoot, cacheRoot);
  }

  if (!hasPopulatedNodeModules(repoRoot)) {
    console.log('[tmpfsGuard] Restoring node_modules into tmpfs...');
    const pnpmCmd = fs.existsSync(path.join(cacheRoot, 'pnpm-global', 'bin', 'pnpm'))
      ? path.join(cacheRoot, 'pnpm-global', 'bin', 'pnpm')
      : 'pnpm';
    const installArgs = [
      'install',
      '--no-frozen-lockfile',
      '--ignore-scripts',
      `--store-dir=${path.join(cacheRoot, 'pnpm-store')}`,
    ];
    if (!process.stdout.isTTY) {
      installArgs.push('--reporter=append-only');
    }
    execFileSync(
      pnpmCmd,
      installArgs,
      { cwd: repoRoot, stdio: 'inherit', env: getPnpmEnv(process.env, cacheRoot) }
    );
    // Ensure node_modules/.vite is also linked cleanly after pnpm install
    ensureTmpfsLayout(repoRoot, cacheRoot);
  }

  if (!findReplayFixture(repoRoot)) {
    const manifestPath = path.join(repoRoot, 'public', 'arenamesh', 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      console.log('[tmpfsGuard] Regenerating 3v3 .rcreplay fixture via WASM simulation...');
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', 'scripts/env/generateReplayFixture.ts', DEFAULT_REPLAY_FIXTURE],
        { cwd: repoRoot, stdio: 'inherit' }
      );
    } else {
      console.log('[tmpfsGuard] Regenerating synthetic 3v3 .rcreplay fixture...');
      execFileSync(
        process.execPath,
        ['scripts/env/generateSyntheticReplayFixture.mjs', DEFAULT_REPLAY_FIXTURE],
        { cwd: repoRoot, stdio: 'inherit' }
      );
    }
  }

  if (withRust) {
    execFileSync('bash', ['scripts/env/bootstrap.sh', '--with-rust'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }

  writeSentinel(repoRoot, cacheRoot);
  console.log('[tmpfsGuard] Auto-restore complete.');
}

export function printTmpfsDiagnostic(report) {
  const baselineLabel =
    report.baseline?.baselineMB != null ? `${report.baseline.baselineMB} MB` : 'not recorded';
  const currentLabel =
    report.currentOverlayMB != null ? `${report.currentOverlayMB} MB` : 'unknown';
  const budgetTag = report.overlayWithinBudget ? 'OK' : 'WARN';
  console.log(
    `[${budgetTag}] OverlayFS footprint: ${currentLabel} (baseline: ${baselineLabel}, budget: <= ${report.overlayBudgetMB} MB)`
  );
  console.log(
    `[${report.sentinelExists ? 'OK' : 'WARN'}] tmpfs sentinel (${report.sentinelPath}): ${
      report.sentinelExists ? `present (${report.sentinel?.updatedAt || 'ok'})` : 'MISSING'
    }`
  );

  if (report.danglingSymlinks.length > 0) {
    console.log(
      `[WARN] Dangling tmpfs symlinks detected: ${report.danglingSymlinks.map((s) => s.rel).join(', ')}`
    );
  }
  if (report.missingFromSentinel.length > 0) {
    console.log(`[WARN] Missing tmpfs assets: ${report.missingFromSentinel.join(', ')}`);
  }

  if (report.tmpfsResetDetected) {
    console.log('\n============================================================');
    console.log('[tmpfsGuard] /tmp (tmpfs) RESET DETECTED!');
    console.log('Container snapshot restore cleared /tmp caches/symlinks.');
    console.log('Run any of the following to restore immediately:');
    for (const cmd of report.restoreCommands) {
      console.log(`  ${cmd}`);
    }
    console.log('============================================================\n');
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dirname, '../..');

  if (args.has('--install-pnpm')) {
    installPnpmToTmpfs(DEFAULT_CACHE_ROOT);
    return;
  }
  if (args.has('--sync-public')) {
    syncPublicSubmoduleToTmpfs(repoRoot, DEFAULT_CACHE_ROOT);
    return;
  }
  if (args.has('--ensure')) {
    const sentinel = ensureTmpfsLayout(repoRoot, DEFAULT_CACHE_ROOT);
    if (args.has('--json')) {
      console.log(JSON.stringify(sentinel, null, 2));
    }
    return;
  }
  if (args.has('--auto-restore')) {
    autoRestoreTmpfs(repoRoot, { withRust: args.has('--with-rust') });
    return;
  }

  const report = inspectTmpfsState(repoRoot, DEFAULT_CACHE_ROOT);
  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printTmpfsDiagnostic(report);
  if (report.tmpfsResetDetected) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
