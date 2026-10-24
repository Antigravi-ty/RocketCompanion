import React, { useRef } from 'react';
import {
  Plus,
  Copy,
  ArrowUp,
  ArrowDown,
  Trash2,
  Download,
  Upload,
} from 'lucide-react';
import {
  useStaticTrainingPackStore,
  type StaticTrainingShotItem,
} from '../../../stores/staticTrainingPackStore';

export interface StaticTrainingShotListViewProps {
  isLight: boolean;
  items: StaticTrainingShotItem[];
  safeIndex: number;
  onSelectInspectShot: (idx: number) => Promise<void>;
  onHoverDesc: (desc: string | null) => void;
}

export const StaticTrainingShotListView: React.FC<StaticTrainingShotListViewProps> = ({
  isLight,
  items,
  safeIndex,
  onSelectInspectShot,
  onHoverDesc,
}) => {
  const addNewShot = useStaticTrainingPackStore((s) => s.addNewShot);
  const duplicateShot = useStaticTrainingPackStore((s) => s.duplicateShot);
  const deleteShot = useStaticTrainingPackStore((s) => s.deleteShot);
  const reorderShot = useStaticTrainingPackStore((s) => s.reorderShot);
  const exportSingleShotJson = useStaticTrainingPackStore((s) => s.exportSingleShotJson);
  const importSingleShotJson = useStaticTrainingPackStore((s) => s.importSingleShotJson);

  const itemJsonInputRef = useRef<HTMLInputElement>(null);

  const handleImportItemJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importSingleShotJson(file);
      onHoverDesc(`Imported shot item from ${file.name}`);
    } catch (err: any) {
      console.error('[StaticTrainingShotListView] Failed to import shot JSON:', err);
      onHoverDesc(`Failed to import shot JSON: ${err?.message || 'Invalid JSON'}`);
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => addNewShot()}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-bold cursor-pointer ${
              isLight
                ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-900 text-white'
                : 'bg-white hover:bg-neutral-200 border-white text-neutral-900'
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Shot</span>
          </button>

          <button
            type="button"
            onClick={() => duplicateShot(safeIndex)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer ${
              isLight
                ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
            }`}
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Duplicate Current</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            ref={itemJsonInputRef}
            type="file"
            accept=".json"
            onChange={handleImportItemJson}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => itemJsonInputRef.current?.click()}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-semibold cursor-pointer ${
              isLight
                ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-700'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-300'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Import .JSON</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto pr-0.5">
        {items.map((shot, idx) => {
          const isSelected = idx === safeIndex;
          return (
            <div
              key={shot.id || idx}
              className={`flex items-center justify-between gap-2 p-2 rounded-lg border ${
                isSelected
                  ? isLight
                    ? 'bg-white border-neutral-900 shadow-2xs'
                    : 'bg-neutral-800 border-neutral-200'
                  : isLight
                  ? 'bg-neutral-50 border-neutral-200'
                  : 'bg-neutral-900/60 border-neutral-800'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectInspectShot(idx)}
                className="flex items-center gap-2 min-w-0 text-left grow cursor-pointer"
              >
                <span className="font-mono text-xs font-bold opacity-70">#{idx + 1}</span>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold truncate">{shot.name}</span>
                  <span className="text-[10px] font-mono opacity-65">
                    Timeout {shot.timeoutSeconds}s • Car {Math.round(shot.car.speed)} UU/s •{' '}
                    {shot.ball.kickoffState
                      ? 'Ball Kickoff Freeze'
                      : `Ball ${Math.round(shot.ball.speed)} UU/s`}
                  </span>
                </div>
              </button>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => reorderShot(idx, idx - 1)}
                  className="p-1 rounded border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                  title="Move Up"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={idx === items.length - 1}
                  onClick={() => reorderShot(idx, idx + 1)}
                  className="p-1 rounded border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                  title="Move Down"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => duplicateShot(idx)}
                  className="p-1 rounded border border-neutral-500/30 hover:bg-neutral-500/15 cursor-pointer"
                  title="Duplicate Shot"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => exportSingleShotJson(idx)}
                  className="p-1 rounded border border-neutral-500/30 hover:bg-neutral-500/15 cursor-pointer"
                  title="Export Single Item JSON"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={items.length <= 1}
                  onClick={() => deleteShot(idx)}
                  className="p-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/15 disabled:opacity-30 cursor-pointer"
                  title="Delete Shot"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
