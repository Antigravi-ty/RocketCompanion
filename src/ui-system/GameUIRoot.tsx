import React, { useEffect, useRef, useState } from 'react';
import { GameViewport } from './core/GameViewport';
import { MenuShell } from './core/MenuShell';
import { useAppStore } from '../ui-core/stores/appStore';
import { copyAndLogLayoutSnapshot } from './core/UIInspector';
import {
  floatingStore,
  configureFloatingStorePersistence,
} from '../ui-core/stores/floatingStore';
import { FLOATING_WINDOW_OPACITY_PRESET } from '../ui-core/stores/floatingPresets';
import {
  getInitialFloatingOpacity,
  saveFloatingOpacity,
} from '../ui-core/config/uiConfig';
import { useStaticTrainingPackStore } from '../ui-core/stores/staticTrainingPackStore';
import { dialogue } from '../ui-core/compounds/dialogue/dialogueStore';
import { Copy, Check } from 'lucide-react';

configureFloatingStorePersistence({
  getInitialOpacity: getInitialFloatingOpacity,
  onSaveOpacity: saveFloatingOpacity,
});
floatingStore.setOpacity(getInitialFloatingOpacity());

export interface GameUIRootProps {
  portalContainer?: HTMLElement | null;
}

export const GameUIRoot: React.FC<GameUIRootProps> = ({ portalContainer }) => {
  const isOpen = useAppStore((s) => s.isOpen);
  const activeRoute = useAppStore((s) => s.activeRoute);
  const matchMode = useAppStore((s) => s.matchMode);
  const theme = useAppStore((s) => s.theme);
  const developerMode = useAppStore((s) => s.developerMode);
  const staticSessionMode = useStaticTrainingPackStore((s) => s.sessionMode);
  const isStaticTrainingEditActive =
    matchMode === 'static-training-pack' && staticSessionMode === 'edit';

  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isLight = theme === 'light';
  const opacityInitRef = useRef(false);

  // Auto-generate Floating Window Opacity in default Stack if Developer Mode is active
  useEffect(() => {
    if (developerMode && !opacityInitRef.current) {
      opacityInitRef.current = true;
      const existing = floatingStore.getSnapshot().windows.some(
        (w) => w.id === FLOATING_WINDOW_OPACITY_PRESET.id
      );
      if (!existing) {
        const w = FLOATING_WINDOW_OPACITY_PRESET.width ?? 320;
        const h = FLOATING_WINDOW_OPACITY_PRESET.height ?? 100;
        const centerPos = typeof window !== 'undefined' ? {
          x: Math.max(20, Math.round((window.innerWidth - w) / 2)),
          y: Math.max(20, Math.round((window.innerHeight - h) / 2)),
        } : undefined;

        floatingStore.spawnWindow({
          ...FLOATING_WINDOW_OPACITY_PRESET,
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

      if (dialogue.getCount() > 0) {
        return;
      }

      const state = useAppStore.getState();
      const packStore = useStaticTrainingPackStore.getState();
      const isEditSessionActive =
        state.matchMode === 'static-training-pack' && packStore.sessionMode === 'edit';

      // 1. Tab key:
      // - When menu is open on 'trajectory' or 'camera', toggles Live Preview dock
      // - When menu is closed and Static Training Pack Edit Mode is active, toggles EdgeInspectorDrawer
      if (e.key === 'Tab') {
        if (
          state.isOpen &&
          (state.activeRoute === 'trajectory' || state.activeRoute === 'camera')
        ) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          state.setLivePreviewCollapsed(!state.isLivePreviewCollapsed);
          return;
        }
        if (!state.isOpen && isEditSessionActive) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          packStore.toggleEdgeInspectorExpanded();
          return;
        }
      }

      // 2. Escape key exclusively handles the Main Menu navigation stack (completely orthogonal to EdgeInspectorDrawer)
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
          } else {
            state.goBack();
          }
        } else {
          state.openMenu('main-menu');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const handleInspect = async () => {
    const label = isOpen
      ? activeRoute
      : isStaticTrainingEditActive
      ? 'static-training-pack-edit'
      : activeRoute;
    await copyAndLogLayoutSnapshot(label);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div ref={rootRef} className="contents">
      <GameViewport>
        {/* Main Morphing Menu Shell with Left-Middle Inspector Slot */}
        <MenuShell
          inspectorSlot={
            isOpen || isStaticTrainingEditActive ? (
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
