import React, { useEffect, useState } from 'react';
import { Copy, FolderPlus, MoveRight, Play, Plus, Trash2 } from 'lucide-react';
import type { StandardSurfaceProps, SurfaceMeta } from '../../manifest/surfaceMetaTypes.ts';
import type { CarTakeoverMode } from '../../config/dynamicTrainingPackTypes.ts';
import {
  dynamicTrainingPackStore,
  useDynamicTrainingPackStore,
} from '../../stores/dynamicTrainingPackStore.ts';
import { captureSessionFromReplay } from '../../../game/modes/DynamicTrainingMode.ts';

export const SURFACE_META: SurfaceMeta = {
  id: 'dynamic-training-editor',
  title: 'Dynamic Training Pack (RCDPack)',
  layer: 'floating-dev',
  menuGroup: 'sandboxes',
  hideFooter: true,
  defaultSizing: {
    width: 480,
    height: 540,
    minWidth: 400,
    minHeight: 420,
  },
  description: 'RCDPack & 4s Replay StateSession editor with Duplicate/Move/Delete and takeover modes',
};

const TAKEOVER_MODES: readonly { readonly id: CarTakeoverMode; readonly label: string }[] = [
  { id: 'disappear', label: 'Disappear' },
  { id: 'as-previous', label: 'As Previous' },
  { id: 'bot', label: 'Bot' },
];

export const DynamicTrainingEditorFloatingWindow: React.FC<StandardSurfaceProps> = () => {
  const loaded = useDynamicTrainingPackStore((s) => s.loaded);
  const packs = useDynamicTrainingPackStore((s) => s.packs);
  const sessions = useDynamicTrainingPackStore((s) => s.sessions);
  const activePackId = useDynamicTrainingPackStore((s) => s.activePackId);
  const activeSessionId = useDynamicTrainingPackStore((s) => s.activeSessionId);
  const lastJudgeOutcome = useDynamicTrainingPackStore((s) => s.lastJudgeOutcome);

  const [newPackName, setNewPackName] = useState('');
  const [targetPackId, setTargetPackId] = useState('');
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) {
      void dynamicTrainingPackStore.getState().loadAll();
    }
  }, [loaded]);

  const st = dynamicTrainingPackStore.getState();
  const activePack = packs.find((p) => p.id === activePackId) ?? packs[0] ?? null;
  const otherPacks = packs.filter((p) => p.id !== activePack?.id);
  const effectiveTargetId =
    otherPacks.find((p) => p.id === targetPackId)?.id ?? otherPacks[0]?.id ?? '';
  const activeSession = activeSessionId ? sessions[activeSessionId] ?? null : null;

  const handleCaptureSample = () => {
    const sample = captureSessionFromReplay(
      [
        {
          tick: 1200,
          ballPos: [0, 93, 2400],
          ballVel: [0, 120, 800],
          ballAngVel: [0, 0, 0],
          cars: [
            {
              carIndex: 0,
              team: 0,
              pos: [-400, 17, 1600],
              vel: [100, 0, 1100],
              rot: [0, 0, 0],
              angVel: [0, 0, 0],
              boost: 65,
              lastControls: {
                throttle: 1,
                steer: 0,
                pitch: 0,
                yaw: 0,
                roll: 0,
                jump: false,
                boost: true,
                handbrake: false,
              },
            },
            {
              carIndex: 1,
              team: 1,
              pos: [200, 17, 4500],
              vel: [-120, 0, -300],
              rot: [0, Math.PI, 0],
              angVel: [0, 0, 0],
              boost: 45,
              lastControls: {
                throttle: 0.8,
                steer: -0.2,
                pitch: 0,
                yaw: 0,
                roll: 0,
                jump: false,
                boost: false,
                handbrake: false,
              },
            },
          ],
        },
      ],
      1200,
      'Replay Intervene Capture',
      0
    );
    st.saveCapturedSession(sample, activePack?.id);
  };

  return (
    <div className="flex flex-col gap-3 text-xs text-zinc-200 select-none">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newPackName}
          onChange={(e) => setNewPackName(e.target.value)}
          placeholder="New RCDPack name..."
          className="flex-1 px-2 py-1.5 rounded bg-zinc-900 border border-white/10 text-xs text-white outline-none"
        />
        <button
          type="button"
          onClick={() => {
            st.createPack(newPackName || 'RCDPack ' + (packs.length + 1));
            setNewPackName('');
          }}
          className="px-2.5 py-1.5 rounded bg-sky-500/20 border border-sky-400/40 text-sky-300 hover:bg-sky-500/30 flex items-center gap-1 cursor-pointer"
        >
          <FolderPlus className="w-3.5 h-3.5" />
          <span>New Pack</span>
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {packs.map((pack) => (
          <button
            key={pack.id}
            type="button"
            onClick={() => st.setActivePack(pack.id)}
            className={`px-2 py-1 rounded border text-[11px] cursor-pointer ${
              activePack?.id === pack.id
                ? 'bg-amber-500/25 border-amber-400 text-amber-300'
                : 'bg-zinc-900/70 border-white/10 text-zinc-400 hover:text-white'
            }`}
          >
            {pack.name} ({pack.sessionIds.length})
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-white/10 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          StateSessions (4s Captured from Replay)
        </span>
        <button
          type="button"
          onClick={handleCaptureSample}
          className="px-2 py-1 rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/30 flex items-center gap-1 text-[11px] cursor-pointer"
        >
          <Plus className="w-3 h-3" />
          <span>Capture 4s Intervene</span>
        </button>
      </div>

      <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto pr-1">
        {activePack?.sessionIds.map((sid) => {
          const sess = sessions[sid];
          if (!sess) return null;
          const isSelected = activeSessionId === sid;
          const isConfirmingDelete = confirmDeleteSessionId === sid;
          return (
            <div
              key={sid}
              onClick={() => st.setActiveSession(sid)}
              className={`p-2 rounded border flex flex-col gap-1.5 cursor-pointer ${
                isSelected
                  ? 'bg-zinc-800/90 border-amber-400/50'
                  : 'bg-zinc-900/60 border-white/10 hover:border-white/25'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Play className="w-3 h-3 text-emerald-400 shrink-0" />
                  <span className="font-medium truncate">{sess.name}</span>
                  <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 text-[9px] uppercase">
                    {sess.sourceTag}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {effectiveTargetId && (
                    <>
                      <button
                        type="button"
                        title="Duplicate to selected target pack"
                        onClick={() => st.duplicateSessionTo(sid, effectiveTargetId)}
                        className="p-1 rounded bg-zinc-800 border border-white/10 text-zinc-300 hover:text-white cursor-pointer"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title="Move to selected target pack"
                        onClick={() => st.moveSessionTo(sid, activePack.id, effectiveTargetId)}
                        className="p-1 rounded bg-zinc-800 border border-white/10 text-zinc-300 hover:text-white cursor-pointer"
                      >
                        <MoveRight className="w-3 h-3" />
                      </button>
                    </>
                  )}
                  {isConfirmingDelete ? (
                    <button
                      type="button"
                      onClick={() => {
                        st.deleteSessionFromPack(sid, activePack.id);
                        setConfirmDeleteSessionId(null);
                      }}
                      className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold cursor-pointer"
                    >
                      Confirm Delete
                    </button>
                  ) : (
                    <button
                      type="button"
                      title="Delete session"
                      onClick={() => setConfirmDeleteSessionId(sid)}
                      className="p-1 rounded bg-zinc-800 border border-white/10 text-rose-400 hover:bg-rose-500/20 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {(!activePack || activePack.sessionIds.length === 0) && (
          <div className="text-[11px] text-zinc-500 py-3 text-center">
            No StateSessions in this RCDPack yet.
          </div>
        )}
      </div>

      {otherPacks.length > 0 && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-zinc-400">Target Pack (Duplicate / Move):</span>
          <select
            value={effectiveTargetId}
            onChange={(e) => setTargetPackId(e.target.value)}
            className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-white/10 text-zinc-200"
          >
            {otherPacks.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {activeSession && (
        <div className="border-t border-white/10 pt-2 flex flex-col gap-1.5">
          <div className="text-[11px] font-semibold text-zinc-300">
            Takeover Modes at Intervene Instant (Tick {activeSession.interveneTick})
          </div>
          {Object.keys(activeSession.carTakeoverModes).map((carIdxStr) => {
            const carIndex = Number(carIdxStr);
            const currentMode = activeSession.carTakeoverModes[carIndex];
            return (
              <div key={carIndex} className="flex items-center justify-between gap-2">
                <span className="text-zinc-400">Car #{carIndex + 1}</span>
                <div className="flex gap-1">
                  {TAKEOVER_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => st.setCarTakeoverMode(activeSession.id, carIndex, m.id)}
                      className={`px-2 py-0.5 rounded border text-[10px] cursor-pointer ${
                        currentMode === m.id
                          ? 'bg-sky-500/25 border-sky-400 text-sky-300'
                          : 'bg-zinc-900 border-white/10 text-zinc-400'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {lastJudgeOutcome && (
            <div className="text-[11px] text-amber-300">
              Last Judge Outcome: <span className="uppercase font-bold">{lastJudgeOutcome}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DynamicTrainingEditorFloatingWindow;
