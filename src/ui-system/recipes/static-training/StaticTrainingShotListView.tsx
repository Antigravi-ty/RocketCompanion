import React, { useRef } from 'react';
import {
  Plus,
  Copy,
  ArrowUp,
  ArrowDown,
  Trash2,
  Download,
  Upload,
  HelpCircle,
} from 'lucide-react';
import {
  useStaticTrainingPackStore,
  MAX_SHOTS_PER_PACK,
  type StaticTrainingShotItem,
} from '../../../stores/staticTrainingPackStore';
import { dialogue } from '../../primitives/dialogue/dialogueStore';

export interface StaticTrainingShotListViewProps {
  isLight: boolean;
  items: StaticTrainingShotItem[];
  safeIndex: number;
  onSelectInspectShot: (idx: number) => void;
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
  const isAtMaxShots = items.length >= MAX_SHOTS_PER_PACK;

  const handleImportItemJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await importSingleShotJson(file);
      onHoverDesc(`Imported shot item from ${file.name}`);
    } catch (err: any) {
      onHoverDesc(`Failed to import shot JSON: ${err?.message || 'Invalid JSON'}`);
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
          <div className="font-semibold text-amber-400">
            Static Training Pack 3D Editor Controls &amp; Shortcuts
          </div>
          <div className="grid grid-cols-1 gap-1.5 font-mono text-[11px]">
            <div>
              <span className="font-bold text-sky-400">[TAB]</span> : Collapse / Expand Live Preview menu to manipulate the 3D scene directly.
            </div>
            <div>
              <span className="font-bold text-sky-400">[9] / [0] or Right-Click</span> : Cycle between the 4 Edit Sub-Modes (Car Heading, Car Speed, Ball Speed, Free Camera).
            </div>
            <div>
              <span className="font-bold text-sky-400">[W / A / S / D]</span> : Move the active target horizontally (Car in Car modes, Ball in Ball mode, Camera in Free Cam).
            </div>
            <div>
              <span className="font-bold text-sky-400">[Space] / [V]</span> : Move Up / Move Down. Pressing [V] at ground level in Car modes snaps the car to ground (60-frame suspension settle).
            </div>
            <div>
              <span className="font-bold text-sky-400">[Mouse Drag]</span> : Aim 3D direction (Car Nose Heading + Pitch, Car Velocity Yaw + Pitch, Ball Velocity Yaw + Pitch, or Free Cam Look).
            </div>
            <div>
              <span className="font-bold text-sky-400">[Q] / [E]</span> : Adjust Car Air Roll angle in Car Heading mode.
            </div>
            <div>
              <span className="font-bold text-sky-400">[O] / [P]</span> : Decrease / Increase Car Boost amount (press [P] at 100 to enable Unlimited Boost INF).
            </div>
            <div>
              <span className="font-bold text-sky-400">[[] / []]</span> : Decrease / Increase launch speed (Car or Ball). Pressing [[] at 0 Ball Speed toggles Kickoff Freeze (stationary mid-air until touched).
            </div>
            <div>
              <span className="font-bold text-sky-400">[F]</span> : Switch relative ball camera horizontal lateral offset side (flips between right +offset and left -offset).
            </div>
            <div>
              <span className="font-bold text-emerald-400">[T]</span> : Toggle trajectory preview test in any Edit sub-mode (launches Car &amp; Ball while keeping the camera at its unlaunched viewpoint; press [T] again to reset).
            </div>
            <div>
              <span className="font-bold text-emerald-400">[G]</span> : Test Single Shot (enter playable control for this shot only; press [G] again to return to editor).
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

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* Top Action Bar */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            disabled={isAtMaxShots}
            onClick={() => addNewShot()}
            onMouseEnter={() =>
              onHoverDesc(
                isAtMaxShots
                  ? `Maximum limit of ${MAX_SHOTS_PER_PACK} shots per pack reached.`
                  : `Append a new default shot to this pack (${items.length}/${MAX_SHOTS_PER_PACK}).`
              )
            }
            onMouseLeave={() => onHoverDesc(null)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-bold transition-all ${
              isAtMaxShots
                ? 'opacity-40 cursor-not-allowed border-neutral-500/30'
                : isLight
                ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-900 text-white cursor-pointer'
                : 'bg-white hover:bg-neutral-200 border-white text-neutral-900 cursor-pointer'
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Shot ({items.length}/{MAX_SHOTS_PER_PACK})</span>
          </button>

          <button
            type="button"
            disabled={isAtMaxShots}
            onClick={() => duplicateShot(safeIndex)}
            onMouseEnter={() =>
              onHoverDesc(
                isAtMaxShots
                  ? `Maximum limit of ${MAX_SHOTS_PER_PACK} shots reached.`
                  : 'Duplicate the highlighted shot.'
              )
            }
            onMouseLeave={() => onHoverDesc(null)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
              isAtMaxShots
                ? 'opacity-40 cursor-not-allowed border-neutral-500/30'
                : isLight
                ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800 cursor-pointer'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200 cursor-pointer'
            }`}
          >
            <Copy className="h-3.5 w-3.5" />
            <span>Duplicate</span>
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
            onMouseEnter={() =>
              onHoverDesc('Import a single shot configuration from a .json file into the current slot.')
            }
            onMouseLeave={() => onHoverDesc(null)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold cursor-pointer ${
              isLight
                ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-700'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-300'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Import .JSON</span>
          </button>

          <button
            type="button"
            onClick={handleShowHelp}
            onMouseEnter={() =>
              onHoverDesc('Open Help dialogue with full 3D editor keyboard & mouse controls.')
            }
            onMouseLeave={() => onHoverDesc(null)}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold cursor-pointer ${
              isLight
                ? 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-700'
                : 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-400/40 text-amber-300'
            }`}
          >
            <HelpCircle className="h-3.5 w-3.5" />
            <span>Show Help</span>
          </button>
        </div>
      </div>

      {/* Horizontal Full-Width Shot List */}
      <div className="flex flex-col gap-1.5 overflow-y-auto grow pr-0.5 min-h-0">
        {items.map((shot, idx) => {
          const isSelected = idx === safeIndex;
          const numStr = `#${String(idx + 1).padStart(2, '0')}`;
          return (
            <div
              key={shot.id || idx}
              className={`flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border transition-all ${
                isSelected
                  ? isLight
                    ? 'bg-white border-neutral-900 shadow-2xs'
                    : 'bg-neutral-800/90 border-neutral-300'
                  : isLight
                  ? 'bg-neutral-50/90 hover:bg-white border-neutral-200'
                  : 'bg-neutral-900/60 hover:bg-neutral-850 border-neutral-800'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectInspectShot(idx)}
                onMouseEnter={() =>
                  onHoverDesc(`Click to open Edit Shot panel for ${numStr} (${shot.name}).`)
                }
                onMouseLeave={() => onHoverDesc(null)}
                className="flex items-center gap-3 min-w-0 text-left grow cursor-pointer"
              >
                <span
                  className={`font-mono text-xs font-extrabold px-2 py-1 rounded-md border shrink-0 ${
                    isSelected
                      ? isLight
                        ? 'bg-neutral-900 text-white border-neutral-900'
                        : 'bg-white text-neutral-900 border-white'
                      : isLight
                      ? 'bg-neutral-100 text-neutral-700 border-neutral-300'
                      : 'bg-neutral-850 text-neutral-300 border-neutral-700'
                  }`}
                >
                  {numStr}
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-bold truncate">{shot.name}</span>
                  <span className="text-[10px] font-mono opacity-65 truncate">
                    Time Limit {shot.timeoutSeconds}s •{' '}
                    {shot.car.unlimitedBoost ? 'Boost INF' : `Boost ${Math.round(shot.car.initialBoost)}%`} •{' '}
                    {shot.car.snapToGround
                      ? 'Ground'
                      : shot.car.hasFlip !== false
                      ? 'Air (Has Flip)'
                      : 'Air (No Flip)'}{' '}
                    •{' '}
                    {shot.ball.kickoffState
                      ? 'Ball Freeze'
                      : `Ball ${Math.round(shot.ball.speed)} UU/s`}
                  </span>
                </div>
              </button>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={() => reorderShot(idx, idx - 1)}
                  className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                  title="Move Up"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={idx === items.length - 1}
                  onClick={() => reorderShot(idx, idx + 1)}
                  className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                  title="Move Down"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={isAtMaxShots}
                  onClick={() => duplicateShot(idx)}
                  className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                  title="Duplicate Shot"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => exportSingleShotJson(idx)}
                  className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 cursor-pointer"
                  title="Export Shot JSON"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={items.length <= 1}
                  onClick={() => deleteShot(idx)}
                  className="p-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/15 disabled:opacity-30 cursor-pointer"
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
