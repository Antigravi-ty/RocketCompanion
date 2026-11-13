export type DynamicCarTakeoverMode =
  | 'player'
  | 'disappear'
  | 'as-previous'
  | 'model'
  | 'no-input';

export interface DynamicCarTakeoverRule {
  mode: DynamicCarTakeoverMode;
  modelId?: string;
}

export interface DynamicTrainingRosterSlot {
  slotIndex: number;
  userName: string;
  team: 0 | 1;
  hitboxId: string;
  visualId: string;
  primaryColorHex?: string;
  accentColorHex?: string;
}

export interface DynamicTrainingCompactCarFrame {
  slotIndex: number;
  entityActive: boolean;
  isDemolished?: boolean;
  pos: [number, number, number];
  rot: [number, number, number, number];
  vel: [number, number, number];
  angVel: [number, number, number];
  boostAmount: number;
  isOnGround: boolean;
  isSupersonic: boolean;
  hasFlipOrJump: boolean;
  airTimeSinceJump: number;
  activeFlags: [boolean, boolean, boolean, boolean];
  controls: [number, number, number, number, number, boolean, boolean, boolean];
}

export interface DynamicTrainingCompactFrame {
  frameIndex: number;
  timeSeconds: number;
  ballPos: [number, number, number];
  ballRot: [number, number, number, number];
  ballVel: [number, number, number];
  ballAngVel: [number, number, number];
  cars: DynamicTrainingCompactCarFrame[];
  boostPadCooldowns: number[];
}

export interface DynamicTrainingStateSession {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sourceKind: 'replay-capture' | 'scratch-authoring';
  sourceReplayName: string;
  sourceFrame120Hz: number;
  prerollStartFrame120Hz: number;
  durationSeconds: number;
  tickRate: 120;
  defaultPovSlotIndex: number;
  roster: DynamicTrainingRosterSlot[];
  frames: DynamicTrainingCompactFrame[];
}

export interface DynamicTrainingStateSessionSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sourceKind: 'replay-capture' | 'scratch-authoring';
  sourceReplayName: string;
  durationSeconds: number;
  frameCount: number;
  defaultPovSlotIndex: number;
  rosterCount: number;
}

export interface DynamicTrainingCarSpawnVariation {
  enabled: boolean;
  posJitterUu: number;
  yawJitterRad: number;
}

export interface DynamicTrainingShotRef {
  id: string;
  sessionId: string;
  prevShotId: string | null;
  name: string;
  timeoutSeconds: number;
  downCounterSeconds: 0 | 1 | 2 | 3;
  interveneOffsetFrames: number;
  povSlotIndex: number;
  perCarTakeover: Record<number, DynamicCarTakeoverRule>;
  optionalCarSpawnVariation?: DynamicTrainingCarSpawnVariation;
}

export interface DynamicTrainingPackMetadata {
  uuid: string;
  title: string;
  description: string;
  folder: string;
  creator?: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  itemCount: number;
}

export interface DynamicTrainingPackRecord {
  metadata: DynamicTrainingPackMetadata;
  shots: DynamicTrainingShotRef[];
}

export interface RCDPackArchive {
  format: 'RCDPack';
  version: 1;
  category: 'dynamic-training-pack';
  metadata: DynamicTrainingPackMetadata;
  shots: DynamicTrainingShotRef[];
  sessions: DynamicTrainingStateSession[];
}

export interface DynamicTrainingShotStats {
  attempts: number;
  goals: number;
  timeouts: number;
  lastResult: 'goal' | 'timeout' | null;
  lastPlayedAt: number;
}

export const DYNAMIC_TRAINING_DEFAULT_FOLDER = 'captured_from_replay';
export const DYNAMIC_TRAINING_PREROLL_SECONDS = 4;
export const DYNAMIC_TRAINING_PREROLL_FRAMES = 480;

export function generateDynamicUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createDefaultPerCarTakeover(
  povSlotIndex: number,
  roster: readonly DynamicTrainingRosterSlot[]
): Record<number, DynamicCarTakeoverRule> {
  const map: Record<number, DynamicCarTakeoverRule> = {};
  for (const slot of roster) {
    map[slot.slotIndex] =
      slot.slotIndex === povSlotIndex ? { mode: 'player' } : { mode: 'as-previous' };
  }
  if (!map[povSlotIndex]) {
    map[povSlotIndex] = { mode: 'player' };
  }
  return map;
}

export function sortDynamicShotsByPrevLink(
  shots: readonly DynamicTrainingShotRef[]
): DynamicTrainingShotRef[] {
  if (shots.length <= 1) return [...shots];
  const byId = new Map<string, DynamicTrainingShotRef>();
  const childrenByPrev = new Map<string | null, DynamicTrainingShotRef[]>();
  for (const shot of shots) {
    byId.set(shot.id, shot);
    const key = shot.prevShotId && shot.prevShotId !== shot.id ? shot.prevShotId : null;
    const list = childrenByPrev.get(key) ?? [];
    list.push(shot);
    childrenByPrev.set(key, list);
  }

  const ordered: DynamicTrainingShotRef[] = [];
  const visited = new Set<string>();

  const walkFrom = (prevKey: string | null) => {
    const queue = childrenByPrev.get(prevKey) ?? [];
    for (const item of queue) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      ordered.push(item);
      walkFrom(item.id);
    }
  };

  walkFrom(null);

  for (const shot of shots) {
    if (visited.has(shot.id)) continue;
    if (!shot.prevShotId || !byId.has(shot.prevShotId)) {
      visited.add(shot.id);
      ordered.push(shot);
      walkFrom(shot.id);
    }
  }

  for (const shot of shots) {
    if (!visited.has(shot.id)) {
      visited.add(shot.id);
      ordered.push(shot);
    }
  }

  return ordered;
}

export function relinkDynamicShotChain(
  shots: readonly DynamicTrainingShotRef[]
): DynamicTrainingShotRef[] {
  return shots.map((shot, idx) => ({
    ...shot,
    prevShotId: idx === 0 ? null : shots[idx - 1].id,
  }));
}

export function summarizeDynamicStateSession(
  session: DynamicTrainingStateSession
): DynamicTrainingStateSessionSummary {
  return {
    sessionId: session.sessionId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sourceKind: session.sourceKind,
    sourceReplayName: session.sourceReplayName,
    durationSeconds: session.durationSeconds,
    frameCount: session.frames.length,
    defaultPovSlotIndex: session.defaultPovSlotIndex,
    rosterCount: session.roster.length,
  };
}
