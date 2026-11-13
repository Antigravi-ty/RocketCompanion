import { create } from 'zustand';
import type {
  CarTakeoverMode,
  RCDPack,
  RcdJudgeOutcome,
  StateSession,
} from '../config/dynamicTrainingPackTypes.ts';
import {
  loadAllRcdData,
  putRcdPack,
  putStateSession,
  removeRcdPack,
  removeStateSession,
} from './dynamicTrainingStorage.ts';

export interface DynamicTrainingPackState {
  loaded: boolean;
  packs: readonly RCDPack[];
  sessions: Record<string, StateSession>;
  activePackId: string | null;
  activeSessionId: string | null;
  countdownRemainingSec: number;
  lastJudgeOutcome: RcdJudgeOutcome | null;

  loadAll: () => Promise<void>;
  createPack: (name: string, description?: string) => string;
  deletePack: (packId: string) => void;
  saveCapturedSession: (session: StateSession, targetPackId?: string) => void;
  duplicateSessionTo: (sessionId: string, targetPackId: string) => void;
  moveSessionTo: (sessionId: string, fromPackId: string, toPackId: string) => void;
  deleteSessionFromPack: (sessionId: string, packId: string) => void;
  setCarTakeoverMode: (sessionId: string, carIndex: number, mode: CarTakeoverMode) => void;
  setActivePack: (packId: string | null) => void;
  setActiveSession: (sessionId: string | null) => void;
  setCountdownRemaining: (sec: number) => void;
  setLastJudgeOutcome: (outcome: RcdJudgeOutcome | null) => void;
}

function isSessionReferenced(packs: readonly RCDPack[], sessionId: string): boolean {
  return packs.some((p) => p.sessionIds.includes(sessionId));
}

export const dynamicTrainingPackStore = create<DynamicTrainingPackState>((set, get) => ({
  loaded: false,
  packs: [],
  sessions: {},
  activePackId: null,
  activeSessionId: null,
  countdownRemainingSec: 0,
  lastJudgeOutcome: null,

  loadAll: async () => {
    const { packs, sessions } = await loadAllRcdData();
    const sessionMap: Record<string, StateSession> = {};
    for (const s of sessions) {
      sessionMap[s.id] = s;
    }
    set({
      loaded: true,
      packs,
      sessions: sessionMap,
      activePackId: get().activePackId ?? packs[0]?.id ?? null,
    });
  },

  createPack: (name, description = '') => {
    const now = Date.now();
    const id = `rcd-pack-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const pack: RCDPack = {
      id,
      name: name.trim() || 'Untitled RCDPack',
      description,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({
      packs: [...s.packs, pack],
      activePackId: id,
    }));
    void putRcdPack(pack);
    return id;
  },

  deletePack: (packId) => {
    const prev = get();
    const nextPacks = prev.packs.filter((p) => p.id !== packId);
    const nextSessions = { ...prev.sessions };
    for (const sid of Object.keys(nextSessions)) {
      if (!isSessionReferenced(nextPacks, sid)) {
        delete nextSessions[sid];
        void removeStateSession(sid);
      }
    }
    set({
      packs: nextPacks,
      sessions: nextSessions,
      activePackId: prev.activePackId === packId ? nextPacks[0]?.id ?? null : prev.activePackId,
    });
    void removeRcdPack(packId);
  },

  saveCapturedSession: (session, targetPackId) => {
    const state = get();
    let packId = targetPackId ?? state.activePackId;
    if (!packId || !state.packs.some((p) => p.id === packId)) {
      packId = state.createPack('Captured Replay Sessions', 'Auto-created RCDPack');
    }
    const now = Date.now();
    set((s) => {
      const nextPacks = s.packs.map((p) =>
        p.id === packId
          ? {
              ...p,
              sessionIds: p.sessionIds.includes(session.id)
                ? p.sessionIds
                : [...p.sessionIds, session.id],
              updatedAt: now,
            }
          : p
      );
      const updatedPack = nextPacks.find((p) => p.id === packId);
      if (updatedPack) void putRcdPack(updatedPack);
      return {
        packs: nextPacks,
        sessions: { ...s.sessions, [session.id]: session },
        activePackId: packId,
        activeSessionId: session.id,
      };
    });
    void putStateSession(session);
  },

  duplicateSessionTo: (sessionId, targetPackId) => {
    const src = get().sessions[sessionId];
    if (!src) return;
    const now = Date.now();
    const copyId = `rcd-session-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const copy: StateSession = {
      ...src,
      id: copyId,
      name: `${src.name} (Copy)`,
      createdAt: now,
      updatedAt: now,
    };
    get().saveCapturedSession(copy, targetPackId);
  },

  moveSessionTo: (sessionId, fromPackId, toPackId) => {
    if (fromPackId === toPackId) return;
    const now = Date.now();
    set((s) => {
      const nextPacks = s.packs.map((p) => {
        if (p.id === fromPackId) {
          const updated = {
            ...p,
            sessionIds: p.sessionIds.filter((id) => id !== sessionId),
            updatedAt: now,
          };
          void putRcdPack(updated);
          return updated;
        }
        if (p.id === toPackId) {
          const updated = {
            ...p,
            sessionIds: p.sessionIds.includes(sessionId) ? p.sessionIds : [...p.sessionIds, sessionId],
            updatedAt: now,
          };
          void putRcdPack(updated);
          return updated;
        }
        return p;
      });
      return { packs: nextPacks };
    });
  },

  deleteSessionFromPack: (sessionId, packId) => {
    const now = Date.now();
    set((s) => {
      const nextPacks = s.packs.map((p) => {
        if (p.id !== packId) return p;
        const updated = {
          ...p,
          sessionIds: p.sessionIds.filter((id) => id !== sessionId),
          updatedAt: now,
        };
        void putRcdPack(updated);
        return updated;
      });
      const nextSessions = { ...s.sessions };
      if (!isSessionReferenced(nextPacks, sessionId)) {
        delete nextSessions[sessionId];
        void removeStateSession(sessionId);
      }
      return {
        packs: nextPacks,
        sessions: nextSessions,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    });
  },

  setCarTakeoverMode: (sessionId, carIndex, mode) => {
    set((s) => {
      const cur = s.sessions[sessionId];
      if (!cur) return s;
      const updated: StateSession = {
        ...cur,
        carTakeoverModes: { ...cur.carTakeoverModes, [carIndex]: mode },
        updatedAt: Date.now(),
      };
      void putStateSession(updated);
      return { sessions: { ...s.sessions, [sessionId]: updated } };
    });
  },

  setActivePack: (activePackId) => set({ activePackId }),
  setActiveSession: (activeSessionId) => set({ activeSessionId }),
  setCountdownRemaining: (countdownRemainingSec) => set({ countdownRemainingSec }),
  setLastJudgeOutcome: (lastJudgeOutcome) => set({ lastJudgeOutcome }),
}));

export function useDynamicTrainingPackStore<T>(
  selector: (state: DynamicTrainingPackState) => T
): T {
  return dynamicTrainingPackStore(selector);
}
