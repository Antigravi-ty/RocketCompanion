import type { SoundCueId } from '../../../audio/types.ts';
import {
  BALL_REST_Z,
  GRAVITY_Z,
  INCIDENT_EVENT_TYPES as EV,
  STANDARD_GOAL_VOLUME_BOX,
} from '../../../physics/RocketSimConstants.ts';
import { STANDARD_BOOST_PADS_34 as PADS } from '../catalog/RLRCBoostPadSpatialCatalog.ts';
import type { RLRCConvertedReplaySession } from '../RLReplayToRLRCConverter.ts';
import type {
  RLRCBookmarkRecord,
  RLRCCarFrameState120Hz,
  RLRCFrame120Hz as Frame,
  RLRCPlayerSlotMeta,
  RLRCVec3,
} from '../RLRCReplayTypes.ts';
import type { RLRCPlaybackRuntimePort } from './RLRCPlaybackSyncApplier.ts';

type T3 = [number, number, number];

export interface RLRCPlaybackAudioDispatchTarget {
  handleEvent?(t: number, a: number, b: number, v: number, pos?: T3): void;
  play?(id: SoundCueId | string, o?: { volume?: number; pitch?: number; isPov?: boolean; pos?: T3; dist?: number }): void;
}

export interface RLRCPlaybackAudioRuntimePort extends RLRCPlaybackRuntimePort {
  audio?: RLRCPlaybackAudioDispatchTarget | null;
}

export interface RLRCPlaybackAudioStepOptions {
  smoothStep?: boolean;
  activePovSlotIndex?: number;
  activePovSlot?: number;
  runtime?: RLRCPlaybackAudioRuntimePort | null;
  audio?: RLRCPlaybackAudioDispatchTarget | null;
  session?: RLRCConvertedReplaySession | null;
  bookmarks?: readonly RLRCBookmarkRecord[] | null;
  roster?: readonly RLRCPlayerSlotMeta[] | null;
}

export interface RLRCSynthesizedDiscreteAudioEvent {
  eventType: number;
  entityA: number;
  entityB: number;
  value: number;
  pos?: T3;
}

export interface RLRCSynthesizedDirectCueEvent {
  cueId: SoundCueId;
  volume?: number;
  pitch?: number;
  isPov?: boolean;
  pos?: T3;
}

export interface RLRCSynthesizedAudioFrameBatch {
  discreteEvents: RLRCSynthesizedDiscreteAudioEvent[];
  directCues: RLRCSynthesizedDirectCueEvent[];
}

type Batch = RLRCSynthesizedAudioFrameBatch;

const GRAV_DV = GRAVITY_Z / 120;
const GOAL_MAX_Z = STANDARD_GOAL_VOLUME_BOX.maxZ;
const ARENA_X = 4096;
const ARENA_Y = 5120;
const ARENA_Z = 2044;

const tup3 = (v: RLRCVec3): T3 => [v.x, v.y, v.z];
const dist3 = (a: RLRCVec3, b: RLRCVec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const speed3 = (v: RLRCVec3): number => Math.hypot(v.x, v.y, v.z);
const nearPost = (p: RLRCVec3): boolean => {
  const ax = Math.abs(p.x);
  return Math.abs(p.y) >= 4960 && ax <= 940 && p.z <= 700 && (ax >= 790 || p.z >= GOAL_MAX_Z - 95);
};
const pushEv = (b: Batch, eventType: number, entityA: number, entityB: number, value: number, pos?: T3): void => {
  b.discreteEvents.push({ eventType, entityA, entityB, value, pos });
};
const pushCue = (b: Batch, cueId: SoundCueId, volume = 0.85, isPov = true, pos?: T3): void => {
  b.directCues.push({ cueId, volume, isPov, pos });
};

export class RLRCPlaybackAudioEdgeSynthesizer {
  private prev: Frame | null = null;
  private anchor: Frame | null = null;
  private ring: Frame[] = [];
  private povSlot = 0;
  private runtimeRef: RLRCPlaybackAudioRuntimePort | null = null;
  private audioOverride: RLRCPlaybackAudioDispatchTarget | null = null;
  private bookmarks: readonly RLRCBookmarkRecord[] = [];
  private lastHitTick = -999;
  private lastGoalTick = -999;
  private lastOtTick = -999;
  private lastCdNum = 0;
  private readonly lastBump = new Int32Array(8).fill(-999);
  private readonly lastDemo = new Int32Array(8).fill(-999);
  private readonly firedBm = new Set<number>();

  public reset(): void {
    this.prev = this.anchor = null;
    this.ring.length = this.lastCdNum = 0;
    this.lastHitTick = this.lastGoalTick = this.lastOtTick = -999;
    this.lastBump.fill(-999);
    this.lastDemo.fill(-999);
    this.firedBm.clear();
  }

  public clear = (): void => this.reset();
  public silence = (): void => this.reset();

  public primeFrame(f: Frame | null): void {
    this.prev = this.anchor = f;
    this.ring.length = 0;
    if (f) {
      this.ring.push(f);
      this.lastCdNum = f.roundCountdownNumber;
    }
  }
  public setActivePovSlot = (s: number): void => {
    if (Number.isFinite(s) && s >= 0) this.povSlot = s | 0;
  };
  public setRuntime = (rt?: RLRCPlaybackAudioRuntimePort | null): void => {
    this.runtimeRef = rt ?? null;
  };
  public setAudioTarget = (a?: RLRCPlaybackAudioDispatchTarget | null): void => {
    this.audioOverride = a ?? null;
  };
  public setBookmarks = (bm?: readonly RLRCBookmarkRecord[] | null): void => {
    this.bookmarks = bm ?? [];
    this.firedBm.clear();
  };
  public configureRoster = (_r?: readonly RLRCPlayerSlotMeta[] | null): void => {};
  public configureSession = (s?: RLRCConvertedReplaySession | null, rt?: RLRCPlaybackAudioRuntimePort | null): void => {
    this.reset();
    if (rt !== undefined) this.runtimeRef = rt;
    this.bookmarks = s?.bookmarks ?? [];
  };

  public stepFrame(frame: Frame, o?: RLRCPlaybackAudioStepOptions | number, sm?: boolean): Batch {
    let smooth = typeof sm === 'boolean' ? sm : true;
    let aud: RLRCPlaybackAudioDispatchTarget | null = null;
    if (typeof o === 'number') {
      this.setActivePovSlot(o);
    } else if (o) {
      const pov = o.activePovSlotIndex ?? o.activePovSlot;
      if (typeof pov === 'number') this.setActivePovSlot(pov);
      if (typeof o.smoothStep === 'boolean') smooth = o.smoothStep;
      if (o.runtime !== undefined) this.runtimeRef = o.runtime;
      if (o.audio !== undefined) aud = o.audio;
      if (o.session?.bookmarks) this.bookmarks = o.session.bookmarks;
      if (o.bookmarks) this.bookmarks = o.bookmarks;
    }
    const prev = this.prev;
    const dt = prev ? frame.frameIndex120Hz - prev.frameIndex120Hz : 0;
    const batch: Batch = { discreteEvents: [], directCues: [] };
    if (!smooth || !prev || dt < 1 || dt > 6) {
      this.primeFrame(frame);
      return batch;
    }
    const anc = this.anchor ?? prev;
    this.emitCarAndPadEdges(prev, frame, batch);
    this.emitBallAndGoal(prev, anc, frame, batch);
    this.emitCollisionsAndDemos(prev, anc, frame, batch);
    this.emitMatchStateAndBookmarks(prev, frame, batch);
    this.prev = frame;
    this.ring.push(frame);
    if (this.ring.length > 5) this.ring.shift();
    this.anchor = this.ring[0] ?? frame;
    this.dispatchBatch(batch, aud);
    return batch;
  }

  public applyFrame120Hz(
    a: Frame | RLRCPlaybackAudioRuntimePort,
    b?: RLRCPlaybackAudioRuntimePort | Frame | RLRCPlaybackAudioStepOptions | number | null,
    c?: RLRCPlaybackAudioStepOptions | number,
    sm?: boolean,
  ): Batch {
    if ('frameIndex120Hz' in a) {
      if (typeof b === 'number') return this.stepFrame(a, b, typeof c === 'boolean' ? c : sm);
      if (b && ('smoothStep' in b || 'activePovSlotIndex' in b || 'audio' in b)) return this.stepFrame(a, b as RLRCPlaybackAudioStepOptions);
      if (b) this.runtimeRef = b as RLRCPlaybackAudioRuntimePort;
      return typeof c === 'number' ? this.stepFrame(a, c, sm) : this.stepFrame(a, c);
    }
    this.runtimeRef = a;
    return b && typeof b === 'object' && 'frameIndex120Hz' in b
      ? this.stepFrame(b, { runtime: a, activePovSlotIndex: typeof c === 'number' ? c : 0, smoothStep: sm ?? true })
      : { discreteEvents: [], directCues: [] };
  }

  public processFrame = this.stepFrame;
  public update = this.stepFrame;

  public synthesizeAndDispatch(p: Frame | null, c: Frame, o?: RLRCPlaybackAudioStepOptions): Batch {
    if (p && (!this.prev || this.prev.frameIndex120Hz !== p.frameIndex120Hz)) this.primeFrame(p);
    return this.stepFrame(c, o);
  }

  private dispatchBatch(b: Batch, ov?: RLRCPlaybackAudioDispatchTarget | null): void {
    const rt = this.runtimeRef?.audio;
    const tgt = ov ?? (rt?.handleEvent || rt?.play ? rt : this.audioOverride);
    if (!tgt) return;
    if (tgt.handleEvent) for (const e of b.discreteEvents) tgt.handleEvent(e.eventType, e.entityA, e.entityB, e.value, e.pos);
    if (tgt.play) for (const c of b.directCues) tgt.play(c.cueId, { volume: c.volume, pitch: c.pitch, isPov: c.isPov, pos: c.pos });
  }

  private emitCarAndPadEdges(prev: Frame, curr: Frame, batch: Batch): void {
    const nCars = Math.min(prev.cars.length, curr.cars.length);
    for (let s = 0; s < nCars; s++) {
      const pC = prev.cars[s]!;
      const cC = curr.cars[s]!;
      if (!pC.entityActive || !cC.entityActive) continue;
      const pF = pC.activeFlags;
      const cF = cC.activeFlags;
      const rb = cC.rigidBody;
      const pos = tup3(rb.position);
      const bf = cC.boostAmount > 1.001 ? cC.boostAmount * 0.01 : cC.boostAmount;
      if (!pF.jumpActive && cF.jumpActive) pushEv(batch, EV.CAR_JUMP, s, 0, 1, pos);
      if (!pF.dodgeActive && cF.dodgeActive) pushEv(batch, EV.CAR_DODGE, s, 0, 1, pos);
      else if (!pF.doubleJumpActive && cF.doubleJumpActive) pushEv(batch, EV.CAR_DOUBLE_JUMP, s, 0, 1, pos);
      if (!pF.boostActive && cF.boostActive) pushEv(batch, EV.CAR_BOOST_START, s, 0, bf, pos);
      else if (pF.boostActive && !cF.boostActive) pushEv(batch, EV.CAR_BOOST_STOP, s, 0, bf, pos);
      if (!pC.isSupersonic && cC.isSupersonic) pushEv(batch, EV.CAR_SUPERSONIC_ENTER, s, 0, speed3(rb.linearVelocity), pos);
    }
    const nPads = Math.min(prev.boostPadCooldowns.length, curr.boostPadCooldowns.length, PADS.length);
    for (let p = 0; p < nPads; p++) {
      if (prev.boostPadCooldowns[p]! <= 1e-3 && curr.boostPadCooldowns[p]! > 0.5) {
        const pad = PADS[p]!;
        const slot = this.nearestCar(curr.cars, pad.position, -1, this.povSlot);
        pushEv(batch, EV.BOOST_PICKUP, slot, p, pad.isBigPad ? 1.0 : 0.12, tup3(pad.position));
      }
    }
  }

  private emitBallAndGoal(prev: Frame, anchor: Frame, curr: Frame, batch: Batch): void {
    const pB = prev.ball;
    const cB = curr.ball;
    const tick = curr.frameIndex120Hz;
    const pPos = pB.rigidBody.position;
    const bPos = cB.rigidBody.position;
    const scored = curr.blueScore > prev.blueScore || curr.orangeScore > prev.orangeScore;
    if ((scored || (pB.entityActive && !cB.entityActive && Math.abs(pPos.y) >= ARENA_Y - 350)) && tick - this.lastGoalTick >= 60) {
      this.lastGoalTick = tick;
      const gPos = tup3(pB.entityActive ? pPos : bPos);
      pushEv(batch, EV.GOAL_SCORED, curr.orangeScore > prev.orangeScore ? 1 : 0, 0, 1, gPos);
      pushCue(batch, 'sfx_goal_poof', 0.92, true, gPos);
      return;
    }
    if (!pB.entityActive || !cB.entityActive || curr.roundCountdownNumber > 0 || tick - this.lastHitTick < 7) return;

    const dt1 = Math.max(1, tick - prev.frameIndex120Hz);
    const vC = cB.rigidBody.linearVelocity;
    const vP = pB.rigidBody.linearVelocity;
    const imp1 = Math.hypot(vC.x - vP.x, vC.y - vP.y, vC.z - vP.z - GRAV_DV * dt1);
    let impW = 0;
    if (anchor.ball.entityActive && tick > anchor.frameIndex120Hz) {
      const vA = anchor.ball.rigidBody.linearVelocity;
      const dtW = tick - anchor.frameIndex120Hz;
      impW = Math.hypot(vC.x - vA.x, vC.y - vA.y, vC.z - vA.z - GRAV_DV * dtW);
    }
    if (imp1 < 185 && !(impW >= 230 && imp1 >= 75)) return;

    const imp = Math.max(imp1, impW * 0.85);
    const hitPos = tup3(bPos);
    let bestSlot = -1;
    let bestD = Infinity;
    for (let s = 0; s < curr.cars.length; s++) {
      if (!curr.cars[s]!.entityActive) continue;
      const d = Math.min(dist3(curr.cars[s]!.rigidBody.position, bPos), dist3(prev.cars[s]!.rigidBody.position, pPos));
      if (d < bestD) {
        bestD = d;
        bestSlot = s;
      }
    }
    if (bestSlot >= 0 && bestD <= 265) {
      this.lastHitTick = tick;
      pushEv(batch, EV.CAR_BALL_HIT, bestSlot, 0, imp, hitPos);
    } else if (nearPost(bPos) && imp >= 220) {
      this.lastHitTick = tick;
      pushEv(batch, EV.BALL_GOALPOST_HIT, 0, 0, imp, hitPos);
    } else if (
      imp >= 195 &&
      (bPos.z <= BALL_REST_Z + 38 ||
        Math.abs(bPos.x) >= ARENA_X - BALL_REST_Z - 140 ||
        Math.abs(bPos.y) >= ARENA_Y - BALL_REST_Z - 140 ||
        bPos.z >= ARENA_Z - BALL_REST_Z - 90)
    ) {
      this.lastHitTick = tick;
      pushEv(batch, EV.BALL_WORLD_HIT, 0, 0, imp, hitPos);
    }
  }

  private emitCollisionsAndDemos(prev: Frame, anchor: Frame, curr: Frame, batch: Batch): void {
    const n = Math.min(prev.cars.length, curr.cars.length);
    const tick = curr.frameIndex120Hz;
    let deact = -1;
    let deactN = 0;
    for (let s = 0; s < n; s++) {
      if (prev.cars[s]!.entityActive && !curr.cars[s]!.entityActive) {
        deactN++;
        deact = s;
      }
    }
    if (deactN === 1 && deact >= 0 && curr.ball.entityActive && !curr.roundCountdownNumber && tick - this.lastDemo[deact]! >= 36) {
      const vPos = prev.cars[deact]!.rigidBody.position;
      this.lastDemo[deact] = tick;
      pushEv(batch, EV.CAR_CAR_DEMO, this.nearestCar(curr.cars, vPos, deact, deact), deact, 2200, tup3(vPos));
    }
    for (let i = 0; i < n; i++) {
      const cA = curr.cars[i]!;
      const pA = prev.cars[i]!;
      if (!cA.entityActive || !pA.entityActive || tick - this.lastBump[i]! < 18) continue;
      for (let j = i + 1; j < n; j++) {
        const cB = curr.cars[j]!;
        const pB = prev.cars[j]!;
        if (!cB.entityActive || !pB.entityActive || tick - this.lastBump[j]! < 18) continue;
        const posA = cA.rigidBody.position;
        const posB = cB.rigidBody.position;
        if (dist3(posA, posB) > 225) continue;
        const bA = (anchor.cars[i]?.entityActive ? anchor.cars[i]! : pA).rigidBody.linearVelocity;
        const bB = (anchor.cars[j]?.entityActive ? anchor.cars[j]! : pB).rigidBody.linearVelocity;
        const dv = Math.max(dist3(cA.rigidBody.linearVelocity, bA), dist3(cB.rigidBody.linearVelocity, bB));
        if (dv < 320) continue;
        this.lastBump[i] = this.lastBump[j] = tick;
        pushEv(batch, EV.CAR_CAR_BUMP, i, j, dv, [(posA.x + posB.x) * 0.5, (posA.y + posB.y) * 0.5, (posA.z + posB.z) * 0.5]);
      }
    }
  }

  private emitMatchStateAndBookmarks(prev: Frame, curr: Frame, batch: Batch): void {
    const tick = curr.frameIndex120Hz;
    const pCd = prev.roundCountdownNumber;
    const cCd = curr.roundCountdownNumber;
    if (cCd !== pCd && cCd !== this.lastCdNum) {
      this.lastCdNum = cCd;
      if (cCd >= 1 && cCd <= 3) pushCue(batch, 'match_countdown_321', 0.78, true);
      else if (pCd === 1 && cCd === 0) pushCue(batch, 'match_start_go', 0.85, true);
    }
    if (!prev.isOvertime && curr.isOvertime && tick - this.lastOtTick > 120) {
      this.lastOtTick = tick;
      pushCue(batch, 'match_entering_overtime', 0.88, true);
    }
    for (let i = 0; i < this.bookmarks.length; i++) {
      if (this.firedBm.has(i)) continue;
      const bm = this.bookmarks[i]!;
      const f = bm.frameIndex120Hz;
      const t = bm.timeSeconds;
      if (!(f > prev.frameIndex120Hz && f <= tick) && !(t > prev.timeSeconds && t <= curr.timeSeconds)) continue;
      this.firedBm.add(i);
      if (bm.kind === 'demolish') {
        const vic = Math.max(0, Math.min(7, bm.slotIndex | 0));
        if (tick - (this.lastDemo[vic] ?? -999) >= 36) {
          this.lastDemo[vic] = tick;
          const vPos = (curr.cars[vic] ?? prev.cars[vic])?.rigidBody.position ?? { x: 0, y: 0, z: 93 };
          pushEv(batch, EV.CAR_CAR_DEMO, this.nearestCar(curr.cars, vPos, vic, vic), vic, 2200, tup3(vPos));
        }
      } else if (bm.kind === 'goal' && tick - this.lastGoalTick >= 60) {
        this.lastGoalTick = tick;
        const gPos = tup3(prev.ball.rigidBody.position);
        pushEv(batch, EV.GOAL_SCORED, bm.team === 1 ? 1 : 0, 0, 1, gPos);
        pushCue(batch, 'sfx_goal_poof', 0.92, true, gPos);
      }
    }
  }

  private nearestCar(cars: readonly RLRCCarFrameState120Hz[], pos: RLRCVec3, excl: number, fb = -1): number {
    let best = fb;
    let bestD = Infinity;
    for (let s = 0; s < cars.length; s++) {
      if (s === excl || !cars[s]!.entityActive) continue;
      const d = dist3(cars[s]!.rigidBody.position, pos);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}

export const synthesizeRLRCPlaybackAudioEdges = (
  s: RLRCPlaybackAudioEdgeSynthesizer,
  f: Frame,
  o?: RLRCPlaybackAudioStepOptions | number,
  sm?: boolean,
): Batch => s.stepFrame(f, o, sm);
export const dispatchRLRCPlaybackAudioEdges = synthesizeRLRCPlaybackAudioEdges;
export default RLRCPlaybackAudioEdgeSynthesizer;
