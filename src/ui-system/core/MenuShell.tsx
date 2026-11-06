import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../ui-core/stores/appStore';
import { useViewportStore } from '../../ui-core/stores/viewportStore';
import { type ActiveMenuRoute } from '../../ui-core/config/uiConfig';
import { MorphingShell } from '../../ui-core/navigation/MorphingShell';
import { FloatingStackIcon } from '../../ui-core/navigation/FloatingStackIcon';
import { FloatingWindowManager } from '../../ui-core/navigation/FloatingWindowManager';
import {
  renderFloatingWindowContent,
  handleFloatingStackCloseWindow,
} from './runtimeFloatingWindowLifecycle';
import { HitboxReferenceOverlayLayer } from './HitboxReferenceOverlayLayer';
import { QuickNotificationSystem } from '../../ui-core/navigation/QuickNotificationSystem';
import { DialogueStackContainer } from '../../ui-core/compounds/Dialogue';
import { useQuickNotificationStore } from '../../ui-core/stores/quickNotificationStore';
import '../../ui-core/stores/cameraDeterminismStore';
import { useMenuLayoutStore } from '../../ui-core/stores/menuLayoutStore';
import { DEFAULT_PANEL_SIZING } from '../../ui-core/tokens/menuLayoutTokens';
import { StaticTrainingShotInspectorDrawer } from '../../ui-core/recipes/StaticTrainingShotInspectorDrawer';
import { EdgeInspectorDrawer } from '../../ui-core/navigation/EdgeInspectorDrawer';
import { useStaticTrainingPackStore } from '../../ui-core/stores/staticTrainingPackStore';
import { StaticTrainingPackHUD } from '../../ui-core/hud/StaticTrainingPackHUD';
import { useLivePreviewDockTransition } from './useLivePreviewDockTransition';
import {
  ROUTE_TO_PANEL_ID,
  renderActiveMenuRoute,
} from './menuRouteRegistry';

export interface MenuShellProps {
  inspectorSlot?: React.ReactNode;
}

export const MenuShell: React.FC<MenuShellProps> = ({ inspectorSlot }) => {
  const isOpen = useAppStore((s) => s.isOpen);
  const closeMenu = useAppStore((s) => s.closeMenu);
  const activeRoute = useAppStore((s) => s.activeRoute);
  const navigate = useAppStore((s) => s.navigate);
  const goBack = useAppStore((s) => s.goBack);
  const theme = useAppStore((s) => s.theme);
  const matchMode = useAppStore((s) => s.matchMode);
  const bridge = useAppStore((s) => s.bridge);
  const isLivePreviewCollapsed = useAppStore((s) => s.isLivePreviewCollapsed);
  const setLivePreviewCollapsed = useAppStore((s) => s.setLivePreviewCollapsed);
  const settingsTargetTab = useAppStore((s) => s.settingsTargetTab);
  const setSettingsTargetTab = useAppStore((s) => s.setSettingsTargetTab);
  const highlightSetting = useAppStore((s) => s.highlightSetting);
  const clearHighlightSetting = useAppStore((s) => s.clearHighlightSetting);
  const onlineSession = useAppStore((s) => s.onlineSession);
  const setMatchMode = useAppStore((s) => s.setMatchMode);
  const { renderScale: uiScale = 100, safeAreaMargin = 0 } = useViewportStore();

  const staticSessionMode = useStaticTrainingPackStore((s) => s.sessionMode);
  const isEdgeInspectorExpanded = useStaticTrainingPackStore((s) => s.isEdgeInspectorExpanded);
  const setEdgeInspectorExpanded = useStaticTrainingPackStore((s) => s.setEdgeInspectorExpanded);

  const isStaticTrainingEditActive =
    matchMode === 'static-training-pack' && staticSessionMode === 'edit';
  const hasExtraMainMenuItem =
    matchMode === 'match' ||
    matchMode === 'online-warmup' ||
    Boolean(onlineSession?.roomId);

  const isLight = theme === 'light';
  const developerMode = useAppStore((s) => s.developerMode);
  const isLayer1 = activeRoute === 'main-menu';
  const activePanelId = ROUTE_TO_PANEL_ID[activeRoute] || 'layer1-main';
  const activeSizing = useMenuLayoutStore(
    (s) => s.panels?.[activePanelId] ?? DEFAULT_PANEL_SIZING[activePanelId]
  );
  const expConfigParentRef = useRef<ActiveMenuRoute>('settings');
  const exhibitionParentRef = useRef<ActiveMenuRoute>('play');

  const {
    isDockState,
    isContentVisible,
    isPillContentVisible,
    handleTriggerCollapse,
    handleTriggerExpand,
    resetToExpanded,
  } = useLivePreviewDockTransition({
    activeRoute,
    isLivePreviewCollapsed,
    setLivePreviewCollapsed,
    bridge,
  });

  const [isShaking, setIsShaking] = useState(false);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerShake = () => {
    if (isShaking) return;
    setIsShaking(true);
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => {
      setIsShaking(false);
    }, 360);
  };

  useEffect(() => {
    return () => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (matchMode === 'online-warmup' && !onlineSession.signalingConnected) {
      useQuickNotificationStore.getState().pushNotification({
        id: 'signaling-disconnect',
        type: 'persistent',
        tone: 'warning',
        icon: 'wifi-off',
        duration: 0,
        content: 'Signaling server disconnected. Match continuing peer-to-peer.',
        buttons: [
          {
            label: 'Reconnect',
            color: 'amber',
            onClick: () => {
              useAppStore.getState().bridge.onReconnectSignaling?.();
            },
          },
        ],
      });
    } else {
      useQuickNotificationStore.getState().dismissNotification('signaling-disconnect');
    }
  }, [matchMode, onlineSession.signalingConnected]);

  return (
    <>
      <QuickNotificationSystem isLight={isLight} placement="bottom-right" />
      <HitboxReferenceOverlayLayer />
      <FloatingWindowManager
        isLight={isLight}
        renderWindowContent={renderFloatingWindowContent}
      />
      {matchMode === 'static-training-pack' && <StaticTrainingPackHUD isLight={isLight} />}
      <FloatingStackIcon
        isLight={isLight}
        absolute={true}
        isMenuOpen={isOpen && !isDockState}
        blockedTooltipText={
          activeRoute === 'settings'
            ? 'Please close settings window first'
            : 'Please close active menu first'
        }
        onBlockedClick={() => {
          triggerShake();
        }}
        onCloseWindowItem={handleFloatingStackCloseWindow}
      />

      {isStaticTrainingEditActive && (
        <EdgeInspectorDrawer
          isExpanded={isEdgeInspectorExpanded}
          onExpandedChange={(expanded) => {
            setEdgeInspectorExpanded(expanded);
          }}
          side="right"
          topOffset={72}
          bottomOffset={184}
          expandedWidth={520}
          enableHotkey={false}
          isLight={isLight}
        >
          <StaticTrainingShotInspectorDrawer
            isLight={isLight}
            transparent={true}
            onCollapseDrawer={() => setEdgeInspectorExpanded(false)}
          />
        </EdgeInspectorDrawer>
      )}
      {!isOpen && isStaticTrainingEditActive && inspectorSlot}

      <MorphingShell
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) closeMenu();
        }}
        width={activeSizing.width}
        height={activeSizing.targetHeight}
        sizing={activeSizing}
        currentKey={activeRoute}
        isLight={isLight}
        isLayer1={isLayer1}
        isDockState={isDockState}
        isContentVisible={isContentVisible}
        isPillContentVisible={isPillContentVisible}
        onExpandDock={handleTriggerExpand}
        isShaking={isShaking}
        onBack={goBack}
        inspectorSlot={inspectorSlot}
        uiScale={uiScale}
        safeAreaMargin={safeAreaMargin}
        hasExtraMainMenuItem={hasExtraMainMenuItem}
        developerMode={developerMode}
      >
        {renderActiveMenuRoute({
          activeRoute,
          isLight,
          isStaticTrainingEditActive,
          settingsTargetTab,
          setSettingsTargetTab,
          highlightSetting,
          clearHighlightSetting,
          bridge,
          navigate,
          goBack,
          closeMenu,
          setMatchMode,
          handleTriggerCollapse,
          resetLivePreviewToExpanded: resetToExpanded,
          expConfigParentRef,
          exhibitionParentRef,
        })}
      </MorphingShell>
      <DialogueStackContainer isLight={isLight} />
    </>
  );
};
