import { useAppStore } from '../runtimeUiPort.ts';
import type { FrameContext } from '../pipeline/FramePipeline.ts';

/**
 * GameRenderSubsystem.ts
 * Encapsulates Three.js rendering passes, BoostBloom occluders,
 * supersonic speed lines, and composer execution.
 */
export class GameRenderSubsystem {
  public runtime: any;
  public lastBloomActive = true;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  public update(context: FrameContext): void {
    const r = this.runtime;
    const { dt, isMatchActive, isSupersonic } = context;

    if (!r.renderer || !r.composer || !r.camera?.camera) return;

    r.arena?.prepareBallSpeedTrail?.(r.camera.camera);

    if (r.speedLinesPass && r.cameraSubsystem) {
      r.speedLinesPass.update(
        dt,
        Boolean(isSupersonic && r.keyboard?.enabled && isMatchActive),
        r.cameraSubsystem.scratchVelocity,
        r.camera.camera,
      );
    }

    const winWidth = r.container
      ? r.container.clientWidth || window.innerWidth
      : window.innerWidth;
    const winHeight = r.container
      ? r.container.clientHeight || window.innerHeight
      : window.innerHeight;
    const curTick = r.physics?.getHeaderView()?.tickCount ?? 0;
    const activeMode = r.modeManager?.activeMode ?? r.modeManager?.getActiveMode?.();
    const activeReplayViewer = activeMode?.standaloneReplayViewer;
    const isStandaloneOrRewinderReplayActive = Boolean(
      (activeReplayViewer?.isActive && !activeReplayViewer?.isIntervening) ||
        activeMode?.rewinderController?.isBlockingLivePhysics,
    );
    const isGoalReplayActive = Boolean(
      r.arena?.isGoalReplayActive ||
        isStandaloneOrRewinderReplayActive ||
        r.cameraSubsystem?.resolveFrameCameraMetadata?.(context)?.isGoalReplayActive,
    );
    const isPodiumActive = Boolean(
      r.podiumController?.isActive || r.match?.state?.phase === 'podium',
    );
    if (r.ballTrajectoryPredictor) {
      r.ballTrajectoryPredictor.setSceneContext?.({
        isGoalReplayActive,
        isPodiumActive,
      });
      r.ballTrajectoryPredictor.update(
        curTick,
        r.arena?.ball?.position,
        winWidth,
        winHeight,
        r.physics,
      );
    }
    if (r.reachabilityVisualizer) {
      r.reachabilityVisualizer.update(r, curTick, winWidth, winHeight);
    }

    const appState = useAppStore.getState();
    const isTransparentPreviewRoute =
      appState.activeRoute === 'trajectory' || appState.activeRoute === 'camera';
    const isLiveMenuOpen = Boolean(
      r.gameUI &&
        appState.isOpen &&
        !appState.isLivePreviewCollapsed &&
        !isTransparentPreviewRoute,
    );
    const isDocHidden = typeof document !== 'undefined' && document.hidden;
    const powerSave =
      appState.graphics?.menuPowerSave || (appState.pauseRenderingOnMenu ? 'freeze' : '30');
    const isExtremeFreeze = powerSave === 'freeze' || powerSave === 'extreme';
    const shouldSkipGpuRender =
      Boolean(context.shouldSkipGpuRender) ||
      isDocHidden || (isLiveMenuOpen && isExtremeFreeze);
    context.shouldSkipGpuRender = shouldSkipGpuRender;

    if (shouldSkipGpuRender) {
      return;
    }

    let flipResetBloom = false;
    if (r.flipResetVisuals && r.flipResetVisuals.size > 0) {
      for (const v of r.flipResetVisuals.values()) {
        if (v?.bloomActive) {
          flipResetBloom = true;
          break;
        }
      }
    }
    const isBloomActive =
      r.bloomEnabled !== false && Boolean(r.arena?.boostBloomActive || flipResetBloom);
    if (isBloomActive) {
      r.camera.camera.layers.set(0);
      r.bloomOcclusion.applyBloomOccluders();
      try {
        r.boostBloom.render(r.arena.scene, r.camera.camera);
      } finally {
        r.bloomOcclusion.restoreBloomMaterials();
      }
    } else if (this.lastBloomActive) {
      r.boostBloom?.clear?.();
    }
    this.lastBloomActive = isBloomActive;

    if (r.profiler) r.profiler.mark();

    if (r.renderer.shadowMap && (r.arena?.lighting?.shouldRenderShadowMap?.() ?? true)) {
      r.renderer.shadowMap.needsUpdate = true;
    }
    r.composer.render(dt);
  }

  public dispose(): void {}
}
