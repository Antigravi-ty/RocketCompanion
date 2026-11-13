import { create } from 'zustand';

export interface CsrFollowHostState {
  isConnectedAsClient: boolean;
  followHostEnabled: boolean;
  hostActivityId: string;
  hostCameraMode: string;
  hostFocusCarIndex: number;
  hostTick: number;
  frameStepMode: boolean;
}

export interface CsrFollowHostActions {
  setConnectedAsClient: (connected: boolean) => void;
  setFollowHostEnabled: (enabled: boolean) => void;
  toggleFollowHost: () => boolean;
  syncHostBroadcastState: (patch: Partial<CsrFollowHostState>) => void;
  reset: () => void;
}

export type CsrFollowHostStore = CsrFollowHostState & CsrFollowHostActions;

const INITIAL_CSR_FOLLOW_STATE: CsrFollowHostState = {
  isConnectedAsClient: false,
  followHostEnabled: false,
  hostActivityId: 'freeplay',
  hostCameraMode: 'ball',
  hostFocusCarIndex: 0,
  hostTick: 0,
  frameStepMode: false,
};

export const useCsrFollowHostStore = create<CsrFollowHostStore>((set, get) => ({
  ...INITIAL_CSR_FOLLOW_STATE,

  setConnectedAsClient: (connected: boolean) => {
    set({
      isConnectedAsClient: connected,
      ...(connected ? {} : { followHostEnabled: false }),
    });
  },

  setFollowHostEnabled: (enabled: boolean) => {
    set({ followHostEnabled: enabled });
  },

  toggleFollowHost: () => {
    const next = !get().followHostEnabled;
    set({ followHostEnabled: next });
    return next;
  },

  syncHostBroadcastState: (patch: Partial<CsrFollowHostState>) => {
    set((prev) => ({ ...prev, ...patch }));
  },

  reset: () => {
    set({ ...INITIAL_CSR_FOLLOW_STATE });
  },
}));
