/**
 * TelemetryStage.ts
 * Updates speedometer HUD needles, flip availability indicator (with countdown & unlimited state),
 * Layer 5A 6-slot player HUD roster strips, and finalizes frame profiling metrics.
 */
import {
  hudStore,
  useAppStore,
  useExperimentalMultiBotsStore,
  useReplayToRcsImporterStore,
  useReplayViewerStore,
  globalHudTransientChannel,
} from '../../runtimeUiPort.ts';
import { resolveModeRosterEntries } from './hudRosterResolverPipeline.ts';
import {
  buildHudTransientFramePayload,
  type CarHudTelemetry,
} from './hudTransientFramePipeline.ts';
import { buildRuntimeDiagnosticReport } from './runtimeDiagnosticReportBuilder.ts';
import type { FrameContext, PipelineStage } from '../FramePipeline.ts';

export class TelemetryStage implements PipelineStage {
  public runtime: any;
  private readonly _demolishedAtMsByCar: Record<number, number> = {};

  constructor(runtime: any) {
    this.runtime = runtime;
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).exportRuntimeDiagnosticReport = () =>
        buildRuntimeDiagnosticReport(this.runtime);
    }
  }

  private _resolveCarHudTelemetry(
    carIndex: number,
    rlrcCurrentFrame?: {
      cars?: ReadonlyArray<{
        slotIndex: number;
        boostAmount?: number;
        entityActive?: boolean;
      }>;
    } | null
  ): CarHudTelemetry {
    const r = this.runtime;
    const cv =
      r?.interpolator?.getCurrCarStateView?.(carIndex) || r?.physics?.getCarStateView?.(carIndex);
    const rlrcCar = rlrcCurrentFrame
      ? carIndex < (rlrcCurrentFrame.cars?.length ?? 0) &&
        rlrcCurrentFrame.cars?.[carIndex]?.slotIndex === carIndex
        ? rlrcCurrentFrame.cars[carIndex]
        : rlrcCurrentFrame.cars?.find?.((c) => c.slotIndex === carIndex)
      : null;
    const rawBoost =
      rlrcCar && typeof rlrcCar.boostAmount === 'number'
        ? rlrcCar.boostAmount
        : cv
          ? cv.boost || 0
          : 33;
    const boostAmount = Math.max(0, Math.min(100, Math.round(rawBoost)));
    const isDemolished =
      Boolean(cv && (cv.isDemoed || cv.demoRespawnTimer > 0)) ||
      Boolean(rlrcCar && !rlrcCar.entityActive);
    const demoRespawnRemainingSec = isDemolished
      ? Math.max(0, Number((cv?.demoRespawnTimer || 0).toFixed(2)))
      : 0;

    if (isDemolished) {
      if (!this._demolishedAtMsByCar[carIndex]) {
        this._demolishedAtMsByCar[carIndex] =
          typeof performance !== 'undefined' ? performance.now() : Date.now();
      }
    } else if (this._demolishedAtMsByCar[carIndex]) {
      this._demolishedAtMsByCar[carIndex] = 0;
    }

    return {
      boostAmount,
      isDemolished,
      demoRespawnRemainingSec,
      demolishedAtMs: this._demolishedAtMsByCar[carIndex] || 0,
    };
  }

  private _syncEdgeRosterHud(context: FrameContext, hudState: any): void {
    const r = this.runtime;
    const appState = useAppStore?.getState?.();
    const matchMode = r?.match?.state?.mode || appState?.matchMode || 'freeplay';
    const freeplayMode = r?.modeManager?.modes?.get?.('freeplay') || null;
    const replayViewer = freeplayMode?.standaloneReplayViewer || null;
    const rlrcSession = freeplayMode?.rlrcReplaySession || null;
    const isStandaloneLoaded =
      (matchMode === 'freeplay' || matchMode === 'replay-viewer') &&
      Boolean(replayViewer?.hasLoadedReplay);
    const isRlrcLoaded =
      (matchMode === 'freeplay' || matchMode === 'replay-viewer') &&
      Boolean(rlrcSession?.hasLoadedReplay);
    const useRlrcSession = isRlrcLoaded && Boolean(rlrcSession?.isActive || !isStandaloneLoaded);
    const isReplayViewerLoaded = isStandaloneLoaded || isRlrcLoaded;

    if (
      !isReplayViewerLoaded &&
      matchMode !== 'exp-multi-bots' &&
      matchMode !== 'match' &&
      matchMode !== 'online-warmup' &&
      matchMode !== 'dev-test-lab'
    ) {
      return;
    }

    const isReplayPov =
      (r?.match?.state?.phase === 'replay' || hudState?.matchPhase === 'replay') &&
      !r?.isGoalReplayCameraOverrideActive?.() &&
      typeof r?.replayPovCarIndex === 'number' &&
      r.replayPovCarIndex >= 0;

    const viewerRoster = replayViewer?.rosterSubController;
    const rlrcStoreState = useRlrcSession ? useReplayToRcsImporterStore.getState() : null;
    const rlrcRosterMeta = useRlrcSession ? (rlrcSession?.session?.roster ?? []) : [];
    const rlrcActivePovIdx = useRlrcSession
      ? typeof rlrcSession?.activePovSlotIndex === 'number'
        ? rlrcSession.activePovSlotIndex
        : (rlrcStoreState?.activePovCarIndex ?? 0)
      : 0;
    const rlrcActivePovTeam = useRlrcSession
      ? (rlrcRosterMeta.find((m: { slotIndex: number }) => m.slotIndex === rlrcActivePovIdx)
          ?.team ??
        rlrcStoreState?.activePovTeam ??
        0)
      : 0;
    const rlrcResolvedRoster = useRlrcSession
      ? rlrcRosterMeta.map((m: { slotIndex: number; userName: string; team: number }) => ({
          carIndex: m.slotIndex,
          name: m.userName || `Player ${m.slotIndex + 1}`,
          team: m.team === 1 ? 1 : 0,
          isSelf: m.slotIndex === rlrcActivePovIdx,
        }))
      : undefined;
    const rlrcCurrentFrame =
      useRlrcSession && !rlrcSession?.isIntervening
        ? (rlrcSession?.session?.frames120Hz?.[rlrcSession?.cursorFrame120Hz ?? 0] ?? null)
        : null;

    const activeCameraCar: number = isReplayViewerLoaded
      ? useRlrcSession
        ? rlrcActivePovIdx
        : typeof viewerRoster?.activePovCarIndex === 'number'
          ? viewerRoster.activePovCarIndex
          : (r?.playerCarIndex ?? 0)
      : isReplayPov
        ? r.replayPovCarIndex
        : typeof context?.activeCar === 'number'
          ? context.activeCar
          : typeof r?.playerCarIndex === 'number'
            ? r.playerCarIndex
            : 0;

    const expStore =
      matchMode === 'exp-multi-bots' ? useExperimentalMultiBotsStore.getState() : null;
    const activeMode = r?.modeManager?.getActiveMode?.();
    const modeSpawnedCars = activeMode?.rosterController?.spawnedCars;
    const expSpawnedCars =
      Array.isArray(modeSpawnedCars) && modeSpawnedCars.length > 0
        ? modeSpawnedCars
        : Array.isArray(expStore?.spawnedCars)
          ? expStore.spawnedCars
          : [];

    const localCarIdx: number =
      typeof r?.networkReconciler?.localCarIndex === 'number' &&
      r.networkReconciler.localCarIndex >= 0
        ? r.networkReconciler.localCarIndex
        : typeof r?.reconciler?.localCarIndex === 'number' && r.reconciler.localCarIndex >= 0
          ? r.reconciler.localCarIndex
          : (r?.playerCarIndex ?? 0);

    const { blueEntries, orangeEntries, isSpectatingNoHuman, detectedLocalTeam } =
      resolveModeRosterEntries({
        matchMode,
        isReplayViewerLoaded,
        replayViewerState: isReplayViewerLoaded
          ? useRlrcSession
            ? rlrcStoreState?.viewerState
            : useReplayViewerStore.getState().viewerState
          : undefined,
        replayViewerActivePovTeam: useRlrcSession ? rlrcActivePovTeam : viewerRoster?.activePovTeam,
        replayViewerLocalTeam: useRlrcSession ? rlrcActivePovTeam : viewerRoster?.localTeam,
        replayViewerActivePovCarIndex: useRlrcSession
          ? rlrcActivePovIdx
          : viewerRoster?.activePovCarIndex,
        replayViewerResolvedRoster: useRlrcSession
          ? rlrcResolvedRoster
          : viewerRoster?.resolvedRoster,
        expPlayerParticipation: expStore?.playerParticipation,
        expSpawnedCars,
        rawRosterSnapshot:
          r?.networkManager?.rosterSyncCoordinator?.lastRosterSnapshot ||
          r?.authoritativeServer?.lastRoomState?.roster,
        replayTimelineCarEntries: r?.replayTimelineController?.carEntries,
        connectedPeers: appState?.onlineSession?.connectedPeers,
        localPeerId: r?.multiplayerSession?.localPeerId || appState?.onlineSession?.localPeerId,
        localCarIdx,
        participantTeams:
          r?.networkManager?.rosterSyncCoordinator?.participantTeams instanceof Map
            ? r.networkManager.rosterSyncCoordinator.participantTeams
            : null,
        arenaCarTeams: r?.arena?.carTeams,
        localPlayerName: r?.multiplayerSession?.playerName || appState?.onlineSession?.playerName,
        carNamesByIndex: r?.networkReconciler?.carNames,
        activeBotName: r?.activeBotName,
        numCars: r?.physics?.numCars,
      });

    const ackJumpByCar = new Map<number, boolean>();
    if (Array.isArray(r?.networkReconciler?.lastParsedPacket?.acknowledgedControls)) {
      for (const item of r.networkReconciler.lastParsedPacket.acknowledgedControls) {
        if (item && typeof item.carIndex === 'number') {
          ackJumpByCar.set(item.carIndex, Boolean(item.controls?.jump));
        }
      }
    }

    const ballView = r?.interpolator?.getCurrBallStateView?.() || r?.physics?.getBallStateView?.();
    const payload = buildHudTransientFramePayload(
      {
        ballPosX: ballView?.posX ?? 0,
        ballPosY: ballView?.posY ?? 0,
        ballPosZ: ballView?.posZ ?? 0,
        ballVelX: ballView?.velX ?? 0,
        ballVelY: ballView?.velY ?? 0,
        ballVelZ: ballView?.velZ ?? 0,
        resolveCarTelemetry: (carIdx) => this._resolveCarHudTelemetry(carIdx, rlrcCurrentFrame),
      },
      {
        activeCameraCar,
        replayCameraMode: hudState?.replayCameraMode,
        perspectiveCamera: r?.camera?.camera ?? null,
      },
      {
        blueEntries,
        orangeEntries,
        detectedLocalTeam,
        isSpectatingNoHuman,
        choreographySignal: hudState?.choreographySignal,
        matchPhase: hudState?.matchPhase,
        localSkipReplayReady: Boolean(
          r?._localSkipReplayReady || r?.networkReconciler?.localSkipReplayReady
        ),
        acknowledgedJumpByCar: ackJumpByCar,
      }
    );

    if (hudState && hudState.localTeam !== payload.localTeam) {
      hudState.setMatchState?.({ localTeam: payload.localTeam });
    }
    if (r) {
      r._lastHudSlotCarMap = payload.slotKeyToCarIndex;
    }

    globalHudTransientChannel.setRoster(payload.rosterPatch);
    globalHudTransientChannel.setMiniMap?.(payload.miniMap);
  }

  public execute(context: FrameContext): void {
    const r = this.runtime;
    const { playerCarView } = context;
    const hudState = hudStore?.getState?.();

    if (playerCarView) {
      const hasFlipNow =
        !playerCarView.isDemoed && Boolean(playerCarView.isOnGround || playerCarView.hasFlipOrJump);
      const flipStatus = playerCarView.flipStatus;
      const flipRemainingSeconds = playerCarView.flipRemainingSeconds;
      const flipsRemaining = playerCarView.flipsRemaining;

      const carSpeed =
        typeof context.overrideCarSpeed === 'number'
          ? context.overrideCarSpeed
          : playerCarView.isDemoed
            ? 0
            : Math.hypot(playerCarView.velX, playerCarView.velY, playerCarView.velZ);
      hudState?.setHasFlip?.(hasFlipNow, flipStatus, flipRemainingSeconds, flipsRemaining);
      hudState?.setDemoRespawnState?.(
        playerCarView.isDemoed,
        playerCarView.demoRespawnTimer,
        playerCarView.demoSpawnSelection
      );
      hudState?.setCarSpeed?.(carSpeed);
    }

    this._syncEdgeRosterHud(context, hudStore?.getState?.() || hudState);

    if (r.profiler) {
      r.profiler.mark();
      const totalTicks = (r.pipeline?._accumSimTicks ?? 0) + (r.interpolator?.lastTicks ?? 0);
      const totalDropped = (r.pipeline?._accumSimDropped ?? 0) + (r.interpolator?.lastDropped ?? 0);
      const totalStalled = Boolean(r.pipeline?._accumSimStalled || r.interpolator?.lastStalled);
      const appState = useAppStore?.getState?.();
      const pauseTelemetryInPowerSave = appState?.telemetry?.pauseTelemetryInPowerSave !== false;
      const skipSample =
        Boolean(context.shouldSkipGpuRender) ||
        (pauseTelemetryInPowerSave && Boolean(r.isPowerSavingActive));
      r.profiler.frameEnd(totalTicks, totalDropped, totalStalled, skipSample);
    }
  }
}
