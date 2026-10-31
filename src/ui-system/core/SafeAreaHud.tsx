import React from 'react';
import { useAppStore } from '../../ui-core/stores/appStore';
import { useUIStore } from '../../ui-core/stores/uiStore';
import { RotateCcw } from 'lucide-react';
import * as SliderPrimitive from '@radix-ui/react-slider';

export const SafeAreaHud: React.FC = () => {
  const showSafeAreaHud = useUIStore((s) => s.showSafeAreaHud);
  const metrics = useUIStore((s) => s.metrics);
  const safeAreaMargin = useUIStore((s) => s.safeAreaMargin);
  const setSafeAreaMargin = useUIStore((s) => s.setSafeAreaMargin);
  const setRenderScale = useAppStore((s) => s.setRenderScale);
  const theme = useAppStore((s) => s.theme);

  if (!showSafeAreaHud) return null;

  const isLight = theme === 'light';

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] select-none font-mono">
      {/* 1. Green dashed boundary representing safe area with applied margin */}
      <div
        className="absolute transition-all duration-150 border-2 border-dashed border-emerald-500/70 bg-emerald-500/5 flex items-center justify-center box-border"
        style={{
          top: `${safeAreaMargin}%`,
          bottom: `${safeAreaMargin}%`,
          left: `${safeAreaMargin}%`,
          right: `${safeAreaMargin}%`,
        }}
      >
        {/* 2. 18:9 Canonical render zone box */}
        <div
          className="relative w-full h-full border border-sky-500/80 bg-sky-500/5 flex items-start p-3 box-border"
          style={{
            maxWidth: `${metrics.renderWidth}px`,
            maxHeight: `${metrics.renderHeight}px`
          }}
        >
          <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-sky-600 text-white shadow-xs">
            SimpleUI 18:9 CANONICAL ZONE
          </div>
        </div>
      </div>

      {/* 3. Floating Bottom Telemetry & Quick Adjust Pill (Pointer events active) */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 pointer-events-auto flex flex-col gap-2 p-3.5 rounded-2xl border shadow-xl backdrop-blur-md max-w-[calc(100vw-32px)] text-xs z-[10000] bg-neutral-900/95 text-neutral-100 border-neutral-700/80">
        {/* Telemetry info row */}
        <div className="flex items-center gap-2 whitespace-nowrap text-[11px] overflow-x-auto pb-1 border-b border-neutral-800">
          <span>
            <strong className="text-sky-400">Viewport:</strong> {Math.round(metrics.renderWidth)}×{Math.round(metrics.renderHeight)}px
          </span>
          <span className="text-neutral-600">|</span>
          <span>
            <strong className="text-emerald-400">Scale:</strong> {(metrics.scaleFactor * 100).toFixed(0)}%
          </span>
          <span className="text-neutral-600">|</span>
          <span>
            <strong className="text-amber-400">Margin:</strong> {safeAreaMargin > 0 ? `+${safeAreaMargin}` : safeAreaMargin}%
          </span>
          {metrics.isPillarboxed && (
            <>
              <span className="text-neutral-600">|</span>
              <span className="text-purple-400 font-semibold">
                Pillarbox: {Math.round(metrics.pillarboxWidth)}px
              </span>
            </>
          )}
        </div>

        {/* Quick controls row with Radix Slider */}
        <div className="flex items-center justify-between gap-4 pt-1">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-neutral-400 font-medium">Safe Margin:</span>
            <div className="flex items-center gap-2 w-32">
              <SliderPrimitive.Root
                value={[safeAreaMargin]}
                min={-5}
                max={10}
                step={1}
                onValueChange={(val) => setSafeAreaMargin(val[0])}
                className="relative flex items-center select-none touch-none w-full h-4 cursor-pointer"
              >
                <SliderPrimitive.Track className="relative grow rounded-full h-1 bg-neutral-700">
                  <SliderPrimitive.Range className="absolute h-full rounded-full bg-sky-500" />
                </SliderPrimitive.Track>
                <SliderPrimitive.Thumb className="block w-3.5 h-3.5 bg-white rounded-full shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
              </SliderPrimitive.Root>
              <span className="text-[11px] font-mono min-w-[32px] text-right font-bold text-sky-400">
                {safeAreaMargin > 0 ? `+${safeAreaMargin}` : safeAreaMargin}%
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              setSafeAreaMargin(0);
              setRenderScale(100);
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition active:scale-95 cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset (0%, 100%)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
