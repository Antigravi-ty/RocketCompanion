import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { GameUIRoot } from './GameUIRoot';
import { useAppStore } from '../ui-core/stores/appStore';
import { type ActiveMenuRoute } from '../ui-core/config/uiConfig';
import { perfTelemetryStore } from '../ui-core/stores/perfTelemetryStore';
import { attachGameRuntimeBridge, syncMaterialsToGame } from './core/runtimeBridgeAdapter';
import { ensureSignalingProfileBridge } from './core/runtimeOnlineBridgeHandlers';
import type { GameRuntimeUiBridgePort } from '../game/runtimeUiPort.ts';
import '../styles/ui-system.css';

export { syncMaterialsToGame };

export interface GameUIRuntimeHandle {
  openMenu: (route?: ActiveMenuRoute) => void;
  closeMenu: () => void;
  toggleMenu: () => void;
  attachToRuntime: (gameRuntime: GameRuntimeUiBridgePort) => void;
  syncVisualMaterials?: () => void;
  destroy: () => void;
}

export function mountGameUI(
  container: HTMLElement,
  gameRuntime?: GameRuntimeUiBridgePort | null,
): GameUIRuntimeHandle {
  let rootEl = container.querySelector<HTMLElement>('#game-ui-root');
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = 'game-ui-root';
    rootEl.style.position = 'absolute';
    rootEl.style.inset = '0';
    rootEl.style.pointerEvents = 'none';
    rootEl.style.zIndex = '500';
    container.appendChild(rootEl);
  }

  ensureSignalingProfileBridge();
  let activeRuntime = gameRuntime ?? null;
  if (activeRuntime) {
    attachGameRuntimeBridge(activeRuntime);
  }

  const root: Root = createRoot(rootEl);
  root.render(<GameUIRoot portalContainer={rootEl} />);

  return {
    openMenu: (route = 'main-menu') => useAppStore.getState().openMenu(route),
    closeMenu: () => useAppStore.getState().closeMenu(),
    toggleMenu: () => useAppStore.getState().toggleMenu(),
    attachToRuntime: (nextRuntime: GameRuntimeUiBridgePort) => {
      activeRuntime = nextRuntime;
      if (activeRuntime) {
        attachGameRuntimeBridge(activeRuntime);
      }
    },
    syncVisualMaterials: () => syncMaterialsToGame(activeRuntime),
    destroy: () => {
      perfTelemetryStore.setSampler(null);
      root.unmount();
      rootEl?.remove();
    },
  };
}
