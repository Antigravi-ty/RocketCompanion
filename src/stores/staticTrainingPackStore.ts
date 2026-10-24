import { create } from 'zustand';
import {
  type StaticTrainingPackMetadata,
  type StaticTrainingShotItem,
  type EditSubMode,
  EDIT_SUB_MODES_ORDER,
  generateUUID,
  createDefaultShotItem,
  cloneShotItem,
  listStaticTrainingPacks,
  loadStaticTrainingPackByUuid,
  saveStaticTrainingPackFull,
  saveSingleStaticTrainingShotItem,
  deleteStaticTrainingPackByUuid,
  exportStaticTrainingPackRCSPack,
  importStaticTrainingPackFromFile,
  exportSingleShotItemToJson,
  parseSingleShotItemFromJsonFile,
} from '../training/StaticTrainingPackStorage';

export type { StaticTrainingPackMetadata, StaticTrainingShotItem, EditSubMode };
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
 * Mutated directly at 60-120Hz during keyboard/mouse manipulation and only persisted
 * to IndexedDB upon exiting Item Edit Mode.
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
  useStaticTrainingPackStore.setState((s) => ({
    editVarVersion: s.editVarVersion + 1,
    activeEditItemDraft: activeEditItemVariable,
  }));
  const handlers = store.runtimeHandlers;
  (handlers.onEditVariableMutated ?? handlers.onSyncEditDraftToArena)?.(activeEditItemVariable);
  return activeEditItemVariable;
}

function createGuardedRuntimeHandlers<T extends object>(storeTag: string, rawHandlers: T): T {
  return new Proxy(rawHandlers, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === 'function') {
        return val;
      }
      if (typeof prop === 'string' && prop.startsWith('on')) {
        return (..._args: unknown[]) => {
          console.warn(
            `[${storeTag}] Runtime handler "${prop}" was invoked before StaticTrainingPackMode registered its handlers.`
          );
        };
      }
      return val;
    },
  });
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
  currentShotIndex: number;

  // Item Edit state (in-memory draft variable, committed to IndexedDB on exit)
  isEditingItem: boolean;
  activeEditItemDraft: StaticTrainingShotItem | null;
  editSubMode: EditSubMode;
  editVarVersion: number;

  // Play Down Counter (defaults: disabled = false, value = 1 -> 2s hold + beep at 1s + GO at 0s)
  downCounterEnabled: boolean;
  downCounterValue: StaticPackDownCounterOption;
  downCounterSeconds: StaticPackDownCounterOption;

  // Live Play Telemetry
  remainingTimeoutSec: number;
  activeCountdownSec: number;
  isShotLaunched: boolean;
  isOvertimeWaitGround: boolean;
  isReplayActive: boolean;
  replayType: 'goal' | 'expire' | null;

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

  // Session Mode & Shot Navigation
  setSessionMode: (mode: StaticPackSessionMode) => void;
  setCurrentShotIndex: (index: number) => void;
  nextShot: () => void;
  prevShot: () => void;
  resetCurrentShot: () => void;

  // Shot List Management
  addNewShot: () => Promise<void>;
  duplicateShot: (index: number) => Promise<void>;
  deleteShot: (index: number) => Promise<void>;
  reorderShot: (fromIndex: number, toIndex: number) => Promise<void>;

  // Item Edit Mode (fast in-memory variable -> IndexedDB on exit)
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
  updateLiveTelemetry: (
    patch: Partial<{
      remainingTimeoutSec: number;
      activeCountdownSec: number;
      isShotLaunched: boolean;
      isOvertimeWaitGround: boolean;
      isReplayActive: boolean;
      replayType: 'goal' | 'expire' | null;
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

  runtimeHandlers: createGuardedRuntimeHandlers<StaticTrainingPackRuntimeHandlers>(
    'staticTrainingPackStore',
    {}
  ),

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
      });
    } catch (err) {
      console.error('[staticTrainingPackStore] Failed to init packs:', err);
      set({ isLoading: false, initialized: true });
    }
  },

  selectPack: async (uuid: string) => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
    }
    const loaded = await loadStaticTrainingPackByUuid(uuid);
    const bundle = buildActivePackBundle(loaded.metadata, loaded.items);
    activeEditItemVariable = null;
    set({
      selectedPackUuid: uuid,
      activePack: bundle,
      activeItems: loaded.items,
      currentShotIndex: 0,
      isEditingItem: false,
      activeEditItemDraft: null,
    });
  },

  createPack: async (title: string, description: string) => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
    }
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
      currentShotIndex: 0,
    });
  },

  exportPackRCS: async (uuid?: string) => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
    }
    const targetUuid = uuid || get().activePack?.uuid || get().selectedPackUuid;
    if (!targetUuid) return null;
    const loaded = await loadStaticTrainingPackByUuid(targetUuid);
    if (!loaded.metadata) return null;
    return await exportStaticTrainingPackRCSPack(loaded.metadata, loaded.items);
  },

  importPackRCS: async (file: File) => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
    }
    const { metadata, items } = await importStaticTrainingPackFromFile(file);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(metadata, items);
    activeEditItemVariable = null;
    set({
      packs,
      selectedPackUuid: metadata.uuid,
      activePack: bundle,
      activeItems: items,
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
    (h.onShotChanged ?? h.onLoadShotInArena)?.(wrapped);
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
    (h.onResetShotRequested ?? h.onResetCurrentShot)?.();
  },

  addNewShot: async () => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
    }
    const { activePack, activeItems } = get();
    if (!activePack) return;
    const newIndex = activeItems.length;
    const newShot = createDefaultShotItem(newIndex);
    const nextItems = [...activeItems, newShot];
    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: nextItems.length,
      updatedAt: Date.now(),
    };
    await saveStaticTrainingPackFull(updatedMeta, nextItems);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    set({
      packs,
      activePack: bundle,
      activeItems: nextItems,
      currentShotIndex: newIndex,
    });
    get().enterItemEditMode(newIndex);
    get().runtimeHandlers.onShotChanged?.(newIndex);
  },

  duplicateShot: async (index: number) => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
    }
    const { activePack, activeItems } = get();
    if (!activePack || index < 0 || index >= activeItems.length) return;
    const source = activeItems[index];
    const duplicated = cloneShotItem(source, index + 1);
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
    await saveStaticTrainingPackFull(updatedMeta, nextItems);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    set({
      packs,
      activePack: bundle,
      activeItems: nextItems,
      currentShotIndex: index + 1,
    });
    get().enterItemEditMode(index + 1);
    get().runtimeHandlers.onShotChanged?.(index + 1);
  },

  deleteShot: async (index: number) => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
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
    await saveStaticTrainingPackFull(updatedMeta, nextItems);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    set({
      packs,
      activePack: bundle,
      activeItems: nextItems,
      currentShotIndex: nextIdx,
    });
    get().enterItemEditMode(nextIdx);
    get().runtimeHandlers.onShotChanged?.(nextIdx);
  },

  reorderShot: async (fromIndex: number, toIndex: number) => {
    if (get().isEditingItem) {
      await get().exitItemEditModeAndSave();
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
    await saveStaticTrainingPackFull(updatedMeta, nextItems);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(updatedMeta, nextItems);
    set({
      packs,
      activePack: bundle,
      activeItems: nextItems,
      currentShotIndex: toIndex,
    });
    get().enterItemEditMode(toIndex);
    get().runtimeHandlers.onShotChanged?.(toIndex);
  },

  enterItemEditMode: (index?: number) => {
    const items = get().activePack?.items || get().activeItems || [];
    const targetIdx = typeof index === 'number' ? index : get().currentShotIndex;
    const targetItem = items[targetIdx];
    if (!targetItem) return;

    const draft = cloneShotItem(targetItem, targetIdx);
    activeEditItemVariable = draft;

    set((s) => ({
      sessionMode: 'edit',
      currentShotIndex: targetIdx,
      isEditingItem: true,
      activeEditItemDraft: draft,
      editVarVersion: s.editVarVersion + 1,
    }));

    const h = get().runtimeHandlers;
    (h.onEditVariableMutated ?? h.onSyncEditDraftToArena)?.(draft);
  },

  exitItemEditModeAndSave: async () => {
    const { activePack, activeItems, currentShotIndex, isEditingItem } = get();
    const draft = activeEditItemVariable || get().activeEditItemDraft;
    if (!isEditingItem || !activePack || !draft) {
      activeEditItemVariable = null;
      set({ isEditingItem: false, activeEditItemDraft: null });
      return;
    }

    const idx = Math.max(0, Math.min(activeItems.length - 1, draft.index ?? currentShotIndex));
    const committedItem = cloneShotItem(draft, idx);
    const nextItems = activeItems.map((it, i) => (i === idx ? committedItem : it));
    const updatedMeta: StaticTrainingPackMetadata = {
      ...activePack.metadata,
      itemCount: nextItems.length,
      updatedAt: Date.now(),
    };

    // Persist to IndexedDB VFS only upon exiting Item Edit Mode
    await saveSingleStaticTrainingShotItem(activePack.uuid, idx, committedItem, updatedMeta);
    const packs = await listStaticTrainingPacks();
    const bundle = buildActivePackBundle(updatedMeta, nextItems);

    activeEditItemVariable = null;
    set((s) => ({
      packs,
      activePack: bundle,
      activeItems: nextItems,
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

    if (isEditingItem) {
      activeEditItemVariable = parsedItem;
      set((s) => ({
        activeEditItemDraft: parsedItem,
        editVarVersion: s.editVarVersion + 1,
      }));
      const h = get().runtimeHandlers;
      (h.onEditVariableMutated ?? h.onSyncEditDraftToArena)?.(parsedItem);
      return;
    }

    if (!activePack) return;
    const nextItems = activeItems.map((it, i) => (i === targetIdx ? parsedItem : it));
    await saveSingleStaticTrainingShotItem(activePack.uuid, targetIdx, parsedItem, activePack.metadata);
    const bundle = buildActivePackBundle(activePack.metadata, nextItems);
    set({ activePack: bundle, activeItems: nextItems });
    get().runtimeHandlers.onShotChanged?.(targetIdx);
  },

  setEditSubMode: (subMode: EditSubMode) => {
    set({ editSubMode: subMode });
    get().runtimeHandlers.onEditSubModeChanged?.(subMode);
  },

  cycleEditSubMode: (delta: 1 | -1) => {
    const cur = get().editSubMode;
    const idx = EDIT_SUB_MODES_ORDER.indexOf(cur);
    const nextIdx =
      ((idx + delta) % EDIT_SUB_MODES_ORDER.length + EDIT_SUB_MODES_ORDER.length) %
      EDIT_SUB_MODES_ORDER.length;
    const nextMode = EDIT_SUB_MODES_ORDER[nextIdx];
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

  updateLiveTelemetry: (patch) => {
    set((s) => ({ ...s, ...patch }));
  },

  setRuntimeHandlers: (handlers) => {
    set((s) => ({
      runtimeHandlers: createGuardedRuntimeHandlers<StaticTrainingPackRuntimeHandlers>(
        'staticTrainingPackStore',
        { ...s.runtimeHandlers, ...handlers }
      ),
    }));
  },
}));
