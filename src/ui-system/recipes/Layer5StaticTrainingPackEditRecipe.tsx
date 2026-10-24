import React, { useState, useRef } from 'react';
import { Info, LogOut } from 'lucide-react';
import { PanelContainer, PanelHeader, PanelContent, PanelFooter } from '../layout/Panel';
import { KeycapBadge } from '../primitives/KeycapBadge';
import { CollapsibleNumberedRailList } from '../primitives/CollapsibleNumberedRailList';
import { dialogue } from '../primitives/dialogue/dialogueStore';
import {
  useStaticTrainingPackStore,
  getActiveEditItemVariable,
  mutateActiveEditItemVariable,
  MAX_SHOTS_PER_PACK,
  type EditSubMode,
  type StaticTrainingShotItem,
} from '../../stores/staticTrainingPackStore';
import { StaticTrainingShotInspectorView } from './static-training/StaticTrainingShotInspectorView';

export const formatShotSubtitle = (shot: StaticTrainingShotItem): string => {
  const boostText = shot.car.unlimitedBoost
    ? 'Boost INF'
    : `Boost ${Math.round(shot.car.initialBoost)}%`;
  const groundText = shot.car.snapToGround
    ? 'Ground'
    : shot.car.hasFlip !== false
    ? 'Air (Has Flip)'
    : 'Air (No Flip)';
  const ballText = shot.ball.kickoffState
    ? 'Ball Freeze'
    : `Ball ${Math.round(shot.ball.speed)} UU/s`;
  return `Time Limit ${shot.timeoutSeconds}s • ${boostText} • ${groundText} • ${ballText}`;
};

export function promptExitStaticTrainingEditSession(
  onExitConfirmed?: (action: 'save' | 'ignore') => void | Promise<void>
): void {
  dialogue.show({
    id: 'static-training-exit-edit-confirm',
    title: 'EXIT EDIT MODE',
    tone: 'warning',
    icon: 'triangle-alert',
    maxWidth: 500,
    content: 'Do you want to save your previous edits before exiting Edit Mode?',
    buttons: [
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          await useStaticTrainingPackStore.getState().commitEditSessionToMainDb();
          await onExitConfirmed?.('save');
        },
      },
      {
        label: 'Ignore',
        variant: 'danger',
        onClick: async () => {
          await useStaticTrainingPackStore.getState().discardEditSessionChanges();
          await onExitConfirmed?.('ignore');
        },
      },
      {
        label: 'Cancel',
        variant: 'outline',
      },
    ],
  });
}

export interface Layer5StaticTrainingPackEditRecipeProps {
  isLight?: boolean;
  transparent?: boolean;
  packTitle?: string;
  /** Controlled or store-backed shots list */
  shots?: StaticTrainingShotItem[];
  onShotsChange?: (shots: StaticTrainingShotItem[]) => void;
  /** Controlled or store-backed selected shot index */
  selectedShotIndex?: number;
  onSelectedShotIndexChange?: (idx: number) => void;
  /** Controlled or store-backed item inspection state (false = full list, true = compressed rail + detail inspector) */
  isInspectingShot?: boolean;
  onInspectingShotChange?: (inspecting: boolean) => void;
  /** Controlled or store-backed 3D edit sub-mode */
  editSubMode?: EditSubMode;
  onEditSubModeChange?: (mode: EditSubMode) => void;
  /** Callback when user clicks Collapse [TAB] in header */
  onCollapseDrawer?: () => void;
  /** Callback when user confirms Exit in the double-check dialogue */
  onExitSession?: (action: 'save' | 'ignore') => void | Promise<void>;
}

/**
 * [L6 Recipe] Layer5StaticTrainingPackEditRecipe
 *
 * Specialized inner content recipe for Static Training Pack Edit Mode (Six Echo / 6E):
 * - Header Left: Permanently mounted Back button (`onBack`) — disabled in List state, enabled when inspecting a shot to return to the full Shot List state.
 * - Header Right: Collapse `[TAB]` button + `Exit` button that spawns a double-check confirmation Dialogue (`Save / Ignore / Cancel`).
 * - Body: `CollapsibleNumberedRailList` — clicking a shot compresses the list from right to left into a narrow `#01..#99` rail,
 *   morphs the 4 top action buttons into compact `+` (black) and `?` (orange) icons, and slides in `StaticTrainingShotInspectorView`.
 * - Footer: Displays live hover descriptions from any option or control in the list or detail inspector.
 */
export const Layer5StaticTrainingPackEditRecipe: React.FC<
  Layer5StaticTrainingPackEditRecipeProps
> = ({
  isLight = false,
  transparent = true,
  packTitle,
  shots: controlledShots,
  onShotsChange,
  selectedShotIndex: controlledIndex,
  onSelectedShotIndexChange,
  isInspectingShot: controlledInspecting,
  onInspectingShotChange,
  editSubMode: controlledSubMode,
  onEditSubModeChange,
  onCollapseDrawer,
  onExitSession,
}) => {
  const activePack = useStaticTrainingPackStore((s) => s.activePack);
  const storeShotIndex = useStaticTrainingPackStore((s) => s.currentShotIndex);
  const storeIsEditingItem = useStaticTrainingPackStore((s) => s.isEditingItem);
  const storeEditSubMode = useStaticTrainingPackStore((s) => s.editSubMode);
  const editVarVersion = useStaticTrainingPackStore((s) => s.editVarVersion);

  const enterItemEditMode = useStaticTrainingPackStore((s) => s.enterItemEditMode);
  const deselectEditShot = useStaticTrainingPackStore((s) => s.deselectEditShot);
  const setStoreEditSubMode = useStaticTrainingPackStore((s) => s.setEditSubMode);
  const addNewShot = useStaticTrainingPackStore((s) => s.addNewShot);
  const duplicateShot = useStaticTrainingPackStore((s) => s.duplicateShot);
  const deleteShot = useStaticTrainingPackStore((s) => s.deleteShot);
  const reorderShot = useStaticTrainingPackStore((s) => s.reorderShot);
  const exportSingleShotJson = useStaticTrainingPackStore((s) => s.exportSingleShotJson);
  const importSingleShotJson = useStaticTrainingPackStore((s) => s.importSingleShotJson);
  const isCurrentShotDirty = useStaticTrainingPackStore((s) => s.isCurrentShotDirty);
  const saveCurrentShotToEditWorkspace = useStaticTrainingPackStore(
    (s) => s.saveCurrentShotToEditWorkspace
  );

  // Subscribe to editVarVersion so fast in-memory variable mutations re-render sliders smoothly
  void editVarVersion;

  const [hoveredDesc, setHoveredDesc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const items = controlledShots ?? activePack?.items ?? [];
  const selectedIndex = controlledIndex ?? storeShotIndex;
  const isInspecting = controlledInspecting ?? storeIsEditingItem;
  const editSubMode = controlledSubMode ?? storeEditSubMode;
  const resolvedPackTitle = packTitle ?? activePack?.metadata.title ?? 'PACK';

  const safeIndex = Math.max(0, Math.min(Math.max(0, items.length - 1), selectedIndex));
  const currentShot =
    (isInspecting && !controlledShots && getActiveEditItemVariable()) ||
    items[safeIndex] ||
    items[0] ||
    null;

  const isDirty = isCurrentShotDirty();

  const handleSelectShot = (idx: number) => {
    if (onSelectedShotIndexChange) onSelectedShotIndexChange(idx);
    if (onInspectingShotChange) onInspectingShotChange(true);
    if (!controlledShots) {
      enterItemEditMode(idx);
    }
  };

  const handleBackToShotList = async () => {
    if (onInspectingShotChange) onInspectingShotChange(false);
    if (!controlledShots) {
      await deselectEditShot();
    }
    setHoveredDesc('Returned to full Shot List view.');
  };

  const handleChangeSubMode = (mode: EditSubMode) => {
    if (onEditSubModeChange) onEditSubModeChange(mode);
    else setStoreEditSubMode(mode);
  };

  const handleMutateCurrentShot = (updater: (draft: StaticTrainingShotItem) => void) => {
    if (onShotsChange && currentShot) {
      const cloned: StaticTrainingShotItem = {
        ...currentShot,
        car: {
          ...currentShot.car,
          location: [...currentShot.car.location] as [number, number, number],
        },
        ball: {
          ...currentShot.ball,
          location: [...currentShot.ball.location] as [number, number, number],
          angularVelocity: [...currentShot.ball.angularVelocity] as [number, number, number],
        },
      };
      updater(cloned);
      onShotsChange(items.map((it, idx) => (idx === safeIndex ? cloned : it)));
      return;
    }
    mutateActiveEditItemVariable(updater);
  };

  const handleAddNewShot = async () => {
    if (items.length >= MAX_SHOTS_PER_PACK) return;
    const newIdx = items.length;
    await addNewShot();
    setHoveredDesc(`Created #${String(newIdx + 1).padStart(2, '0')} (Shot ${newIdx + 1}).`);
  };

  const handleDuplicateShot = async (idx: number) => {
    if (items.length >= MAX_SHOTS_PER_PACK) return;
    await duplicateShot(idx);
    setHoveredDesc(
      `Duplicated #${String(idx + 1).padStart(2, '0')} -> #${String(idx + 2).padStart(2, '0')}.`
    );
  };

  const handleReorderShot = async (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= items.length || fromIdx === toIdx) return;
    await reorderShot(fromIdx, toIdx);
  };

  const handleDeleteShot = async (idx: number) => {
    if (items.length <= 1) return;
    await deleteShot(idx);
    setHoveredDesc(`Deleted shot #${String(idx + 1).padStart(2, '0')}.`);
  };

  const handleExportSingleShot = (idx: number) => {
    const target = items[idx];
    if (!target) return;
    exportSingleShotJson(idx);
    setHoveredDesc(`Exported #${String(idx + 1).padStart(2, '0')} (${target.name}).json`);
  };

  const handleImportSingleShot = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importSingleShotJson(file);
      setHoveredDesc(`Imported shot configuration from ${file.name}.`);
    } catch (err: any) {
      setHoveredDesc(`Failed to import shot JSON: ${err?.message || 'Invalid JSON'}`);
    } finally {
      e.target.value = '';
    }
  };

  const handleShowHelp = () => {
    dialogue.show({
      id: 'static-training-editor-help',
      title: 'HELP',
      tone: 'info',
      icon: 'circle-help',
      maxWidth: 620,
      content: (
        <div className="flex flex-col gap-2.5 text-left text-xs leading-relaxed">
          <div className="font-semibold text-amber-500">
            Static Training Pack 3D Editor Controls &amp; Shortcuts
          </div>
          <div className="grid grid-cols-1 gap-1.5 font-mono text-[11px]">
            <div>
              <span className="font-bold text-sky-500">[TAB]</span> : Collapse / Expand Edge Inspector Drawer to manipulate the 3D scene directly.
            </div>
            <div>
              <span className="font-bold text-sky-500">[9] / [0] or Right-Click</span> : Cycle between the Edit Sub-Modes (Car Heading, Car Speed, Ball Speed, Free Camera).
            </div>
            <div>
              <span className="font-bold text-sky-500">[W / A / S / D]</span> : Move the active target horizontally (Car in Car modes, Ball in Ball mode, Camera in Free Cam).
            </div>
            <div>
              <span className="font-bold text-sky-500">[Space] / [V]</span> : Move Up / Move Down. Pressing [V] at ground level snaps the car to ground (60-frame suspension settle).
            </div>
            <div>
              <span className="font-bold text-sky-500">[Mouse Drag]</span> : Aim 3D direction (Car Nose Heading + Pitch, Car Velocity Yaw + Pitch, Ball Velocity Yaw + Pitch, or Free Cam Look).
            </div>
            <div>
              <span className="font-bold text-sky-500">[Q] / [E]</span> : Adjust Car Air Roll angle in Car Heading mode.
            </div>
            <div>
              <span className="font-bold text-sky-500">[O] / [P]</span> : Decrease / Increase Car Boost amount (press [P] at 100 to enable Unlimited Boost INF).
            </div>
            <div>
              <span className="font-bold text-sky-500">[[] / []]</span> : Decrease / Increase launch speed. Pressing [[] at 0 Ball Speed toggles Kickoff Freeze.
            </div>
            <div>
              <span className="font-bold text-sky-500">[F]</span> : Switch relative ball camera horizontal lateral offset side (flips between right +offset and left -offset).
            </div>
            <div>
              <span className="font-bold text-emerald-500">[T]</span> : Toggle trajectory preview test in any Edit sub-mode (launches Car &amp; Ball while keeping the camera at its unlaunched viewpoint).
            </div>
            <div>
              <span className="font-bold text-emerald-500">[G]</span> : Test Single Shot in playable 3D arena (press [G] again to return to editor).
            </div>
          </div>
        </div>
      ),
      buttons: [
        {
          label: 'Got It',
          variant: 'primary',
        },
      ],
    });
  };

  const handleExitClick = () => {
    promptExitStaticTrainingEditSession(onExitSession);
  };

  const railItems = items.map((shot, idx) => {
    const effectiveShot = idx === safeIndex && currentShot ? currentShot : shot;
    return {
      id: effectiveShot.id || String(idx),
      index: idx,
      title: effectiveShot.name,
      subtitle: formatShotSubtitle(effectiveShot),
    };
  });

  return (
    <PanelContainer
      isLight={isLight}
      transparent={transparent}
      className="w-full h-full"
    >
      {/* Top Header: Left = Permanently mounted Back button (disabled in List state, enabled when inspecting a shot), Right = Collapse [TAB] + Exit */}
      <PanelHeader
        title={
          isInspecting
            ? `EDIT SHOT #${String(safeIndex + 1).padStart(2, '0')}`
            : `EDIT: ${resolvedPackTitle}`
        }
        onBack={() => void handleBackToShotList()}
        backDisabled={!isInspecting}
        isLight={isLight}
        rightElement={
          <div className="flex items-center gap-1.5">
            {onCollapseDrawer && (
              <button
                type="button"
                onClick={onCollapseDrawer}
                onMouseEnter={() =>
                  setHoveredDesc(
                    'Press TAB or click to collapse Edge Inspector Drawer to the side pill without darkening the 3D arena.'
                  )
                }
                onMouseLeave={() => setHoveredDesc(null)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-all cursor-pointer select-none active:scale-95 ${
                  isLight
                    ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800 shadow-2xs'
                    : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200 shadow-2xs'
                }`}
              >
                <span
                  className={`text-[11px] font-sans font-medium ${
                    isLight ? 'text-neutral-700' : 'text-neutral-300'
                  }`}
                >
                  Collapse
                </span>
                <KeycapBadge shortcut="TAB" size="sm" isLight={isLight} />
              </button>
            )}

            <button
              type="button"
              onClick={handleExitClick}
              onMouseEnter={() =>
                setHoveredDesc(
                  'Exit Edit Mode (prompts double-check Save / Ignore / Cancel confirmation dialogue).'
                )
              }
              onMouseLeave={() => setHoveredDesc(null)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-all cursor-pointer select-none active:scale-95 ${
                isLight
                  ? 'bg-rose-50 hover:bg-rose-100 border-rose-200 text-rose-700'
                  : 'bg-rose-950/40 hover:bg-rose-900/50 border-rose-800/70 text-rose-300'
              }`}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Exit</span>
            </button>
          </div>
        }
      />

      <PanelContent
        scrollable={false}
        className="!p-3 flex flex-col gap-2.5 h-full min-h-0 overflow-hidden"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleImportSingleShot}
          className="hidden"
        />

        <CollapsibleNumberedRailList
          isCollapsedToRail={isInspecting}
          items={railItems}
          selectedIndex={safeIndex}
          maxItems={MAX_SHOTS_PER_PACK}
          collapsedRailWidth={60}
          isLight={isLight}
          onSelectItem={handleSelectShot}
          onAddNew={() => void handleAddNewShot()}
          onImport={() => fileInputRef.current?.click()}
          onShowHelp={handleShowHelp}
          onDuplicate={(idx) => void handleDuplicateShot(idx)}
          onReorder={(fromIdx, toIdx) => void handleReorderShot(fromIdx, toIdx)}
          onExportItem={handleExportSingleShot}
          onDeleteItem={(idx) => void handleDeleteShot(idx)}
          onHoverDescription={setHoveredDesc}
          detailContent={
            currentShot ? (
              <StaticTrainingShotInspectorView
                isLight={isLight}
                currentShot={currentShot}
                editSubMode={editSubMode}
                isDirty={isDirty}
                onChangeSubMode={handleChangeSubMode}
                onMutateShot={handleMutateCurrentShot}
                onSaveShot={saveCurrentShotToEditWorkspace}
                onHoverDesc={setHoveredDesc}
              />
            ) : null
          }
        />
      </PanelContent>

      <PanelFooter isLight={isLight} className="!px-4 !py-2.5">
        <div className="flex items-center gap-2 w-full text-xs truncate">
          <Info className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span
            className={`truncate transition-colors duration-150 ${
              hoveredDesc
                ? isLight
                  ? 'text-neutral-900 font-medium'
                  : 'text-neutral-100 font-medium'
                : isLight
                ? 'text-neutral-500'
                : 'text-neutral-400'
            }`}
          >
            {hoveredDesc ||
              'Hover any option to inspect its detail. [TAB] Collapse Drawer · 9/0 Cycle Sub-Mode · V Snap Ground.'}
          </span>
        </div>
      </PanelFooter>
    </PanelContainer>
  );
};
