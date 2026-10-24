import React from 'react';
import { motion } from 'framer-motion';
import {
  Plus,
  Upload,
  HelpCircle,
  Copy,
  ArrowUp,
  ArrowDown,
  Download,
  Trash2,
} from 'lucide-react';
import { UI_EASING } from '../tokens/easing';

export interface CollapsibleRailItem {
  id: string;
  index: number;
  title: string;
  subtitle?: string;
}

export interface CollapsibleNumberedRailListProps {
  /** Whether an item is currently inspected (true = compressed numbered rail; false = full horizontal list, default initial state) */
  isCollapsedToRail: boolean;
  /** List of items (#01..#99) */
  items: CollapsibleRailItem[];
  /** Currently active/selected item index */
  selectedIndex: number;
  /** Maximum item capacity (default: 99) */
  maxItems?: number;
  /** Compressed rail width in px when inspecting an item (default: 60px — 1px border + 4px left pad + 50px badge + 4px right pad + 1px border = 60px) */
  collapsedRailWidth?: number;
  /** Light or dark theme */
  isLight?: boolean;
  /** Callback when an item is clicked to open or switch inspector target */
  onSelectItem: (index: number) => void;
  /** Callback when New Shot (+) is clicked */
  onAddNew?: () => void;
  /** Callback when Import .JSON is clicked */
  onImport?: () => void;
  /** Callback when Show Help (?) is clicked */
  onShowHelp?: () => void;
  /** Callback when Duplicate is clicked (defaults to selectedIndex when invoked from top bar) */
  onDuplicate?: (index: number) => void;
  /** Callback when Move Up / Move Down is clicked */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Callback when Export Shot JSON is clicked */
  onExportItem?: (index: number) => void;
  /** Callback when Delete Shot is clicked */
  onDeleteItem?: (index: number) => void;
  /** Callback when hovering any interactive control to display description in PanelFooter */
  onHoverDescription?: (description: string | null) => void;
  /** Detail inspector view rendered on the right when `isCollapsedToRail` is true */
  detailContent?: React.ReactNode;
  className?: string;
}

/**
 * [L3 Compound] CollapsibleNumberedRailList
 *
 * Apple-symmetric horizontal container clipping (`overflow-hidden`) with hidden scrollbars (`.no-scrollbar`):
 * - Every shot row card is `h-[42px]` (`1px` border + `4px` top pad + `32px` badge + `4px` bottom pad + `1px` border)
 *   with `p-1` (`4px` padding on all 4 sides).
 * - Inside each shot row card, the `#01` badge is permanently `w-[50px] h-8 shrink-0` (`50px × 32px`).
 * - When `isCollapsedToRail` is `true`, the outer rail width is `60px` (`1px` left border + `4px` left pad + `50px` `#01` badge + `4px` right pad + `1px` right border = `60px`),
 *   giving exact `4px` spacing on all 4 sides (top = 4px, bottom = 4px, left = 4px, right = 4px) around `#01`.
 * - Row 1 (`h-8`, `60px` wide when collapsed) has a `28px` black `+` button on the left (`px-[6px]` around `14px` icon) and a `28px` orange `?` button on the right (`px-[6px]` around `14px` icon), with a `4px` gap in between (`28 + 4 + 28 = 60px`).
 * - Both the left rail scroll container and the right detail scroll container use `.no-scrollbar` so vertical scrollbars are completely hidden and never steal horizontal pixels.
 */
export const CollapsibleNumberedRailList: React.FC<CollapsibleNumberedRailListProps> = ({
  isCollapsedToRail,
  items,
  selectedIndex,
  maxItems = 99,
  collapsedRailWidth = 60,
  isLight = false,
  onSelectItem,
  onAddNew,
  onImport,
  onShowHelp,
  onDuplicate,
  onReorder,
  onExportItem,
  onDeleteItem,
  onHoverDescription,
  detailContent,
  className = '',
}) => {
  const isAtMax = items.length >= maxItems;
  const safeIndex = Math.max(0, Math.min(Math.max(0, items.length - 1), selectedIndex));

  return (
    <div
      data-component="collapsible-numbered-rail-list"
      data-collapsed={isCollapsedToRail}
      className={`flex items-stretch w-full h-full min-h-0 overflow-hidden select-none ${className}`}
    >
      {/* Left List / Rail Container:
          Only its outer width animates between 100% and 60px (`collapsedRailWidth`).
          Inner `#01` badges never change width, height, padding, or alignment! */}
      <motion.div
        data-rail-section="left-container"
        initial={false}
        animate={{
          width: isCollapsedToRail ? collapsedRailWidth : '100%',
        }}
        transition={{
          duration: 0.28,
          ease: UI_EASING.apple,
        }}
        style={{
          flexShrink: 0,
        }}
        className="flex flex-col gap-2 min-h-0 h-full overflow-hidden"
      >
        {/* Row 1 (Fixed h-8 / 32px):
            Left = Black [+ New Shot], Right = [Duplicate, Import .JSON, Orange ? Show Help]
            When collapsed to 60px: Left narrows to 28px [+], middle fades/clips out, Right narrows to 28px [?] (28 + 4 + 28 = 60px) */}
        <div
          data-rail-section="top-toolbar"
          className="flex items-center justify-between h-8 shrink-0 w-full overflow-hidden"
        >
          {/* Left: New Shot (+) — 1px border + 6px left pad + 14px icon + 6px right pad + 1px border = 28px when collapsed */}
          <button
            type="button"
            data-rail-button="new-shot"
            disabled={isAtMax}
            onClick={onAddNew}
            onMouseEnter={() =>
              onHoverDescription?.(
                isAtMax
                  ? `Maximum limit of ${maxItems} shots per pack reached.`
                  : `New Shot: Append a new default shot to this pack (${items.length}/${maxItems}).`
              )
            }
            onMouseLeave={() => onHoverDescription?.(null)}
            style={{
              width: isCollapsedToRail ? 28 : 134,
            }}
            className={`h-8 rounded-lg border flex items-center px-[6px] gap-1.5 text-xs font-bold overflow-hidden shrink-0 transition-[width,background-color,border-color] duration-280 ease-[cubic-bezier(0.22,1,0.36,1)] ${
              isAtMax
                ? 'opacity-40 cursor-not-allowed border-neutral-500/30'
                : isLight
                ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-900 text-white cursor-pointer active:scale-95 shadow-2xs'
                : 'bg-neutral-950 hover:bg-neutral-800 border-neutral-700 text-white cursor-pointer active:scale-95 shadow-2xs'
            }`}
            aria-label="New Shot"
          >
            <Plus className="h-3.5 w-3.5 stroke-[2.5] shrink-0" />
            <span
              className={`whitespace-nowrap transition-opacity duration-150 ${
                isCollapsedToRail ? 'opacity-0' : 'opacity-100'
              }`}
            >
              New Shot ({items.length}/{maxItems})
            </span>
          </button>

          {/* Right-Aligned Group: [Duplicate, Import .JSON, Show Help] */}
          <div className="flex items-center justify-end shrink-0 overflow-hidden">
            {/* Middle buttons ([Duplicate] + [Import .JSON]): smoothly collapse width & opacity when rail narrows */}
            <div
              className={`flex items-center gap-1.5 overflow-hidden transition-all duration-280 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                isCollapsedToRail
                  ? 'max-w-0 opacity-0 mr-0 pointer-events-none'
                  : 'max-w-[260px] opacity-100 mr-1.5'
              }`}
            >
              <button
                type="button"
                disabled={isAtMax}
                onClick={() => onDuplicate?.(safeIndex)}
                onMouseEnter={() =>
                  onHoverDescription?.(
                    isAtMax
                      ? `Maximum limit of ${maxItems} shots reached.`
                      : `Duplicate highlighted shot #${String(safeIndex + 1).padStart(2, '0')}.`
                  )
                }
                onMouseLeave={() => onHoverDescription?.(null)}
                className={`h-8 flex items-center gap-1 px-2.5 rounded-lg border text-xs font-semibold transition-colors shrink-0 whitespace-nowrap ${
                  isAtMax
                    ? 'opacity-40 cursor-not-allowed border-neutral-500/30'
                    : isLight
                    ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800 cursor-pointer active:scale-95'
                    : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200 cursor-pointer active:scale-95'
                }`}
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                <span>Duplicate</span>
              </button>

              <button
                type="button"
                onClick={onImport}
                onMouseEnter={() =>
                  onHoverDescription?.(
                    'Import a single shot configuration from a .json file into the current slot.'
                  )
                }
                onMouseLeave={() => onHoverDescription?.(null)}
                className={`h-8 flex items-center gap-1 px-2.5 rounded-lg border text-[11px] font-semibold cursor-pointer transition-colors shrink-0 whitespace-nowrap active:scale-95 ${
                  isLight
                    ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-700'
                    : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-300'
                }`}
              >
                <Upload className="h-3.5 w-3.5 shrink-0" />
                <span>Import .JSON</span>
              </button>
            </div>

            {/* Far-Right Show Help (Orange): 1px border + 6px left pad + 14px icon + 6px right pad + 1px border = 28px when collapsed */}
            <button
              type="button"
              data-rail-button="show-help"
              onClick={onShowHelp}
              onMouseEnter={() =>
                onHoverDescription?.(
                  'Show Help: Open 3D editor keyboard & mouse controls reference dialogue.'
                )
              }
              onMouseLeave={() => onHoverDescription?.(null)}
              style={{
                width: isCollapsedToRail ? 28 : 92,
              }}
              className={`h-8 rounded-lg border flex items-center px-[6px] gap-1 text-[11px] font-bold cursor-pointer overflow-hidden shrink-0 whitespace-nowrap transition-[width,background-color,border-color] duration-280 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-95 ${
                isLight
                  ? 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/40 text-amber-600'
                  : 'bg-amber-500/20 hover:bg-amber-500/30 border-amber-400/40 text-amber-400'
              }`}
              aria-label="Show Help"
            >
              <HelpCircle className="h-3.5 w-3.5 stroke-[2.25] shrink-0" />
              <span
                className={`whitespace-nowrap transition-opacity duration-150 ${
                  isCollapsedToRail ? 'opacity-0' : 'opacity-100'
                }`}
              >
                Show Help
              </span>
            </button>
          </div>
        </div>

        {/* Shared Vertical Scroll Container (`.no-scrollbar` completely hides vertical scrollbar):
            Each row card is `h-[42px] p-1` (4px padding on top, bottom, left, right) with `1px` border.
            The `#01` badge is permanently `w-[50px] h-8 shrink-0` (50px × 32px).
            When collapsed to 60px: 1px border + 4px left pad + 50px badge + 4px right pad + 1px border = 60px! */}
        <div
          data-rail-section="scroll-list"
          className="flex flex-col gap-1.5 overflow-y-auto overflow-x-hidden no-scrollbar grow min-h-0"
        >
          {items.map((item, idx) => {
            const isSelected = idx === safeIndex;
            const numStr = `#${String(idx + 1).padStart(2, '0')}`;

            return (
              <div
                key={item.id || idx}
                data-rail-item={idx}
                onClick={() => onSelectItem(idx)}
                onMouseEnter={() =>
                  onHoverDescription?.(
                    isCollapsedToRail
                      ? `Switch to ${numStr} (${item.title})`
                      : `Click to inspect & edit ${numStr} (${item.title}).`
                  )
                }
                onMouseLeave={() => onHoverDescription?.(null)}
                className={`h-[42px] shrink-0 w-full p-1 rounded-xl border flex items-center gap-2.5 overflow-hidden cursor-pointer transition-colors ${
                  isSelected
                    ? isLight
                      ? 'bg-white border-neutral-900 shadow-2xs'
                      : 'bg-neutral-800/95 border-neutral-200'
                    : isLight
                    ? 'bg-neutral-50/90 hover:bg-white border-neutral-200'
                    : 'bg-neutral-900/60 hover:bg-neutral-850 border-neutral-800'
                }`}
              >
                {/* Fixed Shot Number Badge (#01): Permanently 50px × 32px (`w-[50px] h-8 shrink-0`) */}
                <span
                  data-rail-badge={idx}
                  className={`font-mono text-xs font-extrabold w-[50px] h-8 rounded-lg border flex items-center justify-center shrink-0 transition-colors ${
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

                {/* Right-of-badge content: stays in DOM at constant height, fades opacity & gets clipped by row overflow-hidden */}
                <div
                  className={`flex items-center justify-between gap-2 flex-1 min-w-[320px] shrink-0 pr-1 transition-opacity duration-150 ${
                    isCollapsedToRail
                      ? 'opacity-0 pointer-events-none'
                      : 'opacity-100'
                  }`}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-bold truncate leading-tight">
                      {item.title}
                    </span>
                    {item.subtitle && (
                      <span className="text-[10px] font-mono opacity-65 truncate leading-tight">
                        {item.subtitle}
                      </span>
                    )}
                  </div>

                  <div
                    className="flex items-center gap-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => onReorder?.(idx, idx - 1)}
                      onMouseEnter={() =>
                        onHoverDescription?.(`Move ${numStr} up in the shot sequence.`)
                      }
                      onMouseLeave={() => onHoverDescription?.(null)}
                      className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                      aria-label="Move Up"
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === items.length - 1}
                      onClick={() => onReorder?.(idx, idx + 1)}
                      onMouseEnter={() =>
                        onHoverDescription?.(`Move ${numStr} down in the shot sequence.`)
                      }
                      onMouseLeave={() => onHoverDescription?.(null)}
                      className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                      aria-label="Move Down"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isAtMax}
                      onClick={() => onDuplicate?.(idx)}
                      onMouseEnter={() =>
                        onHoverDescription?.(`Duplicate ${numStr} (${item.title}).`)
                      }
                      onMouseLeave={() => onHoverDescription?.(null)}
                      className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 disabled:opacity-30 cursor-pointer"
                      aria-label="Duplicate Shot"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onExportItem?.(idx)}
                      onMouseEnter={() =>
                        onHoverDescription?.(`Export ${numStr} as a standalone .json file.`)
                      }
                      onMouseLeave={() => onHoverDescription?.(null)}
                      className="p-1.5 rounded-lg border border-neutral-500/30 hover:bg-neutral-500/15 cursor-pointer"
                      aria-label="Export Shot JSON"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={items.length <= 1}
                      onClick={() => onDeleteItem?.(idx)}
                      onMouseEnter={() =>
                        onHoverDescription?.(
                          items.length <= 1
                            ? 'Cannot delete the only remaining shot in the pack.'
                            : `Delete ${numStr} (${item.title}) from this pack.`
                        )
                      }
                      onMouseLeave={() => onHoverDescription?.(null)}
                      className="p-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/15 disabled:opacity-30 cursor-pointer"
                      aria-label="Delete Shot"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </motion.div>

      {/* Right Detail Inspector Pane:
          Uses `.no-scrollbar` and `pr-0` so right outer padding matches left outer padding (`12px` = `12px`) */}
      <div
        data-rail-section="detail-wrapper"
        className={`flex-1 min-w-0 h-full min-h-0 overflow-hidden transition-[margin,opacity] duration-280 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isCollapsedToRail
            ? 'ml-3 opacity-100 pointer-events-auto'
            : 'ml-0 opacity-0 pointer-events-none'
        }`}
      >
        <div
          data-rail-section="detail-scroll"
          className="w-full min-w-[380px] h-full min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar flex flex-col"
        >
          {detailContent}
        </div>
      </div>
    </div>
  );
};
