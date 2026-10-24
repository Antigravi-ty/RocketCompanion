import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pencil,
  Trash2,
  Plus,
  Download,
  Upload,
  Info,
  Target,
  Check,
  X,
  FolderOpen,
} from 'lucide-react';
import { PanelContainer, PanelHeader, PanelContent, PanelFooter } from '../layout/Panel';
import { Badge } from '../primitives/Badge';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { SegmentedSwitch } from '../primitives/SegmentedSwitch';
import { DEFAULT_PANEL_SIZING, UI_RADIUS } from '../tokens';
import { useStaticTrainingPackStore } from '../../stores/staticTrainingPackStore';

export interface Layer4StaticTrainingPackBrowseRecipeProps {
  isLight?: boolean;
  onBack?: () => void;
  onStartPlaySession?: (uuid: string) => void;
  onStartEditSession?: (uuid: string) => void;
}

/**
 * [Recipe] Layer 4 Static Training Pack Browser (Width: 680px, 2-Column Layout)
 * - Left column: Pack list + Create Pack + Import .RCSPack
 * - Right column: Selected Pack Metadata (editable Title & Description, shot count, VFS UUID),
 *   Down Counter toggle (3 / 2 / 1, default 1), Play, Edit, Export .RCSPack, and Delete (with double-check confirmation).
 */
export const Layer4StaticTrainingPackBrowseRecipe: React.FC<Layer4StaticTrainingPackBrowseRecipeProps> = ({
  isLight = false,
  onBack,
  onStartPlaySession,
  onStartEditSession,
}) => {
  const packs = useStaticTrainingPackStore((s) => s.packs);
  const selectedPackUuid = useStaticTrainingPackStore((s) => s.selectedPackUuid);
  const activePack = useStaticTrainingPackStore((s) => s.activePack);
  const initialized = useStaticTrainingPackStore((s) => s.initialized);
  const initStore = useStaticTrainingPackStore((s) => s.initStore);
  const selectPack = useStaticTrainingPackStore((s) => s.selectPack);
  const createPack = useStaticTrainingPackStore((s) => s.createPack);
  const updatePackInfo = useStaticTrainingPackStore((s) => s.updatePackInfo);
  const deletePack = useStaticTrainingPackStore((s) => s.deletePack);
  const exportPackRCS = useStaticTrainingPackStore((s) => s.exportPackRCS);
  const importPackRCS = useStaticTrainingPackStore((s) => s.importPackRCS);
  const downCounterEnabled = useStaticTrainingPackStore((s) => s.downCounterEnabled);
  const downCounterValue = useStaticTrainingPackStore((s) => s.downCounterValue);
  const setDownCounterEnabled = useStaticTrainingPackStore((s) => s.setDownCounterEnabled);
  const setDownCounterValue = useStaticTrainingPackStore((s) => s.setDownCounterValue);

  const [hoveredDesc, setHoveredDesc] = useState<string | null>(null);
  const [isCreatingPack, setIsCreatingPack] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [confirmDeleteUuid, setConfirmDeleteUuid] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!initialized) {
      initStore();
    }
  }, [initialized, initStore]);

  useEffect(() => {
    if (activePack) {
      setEditTitle(activePack.metadata.title);
      setEditDescription(activePack.metadata.description);
    }
    setConfirmDeleteUuid(null);
  }, [activePack?.metadata.uuid, activePack?.metadata.title, activePack?.metadata.description]);

  const handleCreateSubmit = async () => {
    const title = newTitle.trim() || 'Custom Training Pack';
    const desc = newDescription.trim() || 'Custom static training pack scenarios.';
    await createPack(title, desc);
    setNewTitle('');
    setNewDescription('');
    setIsCreatingPack(false);
  };

  const handleSaveMetadata = async () => {
    if (!activePack) return;
    const trimmedTitle = editTitle.trim() || 'Untitled Training Pack';
    const trimmedDesc = editDescription.trim();
    if (
      trimmedTitle !== activePack.metadata.title ||
      trimmedDesc !== activePack.metadata.description
    ) {
      await updatePackInfo(activePack.metadata.uuid, trimmedTitle, trimmedDesc);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importPackRCS(file);
      setHoveredDesc(`Imported pack from ${file.name}`);
    } catch (err: any) {
      console.error('[Layer4StaticTrainingPackBrowseRecipe] Failed to import .RCSPack file:', err);
      setHoveredDesc(`Import failed: ${err?.message || 'Invalid .RCSPack file'}`);
    } finally {
      e.target.value = '';
    }
  };

  const selectedMeta =
    packs.find((p) => p.uuid === selectedPackUuid) || activePack?.metadata || null;

  return (
    <PanelContainer
      isLight={isLight}
      sizing={DEFAULT_PANEL_SIZING['layer4-static-training-pack']}
      className="w-full"
    >
      <PanelHeader
        title="STATIC TRAINING PACKS"
        onBack={onBack}
        isLight={isLight}
        rightElement={
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".rcspack,.RCSPack,.gz,.json"
              onChange={handleImportFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onMouseEnter={() =>
                setHoveredDesc('Import a compressed .RCSPack training pack archive into IndexedDB VFS.')
              }
              onMouseLeave={() => setHoveredDesc(null)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all cursor-pointer active:scale-95 ${
                isLight
                  ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
                  : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Import .RCSPack</span>
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingPack((v) => !v)}
              onMouseEnter={() =>
                setHoveredDesc('Create a new Static Training Pack with custom Title and Description.')
              }
              onMouseLeave={() => setHoveredDesc(null)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all cursor-pointer active:scale-95 ${
                isLight
                  ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-900 text-white'
                  : 'bg-white hover:bg-neutral-200 border-white text-neutral-900'
              }`}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create Pack</span>
            </button>
          </div>
        }
      />

      <PanelContent scrollable={false} className="p-4 flex flex-col gap-3 h-full overflow-hidden">
        {/* Optional Inline Create Pack Form */}
        {isCreatingPack && (
          <div
            className={`p-3 rounded-xl border flex flex-col gap-2 shrink-0 ${
              isLight
                ? 'bg-neutral-100/90 border-neutral-300 text-neutral-900'
                : 'bg-neutral-900/90 border-neutral-700 text-neutral-100'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold tracking-tight">NEW STATIC TRAINING PACK</span>
              <button
                type="button"
                onClick={() => setIsCreatingPack(false)}
                className="p-1 rounded hover:bg-neutral-500/20 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Pack Title (e.g. Aerial Redirects)"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs outline-none ${
                  isLight
                    ? 'bg-white border-neutral-300 text-neutral-900'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-100'
                }`}
              />
              <input
                type="text"
                placeholder="Description..."
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs outline-none ${
                  isLight
                    ? 'bg-white border-neutral-300 text-neutral-900'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-100'
                }`}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCreatingPack(false)}
                className={`px-3 py-1 rounded-lg border text-xs font-medium cursor-pointer ${
                  isLight
                    ? 'bg-white border-neutral-300 text-neutral-700'
                    : 'bg-neutral-800 border-neutral-700 text-neutral-300'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateSubmit}
                className={`px-3 py-1 rounded-lg border text-xs font-bold cursor-pointer flex items-center gap-1 ${
                  isLight
                    ? 'bg-neutral-900 border-neutral-900 text-white'
                    : 'bg-white border-white text-neutral-900'
                }`}
              >
                <Check className="h-3.5 w-3.5" />
                <span>Create</span>
              </button>
            </div>
          </div>
        )}

        {/* Two-Column Browse & Metadata Split View */}
        <div className="grid grid-cols-12 gap-3.5 grow min-h-0 overflow-hidden">
          {/* LEFT COLUMN: Pack List (5 cols) */}
          <div
            className={`col-span-5 flex flex-col rounded-xl border overflow-hidden ${
              isLight
                ? 'bg-neutral-50/70 border-neutral-200/90'
                : 'bg-neutral-900/50 border-neutral-800'
            }`}
          >
            <div
              className={`px-3 py-2 border-b flex items-center justify-between text-[11px] font-bold tracking-wider uppercase ${
                isLight
                  ? 'border-neutral-200 text-neutral-500 bg-neutral-100/60'
                  : 'border-neutral-800 text-neutral-400 bg-neutral-900/80'
              }`}
            >
              <span>Training Packs ({packs.length})</span>
              <FolderOpen className="h-3.5 w-3.5 opacity-60" />
            </div>

            <div className="flex flex-col gap-1.5 p-2 overflow-y-auto grow">
              {packs.map((pack) => {
                const isSelected = pack.uuid === selectedPackUuid;
                return (
                  <button
                    key={pack.uuid}
                    type="button"
                    onClick={() => selectPack(pack.uuid)}
                    onMouseEnter={() =>
                      setHoveredDesc(`${pack.title} — ${pack.itemCount} shots (${pack.description || 'No description'})`)
                    }
                    onMouseLeave={() => setHoveredDesc(null)}
                    className={`flex flex-col gap-1 p-2.5 text-left transition-all border cursor-pointer ${UI_RADIUS.md} ${
                      isSelected
                        ? isLight
                          ? 'bg-white border-neutral-900 shadow-xs text-neutral-900'
                          : 'bg-neutral-800 border-neutral-200 shadow-sm text-white'
                        : isLight
                        ? 'bg-white/60 hover:bg-white border-neutral-200/80 text-neutral-800'
                        : 'bg-neutral-850/60 hover:bg-neutral-800/80 border-neutral-800 text-neutral-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold truncate">{pack.title}</span>
                      <Badge
                        variant={isSelected ? 'default' : 'neutral'}
                        size="sm"
                        isLight={isLight}
                        className="text-[9px] shrink-0"
                      >
                        {pack.itemCount} {pack.itemCount === 1 ? 'Shot' : 'Shots'}
                      </Badge>
                    </div>
                    <span
                      className={`text-[10px] line-clamp-1 ${
                        isLight ? 'text-neutral-500' : 'text-neutral-400'
                      }`}
                    >
                      {pack.description || 'No description'}
                    </span>
                  </button>
                );
              })}

              {packs.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 text-center px-3 opacity-60">
                  <Target className="h-6 w-6 mb-2" />
                  <span className="text-xs font-medium">No Training Packs</span>
                  <span className="text-[10px] mt-0.5">Click Create Pack or Import .RCSPack</span>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT COLUMN: Selected Pack Metadata & Actions (7 cols) */}
          <div
            className={`col-span-7 flex flex-col justify-between rounded-xl border p-3.5 overflow-y-auto ${
              isLight
                ? 'bg-white border-neutral-200/90 text-neutral-900'
                : 'bg-neutral-900/70 border-neutral-800 text-neutral-100'
            }`}
          >
            {selectedMeta ? (
              <>
                <div className="flex flex-col gap-3">
                  {/* Pack Header & Editable Title / Description */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[10px] font-mono uppercase tracking-wider ${
                          isLight ? 'text-neutral-500' : 'text-neutral-400'
                        }`}
                      >
                        PACK METADATA • {selectedMeta.itemCount}{' '}
                        {selectedMeta.itemCount === 1 ? 'SCENARIO' : 'SCENARIOS'}
                      </span>
                      <span
                        className={`text-[10px] font-mono truncate max-w-[170px] ${
                          isLight ? 'text-neutral-400' : 'text-neutral-500'
                        }`}
                        title={`/static-training-pack/${selectedMeta.uuid}`}
                      >
                        ID: {selectedMeta.uuid.slice(0, 8)}
                      </span>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-semibold opacity-70">Pack Name</label>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={handleSaveMetadata}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold outline-none transition-colors ${
                          isLight
                            ? 'bg-neutral-50 focus:bg-white border-neutral-300 text-neutral-900'
                            : 'bg-neutral-850 focus:bg-neutral-800 border-neutral-700 text-neutral-100'
                        }`}
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-semibold opacity-70">Description</label>
                      <textarea
                        rows={2}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        onBlur={handleSaveMetadata}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs outline-none resize-none transition-colors ${
                          isLight
                            ? 'bg-neutral-50 focus:bg-white border-neutral-300 text-neutral-800'
                            : 'bg-neutral-850 focus:bg-neutral-800 border-neutral-700 text-neutral-200'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Down Counter Configuration */}
                  <div
                    className={`p-2.5 rounded-lg border flex flex-col gap-2 ${
                      isLight
                        ? 'bg-neutral-50 border-neutral-200'
                        : 'bg-neutral-850/70 border-neutral-800'
                    }`}
                  >
                    <div
                      className="flex items-center justify-between cursor-pointer select-none"
                      onClick={() => setDownCounterEnabled(!downCounterEnabled)}
                      onMouseEnter={() =>
                        setHoveredDesc(
                          'When OFF (default), shot starts on first driving input. When ON, holds stationary with 3/2/1 countdown beep + Go cue.'
                        )
                      }
                      onMouseLeave={() => setHoveredDesc(null)}
                    >
                      <div className="flex flex-col">
                        <span className="text-xs font-semibold">Pre-Launch Down Counter</span>
                        <span
                          className={`text-[10px] ${
                            isLight ? 'text-neutral-500' : 'text-neutral-400'
                          }`}
                        >
                          {downCounterEnabled
                            ? `Hold ${downCounterValue + 1}s (${downCounterValue}s beep -> GO, pre-input buffered)`
                            : 'Disabled (Instant launch on first driving input)'}
                        </span>
                      </div>
                      <ToggleSwitch
                        checked={downCounterEnabled}
                        onCheckedChange={(checked) => setDownCounterEnabled(checked)}
                        isLight={isLight}
                        variant="neutral"
                      />
                    </div>

                    {downCounterEnabled && (
                      <div className="flex items-center justify-between gap-2 pt-1">
                        <span className="text-[11px] font-medium opacity-80">Countdown Seconds</span>
                        <div className="w-40">
                          <SegmentedSwitch
                            options={[
                              { value: '3', label: '3s' },
                              { value: '2', label: '2s' },
                              { value: '1', label: '1s (Default)' },
                            ]}
                            value={String(downCounterValue)}
                            onChange={(val) => setDownCounterValue(Number(val) as 1 | 2 | 3)}
                            isLight={isLight}
                            size="sm"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Primary Pack Actions: Play, Edit, Export, Delete (with Double-Check) */}
                <div className="flex flex-col gap-2 pt-3 border-t border-neutral-500/15 mt-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onStartPlaySession?.(selectedMeta.uuid)}
                      onMouseEnter={() =>
                        setHoveredDesc(
                          'Start playing this training pack. Hotkeys: [R] Reset Shot, [[] Prev Shot, []] Next Shot.'
                        )
                      }
                      onMouseLeave={() => setHoveredDesc(null)}
                      className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border text-xs font-bold transition-all cursor-pointer active:scale-98 ${
                        isLight
                          ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-900 text-white shadow-xs'
                          : 'bg-white hover:bg-neutral-200 border-white text-neutral-900 shadow-xs'
                      }`}
                    >
                      <Play className="h-4 w-4 fill-current" />
                      <span>PLAY PACK</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onStartEditSession?.(selectedMeta.uuid)}
                      onMouseEnter={() =>
                        setHoveredDesc(
                          'Enter Edit Mode with Live Preview [TAB], 3D Car/Ball trajectory aiming, and Shot List reordering.'
                        )
                      }
                      onMouseLeave={() => setHoveredDesc(null)}
                      className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg border text-xs font-bold transition-all cursor-pointer active:scale-98 ${
                        isLight
                          ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-900'
                          : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-100'
                      }`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      <span>EDIT PACK</span>
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => exportPackRCS(selectedMeta.uuid)}
                      onMouseEnter={() =>
                        setHoveredDesc(
                          'Export this pack as a GZIP-compressed <Title>_<UUID>.RCSPack file.'
                        )
                      }
                      onMouseLeave={() => setHoveredDesc(null)}
                      className={`flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg border text-[11px] font-semibold transition-all cursor-pointer ${
                        isLight
                          ? 'bg-neutral-50 hover:bg-neutral-100 border-neutral-300 text-neutral-700'
                          : 'bg-neutral-850 hover:bg-neutral-800 border-neutral-700 text-neutral-300'
                      }`}
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export .RCSPack</span>
                    </button>

                    {confirmDeleteUuid === selectedMeta.uuid ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-bold text-red-500">Confirm Delete?</span>
                        <button
                          type="button"
                          onClick={async () => {
                            await deletePack(selectedMeta.uuid);
                            setConfirmDeleteUuid(null);
                          }}
                          className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold cursor-pointer"
                        >
                          Yes, Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteUuid(null)}
                          className={`px-2 py-1 rounded-lg border text-[11px] font-medium cursor-pointer ${
                            isLight
                              ? 'bg-neutral-100 border-neutral-300 text-neutral-700'
                              : 'bg-neutral-800 border-neutral-700 text-neutral-300'
                          }`}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteUuid(selectedMeta.uuid)}
                        onMouseEnter={() =>
                          setHoveredDesc('Delete this training pack (requires double-check confirmation).')
                        }
                        onMouseLeave={() => setHoveredDesc(null)}
                        className={`flex items-center gap-1.5 py-1.5 px-3 rounded-lg border text-[11px] font-semibold transition-all cursor-pointer ${
                          isLight
                            ? 'bg-red-50/70 hover:bg-red-100 border-red-200 text-red-700'
                            : 'bg-red-950/30 hover:bg-red-900/40 border-red-900/60 text-red-300'
                        }`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        <span>Delete Pack</span>
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center opacity-60">
                <Target className="h-8 w-8 mb-2" />
                <span className="text-xs font-semibold">Select or Create a Training Pack</span>
              </div>
            )}
          </div>
        </div>
      </PanelContent>

      <PanelFooter isLight={isLight}>
        <div className="flex items-center gap-2 w-full text-xs truncate">
          <Info className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
          <span
            className={`truncate transition-colors duration-150 ${
              hoveredDesc
                ? isLight
                  ? 'text-neutral-900'
                  : 'text-neutral-100'
                : isLight
                ? 'text-neutral-400'
                : 'text-neutral-500'
            }`}
          >
            {hoveredDesc ||
              'Select a Static Training Pack on the left to Play, Edit, Export (.RCSPack), or Delete.'}
          </span>
        </div>
      </PanelFooter>
    </PanelContainer>
  );
};
