import React, { useEffect, useRef, useState } from 'react';
import { GameViewport } from './core/GameViewport';
import { MenuShell } from './core/MenuShell';
import { useAppStore } from '../stores/appStore';
import { copyAndLogLayoutSnapshot } from './core/UIInspector';
import { floatingStore } from '../stores/floatingStore';
import { OPACITY_MANAGER_PRESET } from '../stores/floatingPresets';
import { useStaticTrainingPackStore } from '../stores/staticTrainingPackStore';
import { promptExitStaticTrainingEditSession } from './recipes/Layer5StaticTrainingPackEditRecipe';
import { Copy, Check } from 'lucide-react';

export interface GameUIRootProps {
  portalContainer?: HTMLElement | null;
}

export const GameUIRoot: React.FC<GameUIRootProps> = ({ portalContainer }) => {
  const isOpen = useAppStore((s) => s.isOpen);
  const activeRoute = useAppStore((s) => s.activeRoute);
  const openMenu = useAppStore((s) => s.openMenu);
  const goBack = useAppStore((s) => s.goBack);
  const closeMenu = useAppStore((s) => s.closeMenu);
  const theme = useAppStore((s) => s.theme);
  const isLivePreviewCollapsed = useAppStore((s) => s.isLivePreviewCollapsed);
  const setLivePreviewCollapsed = useAppStore((s) => s.setLivePreviewCollapsed);
  const developerMode = useAppStore((s) => s.developerMode);

  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isLight = theme === 'light';
  const opacityInitRef = useRef(false);

  // Auto-generate Floating Window Opacity Manager in default Stack if Developer Mode is active
  useEffect(() => {
    if (developerMode && !opacityInitRef.current) {
      opacityInitRef.current = true;
      const existing = floatingStore.getSnapshot().windows.some(
        (w) => w.id === OPACITY_MANAGER_PRESET.id
      );
      if (!existing) {
        const w = OPACITY_MANAGER_PRESET.width ?? 320;
        const h = OPACITY_MANAGER_PRESET.height ?? 100;
        const centerPos = typeof window !== 'undefined' ? {
          x: Math.max(20, Math.round((window.innerWidth - w) / 2)),
          y: Math.max(20, Math.round((window.innerHeight - h) / 2)),
        } : undefined;

        floatingStore.spawnWindow({
          ...OPACITY_MANAGER_PRESET,
          position: centerPos,
          startMinimized: true,
        });
      }
    }
  }, [developerMode]);

  // Global hotkeys: Escape and TAB
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e as any).__keybindingCaptureHandled) {
        return;
      }

      const state = useAppStore.getState();

      // 1. Tab key toggles Live Preview / Edge Inspector Drawer when in trajectory, camera, or static-training-pack-session mode
      if (e.key === 'Tab') {
        if (
          state.isOpen &&
          (state.activeRoute === 'trajectory' ||
            state.activeRoute === 'camera' ||
            state.activeRoute === 'static-training-pack-session')
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          state.setLivePreviewCollapsed(!state.isLivePreviewCollapsed);
          return;
        }
      }

      // 2. Escape key handles navigation stack one level at a time
      if (e.key === 'Escape') {
        if (e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (state.isOpen) {
          if (state.isLivePreviewCollapsed) {
            state.setLivePreviewCollapsed(false);
          } else if (state.activeRoute === 'static-training-pack-session') {
            const packStore = useStaticTrainingPackStore.getState();
            if (packStore.isEditingItem) {
              void packStore.deselectEditShot();
            } else {
              promptExitStaticTrainingEditSession(() => {
                state.goBack();
              });
            }
          } else {
            state.goBack();
          }
        } else if (state.matchMode === 'static-training-pack') {
          state.openMenu('static-training-pack');
        } else {
          state.openMenu('main-menu');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const handleInspect = async () => {
    await copyAndLogLayoutSnapshot(activeRoute);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div ref={rootRef} className="contents">
      <GameViewport>
        {/* Main Morphing Menu Shell with Left-Middle Inspector Slot */}
        <MenuShell
          inspectorSlot={
            isOpen ? (
              <button
                type="button"
                data-ui-element="ui-inspector-btn"
                onClick={handleInspect}
                className={`absolute left-4 top-1/2 -translate-y-1/2 z-[9999] pointer-events-auto flex items-center justify-center p-2.5 rounded-xl text-xs font-mono font-medium shadow-xl border backdrop-blur-md transition-all active:scale-95 cursor-pointer ${
                  isLight
                    ? 'bg-white/95 text-neutral-800 border-neutral-300 hover:bg-neutral-100 shadow-neutral-300/50'
                    : 'bg-neutral-900/95 text-neutral-100 border-neutral-700 hover:bg-neutral-800 shadow-black/60'
                }`}
                title="Export menu layout data (logged to console and copied to clipboard)"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-500 stroke-[3]" />
                    <span className="sr-only">Copied layout data to clipboard</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 text-amber-500" />
                    <span className="sr-only">Export current menu layout data</span>
                  </>
                )}
              </button>
            ) : null
          }
        />
      </GameViewport>
    </div>
  );
};
