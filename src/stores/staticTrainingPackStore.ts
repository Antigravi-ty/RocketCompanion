import { create } from 'zustand';
import {
  type StaticTrainingPackMetadata,
  type StaticTrainingShotItem,
  type EditSubMode,
  EDIT_SUB_MODES_ORDER,
  MAX_SHOTS_PER_PACK,
  generateUUID,
  createDefaultShotItem,
  cloneShotItem,
  areShotItemsEqual,
  areShotListsEqual,
  listStaticTrainingPacks,
  loadStaticTrainingPackByUuid,
  saveStaticTrainingPackFull,
  saveSingleStaticTrainingShotItem,
  deleteStaticTrainingPackByUuid,
  saveEditWorkspacePackFull,
  saveSingleEditWorkspaceShotItem,
  clearEditWorkspaceByUuid,
  exportStaticTrainingPackRCSPack,
  importStaticTrainingPackFromFile,
  exportSingleShotItemToJson,
  parseSingleShotItemFromJsonFile,
} from '../training/StaticTrainingPackStorage';

export {
  type StaticTrainingPackMetadata,
  type StaticTrainingShotItem,
  type EditSubMode,
  MAX_SHOTS_PER_PACK,
  areShotItemsEqual,
  areShotListsEqual,
};
export type StaticPackDownCounterOption = 1 | 2 | 3;
export type StaticPackSessionMode = 'browse' | 'play' | 'edit';

export interface ActiveStaticTrainingPackBundle {
  uuid: string;
  title: string;
  description: string;
  itemCount: number;
  metadata: StaticTrainingPackMetadata;
  items: StaticTrainingShotItem[];
}

/**
 * Fast in-memory variable holding the active shot item during Item Edit Mode.
 * Mutated directly at 60-120Hz during keyboard/mouse manipulation.
 */
let activeEditItemVariable: StaticTrainingShotItem | null = null;

export function getActiveEditItemVariable(): StaticTrainingShotItem | null {
  return activeEditItemVariable;
}

export function setActiveEditItemVariable(item: StaticTrainingShotItem | null): void {
  activeEditItemVariable = item;
}

export function mutateActiveEditItemVariable(
  updater: (draft: StaticTrainingShotItem) => void
): StaticTrainingShotItem | null {
  const store = useStaticTrainingPackStore.getState();
  if (!activeEditItemVariable) {
    const items = store.activePack?.items || store.activeItems || [];
    const fallback = items[store.currentShotIndex] || items[0];
    if (!fallback) return null;
    activeEditItemVariable = cloneShotItem(fallback, store.currentShotIndex);
  }
  updater(activeEditItemVariable);
  const clonedDraft = cloneShotItem(activeEditItemVariable, store.currentShotIndex);
  activeEditItemVariable = clonedDraft;
  useStaticTrainingPackStore.setState((s) => ({
    editVarVersion: s.editVarVersion + 1,
    activeEditItemDraft: clonedDraft,
  }));
  const handlers = store.runtimeHandlers;
  handlers.onEditVariableMutated?.(clonedDraft);
  handlers.onSyncEditDraftToArena?.(clonedDraft);
  return clonedDraft;
}

function buildActivePackBundle(
  metadata: StaticTrainingPackMetadata | null,
  items: StaticTrainingShotItem[]
): ActiveStaticTrainingPackBundle | null {
  if (!metadata) return null;
  return {
    uuid: metadata.uuid,
    title: metadata.title,
    description: metadata.description,
    itemCount: items.length,
    metadata: { ...metadata, itemCount: items.length },
    items,
  };
}

export interface StaticTrainingPackRuntimeHandlers {
  onShotChanged?: (shotIndex: number) => void;
  onLoadShotInArena?: (shotIndex: number) => void;
  onResetShotRequested?: () => void;
  onResetCurrentShot?: () => void;
  onEditVariableMutated?: (draft: StaticTrainingShotItem) => void;
  onSyncEditDraftToArena?: (draft: StaticTrainingShotItem) => void;
  onEditSubModeChanged?: (subMode: EditSubMode) => void;
  onSessionModeChanged?: (mode: StaticPackSessionMode) => void;
}

export interface StaticTrainingPackStoreState {
  initialized: boolean;
  isLoading: boolean;
  packs: StaticTrainingPackMetadata[];
  selectedPackUuid: string | null;

  // Active Play / Edit session state
  sessionMode: StaticPackSessionMode;
  activePack: ActiveStaticTrainingPackBundle | null;
  activeItems: StaticTrainingShotItem[];
  committedSessionItems: StaticTrainingShotItem[];
  currentShotIndex: number;

  // Item Edit state (when true, right-side Edit Shot panel is open for currentShotIndex)
  isEditingItem: boolean;
  activeEditItemDraft: StaticTrainingShotItem | null;
  editSubMode: EditSubMode;
  editVarVersion: number;

  // Play Down Counter (defaults: disabled = false, value = 1 -> 2s hold + beep at 1s + GO at 0s)
  downCounterEnabled: boolean;
  downCounterValue: StaticPackDownCounterOption;
  downCounterSeconds: StaticPackDownCounterOption;

  // Live Play & Edit Test Telemetry
  remainingTimeoutSec: number;
  activeCountdownSec: number;
  isShotLaunched: boolean;
  isOvertimeWaitGround: boolean;
  isReplayActive: boolean;
  replayType: 'goal' | 'expire' | null;
  isFreeCamTrajectoryTesting: boolean;
  isTestingSingleShot: boolean;

  runtimeHandlers: StaticTrainingPackRuntimeHandlers;

  // Actions
  initStore: () => Promise<void>;
  initPacks: () => Promise<void>;
  selectPack: (uuid: string) => Promise<void>;
  createPack: (title: string, description: string) => Promise<StaticTrainingPackMetadata>;
  updatePackInfo: (uuid: string, title: string, description: string) => Promise<void>;
  updatePackMetadata: (uuid: string, patch: { title?: string; description?: string }) => Promise<void>;
  deletePack: (uuid: string) => Promise<void>;
  exportPackRCS: (uuid?: string) => Promise<string | null>;
  importPackRCS: (file: File) => Promise<StaticTrainingPackMetadata>;

  // Session Mode & Edit Workspace Lifecycle
  setSessionMode: (mode: StaticPackSessionMode) => void;
  beginEditSession: (uuid: string) => Promise<void>;
  saveCurrentShotToEditWorkspace: () => Promise<void>;
  deselectEditShot: () => Promise<void>;
  isCurrentShotDirty: () => boolean;
  hasUnsavedEditSessionChanges: () => boolean;
  commitEditSessionToMainDb: () => Promise<void>;
  discardEditSessionChanges: () => Promise<void>;

  // Shot Navigation
  setCurrentShotIndex: (index: number) => void;
  nextShot: () => void;
  prevShot: () => void;
  resetCurrentShot: () => void;

  // Shot List Management (operates on Edit-Mode IndexedDB during Edit Session, max 99 shots)
  addNewShot: () => Promise<void>;
  duplicateShot: (index: number) => Promise<void>;
  deleteShot: (index: number) => Promise<void>;
  reorderShot: (fromIndex: number, toIndex: number) => Promise<void>;

  // Item Edit Mode (selects a shot in the Edit Session)
  enterItemEditMode: (index?: number) => void;
  exitItemEditModeAndSave: () => Promise<void>;
  exportSingleShotJson: (index?: number) => string | null;
  importSingleShotJson: (file: File, index?: number) => Promise<void>;

  // Edit Sub-Mode (Car Heading -> Car Speed -> Ball Speed -> Free Cam; 9 = prev, 0 / RightClick = next)
  setEditSubMode: (subMode: EditSubMode) => void;
  cycleEditSubMode: (delta: 1 | -1) => EditSubMode;

  // Down Counter & Telemetry
  setDownCounterEnabled: (enabled: boolean) => void;
  setDownCounterValue: (val: StaticPackDownCounterOption) => void;
  setFreeCamTrajectoryTesting: (active: boolean) => void;
  setTestingSingleShot: (active: boolean) => void;
  updateLiveTelemetry: (
    patch: Partial<{
      remainingTimeoutSec: number;
      activeCountdownSec: number;
      isShotLaunched: boolean;
      isOvertimeWaitGround: boolean;
      isReplayActive: boolean;
      replayType: 'goal' | 'expire' | null;
      isFreeCamTrajectoryTesting: boolean;
      isTestingSingleShot: boolean;
    }>
  ) => void;
  setRuntimeHandlers: (handlers: Partial<StaticTrainingPackRuntimeHandlers>) => void;
}

export const useStaticTrainingPackStore = create<StaticTrainingPackStoreState>((set, get) => ({
  initialized: false,
  isLoading: false,
  packs: [],
  selectedPackUuid: null,

  sessionMode: 'play',
  activePack: null,
  activeItems: [],
  committedSessionItems: [],
  currentShotIndex: 0,

  isEditingItem: false,
  activeEditItemDraft: null,
  editSubMode: 'car-heading',
  editVarVersion: 0,

  downCounterEnabled: false,
  downCounterValue: 1,
  downCounterSeconds: 1,

  remainingTimeoutSec: 10,
  activeCountdownSec: 0,
  isShotLaunched: false,
  isOvertimeWaitGround: false,
  isReplayActive: false,
  replayType: null,
  isFreeCamTrajectoryTesting: false,
  isTestingSingleShot: false,

  runtimeHandlers: {},

  initStore: async () => {
    await get().initPacks();
  },

  initPacks: async () => {
    set({ isLoading: true });
    try {
      const packs = await listStaticTrainingPacks();
      const currentSelected = get().selectedPackUuid;
      const validSelected =
        currentSelected && packs.some((p) => p.uuid === currentSelected)
          ? currentSelected
          : packs[0]?.uuid ?? null;

      let activePack = get().activePack;
      let activeItems = get().activeItems;
      if (validSelected && (!activePack || activePack.uuid !== validSelected)) {
        const loaded = await loadStaticTrainingPackByUuid(validSelected);
        activeItems = loaded.items;
        activePack = buildActivePackBundle(loaded.metadata, loaded.items);
      }

      set({
        initialized: true,
        isLoading: false,
        packs,
        selectedPackUuid: validSelected,
        activePack,
        activeItems,
        committedSessionItems: activeItems.map((it, idx) => cloneShotItem(it, idx)),
      });
    } catch (err) {
      console.error('[staticTrainingPackStore] Failed to init packs:', err);
      set({ isLoading: false, initialized: true });
    }
  },

  selectPack: async (uuid: string) => {
    const loaded = await loadStaticTrainingPackByUuid(uuid);
    const bundle = buildActivePackBundle(loaded.metadata, loaded.items);
    activeEditItemVariable = null;
    set({
      selectedPackUuid: uuid,
      activePack: bundle,
      activeItems: loaded.items,
      committedSessionItems: loaded.items.map((it, idx) => cloneShotItem(it, idx)),
      currentShotIndex: 0,
      isEditingItem: false,
      activeEditItemDraft: null,
      isFreeCamTrajectoryTesting: false,
      isTestingSingleShot: false,
    });
  },

  beginEditSession: async (uuid: string) => {
    const loaded = await loadStaticTrainingPackByUuid(uuid);
    if (!loaded.metadata) return;
    await saveEditWorkspacePackFull(loaded.metadata, loaded.items);
    const bundle = buildActivePackBundle(loaded.metadata, loaded.items);
    activeEditItemVariable = null;
    set({
      selectedPackUuid: uuid,
      sessionMode: 'edit',
      activePack: bundle,
      activeItems: loaded.items.map((it, idx) => cloneShotItem(it, idx)),
      committedSessionItems: loaded.items.map((it, idx) => cloneShotItem(it, idx)),
      currentShotIndex: 0,
      isEditingItem: false,
      activeEditItemDraft: null,
      isFreeCamTrajectoryTesting: false,
      isTestingSingleShot: false,
    });
    get().runtimeHandlers.onSessionModeChanged?.('edit');
  },

  saveCurrentShotToEditWorkspace: async () => {
    const { activePack, activeItems, currentShotIndex, isEditingItem } = get();
    const draft = activeEditItemVariable || get().activeEditItemDraft;
    if (!isEditingItem || !activePack || !draft) return;

    const idx = Math.max(0, Math.min(activeItems.length - 1, currentShotIndex));
    const savedShot = cloneShotItem(draft, idx);
    activeEditItemVariable = cloneShotItem(savedShot, idx);
    const nextItems = activeItems.map((it, i) => (i === idx ? savedShot : it));
    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: nextItems.length,
      updatedAt: Date.now(),
    };

    await saveSingleEditWorkspaceShotItem(activePack.uuid, idx, savedShot, updatedMeta);
    const bundle = buildActivePackBundle(updatedMeta, nextItems);

    set((s) => ({
      activePack: bundle,
      activeItems: nextItems,
      activeEditItemDraft: cloneShotItem(savedShot, idx),
      editVarVersion: s.editVarVersion + 1,
    }));
  },

  deselectEditShot: async () => {
    if (get().isCurrentShotDirty()) {
      await get().saveCurrentShotToEditWorkspace();
    }
    activeEditItemVariable = null;
    set((s) => ({
      isEditingItem: false,
      activeEditItemDraft: null,
      editVarVersion: s.editVarVersion + 1,
    }));
  },

  isCurrentShotDirty: () => {
    const { isEditingItem, activeEditItemDraft, activeItems, currentShotIndex } = get();
    const draft = activeEditItemVariable || activeEditItemDraft;
    if (!isEditingItem || !draft) return false;
    const saved = activeItems[currentShotIndex];
    if (!saved) return true;
    return !areShotItemsEqual(draft, saved);
  },

  hasUnsavedEditSessionChanges: () => {
    const { activeItems, committedSessionItems, isEditingItem, activeEditItemDraft, currentShotIndex } = get();
    const draft = activeEditItemVariable || activeEditItemDraft;
    const effectiveItems =
      isEditingItem && draft
        ? activeItems.map((it, i) => (i === currentShotIndex ? cloneShotItem(draft, i) : it))
        : activeItems;
    return !areShotListsEqual(effectiveItems, committedSessionItems);
  },

  commitEditSessionToMainDb: async () => {
    const { activePack, activeItems, isEditingItem, activeEditItemDraft, currentShotIndex } = get();
    if (!activePack) return;
    const draft = activeEditItemVariable || activeEditItemDraft;
    const finalItems = (
      isEditingItem && draft
        ? activeItems.map((it, i) => (i === currentShotIndex ? cloneShotItem(draft, i) : it))
        : activeItems
    )
      .slice(0, MAX_SHOTS_PER_PACK)
      .map((it, idx) => cloneShotItem(it, idx));

    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: finalItems.length,
      updatedAt: Date.now(),
    };

    await saveStaticTrainingPackFull(updatedMeta, finalItems);
    await clearEditWorkspaceByUuid(activePack.uuid);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(updatedMeta, finalItems);

    activeEditItemVariable = null;
    set((s) => ({
      packs,
      activePack: bundle,
      activeItems: finalItems,
      committedSessionItems: finalItems.map((it, idx) => cloneShotItem(it, idx)),
      isEditingItem: false,
      activeEditItemDraft: null,
      isFreeCamTrajectoryTesting: false,
      isTestingSingleShot: false,
      editVarVersion: s.editVarVersion + 1,
    }));
  },

  discardEditSessionChanges: async () => {
    const { activePack } = get();
    if (!activePack) return;
    await clearEditWorkspaceByUuid(activePack.uuid);
    const loaded = await loadStaticTrainingPackByUuid(activePack.uuid);
    const bundle = buildActivePackBundle(loaded.metadata, loaded.items);
    activeEditItemVariable = null;
    set((s) => ({
      activePack: bundle,
      activeItems: loaded.items,
      committedSessionItems: loaded.items.map((it, idx) => cloneShotItem(it, idx)),
      currentShotIndex: 0,
      isEditingItem: false,
      activeEditItemDraft: null,
      isFreeCamTrajectoryTesting: false,
      isTestingSingleShot: false,
      editVarVersion: s.editVarVersion + 1,
    }));
  },

  createPack: async (title: string, description: string) => {
    const now = Date.now();
    const uuid = generateUUID();
    const initialShot = createDefaultShotItem(0);
    const meta: StaticTrainingPackMetadata = {
      uuid,
      title: (title || 'New Static Pack').trim() || 'New Static Pack',
      description: (description || '').trim(),
      createdAt: now,
      updatedAt: now,
      itemCount: 1,
    };
    await saveStaticTrainingPackFull(meta, [initialShot]);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(meta, [initialShot]);
    activeEditItemVariable = null;
    set({
      packs,
      selectedPackUuid: uuid,
      activePack: bundle,
      activeItems: [initialShot],
      committedSessionItems: [cloneShotItem(initialShot, 0)],
      currentShotIndex: 0,
      isEditingItem: false,
      activeEditItemDraft: null,
    });
    return meta;
  },

  updatePackInfo: async (uuid: string, title: string, description: string) => {
    await get().updatePackMetadata(uuid, { title, description });
  },

  updatePackMetadata: async (uuid: string, patch: { title?: string; description?: string }) => {
    const loaded = await loadStaticTrainingPackByUuid(uuid);
    if (!loaded.metadata) return;
    const updatedMeta: StaticTrainingPackMetadata = {
      ...loaded.metadata,
      title: patch.title !== undefined ? patch.title : loaded.metadata.title,
      description: patch.description !== undefined ? patch.description : loaded.metadata.description,
      updatedAt: Date.now(),
    };
    await saveStaticTrainingPackFull(updatedMeta, loaded.items);
    const packs = await listStaticTrainingPacks();
    set((s) => ({
      packs,
      activePack:
        s.activePack?.uuid === uuid
          ? buildActivePackBundle(updatedMeta, s.activeItems)
          : s.activePack,
    }));
  },

  deletePack: async (uuid: string) => {
    if (get().isEditingItem && get().activePack?.uuid === uuid) {
      activeEditItemVariable = null;
      set({ isEditingItem: false, activeEditItemDraft: null });
    }
    await deleteStaticTrainingPackByUuid(uuid);
    const packs = await listStaticTrainingPacks();
    const nextUuid = packs[0]?.uuid ?? null;
    let nextActivePack: ActiveStaticTrainingPackBundle | null = null;
    let nextActiveItems: StaticTrainingShotItem[] = [];
    if (nextUuid) {
      const loaded = await loadStaticTrainingPackByUuid(nextUuid);
      nextActiveItems = loaded.items;
      nextActivePack = buildActivePackBundle(loaded.metadata, loaded.items);
    }
    set({
      packs,
      selectedPackUuid: nextUuid,
      activePack: nextActivePack,
      activeItems: nextActiveItems,
      committedSessionItems: nextActiveItems.map((it, idx) => cloneShotItem(it, idx)),
      currentShotIndex: 0,
    });
  },

  exportPackRCS: async (uuid?: string) => {
    const targetUuid = uuid || get().activePack?.uuid || get().selectedPackUuid;
    if (!targetUuid) return null;
    const loaded = await loadStaticTrainingPackByUuid(targetUuid);
    if (!loaded.metadata) return null;
    return await exportStaticTrainingPackRCSPack(loaded.metadata, loaded.items);
  },

  importPackRCS: async (file: File) => {
    const { metadata, items } = await importStaticTrainingPackFromFile(file);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(metadata, items);
    activeEditItemVariable = null;
    set({
      packs,
      selectedPackUuid: metadata.uuid,
      activePack: bundle,
      activeItems: items,
      committedSessionItems: items.map((it, idx) => cloneShotItem(it, idx)),
      currentShotIndex: 0,
      isEditingItem: false,
      activeEditItemDraft: null,
    });
    return metadata;
  },

  setSessionMode: (mode: StaticPackSessionMode) => {
    set({ sessionMode: mode });
    get().runtimeHandlers.onSessionModeChanged?.(mode);
  },

  setCurrentShotIndex: (index: number) => {
    const items = get().activePack?.items || get().activeItems || [];
    if (items.length === 0) return;
    const wrapped = ((index % items.length) + items.length) % items.length;
    set({
      currentShotIndex: wrapped,
      remainingTimeoutSec: items[wrapped]?.timeoutSeconds ?? 10,
    });
    const h = get().runtimeHandlers;
    h.onShotChanged?.(wrapped);
    h.onLoadShotInArena?.(wrapped);
  },

  nextShot: () => {
    const items = get().activePack?.items || get().activeItems || [];
    if (items.length === 0) return;
    const nextIdx = (get().currentShotIndex + 1) % items.length;
    get().setCurrentShotIndex(nextIdx);
  },

  prevShot: () => {
    const items = get().activePack?.items || get().activeItems || [];
    if (items.length === 0) return;
    const prevIdx = (get().currentShotIndex - 1 + items.length) % items.length;
    get().setCurrentShotIndex(prevIdx);
  },

  resetCurrentShot: () => {
    const h = get().runtimeHandlers;
    h.onResetShotRequested?.();
    h.onResetCurrentShot?.();
  },

  addNewShot: async () => {
    const wasEditingItem = get().isEditingItem;
    if (wasEditingItem && get().isCurrentShotDirty()) {
      await get().saveCurrentShotToEditWorkspace();
    }
    const { activePack, activeItems } = get();
    if (!activePack || activeItems.length >= MAX_SHOTS_PER_PACK) return;
    const newIndex = activeItems.length;
    const newShot = createDefaultShotItem(newIndex);
    const nextItems = [...activeItems, newShot];
    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: nextItems.length,
      updatedAt: Date.now(),
    };
    await saveEditWorkspacePackFull(updatedMeta, nextItems);
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    if (wasEditingItem) {
      const draft = cloneShotItem(newShot, newIndex);
      activeEditItemVariable = cloneShotItem(draft, newIndex);
      set((s) => ({
        activePack: bundle,
        activeItems: nextItems,
        currentShotIndex: newIndex,
        activeEditItemDraft: draft,
        editVarVersion: s.editVarVersion + 1,
      }));
      const h = get().runtimeHandlers;
      h.onShotChanged?.(newIndex);
      h.onEditVariableMutated?.(draft);
      h.onSyncEditDraftToArena?.(draft);
    } else {
      set({
        activePack: bundle,
        activeItems: nextItems,
        currentShotIndex: newIndex,
      });
      get().runtimeHandlers.onShotChanged?.(newIndex);
    }
  },

  duplicateShot: async (index: number) => {
    if (get().isEditingItem && get().isCurrentShotDirty()) {
      await get().saveCurrentShotToEditWorkspace();
    }
    const { activePack, activeItems } = get();
    if (
      !activePack ||
      index < 0 ||
      index >= activeItems.length ||
      activeItems.length >= MAX_SHOTS_PER_PACK
    ) {
      return;
    }
    const source = activeItems[index];
    const duplicated = cloneShotItem(source, index + 1);
    duplicated.id = generateUUID();
    duplicated.name = `${source.name || `Shot ${index + 1}`} (Copy)`;
    const nextItems = [
      ...activeItems.slice(0, index + 1),
      duplicated,
      ...activeItems.slice(index + 1),
    ].map((it, idx) => ({ ...it, index: idx }));

    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: nextItems.length,
      updatedAt: Date.now(),
    };
    await saveEditWorkspacePackFull(updatedMeta, nextItems);
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    set({
      activePack: bundle,
      activeItems: nextItems,
      currentShotIndex: index + 1,
    });
    get().runtimeHandlers.onShotChanged?.(index + 1);
  },

  deleteShot: async (index: number) => {
    if (get().isEditingItem && get().isCurrentShotDirty()) {
      await get().saveCurrentShotToEditWorkspace();
    }
    const { activePack, activeItems, currentShotIndex } = get();
    if (!activePack || activeItems.length <= 1) return;
    const nextItems = activeItems
      .filter((_, idx) => idx !== index)
      .map((it, idx) => ({ ...it, index: idx }));
    const nextIdx = Math.max(
      0,
      Math.min(nextItems.length - 1, currentShotIndex >= index ? currentShotIndex - 1 : currentShotIndex)
    );

    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: nextItems.length,
      updatedAt: Date.now(),
    };
    await saveEditWorkspacePackFull(updatedMeta, nextItems);
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    activeEditItemVariable = null;
    set({
      activePack: bundle,
      activeItems: nextItems,
      currentShotIndex: nextIdx,
      isEditingItem: false,
      activeEditItemDraft: null,
    });
    get().runtimeHandlers.onShotChanged?.(nextIdx);
  },

  reorderShot: async (fromIndex: number, toIndex: number) => {
    if (get().isEditingItem && get().isCurrentShotDirty()) {
      await get().saveCurrentShotToEditWorkspace();
    }
    const { activePack, activeItems } = get();
    if (
      !activePack ||
      fromIndex < 0 ||
      fromIndex >= activeItems.length ||
      toIndex < 0 ||
      toIndex >= activeItems.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const copy = [...activeItems];
    const [moved] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, moved);
    const nextItems = copy.map((it, idx) => ({ ...it, index: idx }));

    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: nextItems.length,
      updatedAt: Date.now(),
    };
    await saveEditWorkspacePackFull(updatedMeta, nextItems);
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    set({
      activePack: bundle,
      activeItems: nextItems,
      currentShotIndex: toIndex,
    });
    get().runtimeHandlers.onShotChanged?.(toIndex);
  },

  enterItemEditMode: (index?: number) => {
    // If switching from another shot that has unsaved in-memory edits, flush it to the Edit-Mode IndexedDB first
    if (get().isEditingItem && get().isCurrentShotDirty()) {
      void get().saveCurrentShotToEditWorkspace();
    }
    const items = get().activePack?.items || get().activeItems || [];
    const targetIdx = typeof index === 'number' ? index : get().currentShotIndex;
    const targetItem = items[targetIdx];
    if (!targetItem) return;

    const draft = cloneShotItem(targetItem, targetIdx);
    activeEditItemVariable = cloneShotItem(draft, targetIdx);

    const nextSubMode =
      draft.car.speedFollowsHeading !== false && get().editSubMode === 'car-speed'
        ? 'car-heading'
        : get().editSubMode;

    set((s) => ({
      sessionMode: 'edit',
      currentShotIndex: targetIdx,
      isEditingItem: true,
      activeEditItemDraft: draft,
      editSubMode: nextSubMode,
      editVarVersion: s.editVarVersion + 1,
    }));

    const h = get().runtimeHandlers;
    h.onShotChanged?.(targetIdx);
    h.onEditVariableMutated?.(draft);
    h.onSyncEditDraftToArena?.(draft);
  },

  exitItemEditModeAndSave: async () => {
    await get().saveCurrentShotToEditWorkspace();
    activeEditItemVariable = null;
    set((s) => ({
      isEditingItem: false,
      activeEditItemDraft: null,
      editVarVersion: s.editVarVersion + 1,
    }));
  },

  exportSingleShotJson: (index?: number) => {
    const { activePack, activeItems, currentShotIndex, isEditingItem } = get();
    const targetItem =
      isEditingItem && activeEditItemVariable && index === undefined
        ? activeEditItemVariable
        : activeItems[typeof index === 'number' ? index : currentShotIndex];
    if (!targetItem) return null;
    return exportSingleShotItemToJson(targetItem, activePack?.title || 'StaticPack');
  },

  importSingleShotJson: async (file: File, index?: number) => {
    const { activePack, activeItems, currentShotIndex, isEditingItem } = get();
    const targetIdx = typeof index === 'number' ? index : currentShotIndex;
    const parsedItem = await parseSingleShotItemFromJsonFile(file, targetIdx);

    if (isEditingItem && targetIdx === currentShotIndex) {
      activeEditItemVariable = cloneShotItem(parsedItem, targetIdx);
      set((s) => ({
        activeEditItemDraft: cloneShotItem(parsedItem, targetIdx),
        editVarVersion: s.editVarVersion + 1,
      }));
      const h = get().runtimeHandlers;
      h.onEditVariableMutated?.(parsedItem);
      h.onSyncEditDraftToArena?.(parsedItem);
      return;
    }

    if (!activePack) return;
    const nextItems = activeItems.map((it, i) => (i === targetIdx ? parsedItem : it));
    await saveSingleEditWorkspaceShotItem(activePack.uuid, targetIdx, parsedItem, activePack.metadata);
    const bundle = buildActivePackBundle(activePack.metadata, nextItems);
    set({ activePack: bundle, activeItems: nextItems, currentShotIndex: targetIdx });
    get().runtimeHandlers.onShotChanged?.(targetIdx);
  },

  setEditSubMode: (subMode: EditSubMode) => {
    set({ editSubMode: subMode });
    get().runtimeHandlers.onEditSubModeChanged?.(subMode);
  },

  cycleEditSubMode: (delta: 1 | -1) => {
    const cur = get().editSubMode;
    const currentItem =
      activeEditItemVariable ||
      get().activeEditItemDraft ||
      get().activePack?.items?.[get().currentShotIndex] ||
      get().activeItems?.[get().currentShotIndex];
    const alignsSpeedWithNose = currentItem?.car?.speedFollowsHeading !== false;
    const order: EditSubMode[] = alignsSpeedWithNose
      ? ['car-heading', 'ball-speed', 'free-cam']
      : EDIT_SUB_MODES_ORDER;
    const curIdx = order.indexOf(cur);
    const baseIdx = curIdx >= 0 ? curIdx : 0;
    const nextIdx = ((baseIdx + delta) % order.length + order.length) % order.length;
    const nextMode = order[nextIdx];
    set({ editSubMode: nextMode });
    get().runtimeHandlers.onEditSubModeChanged?.(nextMode);
    return nextMode;
  },

  setDownCounterEnabled: (enabled: boolean) => {
    set({ downCounterEnabled: Boolean(enabled) });
    if (get().sessionMode === 'play') {
      get().resetCurrentShot();
    }
  },

  setDownCounterValue: (val: StaticPackDownCounterOption) => {
    const clamped = (val === 1 || val === 2 || val === 3 ? val : 1) as StaticPackDownCounterOption;
    set({ downCounterValue: clamped, downCounterSeconds: clamped });
    if (get().sessionMode === 'play' && get().downCounterEnabled) {
      get().resetCurrentShot();
    }
  },

  setFreeCamTrajectoryTesting: (active: boolean) => {
    set({ isFreeCamTrajectoryTesting: Boolean(active) });
  },

  setTestingSingleShot: (active: boolean) => {
    set({ isTestingSingleShot: Boolean(active) });
  },

  updateLiveTelemetry: (patch) => {
    set((s) => ({ ...s, ...patch }));
  },

  setRuntimeHandlers: (handlers) => {
    set((s) => ({
      runtimeHandlers: { ...s.runtimeHandlers, ...handlers },
    }));
  },
}));
