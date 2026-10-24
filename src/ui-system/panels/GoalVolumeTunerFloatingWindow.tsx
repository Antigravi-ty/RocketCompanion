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

export interface GoalVolumeTunerFloatingWindowProps {
  isLight?: boolean;
  active?: boolean;
}

type PresetTab = 'standard' | 'throwback';

export const GoalVolumeTunerFloatingWindow: React.FC<GoalVolumeTunerFloatingWindowProps> = ({
  isLight = false,
}) => {
  const stadiumPreset = useAppStore((s) => s.underDevelopment?.stadiumPreset || 'standard');
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

  const applyBoxPatch = (patch: Partial<typeof currentBox>) => {
    if (isThrowbackTab) {
      updateGoalVolumeTunerConfig({ throwback: { ...cfg.throwback, ...patch } });
    } else {
      updateGoalVolumeTunerConfig({ standard: { ...cfg.standard, ...patch } });
    }
  };

  const handleCopyJson = () => {
    try {
      const payload = {
        standard: cfg.standard,
        throwback: cfg.throwback,
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
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'goal-volume-hitbox-config.json';
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
        text = window.prompt('Paste Goal Volume Hitbox Configuration JSON:') || '';
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

  return (
    <div className="flex flex-col gap-2.5 h-full select-none text-xs pb-2">
      {/* 1. Header Toolbar */}
      <div className={`p-2.5 rounded-xl border flex items-center justify-between ${cardBg}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Box className="h-4 w-4 text-emerald-500 shrink-0" />
          <div className="flex flex-col min-w-0">
            <span className="font-bold text-xs uppercase tracking-wide truncate">
              Goal Volume Hitbox Tuner
            </span>
            <span className={`text-[10px] truncate ${mutedText}`}>
              Live 3D Goal Detection AABB &amp; Ball-Center Trigger Calibration
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleImportJson}
            title="Import Goal Volume JSON from clipboard or prompt"
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
            title="Copy Goal Volume JSON to clipboard"
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
            title="Export Goal Volume JSON file"
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
            title="Reset Goal Volume Hitbox to calibrated defaults"
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

      {/* 2. 3D Hitbox Overlay Visibility Toggle (Default OFF) */}
      <div className={`p-2.5 rounded-xl border flex items-center justify-between ${cardBg}`}>
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

      {/* 3. Arena Preset Selector */}
      <div className={`p-2.5 rounded-xl border flex flex-col gap-2 ${cardBg}`}>
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

      {/* 4. Dimension Sliders */}
      <div className={`p-2.5 rounded-xl border flex flex-col gap-2.5 ${cardBg}`}>
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

      {/* 5. Computed Ball-Center Trigger Readout */}
      <div className={`p-2.5 rounded-xl border font-mono text-[10px] leading-relaxed ${cardBg}`}>
        <div className="font-sans font-bold text-[11px] mb-1">
          Computed Ball-Center Trigger Bounds (R = {r} UU)
        </div>
        <div>• Outer Volume X: ±{currentBox.halfWidthX.toFixed(2)} UU | Y: [{currentBox.minY.toFixed(2)}, {currentBox.maxY.toFixed(2)}] | Z: [0, {currentBox.maxZ.toFixed(2)}]</div>
        <div>• Trigger Center X: ±{triggerHalfWidthX.toFixed(2)} UU | Y: [{triggerMinY.toFixed(2)}, {triggerMaxY.toFixed(2)}] | Z: [0, {triggerMaxZ.toFixed(2)}]</div>
      </div>
    </div>
  );
};
