import { defineConfig } from 'vite';
import { resolve } from 'path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

/**
 * Raises Node.js Http2SecureServer maxConcurrentStreams (default 100 -> 1000) and
 * maxSessionMemory (default 1000 -> 4096) so cold-cache ESM waterfall bursts (~460 modules)
 * and WebWorker module graphs in Safari/WebKit never trigger NGHTTP2_REFUSED_STREAM
 * ("The network connection was lost" / "Importing a module script failed").
 */
function http2HighConcurrencyPlugin() {
  return {
    name: 'rc-http2-high-concurrency',
    configureServer(server) {
      const httpServer = server.httpServer;
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

      httpServer.on('session', (session) => {
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
    }
  };
}

function customParameterUrlsPlugin() {
  return {
    name: 'rc-custom-parameter-urls',
    configureServer(server) {
      const originalPrintUrls = server.printUrls.bind(server);

      server.printUrls = () => {
        originalPrintUrls();

        const localUrls = server.resolvedUrls?.local ?? [];
        const networkUrls = server.resolvedUrls?.network ?? [];
        if (localUrls.length === 0 && networkUrls.length === 0) return;

        const localBaseUrl = localUrls[0] || 'https://localhost:3001/';
        const networkBaseUrl =
          networkUrls.find((url) => url.includes('192.168.1.150')) ||
          localBaseUrl.replace('localhost', '192.168.1.150');

        const formatUrlWithQuery = (baseUrl, query) => {
          const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
          return `${normalizedBaseUrl}${query}`;
        };

        const parameterUrlEntries = [
          { label: 'Developer Mode', url: formatUrlWithQuery(localBaseUrl, '?dev=1') },
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

export default defineConfig({
  clearScreen: false,
  worker: {
    format: 'es'
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  optimizeDeps: {
    entries: [
      'index.html',
      'src/main.js',
      'src/game/GameBootstrap.js',
      'src/ui-system/index.tsx',
      'src/network/server/AuthoritativeServerWorker.js'
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
        './src/main.js',
        './src/styles/game.css',
        './src/game/GameBootstrap.js',
        './src/game/GameRuntime.js',
        './src/game/modes/GameModeManager.js',
        './src/game/modes/ExperimentalMultiBotsMode.js',
        './src/game/modes/experimental-multi-bots/ExperimentalMultiBotsRosterHelper.js',
        './src/game/modes/experimental-multi-bots/ExperimentalMultiBotsReplayHelper.js',
        './src/entities/stadium/driftwoods/DriftwoodsMaterialManager.js',
        './src/entities/stadium/driftwoods/WallFxShaderController.js',
        './src/ui-system/index.tsx',
        './src/ui-system/GameUIRoot.tsx',
        './src/network/server/AuthoritativeServerWorker.js'
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
    react(),
    tailwindcss(),
    basicSsl(),
    http2HighConcurrencyPlugin(),
    customParameterUrlsPlugin()
  ]
});
