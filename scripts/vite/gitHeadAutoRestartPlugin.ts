import type { Plugin, ViteDevServer } from 'vite';
import { readCompositeGitHeadState } from '../git/gitHeadState.ts';

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
  const checkGitHead = async () => {
    if (reloading) return;
    try {
      const res = await fetch('/__rc_git_head', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.signature && bootSig && data.signature !== bootSig) {
        reloading = true;
        window.location.reload();
      } else if (data && data.signature && !bootSig) {
        bootSig = data.signature;
      }
    } catch {
      // Server is restarting; next poll will catch new signature
    }
  };
  if (import.meta.hot) {
    import.meta.hot.on('vite:ws:connect', checkGitHead);
    import.meta.hot.on('rc:git-head-changed', () => {
      if (!reloading) {
        reloading = true;
        window.location.reload();
      }
    });
  }
  setInterval(checkGitHead, 1500);
})();
</script>`;
      return html.includes('</body>')
        ? html.replace('</body>', `${clientGuardScript}</body>`)
        : `${html}${clientGuardScript}`;
    },
    configureServer(server: ViteDevServer) {
      let baselineSignature = readCompositeGitHeadState().signature;
      let isRestarting = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

      server.middlewares.use('/__rc_git_head', (_req, res) => {
        const current = readCompositeGitHeadState();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            signature: current.signature ?? baselineSignature,
            locked: current.locked,
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
            cleanup();
            console.log(
              `\n  [rc-git-auto-restart] Git HEAD switch detected:\n    prev: ${previousSignature}\n    next: ${settled.signature}\n  -> Auto-restarting Vite dev server...`
            );
            try {
              server.moduleGraph.invalidateAll();
              server.ws?.send?.({
                type: 'custom',
                event: 'rc:git-head-changed',
                data: { signature: settled.signature },
              });
              server.ws?.send?.({ type: 'full-reload', path: '*' });
              await server.restart(true);
              server.ws?.send?.({ type: 'full-reload', path: '*' });
              setTimeout(() => {
                server.ws?.send?.({ type: 'full-reload', path: '*' });
              }, 350);
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
