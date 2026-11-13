import type { ArenaRaycastDiag, ArenaSurfaceHit } from './arenaSurfaceRaycaster.ts';

export interface TelestratorPointerDiagEntry {
  ts: number;
  phase: 'down' | 'move' | 'up' | 'cancel' | 'hover';
  reason: string;
  x: number;
  y: number;
  pointerType: string;
  pointerId: number;
  button: number;
  hitPoint: [number, number, number] | null;
  hitNormal: [number, number, number] | null;
  hitDistance: number | null;
  raycast: ArenaRaycastDiag | null;
}

export interface TelestratorPointerDiagDump {
  latest: TelestratorPointerDiagEntry | null;
  recentEvents: TelestratorPointerDiagEntry[];
  totalDownCount: number;
  blockedDownCount: number;
  noHitDownCount: number;
  cancelCount: number;
  maxRaycastMs: number;
}

const MAX_DIAG_HISTORY = 40;

export class TelestratorPointerDiagRecorder {
  private readonly history: TelestratorPointerDiagEntry[] = [];
  private latest: TelestratorPointerDiagEntry | null = null;
  private totalDownCount = 0;
  private blockedDownCount = 0;
  private noHitDownCount = 0;
  private cancelCount = 0;
  private maxRaycastMs = 0;

  public record(
    phase: TelestratorPointerDiagEntry['phase'],
    reason: string,
    e: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType' | 'pointerId' | 'button'>,
    hit: ArenaSurfaceHit | null = null,
    raycast: ArenaRaycastDiag | null = null
  ): TelestratorPointerDiagEntry {
    if (phase === 'down') {
      this.totalDownCount++;
      if (reason === 'blocked-button-or-ui') this.blockedDownCount++;
      if (reason === 'no-hit') this.noHitDownCount++;
    } else if (phase === 'cancel') {
      this.cancelCount++;
    }
    if (raycast && raycast.totalMs > this.maxRaycastMs) {
      this.maxRaycastMs = raycast.totalMs;
    }

    const entry: TelestratorPointerDiagEntry = {
      ts: Date.now(),
      phase,
      reason,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      pointerType: e.pointerType || 'unknown',
      pointerId: e.pointerId,
      button: e.button,
      hitPoint: hit
        ? [Math.round(hit.point.x), Math.round(hit.point.y), Math.round(hit.point.z)]
        : null,
      hitNormal: hit
        ? [
            Number(hit.normal.x.toFixed(3)),
            Number(hit.normal.y.toFixed(3)),
            Number(hit.normal.z.toFixed(3)),
          ]
        : null,
      hitDistance: hit ? Math.round(hit.distance) : null,
      raycast,
    };

    this.latest = entry;
    if (phase !== 'hover') {
      this.history.push(entry);
      if (this.history.length > MAX_DIAG_HISTORY) {
        this.history.shift();
      }
    }
    return entry;
  }

  public getDump(): TelestratorPointerDiagDump {
    return {
      latest: this.latest,
      recentEvents: [...this.history],
      totalDownCount: this.totalDownCount,
      blockedDownCount: this.blockedDownCount,
      noHitDownCount: this.noHitDownCount,
      cancelCount: this.cancelCount,
      maxRaycastMs: Number(this.maxRaycastMs.toFixed(2)),
    };
  }
}
