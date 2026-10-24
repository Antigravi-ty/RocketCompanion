import { audioConfig } from '../config/audioConfig.js';
import {
  listenerManager,
  toAudioCoordinates,
  calculateIncidentDistanceGain,
  getUuToMeters
} from './SpatialAudioSource.js';

export class AudioSlotPool {
  constructor(context, maxSlots = 10, destination = null) {
    this.context = context;
    this.maxSlots = maxSlots;
    this.destination = destination;
    this.slots = [];
    this._initialized = false;
    this._scratchPos = { x: 0, y: 0, z: 0 };
    this.isMuted = false;
  }

  init(destination = null) {
    if (this._initialized || !this.context) return;
    const ctx = this.context;
    if (destination) this.destination = destination;
    const dest = this.destination || ctx.destination;
    listenerManager.setContext(ctx);

    for (let i = 0; i < this.maxSlots; i++) {
      const gainNode = ctx.createGain();

      // 3D Omnidirectional Panner Node (follows unified spatialPanningModel)
      const panner3D = ctx.createPanner();
      panner3D.panningModel = audioConfig.get('spatialPanningModel') || 'equalpower';
      panner3D.distanceModel = 'inverse';
      panner3D.rolloffFactor = 0; // Distance gain handled explicitly via smoothstep
      panner3D.coneInnerAngle = 360;
      panner3D.coneOuterAngle = 360;
      panner3D.channelCount = 1;
      panner3D.channelCountMode = 'explicit';
      panner3D.channelInterpretation = 'speakers';
      if (dest) panner3D.connect(dest);

      // 2D Stereo fallback Panner Node (for non-spatial broadcast signals & UI clicks)
      let panner2D = null;
      if (typeof ctx.createStereoPanner === 'function') {
        panner2D = ctx.createStereoPanner();
        if (dest) panner2D.connect(dest);
      } else if (i === 0) {
        console.warn('[AudioSlotPool] AudioContext.createStereoPanner is unavailable; 2D stereo signals will connect directly to destination without stereo panning.');
      }

      this.slots.push({
        id: i,
        gainNode,
        panner3D,
        panner2D,
        currentMode: null, // 'spatial' | 'stereo'
        inUse: false,
        sourceNode: null,
        startTime: 0,
        priority: 0,
        onEnded: null
      });
    }
    this._initialized = true;
  }

  acquireSlot(priority = 1) {
    if (!this._initialized) this.init();

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.inUse) {
        slot.inUse = true;
        slot.priority = priority;
        slot.startTime = performance.now();
        return slot;
      }
    }

    // Steal oldest slot with <= priority
    let candidate = null;
    let oldestTime = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.priority <= priority && slot.startTime < oldestTime) {
        oldestTime = slot.startTime;
        candidate = slot;
      }
    }

    if (candidate) {
      this.releaseSlot(candidate);
      candidate.inUse = true;
      candidate.priority = priority;
      candidate.startTime = performance.now();
      return candidate;
    }

    return null;
  }

  releaseSlot(slot) {
    if (!slot) return;
    if (slot.sourceNode) {
      try {
        slot.sourceNode.onended = null;
        slot.sourceNode.stop();
        slot.sourceNode.disconnect();
      } catch (e) {
        console.warn('[AudioArchitecture] Error stopping SoundPool source node:', e);
      }
      slot.sourceNode = null;
    }
    slot.inUse = false;
    slot.priority = 0;
    slot.startTime = 0;
    if (slot.onEnded) {
      try { slot.onEnded(); } catch (e) {
        console.error('[AudioArchitecture] SoundPool onEnded callback error:', e);
      }
      slot.onEnded = null;
    }
  }

  updatePanningModel(model) {
    if (!model) return;
    for (const slot of this.slots) {
      if (slot && slot.panner3D) {
        try { slot.panner3D.panningModel = model; } catch (err) { console.warn("[AudioSlotPool] Failed to set panningModel:", err?.message || err); }
      }
    }
  }

  playBuffer(buffer, options = {}) {
    if (!buffer || this.isMuted) return null;
    const ctx = this.context;
    if (!ctx || ctx.state === "closed") return null;
    if (ctx.state === "suspended") {
      ctx.resume().catch((err) => console.warn('[AudioArchitecture] AudioContext resume failed/blocked:', err));
    }

    const baseVolume = options.volume ?? 1.0;
    const playbackRate = options.playbackRate ?? 1.0;
    const priority = options.priority ?? 1;

    const slot = this.acquireSlot(priority);
    if (!slot) return null;

    const now = ctx.currentTime;
    try {
      slot.gainNode.gain.cancelScheduledValues(now);

      const audioPos = options.position ? toAudioCoordinates(this._scratchPos, options.position) : null;

      if (audioPos) {
        // Spatial 3D HRTF playback from emission coordinates (x, y, z)
        if (slot.currentMode !== 'spatial') {
          try { slot.gainNode.disconnect(); } catch (e) {
            console.warn('[AudioArchitecture] Error disconnecting slot gainNode:', e);
          }
          slot.gainNode.connect(slot.panner3D);
          slot.currentMode = 'spatial';
        }

        const px = audioPos.x * getUuToMeters();
        const py = audioPos.y * getUuToMeters();
        const pz = audioPos.z * getUuToMeters();
        if (slot.panner3D.positionX) {
          slot.panner3D.positionX.setValueAtTime(px, now);
          slot.panner3D.positionY.setValueAtTime(py, now);
          slot.panner3D.positionZ.setValueAtTime(pz, now);
        } else if (typeof slot.panner3D.setPosition === 'function') {
          slot.panner3D.setPosition(px, py, pz);
        }

        // Calculate distance from emitter point to camera listener
        const dx = audioPos.x - listenerManager.position.x;
        const dy = audioPos.y - listenerManager.position.y;
        const dz = audioPos.z - listenerManager.position.z;
        const distance = Math.hypot(dx, dy, dz);
        const distGain = calculateIncidentDistanceGain(distance);
        const effectiveGain = Math.max(0, Math.min(5.0, baseVolume * distGain));
        slot.gainNode.gain.setValueAtTime(effectiveGain, now);
      } else {
        // Non-spatial 2D stereo playback (signals, UI clicks)
        if (slot.currentMode !== 'stereo') {
          try { slot.gainNode.disconnect(); } catch (e) {
            console.warn('[AudioArchitecture] Error disconnecting slot gainNode:', e);
          }
          if (slot.panner2D) {
            slot.gainNode.connect(slot.panner2D);
          } else {
            const dest = this.destination || ctx.destination;
            if (dest) slot.gainNode.connect(dest);
          }
          slot.currentMode = 'stereo';
        }

        if (slot.panner2D && slot.panner2D.pan) {
          const pan = options.pan ?? 0.0;
          slot.panner2D.pan.cancelScheduledValues(now);
          slot.panner2D.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), now);
        }

        slot.gainNode.gain.setValueAtTime(Math.max(0, Math.min(5.0, baseVolume)), now);
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.setValueAtTime(playbackRate, now);
      src.connect(slot.gainNode);

      slot.sourceNode = src;
      slot.onEnded = options.onEnded ?? null;

      src.onended = () => {
        if (slot.sourceNode === src) {
          this.releaseSlot(slot);
        }
      };

      src.start(now);
      return slot;
    } catch (e) {
      console.warn('[AudioArchitecture] Error starting SoundPool source:', e);
      this.releaseSlot(slot);
      return null;
    }
  }

  silenceAll() {
    for (let i = 0; i < this.slots.length; i++) {
      this.releaseSlot(this.slots[i]);
    }
  }
}
