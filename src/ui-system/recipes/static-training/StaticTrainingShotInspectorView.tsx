import React, { useState, useEffect } from 'react';
import {
  Compass,
  Gauge,
  CircleDot,
  Camera,
  RotateCw,
  Save,
} from 'lucide-react';
import { ToggleSwitch } from '../../primitives/ToggleSwitch';
import { KeycapBadge } from '../../primitives/KeycapBadge';
import { CompactNumberSlider } from './CompactNumberSlider';
import {
  useStaticTrainingPackStore,
  mutateActiveEditItemVariable,
  type EditSubMode,
  type StaticTrainingShotItem,
} from '../../../stores/staticTrainingPackStore';

export interface StaticTrainingShotInspectorViewProps {
  isLight: boolean;
  currentShot: StaticTrainingShotItem;
  onHoverDesc: (desc: string | null) => void;
}

const radToDeg = (r: number) => Math.round((r * 180) / Math.PI);
const degToRad = (d: number) => Number(((d * Math.PI) / 180).toFixed(4));

const SUB_MODE_OPTIONS: {
  id: EditSubMode;
  label: string;
  icon: React.ReactNode;
  hint: string;
}[] = [
  {
    id: 'car-heading',
    label: 'Car Heading',
    icon: <Compass className="h-3.5 w-3.5" />,
    hint: 'WASD/Space/V Move Car • Drag Mouse = Car Heading & Pitch • [ / ] = Car Speed • Q/E = Air Roll • O/P = Boost',
  },
  {
    id: 'car-speed',
    label: 'Car Speed',
    icon: <Gauge className="h-3.5 w-3.5" />,
    hint: 'WASD/Space/V Move Car • Drag Mouse = Car Velocity Yaw & Pitch • [ / ] = Car Speed',
  },
  {
    id: 'ball-speed',
    label: 'Ball Speed',
    icon: <CircleDot className="h-3.5 w-3.5" />,
    hint: 'WASD/Space/V Move Ball • Drag Mouse = Ball Velocity Yaw & Pitch • [ / ] = Ball Speed • [F] = Switch Camera Side',
  },
  {
    id: 'free-cam',
    label: 'Free Cam',
    icon: <Camera className="h-3.5 w-3.5" />,
    hint: 'WASD/Space/V + Drag Look • [T] Toggle Trajectory Preview • [G] Test Single Shot',
  },
];

export const StaticTrainingShotInspectorView: React.FC<StaticTrainingShotInspectorViewProps> = ({
  isLight,
  currentShot,
  onHoverDesc,
}) => {
  const editSubMode = useStaticTrainingPackStore((s) => s.editSubMode);
  const setEditSubMode = useStaticTrainingPackStore((s) => s.setEditSubMode);
  const isCurrentShotDirty = useStaticTrainingPackStore((s) => s.isCurrentShotDirty);
  const saveCurrentShotToEditWorkspace = useStaticTrainingPackStore(
    (s) => s.saveCurrentShotToEditWorkspace
  );
  const editVarVersion = useStaticTrainingPackStore((s) => s.editVarVersion);
  void editVarVersion;

  // Show Advanced is transient UI state: always defaults to false and resets whenever selecting a shot
  const [showAdvanced, setShowAdvanced] = useState(false);
  useEffect(() => {
    setShowAdvanced(false);
  }, [currentShot.id, currentShot.index]);

  const isDirty = isCurrentShotDirty();
  const limitBoostAmount = !currentShot.car.unlimitedBoost;
  const hasFlip = currentShot.car.hasFlip !== false;
  const speedFollowsHeading = currentShot.car.speedFollowsHeading !== false;
  const visibleSubModeOptions = speedFollowsHeading
    ? SUB_MODE_OPTIONS.filter((opt) => opt.id !== 'car-speed')
    : SUB_MODE_OPTIONS;

  const sectionBg = isLight
    ? 'bg-white border-neutral-200 text-neutral-900'
    : 'bg-neutral-900/60 border-neutral-800 text-neutral-100';

  return (
    <div className="flex flex-col gap-2.5">
      {/* 1. Top Bar: Shot Name Input on Left + Save Button on Right (Disabled when clean) */}
      <div className={`p-2.5 rounded-xl border flex items-center justify-between gap-2 ${sectionBg}`}>
        <input
          type="text"
          value={currentShot.name}
          onChange={(e) =>
            mutateActiveEditItemVariable((d) => {
              d.name = e.target.value;
            })
          }
          className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold grow outline-none ${
            isLight
              ? 'bg-neutral-50 focus:bg-white border-neutral-300 text-neutral-900'
              : 'bg-neutral-850 focus:bg-neutral-800 border-neutral-700 text-neutral-100'
          }`}
          placeholder="Shot Name"
        />

        <button
          type="button"
          disabled={!isDirty}
          onClick={async () => {
            await saveCurrentShotToEditWorkspace();
            onHoverDesc(`Saved #${String(currentShot.index + 1).padStart(2, '0')} (${currentShot.name}) to edit workspace.`);
          }}
          onMouseEnter={() =>
            onHoverDesc(
              isDirty
                ? 'Save changes for this shot into the Edit Mode workspace.'
                : 'No unsaved changes on this shot.'
            )
          }
          onMouseLeave={() => onHoverDesc(null)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold shrink-0 transition-all ${
            isDirty
              ? isLight
                ? 'bg-neutral-900 hover:bg-neutral-800 border-neutral-900 text-white cursor-pointer active:scale-95'
                : 'bg-emerald-500 hover:bg-emerald-400 border-emerald-400 text-neutral-950 cursor-pointer active:scale-95'
              : isLight
              ? 'bg-neutral-100 border-neutral-200 text-neutral-400 opacity-50 cursor-not-allowed'
              : 'bg-neutral-850 border-neutral-800 text-neutral-500 opacity-50 cursor-not-allowed'
          }`}
        >
          <Save className="h-3.5 w-3.5" />
          <span>Save</span>
        </button>
      </div>

      {/* 2. Top Quick Action Bar: Air Roll Reset Level + Sub-Mode Buttons */}
      <div className={`p-2.5 rounded-xl border flex flex-col gap-2 ${sectionBg}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-mono opacity-80">
            <span>Sub-Mode:</span>
            <KeycapBadge shortcut="9 / 0" size="sm" isLight={isLight} />
          </div>

          <button
            type="button"
            onClick={() =>
              mutateActiveEditItemVariable((d) => {
                d.car.airRoll = 0;
                d.car.headingPitch = 0;
                if (d.car.speedFollowsHeading !== false) {
                  d.car.speedPitch = 0;
                }
              })
            }
            onMouseEnter={() =>
              onHoverDesc('Reset Car Air Roll and Pitch to horizontal level (0 deg).')
            }
            onMouseLeave={() => onHoverDesc(null)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-bold cursor-pointer transition-all active:scale-95 ${
              isLight
                ? 'bg-neutral-100 hover:bg-neutral-200 border-neutral-300 text-neutral-800'
                : 'bg-neutral-800 hover:bg-neutral-700 border-neutral-700 text-neutral-200'
            }`}
          >
            <RotateCw className="h-3 w-3" />
            <span>Air Roll Reset Level</span>
          </button>
        </div>

        <div
          className={`grid gap-1.5 ${
            visibleSubModeOptions.length === 3 ? 'grid-cols-3' : 'grid-cols-4'
          }`}
        >
          {visibleSubModeOptions.map((opt) => {
            const active = editSubMode === opt.id;
            const hintText =
              opt.id === 'car-heading' && speedFollowsHeading
                ? 'WASD/Space/V Move Car • Drag Mouse = Car Heading & Pitch • [ / ] = Car Speed • Q/E = Air Roll • O/P = Boost'
                : opt.hint;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setEditSubMode(opt.id)}
                onMouseEnter={() => onHoverDesc(hintText)}
                onMouseLeave={() => onHoverDesc(null)}
                className={`flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg border text-[10px] font-bold transition-all cursor-pointer ${
                  active
                    ? isLight
                      ? 'bg-neutral-900 border-neutral-900 text-white shadow-2xs'
                      : 'bg-white border-white text-neutral-900 shadow-2xs'
                    : isLight
                    ? 'bg-neutral-50 hover:bg-neutral-100 border-neutral-300 text-neutral-700'
                    : 'bg-neutral-850 hover:bg-neutral-800 border-neutral-700 text-neutral-300'
                }`}
              >
                {opt.icon}
                <span className="truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Core Shot Controls (Ordered as specified) */}
      <div className={`p-2.5 rounded-xl border flex flex-col gap-2 ${sectionBg}`}>
        {/* (a) Limit Boost Amount Toggle Switch (Default OFF -> Unlimited Boost) */}
        <div className="flex items-center justify-between py-0.5 px-1">
          <div className="flex flex-col">
            <span className="text-[11px] font-semibold">Limit Boost Amount</span>
            <span className="text-[10px] opacity-65">
              {limitBoostAmount
                ? `Limited (${Math.round(currentShot.car.initialBoost)}% initial boost)`
                : 'Unlimited Boost (INF)'}
            </span>
          </div>
          <ToggleSwitch
            checked={limitBoostAmount}
            onCheckedChange={(checked) =>
              mutateActiveEditItemVariable((d) => {
                d.car.unlimitedBoost = !checked;
              })
            }
            isLight={isLight}
            variant="neutral"
          />
        </div>

        {limitBoostAmount && (
          <CompactNumberSlider
            label="Boost Amount [O/P]"
            value={Math.round(currentShot.car.initialBoost)}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(b) =>
              mutateActiveEditItemVariable((d) => {
                d.car.initialBoost = b;
              })
            }
            isLight={isLight}
          />
        )}

        {/* (b) Time Limit Slider (Default 10s, Max 60s) */}
        <CompactNumberSlider
          label="Time Limit"
          value={currentShot.timeoutSeconds}
          min={1}
          max={60}
          step={1}
          unit="s"
          onChange={(val) =>
            mutateActiveEditItemVariable((d) => {
              d.timeoutSeconds = Math.max(1, Math.min(60, val));
            })
          }
          isLight={isLight}
        />

        {/* (c) Align Speed with Car Nose Toggle Switch (Default ON) */}
        <div className="flex items-center justify-between py-0.5 px-1">
          <div className="flex flex-col">
            <span className="text-[11px] font-semibold">Align Speed with Car Nose</span>
            <span className="text-[10px] opacity-65">
              {speedFollowsHeading
                ? 'Velocity follows car heading ([ / ] adjusts speed in Car Heading)'
                : 'Independent car velocity direction (Car Speed sub-mode enabled)'}
            </span>
          </div>
          <ToggleSwitch
            checked={speedFollowsHeading}
            onCheckedChange={(checked) => {
              mutateActiveEditItemVariable((d) => {
                d.car.speedFollowsHeading = checked;
                if (checked) {
                  d.car.speedYaw = d.car.headingYaw;
                  d.car.speedPitch = d.car.snapToGround ? 0 : d.car.headingPitch;
                }
              });
              if (checked && editSubMode === 'car-speed') {
                setEditSubMode('car-heading');
              }
            }}
            isLight={isLight}
            variant="neutral"
          />
        </div>

        {/* (d) Snap to Ground Toggle Switch (Default ON) */}
        <div className="flex items-center justify-between py-0.5 px-1">
          <div className="flex flex-col">
            <span className="text-[11px] font-semibold">Snap to Ground</span>
            <span className="text-[10px] opacity-65">
              60-frame suspension settle on ground [V]
            </span>
          </div>
          <ToggleSwitch
            checked={currentShot.car.snapToGround}
            onCheckedChange={(checked) =>
              mutateActiveEditItemVariable((d) => {
                d.car.snapToGround = checked;
                if (checked) {
                  d.car.location[2] = 17.05;
                  d.car.headingPitch = 0;
                  d.car.airRoll = 0;
                  d.car.hasFlip = true;
                  if (d.car.speedFollowsHeading !== false) {
                    d.car.speedPitch = 0;
                  }
                } else if (d.car.location[2] < 45) {
                  d.car.location[2] = 120;
                }
              })
            }
            isLight={isLight}
            variant="neutral"
          />
        </div>

        {/* (e) Has Flip Toggle Switch (Default ON; when airborne & OFF, spawns without flip) */}
        <div className="flex items-center justify-between py-0.5 px-1">
          <div className="flex flex-col">
            <span className="text-[11px] font-semibold">Has Flip</span>
            <span className="text-[10px] opacity-65">
              {currentShot.car.snapToGround
                ? 'On Ground (Flip always available)'
                : hasFlip
                ? 'Airborne spawn with flip available'
                : 'Airborne spawn with NO flip'}
            </span>
          </div>
          <ToggleSwitch
            checked={currentShot.car.snapToGround ? true : hasFlip}
            onCheckedChange={(checked) =>
              mutateActiveEditItemVariable((d) => {
                d.car.hasFlip = checked;
                if (!checked && d.car.snapToGround) {
                  d.car.snapToGround = false;
                  if (d.car.location[2] < 45) {
                    d.car.location[2] = 120;
                  }
                }
              })
            }
            isLight={isLight}
            variant="neutral"
          />
        </div>

        {/* (f) Random Angular Velocity Toggle Switch (Default ON) */}
        <div className="flex items-center justify-between py-0.5 px-1">
          <div className="flex flex-col">
            <span className="text-[11px] font-semibold">Random Angular Velocity</span>
            <span className="text-[10px] opacity-65">
              {currentShot.ball.randomAngularVelocity
                ? 'Ball spin auto-generated from speed'
                : 'Manual 3-axis ball angular velocity'}
            </span>
          </div>
          <ToggleSwitch
            checked={currentShot.ball.randomAngularVelocity}
            onCheckedChange={(checked) =>
              mutateActiveEditItemVariable((d) => {
                d.ball.randomAngularVelocity = checked;
              })
            }
            isLight={isLight}
            variant="neutral"
          />
        </div>

        {/* Manual Angular Velocity Sliders (ONLY shown when Random Angular Velocity is OFF) */}
        {!currentShot.ball.randomAngularVelocity && (
          <div className="flex flex-col gap-1.5 pt-1.5 border-t border-neutral-500/15">
            <CompactNumberSlider
              label="AngVel X (Pitch)"
              value={currentShot.ball.angularVelocity[0]}
              min={-6}
              max={6}
              step={0.1}
              unit=" r/s"
              onChange={(v) =>
                mutateActiveEditItemVariable((d) => {
                  d.ball.angularVelocity[0] = Number(v.toFixed(2));
                })
              }
              isLight={isLight}
            />
            <CompactNumberSlider
              label="AngVel Y (Roll)"
              value={currentShot.ball.angularVelocity[1]}
              min={-6}
              max={6}
              step={0.1}
              unit=" r/s"
              onChange={(v) =>
                mutateActiveEditItemVariable((d) => {
                  d.ball.angularVelocity[1] = Number(v.toFixed(2));
                })
              }
              isLight={isLight}
            />
            <CompactNumberSlider
              label="AngVel Z (Yaw)"
              value={currentShot.ball.angularVelocity[2]}
              min={-6}
              max={6}
              step={0.1}
              unit=" r/s"
              onChange={(v) =>
                mutateActiveEditItemVariable((d) => {
                  d.ball.angularVelocity[2] = Number(v.toFixed(2));
                })
              }
              isLight={isLight}
            />
          </div>
        )}

        {/* (g) Show Advanced Toggle Switch (Default OFF, never persisted) */}
        <div className="flex items-center justify-between py-0.5 px-1 border-t border-neutral-500/15 pt-2">
          <div className="flex flex-col">
            <span className="text-[11px] font-semibold">Show Advanced</span>
            <span className="text-[10px] opacity-65">
              Reveal exact coordinates, angles, speeds &amp; kickoff freeze
            </span>
          </div>
          <ToggleSwitch
            checked={showAdvanced}
            onCheckedChange={(checked) => setShowAdvanced(checked)}
            isLight={isLight}
            variant="neutral"
          />
        </div>
      </div>

      {/* 4. Advanced Detailed Parameters (ONLY visible when Show Advanced is ON) */}
      {showAdvanced && (
        <div className={`p-2.5 rounded-xl border flex flex-col gap-2 ${sectionBg}`}>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400">
            Advanced Car Parameters
          </span>

          <CompactNumberSlider
            label="Car Pos X"
            value={Math.round(currentShot.car.location[0])}
            min={-3900}
            max={3900}
            step={10}
            unit=" UU"
            onChange={(val) =>
              mutateActiveEditItemVariable((d) => {
                d.car.location[0] = val;
              })
            }
            isLight={isLight}
          />
          <CompactNumberSlider
            label="Car Pos Y"
            value={Math.round(currentShot.car.location[1])}
            min={-5000}
            max={5000}
            step={10}
            unit=" UU"
            onChange={(val) =>
              mutateActiveEditItemVariable((d) => {
                d.car.location[1] = val;
              })
            }
            isLight={isLight}
          />
          <CompactNumberSlider
            label="Car Pos Z"
            value={Math.round(currentShot.car.location[2])}
            min={17}
            max={1980}
            step={5}
            unit=" UU"
            onChange={(val) =>
              mutateActiveEditItemVariable((d) => {
                d.car.location[2] = val;
                if (val > 22) d.car.snapToGround = false;
              })
            }
            isLight={isLight}
          />

          <CompactNumberSlider
            label="Car Heading Yaw"
            value={radToDeg(currentShot.car.headingYaw)}
            min={-180}
            max={180}
            step={1}
            unit="°"
            onChange={(deg) =>
              mutateActiveEditItemVariable((d) => {
                d.car.headingYaw = degToRad(deg);
                if (d.car.speedFollowsHeading !== false) {
                  d.car.speedYaw = d.car.headingYaw;
                }
              })
            }
            isLight={isLight}
          />
          <CompactNumberSlider
            label="Car Heading Pitch"
            value={radToDeg(currentShot.car.headingPitch)}
            min={-85}
            max={85}
            step={1}
            unit="°"
            onChange={(deg) =>
              mutateActiveEditItemVariable((d) => {
                d.car.headingPitch = degToRad(deg);
                if (deg !== 0) d.car.snapToGround = false;
                if (d.car.speedFollowsHeading !== false) {
                  d.car.speedPitch = d.car.headingPitch;
                }
              })
            }
            isLight={isLight}
          />
          <CompactNumberSlider
            label="Car Air Roll [Q/E]"
            value={radToDeg(currentShot.car.airRoll)}
            min={-180}
            max={180}
            step={1}
            unit="°"
            onChange={(deg) =>
              mutateActiveEditItemVariable((d) => {
                d.car.airRoll = degToRad(deg);
                if (deg !== 0) d.car.snapToGround = false;
              })
            }
            isLight={isLight}
          />

          <CompactNumberSlider
            label="Car Speed [ / ]"
            value={Math.round(currentShot.car.speed)}
            min={0}
            max={2300}
            step={10}
            unit=" UU"
            onChange={(spd) =>
              mutateActiveEditItemVariable((d) => {
                d.car.speed = spd;
              })
            }
            isLight={isLight}
          />
          {!speedFollowsHeading && (
            <>
              <CompactNumberSlider
                label="Car Speed Yaw"
                value={radToDeg(currentShot.car.speedYaw)}
                min={-180}
                max={180}
                step={1}
                unit="°"
                onChange={(deg) =>
                  mutateActiveEditItemVariable((d) => {
                    d.car.speedYaw = degToRad(deg);
                  })
                }
                isLight={isLight}
              />
              <CompactNumberSlider
                label="Car Speed Pitch"
                value={radToDeg(currentShot.car.speedPitch)}
                min={-85}
                max={85}
                step={1}
                unit="°"
                onChange={(deg) =>
                  mutateActiveEditItemVariable((d) => {
                    d.car.speedPitch = degToRad(deg);
                  })
                }
                isLight={isLight}
              />
            </>
          )}

          <div className="pt-2 border-t border-neutral-500/15 flex flex-col gap-2">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-sky-400">
              Advanced Ball Parameters
            </span>

            <div className="flex items-center justify-between py-0.5 px-1">
              <div className="flex flex-col">
                <span className="text-[11px] font-semibold">Kickoff Freeze State</span>
                <span className="text-[10px] opacity-65">
                  Stationary mid-air until touched (or press &apos;[&apos; at 0 speed)
                </span>
              </div>
              <ToggleSwitch
                checked={currentShot.ball.kickoffState}
                onCheckedChange={(checked) =>
                  mutateActiveEditItemVariable((d) => {
                    d.ball.kickoffState = checked;
                    if (checked) d.ball.speed = 0;
                  })
                }
                isLight={isLight}
                variant="neutral"
              />
            </div>

            <CompactNumberSlider
              label="Ball Pos X"
              value={Math.round(currentShot.ball.location[0])}
              min={-3900}
              max={3900}
              step={10}
              unit=" UU"
              onChange={(val) =>
                mutateActiveEditItemVariable((d) => {
                  d.ball.location[0] = val;
                })
              }
              isLight={isLight}
            />
            <CompactNumberSlider
              label="Ball Pos Y"
              value={Math.round(currentShot.ball.location[1])}
              min={-5000}
              max={5000}
              step={10}
              unit=" UU"
              onChange={(val) =>
                mutateActiveEditItemVariable((d) => {
                  d.ball.location[1] = val;
                })
              }
              isLight={isLight}
            />
            <CompactNumberSlider
              label="Ball Pos Z"
              value={Math.round(currentShot.ball.location[2])}
              min={94}
              max={1940}
              step={5}
              unit=" UU"
              onChange={(val) =>
                mutateActiveEditItemVariable((d) => {
                  d.ball.location[2] = val;
                })
              }
              isLight={isLight}
            />

            {!currentShot.ball.kickoffState && (
              <>
                <CompactNumberSlider
                  label="Ball Speed [ / ]"
                  value={Math.round(currentShot.ball.speed)}
                  min={0}
                  max={4000}
                  step={10}
                  unit=" UU"
                  onChange={(spd) =>
                    mutateActiveEditItemVariable((d) => {
                      d.ball.speed = spd;
                    })
                  }
                  isLight={isLight}
                />
                <CompactNumberSlider
                  label="Ball Speed Yaw"
                  value={radToDeg(currentShot.ball.speedYaw)}
                  min={-180}
                  max={180}
                  step={1}
                  unit="°"
                  onChange={(deg) =>
                    mutateActiveEditItemVariable((d) => {
                      d.ball.speedYaw = degToRad(deg);
                    })
                  }
                  isLight={isLight}
                />
                <CompactNumberSlider
                  label="Ball Speed Pitch"
                  value={radToDeg(currentShot.ball.speedPitch)}
                  min={-85}
                  max={85}
                  step={1}
                  unit="°"
                  onChange={(deg) =>
                    mutateActiveEditItemVariable((d) => {
                      d.ball.speedPitch = degToRad(deg);
                    })
                  }
                  isLight={isLight}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
