import React, { useRef, useState } from 'react';
import { Copy, Download, FolderPlus, MoveRight, Trash2, Upload } from 'lucide-react';
import type { DynamicTrainingPackRecord } from '../../../config/dynamicTrainingPackTypes';

export interface DynamicTrainingPackManagerSectionProps {
  isLight: boolean;
  packs: DynamicTrainingPackRecord[];
  activePack: DynamicTrainingPackRecord | null;
  activeShotId: string | null;
  onSelectPack: (uuid: string) => void;
  onSelectShot: (shotId: string) => void;
  onCreatePack: (title: string) => void;
  onExportPack: (uuid: string) => void;
  onImportPack: (rawOrBytes: ArrayBuffer | string) => void;
  onMoveShot: (targetPackUuid: string, shotId: string) => void;
  onDuplicateShot: (targetPackUuid: string, shotId: string) => void;
  onDeleteShot: (shotId: string, deleteSessionToo: boolean) => void;
}

export const DynamicTrainingPackManagerSection: React.FC<DynamicTrainingPackManagerSectionProps> =
  React.memo(
    ({
      isLight,
      packs,
      activePack,
      activeShotId,
      onSelectPack,
      onSelectShot,
      onCreatePack,
      onExportPack,
      onImportPack,
      onMoveShot,
      onDuplicateShot,
      onDeleteShot,
    }) => {
      const [newPackTitle, setNewPackTitle] = useState('');
      const [targetPackUuid, setTargetPackUuid] = useState<string>('');
      const [confirmDeleteShotId, setConfirmDeleteShotId] = useState<string | null>(null);
      const fileInputRef = useRef<HTMLInputElement | null>(null);

      const inputCls = isLight
        ? 'bg-white border-neutral-300 text-neutral-900'
        : 'bg-neutral-950 border-neutral-700 text-neutral-100';
      const btnCls = isLight
        ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
        : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-100';

      const otherPacks = packs.filter((p) => p.metadata.uuid !== activePack?.metadata.uuid);
      const effectiveTargetPack =
        otherPacks.find((p) => p.metadata.uuid === targetPackUuid)?.metadata.uuid ??
        otherPacks[0]?.metadata.uuid ??
        activePack?.metadata.uuid ??
        '';

      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <select
              value={activePack?.metadata.uuid ?? ''}
              onChange={(e) => onSelectPack(e.target.value)}
              className={`flex-1 min-w-0 px-2 py-1 rounded border text-xs font-semibold ${inputCls}`}
            >
              {packs.map((p) => (
                <option key={p.metadata.uuid} value={p.metadata.uuid}>
                  [{p.metadata.folder}] {p.metadata.title} ({p.shots.length})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!activePack}
              onClick={() => activePack && onExportPack(activePack.metadata.uuid)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-semibold cursor-pointer ${btnCls}`}
              title="Export .rcd.gz Pack"
            >
              <Download className="h-3 w-3" />
              .rcd.gz
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-semibold cursor-pointer ${btnCls}`}
              title="Import .rcd.gz Pack"
            >
              <Upload className="h-3 w-3" />
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".rcd.gz,.rcd,.json,.gz"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void file.arrayBuffer().then((buf) => onImportPack(buf));
                e.target.value = '';
              }}
            />
          </div>

          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={newPackTitle}
              onChange={(e) => setNewPackTitle(e.target.value)}
              placeholder="New dynamic pack title..."
              className={`flex-1 min-w-0 px-2 py-1 rounded border text-[11px] ${inputCls}`}
            />
            <button
              type="button"
              onClick={() => {
                onCreatePack(newPackTitle || 'Custom Dynamic Pack');
                setNewPackTitle('');
              }}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-semibold cursor-pointer ${btnCls}`}
            >
              <FolderPlus className="h-3 w-3" />
              Create
            </button>
          </div>

          {activePack && activePack.shots.length > 0 && (
            <div className="flex flex-col gap-1 max-h-36 overflow-y-auto pr-1">
              {activePack.shots.map((shot, idx) => {
                const isSelected = shot.id === activeShotId;
                const isConfirming = confirmDeleteShotId === shot.id;
                return (
                  <div
                    key={shot.id}
                    className={`flex items-center justify-between gap-1.5 px-2 py-1 rounded border text-[11px] ${
                      isSelected
                        ? 'border-cyan-500 bg-cyan-500/10'
                        : isLight
                          ? 'border-neutral-200 bg-white'
                          : 'border-neutral-800 bg-neutral-900/50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectShot(shot.id)}
                      className="flex-1 min-w-0 text-left truncate font-medium cursor-pointer"
                    >
                      #{idx + 1} {shot.name}
                    </button>

                    {!isConfirming ? (
                      <div className="flex items-center gap-1 shrink-0">
                        {otherPacks.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              effectiveTargetPack && onMoveShot(effectiveTargetPack, shot.id)
                            }
                            className={`p-1 rounded border cursor-pointer ${btnCls}`}
                            title="Move to other pack"
                          >
                            <MoveRight className="h-3 w-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            onDuplicateShot(
                              effectiveTargetPack || activePack.metadata.uuid,
                              shot.id
                            )
                          }
                          className={`p-1 rounded border cursor-pointer ${btnCls}`}
                          title="Duplicate shot"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteShotId(shot.id)}
                          className="p-1 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/20 cursor-pointer"
                          title="Delete shot"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            onDeleteShot(shot.id, true);
                            setConfirmDeleteShotId(null);
                          }}
                          className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-semibold cursor-pointer"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteShotId(null)}
                          className={`px-1.5 py-0.5 rounded border text-[10px] cursor-pointer ${btnCls}`}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {otherPacks.length > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] opacity-75">
              <span>Move/Duplicate target:</span>
              <select
                value={effectiveTargetPack}
                onChange={(e) => setTargetPackUuid(e.target.value)}
                className={`flex-1 px-1.5 py-0.5 rounded border ${inputCls}`}
              >
                {otherPacks.map((p) => (
                  <option key={p.metadata.uuid} value={p.metadata.uuid}>
                    {p.metadata.title}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      );
    }
  );
DynamicTrainingPackManagerSection.displayName = 'DynamicTrainingPackManagerSection';
