import { audioConfig, registerAudioDiagnosticsProvider } from '../ui-core/config/audioConfig.ts';
import { getAudioSlotPool, registerAudioEngine } from './audioContext.ts';
import { VehicleAudioManager, type VehicleAudioUpdateContext } from './VehicleAudioManager.ts';
import { IncidentAudioEngine } from './IncidentAudioEngine.ts';
import { SignalAudioEngine } from './SignalAudioEngine.ts';
import { loadAudioAssets, applyBoostVariationBuffers } from './audioAssetLoader.ts';
import {
  stadiumSpatialAudioEngine,
  type StadiumSpatialAudioEngine,
} from './StadiumSpatialAudioEngine.ts';
import {
  BallAudioEmitter,
  type BallMeshOrViewLike,
  type BallPhysicsStateLike,
} from './BallAudioEmitter.ts';
import {
  AudioMenuPreviewPlayer,
  type PreviewAudioBufferOptions,
} from './AudioMenuPreviewPlayer.ts';
import type { CameraTransformLike } from './SpatialAudioSource.ts';
import type { PhysicsImpactAudioEvent } from './WorldImpactAudioHandler.ts';
import './audioDebug.ts';

export type { PreviewAudioBufferOptions };

export class GameAudioEngineFacade {
  _lastBoostVariationKey: string;
  ballEngine: BallAudioEmitter;
  incidentEngine: IncidentAudioEngine;
  loaded: boolean;
  loading: boolean;
  readonly previewPlayer: AudioMenuPreviewPlayer;
  signalEngine: SignalAudioEngine;
  stadiumSpatialEngine: StadiumSpatialAudioEngine;
  vehicleManager: VehicleAudioManager;

  constructor() {
    this.ballEngine = new BallAudioEmitter();
    this.vehicleManager = new VehicleAudioManager();
    this.incidentEngine = new IncidentAudioEngine(this.vehicleManager);
    this.signalEngine = new SignalAudioEngine();
    this.stadiumSpatialEngine = stadiumSpatialAudioEngine;
    this.stadiumSpatialEngine.init();
    this.previewPlayer = new AudioMenuPreviewPlayer(this);

    this.loading = false;
    this.loaded = false;
    this._lastBoostVariationKey = `${audioConfig.get('boostStartVariation')}|${audioConfig.get('boostLoopVariation')}|${audioConfig.get('boostEndVariation')}`;

    registerAudioEngine(this);
    registerAudioDiagnosticsProvider({
      previewBoostVariation: (variationId, phase) => this.previewBoostVariation(variationId, phase),
      previewAudioDetail: (detailKey) => this.previewAudioDetail(detailKey),
      stopAudioDetailPreview: () => this.stopAudioDetailPreview(),
    });

    audioConfig.subscribe(() => {
      const spatialEnabled = audioConfig.get('spatialAudio') !== false;
      const panModel: PanningModelType = spatialEnabled
        ? audioConfig.get('spatialPanningModel') || 'equalpower'
        : 'equalpower';
      this.vehicleManager?.updatePanningModel?.(panModel);
      this.ballEngine?.updatePanningModel?.(panModel);
      getAudioSlotPool()?.updatePanningModel?.(panModel);

      const nextBoostKey = `${audioConfig.get('boostStartVariation')}|${audioConfig.get('boostLoopVariation')}|${audioConfig.get('boostEndVariation')}`;
      if (nextBoostKey !== this._lastBoostVariationKey) {
        this._lastBoostVariationKey = nextBoostKey;
        const s = audioConfig.get('boostStartVariation');
        const l = audioConfig.get('boostLoopVariation');
        const e = audioConfig.get('boostEndVariation');
        if (this.vehicleManager) {
          const selfIdx = this.vehicleManager.activeCarIndex ?? 0;
          if (s && s === l && l === e) {
            this.vehicleManager.carBoostVariations.set(selfIdx, String(s));
          } else {
            this.vehicleManager.carBoostVariations.delete(selfIdx);
          }
        }
      }

      if (this.loaded) {
        applyBoostVariationBuffers(this);
      }
    });
  }

  stopAudioDetailPreview(): void {
    this.previewPlayer.stopAudioDetailPreview();
  }

  previewAudioDetail(detailKey: string): void {
    this.previewPlayer.previewAudioDetail(detailKey);
  }

  previewBoostVariation(variationId = 'rush', phase = 'start'): void {
    this.previewPlayer.previewBoostVariation(variationId, phase);
  }

  async preload(
    onProgress: ((completed: number, total: number, url: string) => void) | null = null
  ) {
    if (this.loaded || this.loading || typeof window === 'undefined') return;
    this.loading = true;
    try {
      this.stadiumSpatialEngine?.prewarm?.();
      await loadAudioAssets(this, onProgress);
      this.loaded = true;
    } finally {
      this.loading = false;
    }
  }

  handleEvent(
    event: PhysicsImpactAudioEvent | null | undefined,
    camera: CameraTransformLike | null = null
  ) {
    this.incidentEngine.handleEvent(event, camera);
  }

  updateBallAudio(
    ballViewOrMesh: BallMeshOrViewLike | null | undefined,
    camera: CameraTransformLike | null | undefined,
    physics: BallPhysicsStateLike | null | undefined
  ) {
    this.ballEngine.update(ballViewOrMesh, camera, physics);
  }

  updateVehicles(context: VehicleAudioUpdateContext) {
    this.vehicleManager.update(context);
  }

  setCarBoostAudioVariation(carIndex: number, variationId: string | null = null) {
    this.vehicleManager?.setCarBoostAudioVariation?.(carIndex, variationId);
  }

  updateSupersonic(isSupersonic: boolean, isMatchActive: boolean = true) {
    const emitter = this.vehicleManager.getEmitter(this.vehicleManager.activeCarIndex);
    if (emitter) {
      if (typeof emitter.updateSupersonic === 'function') {
        emitter.updateSupersonic(isSupersonic, isMatchActive);
      } else {
        emitter.updateState({ isSupersonic, isAlive: true, audible: isMatchActive });
      }
    }
  }

  updateBoost(isBoosting: boolean, isMatchActive: boolean = true) {
    const emitter = this.vehicleManager.getEmitter(this.vehicleManager.activeCarIndex);
    if (emitter) {
      if (typeof emitter.updateBoost === 'function') {
        emitter.updateBoost(isBoosting, isMatchActive);
      } else {
        emitter.updateState({ isBoosting, isAlive: true, audible: isMatchActive });
      }
    }
  }

  handleSignal(signalType: string) {
    this.signalEngine.handleSignal(signalType);
  }

  play(key: string, volMult: number = 1.0, minInterval: number = 0) {
    this.signalEngine.play(key, volMult, minInterval);
  }

  playDirect(key: string, volMult: number = 1.0, minInterval: number = 0) {
    this.signalEngine.play(key, volMult, minInterval);
  }

  playClick(volume: number = 1.0): void {
    this.signalEngine.playClick(volume);
  }

  silenceAll() {
    this.ballEngine.silenceAll();
    this.vehicleManager.silenceAll();
    const pool = getAudioSlotPool();
    if (pool) pool.silenceAll();
  }

  onFocusRegained() {
    this.silenceAll();
  }

  stopContinuousAudio() {
    this.silenceAll();
  }

  resetIncidentDebounceState() {
    if (this.incidentEngine) {
      this.incidentEngine.lastCarBallHitTimestamp = 0;
      this.incidentEngine.lastCarCollisionTimestamp = 0;
      this.incidentEngine.lastGoalScoredTimestamp = 0;
      this.incidentEngine.lastBoostPickupByPad?.clear?.();
      this.incidentEngine.lastCarCollisionByPair?.clear?.();
      this.incidentEngine.lastCarDemoByVictim?.clear?.();
      if (this.incidentEngine.worldImpactHandler) {
        this.incidentEngine.worldImpactHandler.lastGoalpostHitTimestamp = 0;
        this.incidentEngine.worldImpactHandler.lastBallWorldHitTimestamp = 0;
      }
    }
    if (this.vehicleManager) {
      this.vehicleManager._lastFlipResetMsByCar?.clear?.();
      this.vehicleManager._lastBoostEdgeMsByCar?.clear?.();
      this.vehicleManager._lastJumpActionMsByCar?.clear?.();
      this.vehicleManager._lastSupersonicEnterMsByCar?.clear?.();
      this.vehicleManager._lastWheelLandingMsByCar?.clear?.();
      this.vehicleManager._landingStateByCar?.clear?.();
    }
  }
}

export const gameAudio = new GameAudioEngineFacade();
