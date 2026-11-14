import React, { useMemo } from 'react';
import {
  CheckCircle2,
  XCircle,
  Wrench,
  PauseCircle,
  ChevronLeft,
  ChevronRight,
  FileOutput,
  MessageSquare,
  Eraser,
  History,
} from 'lucide-react';
import type { SurfaceApprovalStatus } from '../../../ui-core/manifest/surfaceMetaTypes';
import { quickNotification } from '../../../ui-core/stores/quickNotificationStore';
import {
  buildAllReviewUnits,
  findUnitIndexByKeyOrSurface,
  resolveLedgerVariantRecord,
} from './reviewLedgerAdapter';
import { useReviewLedgerStore } from './reviewLedgerStore';

export interface SidebarReviewTriagePanelProps {
  isLight: boolean;
}

const STATUS_BUTTONS: Array<{
  status: SurfaceApprovalStatus;
  label: string;
  shortcut: string;
  icon: React.ComponentType<{ className?: string }>;
  activeCls: string;
  idleClsLight: string;
  idleClsDark: string;
}> = [
  {
    status: 'approved',
    label: 'Approve',
    shortcut: 'A',
    icon: CheckCircle2,
    activeCls: 'bg-emerald-500 text-neutral-950 border-emerald-400 ring-2 ring-emerald-400/50',
    idleClsLight: 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200',
    idleClsDark: 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  },
  {
    status: 'rejected',
    label: 'Reject',
    shortcut: 'R',
    icon: XCircle,
    activeCls: 'bg-rose-500 text-white border-rose-400 ring-2 ring-rose-400/50',
    idleClsLight: 'bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200',
    idleClsDark: 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/30',
  },
  {
    status: 'pending',
    label: 'Fixed',
    shortcut: 'F',
    icon: Wrench,
    activeCls: 'bg-sky-500 text-neutral-950 border-sky-400 ring-2 ring-sky-400/50',
    idleClsLight: 'bg-sky-50 hover:bg-sky-100 text-sky-700 border-sky-200',
    idleClsDark: 'bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border-sky-500/30',
  },
  {
    status: 'deferred',
    label: 'Hold',
    shortcut: 'D',
    icon: PauseCircle,
    activeCls: 'bg-amber-500 text-neutral-950 border-amber-400 ring-2 ring-amber-400/50',
    idleClsLight: 'bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border-neutral-300',
    idleClsDark: 'bg-neutral-900 hover:bg-neutral-800 text-neutral-300 border-neutral-700',
  },
];

export const SidebarReviewTriagePanel: React.FC<SidebarReviewTriagePanelProps> = React.memo(
  ({ isLight }) => {
    const {
      activeUnitKey,
      playlistScope,
      decisionsMap,
      registeredUnitsMap,
      simulateTemplateStale,
      setDecision,
      updateNote,
      stepQueue,
      setExporterModalOpen,
    } = useReviewLedgerStore();

    const allUnits = useMemo(
      () =>
        buildAllReviewUnits({
          playlistScope,
          decisionsMap,
          registeredUnitsMap,
          globalTemplateStaleOverride: simulateTemplateStale,
        }),
      [playlistScope, decisionsMap, registeredUnitsMap, simulateTemplateStale]
    );

    const activeUnit = useMemo(() => {
      const idx = findUnitIndexByKeyOrSurface(allUnits, activeUnitKey);
      return (idx >= 0 ? allUnits[idx] : undefined) || allUnits[0];
    }, [allUnits, activeUnitKey]);

    if (!activeUnit) return null;

    const ledgerVariant = resolveLedgerVariantRecord(
      activeUnit.ledgerRecord,
      activeUnit.variantId
    );
    const baselineNote = (ledgerVariant?.note ?? activeUnit.ledgerRecord?.note ?? '').trim();
    const baselineStatus = ledgerVariant?.status ?? activeUnit.ledgerRecord?.status;

    const handleTriggerDecision = (status: SurfaceApprovalStatus) => {
      const next = setDecision({
        unitKey: activeUnit.unitKey,
        status,
        advanceToNext: true,
      });
      const label = status === 'pending' ? 'FIXED / VERIFY' : status.toUpperCase();
      const msg = `${label} #${activeUnit.playlistIndex} · ${activeUnit.label}${
        next ? ` -> #${next.playlistIndex} ${next.label}` : ''
      }`;
      if (status === 'approved') quickNotification.success(msg);
      else if (status === 'rejected') quickNotification.warning(msg);
      else quickNotification.info(msg);
    };

    const navBtnCls = isLight
      ? 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-700'
      : 'bg-neutral-900 hover:bg-neutral-800 border-neutral-700 text-neutral-300';

    return (
      <div
        className={`w-72 border-t p-3 flex flex-col gap-2 font-mono text-xs ${
          isLight
            ? 'border-neutral-200/90 bg-neutral-50/90 text-neutral-900'
            : 'border-neutral-800/90 bg-neutral-900/55 text-neutral-100'
        }`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1 min-w-0">
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-500 text-[10px] font-bold shrink-0">
              #{activeUnit.playlistIndex}/{allUnits.length}
            </span>
            <span className="text-[11px] font-bold truncate" title={activeUnit.label}>
              {activeUnit.label}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => stepQueue(-1)}
              className={`p-1 rounded border cursor-pointer transition-colors ${navBtnCls}`}
              title="Previous unit"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => stepQueue(1)}
              className={`p-1 rounded border cursor-pointer transition-colors ${navBtnCls}`}
              title="Next unit"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Review Triage Status">
          {STATUS_BUTTONS.map((btn) => {
            const Icon = btn.icon;
            const isActive = activeUnit.status === btn.status;
            return (
              <button
                key={btn.status}
                type="button"
                aria-pressed={isActive}
                onClick={() => handleTriggerDecision(btn.status)}
                className={`flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-bold cursor-pointer transition-all active:scale-95 ${
                  isActive
                    ? btn.activeCls
                    : isLight
                      ? btn.idleClsLight
                      : btn.idleClsDark
                }`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{btn.label}</span>
                <span className="text-[9px] opacity-75">[{btn.shortcut}]</span>
              </button>
            );
          })}
        </div>

        {baselineNote && (
          <div
            className={`rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed ${
              isLight
                ? 'bg-amber-50/80 border-amber-200 text-amber-950'
                : 'bg-amber-500/10 border-amber-500/25 text-amber-200'
            }`}
          >
            <div className="flex items-center justify-between gap-1 font-bold uppercase tracking-wider text-[9px] opacity-80 mb-0.5">
              <span className="inline-flex items-center gap-1">
                <History className="h-2.5 w-2.5" />
                Previous Ledger Note
              </span>
              {baselineStatus && <span>{baselineStatus}</span>}
            </div>
            <div className="whitespace-pre-wrap break-words max-h-16 overflow-y-auto">
              {baselineNote}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="inline-flex items-center gap-1 font-bold uppercase tracking-wider opacity-75">
              <MessageSquare className="h-3 w-3 text-amber-500" />
              Reviewer Note
            </span>
            {activeUnit.note.trim().length > 0 && (
              <button
                type="button"
                onClick={() => updateNote(activeUnit.unitKey, '')}
                className="inline-flex items-center gap-0.5 text-[10px] opacity-70 hover:opacity-100 cursor-pointer"
                title="Clear note"
              >
                <Eraser className="h-2.5 w-2.5" />
                Clear
              </button>
            )}
          </div>
          <textarea
            id="rc-sidebar-triage-note"
            rows={4}
            value={activeUnit.note}
            onChange={(e) => updateNote(activeUnit.unitKey, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.currentTarget.blur();
              }
              e.stopPropagation();
            }}
            placeholder="Write multi-line review note (Enter for newline, Space works normally)..."
            className={`w-full px-2.5 py-1.5 rounded-lg border text-[11px] font-mono outline-none transition-colors resize-y min-h-[76px] max-h-40 leading-relaxed ${
              isLight
                ? 'bg-white border-neutral-300 focus:border-amber-500 text-neutral-900 placeholder:text-neutral-400'
                : 'bg-neutral-950 border-neutral-800 focus:border-amber-500 text-neutral-100 placeholder:text-neutral-500'
            }`}
          />
        </div>

        <button
          type="button"
          onClick={() => setExporterModalOpen(true)}
          className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold text-[11px] cursor-pointer transition-all active:scale-95"
        >
          <FileOutput className="h-3.5 w-3.5" />
          <span>Export Triage Bundle</span>
        </button>
      </div>
    );
  }
);

SidebarReviewTriagePanel.displayName = 'SidebarReviewTriagePanel';
