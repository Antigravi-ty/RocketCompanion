import {
  isVerboseLogEnabled,
  ConsoleProgressObserver
} from './ConsoleProgressObserver.js';
import { MinimumProgressLoader } from './MinimumProgressLoader.js';
import { DualProgressUIAdapter } from './DualProgressUIAdapter.js';
import { LoadingOrchestrator } from './LoadingOrchestrator.js';
import { LoadingTask } from './LoadingTask.js';
import { verifyCameraMicrokernelIntegrity } from '../camera/exempt_pov_microkernel/CameraMicrokernel.js';
import { auditRequiredAssets, formatMissingAssetsHtml } from '../game/AssetDiagnostics.js';
import { fetchArenaCollisionManifest, fetchArenaCollisionChunks } from '../physics/RocketSimMeshLoader.js';

export {
  isVerboseLogEnabled,
  ConsoleProgressObserver,
  MinimumProgressLoader,
  DualProgressUIAdapter,
  LoadingOrchestrator,
  LoadingTask
};

export function buildEngineLoadingPipeline(runtime, options = {}) {
  const orchestrator = new LoadingOrchestrator(options);

  orchestrator.registerTask(
    new LoadingTask({
      id: 'preflight.camera_microkernel',
      name: 'Verify Camera Microkernel Integrity',
      stage: 1,
      stageName: 'Security Preflight',
      type: 'indeterminate',
      category: 'Security Preflight',
      hint: 'Verifying camera.wasm SHA-256 Digest & Linear Memory Contract...',
      weight: 1.0,
      critical: true,
      run: async (ctx) => {
        ctx.reportProgress(0.2, 'Checking SHA-256 and ABI contract...');
        await verifyCameraMicrokernelIntegrity(options);
        ctx.reportProgress(1.0, 'POV camera microkernel verified');
      }
    })
  );

  orchestrator.registerTask(
    new LoadingTask({
      id: 'diagnostics.static_assets',
      name: 'Audit Static Assets & Headers',
      stage: 2,
      stageName: 'Asset Diagnostics',
      type: 'indeterminate',
      category: 'Asset Diagnostics',
      hint: 'Auditing asset availability and binary headers...',
      weight: 1.0,
      critical: true,
      run: async (ctx) => {
        ctx.reportProgress(0.3, 'Auditing asset availability and binary headers...');
        const { missingCritical } = await auditRequiredAssets();

        if (missingCritical && missingCritical.length > 0) {
          const err = new Error(formatMissingAssetsHtml(missingCritical));
          err.isAssetError = true;
          throw err;
        }

        ctx.reportProgress(1.0, 'Asset diagnostics passed');
      }
    })
  );

  orchestrator.registerTask(
    new LoadingTask({
      id: 'physics.manifest.fetch',
      name: 'Fetch Arena Collision Manifest',
      stage: 3,
      stageName: 'Physics & Collision Mesh',
      type: 'determinate',
      category: 'Physics & Collision',
      weight: 0.15,
      critical: true,
      run: async (ctx) => {
        ctx.reportProgress(0.2, 'Requesting /arenamesh/manifest.json');
        const chunkFilenames = await fetchArenaCollisionManifest();
        ctx.setShared('meshFilenames', chunkFilenames);
        ctx.reportProgress(1.0, `Discovered ${chunkFilenames.length} arena mesh chunks`);
      }
    })
  );

  orchestrator.registerTask(
    new LoadingTask({
      id: 'physics.mesh.stream',
      name: 'Stream 16 Arena Mesh Chunks',
      stage: 3,
      stageName: 'Physics & Collision Mesh',
      type: 'determinate',
      category: 'Physics & Collision',
      weight: 0.45,
      dependencies: ['physics.manifest.fetch'],
      critical: true,
      run: async (ctx) => {
        const filenames = ctx.getShared('meshFilenames') || [];
        const chunks = await fetchArenaCollisionChunks(filenames, {
          fetchBuffer: (url) => ctx.downloadTracker.fetchBuffer(url),
          onChunkLoaded: (completed, total, chunkFile) => {
            ctx.reportProgress(completed / total, `Chunk ${completed}/${total} (${chunkFile})`);
          }
        });

        ctx.setShared('collisionChunks', chunks);
        ctx.reportProgress(1.0, 'All collision mesh chunks downloaded');
      }
    })
  );

  orchestrator.registerTask(
    new LoadingTask({
      id: 'physics.engine.init',
      name: 'Initialize RocketSim WASM & Arena',
      stage: 3,
      stageName: 'Physics & Collision Mesh',
      type: 'indeterminate',
      category: 'Physics & Collision',
      hint: 'Allocating RocketSim WASM linear heap & compiling collision BVH tree...',
      weight: 0.40,
      dependencies: ['physics.mesh.stream', 'preflight.camera_microkernel'],
      critical: true,
      run: async (ctx) => {
        ctx.reportProgress(0.2, 'Allocating WASM heap & compiling rigid-body physics...');
        const collisionData = ctx.getShared('collisionChunks');
        await runtime.setupPhysics({ collisionData });
        ctx.reportProgress(1.0, 'Arena collision space created & player car allocated');
      }
    })
  );

  const isTouchHeadless =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('touch') === '2';

  orchestrator.registerTask(
    new LoadingTask({
      id: 'geometry.scene.build',
      name: 'Stream 3D Stadium, Vehicle & Pad Geometries',
      stage: 4,
      stageName: '3D Geometry & Assets',
      type: 'determinate',
      category: '3D Geometry',
      weight: 1.0,
      dependencies: ['physics.engine.init'],
      critical: true,
      run: async (ctx) => {
        if (isTouchHeadless) {
          console.info('[Loading][Headless] Headless Parameter Detected (?touch=2) — skipping 3D Stadium & Vehicle GLB asset streaming.');
        }
        await runtime.setupScene((ratio, detail) => {
          ctx.reportProgress(ratio, detail);
        });
        ctx.reportProgress(
          1.0,
          isTouchHeadless
            ? 'Headless Parameter Detected (?touch=2) — 3D scene graph exempted'
            : '3D scene graph & UI overlays mounted'
        );
      }
    })
  );

  orchestrator.registerTask(
    new LoadingTask({
      id: 'shaders.prewarm',
      name: 'Prewarm Shaders & Composite Passes',
      stage: 5,
      stageName: 'Shader Pipeline Prewarming',
      type: 'indeterminate',
      category: 'Graphics Pipeline',
      hint: 'Compiling PBR Uber-Shaders across visual themes (WebGL compileAsync)...',
      weight: 1.0,
      dependencies: ['geometry.scene.build'],
      critical: true,
      run: async (ctx) => {
        if (isTouchHeadless) {
          console.info('[Loading][Headless] Headless Parameter Detected (?touch=2) — skipping WebGL shader prewarming.');
        }
        await runtime.setupShaders((ratio, theme) => {
          ctx.reportProgress(ratio, `Prewarming materials for theme: ${theme}`);
        });
        ctx.reportProgress(
          1.0,
          isTouchHeadless
            ? 'Headless Parameter Detected (?touch=2) — WebGL shader compilation exempted'
            : 'All visual shaders compiled into GPU cache'
        );
      }
    })
  );

  orchestrator.registerTask(
    new LoadingTask({
      id: 'ignition.clock_scheduler',
      name: 'Ignite 120Hz Clock & Synchronize First Frame',
      stage: 6,
      stageName: 'Engine Ignition',
      type: 'indeterminate',
      category: 'Engine Ignition',
      hint: 'Activating 120Hz deterministic render clock & synchronizing frame 0...',
      weight: 1.0,
      dependencies: ['shaders.prewarm'],
      critical: true,
      run: async (ctx) => {
        ctx.reportProgress(
          0.5,
          isTouchHeadless
            ? 'Igniting 120Hz headless physics clock (?touch=2)...'
            : 'Synchronizing physics interpolator and rendering frame 0...'
        );
        runtime.ignite();
        ctx.reportProgress(
          1.0,
          isTouchHeadless
            ? 'Headless ignition complete (?touch=2). Simulation running at 120Hz.'
            : 'Engine ignition complete. Simulation running at 120Hz.'
        );
      }
    })
  );

  return orchestrator;
}

export async function startBackgroundAssetPipeline(runtime, onProgress = null, options = {}) {
  const verbose = isVerboseLogEnabled();
  const startTime = performance.now();

  if (verbose) {
    console.log('[Loading] > Background asset pipeline started for non-essential subsystems...');
  }

  const notifyStore = options.notifyStore || null;
  const taskId = 'background-asset-pipeline';
  if (notifyStore) {
    notifyStore.pushOngoingNotification({
      id: taskId,
      type: 'background',
      title: 'Background Assets',
      content: 'Synchronizing audio, fonts & AI models...',
      icon: 'Layers',
      progress: 0,
      tone: 'info',
      isSpinningIcon: true
    });
  }

  const taskProgress = { audio: 0, fonts: 0, bot: 0 };
  const updateOverall = (cat, ratio, desc) => {
    taskProgress[cat] = Math.min(1, Math.max(0, ratio));
    const totalRatio = (taskProgress.audio + taskProgress.fonts + taskProgress.bot) / 3;
    if (notifyStore) {
      notifyStore.updateOngoingNotification(taskId, {
        progress: totalRatio,
        content: desc || `Synchronizing assets (${Math.round(totalRatio * 100)}%)`
      });
    }
  };

  const backgroundTasks = [
    {
      name: '41-Channel Spatial Audio Pool',
      run: async () => {
        await runtime.setupAudio((loaded, total, file) => {
          const filename = file ? file.split('/').pop() : '';
          const ratio = total > 0 ? loaded / total : 1.0;
          const msg = `Audio pool: ${loaded}/${total} (${filename})`;
          if (onProgress) onProgress('audio', ratio, msg);
          updateOverall('audio', ratio, msg);
          if (verbose) {
            console.log(`[Loading][Background] ${msg}`);
          }
        });
        updateOverall('audio', 1.0, '41-channel audio architecture ready.');
        if (verbose) {
          console.log('[Loading][Background] 41-channel audio architecture ready.');
        }
      }
    },
    {
      name: 'Web Font Preloader',
      run: async () => {
        if (typeof document !== 'undefined' && document.fonts) {
          const fontList = ['400 14px "JetBrains Mono"', '400 16px Archivo', '500 16px Archivo', '700 16px Archivo', '400 20px "Lilita One"'];
          let loaded = 0;
          await Promise.all(
            fontList.map(async (f) => {
              try {
                await document.fonts.load(f);
              } catch (err) {
                console.warn(`[Loading][Background] Failed to preload web font "${f}":`, err);
              }
              loaded++;
              const ratio = loaded / fontList.length;
              const msg = `Font loaded: ${f} (${loaded}/${fontList.length})`;
              if (onProgress) onProgress('fonts', ratio, msg);
              updateOverall('fonts', ratio, msg);
              if (verbose) {
                console.log(`[Loading][Background] ${msg}`);
              }
            })
          );
          updateOverall('fonts', 1.0, 'Web fonts preloaded.');
        }
      }
    },
    {
      name: 'AI Bot Neural Policies (Seer, Necto, Nexto)',
      run: async () => {
        await runtime.setupBot((loaded, total, botId) => {
          const ratio = total > 0 ? loaded / total : 1.0;
          const msg = `Bot policy: ${botId} (${loaded}/${total})`;
          if (onProgress) onProgress('bot', ratio, msg);
          updateOverall('bot', ratio, msg);
          if (verbose) {
            console.log(`[Loading][Background] ${msg}`);
          }
        });
        updateOverall('bot', 1.0, 'AI Bot policies synchronized.');
        if (verbose) {
          console.log('[Loading][Background] AI Bot policies synchronized.');
        }
      }
    }
  ];

  try {
    await Promise.allSettled(backgroundTasks.map((t) => t.run()));
    if (verbose) {
      const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);
      console.log('[Loading] ══════════════ [Background Pipeline] All Assets Loaded ══════════════');
      console.log(`[Loading] Background asset pipeline complete in ${elapsedSec}s — all deferred subsystems synchronized.`);
    }
    if (notifyStore) {
      notifyStore.completeOngoingNotification(taskId, {
        content: 'All deferred assets synchronized',
        autoDismissMs: 3000,
        tone: 'info'
      });
    }
  } catch (err) {
    console.warn('[Loading][Background] Background asset pipeline warning:', err);
    if (notifyStore) {
      notifyStore.dismissOngoingNotification(taskId);
    }
  }
}
