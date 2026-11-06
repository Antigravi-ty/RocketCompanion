import {
  UU_TO_METERS,
  getUuToMeters,
  SPATIAL_CONFIG,
  SPATIAL_AUDIO_CONFIG,
  INCIDENT_SPATIAL_CONFIG,
  applySpatialConfigPatch,
  calculateIncidentDistanceGain,
  toAudioCoordinates,
  calculateDistanceGain,
  evaluateCategoryDistanceGain,
  isDistanceCulled,
  solveIsoGainRadiusUU,
  spatialAttenuationEvaluator,
  setArenaAcousticScale,
  getArenaAcousticScale,
  getSpatialAttenuationProfile,
  spatialAttenuationProfiles,
  type AudioAttenuationCategory,
  type SpatialAttenuationProfile,
  type SpatialConfigPatch,
  type SpatialVector3Like,
  type SpatialPositionInput
} from './spatialAudioMath.ts';
import { audioConfig } from '../ui-core/config/audioConfig';

export {
  UU_TO_METERS,
  getUuToMeters,
  SPATIAL_CONFIG,
  SPATIAL_AUDIO_CONFIG,
  INCIDENT_SPATIAL_CONFIG,
  calculateIncidentDistanceGain,
  toAudioCoordinates,
  calculateDistanceGain,
  evaluateCategoryDistanceGain,
  isDistanceCulled,
  solveIsoGainRadiusUU,
  spatialAttenuationEvaluator,
  setArenaAcousticScale,
  getArenaAcousticScale,
  getSpatialAttenuationProfile,
  spatialAttenuationProfiles,
  type AudioAttenuationCategory,
  type SpatialAttenuationProfile,
  type SpatialConfigPatch,
  type SpatialVector3Like,
  type SpatialPositionInput
};

export interface AudioPositionVector extends SpatialVector3Like {
  copy(p?: Partial<SpatialVector3Like> | null): AudioPositionVector;
  set(x: number, y: number, z: number): AudioPositionVector;
  setFromMatrixPosition(m?: { elements?: ArrayLike<number> } | null): AudioPositionVector;
}

export interface AudioQuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
  copy(q?: Partial<AudioQuaternionLike> | null): AudioQuaternionLike;
  set(x: number, y: number, z: number, w?: number): AudioQuaternionLike;
}

export interface CameraTransformLike {
  updateWorldMatrix?: (updateParents?: boolean, updateChildren?: boolean) => void;
  matrixWorld?: { elements?: ArrayLike<number> } | null;
  getWorldPosition?: (target: AudioPositionVector) => void;
  position?: Partial<SpatialVector3Like> | null;
  getWorldQuaternion?: (target: AudioQuaternionLike) => void;
  quaternion?: Partial<AudioQuaternionLike> | null;
}

export function updateSpatialConfig(patch: SpatialConfigPatch | null | undefined): void {
  applySpatialConfigPatch(patch, (panningModel) => {
    if (listenerManager) {
      listenerManager.updateSourcesPanningModel(panningModel);
    }
  });
}

// Internal listener state shared across all spatial audio instances
class AudioListenerManager {
  _lastFx: number | undefined;
  _lastFy: number | undefined;
  _lastFz: number | undefined;
  _lastLx: number | undefined;
  _lastLy: number | undefined;
  _lastLz: number | undefined;
  _lastUx: number | undefined;
  _lastUy: number | undefined;
  _lastUz: number | undefined;
  context: AudioContext | null;
  forward: SpatialVector3Like;
  hasListener: boolean;
  position: AudioPositionVector;
  quaternion: AudioQuaternionLike;
  sources: Set<SpatialAudioSource>;
  up: SpatialVector3Like;

  constructor() {
    this.position = {
      x: 0,
      y: 0,
      z: 0,
      copy(p) {
        if (p) {
          this.x = p.x ?? 0;
          this.y = p.y ?? 0;
          this.z = p.z ?? 0;
        }
        return this;
      },
      set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
      },
      setFromMatrixPosition(m) {
        if (m && m.elements) {
          this.x = m.elements[12];
          this.y = m.elements[13];
          this.z = m.elements[14];
        }
        return this;
      }
    };
    this.forward = { x: 0, y: 0, z: -1 };
    this.up = { x: 0, y: 1, z: 0 };
    this.quaternion = {
      x: 0,
      y: 0,
      z: 0,
      w: 1,
      copy(q) {
        if (q) {
          this.x = q.x ?? 0;
          this.y = q.y ?? 0;
          this.z = q.z ?? 0;
          this.w = q.w ?? 1;
        }
        return this;
      },
      set(x, y, z, w) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w ?? 1;
        return this;
      }
    };
    this.hasListener = false;
    this.sources = new Set();
    this.context = null;
  }

  setContext(ctx: AudioContext | null): void {
    if (ctx && ctx !== this.context) {
      this.context = ctx;
    }
  }

  register(source: SpatialAudioSource): void {
    this.sources.add(source);
  }

  unregister(source: SpatialAudioSource): void {
    this.sources.delete(source);
  }

  updateSourcesPanningModel(model: PanningModelType): void {
    for (const source of this.sources) {
      if (source && source.panner) {
        try {
          source.panner.panningModel = model;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn("[SpatialAudioSource] Failed to set panningModel:", errMsg);
        }
      }
    }
  }

  rotateVector(v: SpatialVector3Like, q: { x: number; y: number; z: number; w?: number }): SpatialVector3Like {
    const x = v.x, y = v.y, z = v.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w ?? 1;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return {
      x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
      y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
      z: iz * qw + iw * -qz + ix * -qy - iy * -qx
    };
  }

  /**
   * Updates global audio listener state from 3D camera.
   * @param {Object} camera - Three.js camera or equivalent transform object
   */
  updateFromCamera(camera: CameraTransformLike | null | undefined): void {
    if (!camera) return;

    try {
      if (typeof camera.updateWorldMatrix === 'function') {
        camera.updateWorldMatrix(true, false);
      }

      if (camera.matrixWorld && camera.matrixWorld.elements) {
        const te = camera.matrixWorld.elements;
        this.position.x = te[12];
        this.position.y = te[13];
        this.position.z = te[14];

        const fx = -te[8], fy = -te[9], fz = -te[10];
        const flen = Math.hypot(fx, fy, fz) || 1;
        this.forward.x = fx / flen;
        this.forward.y = fy / flen;
        this.forward.z = fz / flen;

        const ux = te[4], uy = te[5], uz = te[6];
        const ulen = Math.hypot(ux, uy, uz) || 1;
        this.up.x = ux / ulen;
        this.up.y = uy / ulen;
        this.up.z = uz / ulen;
      } else {
        if (typeof camera.getWorldPosition === 'function') {
          camera.getWorldPosition(this.position);
        } else if (camera.position) {
          this.position.x = camera.position.x ?? 0;
          this.position.y = camera.position.y ?? 0;
          this.position.z = camera.position.z ?? 0;
        }

        if (typeof camera.getWorldQuaternion === 'function') {
          camera.getWorldQuaternion(this.quaternion);
        } else if (camera.quaternion) {
          this.quaternion.x = camera.quaternion.x ?? 0;
          this.quaternion.y = camera.quaternion.y ?? 0;
          this.quaternion.z = camera.quaternion.z ?? 0;
          this.quaternion.w = camera.quaternion.w ?? 1;
        }

        this.forward = this.rotateVector({ x: 0, y: 0, z: -1 }, this.quaternion);
        this.up = this.rotateVector({ x: 0, y: 1, z: 0 }, this.quaternion);
      }

      this.hasListener = true;

      if (this.context && this.context.listener) {
        const listener = this.context.listener;
        const t = this.context.currentTime;
        const lx = this.position.x * getUuToMeters();
        const ly = this.position.y * getUuToMeters();
        const lz = this.position.z * getUuToMeters();
        const fx = this.forward.x;
        const fy = this.forward.y;
        const fz = this.forward.z;
        const ux = this.up.x;
        const uy = this.up.y;
        const uz = this.up.z;

        const changed =
          this._lastLx === undefined ||
          this._lastLy === undefined ||
          this._lastLz === undefined ||
          this._lastFx === undefined ||
          this._lastFy === undefined ||
          this._lastFz === undefined ||
          this._lastUx === undefined ||
          this._lastUy === undefined ||
          this._lastUz === undefined ||
          Math.abs(lx - this._lastLx) > 1e-4 ||
          Math.abs(ly - this._lastLy) > 1e-4 ||
          Math.abs(lz - this._lastLz) > 1e-4 ||
          Math.abs(fx - this._lastFx) > 1e-4 ||
          Math.abs(fy - this._lastFy) > 1e-4 ||
          Math.abs(fz - this._lastFz) > 1e-4 ||
          Math.abs(ux - this._lastUx) > 1e-4 ||
          Math.abs(uy - this._lastUy) > 1e-4 ||
          Math.abs(uz - this._lastUz) > 1e-4;

        if (changed) {
          this._lastLx = lx;
          this._lastLy = ly;
          this._lastLz = lz;
          this._lastFx = fx;
          this._lastFy = fy;
          this._lastFz = fz;
          this._lastUx = ux;
          this._lastUy = uy;
          this._lastUz = uz;

          if (listener.positionX) {
            listener.positionX.setValueAtTime(lx, t);
            listener.positionY.setValueAtTime(ly, t);
            listener.positionZ.setValueAtTime(lz, t);
            listener.forwardX.setValueAtTime(fx, t);
            listener.forwardY.setValueAtTime(fy, t);
            listener.forwardZ.setValueAtTime(fz, t);
            listener.upX.setValueAtTime(ux, t);
            listener.upY.setValueAtTime(uy, t);
            listener.upZ.setValueAtTime(uz, t);
          } else if (typeof listener.setPosition === 'function') {
            listener.setPosition(lx, ly, lz);
            listener.setOrientation(fx, fy, fz, ux, uy, uz);
          }
        }
      }

      for (const source of this.sources) {
        source.updateListener();
      }
    } catch (err) {
      console.warn('[AudioListenerManager] Failed to update listener from camera:', err);
    }
  }
}

export const listenerManager = new AudioListenerManager();

export function updateAudioListener(camera: CameraTransformLike | null | undefined): void {
  try {
    listenerManager.updateFromCamera(camera);
  } catch (err) {
    console.warn('[SpatialAudioSource] updateAudioListener failed:', err);
  }
}

/**
 * 3D Spatial Audio Source for individual sound emitters (e.g. car engines, boost nozzles).
 */
export class SpatialAudioSource {
  _lastPx: number | undefined;
  _lastPy: number | undefined;
  _lastPz: number | undefined;
  category: AudioAttenuationCategory;
  context: AudioContext | null;
  enabled: boolean;
  input: GainNode;
  output: GainNode | null;
  panner: PannerNode | null;
  position: AudioPositionVector;
  targetGain: number;

  constructor(
    context: AudioContext | null,
    destinationNode?: AudioNode | null,
    category: AudioAttenuationCategory = 'engine_other'
  ) {
    this.context = context;
    this.category = category;
    this.enabled = true;
    this.targetGain = -1;
    this.input = null!;
    this.output = null;
    this.panner = null;
    this.position = {
      x: 0,
      y: 0,
      z: 0,
      copy(p) {
        if (p) {
          this.x = p.x ?? 0;
          this.y = p.y ?? 0;
          this.z = p.z ?? 0;
        }
        return this;
      },
      set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
      },
      setFromMatrixPosition(m) {
        if (m && m.elements) {
          this.x = m.elements[12];
          this.y = m.elements[13];
          this.z = m.elements[14];
        }
        return this;
      }
    };

    if (!context) {
      return;
    }

    try {
      this.input = context.createGain();
      this.input.channelCount = 1;
      this.input.channelCountMode = 'explicit';
      this.input.channelInterpretation = 'speakers';

      this.panner = context.createPanner();
      this.panner.panningModel = SPATIAL_CONFIG.panningModel;
      this.panner.channelCount = 1;
      this.panner.channelCountMode = 'explicit';
      this.panner.rolloffFactor = 0;
      this.panner.coneInnerAngle = 360;
      this.panner.coneOuterAngle = 360;

      this.output = context.createGain();
      this.output.gain.value = 0;

      this.input.connect(this.panner);
      this.panner.connect(this.output);
      if (destinationNode) {
        this.output.connect(destinationNode);
      }
    } catch (err) {
      console.warn('[SpatialAudioSource] Failed to create audio nodes:', err);
    }

    listenerManager.register(this);
    this.updateListener();
  }

  setPosition(pos: SpatialPositionInput | null | undefined): void {
    if (!pos) return;
    if (Number.isFinite(pos.posX) && Number.isFinite(pos.posY) && Number.isFinite(pos.posZ)) {
      this.position.set(pos.posX as number, pos.posZ as number, pos.posY as number);
    } else if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
      this.position.copy({ x: pos.x, y: pos.y, z: pos.z });
    }
    if (!this.context || !this.panner) return;
    try {
      const t = this.context.currentTime;
      const px = this.position.x * getUuToMeters();
      const py = this.position.y * getUuToMeters();
      const pz = this.position.z * getUuToMeters();
      if (
        this._lastPx === undefined ||
        this._lastPy === undefined ||
        this._lastPz === undefined ||
        Math.abs(px - this._lastPx) > 1e-4 ||
        Math.abs(py - this._lastPy) > 1e-4 ||
        Math.abs(pz - this._lastPz) > 1e-4
      ) {
        this._lastPx = px;
        this._lastPy = py;
        this._lastPz = pz;
        if (this.panner.positionX) {
          this.panner.positionX.setValueAtTime(px, t);
          this.panner.positionY.setValueAtTime(py, t);
          this.panner.positionZ.setValueAtTime(pz, t);
        } else if (typeof this.panner.setPosition === 'function') {
          this.panner.setPosition(px, py, pz);
        }
      }
    } catch (err) {
      console.warn('[SpatialAudioSource] Error setting panner position:', err);
    }
    this.applyGain();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    this.applyGain();
  }

  updateListener(): void {
    if (!this.context) return;
    this.applyGain();
  }

  applyGain(): void {
    if (!this.context || !this.output) return;
    let target = 0;
    if (this.enabled && listenerManager.hasListener) {
      const dx = this.position.x - listenerManager.position.x;
      const dy = this.position.y - listenerManager.position.y;
      const dz = this.position.z - listenerManager.position.z;
      const distance = Math.hypot(dx, dy, dz);
      target = calculateDistanceGain(distance, this.category);
    }

    if (target === this.targetGain) return;
    this.targetGain = target;

    try {
      const t = this.context.currentTime;
      const currentGain = this.output.gain.value;
      this.output.gain.cancelScheduledValues(t);

      if (target === 0 || this.context.state !== 'running') {
        this.output.gain.setValueAtTime(target, t);
      } else {
        this.output.gain.setValueAtTime(currentGain, t);
        this.output.gain.linearRampToValueAtTime(target, t + SPATIAL_AUDIO_CONFIG.RAMP_TIME);
      }
    } catch (err) {
      console.warn('[SpatialAudioSource] Error ramping output gain:', err);
    }
  }

  dispose(): void {
    this.setEnabled(false);
    listenerManager.unregister(this);
    try {
      this.input?.disconnect();
      this.panner?.disconnect();
      this.output?.disconnect();
    } catch (e) {
      console.warn('[SpatialAudioSource] Error disconnecting audio nodes on dispose:', e);
    }
  }
}

updateSpatialConfig(audioConfig.config);
audioConfig.subscribe((cfg) => {
  if (cfg) {
    updateSpatialConfig(cfg);
  }
});
