import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { KeycapBadge } from '../primitives/KeycapBadge';
import { UI_EASING } from '../tokens/easing';
import { MorphContainerContext } from '../tokens/morphContext';

export type EdgeDrawerSide = 'right' | 'left';

export interface EdgeInspectorDrawerProps {
  /** Whether the inspector drawer is expanded (true) or collapsed to an edge pill (false) */
  isExpanded: boolean;
  /** Callback when expanded state changes via click or hotkey */
  onExpandedChange: (expanded: boolean) => void;
  /** Dock edge: 'right' (default) or 'left' */
  side?: EdgeDrawerSide;
  /** Expanded drawer width in px (default: 520px) */
  expandedWidth?: number;
  /** Collapsed edge pill width in px (default: 88px) */
  collapsedWidth?: number;
  /** Collapsed edge pill height in px (default: 38px) */
  collapsedHeight?: number;
  /** Top vertical clearance in px (default: 72px — clears topFloating Stack Icon & Notification tray) */
  topOffset?: number;
  /** Bottom vertical clearance in px (default: 184px — clears bottom-right 148px Circular Boost Gauge + 20px margin + 16px gap) */
  bottomOffset?: number;
  /** Horizontal edge margin in px (default: 16px) */
  edgeMargin?: number;
  /** Hotkey label displayed on the collapsed pill and listened on window (default: 'TAB') */
  shortcutKey?: string;
  /** Whether to listen to the keyboard shortcut (default: true) */
  enableHotkey?: boolean;
  /** Positioning mode: 'absolute' inside stage container (default) or 'fixed' to viewport */
  positionMode?: 'absolute' | 'fixed';
  /** Light or dark theme */
  isLight?: boolean;
  /** Optional className applied to the morphing shell */
  className?: string;
  /** Content rendered inside the expanded inspector drawer */
  children: React.ReactNode;
}

export type EdgeDrawerAnimPhase =
  | 'expanded'
  | 'collapsing_content'
  | 'collapsing_resize'
  | 'collapsed'
  | 'expanding_content'
  | 'expanding_resize';

/**
 * [L4 Motion / L6 Pattern] EdgeInspectorDrawer (Apple HIG Zero-Backdrop Edge Inspector)
 *
 * Designed for live in-game 3D editors & training inspectors:
 * - Zero backdrop darkening (never dims or blocks the underlying 3D arena).
 * - Anchored to `'right'` (default) or `'left'` edge with explicit `topOffset` and `bottomOffset`
 *   to avoid colliding with HUD elements like the bottom-right Circular Boost Gauge (148×148px at bottom: 20px).
 * - Sequenced Step Morph between `collapsedWidth` (88×38px edge pill) and `expandedWidth` (520px inspector).
 * - Listens to `TAB` (or custom `shortcutKey`) to toggle between collapsed pill and expanded drawer.
 */
export const EdgeInspectorDrawer: React.FC<EdgeInspectorDrawerProps> = ({
  isExpanded,
  onExpandedChange,
  side = 'right',
  expandedWidth = 520,
  collapsedWidth = 88,
  collapsedHeight = 38,
  topOffset = 72,
  bottomOffset = 184,
  edgeMargin = 16,
  shortcutKey = 'TAB',
  enableHotkey = true,
  positionMode = 'absolute',
  isLight = false,
  className = '',
  children,
}) => {
  const [phase, setPhase] = useState<EdgeDrawerAnimPhase>(
    isExpanded ? 'expanded' : 'collapsed'
  );
  const [isPillHovered, setIsPillHovered] = useState(false);

  // Sync external `isExpanded` prop changes with internal sequenced state machine
  useEffect(() => {
    if (isExpanded && (phase === 'collapsed' || phase === 'collapsing_resize')) {
      setPhase('expanding_content');
      const t1 = setTimeout(() => {
        setPhase('expanding_resize');
        const t2 = setTimeout(() => {
          setPhase('expanded');
        }, 250);
        return () => clearTimeout(t2);
      }, 70);
      return () => clearTimeout(t1);
    }
    if (!isExpanded && (phase === 'expanded' || phase === 'expanding_resize')) {
      setPhase('collapsing_content');
      const t1 = setTimeout(() => {
        setPhase('collapsing_resize');
        const t2 = setTimeout(() => {
          setPhase('collapsed');
        }, 250);
        return () => clearTimeout(t2);
      }, 90);
      return () => clearTimeout(t1);
    }
  }, [isExpanded]);

  // Listen for TAB (or custom shortcutKey)
  useEffect(() => {
    if (!enableHotkey) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key.toUpperCase() === shortcutKey.toUpperCase()) {
        e.preventDefault();
        e.stopPropagation();
        onExpandedChange(!isExpanded);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enableHotkey, shortcutKey, isExpanded, onExpandedChange]);

  const isDockGeometry =
    phase === 'collapsed' ||
    phase === 'collapsing_resize' ||
    phase === 'expanding_content';
  const isContentVisible = phase === 'expanded';
  const isPillVisible = phase === 'collapsed';

  // Position styles anchored to either right or left edge, respecting topOffset & bottomOffset
  const horizontalAnchorStyle: React.CSSProperties =
    side === 'right' ? { right: edgeMargin } : { left: edgeMargin };

  // When expanded, fill available vertical span between topOffset and bottomOffset.
  // When collapsed to pill, vertically center within the safe span [topOffset, 100% - bottomOffset].
  const verticalAnchorStyle: React.CSSProperties = isDockGeometry
    ? {
        top: `calc(${topOffset}px + (100% - ${topOffset + bottomOffset}px - ${collapsedHeight}px) / 2)`,
        height: collapsedHeight,
      }
    : {
        top: `${topOffset}px`,
        height: `calc(100% - ${topOffset + bottomOffset}px)`,
      };

  const ExpandChevron = side === 'right' ? ChevronLeft : ChevronRight;
  const hoverNudgeX = side === 'right' ? -2.5 : 2.5;

  return (
    <MorphContainerContext.Provider value={true}>
      <motion.div
        data-ui-element="edge-inspector-drawer"
        data-side={side}
        data-expanded={!isDockGeometry}
        initial={false}
        animate={{
          width: isDockGeometry ? collapsedWidth : expandedWidth,
          borderRadius: isDockGeometry ? 12 : 16,
        }}
        transition={{
          duration: 0.28,
          ease: UI_EASING.apple,
        }}
        style={{
          position: positionMode,
          ...horizontalAnchorStyle,
          ...verticalAnchorStyle,
        }}
        className={`z-50 pointer-events-auto select-none overflow-hidden flex flex-col transition-[top,height,box-shadow] duration-280 ease-[cubic-bezier(0.2,0.8,0.25,1)] ${
          isDockGeometry
            ? isLight
              ? 'border border-neutral-300 bg-white/95 hover:bg-white text-neutral-900 shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.14)] backdrop-blur-md cursor-pointer'
              : 'border border-neutral-700 bg-neutral-900/95 hover:bg-neutral-850 text-neutral-100 shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_8px_24px_rgba(0,0,0,0.65)] backdrop-blur-md cursor-pointer'
            : isLight
            ? 'border border-neutral-300/90 bg-neutral-50/96 text-neutral-900 shadow-[0_0_0_1px_rgba(0,0,0,0.10),0_16px_40px_rgba(0,0,0,0.18)] backdrop-blur-xl'
            : 'border border-neutral-700/70 bg-neutral-900/96 text-neutral-100 shadow-[0_0_0_1px_rgba(255,255,255,0.14),0_20px_48px_rgba(0,0,0,0.82)] backdrop-blur-xl'
        } ${className}`}
        onClick={isDockGeometry ? () => onExpandedChange(true) : undefined}
        onMouseEnter={() => isDockGeometry && setIsPillHovered(true)}
        onMouseLeave={() => setIsPillHovered(false)}
      >
        {isDockGeometry ? (
          <div
            className={`w-full h-full flex items-center justify-between px-3 cursor-pointer select-none transition-opacity duration-150 ${
              isPillVisible ? 'opacity-100' : 'opacity-0'
            } ${side === 'left' ? 'flex-row-reverse' : 'flex-row'}`}
          >
            <motion.div
              animate={{ x: isPillHovered ? hoverNudgeX : 0 }}
              transition={UI_EASING.spring.tactile}
              className={`flex items-center justify-center shrink-0 ${
                isLight ? 'text-neutral-900' : 'text-neutral-100'
              }`}
            >
              <ExpandChevron className="h-4 w-4 stroke-[2.5]" />
            </motion.div>

            <div
              className={`h-3.5 w-px ${
                isLight ? 'bg-neutral-200' : 'bg-neutral-700'
              }`}
            />

            <KeycapBadge shortcut={shortcutKey} size="sm" isLight={isLight} />
          </div>
        ) : (
          <div
            className={`w-full h-full flex flex-col min-h-0 transition-opacity ${
              isContentVisible
                ? 'opacity-100 pointer-events-auto duration-150'
                : 'opacity-0 pointer-events-none duration-100'
            }`}
          >
            {children}
          </div>
        )}
      </motion.div>
    </MorphContainerContext.Provider>
  );
};
