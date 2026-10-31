import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../../ui-core/stores/appStore';
import { calculateSettingsSafeScale } from '../../ui-core/config/uiConfig';
import { useUIStore, ViewportMetrics } from '../../ui-core/stores/uiStore';
import { SafeAreaHud } from './SafeAreaHud';
import { InGameHUD } from '../../ui-core/hud/InGameHUD';
import { AlertTriangle, ChevronRight, Bot, Menu, Router } from 'lucide-react';

interface GameViewportProps {
  children: React.ReactNode;
}

export const GameViewport: React.FC<GameViewportProps> = ({ children }) => {
  const safeAreaMargin = useUIStore((s) => s.safeAreaMargin);
  const uiScale = useUIStore((s) => s.uiScale ?? 100);
  const activeRoute = useAppStore((s) => s.activeRoute);
  const isOpen = useAppStore((s) => s.isOpen);
  const openMenu = useAppStore((s) => s.openMenu);
  const touchMode = useAppStore((s) => s.touchMode);
  const touchHeadlessMode = useAppStore((s) => s.touchHeadlessMode);
  const touchInputAgent = useAppStore((s) => s.touchInputAgent);
  const setTouchInputAgent = useAppStore((s) => s.setTouchInputAgent);
  const matchMode = useAppStore((s) => s.matchMode);
  const onlineSession = useAppStore((s) => s.onlineSession);
  const metrics = useUIStore((s) => s.metrics);
  const setMetrics = useUIStore((s) => s.setMetrics);
  const portraitDismissed = useUIStore((s) => s.portraitDismissed);
  const dismissPortraitGate = useUIStore((s) => s.dismissPortraitGate);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const computeAndApply = () => {
      if (typeof window === 'undefined') return;

      const Wwin = window.innerWidth;
      const Hwin = window.innerHeight;

      // 1. Safe Area Margin (-5% to +10%)
      const marginW = Wwin * (safeAreaMargin / 100);
      const marginH = Hwin * (safeAreaMargin / 100);
      const Wsafe = Math.max(100, Wwin - marginW * 2);
      const Hsafe = Math.max(100, Hwin - marginH * 2);

      // 2. 18:9 aspect ratio clamp (max width is Hsafe * 2.0)
      const maxRenderW = Hsafe * 2.0;
      const Wrender = Math.min(Wsafe, maxRenderW);
      const Hrender = Hsafe;

      const isPillarboxed = Wsafe > maxRenderW;
      const pillarboxWidth = isPillarboxed ? (Wsafe - Wrender) / 2 : 0;
      const isPortrait = Wsafe < Hsafe;

      // UI Zoom is 100% user-controlled (no automatic resolution-based scaling)
      const scaleFactor = Number((uiScale / 100).toFixed(3));

      const newMetrics: ViewportMetrics = {
        scaleFactor,
        renderWidth: Wrender,
        renderHeight: Hrender,
        isPortrait,
        isPillarboxed,
        pillarboxWidth,
        safeMarginPct: safeAreaMargin
      };

      setMetrics(newMetrics);

      // 3. Inject CSS Variables onto Document Root (SimpleUI architecture)
      const root = document.documentElement;
      root.style.setProperty('--ui-scale', String(scaleFactor));
      root.style.setProperty('--ui-user-scale', `${uiScale}%`);
      root.style.setProperty('--ui-render-width', `${Math.round(Wrender)}px`);
      root.style.setProperty('--ui-render-height', `${Math.round(Hrender)}px`);
      root.style.setProperty('--ui-pillarbox-width', `${Math.round(pillarboxWidth)}px`);
      root.style.setProperty('--ui-safe-margin', `${safeAreaMargin}%`);
      root.style.setProperty('--ui-safe-margin-x', `${Math.round(marginW)}px`);
      root.style.setProperty('--ui-safe-margin-y', `${Math.round(marginH)}px`);
    };

    computeAndApply();
    window.addEventListener('resize', computeAndApply);
    return () => window.removeEventListener('resize', computeAndApply);
  }, [safeAreaMargin, uiScale, setMetrics]);

  return (
    <div
      ref={viewportRef}
      id="game-ui-viewport-host"
      className="fixed inset-0 pointer-events-none select-none overflow-hidden"
    >
      {/* Headless React-Only Backdrop when ?touch=2 is active (No Three.js Rendering) */}
      {touchHeadlessMode && (
        <div
          className="fixed inset-0 bg-neutral-950 pointer-events-auto flex flex-col items-center justify-center p-4"
          onClick={() => {
            if (!isOpen) {
              openMenu('main-menu');
            }
          }}
        >
          {!isOpen && (
            <div
              className="max-w-sm w-full rounded-2xl border border-neutral-800 bg-neutral-900/90 p-5 shadow-2xl flex flex-col gap-4 font-mono text-neutral-200"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                <div className="flex items-center gap-2 text-amber-400 font-bold text-xs uppercase tracking-wider">
                  <Bot className="h-4 w-4" />
                  <span>Headless Touch Mode (?touch=2)</span>
                </div>
                <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                  React Only · No 3D
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-neutral-950/80 border border-neutral-800/80">
                  <div className="text-[10px] text-neutral-500 uppercase">Mode</div>
                  <div className="font-bold text-white uppercase mt-0.5 truncate">{matchMode}</div>
                </div>
                <div className="p-2.5 rounded-xl bg-neutral-950/80 border border-neutral-800/80">
                  <div className="text-[10px] text-neutral-500 uppercase">Room / Peers</div>
                  <div className="font-bold text-sky-400 mt-0.5 truncate flex items-center gap-1">
                    <Router className="h-3 w-3 shrink-0" />
                    <span>
                      {onlineSession?.roomId
                        ? `${onlineSession.roomId} (${1 + (onlineSession.connectedPeers?.length || 0)})`
                        : 'Local'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="text-[10px] text-neutral-400 uppercase font-bold">
                  Active Input Agent
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      { id: 'none', label: 'No input' },
                      { id: 'necto', label: 'Necto' },
                      { id: 'nexto', label: 'Nexto' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setTouchInputAgent(opt.id)}
                      className={`py-2 px-2 rounded-lg border text-xs font-bold cursor-pointer transition-all ${
                        touchInputAgent === opt.id
                          ? 'bg-amber-500 text-neutral-950 border-amber-400 shadow-sm'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:bg-neutral-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => openMenu('main-menu')}
                className="w-full py-2.5 px-4 rounded-xl bg-white text-neutral-950 hover:bg-neutral-200 font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition active:scale-98"
              >
                <Menu className="h-4 w-4" />
                <span>Open Game Menu</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Telemetry HUD & Boundary guides (fixed to physical display window) */}
      <SafeAreaHud />

      {/* Main Safe Area Host Layer */}
      <div
        id="game-ui-safe-area-host"
        className="absolute transition-all duration-150 pointer-events-none select-none"
        style={{
          top: `${safeAreaMargin}%`,
          bottom: `${safeAreaMargin}%`,
          left: `${safeAreaMargin}%`,
          right: `${safeAreaMargin}%`,
        }}
      >
        {(() => {
          const Wwin = typeof window !== 'undefined' ? window.innerWidth : 1280;
          const Hwin = typeof window !== 'undefined' ? window.innerHeight : 720;
          const maxSafeScale = calculateSettingsSafeScale(Wwin, Hwin, safeAreaMargin);
          const isSettings = activeRoute === 'settings';
          const effectiveUiScale = isSettings && uiScale > maxSafeScale ? maxSafeScale : uiScale;

          return (
            <div
              id="game-ui-scale-root"
              className="w-full h-full relative pointer-events-none"
              style={{
                zoom: (effectiveUiScale ?? 100) / 100,
              }}
            >
              {/* Modern Layer 5A Spatial Choreography HUD */}
              <InGameHUD />

              {/* Main UI Children (MenuShell, etc.) */}
              {children}
            </div>
          );
        })()}
      </div>

      {/* SimpleUI Portrait Orientation Barrier */}
      {!touchMode && metrics.isPortrait && !portraitDismissed && (
        <div className="fixed inset-0 z-[100000] pointer-events-auto bg-black/85 backdrop-blur-md flex items-center justify-center p-6 select-none">
          <div className="max-w-xs w-full bg-neutral-900 border border-neutral-700/80 rounded-2xl p-6 text-center shadow-2xl flex flex-col items-center gap-3">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30">
              <AlertTriangle className="h-3 w-3" />
              <span>Landscape Recommended</span>
            </div>
            <h2 className="text-base font-bold text-white mt-1">Use it at your own risk</h2>
            <p className="text-xs text-neutral-400 leading-relaxed">
              Rocket Companion is engineered for horizontal desktop/laptop displays (up to 18:9).
            </p>
            <button
              type="button"
              onClick={dismissPortraitGate}
              className="mt-2 w-full py-2 px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs transition active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
            >
              <span>I got it, proceed anyway</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
