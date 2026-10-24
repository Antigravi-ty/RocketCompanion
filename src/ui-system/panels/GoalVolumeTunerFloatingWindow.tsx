import React, { useState, useEffect } from 'react';
import {
  Box,
  Copy,
  Check,
  Download,
  Upload,
  RotateCcw,
  Eye,
  Layers,
  Sparkles,
  Palette,
} from 'lucide-react';
import {
  getGoalVolumeTunerConfig,
  updateGoalVolumeTunerConfig,
  resetGoalVolumeTunerConfig,
  subscribeGoalVolumeTunerConfig,
} from '../../config/goalVolumeTunerConfig.js';
import { BALL_COLLISION_RADIUS } from '../../physics/RocketSimConstants.js';
import { useAppStore } from '../../stores/appStore';
import { SliderControl } from '../primitives/SliderControl';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { SegmentedSwitch } from '../primitives/SegmentedSwitch';
import {
  CubicBezierCurveEditor,
  type CubicBezierPreset,
} from '../charts/CubicBezierCurveEditor';
import { TunerColorRow } from './driftwoods/DriftwoodsTunerControls';

export interface GoalVolumeTunerFloatingWindowProps {
  isLight?: boolean;
  active?: boolean;
}

type PresetTab = 'standard' | 'throwback';
type TunerSectionTab = 'ball_rim_fx' | 'hitbox';

const BALL_RIM_BEZIER_PRESETS: CubicBezierPreset[] = [
  { name: 'Sharp Rim', value: { p1x: 0.42, p1y: 0.0, p2x: 0.85, p2y: 0.25 } },
  { name: 'Razor Edge', value: { p1x: 0.65, p1y: 0.0, p2x: 0.92, p2y: 0.1 } },
  { name: 'Smooth Ease', value: { p1x: 0.25, p1y: 0.1, p2x: 0.25, p2y: 1.0 } },
  { name: 'Linear', value: { p1x: 0.33, p1y: 0.33, p2x: 0.67, p2y: 0.67 } },
];

export const GoalVolumeTunerFloatingWindow: React.FC<GoalVolumeTunerFloatingWindowProps> = ({
  isLight = false,
}) => {
  const stadiumPreset = useAppStore((s) => s.underDevelopment?.stadiumPreset || 'standard');
  const [activeTab, setActiveTab] = useState<TunerSectionTab>('ball_rim_fx');
  const [selectedPreset, setSelectedPreset] = useState<PresetTab>(
    stadiumPreset === 'throwback' ? 'throwback' : 'standard'
  );
  const [cfg, setCfg] = useState(() => getGoalVolumeTunerConfig());
  const [copied, setCopied] = useState(false);
  const [imported, setImported] = useState(false);

  useEffect(() => {
    setSelectedPreset(stadiumPreset === 'throwback' ? 'throwback' : 'standard');
  }, [stadiumPreset]);

  useEffect(() => {
    return subscribeGoalVolumeTunerConfig((next: ReturnType<typeof getGoalVolumeTunerConfig>) => {
      setCfg(next);
    });
  }, []);

  const currentBox = selectedPreset === 'throwback' ? cfg.throwback : cfg.standard;
  const isThrowbackTab = selectedPreset === 'throwback';
  const rimFx = cfg.ballRimFx;

  const applyBoxPatch = (patch: Partial<typeof currentBox>) => {
    if (isThrowbackTab) {
      updateGoalVolumeTunerConfig({ throwback: { ...cfg.throwback, ...patch } });
    } else {
      updateGoalVolumeTunerConfig({ standard: { ...cfg.standard, ...patch } });
    }
  };

  const applyRimFxPatch = (patch: Partial<typeof rimFx>) => {
    updateGoalVolumeTunerConfig({
      ballRimFx: {
        ...rimFx,
        ...patch,
      },
    });
  };

  const handleCopyJson = () => {
    try {
      const payload = {
        standard: cfg.standard,
        throwback: cfg.throwback,
        ballRimFx: cfg.ballRimFx,
      };
      navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[GoalVolumeTuner] Copy JSON failed:', err);
    }
  };

  const handleDownloadJson = () => {
    try {
      const payload = {
        standard: cfg.standard,
        throwback: cfg.throwback,
        ballRimFx: cfg.ballRimFx,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'goal-volume-and-ball-rim-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('[GoalVolumeTuner] Download JSON failed:', err);
    }
  };

  const handleImportJson = async () => {
    try {
      let text = '';
      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        try {
          text = await navigator.clipboard.readText();
        } catch {
          // fallback to prompt
        }
      }
      if (!text) {
        text = window.prompt('Paste Goal Volume & Ball Rim FX Configuration JSON:') || '';
      }
      if (!text.trim()) return;
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        updateGoalVolumeTunerConfig(parsed);
        setImported(true);
        setTimeout(() => setImported(false), 2000);
      }
    } catch (err) {
      console.warn('[GoalVolumeTuner] Import JSON failed:', err);
    }
  };

  const r = BALL_COLLISION_RADIUS;
  const margin = (isThrowbackTab || currentBox.enabled) ? 0.25 * r : 0.0;
  const triggerHalfWidthX = Math.max(0, currentBox.halfWidthX - margin);
  const triggerMinY = currentBox.minY + r;
  const triggerMaxY = currentBox.maxY;
  const triggerMaxZ = Math.max(0, currentBox.maxZ - margin);

  const cardBg = isLight
    ? 'bg-neutral-50 border-neutral-200 text-neutral-900'
    : 'bg-neutral-900/60 border-neutral-700/60 text-neutral-100';
  const mutedText = isLight ? 'text-neutral-500' : 'text-neutral-400';

  const innerPctClamped = Math.max(0, Math.min(99.9, Number(rimFx.innerStartPct) ?? 90));
  const outerPctClamped = Math.max(innerPctClamped + 0.1, Math.min(100, Number(rimFx.outerEndPct) ?? 100));

  return (
    <div className="flex flex-col gap-2.5 h-full select-none text-xs pb-2 overflow-y-auto pr-0.5">
      {/* 1. Header Toolbar */}
      <div className={`p-2.5 rounded-xl border flex items-center justify-between shrink-0 ${cardBg}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Box className="h-4 w-4 text-emerald-500 shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="font-bold text-xs uppercase tracking-wide truncate">
              Goal Volume &amp; Ball Rim FX Tuner
            </span>
            <span className={`text-[10px] truncate ${mutedText}`}>
              In-Goal Outer Rim Glow Curve, Dual Colors &amp; 3D Goal Hitbox AABB
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleImportJson}
            title="Import Goal Volume & Ball Rim FX JSON from clipboard or prompt"
            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer transition-all active:scale-95 ${
              imported
                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                : isLight
                ? 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-700'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-600 text-neutral-200'
            }`}
          >
            {imported ? <Check className="h-3 w-3" /> : <Upload className="h-3 w-3" />}
            <span>{imported ? 'Imported' : 'Import'}</span>
          </button>

          <button
            type="button"
            onClick={handleCopyJson}
            title="Copy Goal Volume & Ball Rim FX JSON to clipboard"
            className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer transition-all active:scale-95 ${
              copied
                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                : isLight
                ? 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-700'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-600 text-neutral-200'
            }`}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? 'Copied' : 'Copy JSON'}</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadJson}
            title="Export Goal Volume & Ball Rim FX JSON file"
            className={`p-1.5 rounded-lg border cursor-pointer transition-all active:scale-95 ${
              isLight
                ? 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-700'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-600 text-neutral-200'
            }`}
          >
            <Download className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => resetGoalVolumeTunerConfig()}
            title="Reset Goal Volume & Ball Rim FX to calibrated defaults"
            className={`p-1.5 rounded-lg border cursor-pointer transition-all active:scale-95 ${
              isLight
                ? 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-700'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-600 text-neutral-200'
            }`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Top-Level Mode Switcher */}
      <div className="shrink-0">
        <SegmentedSwitch
          value={activeTab}
          onValueChange={(val) => setActiveTab(val as TunerSectionTab)}
          options={[
            { value: 'ball_rim_fx', label: 'In-Goal Ball Rim & Dark Core FX' },
            { value: 'hitbox', label: '3D Goal Volume Hitbox (AABB)' },
          ]}
          size="sm"
          fullWidth
          isLight={isLight}
        />
      </div>

      {activeTab === 'ball_rim_fx' ? (
        <>
          {/* Enable In-Goal Ball Rim & Dark Core FX */}
          <div className={`p-2.5 rounded-xl border flex items-center justify-between shrink-0 ${cardBg}`}>
            <div className="flex items-center gap-2 min-w-0 pr-2">
              <Sparkles className="h-4 w-4 text-emerald-400 shrink-0" />
              <div className="flex flex-col leading-tight min-w-0">
                <span className="font-semibold text-xs truncate">
                  Enable In-Goal Dark Core &amp; Outer Rim Glow
                </span>
                <span className={`text-[10px] mt-0.5 truncate ${mutedText}`}>
                  Darkens ball inside the goal plane with a curved radial rim outline and 3D jitter
                </span>
              </div>
            </div>
            <ToggleSwitch
              checked={Boolean(rimFx.enabled)}
              onCheckedChange={(checked) => applyRimFxPatch({ enabled: checked })}
              isLight={isLight}
            />
          </div>

          {/* Radial Rim Band Percentage (e.g. 90% -> 100%) */}
          <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 shrink-0 ${cardBg}`}>
            <div className="flex items-center justify-between">
              <span className="font-bold text-xs uppercase tracking-wide">
                1. Radial Rim Thickness Band (0% Center → 100% Edge)
              </span>
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/15 text-emerald-400">
                Band: {innerPctClamped.toFixed(1)}% – {outerPctClamped.toFixed(1)}% ({(outerPctClamped - innerPctClamped).toFixed(1)}% thick)
              </span>
            </div>

            {/* Live Radial Band Preview Bar */}
            <div
              className="h-4 w-full rounded-lg border border-neutral-600/60 overflow-hidden relative"
              style={{
                background: `linear-gradient(90deg, ${rimFx.coreColor} 0%, ${rimFx.coreColor} ${innerPctClamped}%, ${rimFx.rimColor} ${outerPctClamped}%, ${rimFx.rimColor} 100%)`,
              }}
            >
              <div className="absolute inset-0 flex items-center justify-between px-2 text-[9px] font-mono font-bold mix-blend-difference text-white pointer-events-none">
                <span>0% Center (Dark Core)</span>
                <span>{innerPctClamped.toFixed(1)}% Start</span>
                <span>{outerPctClamped.toFixed(1)}% Outer Rim</span>
              </div>
            </div>

            <SliderControl
              label="Rim Gradient Inner Start (%)"
              description="Sphere radius percentage where dark core begins transitioning to rim glow (e.g. 90%)"
              value={rimFx.innerStartPct}
              min={0}
              max={99.5}
              step={0.5}
              editable={true}
              onChange={(val) =>
                applyRimFxPatch({
                  innerStartPct: Math.min(val, (rimFx.outerEndPct ?? 100) - 0.5),
                })
              }
              isLight={isLight}
            />

            <SliderControl
              label="Rim Gradient Outer End (%)"
              description="Sphere silhouette edge percentage where rim reaches full intensity (default 100%)"
              value={rimFx.outerEndPct}
              min={5}
              max={100}
              step={0.5}
              editable={true}
              onChange={(val) =>
                applyRimFxPatch({
                  outerEndPct: Math.max(val, (rimFx.innerStartPct ?? 90) + 0.5),
                })
              }
              isLight={isLight}
            />
          </div>

          {/* Interactive Cubic-Bezier Gradient Curve Controller */}
          <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 shrink-0 ${cardBg}`}>
            <CubicBezierCurveEditor
              title="2. Core-to-Rim Gradient Curve (Inner Start % → Outer Edge %)"
              p1x={rimFx.bezierP1X}
              p1y={rimFx.bezierP1Y}
              p2x={rimFx.bezierP2X}
              p2y={rimFx.bezierP2Y}
              presets={BALL_RIM_BEZIER_PRESETS}
              onChange={(next) =>
                applyRimFxPatch({
                  bezierP1X: next.p1x,
                  bezierP1Y: next.p1y,
                  bezierP2X: next.p2x,
                  bezierP2Y: next.p2y,
                })
              }
              isLight={isLight}
            />

            <div className="grid grid-cols-2 gap-2 pt-1">
              <SliderControl
                label="Control Point P1.X"
                value={rimFx.bezierP1X}
                min={0}
                max={1}
                step={0.01}
                editable={true}
                onChange={(val) => applyRimFxPatch({ bezierP1X: val })}
                isLight={isLight}
              />
              <SliderControl
                label="Control Point P1.Y"
                value={rimFx.bezierP1Y}
                min={-1}
                max={2}
                step={0.01}
                editable={true}
                onChange={(val) => applyRimFxPatch({ bezierP1Y: val })}
                isLight={isLight}
              />
              <SliderControl
                label="Control Point P2.X"
                value={rimFx.bezierP2X}
                min={0}
                max={1}
                step={0.01}
                editable={true}
                onChange={(val) => applyRimFxPatch({ bezierP2X: val })}
                isLight={isLight}
              />
              <SliderControl
                label="Control Point P2.Y"
                value={rimFx.bezierP2Y}
                min={-1}
                max={2}
                step={0.01}
                editable={true}
                onChange={(val) => applyRimFxPatch({ bezierP2Y: val })}
                isLight={isLight}
              />
            </div>
          </div>

          {/* Dual Color & Brightness Controls (Rim White vs Core Black) */}
          <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 shrink-0 ${cardBg}`}>
            <div className="flex items-center gap-1.5">
              <Palette className="h-3.5 w-3.5 text-sky-400" />
              <span className="font-bold text-xs uppercase tracking-wide">
                3. Rim &amp; Core Colors &amp; Brightness
              </span>
            </div>

            <TunerColorRow
              label="Outer Rim Glow Color"
              description="Base color for the outer silhouette rim outline"
              value={rimFx.rimColor}
              onChange={(hex) => applyRimFxPatch({ rimColor: hex })}
              isLight={isLight}
            />

            <SliderControl
              label="Outer Rim Brightness / Intensity"
              description="Controls how bright/white the outer rim glow renders (0.0 – 3.0)"
              value={rimFx.rimIntensity}
              min={0}
              max={3}
              step={0.02}
              editable={true}
              onChange={(val) => applyRimFxPatch({ rimIntensity: val })}
              isLight={isLight}
            />

            <TunerColorRow
              label="Inner Dark Core Color"
              description="Base color for the darkened ball interior inside the goal"
              value={rimFx.coreColor}
              onChange={(hex) => applyRimFxPatch({ coreColor: hex })}
              isLight={isLight}
            />

            <SliderControl
              label="Inner Core Brightness Multiplier"
              description="Controls how dark the core is (0.0 = pure pitch black, 1.0 = exact core hex color)"
              value={rimFx.coreBrightness}
              min={0}
              max={2}
              step={0.02}
              editable={true}
              onChange={(val) => applyRimFxPatch({ coreBrightness: val })}
              isLight={isLight}
            />
          </div>

          {/* Goal Plane Seam & 3D Jitter Controls */}
          <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 shrink-0 ${cardBg}`}>
            <span className="font-bold text-xs uppercase tracking-wide">
              4. Goal-Line Intersection Seam &amp; 3D Jitter
            </span>

            <SliderControl
              label="Goal-Plane Seam Glow Width (UU)"
              description="Width of the highlight ring where the ball intersects the goal plane (0 = off)"
              value={rimFx.seamWidthUu}
              min={0}
              max={25}
              step={0.25}
              editable={true}
              onChange={(val) => applyRimFxPatch({ seamWidthUu: val })}
              isLight={isLight}
            />

            <SliderControl
              label="Goal-Plane Seam Glow Intensity"
              description="Opacity of the goal-plane intersection seam (set to 0 to show only outer silhouette rim)"
              value={rimFx.seamIntensity}
              min={0}
              max={1.5}
              step={0.02}
              editable={true}
              onChange={(val) => applyRimFxPatch({ seamIntensity: val })}
              isLight={isLight}
            />

            <SliderControl
              label="In-Goal 3D Jitter Amplitude Multiplier"
              description="Scales the high-frequency 3D vibration amplitude while inside the goal"
              value={rimFx.jitterAmplitude}
              min={0}
              max={3}
              step={0.05}
              editable={true}
              onChange={(val) => applyRimFxPatch({ jitterAmplitude: val })}
              isLight={isLight}
            />
          </div>
        </>
      ) : (
        <>
          {/* 3D Hitbox Overlay Visibility Toggle (Default OFF) */}
          <div className={`p-2.5 rounded-xl border flex items-center justify-between shrink-0 ${cardBg}`}>
            <div className="flex items-center gap-2 min-w-0 pr-2">
              <Eye className="h-4 w-4 text-sky-400 shrink-0" />
              <div className="flex flex-col leading-tight min-w-0">
                <span className="font-semibold text-xs truncate">
                  Show 3D Goal Volume Hitbox Overlay
                </span>
                <span className={`text-[10px] mt-0.5 truncate ${mutedText}`}>
                  Renders outer Goal Volume Box + inner Ball-Center Trigger Box for Blue &amp; Orange goals
                </span>
              </div>
            </div>
            <ToggleSwitch
              checked={Boolean(cfg.showHitboxVisual)}
              onCheckedChange={(checked) => updateGoalVolumeTunerConfig({ showHitboxVisual: checked })}
              isLight={isLight}
            />
          </div>

          {/* Arena Preset Selector */}
          <div className={`p-2.5 rounded-xl border flex flex-col gap-2 shrink-0 ${cardBg}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-amber-500" />
                <span className="font-semibold text-xs">Target Stadium Preset</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/15 text-emerald-400">
                Active Arena: {stadiumPreset.toUpperCase()}
              </span>
            </div>

            <SegmentedSwitch
              value={selectedPreset}
              onValueChange={(val) => setSelectedPreset(val as PresetTab)}
              options={[
                { value: 'standard', label: 'Standard Soccar (5120)' },
                { value: 'throwback', label: 'Throwback Stadium (4922)' },
              ]}
              size="sm"
              fullWidth
              isLight={isLight}
            />
          </div>

          {/* Dimension Sliders */}
          <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 shrink-0 ${cardBg}`}>
            <SliderControl
              label="Goal Half-Width X (halfWidthX)"
              description="Half-width of goal aperture from center X=0 (UU)"
              value={currentBox.halfWidthX}
              min={700}
              max={1200}
              step={0.5}
              editable={true}
              onChange={(val) => applyBoxPatch({ halfWidthX: val })}
              isLight={isLight}
            />

            <SliderControl
              label="Goal Line Plane Y (minY)"
              description="Front goal line plane distance from center Y=0 (UU)"
              value={currentBox.minY}
              min={4500}
              max={5400}
              step={0.5}
              editable={true}
              onChange={(val) => applyBoxPatch({ minY: val })}
              isLight={isLight}
            />

            <SliderControl
              label="Goal Back Plane Y (maxY)"
              description="Rear depth plane of the rectangular scoring volume (UU)"
              value={currentBox.maxY}
              min={5100}
              max={6200}
              step={1.0}
              editable={true}
              onChange={(val) => applyBoxPatch({ maxY: val })}
              isLight={isLight}
            />

            <SliderControl
              label="Crossbar Ceiling Height Z (maxZ)"
              description="Goal ceiling height from floor Z=0 (UU)"
              value={currentBox.maxZ}
              min={450}
              max={850}
              step={0.5}
              editable={true}
              onChange={(val) => applyBoxPatch({ maxZ: val })}
              isLight={isLight}
            />
          </div>

          {/* Computed Ball-Center Trigger Readout */}
          <div className={`p-2.5 rounded-xl border font-mono text-[10px] leading-relaxed shrink-0 ${cardBg}`}>
            <div className="font-sans font-bold text-[11px] mb-1">
              Computed Ball-Center Trigger Bounds (R = {r} UU)
            </div>
            <div>• Outer Volume X: ±{currentBox.halfWidthX.toFixed(2)} UU | Y: [{currentBox.minY.toFixed(2)}, {currentBox.maxY.toFixed(2)}] | Z: [0, {currentBox.maxZ.toFixed(2)}]</div>
            <div>• Trigger Center X: ±{triggerHalfWidthX.toFixed(2)} UU | Y: [{triggerMinY.toFixed(2)}, {triggerMaxY.toFixed(2)}] | Z: [0, {triggerMaxZ.toFixed(2)}]</div>
          </div>
        </>
      )}
    </div>
  );
};
