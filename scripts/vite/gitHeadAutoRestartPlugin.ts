import fs from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { readCompositeGitHeadState, REPO_ROOT_DIR } from '../git/gitHeadState.ts';

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

/**
 * Dev-only plugin (`apply: 'serve'`): monitors `.git/HEAD` and active branch refs across
 * the main repository and `public` submodule.
 */
export function rcGitHeadAutoRestartPlugin(): Plugin {
  return {
    name: 'rc-git-head-auto-restart',
    apply: 'serve',
    transformIndexHtml(html: string) {
      const initialSig = readCompositeGitHeadState().signature ?? '';
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
      let baselineSignature = readCompositeGitHeadState().signature;
      let baselineDepsStamp = readDepsStamp();
      let isRestarting = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      server.middlewares.use('/__rc_git_head', (_req, res) => {
        const current = readCompositeGitHeadState();
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
        const current = readCompositeGitHeadState();
        if (current.locked || !current.signature) return;

        if (baselineSignature === null) {
          baselineSignature = current.signature;
          return;
        }

        if (current.signature !== baselineSignature && !settleTimer) {
          const previousSignature = baselineSignature;
          settleTimer = setTimeout(async () => {
            settleTimer = null;
            if (isRestarting) return;
            const settled = readCompositeGitHeadState();
            if (settled.locked || !settled.signature || settled.signature === previousSignature) {
              return;
            }
            isRestarting = true;
            baselineSignature = settled.signature;
            const nextDepsStamp = readDepsStamp();
            const depsChanged = nextDepsStamp !== baselineDepsStamp;
            baselineDepsStamp = nextDepsStamp;
            cleanup();
            console.log(
              `\n  [rc-git-auto-restart] Git HEAD switch detected:\n    prev: ${previousSignature}\n    next: ${settled.signature}\n  -> Auto-restarting Vite dev server (forceOptimize=${depsChanged})...`
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
          }, 120);
          settleTimer.unref?.();
        }
      }, 150);

      pollTimer.unref?.();
      server.httpServer?.once('close', cleanup);
    },
  };
}
