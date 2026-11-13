import { create } from 'zustand';
import {
  createDefaultPerCarTakeover,
  generateDynamicUuid,
  relinkDynamicShotChain,
  type DynamicCarTakeoverRule,
  type DynamicTrainingPackRecord,
  type DynamicTrainingShotRef,
  type DynamicTrainingShotStats,
  type DynamicTrainingStateSession,
  type DynamicTrainingStateSessionSummary,
} from '../config/dynamicTrainingPackTypes';
import { decodeRcdPackFromJson, encodeRcdPackToJson } from '../config/dynamicTrainingPackCodec';
import {
  countSessionReferencesAcrossPacks,
  deleteDynamicPack,
  deleteDynamicStateSession,
  duplicateDynamicShotToPack,
  ensureCapturedFromReplayPack,
  listDynamicPacks,
  listDynamicStateSessionSummaries,
  loadAllDynamicShotStats,
  loadDynamicStateSession,
  moveDynamicShotBetweenPacks,
  saveDynamicPack,
  saveDynamicShotStats,
  saveDynamicStateSession,
} from './dynamicTrainingPackStorage';

export type DynamicTrainingPlayPhase = 'idle' | 'preroll-countdown' | 'intervening' | 'result';

export interface DynamicTrainingPackStoreState {
  isLoaded: boolean;
  packs: DynamicTrainingPackRecord[];
  sessionSummaries: DynamicTrainingStateSessionSummary[];
  activePackUuid: string | null;
  activeShotId: string | null;
  playPhase: DynamicTrainingPlayPhase;
  countdownRemainingSec: number;
  remainingTimeoutSec: number;
  lastResult: 'goal' | 'timeout' | null;
  shotStats: Record<string, DynamicTrainingShotStats>;
  statusMessage: string | null;

  initialize: () => Promise<void>;
  refreshAll: () => Promise<void>;
  selectPack: (packUuid: string | null) => void;
  selectShot: (shotId: string | null) => void;
  createPack: (title: string, folder?: string) => Promise<DynamicTrainingPackRecord>;
  removePack: (packUuid: string) => Promise<void>;
  saveCaptureSessionIntoPack: (
    session: DynamicTrainingStateSession,
    options?: { packUuid?: string; shotName?: string; povSlotIndex?: number }
  ) => Promise<{ pack: DynamicTrainingPackRecord; shot: DynamicTrainingShotRef }>;
  updateShotConfig: (
    packUuid: string,
    shotId: string,
    patch: Partial<DynamicTrainingShotRef>
  ) => Promise<void>;
  updateShotPerCarTakeover: (
    packUuid: string,
    shotId: string,
    slotIndex: number,
    rule: DynamicCarTakeoverRule
  ) => Promise<void>;
  moveShotToPack: (sourcePackUuid: string, targetPackUuid: string, shotId: string) => Promise<void>;
  duplicateShotToPack: (
    sourcePackUuid: string,
    targetPackUuid: string,
    shotId: string
  ) => Promise<void>;
  deleteShotWithSessionCheck: (
    packUuid: string,
    shotId: string,
    deleteUnreferencedSession: boolean
  ) => Promise<void>;
  exportPackJson: (packUuid: string) => Promise<string | null>;
  importPackJson: (rawJson: string) => Promise<DynamicTrainingPackRecord>;
  recordShotOutcome: (shotId: string, outcome: 'goal' | 'timeout') => Promise<void>;
  setLivePlaybackState: (patch: {
    playPhase?: DynamicTrainingPlayPhase;
    countdownRemainingSec?: number;
    remainingTimeoutSec?: number;
    lastResult?: 'goal' | 'timeout' | null;
    statusMessage?: string | null;
  }) => void;

  runtimeHandlers: {
    onPlayShot?: (packUuid: string, shotId: string) => Promise<void> | void;
    onRestartShot?: () => void;
    onStopSession?: () => void;
  };
  setRuntimeHandlers: (
    handlers: Partial<DynamicTrainingPackStoreState['runtimeHandlers']>
  ) => void;
}

export const useDynamicTrainingPackStore = create<DynamicTrainingPackStoreState>((set, get) => ({
  isLoaded: false,
  packs: [],
  sessionSummaries: [],
  activePackUuid: null,
  activeShotId: null,
  playPhase: 'idle',
  countdownRemainingSec: 0,
  remainingTimeoutSec: 0,
  lastResult: null,
  shotStats: {},
  statusMessage: null,
  runtimeHandlers: {},

  setRuntimeHandlers: (handlers) =>
    set((s) => ({ runtimeHandlers: { ...s.runtimeHandlers, ...handlers } })),

  setLivePlaybackState: (patch) => set((s) => ({ ...s, ...patch })),

  initialize: async () => {
    if (get().isLoaded) return;
    await ensureCapturedFromReplayPack();
    await get().refreshAll();
    set({ isLoaded: true });
  },

  refreshAll: async () => {
    const [packs, sessionSummaries, shotStats] = await Promise.all([
      listDynamicPacks(),
      listDynamicStateSessionSummaries(),
      loadAllDynamicShotStats(),
    ]);
    const currentPackUuid = get().activePackUuid;
    const activePack =
      packs.find((p) => p.metadata.uuid === currentPackUuid) ?? packs[0] ?? null;
    const currentShotId = get().activeShotId;
    const activeShot =
      activePack?.shots.find((s) => s.id === currentShotId) ?? activePack?.shots[0] ?? null;
    set({
      packs,
      sessionSummaries,
      shotStats,
      activePackUuid: activePack?.metadata.uuid ?? null,
      activeShotId: activeShot?.id ?? null,
    });
  },

  selectPack: (packUuid) => {
    const pack = get().packs.find((p) => p.metadata.uuid === packUuid) ?? null;
    set({
      activePackUuid: pack?.metadata.uuid ?? null,
      activeShotId: pack?.shots[0]?.id ?? null,
    });
  },

  selectShot: (shotId) => set({ activeShotId: shotId }),

  createPack: async (title, folder = 'custom') => {
    const now = Date.now();
    const record: DynamicTrainingPackRecord = {
      metadata: {
        uuid: generateDynamicUuid(),
        title: title.trim() || 'Untitled Dynamic Pack',
        description: '',
        folder,
        createdAt: now,
        updatedAt: now,
        itemCount: 0,
      },
      shots: [],
    };
    const saved = await saveDynamicPack(record);
    await get().refreshAll();
    set({ activePackUuid: saved.metadata.uuid, activeShotId: null });
    return saved;
  },

  removePack: async (packUuid) => {
    await deleteDynamicPack(packUuid);
    await get().refreshAll();
  },

  saveCaptureSessionIntoPack: async (session, options) => {
    await saveDynamicStateSession(session);
    const packs = await listDynamicPacks();
    let targetPack = options?.packUuid
      ? packs.find((p) => p.metadata.uuid === options.packUuid)
      : undefined;
    if (!targetPack) {
      targetPack = await ensureCapturedFromReplayPack();
    }

    const povSlot = options?.povSlotIndex ?? session.defaultPovSlotIndex;
    const prevShotId =
      targetPack.shots.length > 0 ? targetPack.shots[targetPack.shots.length - 1].id : null;
    const shot: DynamicTrainingShotRef = {
      id: generateDynamicUuid(),
      sessionId: session.sessionId,
      prevShotId,
      name: options?.shotName?.trim() || session.title || `Shot ${targetPack.shots.length + 1}`,
      timeoutSeconds: 10,
      downCounterSeconds: 3,
      interveneOffsetFrames: 0,
      povSlotIndex: povSlot,
      perCarTakeover: createDefaultPerCarTakeover(povSlot, session.roster),
    };

    const savedPack = await saveDynamicPack({
      metadata: targetPack.metadata,
      shots: [...targetPack.shots, shot],
    });
    await get().refreshAll();
    set({ activePackUuid: savedPack.metadata.uuid, activeShotId: shot.id });
    return { pack: savedPack, shot };
  },

  updateShotConfig: async (packUuid, shotId, patch) => {
    const pack = get().packs.find((p) => p.metadata.uuid === packUuid);
    if (!pack) return;
    const nextShots = relinkDynamicShotChain(
      pack.shots.map((s) => (s.id === shotId ? { ...s, ...patch, id: s.id } : s))
    );
    await saveDynamicPack({ metadata: pack.metadata, shots: nextShots });
    await get().refreshAll();
  },

  updateShotPerCarTakeover: async (packUuid, shotId, slotIndex, rule) => {
    const pack = get().packs.find((p) => p.metadata.uuid === packUuid);
    if (!pack) return;
    const shot = pack.shots.find((s) => s.id === shotId);
    if (!shot) return;
    const nextPerCar = { ...shot.perCarTakeover, [slotIndex]: rule };
    const nextPov = rule.mode === 'player' ? slotIndex : shot.povSlotIndex;
    await get().updateShotConfig(packUuid, shotId, {
      povSlotIndex: nextPov,
      perCarTakeover: nextPerCar,
    });
  },

  moveShotToPack: async (sourcePackUuid, targetPackUuid, shotId) => {
    await moveDynamicShotBetweenPacks(sourcePackUuid, targetPackUuid, shotId);
    await get().refreshAll();
  },

  duplicateShotToPack: async (sourcePackUuid, targetPackUuid, shotId) => {
    await duplicateDynamicShotToPack(sourcePackUuid, targetPackUuid, shotId);
    await get().refreshAll();
  },

  deleteShotWithSessionCheck: async (packUuid, shotId, deleteUnreferencedSession) => {
    const pack = get().packs.find((p) => p.metadata.uuid === packUuid);
    if (!pack) return;
    const shot = pack.shots.find((s) => s.id === shotId);
    const nextShots = relinkDynamicShotChain(pack.shots.filter((s) => s.id !== shotId));
    await saveDynamicPack({ metadata: pack.metadata, shots: nextShots });
    if (shot && deleteUnreferencedSession) {
      const refs = await countSessionReferencesAcrossPacks(shot.sessionId);
      if (refs === 0) {
        await deleteDynamicStateSession(shot.sessionId);
      }
    }
    await get().refreshAll();
  },

  exportPackJson: async (packUuid) => {
    const pack = get().packs.find((p) => p.metadata.uuid === packUuid);
    if (!pack) return null;
    const sessionMap = new Map<string, DynamicTrainingStateSession>();
    for (const shot of pack.shots) {
      if (sessionMap.has(shot.sessionId)) continue;
      const sess = await loadDynamicStateSession(shot.sessionId);
      if (sess) sessionMap.set(shot.sessionId, sess);
    }
    return encodeRcdPackToJson(pack, sessionMap);
  },

  importPackJson: async (rawJson) => {
    const { pack, sessions } = decodeRcdPackFromJson(rawJson);
    for (const sess of sessions) {
      await saveDynamicStateSession(sess);
    }
    const saved = await saveDynamicPack(pack);
    await get().refreshAll();
    set({ activePackUuid: saved.metadata.uuid, activeShotId: saved.shots[0]?.id ?? null });
    return saved;
  },

  recordShotOutcome: async (shotId, outcome) => {
    const prev = get().shotStats[shotId] ?? {
      attempts: 0,
      goals: 0,
      timeouts: 0,
      lastResult: null,
      lastPlayedAt: 0,
    };
    const next: DynamicTrainingShotStats = {
      attempts: prev.attempts + 1,
      goals: prev.goals + (outcome === 'goal' ? 1 : 0),
      timeouts: prev.timeouts + (outcome === 'timeout' ? 1 : 0),
      lastResult: outcome,
      lastPlayedAt: Date.now(),
    };
    await saveDynamicShotStats(shotId, next);
    set((s) => ({
      shotStats: { ...s.shotStats, [shotId]: next },
      lastResult: outcome,
      playPhase: 'result',
    }));
  },
}));
