/**
 * ScenarioRuntimeProbeAndErrorGuard.ts
 * Zero-escape runtime error & console.error interceptor, configurable fast-forward
 * speed multiplier resolver (1x / 10x / 20x / 50x), and Three.js SceneGraph
 * vehicle rig geometry probe (wheel steer positions, suspension heights, boost outlets).
 */

import { getVehicleDescriptor } from '../../ui-core/config/vehicleTunerConfig';
import { roundMetric } from './scenarioMetricsPipeline.ts';
import type {
  ScenarioCapturedError,
  ScenarioFastForwardSpeedPreset,
  ScenarioSpeedMultiplierConfig,
  VehicleRigGeometryProbe,
} from './ScenarioTypes.ts';

declare global {
  interface Window {
    __rcScenarioSpeed?: string;
  }
}

const BENIGN_CONSOLE_ERROR_SUBSTRINGS: readonly string[] = Object.freeze([
  'favicon.ico',
  'ResizeObserver loop',
]);

function isBenignErrorString(message: string): boolean {
  for (let i = 0; i < BENIGN_CONSOLE_ERROR_SUBSTRINGS.length; i++) {
    if (message.includes(BENIGN_CONSOLE_ERROR_SUBSTRINGS[i])) return true;
  }
  return false;
}

function formatConsoleErrorArgs(args: unknown[]): { message: string; stack?: string } {
  let stack: string | undefined;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg instanceof Error) {
      parts.push(arg.message || String(arg));
      if (!stack && arg.stack) stack = arg.stack;
    } else if (typeof arg === 'string') {
      parts.push(arg);
    } else {
      try {
        parts.push(JSON.stringify(arg));
      } catch {
        parts.push(String(arg));
      }
    }
  }
  return { message: parts.join(' '), stack };
}

export class ScenarioRuntimeErrorInterceptor {
  private readonly captured: ScenarioCapturedError[] = [];
  private readonly getTick: () => number;
  private origConsoleError: ((...args: unknown[]) => void) | null = null;
  private onWindowError: ((event: ErrorEvent) => void) | null = null;
  private onUnhandledRejection: ((event: PromiseRejectionEvent) => void) | null = null;
  private installed = false;

  constructor(getTick: () => number) {
    this.getTick = getTick;
  }

  public install(): void {
    if (this.installed) return;
    this.installed = true;
    this.captured.length = 0;

    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      const orig = console.error.bind(console);
      this.origConsoleError = orig;
      console.error = (...args: unknown[]) => {
        const formatted = formatConsoleErrorArgs(args);
        if (
          !isBenignErrorString(formatted.message) &&
          !formatted.message.includes('[ScenarioBaseline] Fatal error in autorun suite')
        ) {
          this.captured.push({
            tick: this.getTick(),
            source: 'console_error',
            message: formatted.message.slice(0, 500),
            stack: formatted.stack ? formatted.stack.slice(0, 600) : undefined,
          });
        }
        orig(...args);
      };
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.onWindowError = (event: ErrorEvent) => {
        const msg = event?.message || String(event?.error || 'Uncaught window error');
        if (isBenignErrorString(msg)) return;
        const errObj = event?.error instanceof Error ? event.error : null;
        this.captured.push({
          tick: this.getTick(),
          source: 'window_error',
          message: msg.slice(0, 500),
          stack: errObj?.stack
            ? errObj.stack.slice(0, 600)
            : event?.filename
              ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
              : undefined,
        });
      };

      this.onUnhandledRejection = (event: PromiseRejectionEvent) => {
        const reason = event?.reason;
        const msg =
          reason instanceof Error
            ? reason.message
            : typeof reason === 'string'
              ? reason
              : String(reason || 'Unhandled promise rejection');
        if (isBenignErrorString(msg)) return;
        this.captured.push({
          tick: this.getTick(),
          source: 'unhandled_rejection',
          message: msg.slice(0, 500),
          stack: reason instanceof Error && reason.stack ? reason.stack.slice(0, 600) : undefined,
        });
      };

      window.addEventListener('error', this.onWindowError);
      window.addEventListener('unhandledrejection', this.onUnhandledRejection);
    }
  }

  public uninstall(): ScenarioCapturedError[] {
    if (!this.installed) return [...this.captured];
    this.installed = false;

    if (this.origConsoleError && typeof console !== 'undefined') {
      console.error = this.origConsoleError;
      this.origConsoleError = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      if (this.onWindowError) {
        window.removeEventListener('error', this.onWindowError);
        this.onWindowError = null;
      }
      if (this.onUnhandledRejection) {
        window.removeEventListener('unhandledrejection', this.onUnhandledRejection);
        this.onUnhandledRejection = null;
      }
    }
    return [...this.captured];
  }

  public getCapturedErrors(): ScenarioCapturedError[] {
    return [...this.captured];
  }
}

export function getRequestedScenarioSpeedPreset(): ScenarioFastForwardSpeedPreset {
  let raw = '';
  if (typeof window !== 'undefined') {
    if (window.__rcScenarioSpeed) {
      raw = String(window.__rcScenarioSpeed).trim().toLowerCase();
    } else if (window.location?.search) {
      try {
        const params = new URLSearchParams(window.location.search);
        raw = (params.get('scenarioSpeed') || params.get('speed') || '').trim().toLowerCase();
      } catch {
        raw = '';
      }
    }
  }
  if (raw === '1x' || raw === '1') return '1x';
  if (raw === '10x' || raw === '10') return '10x';
  if (raw === '50x' || raw === '50') return '50x';
  return '20x';
}

export function resolveScenarioSpeedConfig(
  baseRenderStride: number,
  baseBatchYieldTicks: number,
  explicitPreset?: ScenarioFastForwardSpeedPreset | null,
): ScenarioSpeedMultiplierConfig {
  const preset = explicitPreset || getRequestedScenarioSpeedPreset();
  const safeBaseStride = Math.max(1, baseRenderStride || 15);
  const safeBaseYield = Math.max(10, baseBatchYieldTicks || 60);

  if (preset === '1x') {
    return {
      speedPreset: '1x',
      renderStride: 1,
      batchYieldTicks: 12,
    };
  }
  if (preset === '10x') {
    return {
      speedPreset: '10x',
      renderStride: Math.max(10, Math.min(safeBaseStride, 15)),
      batchYieldTicks: Math.max(40, safeBaseYield),
    };
  }
  if (preset === '50x') {
    return {
      speedPreset: '50x',
      renderStride: Math.max(45, safeBaseStride * 3),
      batchYieldTicks: Math.max(240, safeBaseYield * 4),
    };
  }
  return {
    speedPreset: '20x',
    renderStride: safeBaseStride,
    batchYieldTicks: safeBaseYield,
  };
}

export function captureVehicleRigGeometryProbe(
  arena: unknown,
  carIndex = 0,
): VehicleRigGeometryProbe | null {
  if (!arena || typeof arena !== 'object') return null;
  const a = arena as {
    vehiclePresets?: Array<string | null>;
    carVisual?: string;
    carWheels?: Array<Array<{ steer?: { position?: { x: number; y: number; z: number } } }> | null>;
    carBoosts?: Array<Array<unknown> | null>;
    vehicleRegistry?: {
      vehiclePresets?: Array<string | null>;
      carWheelSpecs?: Array<Array<[number, number, number, number, number?]> | null>;
    };
  };

  const visualId =
    a.vehiclePresets?.[carIndex] ||
    a.vehicleRegistry?.vehiclePresets?.[carIndex] ||
    (carIndex === 0 ? a.carVisual : null) ||
    'octane';

  const descriptor = getVehicleDescriptor(visualId);
  const wheels = a.carWheels?.[carIndex] || [];
  const wheelSteerPositions: Array<[number, number, number]> = [];
  let allFinite = true;

  for (let i = 0; i < wheels.length; i++) {
    const pos = wheels[i]?.steer?.position;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number') {
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
        allFinite = false;
      }
      wheelSteerPositions.push([
        roundMetric(pos.x, 3),
        roundMetric(pos.y, 3),
        roundMetric(pos.z, 3),
      ]);
    }
  }

  const frontAxleX = wheelSteerPositions[0]?.[0] ?? 0;
  const rearAxleX = wheelSteerPositions[2]?.[0] ?? wheelSteerPositions[1]?.[0] ?? 0;
  const frontSuspensionHeightY = wheelSteerPositions[0]?.[1] ?? 0;
  const rearSuspensionHeightY = wheelSteerPositions[2]?.[1] ?? wheelSteerPositions[1]?.[1] ?? 0;
  const wheelTrackWidthZ =
    wheelSteerPositions.length >= 2
      ? roundMetric(Math.abs((wheelSteerPositions[0]?.[2] ?? 0) - (wheelSteerPositions[1]?.[2] ?? 0)), 3)
      : 0;

  const descriptorWheelAnchors: Array<[number, number, number]> = Array.isArray(descriptor?.wheelAnchors)
    ? descriptor.wheelAnchors.map((w) => [
        roundMetric(Number(w[0] ?? 0), 3),
        roundMetric(Number(w[1] ?? 0), 3),
        roundMetric(Number(w[2] ?? 0), 3),
      ])
    : [];

  const descriptorSuspensionHeights: [number, number, number, number] = Array.isArray(
    descriptor?.suspensionHeights,
  )
    ? [
        roundMetric(Number(descriptor.suspensionHeights[0] ?? 0), 3),
        roundMetric(Number(descriptor.suspensionHeights[1] ?? 0), 3),
        roundMetric(Number(descriptor.suspensionHeights[2] ?? 0), 3),
        roundMetric(Number(descriptor.suspensionHeights[3] ?? 0), 3),
      ]
    : [0, 0, 0, 0];

  const boostEmitters = a.carBoosts?.[carIndex] || [];

  return {
    carIndex,
    visualId: String(visualId),
    wheelCount: wheelSteerPositions.length,
    wheelSteerPositions,
    frontAxleX,
    rearAxleX,
    wheelTrackWidthZ,
    frontSuspensionHeightY,
    rearSuspensionHeightY,
    descriptorWheelAnchors,
    descriptorSuspensionHeights,
    boostEmitterCount: boostEmitters.length,
    isFiniteGeometry: allFinite && wheelSteerPositions.length === 4,
  };
}

export function captureAllActiveVehicleRigProbes(arena: unknown): VehicleRigGeometryProbe[] {
  const probes: VehicleRigGeometryProbe[] = [];
  const a = arena as { cars?: Array<{ visible?: boolean } | null> } | null | undefined;
  for (let c = 0; c < 6; c++) {
    if (c === 0 || a?.cars?.[c]?.visible) {
      const probe = captureVehicleRigGeometryProbe(arena, c);
      if (probe) probes.push(probe);
    }
  }
  return probes;
}
