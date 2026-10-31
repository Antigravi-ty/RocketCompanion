import { MinimumProgressLoader } from './loader/MinimumProgressLoader.js';
import { isVerboseLogEnabled } from './loader/ConsoleProgressObserver.js';

const MODULE_RETRY_SESSION_KEY = '__rc_bootstrap_module_reload_ts';

function isModuleImportError(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('Importing a module script failed') ||
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('error loading dynamically imported module') ||
    msg.includes('The network connection was lost') ||
    msg.includes('Importing binding name')
  );
}

async function importWithRetry(importer, fallbackUrl, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt === 1) {
        return await importer();
      }
      const retryUrl = new URL(fallbackUrl, import.meta.url);
      retryUrl.searchParams.set('retry', `${attempt}_${Date.now()}`);
      return await import(/* @vite-ignore */ retryUrl.href);
    } catch (err) {
      lastErr = err;
      if (!isModuleImportError(err) || attempt >= maxAttempts) {
        break;
      }
      console.warn(
        `[Engine] Module stream interrupted on attempt ${attempt}/${maxAttempts}, retrying in ${150 * attempt}ms...`,
        err
      );
      await new Promise((r) => setTimeout(r, 150 * attempt));
    }
  }
  throw lastErr;
}

async function bootApplication() {
  const host = typeof document !== 'undefined' ? document.querySelector('#app') : null;
  const loader = new MinimumProgressLoader(host);
  loader.mount();

  let isBootstrapping = true;
  const onBootstrapError = (event) => {
    if (!isBootstrapping || loader.isCompleted) return;
    if (event?.target && typeof window !== 'undefined' && event.target !== window && !(event instanceof ErrorEvent)) {
      return;
    }
    const err = event?.error instanceof Error
      ? event.error
      : new Error(event?.message || 'Uncaught exception during engine bootstrap');
    if (!err.stack && event?.filename) {
      err.stack = `${err.message}\n    at ${event.filename}:${event.lineno || 0}:${event.colno || 0}`;
    }
    loader.onError({
      taskId: loader.activeTaskId || 'bootstrap',
      taskName: loader.activeTaskName || 'Engine Bootstrap',
      error: err,
      isCritical: true
    });
  };

  const onBootstrapUnhandledRejection = (event) => {
    if (!isBootstrapping || loader.isCompleted) return;
    const reason = event?.reason;
    const err = reason instanceof Error
      ? reason
      : new Error(typeof reason === 'string' ? reason : 'Unhandled promise rejection during engine bootstrap');
    loader.onError({
      taskId: loader.activeTaskId || 'bootstrap',
      taskName: loader.activeTaskName || 'Engine Bootstrap',
      error: err,
      isCritical: true
    });
  };

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', onBootstrapError);
    window.addEventListener('unhandledrejection', onBootstrapUnhandledRejection);
  }

  import('./styles/game.css').catch((err) => {
    console.warn('[Engine] Non-fatal stylesheet stream warning:', err);
  });

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    await new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
      });
    });
  }

  try {
    loader.onTaskStart({
      taskId: 'bootstrap.module_graph',
      taskName: 'Loading Engine Core Modules...',
      step: 1,
      totalSteps: 8,
      stageIndex: 1,
      totalStages: 6,
      overallPercent: 2,
      taskType: 'indeterminate',
      category: 'Bootstrap Core',
      hint: 'Streaming and linking core runtime & 3D subsystems...'
    });

    // Stagger engine and UI module trees so cold-start HTTP/2 stream breadth stays low
    const { bootstrapEngine } = await importWithRetry(
      () => import('./game/GameBootstrap.js'),
      './game/GameBootstrap.js'
    );
    const { mountGameUI } = await importWithRetry(
      () => import('./ui-system/index.tsx'),
      './ui-system/index.tsx'
    );

    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(MODULE_RETRY_SESSION_KEY);
      }
    } catch (_e) {}

    await bootstrapEngine({ loader, mountUI: mountGameUI });

    if (isVerboseLogEnabled()) {
      console.log('[Engine] Rocket Companion Engine online — Free Play ready.');
    }
  } catch (err) {
    // If a sub-module inside the static import graph failed at the HTTP/2 transport layer
    // on a cold cache, perform a single automatic page reload so cached modules finish cleanly.
    if (isModuleImportError(err) && typeof window !== 'undefined') {
      try {
        const now = Date.now();
        const lastReload = Number(sessionStorage.getItem(MODULE_RETRY_SESSION_KEY) || 0);
        if (!lastReload || now - lastReload > 15000) {
          sessionStorage.setItem(MODULE_RETRY_SESSION_KEY, String(now));
          console.warn('[Engine] Cold-start module transport interrupted; performing automatic recovery reload...');
          window.location.reload();
          return;
        }
      } catch (_storageErr) {}
    }

    console.error('[Engine] Fatal bootstrap failure:', err);
    loader.onError({
      taskId: loader.activeTaskId || 'bootstrap',
      taskName: loader.activeTaskName || 'Engine Bootstrap',
      error: err,
      isCritical: true
    });
  } finally {
    isBootstrapping = false;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('error', onBootstrapError);
      window.removeEventListener('unhandledrejection', onBootstrapUnhandledRejection);
    }
  }
}

bootApplication();
