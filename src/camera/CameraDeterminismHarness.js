/**
 * CameraDeterminismHarness.js
 * Side-by-Side POV Camera Determinism & Equivalence Verification Harness.
 *
 * Runs both the legacy WASM POV Camera Microkernel (camera.wasm) and the
 * clean-room pure JavaScript CleanPovCameraKernel on identical 32-Float64 input frames:
 * - Supports live toggle between Legacy WASM and Clean JS camera outputs for active rendering.
 * - Continuously records up to 600 pre-trigger frames in a zero-allocation ring buffer.
 * - Automatically triggers post-divergence capture (up to 600 additional frames, ~5s at 120Hz)
 *   when output deltas exceed the configured tolerance threshold.
 * - Exports captured pre + post frames to CSV (with 8 significant digits via toPrecision(8))
 *   for offline inspection and regression analysis.
 */

import { CleanPovCameraKernel } from './CleanPovCameraKernel.js';
import {
  PRE_TRIGGER_FRAME_LIMIT,
  POST_TRIGGER_FRAME_LIMIT,
  MAX_CAPTURED_FRAMES,
  CAMERA_CAPTURE_STATES,
  CAMERA_SOURCE_MODES,
} from '../ui-core/config/cameraDefaults.js';

export {
  PRE_TRIGGER_FRAME_LIMIT,
  POST_TRIGGER_FRAME_LIMIT,
  MAX_CAPTURED_FRAMES,
  CAMERA_CAPTURE_STATES,
  CAMERA_SOURCE_MODES,
};

const CSV_COLUMNS = [
  'frame_index',
  'capture_phase',
  'timestamp_ms',
  'did_reset',
  'in_dt',
  'in_ball_cam',
  'in_car_pos_x',
  'in_car_pos_y',
  'in_car_pos_z',
  'in_car_quat_x',
  'in_car_quat_y',
  'in_car_quat_z',
  'in_car_quat_w',
  'in_ball_pos_x',
  'in_ball_pos_y',
  'in_ball_pos_z',
  'in_flags',
  'in_on_ground',
  'in_ground_normal_x',
  'in_ground_normal_y',
  'in_ground_normal_z',
  'in_vel_x',
  'in_vel_y',
  'in_vel_z',
  'in_supersonic',
  'in_fov',
  'in_distance',
  'in_height',
  'in_angle_deg',
  'in_stiffness',
  'in_transition_speed',
  'in_aspect',
  'in_look_x',
  'in_look_y',
  'in_swivel_speed',
  'in_invert_swivel',
  'wasm_pos_x',
  'wasm_pos_y',
  'wasm_pos_z',
  'wasm_dir_x',
  'wasm_dir_y',
  'wasm_dir_z',
  'wasm_up_x',
  'wasm_up_y',
  'wasm_up_z',
  'wasm_fov',
  'clean_pos_x',
  'clean_pos_y',
  'clean_pos_z',
  'clean_dir_x',
  'clean_dir_y',
  'clean_dir_z',
  'clean_up_x',
  'clean_up_y',
  'clean_up_z',
  'clean_fov',
  'delta_pos',
  'delta_dir',
  'delta_up',
  'delta_fov',
  'max_rel_error'
];

function createEmptyFrameRecord() {
  return {
    frameIndex: 0,
    capturePhase: 'pre_trigger',
    timestampMs: 0,
    didReset: 0,
    input: new Float64Array(32),
    wasmOutput: new Float64Array(10),
    cleanOutput: new Float64Array(10),
    deltaPos: 0,
    deltaDir: 0,
    deltaUp: 0,
    deltaFov: 0,
    maxRelError: 0
  };
}

function copyFrameRecord(dst, src) {
  dst.frameIndex = src.frameIndex;
  dst.capturePhase = src.capturePhase;
  dst.timestampMs = src.timestampMs;
  dst.didReset = src.didReset;
  dst.input.set(src.input);
  dst.wasmOutput.set(src.wasmOutput);
  dst.cleanOutput.set(src.cleanOutput);
  dst.deltaPos = src.deltaPos;
  dst.deltaDir = src.deltaDir;
  dst.deltaUp = src.deltaUp;
  dst.deltaFov = src.deltaFov;
  dst.maxRelError = src.maxRelError;
}

function formatPrecision8(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '0';
  if (val === 0) return '0';
  return Number(val.toPrecision(8)).toString();
}

export class CameraDeterminismHarness {
  constructor() {
    this.cleanKernel = new CleanPovCameraKernel();
    this.activeSource = CAMERA_SOURCE_MODES.CLEAN_JS;
    this.autoCaptureEnabled = true;

    // 8 significant digits tolerance threshold: relative error 1e-5 or position error 0.01 UU
    this.posTolerance = 0.01;
    this.dirTolerance = 1e-4;
    this.upTolerance = 1e-4;
    this.fovTolerance = 1e-3;

    this.preRingBuffer = Array.from({ length: PRE_TRIGGER_FRAME_LIMIT }, () => createEmptyFrameRecord());
    this.preWriteCursor = 0;
    this.preBufferedCount = 0;

    this.capturedFramesBuffer = Array.from({ length: MAX_CAPTURED_FRAMES }, () => createEmptyFrameRecord());
    this.capturedFrameCount = 0;
    this.postRemainingFrames = 0;
    this.captureState = CAMERA_CAPTURE_STATES.MONITORING;
    this.pendingResetFlag = 0;
    this._lastNotifyTimeMs = 0;

    this.metrics = {
      frameIndex: 0,
      activeSource: this.activeSource,
      captureState: this.captureState,
      preBufferCount: 0,
      postBufferCount: 0,
      totalCapturedCount: 0,
      triggerFrameIndex: -1,
      deltaPos: 0,
      deltaDir: 0,
      deltaUp: 0,
      deltaFov: 0,
      maxRelError: 0,
      peakDeltaPos: 0,
      peakDeltaDir: 0,
      peakDeltaUp: 0,
      peakDeltaFov: 0,
      peakRelError: 0,
      divergenceCount: 0,
      isMatching: true
    };

    this._listeners = new Set();
  }

  get capturedFrames() {
    return this.capturedFramesBuffer.slice(0, this.capturedFrameCount);
  }

  subscribe(listener) {
    if (typeof listener === 'function') {
      this._listeners.add(listener);
      return () => this._listeners.delete(listener);
    }
    return () => {};
  }

  _notify() {
    for (const listener of this._listeners) {
      try {
        listener(this.metrics);
      } catch (err) {
        console.error('[CameraDeterminismHarness] Listener error:', err);
      }
    }
  }

  setActiveSource(source) {
    if (source === CAMERA_SOURCE_MODES.WASM || source === CAMERA_SOURCE_MODES.CLEAN_JS) {
      this.activeSource = source;
      this.metrics.activeSource = source;
      this._notify();
    }
  }

  toggleActiveSource() {
    const next =
      this.activeSource === CAMERA_SOURCE_MODES.CLEAN_JS
        ? CAMERA_SOURCE_MODES.WASM
        : CAMERA_SOURCE_MODES.CLEAN_JS;
    this.setActiveSource(next);
    return next;
  }

  setPosTolerance(tolerance) {
    const parsed = Number(tolerance);
    if (Number.isFinite(parsed) && parsed >= 0) {
      this.posTolerance = parsed;
      this._notify();
    }
  }

  onResetView() {
    this.cleanKernel.resetView();
    this.pendingResetFlag = 1;
  }

  resetCaptureAndPeaks() {
    this.preWriteCursor = 0;
    this.preBufferedCount = 0;
    this.capturedFrameCount = 0;
    this.postRemainingFrames = 0;
    this.captureState = CAMERA_CAPTURE_STATES.MONITORING;

    this.metrics.captureState = CAMERA_CAPTURE_STATES.MONITORING;
    this.metrics.preBufferCount = 0;
    this.metrics.postBufferCount = 0;
    this.metrics.totalCapturedCount = 0;
    this.metrics.triggerFrameIndex = -1;
    this.metrics.peakDeltaPos = 0;
    this.metrics.peakDeltaDir = 0;
    this.metrics.peakDeltaUp = 0;
    this.metrics.peakDeltaFov = 0;
    this.metrics.peakRelError = 0;
    this.metrics.divergenceCount = 0;
    this.metrics.isMatching = true;

    this._notify();
  }

  triggerManualCapture() {
    if (this.captureState !== CAMERA_CAPTURE_STATES.MONITORING) return;
    this._lockPreBufferAndStartPostCapture(this.metrics.frameIndex);
    this._notify();
  }

  _lockPreBufferAndStartPostCapture(triggerFrameIdx) {
    const count = this.preBufferedCount;
    const startIdx = (this.preWriteCursor - count + PRE_TRIGGER_FRAME_LIMIT) % PRE_TRIGGER_FRAME_LIMIT;

    for (let i = 0; i < count; i++) {
      const slot = (startIdx + i) % PRE_TRIGGER_FRAME_LIMIT;
      const targetRecord = this.capturedFramesBuffer[i];
      copyFrameRecord(targetRecord, this.preRingBuffer[slot]);
      targetRecord.capturePhase = i === count - 1 ? 'trigger_frame' : 'pre_trigger';
    }

    this.capturedFrameCount = count;
    this.captureState = CAMERA_CAPTURE_STATES.CAPTURING_POST;
    this.postRemainingFrames = POST_TRIGGER_FRAME_LIMIT;
    this.metrics.captureState = this.captureState;
    this.metrics.triggerFrameIndex = triggerFrameIdx;
    this.metrics.postBufferCount = 0;
    this.metrics.totalCapturedCount = this.capturedFrameCount;
  }

  /**
   * Executes both WASM and Clean JS camera kernels on the 32-Float64 input array,
   * compares their 10-Float64 outputs, records into the 600-frame ring buffer / post-trigger buffer,
   * and returns the selected active camera's 42-Float64 view buffer.
   *
   * @param {object} wasmKernel - CameraMicrokernel instance
   * @param {Float64Array} inputArray - 32-Float64 input buffer
   * @param {string|null} [preferredSource] - Optional override ('clean_js' | 'wasm')
   * @returns {Float64Array} 42-Float64 buffer with output at indices [32..41]
   */
  stepAndCompare(wasmKernel, inputArray, preferredSource = null) {
    const wasmView = wasmKernel.stepView(inputArray);
    const cleanView = this.cleanKernel.stepView(inputArray);

    const frameIdx = this.metrics.frameIndex + 1;
    this.metrics.frameIndex = frameIdx;

    const dxPos = wasmView[32] - cleanView[32];
    const dyPos = wasmView[33] - cleanView[33];
    const dzPos = wasmView[34] - cleanView[34];
    const deltaPos = Math.hypot(dxPos, dyPos, dzPos);

    const dxDir = wasmView[35] - cleanView[35];
    const dyDir = wasmView[36] - cleanView[36];
    const dzDir = wasmView[37] - cleanView[37];
    const deltaDir = Math.hypot(dxDir, dyDir, dzDir);

    const dxUp = wasmView[38] - cleanView[38];
    const dyUp = wasmView[39] - cleanView[39];
    const dzUp = wasmView[40] - cleanView[40];
    const deltaUp = Math.hypot(dxUp, dyUp, dzUp);

    const deltaFov = Math.abs(wasmView[41] - cleanView[41]);

    let maxRelError = 0;
    for (let k = 32; k < 42; k++) {
      const wVal = wasmView[k];
      const cVal = cleanView[k];
      const absDiff = Math.abs(wVal - cVal);
      const denom = Math.max(1.0, Math.abs(wVal), Math.abs(cVal));
      const rel = absDiff / denom;
      if (rel > maxRelError) maxRelError = rel;
    }

    const isDivergent =
      deltaPos > this.posTolerance ||
      deltaDir > this.dirTolerance ||
      deltaUp > this.upTolerance ||
      deltaFov > this.fovTolerance;

    this.metrics.deltaPos = deltaPos;
    this.metrics.deltaDir = deltaDir;
    this.metrics.deltaUp = deltaUp;
    this.metrics.deltaFov = deltaFov;
    this.metrics.maxRelError = maxRelError;

    if (deltaPos > this.metrics.peakDeltaPos) this.metrics.peakDeltaPos = deltaPos;
    if (deltaDir > this.metrics.peakDeltaDir) this.metrics.peakDeltaDir = deltaDir;
    if (deltaUp > this.metrics.peakDeltaUp) this.metrics.peakDeltaUp = deltaUp;
    if (deltaFov > this.metrics.peakDeltaFov) this.metrics.peakDeltaFov = deltaFov;
    if (maxRelError > this.metrics.peakRelError) this.metrics.peakRelError = maxRelError;

    let stateChanged = false;
    if (isDivergent) {
      this.metrics.divergenceCount += 1;
      if (this.metrics.isMatching) {
        this.metrics.isMatching = false;
        stateChanged = true;
      }
    }

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const didReset = this.pendingResetFlag;
    this.pendingResetFlag = 0;

    if (this.captureState === CAMERA_CAPTURE_STATES.MONITORING) {
      const slotRecord = this.preRingBuffer[this.preWriteCursor];
      slotRecord.frameIndex = frameIdx;
      slotRecord.capturePhase = 'pre_trigger';
      slotRecord.timestampMs = nowMs;
      slotRecord.didReset = didReset;
      slotRecord.input.set(inputArray);
      for (let i = 0; i < 10; i++) {
        slotRecord.wasmOutput[i] = wasmView[32 + i];
        slotRecord.cleanOutput[i] = cleanView[32 + i];
      }
      slotRecord.deltaPos = deltaPos;
      slotRecord.deltaDir = deltaDir;
      slotRecord.deltaUp = deltaUp;
      slotRecord.deltaFov = deltaFov;
      slotRecord.maxRelError = maxRelError;

      this.preWriteCursor = (this.preWriteCursor + 1) % PRE_TRIGGER_FRAME_LIMIT;
      if (this.preBufferedCount < PRE_TRIGGER_FRAME_LIMIT) {
        this.preBufferedCount += 1;
      }
      this.metrics.preBufferCount = this.preBufferedCount;
      this.metrics.totalCapturedCount = this.preBufferedCount;

      if (isDivergent && this.autoCaptureEnabled) {
        this._lockPreBufferAndStartPostCapture(frameIdx);
        stateChanged = true;
      }
    } else if (this.captureState === CAMERA_CAPTURE_STATES.CAPTURING_POST) {
      if (this.capturedFrameCount < MAX_CAPTURED_FRAMES) {
        const postRecord = this.capturedFramesBuffer[this.capturedFrameCount];
        postRecord.frameIndex = frameIdx;
        postRecord.capturePhase = 'post_trigger';
        postRecord.timestampMs = nowMs;
        postRecord.didReset = didReset;
        postRecord.input.set(inputArray);
        for (let i = 0; i < 10; i++) {
          postRecord.wasmOutput[i] = wasmView[32 + i];
          postRecord.cleanOutput[i] = cleanView[32 + i];
        }
        postRecord.deltaPos = deltaPos;
        postRecord.deltaDir = deltaDir;
        postRecord.deltaUp = deltaUp;
        postRecord.deltaFov = deltaFov;
        postRecord.maxRelError = maxRelError;
        this.capturedFrameCount += 1;
      }

      this.postRemainingFrames -= 1;
      this.metrics.postBufferCount = POST_TRIGGER_FRAME_LIMIT - this.postRemainingFrames;
      this.metrics.totalCapturedCount = this.capturedFrameCount;

      if (this.postRemainingFrames <= 0) {
        this.captureState = CAMERA_CAPTURE_STATES.CAPTURED_READY;
        this.metrics.captureState = this.captureState;
        stateChanged = true;
      }
    }

    const effectiveSource = preferredSource || this.activeSource;
    if (stateChanged || nowMs - this._lastNotifyTimeMs >= 60) {
      this._lastNotifyTimeMs = nowMs;
      this._notify();
    }

    return effectiveSource === CAMERA_SOURCE_MODES.CLEAN_JS ? cleanView : wasmView;
  }

  /**
   * Builds CSV content string from either the locked capture buffer (if triggered)
   * or the current 600-frame rolling buffer (if still monitoring).
   * All floating-point numbers are formatted with toPrecision(8).
   *
   * @returns {string}
   */
  buildCsvString() {
    let records = [];
    if (
      this.captureState === CAMERA_CAPTURE_STATES.CAPTURING_POST ||
      this.captureState === CAMERA_CAPTURE_STATES.CAPTURED_READY
    ) {
      records = this.capturedFramesBuffer.slice(0, this.capturedFrameCount);
    } else {
      const count = this.preBufferedCount;
      const startIdx = (this.preWriteCursor - count + PRE_TRIGGER_FRAME_LIMIT) % PRE_TRIGGER_FRAME_LIMIT;
      for (let i = 0; i < count; i++) {
        records.push(this.preRingBuffer[(startIdx + i) % PRE_TRIGGER_FRAME_LIMIT]);
      }
    }

    const lines = [CSV_COLUMNS.join(',')];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const row = [
        String(r.frameIndex),
        r.capturePhase,
        formatPrecision8(r.timestampMs),
        String(r.didReset)
      ];
      for (let k = 0; k < 32; k++) {
        row.push(formatPrecision8(r.input[k]));
      }
      for (let k = 0; k < 10; k++) {
        row.push(formatPrecision8(r.wasmOutput[k]));
      }
      for (let k = 0; k < 10; k++) {
        row.push(formatPrecision8(r.cleanOutput[k]));
      }
      row.push(
        formatPrecision8(r.deltaPos),
        formatPrecision8(r.deltaDir),
        formatPrecision8(r.deltaUp),
        formatPrecision8(r.deltaFov),
        formatPrecision8(r.maxRelError)
      );
      lines.push(row.join(','));
    }

    return lines.join('\n');
  }

  /**
   * Triggers a browser download of the recorded camera frames as a CSV file.
   */
  exportCsvFile() {
    const csvContent = this.buildCsvString();
    if (typeof document === 'undefined') return csvContent;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stateTag = this.metrics.isMatching ? 'matching' : 'diverged';
    link.href = url;
    link.setAttribute('download', `camera_deterministic_${stateTag}_${timestamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return csvContent;
  }
}

let singletonCameraHarness = null;

export function getCameraDeterminismHarness() {
  if (!singletonCameraHarness) {
    singletonCameraHarness = new CameraDeterminismHarness();
  }
  return singletonCameraHarness;
}

export default CameraDeterminismHarness;
