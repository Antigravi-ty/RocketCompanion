import React, { useState } from 'react';
import {
  Car,
  Box,
  Flame,
  Disc,
  RotateCcw,
  Download,
  Copy,
  Check,
} from 'lucide-react';
import { useAppStore, garageSettingsStore } from '../../stores/appStore';
import { UnderlineTabs, type TabItem } from '../primitives/UnderlineTabs';
import { SegmentedSwitch } from '../primitives/SegmentedSwitch';
import { ToggleSwitch } from '../primitives/ToggleSwitch';
import { TunerPrecisionContext } from '../primitives/PrecisionDigitPicker';
import { useReferenceOverlayStore } from '../../stores/referenceOverlayStore';
import { HITBOX_PRESETS } from '../../config/vehicleConstants.js';
import {
  FENNEC_DESCRIPTOR,
  INSIDIO_DESCRIPTOR,
  getVehicleDescriptor,
} from '../../config/vehicleTunerConfig.js';
import {
  getVehicleTunerRuntimeFlags,
  setVehicleTunerRuntimeFlags,
  recomputeDescriptorBoostOutlets,
  getWheelModifierConfig,
  setWheelModifierConfig,
  DEFAULT_WHEEL_MODIFIER_CONFIG,
} from '../../config/vehicleTunerConfig.js';
import { HitboxAlignTab } from './vehicle-tuner/HitboxAlignTab';
import { BoostAndBloomTab } from './vehicle-tuner/BoostAndBloomTab';
import { WheelModifierTab } from './vehicle-tuner/WheelModifierTab';

export interface VehicleTunerFloatingWindowProps {
  isLight?: boolean;
  active?: boolean;
}

export type VehicleTunerTab = 'hitbox' | 'wheels' | 'boost';
export type CustomVehicleId = 'fennec' | 'insidio';

const INITIAL_VEHICLE_OFFSET_SNAPSHOT = JSON.parse(
  JSON.stringify({
    fennec: {
      hitboxPreset: FENNEC_DESCRIPTOR.hitboxPreset,
      alignment: FENNEC_DESCRIPTOR.alignment,
      wheelAnchors: FENNEC_DESCRIPTOR.wheelAnchors,
      suspensionHeights: FENNEC_DESCRIPTOR.suspensionHeights,
      boostNozzleParams: FENNEC_DESCRIPTOR.boostNozzleParams,
      boostOutlets: FENNEC_DESCRIPTOR.boostOutlets,
    },
    insidio: {
      hitboxPreset: INSIDIO_DESCRIPTOR.hitboxPreset,
      alignment: INSIDIO_DESCRIPTOR.alignment,
      wheelAnchors: INSIDIO_DESCRIPTOR.wheelAnchors,
      suspensionHeights: INSIDIO_DESCRIPTOR.suspensionHeights,
      boostNozzleParams: INSIDIO_DESCRIPTOR.boostNozzleParams,
      boostOutlets: INSIDIO_DESCRIPTOR.boostOutlets,
    },
  })
);

/**
 * Per-Vehicle Model & Spatial Offset Tuner Floating Window (Active Tuner)
 * Dedicated exclusively to per-model / per-hitbox spatial registration:
 * 1. Hitbox & Align (Hitbox archetype, Chassis Center Offset, Scale, Reference PNG Overlay)
 * 2. Wheel Offsets (Per-vehicle Front/Rear Axle X, Track Half-Width Z, Radius, Suspension Rest Y)
 * 3. Boost Nozzles (Per-vehicle Dual Exhaust Nozzle X/Y/Z offsets)
 */
export const VehicleTunerFloatingWindow: React.FC<VehicleTunerFloatingWindowProps> = ({
  isLight = false,
}) => {
  const activeCar = useAppStore((s) => s.activeCar);
  const setActiveCar = useAppStore((s) => s.setActiveCar);
  const gameplay = useAppStore((s) => s.gameplay);
  const updateGameplay = useAppStore((s) => s.updateGameplay);
  const bridge = useAppStore((s) => s.bridge);
  const precisionStep = useAppStore((s) => s.precisionStep);
  const setPrecisionStep = useAppStore((s) => s.setPrecisionStep);

  const [selectedCar, setSelectedCar] = useState<CustomVehicleId>(() =>
    activeCar === 'insidio' ? 'insidio' : 'fennec'
  );
  const [activeTab, setActiveTab] = useState<VehicleTunerTab>('hitbox');
  const [copiedJson, setCopiedJson] = useState(false);
  const [, setRevision] = useState(0);
  const [runtimeFlags, setRuntimeFlagsState] = useState(() => getVehicleTunerRuntimeFlags());
  const [wheelConfig, setWheelConfig] = useState(() => getWheelModifierConfig());

  const descriptor: any = getVehicleDescriptor(selectedCar) || FENNEC_DESCRIPTOR;
  const hitboxSpec: any =
    (HITBOX_PRESETS as any)[descriptor.hitboxPreset] || (HITBOX_PRESETS as any)['hitbox-octane'];

  const notifyAndRefresh = (carId: CustomVehicleId = selectedCar, nextHitboxPreset?: string) => {
    const desc = getVehicleDescriptor(carId);
    if (desc) {
      recomputeDescriptorBoostOutlets(desc);
    }
    setRevision((r) => r + 1);
    bridge.onCustomVehicleTunerChange?.(carId, nextHitboxPreset);
  };

  React.useEffect(() => {
    notifyAndRefresh(selectedCar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectVehicle = (carId: CustomVehicleId) => {
    setSelectedCar(carId);
    const nextFlags = setVehicleTunerRuntimeFlags({ activeVehicleId: carId });
    setRuntimeFlagsState(nextFlags);
    setActiveCar(carId);
    try {
      garageSettingsStore.save({ vehiclePreset: carId, carVisual: carId });
    } catch (err) {
      console.warn('[VehicleModelOffsetTuner] Failed to persist selected vehicle to garageSettingsStore:', err);
    }
    bridge.onVehicleChange?.(carId);
  };

  const handleToggleRuntimeFlag = (patch: Partial<typeof runtimeFlags>) => {
    const next = setVehicleTunerRuntimeFlags(patch);
    setRuntimeFlagsState(next);
    notifyAndRefresh(selectedCar);
  };

  const handleAlignmentChange = (patch: Partial<typeof descriptor.alignment>) => {
    Object.assign(descriptor.alignment, patch);
    notifyAndRefresh(selectedCar);
  };

  const handleCenterOffsetAxis = (axisIndex: 0 | 1 | 2, val: number) => {
    const nextOffset = [...(descriptor.alignment.centerOffset || [0, 0, 0])];
    nextOffset[axisIndex] = Number(val.toFixed(6));
    descriptor.alignment.centerOffset = nextOffset;
    notifyAndRefresh(selectedCar);
  };

  const handleAlignTopToRLHitbox = () => {
    const raw = descriptor.rawBounds;
    if (!raw || !hitboxSpec) return;
    const s = descriptor.alignment.scale ?? 1;
    const sx = s * (descriptor.alignment.scaleX ?? 1);
    const sy = s * (descriptor.alignment.scaleY ?? 1);
    const rlTopY = raw.rlHitboxTopY ?? (hitboxSpec.up + (hitboxSpec.height - 2.5) * 0.5);
    const visualRawTopY = raw.roofTopY * sy;
    const targetOffsetY = Number((rlTopY - visualRawTopY).toFixed(3));
    const targetOffsetX = Number((hitboxSpec.forward - raw.center[0] * sx).toFixed(3));
    descriptor.alignment.centerOffset = [targetOffsetX, targetOffsetY, 0];
    notifyAndRefresh(selectedCar);
  };

  const handleAlignToWheelArches = () => {
    if (selectedCar === 'fennec') {
      descriptor.alignment.centerOffset = [0, 1.75, 0];
    } else {
      descriptor.alignment.centerOffset = [0, 0, 0];
    }
    notifyAndRefresh(selectedCar);
  };

  const handleAlignRawOrigin = () => {
    descriptor.alignment.scale = 1.0;
    descriptor.alignment.scaleX = 1.0;
    descriptor.alignment.scaleY = 1.0;
    descriptor.alignment.scaleZ = 1.0;
    descriptor.alignment.centerOffset = [0, 0, 0];
    notifyAndRefresh(selectedCar);
  };

  const handleWheelPairChange = (
    pair: 'front' | 'rear',
    field: 'x' | 'z' | 'radius' | 'restY',
    val: number
  ) => {
    const i0 = pair === 'front' ? 0 : 2;
    const i1 = pair === 'front' ? 1 : 3;
    if (field === 'x') {
      descriptor.wheelAnchors[i0][0] = val;
      descriptor.wheelAnchors[i1][0] = val;
    } else if (field === 'z') {
      descriptor.wheelAnchors[i0][1] = Math.abs(val);
      descriptor.wheelAnchors[i1][1] = -Math.abs(val);
    } else if (field === 'radius') {
      descriptor.wheelAnchors[i0][2] = val;
      descriptor.wheelAnchors[i1][2] = val;
    } else if (field === 'restY') {
      descriptor.suspensionHeights[i0] = val;
      descriptor.suspensionHeights[i1] = val;
    }
    notifyAndRefresh(selectedCar);
  };

  const handleBoostNozzleChange = (patch: Partial<typeof descriptor.boostNozzleParams>) => {
    Object.assign(descriptor.boostNozzleParams, patch);
    notifyAndRefresh(selectedCar);
  };

  const applyWheelPatch = (patch: Partial<typeof DEFAULT_WHEEL_MODIFIER_CONFIG>) => {
    const next = setWheelModifierConfig(patch);
    setWheelConfig({ ...next });
    notifyAndRefresh(selectedCar);
  };

  const handleResetVehicle = () => {
    const snap = JSON.parse(JSON.stringify(INITIAL_VEHICLE_OFFSET_SNAPSHOT[selectedCar]));
    Object.assign(descriptor, snap);
    notifyAndRefresh(selectedCar, descriptor.hitboxPreset);
  };

  const buildExportJson = () => ({
    version: 'vehicle-model-offset-tuner-v1',
    exportedAt: new Date().toISOString(),
    referenceOverlayProfiles: useReferenceOverlayStore.getState().exportProfilesJson(),
    vehicles: {
      fennec: {
        hitboxPreset: FENNEC_DESCRIPTOR.hitboxPreset,
        alignment: FENNEC_DESCRIPTOR.alignment,
        wheelAnchors: FENNEC_DESCRIPTOR.wheelAnchors,
        suspensionHeights: FENNEC_DESCRIPTOR.suspensionHeights,
        boostNozzleParams: FENNEC_DESCRIPTOR.boostNozzleParams,
        boostOutlets: FENNEC_DESCRIPTOR.boostOutlets,
      },
      insidio: {
        hitboxPreset: INSIDIO_DESCRIPTOR.hitboxPreset,
        alignment: INSIDIO_DESCRIPTOR.alignment,
        wheelAnchors: INSIDIO_DESCRIPTOR.wheelAnchors,
        suspensionHeights: INSIDIO_DESCRIPTOR.suspensionHeights,
        boostNozzleParams: INSIDIO_DESCRIPTOR.boostNozzleParams,
        boostOutlets: INSIDIO_DESCRIPTOR.boostOutlets,
      },
    },
  });

  const handleCopyJson = async () => {
    try {
      const jsonStr = JSON.stringify(buildExportJson(), null, 2);
      await navigator.clipboard.writeText(jsonStr);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch (err) {
      console.warn('[VehicleModelOffsetTuner] Clipboard copy failed:', err);
    }
  };

  const handleDownloadJson = () => {
    try {
      const jsonStr = JSON.stringify(buildExportJson(), null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vehicle-model-offsets-${selectedCar}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('[VehicleModelOffsetTuner] Download JSON failed:', err);
    }
  };

  const tabs: TabItem[] = [
    { id: 'hitbox', label: '1. Hitbox & Align', icon: <Box className="h-3.5 w-3.5" /> },
    { id: 'wheels', label: '2. Wheel Offsets', icon: <Disc className="h-3.5 w-3.5" /> },
    { id: 'boost', label: '3. Boost Nozzles', icon: <Flame className="h-3.5 w-3.5" /> },
  ];

  const cardClass = `p-2.5 rounded-xl border flex flex-col gap-2 ${
    isLight ? 'bg-neutral-50/90 border-neutral-200' : 'bg-neutral-850/75 border-neutral-700/80'
  }`;

  return (
    <TunerPrecisionContext.Provider value={{ step: precisionStep, setStep: setPrecisionStep }}>
      <div className="flex flex-col gap-2.5 text-xs select-none" data-ui-element="vehicle-tuner-window">
        {/* Top Chassis Selector & Spatial Debug Switches */}
        <div className={cardClass}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-[11px] uppercase tracking-wider text-amber-500 flex items-center gap-1.5">
              <Car className="h-3.5 w-3.5" />
              Target Vehicle Model (Per-Model Offsets)
            </span>
            <span className="text-[10px] font-mono opacity-75">
              Equipped: <strong>{activeCar}</strong>
            </span>
          </div>

          <SegmentedSwitch
            value={selectedCar}
            onValueChange={(v) => handleSelectVehicle(v as CustomVehicleId)}
            options={[
              { value: 'fennec', label: 'Fennec (Fennec.glb)' },
              { value: 'insidio', label: 'Insidio (Insidio.glb)' },
            ]}
            size="sm"
            fullWidth
            isLight={isLight}
          />

          <div className="grid grid-cols-3 gap-1.5 pt-0.5">
            <div className="flex items-center justify-between px-2 py-1 rounded-lg border border-neutral-500/20">
              <span className="text-[10px] font-medium">Hitbox Wire</span>
              <ToggleSwitch
                checked={gameplay.showCarHitbox}
                onChange={(checked) => updateGameplay({ showCarHitbox: checked })}
                isLight={isLight}
              />
            </div>
            <div className="flex items-center justify-between px-2 py-1 rounded-lg border border-neutral-500/20">
              <span className="text-[10px] font-medium">Nozzle Gizmos</span>
              <ToggleSwitch
                checked={runtimeFlags.showNozzleGizmos}
                onChange={(checked) => handleToggleRuntimeFlag({ showNozzleGizmos: checked })}
                isLight={isLight}
              />
            </div>
            <div className="flex items-center justify-between px-2 py-1 rounded-lg border border-neutral-500/20">
              <span className="text-[10px] font-medium">Force Boost</span>
              <ToggleSwitch
                checked={runtimeFlags.forceBoostPreview}
                onChange={(checked) => handleToggleRuntimeFlag({ forceBoostPreview: checked })}
                isLight={isLight}
              />
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <UnderlineTabs
          items={tabs}
          activeId={activeTab}
          onChange={(id) => setActiveTab(id as VehicleTunerTab)}
          isLight={isLight}
        />

        {activeTab === 'hitbox' && (
          <HitboxAlignTab
            descriptor={descriptor}
            hitboxSpec={hitboxSpec}
            selectedCar={selectedCar}
            notifyAndRefresh={notifyAndRefresh}
            handleCenterOffsetAxis={handleCenterOffsetAxis}
            handleAlignmentChange={handleAlignmentChange}
            handleAlignTopToRLHitbox={handleAlignTopToRLHitbox}
            handleAlignToWheelArches={handleAlignToWheelArches}
            handleAlignRawOrigin={handleAlignRawOrigin}
            isLight={isLight}
            cardClass={cardClass}
          />
        )}

        {activeTab === 'wheels' && (
          <WheelModifierTab
            descriptor={descriptor}
            wheelConfig={wheelConfig}
            applyWheelPatch={applyWheelPatch}
            handleWheelPairChange={handleWheelPairChange}
            scope="per-vehicle"
            isLight={isLight}
            cardClass={cardClass}
          />
        )}

        {activeTab === 'boost' && (
          <BoostAndBloomTab
            descriptor={descriptor}
            handleBoostNozzleChange={handleBoostNozzleChange}
            scope="per-vehicle"
            isLight={isLight}
            cardClass={cardClass}
          />
        )}

        {/* Footer Actions: Reset, Copy JSON, Download JSON */}
        <div className="flex items-center justify-between gap-2 pt-1 border-t border-neutral-500/20">
          <button
            type="button"
            onClick={handleResetVehicle}
            className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
              isLight
                ? 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-700'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
            }`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset {descriptor.name} Offsets</span>
          </button>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopyJson}
              className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 cursor-pointer transition-colors ${
                copiedJson
                  ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                  : isLight
                  ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-900 text-white'
                  : 'bg-amber-500 hover:bg-amber-400 border-amber-400 text-neutral-950'
              }`}
            >
              {copiedJson ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedJson ? 'Copied JSON' : 'Copy JSON'}</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadJson}
              className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors ${
                isLight
                  ? 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-800'
                  : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-600 text-neutral-100'
              }`}
            >
              <Download className="h-3.5 w-3.5" />
              <span>.JSON</span>
            </button>
          </div>
        </div>
      </div>
    </TunerPrecisionContext.Provider>
  );
};
