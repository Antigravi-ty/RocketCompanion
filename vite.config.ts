import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import fs from 'node:fs';
import { resolve } from 'path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;
const RESOLVED_DEV_PROFILE_PATH = resolve(__dirname, '.cache/resolvedProfile.json');

function readDevPrivateProfileSafe(): Record<string, any> | null {
  try {
    if (!fs.existsSync(RESOLVED_DEV_PROFILE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(RESOLVED_DEV_PROFILE_PATH, 'utf8'));
    if (parsed && parsed.profileSource === 'private' && Array.isArray(parsed.signaling?.relays)) {
      return parsed;
    }
  } catch {
    // Ignore read error
  }
  return null;
}

/**
 * Dev-only plugin (`apply: 'serve'`): injects `.cache/resolvedProfile.json` into the local dev session
 * and exposes `/__rc_dev_profile` without ever bundling private credentials into `vite build`.
 */
function rcPrivateCredentialsDevPlugin(): Plugin {
  return {
    name: 'rc-private-credentials-dev',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__rc_dev_profile', (req, res) => {
        const reqUrl = String(req.url || '').toLowerCase();
        const isNoKey = reqUrl.includes('nokey=1') || reqUrl.includes('nokey=true');
        const profile = isNoKey
          ? {
              profileSource: 'default',
              signaling: { defaultSignalingUrl: '', relays: [] },
              turn: { iceServers: [] },
            }
          : readDevPrivateProfileSafe() || {
              profileSource: 'default',
              signaling: { defaultSignalingUrl: '', relays: [] },
              turn: { iceServers: [] },
            };
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(profile));
      });
    },
    transformIndexHtml() {
      const profile = readDevPrivateProfileSafe();
      if (!profile) return [];
      return [
        {
          tag: 'script',
          attrs: { id: 'rc-dev-private-profile' },
          children: `if (!/[?&]nokey=(1|true|yes)/i.test(window.location.search)) { window.__RC_DEV_PRIVATE_PROFILE__ = ${JSON.stringify(profile)}; }`,
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

/**
 * Raises Node.js Http2SecureServer maxConcurrentStreams (default 100 -> 1000) and
 * maxSessionMemory (default 1000 -> 4096) so cold-cache ESM waterfall bursts (~460 modules)
 * and WebWorker module graphs in Safari/WebKit never trigger NGHTTP2_REFUSED_STREAM
 * ("The network connection was lost" / "Importing a module script failed").
 */
function http2HighConcurrencyPlugin(): Plugin {
  return {
    name: 'rc-http2-high-concurrency',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const rangeHeader = req.headers.range;
        const reqUrl = String(req.url || '');
        if (rangeHeader) {
          // Vite's sirv checks If-None-Match before Range and returns an empty 304 on sub-range requests,
          // which wedges browser sparse 206 cache entries. Always serve 206 Partial Content for Range requests.
          delete req.headers['if-none-match'];
          delete req.headers['if-modified-since'];
          if (reqUrl.includes('__rc_audit=') || rangeHeader === 'bytes=0-15') {
            res.setHeader('Cache-Control', 'no-store');
          }
        }
        next();
      });

      const httpServer = server.httpServer as Record<string | symbol, any> | null;
      if (!httpServer) return;

      httpServer.timeout = 0;
      httpServer.keepAliveTimeout = 60000;

      const optSym = Object.getOwnPropertySymbols(httpServer).find(
        (s) => s.description === 'options'
      );
      if (optSym && httpServer[optSym]) {
        httpServer[optSym].maxSessionMemory = 4096;
        httpServer[optSym].settings = {
          ...(httpServer[optSym].settings || {}),
          maxConcurrentStreams: 1000
        };
      }

      const activeSessions = new Set<Record<string, any>>();
      httpServer.on('session', (session: Record<string, any>) => {
        activeSessions.add(session);
        session.once?.('close', () => {
          activeSessions.delete(session);
        });
        try {
          if (typeof session.settings === 'function') {
            session.settings({ maxConcurrentStreams: 1000 });
          }
          if (typeof session.setTimeout === 'function') {
            session.setTimeout(0);
          }
        } catch (_err) {
          // Ignore if session is already closing
        }
      });

      httpServer.once?.('close', () => {
        for (const session of activeSessions) {
          try {
            session.destroy?.();
          } catch (_err) {
            // Ignore session destroy errors during shutdown
          }
        }
        activeSessions.clear();
      });
    }
  };
}

function customParameterUrlsPlugin(): Plugin {
  return {
    name: 'rc-custom-parameter-urls',
    configureServer(server: ViteDevServer) {
      const originalPrintUrls = server.printUrls.bind(server);

      server.printUrls = () => {
        originalPrintUrls();

        const localUrls = server.resolvedUrls?.local ?? [];
        const networkUrls = server.resolvedUrls?.network ?? [];
        if (localUrls.length === 0 && networkUrls.length === 0) return;

        const localBaseUrl = localUrls[0] || 'https://localhost:3001/';
        const networkBaseUrl =
          networkUrls[0] ||
          localBaseUrl.replace('localhost', '192.0.2.1');

        const formatUrlWithQuery = (baseUrl: string, query: string): string => {
          const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
          return `${normalizedBaseUrl}${query}`;
        };

        const parameterUrlEntries = [
          { label: 'Developer Mode', url: formatUrlWithQuery(localBaseUrl, '?dev=1') },
          { label: 'No-Key Sim Mode', url: formatUrlWithQuery(localBaseUrl, '?nokey=1') },
          { label: 'Touch Mode', url: formatUrlWithQuery(networkBaseUrl, '?touch=1') },
          { label: 'Headless Mode', url: formatUrlWithQuery(networkBaseUrl, '?touch=2') }
        ];

        console.log('\n  Custom Parameter URLs:');
        for (const { label, url } of parameterUrlEntries) {
          console.log(`  ->  ${label.padEnd(15)}: ${url}`);
        }
      };
    }
  };
}

function resolveWorktreeGitDir(worktreePath: string): string | null {
  try {
    const dotGitPath = resolve(worktreePath, '.git');
    if (!fs.existsSync(dotGitPath)) return null;
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGitPath, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/i.exec(content);
      if (match?.[1]) {
        return resolve(worktreePath, match[1].trim());
      }
    }
  } catch {
    // Ignore gitdir resolution errors
  }
  return null;
}

function resolveCommonGitDir(gitDir: string): string {
  try {
    const commonDirFile = resolve(gitDir, 'commondir');
    if (fs.existsSync(commonDirFile)) {
      const rel = fs.readFileSync(commonDirFile, 'utf8').trim();
      if (rel) {
        return resolve(gitDir, rel);
      }
    }
  } catch {
    // Ignore commondir resolution errors
  }
  return gitDir;
}

function readLastHeadLogSha(gitDir: string): string | null {
  try {
    const logPath = resolve(gitDir, 'logs/HEAD');
    if (!fs.existsSync(logPath)) return null;
    const content = fs.readFileSync(logPath, 'utf8').trim();
    if (!content) return null;
    const lastLine = content.slice(content.lastIndexOf('\n') + 1).trim();
    const parts = lastLine.split(/\s+/);
    if (parts.length >= 2 && /^[0-9a-f]{40}$/i.test(parts[1])) {
      return parts[1].slice(0, 12);
    }
  } catch {
    // Ignore reflog read errors
  }
  return null;
}

function resolveRefCommitSha(gitDir: string, refName: string): string {
  const commonGitDir = resolveCommonGitDir(gitDir);
  const candidateDirs = commonGitDir !== gitDir ? [gitDir, commonGitDir] : [gitDir];
  try {
    for (const dir of candidateDirs) {
      const looseRefPath = resolve(dir, refName);
      if (fs.existsSync(looseRefPath)) {
        return fs.readFileSync(looseRefPath, 'utf8').trim().slice(0, 12);
      }
    }
    for (const dir of candidateDirs) {
      const packedRefsPath = resolve(dir, 'packed-refs');
      if (fs.existsSync(packedRefsPath)) {
        const lines = fs.readFileSync(packedRefsPath, 'utf8').split('\n');
        const suffix = ` ${refName}`;
        for (const line of lines) {
          if (!line || line.startsWith('#') || line.startsWith('^')) continue;
          if (line.endsWith(suffix)) {
            return line.slice(0, 12);
          }
        }
      }
    }
    const reflogSha = readLastHeadLogSha(gitDir);
    if (reflogSha) return reflogSha;
  } catch {
    // Ignore ref read errors
  }
  return 'unknown';
}

function readWorktreeHeadSnapshot(
  label: string,
  worktreePath: string
): { summary: string; locked: boolean } {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  if (!gitDir) {
    return { summary: `${label}:uninitialized`, locked: false };
  }
  const commonGitDir = resolveCommonGitDir(gitDir);
  try {
    if (
      fs.existsSync(resolve(gitDir, 'index.lock')) ||
      fs.existsSync(resolve(gitDir, 'HEAD.lock')) ||
      fs.existsSync(resolve(commonGitDir, 'index.lock')) ||
      fs.existsSync(resolve(commonGitDir, 'HEAD.lock'))
    ) {
      return { summary: '', locked: true };
    }
    const headPath = resolve(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) {
      return { summary: `${label}:no-head`, locked: false };
    }
    const headRaw = fs.readFileSync(headPath, 'utf8').trim();
    if (headRaw.startsWith('ref:')) {
      const refName = headRaw.slice(4).trim();
      const shortBranch = refName.replace(/^refs\/heads\//, '');
      const sha = resolveRefCommitSha(gitDir, refName);
      return { summary: `${label}:${shortBranch}@${sha}`, locked: false };
    }
    return { summary: `${label}:detached@${headRaw.slice(0, 12)}`, locked: false };
  } catch {
    return { summary: `${label}:error`, locked: false };
  }
}

function readCompositeGitHeadState(): { signature: string | null; locked: boolean } {
  const targets = [
    { label: 'root', path: __dirname },
    { label: 'ui-core', path: resolve(__dirname, 'src/ui-core') },
    { label: 'public', path: resolve(__dirname, 'public') },
  ];
  const parts: string[] = [];
  for (const t of targets) {
    const snap = readWorktreeHeadSnapshot(t.label, t.path);
    if (snap.locked) {
      return { signature: null, locked: true };
    }
    parts.push(snap.summary);
  }
  return { signature: parts.join(' | '), locked: false };
}

/**
 * Dev-only plugin (`apply: 'serve'`): monitors `.git/HEAD` and active branch refs across
 * the main repository and initialized submodules (`src/ui-core`, `public`). When a branch switch
 * or commit checkout settles on disk, automatically invalidates the module graph and restarts
 * the Vite dev server in-process so ETag caching remains intact without stale cross-branch state.
 */
function rcGitHeadAutoRestartPlugin(): Plugin {
  return {
    name: 'rc-git-head-auto-restart',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      let baselineSignature = readCompositeGitHeadState().signature;
      let isRestarting = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;

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
              await server.restart();
              server.ws?.send?.({ type: 'full-reload', path: '*' });
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

export default defineConfig({
  clearScreen: false,
  worker: {
    format: 'es'
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  optimizeDeps: {
    entries: [
      'index.html',
      'src/main.ts',
      'src/game/GameBootstrap.ts',
      'src/ui-system/index.tsx',
      'src/network/server/AuthoritativeServerWorker.ts'
    ],
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'three',
      'three/addons/lines/LineMaterial.js',
      'three/addons/lines/LineSegments2.js',
      'three/addons/lines/LineSegmentsGeometry.js',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/postprocessing/Pass.js',
      'three/addons/shaders/CopyShader.js',
      'zustand',
      'framer-motion',
      'lucide-react',
      '@radix-ui/react-dialog',
      '@radix-ui/react-slider',
      '@radix-ui/react-slot',
      '@radix-ui/react-tabs',
      'clsx',
      'tailwind-merge'
    ]
  },
  server: {
    host: host || true,
    port: 3001,
    strictPort: true,
    open: false,
    watch: {
      ignored: ['**/src-tauri/**']
    },
    warmup: {
      clientFiles: [
        './src/main.ts',
        './src/styles/game.css',
        './src/game/GameBootstrap.ts',
        './src/game/GameRuntime.ts',
        './src/game/modes/GameModeManager.ts',
        './src/game/modes/ExperimentalMultiBotsMode.ts',
        './src/game/modes/experimental-multi-bots/ExperimentalMultiBotsRosterController.ts',
        './src/game/modes/experimental-multi-bots/ExperimentalMultiBotsReplayController.ts',
        './src/entities/stadium/driftwoods/DriftwoodsMaterialManager.ts',
        './src/entities/stadium/driftwoods/WallFxShaderController.ts',
        './src/ui-system/index.tsx',
        './src/ui-system/GameUIRoot.tsx',
        './src/network/server/AuthoritativeServerWorker.ts'
      ]
    },
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
  },
  preview: {
    host: true,
    port: 3001,
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    target: 'esnext'
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  },
  plugins: [
    rcPrivateCredentialsDevPlugin(),
    rcGitHeadAutoRestartPlugin(),
    react(),
    tailwindcss(),
    basicSsl(),
    http2HighConcurrencyPlugin(),
    customParameterUrlsPlugin()
  ]
});
