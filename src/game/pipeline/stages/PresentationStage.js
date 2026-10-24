/**
 * PresentationStage.js
 * Synchronizes 3D scene meshes, wheel rotations, network smoothing offsets,
 * flip reset particle visualizers, and delegates camera updates.
 */
export class PresentationStage {
  constructor(runtime) {
    this.runtime = runtime;
  }

  execute(context) {
    const r = this.runtime;
    const { dt, isMatchActive } = context;

    const getCarControls = (carIdx) => {
      if (r.match?.state?.mode === 'exp-multi-bots') {
        const expCtrl = r.modeManager?.getActiveMode()?.getCarControls?.(carIdx);
        if (expCtrl) return expCtrl;
      }
      if (carIdx === r.playerCarIndex) {
        return r.playerControls;
      }
      const remote = r.networkReconciler?.lastRemoteControls?.get(carIdx);
      const ctrl = remote?.controls ? remote.controls : remote;
      if (ctrl) return ctrl;
      if (r.isBotMatch && carIdx === 1) return r.botControls || r.neutralControls;
      return r.neutralControls;
    };

    const car0Controls = getCarControls(0);
    const car0Throttle = r.playerCarIndex === 0 ? r.playerThrottle : (car0Controls?.throttle ?? 0);
    const car1Controls = getCarControls(1);

    r.arena.playerCarIndex = r.playerCarIndex;
    r.arena.isFreeCam = Boolean(r.camera?.isFreeCam);
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
      getCarControls
    );

    // Apply network prediction smoothing to player car mesh
    if (r.networkReconciler) {
      const activeCarMesh = r.arena?.cars?.[r.playerCarIndex];
      const smoothOffset = r.networkReconciler.updateSmoothing(dt);
      if (r.networkReconciler.enableSmoothing && activeCarMesh?.group && smoothOffset) {
        activeCarMesh.group.position.x += smoothOffset.x;
        activeCarMesh.group.position.y += smoothOffset.y;
        activeCarMesh.group.position.z += smoothOffset.z;
      }

      // Channel A: Lobby Dual-World Ghost Rendering (Host + remote peers up to 8 cars + remote ball, no ball trajectory line)
      if (
        r.networkReconciler.lobbyDualWorldMode &&
        r.networkReconciler.lobbyCurrAuthoritativeState &&
        r.multiWorldGhostRenderer
      ) {
        r.multiWorldGhostRenderer.setVisible(true);
        r.multiWorldGhostRenderer.updateWorld(
          'lobby-remote',
          r.networkReconciler.lobbyPrevAuthoritativeState || r.networkReconciler.lobbyCurrAuthoritativeState,
          r.networkReconciler.lobbyCurrAuthoritativeState,
          r.interpolator?.alpha ?? 1.0,
          dt,
          {
            paletteIndex: 0,
            excludeCarIndices: [1, 2, 3, 4, 5, r.playerCarIndex],
            getCarControls,
            showBall: true
          }
        );
      }
    }

    // Flip reset particle effects
    for (const [cIdx, visual] of r.flipResetVisuals.entries()) {
      const cView = r.interpolator?.getCurrCarStateView(cIdx);
      visual.update(dt, cView ? !cView.isDemoed : true);
    }

    // Camera follow & dynamics
    r.cameraSubsystem?.update?.(context);

    // Refresh name tag positions & distance scaling against final frame camera pose
    const numCars = r.interpolator?.getCurrHeaderView?.()?.numCars ?? r.physics?.numCars ?? 0;
    r.arena?.nameTagSystem?.update(r.arena, numCars, r.camera?.camera);

    if (r.profiler) r.profiler.mark();
  }
}
