import { getNameTagRuntimeState, setNameTagRuntimeState } from '../../runtimeUiPort.ts';
import type { FrameContext, PipelineStage } from '../FramePipeline.ts';

/**
 * PresentationStage.ts
 * Synchronizes 3D scene meshes, wheel rotations, network smoothing offsets,
 * flip reset particle visualizers, and delegates camera updates.
 */
export class PresentationStage implements PipelineStage {
  public runtime: any;

  constructor(runtime: any) {
    this.runtime = runtime;
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;
    const { dt, isMatchActive } = context;

    const getCarControls = (carIdx: number) => {
      if (r.match?.state?.mode === 'exp-multi-bots') {
        const expCtrl = r.modeManager?.getActiveMode()?.getCarControls?.(carIdx);
        if (expCtrl) return expCtrl;
      }
      if (carIdx === r.playerCarIndex) {
        return r.playerControls;
      }
      const remote = r.networkReconciler?.historyBuffer.lastRemoteControls?.get(carIdx);
      const ctrl = remote?.controls ? remote.controls : remote;
      if (ctrl) return ctrl;
      if (r.isBotMatch && carIdx === 1) return r.botControls || r.neutralControls;
      return r.neutralControls;
    };

    const car0Controls = getCarControls(0);
    const car0Throttle =
      r.playerCarIndex === 0 ? r.playerThrottle : (car0Controls?.throttle ?? 0);
    const car1Controls = getCarControls(1);

    if (r.arena) {
      r.arena.playerCarIndex = r.playerCarIndex;
      r.arena.isFreeCam = Boolean(r.camera?.isFreeCam);
      const camMeta = r.cameraSubsystem?.resolveFrameCameraMetadata?.(context);
      if (camMeta) {
        r.arena.isGoalReplayActive = camMeta.isGoalReplayActive;
        r.arena.cameraMode = camMeta.cameraMode;
        r.arena.isPovCamera = camMeta.isPovCamera;
        r.arena.focusedCarIndex = camMeta.obsTargetIdx;
      }
      if (r.camera?.camera) {
        r.arena.camera = r.camera.camera;
      }

      r.arena.update(
        r.interpolator.prevState,
        r.interpolator.currState,
        r.interpolator.alpha,
        dt,
        car0Throttle,
        car0Controls,
        car1Controls,
        isMatchActive,
        getCarControls,
      );
    }

    if (r.networkReconciler) {
      const activeCarMesh = r.arena?.cars?.[r.playerCarIndex];
      const smoothOffset = r.networkReconciler.updateSmoothing(dt);
      if (r.networkReconciler.enableSmoothing && activeCarMesh?.group && smoothOffset) {
        activeCarMesh.group.position.x += smoothOffset.x;
        activeCarMesh.group.position.y += smoothOffset.y;
        activeCarMesh.group.position.z += smoothOffset.z;
      }

      const ghostRenderer = r.networkManager?.diagnosticsProbe?.multiWorldGhostRenderer;
      if (
        r.networkReconciler.lobbyDualWorldMode &&
        r.networkReconciler.lobbyCurrAuthoritativeState &&
        ghostRenderer
      ) {
        ghostRenderer.setVisible(true);
        ghostRenderer.updateWorld(
          'lobby-remote',
          r.networkReconciler.lobbyPrevAuthoritativeState ||
            r.networkReconciler.lobbyCurrAuthoritativeState,
          r.networkReconciler.lobbyCurrAuthoritativeState,
          r.interpolator?.alpha ?? 1.0,
          dt,
          {
            paletteIndex: 0,
            excludeCarIndices:
              typeof r.playerCarIndex === 'number' && r.playerCarIndex > 0
                ? [1, 2, 3, 4, 5, 6, 7, r.playerCarIndex]
                : [1, 2, 3, 4, 5, 6, 7],
            getCarControls,
            showBall: true,
          },
        );
      }
    }

    for (const [cIdx, visual] of r.flipResetVisuals.entries()) {
      const cView = r.interpolator?.getCurrCarStateView(cIdx);
      visual.update(dt, cView ? !cView.isDemoed : true);
    }

    r.cameraSubsystem?.update?.(context);
    r.arena?.updateSubjectShadows?.();

    const activeCameraMode =
      r.arena?.cameraMode || r.camera?.currentMode || (r.camera?.isFreeCam ? 'free' : 'pov');
    const focusedCarIndex =
      typeof r.arena?.focusedCarIndex === 'number'
        ? r.arena.focusedCarIndex
        : (r.playerCarIndex ?? 0);
    const nameTagRuntime = getNameTagRuntimeState();
    if (
      nameTagRuntime.activeCameraMode !== activeCameraMode ||
      nameTagRuntime.focusedCarIndex !== focusedCarIndex
    ) {
      setNameTagRuntimeState({
        activeCameraMode,
        focusedCarIndex,
      });
    }

    const numCars = r.interpolator?.getCurrHeaderView?.()?.numCars ?? r.physics?.numCars ?? 0;
    r.arena?.nameTagSystem?.update(r.arena, numCars, r.camera?.camera);
    r.arena?.spatialAudioVisualizer?.update(r.arena, r.camera?.camera);

    if (r.profiler) r.profiler.mark();
  }
}
