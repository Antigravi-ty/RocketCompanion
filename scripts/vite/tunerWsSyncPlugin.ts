import fs from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { computeVisualFileHash } from '../../src/ui-core/manifest/visualFileHash.ts';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UI_CORE_DIR = resolve(ROOT_DIR, 'src/ui-core');

function collectUiCoreFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      collectUiCoreFiles(fullPath, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(fullPath);
    }
  }
  return out;
}

function toUiCoreRelPath(absPath: string): string | null {
  const rel = relative(UI_CORE_DIR, absPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || (!rel.endsWith('.ts') && !rel.endsWith('.tsx'))) {
    return null;
  }
  return `src/ui-core/${rel}`;
}

/**
 * Lightweight Vite WebSocket State Relay Plugin for RCUITuner (Port 3002).
 * Reuses Vite's built-in WebSocket server (`server.ws`) so that multiple tabs,
 * macOS Safari Private Browsing windows, and other devices on the same LAN
 * stay synchronized in real time with zero external dependencies.
 * Also serves `/__rc_ui_core_hashes` so the browser never needs 500+ `?raw` HTTP requests.
 */
export function rcUiTunerSyncPlugin(): Plugin {
  const stateRegistry = new Map<string, unknown>();
  const uiCoreHashesCache = new Map<string, string>();
  let hashesCacheReady = false;
  let hashesCacheJson: string | null = null;

  const ensureUiCoreHashesBuilt = () => {
    if (hashesCacheReady) return;
    const t0 = performance.now();
    const files = collectUiCoreFiles(UI_CORE_DIR);
    uiCoreHashesCache.clear();
    for (const fullPath of files) {
      const rel = toUiCoreRelPath(fullPath);
      if (!rel) continue;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        uiCoreHashesCache.set(rel, computeVisualFileHash(content));
      } catch {
        // Ignore unreadable files
      }
    }
    hashesCacheReady = true;
    hashesCacheJson = null;
    const elapsedMs = (performance.now() - t0).toFixed(1);
    console.log(
      `[rc-tuner] UI Core hash cache ready: ${uiCoreHashesCache.size} files hashed in ${elapsedMs}ms`
    );
  };

  const getHashesJson = (): string => {
    ensureUiCoreHashesBuilt();
    if (!hashesCacheJson) {
      hashesCacheJson = JSON.stringify({
        hashes: Object.fromEntries(uiCoreHashesCache.entries()),
      });
    }
    return hashesCacheJson;
  };

  return {
    name: 'rc-ui-tuner-ws-sync',
    configureServer(server: ViteDevServer) {
      console.log('[rc-tuner] Initializing UI Tuner dev server & pre-warming hash cache...');

      server.httpServer?.once('listening', () => {
        setImmediate(() => {
          ensureUiCoreHashesBuilt();
        });
      });

      server.middlewares.use('/__rc_ui_core_hashes', (_req, res) => {
        const payload = getHashesJson();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(payload);
      });

      const handleUiCoreFileEvent = (absPath: string, removed: boolean) => {
        const rel = toUiCoreRelPath(absPath);
        if (!rel) return;
        if (!hashesCacheReady) {
          ensureUiCoreHashesBuilt();
        }
        let nextHash: string | null = null;
        if (removed) {
          uiCoreHashesCache.delete(rel);
        } else {
          try {
            const content = fs.readFileSync(absPath, 'utf8');
            nextHash = computeVisualFileHash(content);
            uiCoreHashesCache.set(rel, nextHash);
          } catch {
            uiCoreHashesCache.delete(rel);
          }
        }
        hashesCacheJson = null;
        server.ws.send('rc-ui-tuner:ui-core-hashes-updated', {
          file: rel,
          hash: nextHash,
        });
      };

      server.watcher.on('change', (p) => handleUiCoreFileEvent(p, false));
      server.watcher.on('add', (p) => handleUiCoreFileEvent(p, false));
      server.watcher.on('unlink', (p) => handleUiCoreFileEvent(p, true));

      server.ws.on(
        'rc-ui-tuner:sync-patch',
        (data: { senderId?: string; entries?: Record<string, unknown>; ts?: number }) => {
          if (!data || !data.entries || typeof data.entries !== 'object') return;
          for (const [key, value] of Object.entries(data.entries)) {
            if (key === 'store:menuLayout' || key === 'store:floating') continue;
            stateRegistry.set(key, value);
          }
          server.ws.send('rc-ui-tuner:sync-patch', data);
        }
      );

      server.ws.on(
        'rc-ui-tuner:sync-seed',
        (data: { senderId?: string; entries?: Record<string, unknown> }) => {
          if (!data || !data.entries || typeof data.entries !== 'object') return;
          const newlySeeded: Record<string, unknown> = {};
          let hasNew = false;
          for (const [key, value] of Object.entries(data.entries)) {
            if (!stateRegistry.has(key)) {
              stateRegistry.set(key, value);
              newlySeeded[key] = value;
              hasNew = true;
            }
          }
          if (hasNew) {
            server.ws.send('rc-ui-tuner:sync-patch', {
              senderId: data.senderId,
              entries: newlySeeded,
              ts: Date.now(),
            });
          }
        }
      );

      server.ws.on(
        'rc-ui-tuner:sync-request',
        (data: { senderId?: string }, client) => {
          const entries = Object.fromEntries(stateRegistry.entries());
          client.send('rc-ui-tuner:sync-snapshot', {
            targetId: data?.senderId,
            entries,
            ts: Date.now(),
          });
        }
      );

      server.ws.on(
        'rc-ui-tuner:sync-reset',
        (data: { senderId?: string; scopePrefix?: string; ts?: number }) => {
          if (data?.scopePrefix) {
            for (const key of Array.from(stateRegistry.keys())) {
              if (key.startsWith(data.scopePrefix)) {
                stateRegistry.delete(key);
              }
            }
          } else {
            stateRegistry.clear();
          }
          server.ws.send('rc-ui-tuner:sync-reset', {
            senderId: data?.senderId,
            scopePrefix: data?.scopePrefix,
            ts: Date.now(),
          });
        }
      );
    },
  };
}

/**
 * Serves a custom root HTML file (`tuner.html` or `entry.html`) when accessing `/` on dedicated ports (3000 or 3002).
 */
export function customHtmlEntryPlugin(
  htmlFilename: string,
  statusResolver?: () => Record<string, boolean>
): Plugin {
  const htmlPath = resolve(ROOT_DIR, htmlFilename);
  return {
    name: `rc-custom-html-entry-${htmlFilename}`,
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (statusResolver) {
        server.middlewares.use('/__rc_entry_status', (_req, res) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(statusResolver()));
        });
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next();
        const urlPath = req.url.split('?')[0];
        if (urlPath === '/' || urlPath === '/index.html' || urlPath === `/${htmlFilename}`) {
          try {
            const rawHtml = fs.readFileSync(htmlPath, 'utf8');
            const transformed = await server.transformIndexHtml(req.url, rawHtml);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(transformed);
            return;
          } catch (err) {
            return next(err);
          }
        }
        next();
      });
    },
  };
}
