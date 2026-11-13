import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { readCompositeGitHeadState, REPO_ROOT_DIR } from '../git/gitHeadState.ts';

const CRATES_DIR = resolve(REPO_ROOT_DIR, 'crates');
const BUILD_WASM_SCRIPT = resolve(REPO_ROOT_DIR, 'scripts/buildPhysicsWasm.mjs');

function readDepsStamp(): string {
  const files = ['package.json', 'pnpm-lock.yaml'];
  return files
    .map((f) => {
      try {
        const st = fs.statSync(resolve(REPO_ROOT_DIR, f));
        return `${f}:${st.size}:${Math.trunc(st.mtimeMs)}`;
      } catch {
        return `${f}:missing`;
      }
    })
    .join('|');
}

function computeRustWorkspaceSignature(dirPath: string): string {
  if (!fs.existsSync(dirPath)) return 'no-crates';
  let fileCount = 0;
  let maxMtimeMs = 0;
  let totalSize = 0;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'target' || entry.name === '.git') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.rs') ||
          entry.name === 'Cargo.toml' ||
          entry.name === 'Cargo.lock' ||
          entry.name === 'rocketsim.tree-hash')
      ) {
        try {
          const st = fs.statSync(full);
          fileCount++;
          totalSize += st.size;
          if (st.mtimeMs > maxMtimeMs) {
            maxMtimeMs = st.mtimeMs;
          }
        } catch {
          // Ignore transient stat error
        }
      }
    }
  };

  walk(dirPath);
  return `rs:${fileCount}:${totalSize}:${Math.floor(maxMtimeMs)}`;
}

function readWorkspaceWatchState(): {
  signature: string | null;
  gitSignature: string | null;
  rustSignature: string;
  locked: boolean;
} {
  const gitState = readCompositeGitHeadState();
  const rustSignature = computeRustWorkspaceSignature(CRATES_DIR);
  if (gitState.locked || !gitState.signature) {
    return {
      signature: null,
      gitSignature: gitState.signature,
      rustSignature,
      locked: gitState.locked,
    };
  }
  return {
    signature: `${gitState.signature} | ${rustSignature}`,
    gitSignature: gitState.signature,
    rustSignature,
    locked: false,
  };
}

let lastCompiledRustSig = '';

function rebuildRustWasmIfNeeded(rustSig: string, reason: string): boolean {
  if (!fs.existsSync(CRATES_DIR) || !fs.existsSync(BUILD_WASM_SCRIPT)) return false;
  if (lastCompiledRustSig === rustSig) return false;
  lastCompiledRustSig = rustSig;
  console.log(
    `\n  [rc-git-auto-restart] Rust workspace change detected (${reason}) -> compiling dev WASM (src/physics/core.wasm)...`
  );
  const res = spawnSync(process.execPath, [BUILD_WASM_SCRIPT, '--dev'], {
    cwd: REPO_ROOT_DIR,
    stdio: 'inherit',
  });
  return res.status === 0;
}

/**
 * Dev-only plugin (`apply: 'serve'`): monitors `.git/HEAD`, active branch refs, and
 * `crates/` Rust source tree. Automatically rebuilds `src/physics/core.wasm` only when
 * `crates/` changes (either via commit/checkout or live `.rs` edit), then restarts Vite.
 */
export function rcGitHeadAutoRestartPlugin(): Plugin {
  return {
    name: 'rc-git-head-auto-restart',
    apply: 'serve',
    transformIndexHtml(html: string) {
      const initialSig = readWorkspaceWatchState().signature ?? '';
      const clientGuardScript = `<script type="module">
(() => {
  let bootSig = ${JSON.stringify(initialSig)};
  let reloading = false;
  let serverRestarting = false;
  const checkGitHead = async () => {
    if (reloading) return;
    try {
      const res = await fetch('/__rc_git_head', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.restarting) {
        serverRestarting = true;
        return;
      }
      if (data && data.signature && bootSig && data.signature !== bootSig) {
        reloading = true;
        window.location.reload();
      } else if (data && data.signature && !bootSig) {
        bootSig = data.signature;
      } else if (serverRestarting && data && !data.restarting) {
        reloading = true;
        window.location.reload();
      }
    } catch {
      serverRestarting = true;
    }
  };
  if (import.meta.hot) {
    import.meta.hot.on('vite:ws:disconnect', () => {
      serverRestarting = true;
    });
    import.meta.hot.on('vite:ws:connect', () => {
      serverRestarting = false;
      void checkGitHead();
    });
    import.meta.hot.on('rc:git-head-changed', () => {
      void checkGitHead();
    });
  }
  setInterval(checkGitHead, 1200);
})();
</script>`;
      return html.includes('</body>')
        ? html.replace('</body>', `${clientGuardScript}</body>`)
        : `${html}${clientGuardScript}`;
    },
    configureServer(server: ViteDevServer) {
      const initial = readWorkspaceWatchState();
      let baselineSignature = initial.signature;
      let baselineGitSig = initial.gitSignature;
      let baselineRustSig = initial.rustSignature;
      let baselineDepsStamp = readDepsStamp();
      if (baselineRustSig && !lastCompiledRustSig) {
        lastCompiledRustSig = baselineRustSig;
      }
      let isRestarting = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      server.middlewares.use('/__rc_git_head', (_req, res) => {
        const current = readWorkspaceWatchState();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            signature: isRestarting ? null : (current.signature ?? baselineSignature),
            locked: current.locked,
            restarting: isRestarting,
          })
        );
      });

      if (process.env.RC_DISABLE_VITE_GIT_RESTART === '1') {
        return;
      }

      const cleanup = () => {
        clearInterval(pollTimer);
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
      };

      const pollTimer = setInterval(() => {
        if (isRestarting) return;
        const current = readWorkspaceWatchState();
        if (current.locked || !current.gitSignature) return;

        if (baselineGitSig === null) {
          baselineSignature = current.signature;
          baselineGitSig = current.gitSignature;
          baselineRustSig = current.rustSignature;
          return;
        }

        const gitChanged = current.gitSignature !== baselineGitSig;
        const rustChanged = current.rustSignature !== baselineRustSig;

        if ((gitChanged || rustChanged) && !settleTimer) {
          const prevGitSig = baselineGitSig;
          const prevRustSig = baselineRustSig;
          settleTimer = setTimeout(async () => {
            settleTimer = null;
            if (isRestarting) return;
            const settled = readWorkspaceWatchState();
            if (
              settled.locked ||
              !settled.gitSignature ||
              (settled.gitSignature === prevGitSig && settled.rustSignature === prevRustSig)
            ) {
              return;
            }
            isRestarting = true;
            const settledGitChanged = settled.gitSignature !== prevGitSig;
            const settledRustChanged = settled.rustSignature !== prevRustSig;
            baselineSignature = settled.signature;
            baselineGitSig = settled.gitSignature;
            baselineRustSig = settled.rustSignature;
            const nextDepsStamp = readDepsStamp();
            const depsChanged = nextDepsStamp !== baselineDepsStamp;
            baselineDepsStamp = nextDepsStamp;
            cleanup();

            if (settledRustChanged) {
              rebuildRustWasmIfNeeded(
                settled.rustSignature,
                settledGitChanged ? 'git HEAD + crates/ modified' : 'crates/ source modified'
              );
            }

            console.log(
              `\n  [rc-git-auto-restart] Workspace change detected:\n    git : ${prevGitSig} -> ${settled.gitSignature}\n    rust: ${settledRustChanged ? 'MODIFIED (rebuilt WASM)' : 'unchanged (skipped WASM build)'}\n  -> Auto-restarting Vite dev server (forceOptimize=${depsChanged})...`
            );
            try {
              server.moduleGraph.invalidateAll();
              await server.restart(depsChanged);
              server.ws?.send?.({
                type: 'custom',
                event: 'rc:git-head-changed',
                data: { signature: settled.signature },
              });
            } catch (err) {
              isRestarting = false;
              console.error('[rc-git-auto-restart] Failed to auto-restart Vite server:', err);
            }
          }, 150);
          settleTimer.unref?.();
        }
      }, 200);

      pollTimer.unref?.();
      server.httpServer?.once('close', cleanup);
    },
  };
}

