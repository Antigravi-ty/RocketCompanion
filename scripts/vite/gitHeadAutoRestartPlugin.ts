import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { isCheckoutLockActive } from '../git/gitCheckoutSignal.ts';
import { readCompositeGitHeadState, REPO_ROOT_DIR } from '../git/gitHeadState.ts';

const SETTLE_QUIET_MS = 1000;
const SETTLE_MAX_WAIT_MS = 3000;
const FALLBACK_POLL_MS = 500;

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

export function rcGitHeadAutoRestartPlugin(): Plugin {
  let serverBootId = randomUUID();

  return {
    name: 'rc-git-head-auto-restart',
    apply: 'serve',
    transformIndexHtml(html: string) {
      const initialBootId = serverBootId;
      const initialSig = readCompositeGitHeadState().signature ?? '';
      const clientGuardScript = `<script type="module">
(() => {
  const INITIAL_BOOT_ID = ${JSON.stringify(initialBootId)};
  const INITIAL_SIG = ${JSON.stringify(initialSig)};
  let reloading = false;
  let waitingForServer = false;
  let pollTimer = null;

  const showBanner = () => {
    if (document.getElementById('__rc_git_reload_banner')) return;
    const banner = document.createElement('div');
    banner.id = '__rc_git_reload_banner';
    banner.textContent = 'Git checkout detected - waiting for Vite dev server...';
    Object.assign(banner.style, {
      position: 'fixed',
      top: '10px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      padding: '6px 14px',
      borderRadius: '9999px',
      background: 'rgba(15, 23, 42, 0.92)',
      color: '#e2e8f0',
      border: '1px solid rgba(148, 163, 184, 0.35)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '12px',
      fontWeight: '500',
      pointerEvents: 'none',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
    });
    (document.body || document.documentElement).appendChild(banner);
  };

  const hideBanner = () => {
    const banner = document.getElementById('__rc_git_reload_banner');
    if (banner) banner.remove();
  };

  const scheduleNext = (delayMs) => {
    if (pollTimer) clearTimeout(pollTimer);
    if (reloading) return;
    pollTimer = setTimeout(checkGitHead, delayMs);
  };

  const checkGitHead = async () => {
    if (reloading) return;
    try {
      const res = await fetch('/__rc_git_head', { cache: 'no-store' });
      if (!res.ok) {
        waitingForServer = true;
        showBanner();
        scheduleNext(400);
        return;
      }
      const data = await res.json();
      if (!data || data.restarting || data.settling || data.locked) {
        waitingForServer = true;
        showBanner();
        scheduleNext(400);
        return;
      }
      if (data.bootId && data.bootId !== INITIAL_BOOT_ID) {
        reloading = true;
        window.location.reload();
        return;
      }
      if (waitingForServer && data.signature && INITIAL_SIG && data.signature !== INITIAL_SIG) {
        reloading = true;
        window.location.reload();
        return;
      }
      if (waitingForServer) {
        waitingForServer = false;
        hideBanner();
      }
      scheduleNext(1500);
    } catch {
      waitingForServer = true;
      showBanner();
      scheduleNext(400);
    }
  };

  if (import.meta.hot) {
    import.meta.hot.on('vite:ws:disconnect', () => {
      waitingForServer = true;
      showBanner();
      scheduleNext(350);
    });
    import.meta.hot.on('vite:ws:connect', () => {
      void checkGitHead();
    });
    import.meta.hot.on('rc:git-head-changed', () => {
      void checkGitHead();
    });
  }

  scheduleNext(1200);
})();
</script>`;
      return html.includes('</body>')
        ? html.replace('</body>', `${clientGuardScript}</body>`)
        : `${html}${clientGuardScript}`;
    },
    configureServer(server: ViteDevServer) {
      serverBootId = randomUUID();
      const bootId = serverBootId;
      const isSupervised = process.env.RC_DEV_SUPERVISOR === '1';
      const disableSelfRestart = isSupervised || process.env.RC_DISABLE_VITE_GIT_RESTART === '1';

      let baselineSignature = readCompositeGitHeadState().signature;
      let baselineDepsStamp = readDepsStamp();
      let isSettling = false;
      let isRestarting = false;
      let settleStartAt = 0;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      let cleanedUp = false;

      const scheduleStandaloneRestart = () => {
        if (disableSelfRestart || isRestarting || cleanedUp) return;
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        const elapsed = Date.now() - settleStartAt;
        const remainingCap = Math.max(0, SETTLE_MAX_WAIT_MS - elapsed);
        const delay = Math.min(SETTLE_QUIET_MS, remainingCap);

        settleTimer = setTimeout(async () => {
          settleTimer = null;
          if (disableSelfRestart || isRestarting || cleanedUp) return;

          const current = readCompositeGitHeadState();
          if (current.locked && Date.now() - settleStartAt < SETTLE_MAX_WAIT_MS) {
            scheduleStandaloneRestart();
            return;
          }

          if (!current.signature || current.signature === baselineSignature) {
            isSettling = false;
            return;
          }

          isRestarting = true;
          const previousSignature = baselineSignature;
          baselineSignature = current.signature;
          const nextDepsStamp = readDepsStamp();
          const depsChanged = nextDepsStamp !== baselineDepsStamp;
          baselineDepsStamp = nextDepsStamp;

          console.log(
            `\n  [rc-git-auto-restart] Git checkout settled:\n    prev: ${previousSignature ?? 'none'}\n    next: ${current.signature}\n  -> Restarting Vite dev server (forceOptimize=${depsChanged})...`
          );

          try {
            server.moduleGraph.invalidateAll();
            await server.restart(depsChanged);
          } catch (err) {
            isRestarting = false;
            isSettling = false;
            console.error('[rc-git-auto-restart] Failed to auto-restart Vite server:', err);
          }
        }, delay);
        settleTimer.unref?.();
      };

      const enterSettlingState = (_reason: string) => {
        if (isRestarting || cleanedUp) return;
        if (!isSettling) {
          isSettling = true;
          settleStartAt = Date.now();
        }
        if (!disableSelfRestart) {
          scheduleStandaloneRestart();
        }
      };

      const originalWsSend = server.ws.send.bind(server.ws);
      server.ws.send = ((...args: Parameters<typeof server.ws.send>) => {
        const first = args[0] as { type?: string } | undefined;
        if (first && (first.type === 'update' || first.type === 'full-reload')) {
          const locked = isCheckoutLockActive(REPO_ROOT_DIR);
          if (isSettling || isRestarting || locked) {
            if (locked && !isSettling && !isRestarting) {
              enterSettlingState('git-lock-during-hmr');
            }
            return;
          }
        }
        return originalWsSend(...args);
      }) as typeof server.ws.send;

      const onWorkspaceActivity = () => {
        if (isSettling && !isRestarting && !disableSelfRestart) {
          scheduleStandaloneRestart();
        }
      };
      server.watcher.on('all', onWorkspaceActivity);

      server.middlewares.use('/__rc_git_head', (_req, res) => {
        const current = readCompositeGitHeadState();
        if (current.locked && !isSettling && !isRestarting) {
          enterSettlingState('git-lock-on-poll');
        } else if (
          !isSettling &&
          !isRestarting &&
          current.signature &&
          baselineSignature &&
          current.signature !== baselineSignature
        ) {
          enterSettlingState('head-signature-changed');
        }

        const busy = isRestarting || isSettling || current.locked;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          JSON.stringify({
            bootId,
            signature: busy ? null : (current.signature ?? baselineSignature),
            locked: current.locked,
            settling: isSettling,
            restarting: busy,
          })
        );
      });

      server.middlewares.use('/__rc_git_checkout_done', (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          enterSettlingState('post-checkout-hook');
          if (isSupervised && typeof process.send === 'function') {
            try {
              const body = Buffer.concat(chunks).toString('utf8').trim();
              const event = body ? JSON.parse(body) : null;
              process.send({ type: 'rc:checkout-done', event });
            } catch {
              process.send({ type: 'rc:checkout-done', event: null });
            }
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ ok: true, bootId }));
        });
      });

      const onSupervisorMessage = (msg: unknown) => {
        if (
          msg &&
          typeof msg === 'object' &&
          (msg as { type?: string }).type === 'rc:checkout-settling'
        ) {
          enterSettlingState('supervisor-ipc');
        }
      };
      if (isSupervised) {
        process.on('message', onSupervisorMessage);
      }

      const pollTimer = setInterval(() => {
        if (isRestarting || cleanedUp) return;
        const current = readCompositeGitHeadState();
        if (current.locked) {
          enterSettlingState('git-lock-poll');
          return;
        }
        if (!current.signature) return;

        if (baselineSignature === null) {
          baselineSignature = current.signature;
          return;
        }

        if (current.signature !== baselineSignature) {
          enterSettlingState('head-poll');
        }
      }, FALLBACK_POLL_MS);
      pollTimer.unref?.();

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(pollTimer);
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        server.watcher.off('all', onWorkspaceActivity);
        if (isSupervised) {
          process.off('message', onSupervisorMessage);
        }
      };

      server.httpServer?.once('close', cleanup);
    },
  };
}
