import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Activity,
  Gauge,
  Monitor,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  RotateCcw,
  Play,
  Pause,
  Cpu,
} from 'lucide-react';
import { Badge } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import {
  getTauriDisplayDiagnostics,
  isTauriRuntime,
  type TauriDisplayDiagnostics,
} from '../config/tauriLaunchConfigBridge';

export interface DisplayRefreshRateCardProps {
  isLight?: boolean;
  defaultExpanded?: boolean;
}

export const DisplayRefreshRateCard: React.FC<DisplayRefreshRateCardProps> = ({
  isLight = false,
  defaultExpanded = true,
}) => {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const [currentFps, setCurrentFps] = useState<number>(0);
  const [avgFps, setAvgFps] = useState<number>(0);
  const [minFps, setMinFps] = useState<number>(0);
  const [maxFps, setMaxFps] = useState<number>(0);
  const [frameTimeMs, setFrameTimeMs] = useState<number>(0);
  const [jitterMs, setJitterMs] = useState<number>(0);
  const [isTestPaused, setIsTestPaused] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [diagnostics, setDiagnostics] = useState<TauriDisplayDiagnostics | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(performance.now());
  const historyRef = useRef<number[]>([]);
  const ufoPosRef = useRef<number>(0);
  const lastStateUpdateRef = useRef<number>(0);

  useEffect(() => {
    let active = true;
    getTauriDisplayDiagnostics().then((diag) => {
      if (active && diag) {
        setDiagnostics(diag);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const resetStats = useCallback(() => {
    historyRef.current = [];
    setMinFps(0);
    setMaxFps(0);
    setAvgFps(0);
    setJitterMs(0);
  }, []);

  useEffect(() => {
    const renderLoop = (now: number) => {
      const delta = now - lastTimeRef.current;
      lastTimeRef.current = now;

      if (delta > 0 && delta < 1000) {
        const fps = 1000 / delta;
        const history = historyRef.current;
        history.push(fps);
        if (history.length > 120) {
          history.shift();
        }

        if (now - lastStateUpdateRef.current > 120) {
          lastStateUpdateRef.current = now;
          const sum = history.reduce((acc, v) => acc + v, 0);
          const calculatedAvg = sum / Math.max(1, history.length);
          const currentMin = Math.min(...history);
          const currentMax = Math.max(...history);

          let variance = 0;
          for (let i = 0; i < history.length; i++) {
            variance += (history[i] - calculatedAvg) ** 2;
          }
          const stdDev = Math.sqrt(variance / Math.max(1, history.length));

          setCurrentFps(Math.round(fps * 10) / 10);
          setAvgFps(Math.round(calculatedAvg * 10) / 10);
          setMinFps(Math.round(currentMin * 10) / 10);
          setMaxFps(Math.round(currentMax * 10) / 10);
          setFrameTimeMs(Math.round(delta * 100) / 100);
          setJitterMs(Math.round(stdDev * 100) / 100);
        }
      }

      const canvas = canvasRef.current;
      if (canvas && !isTestPaused) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);

          const stepPx = (delta * 0.45) % w;
          ufoPosRef.current = (ufoPosRef.current + stepPx) % w;

          ctx.fillStyle = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
          ctx.fillRect(0, 0, w, h);

          const grad = ctx.createLinearGradient(0, 0, w, 0);
          grad.addColorStop(0, '#10b981');
          grad.addColorStop(0.5, '#38bdf8');
          grad.addColorStop(1, '#f59e0b');

          const posX = ufoPosRef.current;
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(posX - 24, 6, 48, h - 12, 6);
          ctx.fill();

          ctx.fillStyle = isLight ? '#0f172a' : '#f8fafc';
          ctx.font = '10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText('120Hz rAF', posX, h / 2 + 3);
        }
      }

      animationFrameRef.current = requestAnimationFrame(renderLoop);
    };

    animationFrameRef.current = requestAnimationFrame(renderLoop);
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isLight, isTestPaused]);

  const handleCopyReport = async () => {
    const report = {
      timestamp: new Date().toISOString(),
      runtime: isTauriRuntime() ? 'Tauri WebView' : 'Browser',
      platform: diagnostics?.platform ?? 'unknown',
      architecture: diagnostics?.arch ?? 'unknown',
      os: diagnostics?.os ?? 'unknown',
      macosFpsPluginActive: diagnostics?.hasMacosFpsPlugin ?? false,
      screen: {
        width: typeof screen !== 'undefined' ? screen.width : 0,
        height: typeof screen !== 'undefined' ? screen.height : 0,
        colorDepth: typeof screen !== 'undefined' ? screen.colorDepth : 0,
        devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      },
      viewport: {
        innerWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
        innerHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
      },
      sampling: {
        currentFps,
        avgFps,
        minFps,
        maxFps,
        frameTimeMs,
        jitterStdDevMs: jitterMs,
        sampleCount: historyRef.current.length,
      },
      monitors: diagnostics?.availableMonitors ?? [],
      primaryMonitor: diagnostics?.primaryMonitor ?? null,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const isProMotion = avgFps >= 95;
  const isCapped60 = avgFps >= 50 && avgFps < 95;

  return (
    <div
      className={`rounded-xl border transition-all ${
        isLight
          ? 'bg-white/90 border-neutral-200/90'
          : 'bg-white/[0.03] border-white/[0.08]'
      }`}
    >
      <div
        className="px-4 py-3 flex items-center justify-between cursor-pointer select-none"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="flex items-center gap-2.5">
          <Activity className="w-4 h-4 text-emerald-400" />
          <span className="font-semibold text-xs tracking-wide">
            Display & ProMotion Refresh Rate Diagnostics
          </span>
          <Badge
            variant={isProMotion ? 'emerald' : isCapped60 ? 'amber' : 'danger'}
            size="sm"
            isLight={isLight}
          >
            {isProMotion
              ? 'ProMotion 120Hz'
              : isCapped60
              ? '60-72Hz (WebKit Capped)'
              : `${currentFps} FPS`}
          </Badge>
        </div>

        <span className="text-[11px] font-mono text-neutral-400">
          {expanded ? 'Collapse' : 'Expand'}
        </span>
      </div>

      {expanded && (
        <div
          className={`px-4 pb-4 pt-1 flex flex-col gap-3.5 border-t text-xs ${
            isLight ? 'border-neutral-200/80 text-neutral-800' : 'border-white/[0.06] text-neutral-200'
          }`}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono">
            <div className={`p-2.5 rounded-lg border ${isLight ? 'bg-neutral-100/70 border-neutral-200' : 'bg-black/30 border-white/5'}`}>
              <div className="text-[10px] uppercase text-neutral-500 font-sans">Current FPS</div>
              <div className="text-base font-bold text-emerald-400 mt-0.5">{currentFps}</div>
              <div className="text-[10px] text-neutral-400">{frameTimeMs} ms</div>
            </div>

            <div className={`p-2.5 rounded-lg border ${isLight ? 'bg-neutral-100/70 border-neutral-200' : 'bg-black/30 border-white/5'}`}>
              <div className="text-[10px] uppercase text-neutral-500 font-sans">Average (120f)</div>
              <div className="text-base font-bold text-sky-400 mt-0.5">{avgFps}</div>
              <div className="text-[10px] text-neutral-400">StdDev ±{jitterMs}ms</div>
            </div>

            <div className={`p-2.5 rounded-lg border ${isLight ? 'bg-neutral-100/70 border-neutral-200' : 'bg-black/30 border-white/5'}`}>
              <div className="text-[10px] uppercase text-neutral-500 font-sans">Min / Max FPS</div>
              <div className="text-sm font-semibold mt-1">
                {minFps} / {maxFps}
              </div>
              <div className="text-[10px] text-neutral-400">Range: {Math.max(0, maxFps - minFps).toFixed(1)}</div>
            </div>

            <div className={`p-2.5 rounded-lg border ${isLight ? 'bg-neutral-100/70 border-neutral-200' : 'bg-black/30 border-white/5'}`}>
              <div className="text-[10px] uppercase text-neutral-500 font-sans">Status</div>
              <div className="flex items-center gap-1.5 mt-1 font-sans font-semibold text-xs">
                {isProMotion ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="text-emerald-400">ProMotion OK</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="text-amber-400">{avgFps > 0 ? 'Throttled 60Hz' : 'Sampling...'}</span>
                  </>
                )}
              </div>
              <div className="text-[10px] text-neutral-400">Target: 120Hz</div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] text-neutral-400">
              <span className="flex items-center gap-1.5">
                <Gauge className="w-3.5 h-3.5" />
                Continuous rAF Motion Visual Pacing Track
              </span>
              <button
                type="button"
                onClick={() => setIsTestPaused((p) => !p)}
                className="hover:text-neutral-100 flex items-center gap-1 text-[11px] transition-colors"
              >
                {isTestPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                {isTestPaused ? 'Resume Track' : 'Pause Track'}
              </button>
            </div>
            <canvas
              ref={canvasRef}
              width={540}
              height={32}
              className={`w-full h-8 rounded-lg border ${
                isLight ? 'bg-neutral-100 border-neutral-200' : 'bg-black/40 border-white/8'
              }`}
            />
          </div>

          <div className={`p-2.5 rounded-lg border font-mono text-[11px] grid grid-cols-2 gap-x-4 gap-y-1.5 ${
            isLight ? 'bg-neutral-100/40 border-neutral-200' : 'bg-black/20 border-white/5'
          }`}>
            <div>
              <span className="text-neutral-500">Platform: </span>
              <span>{diagnostics?.platform ?? 'web'} ({diagnostics?.arch ?? 'unknown'})</span>
            </div>
            <div>
              <span className="text-neutral-500">DPR: </span>
              <span>{typeof window !== 'undefined' ? window.devicePixelRatio : 1}x</span>
            </div>
            <div>
              <span className="text-neutral-500">Screen: </span>
              <span>{typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : 'unknown'}</span>
            </div>
            <div>
              <span className="text-neutral-500">FPS Plugin: </span>
              <span className="text-emerald-400">Active</span>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="secondary"
              size="sm"
              isLight={isLight}
              icon={copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              onClick={handleCopyReport}
            >
              {copied ? 'Copied Diagnostics JSON!' : 'Copy Diagnostics Payload'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              isLight={isLight}
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              onClick={resetStats}
            >
              Reset Jitter
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
