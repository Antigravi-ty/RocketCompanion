import React, { createContext, useContext } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  UI_SPACING,
  UI_RADIUS,
  useInMorphContainer,
  type PanelSizingConfig,
  type PanelSizingMode,
} from '../tokens';
import { KeycapBadge } from '../primitives/KeycapBadge';

const PanelSizingModeContext = createContext<PanelSizingMode>('fixed');

export interface PanelHeaderProps {
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  onBack?: () => void;
  /** Keep the Back button permanently mounted in the header but disabled (prevents header height shift between root and detail views) */
  backDisabled?: boolean;
  rightElement?: React.ReactNode;
  actions?: React.ReactNode;
  isLight?: boolean;
}

/**
 * 3-Stage Compound Panel Header
 * Standardized SimpleUI .ui-panel__header pattern (px-6 py-4 / 24px horizontal, 16px vertical)
 */
export const PanelHeader: React.FC<PanelHeaderProps> = ({
  title,
  subtitle,
  badge,
  onBack,
  backDisabled = false,
  rightElement,
  actions,
  isLight = false,
}) => {
  return (
    <div
      data-ui-element="panel-header"
      data-panel-section="header"
      className={`flex items-center justify-between ${UI_SPACING.panel.header} border-b select-none shrink-0 transition-colors duration-150 ${
        isLight
          ? 'border-neutral-200/90 bg-neutral-100/50 text-neutral-900'
          : 'border-neutral-800/80 bg-neutral-950/40 text-white'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {onBack && (
          <button
            type="button"
            disabled={backDisabled}
            onClick={backDisabled ? undefined : onBack}
            className={`inline-flex items-center justify-center h-8 w-8 shrink-0 aspect-square rounded-lg border transition-all outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:focus-visible:ring-neutral-500 ${
              backDisabled
                ? isLight
                  ? 'bg-neutral-100/70 border-neutral-200/80 text-neutral-300 opacity-50 cursor-not-allowed'
                  : 'bg-neutral-900/50 border-neutral-800/60 text-neutral-600 opacity-50 cursor-not-allowed'
                : isLight
                ? 'bg-white hover:bg-neutral-100 border-neutral-300/80 text-neutral-700 shadow-2xs active:scale-95 cursor-pointer'
                : 'bg-neutral-800/80 hover:bg-neutral-700/80 border-neutral-700/60 text-neutral-200 shadow-2xs active:scale-95 cursor-pointer'
            }`}
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
          </button>
        )}

        <div className="flex flex-col text-left leading-tight min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold tracking-tight uppercase truncate">
              {title}
            </h2>
            {badge}
          </div>
          {subtitle && (
            <p className={`text-xs mt-0.5 font-normal truncate ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 ml-3">
        {rightElement ?? actions ?? null}
      </div>
    </div>
  );
};

export interface PanelContentProps {
  children: React.ReactNode;
  className?: string;
  scrollable?: boolean;
  isLight?: boolean;
  style?: React.CSSProperties;
}

/**
 * 3-Stage Compound Panel Content Body
 * Standardized SimpleUI .ui-panel__content pattern (p-6 / 24px uniform padding)
 * - In 'fixed' sizing mode: `flex-1 min-h-0` fills the locked container height.
 * - In 'auto' sizing mode: `flex-initial min-h-0` fits natural content height while shrinking to scroll when hitting maxHeight/availH.
 */
export const PanelContent: React.FC<PanelContentProps> = ({
  children,
  className = '',
  scrollable = true,
  style,
}) => {
  const sizingMode = useContext(PanelSizingModeContext);
  const flexClass = sizingMode === 'auto' ? 'flex-initial min-h-0' : 'flex-1 min-h-0';

  return (
    <div
      data-ui-element="panel-content"
      data-panel-section="content"
      style={style}
      className={`flex flex-col ${flexClass} ${UI_SPACING.panel.body} w-full box-border ${
        scrollable ? 'overflow-y-auto' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
};

export interface PanelFooterProps {
  children?: React.ReactNode;
  hint?: string;
  isLight?: boolean;
  className?: string;
}

/**
 * 3-Stage Compound Panel Footer
 * Standardized SimpleUI .ui-panel__footer pattern (px-6 py-3.5) with secondary surface background.
 */
export const PanelFooter: React.FC<PanelFooterProps> = ({
  children,
  hint,
  isLight = false,
  className = '',
}) => {
  return (
    <div
      data-ui-element="panel-footer"
      data-panel-section="footer"
      className={`flex items-center justify-between ${UI_SPACING.panel.footer} border-t text-xs select-none shrink-0 mt-auto relative z-10 transition-colors duration-150 ${
        isLight
          ? 'border-neutral-200/90 text-neutral-600 bg-neutral-100/60'
          : 'border-neutral-800/80 text-neutral-400 bg-neutral-950/50'
      } ${className}`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">{children}</div>
      {hint && (
        <div className="shrink-0 ml-3">
          <KeycapBadge size="sm" isLight={isLight}>
            {hint}
          </KeycapBadge>
        </div>
      )}
    </div>
  );
};

export interface PanelContainerProps {
  children: React.ReactNode;
  isLight?: boolean;
  className?: string;
  transparent?: boolean;
  /** Unified per-panel sizing contract ('auto' clamping vs 'fixed' height) */
  sizing?: PanelSizingConfig;
  /** Legacy / explicit outer container height (in px or CSS string) when rendered standalone outside MorphContainer */
  height?: number | string;
  /** Legacy / explicit outer container max-width (in px or CSS string) */
  width?: number | string;
  style?: React.CSSProperties;
}

/**
 * PanelContainer
 * Shell wrapping the 3-stage panel hierarchy (Header -> Content -> Footer).
 * Supports dual sizing modes ('auto' content-fit with min/max clamping vs 'fixed' targetHeight with viewport fallback).
 */
export const PanelContainer: React.FC<PanelContainerProps> = ({
  children,
  isLight = false,
  className = '',
  transparent,
  sizing,
  height,
  width,
  style,
}) => {
  const inMorphContainer = useInMorphContainer();
  const isTransparent = transparent ?? inMorphContainer;

  // When inside MorphContainer, omit inner border/shadow to prevent duplicate styling
  const effectiveClassName = isTransparent
    ? className
        .replace(/shadow-\[[^\]]+\]/g, '')
        .replace(/\bshadow(-\w+)?\b/g, '')
        .trim()
    : className;

  const effectiveWidth = sizing?.width ?? width;
  const resolvedMaxWidth =
    effectiveWidth !== undefined
      ? typeof effectiveWidth === 'number'
        ? `${effectiveWidth}px`
        : effectiveWidth
      : undefined;

  const sizingMode: PanelSizingMode = sizing?.mode ?? 'fixed';

  // Compute standalone container height constraints when outside MorphContainer
  const standaloneSizingStyle: React.CSSProperties = {};
  if (!inMorphContainer) {
    if (sizing) {
      if (sizing.mode === 'auto') {
        standaloneSizingStyle.height = 'auto';
        standaloneSizingStyle.minHeight = `min(${sizing.minHeight}px, var(--avail-h, 100vh))`;
        standaloneSizingStyle.maxHeight = `min(${sizing.maxHeight}px, var(--avail-h, 100vh))`;
      } else {
        standaloneSizingStyle.height = `min(${sizing.targetHeight}px, var(--avail-h, 100vh))`;
        standaloneSizingStyle.maxHeight = `min(${sizing.targetHeight}px, var(--avail-h, 100vh))`;
      }
    } else if (height !== undefined) {
      const hStr = typeof height === 'number' ? `${height}px` : height;
      standaloneSizingStyle.height = `min(${hStr}, var(--avail-h, 100vh))`;
      standaloneSizingStyle.maxHeight = `min(${hStr}, var(--avail-h, 100vh))`;
    }
  }

  return (
    <PanelSizingModeContext.Provider value={sizingMode}>
      <div
        data-panel="container"
        data-sizing-mode={sizingMode}
        style={{
          ...standaloneSizingStyle,
          ...(resolvedMaxWidth ? { maxWidth: resolvedMaxWidth } : {}),
          ...style,
        }}
        className={`flex flex-col ${
          inMorphContainer ? 'h-full' : sizing?.mode === 'auto' ? 'h-auto' : 'h-full'
        } w-full overflow-hidden transition-colors ${
          isTransparent
            ? 'bg-transparent border-0 ring-0 shadow-none'
            : `${UI_RADIUS.xl} border shadow-2xl ${
                isLight
                  ? 'bg-neutral-50/98 border-neutral-300/80 text-neutral-900 ring-1 ring-black/5'
                  : 'bg-neutral-900/98 border-neutral-700/60 text-neutral-100 ring-1 ring-white/10'
              }`
        } ${effectiveClassName}`}
      >
        {children}
      </div>
    </PanelSizingModeContext.Provider>
  );
};
