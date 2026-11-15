import React from 'react';
import { Activity } from 'lucide-react';
import { lookupLucideIcon } from '../primitives/iconLookup';
import { PRESET_WINDOWS } from '../stores/devFloatingPresets';

export const RotateCcwClockIcon: React.FC<{ className?: string }> = ({ className = 'h-4 w-4 shrink-0' }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    data-lucide="rotate-ccw-clock"
    className={`lucide lucide-rotate-ccw-clock ${className}`}
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </svg>
);

export interface FloatingWindowIconProps {
  category?: string;
  id?: string;
  className?: string;
}

const PRESET_BY_ID = new Map(PRESET_WINDOWS.map((preset) => [preset.id, preset]));

/**
 * Canonical unified icon resolver for floating windows, ghost flights, and minimized stack tray items.
 * Resolves icon and color directly from PRESET_WINDOWS so menu entries, window headers, and stack items never drift.
 */
export const getFloatingWindowIcon = (category?: string, id?: string, extraClass: string = 'h-4 w-4 shrink-0') => {
  const normId = (id || '').toLowerCase();
  const matchedPreset =
    (id ? PRESET_BY_ID.get(id) : undefined) ??
    PRESET_WINDOWS.find((preset) => normId === preset.id || normId.startsWith(`${preset.id}-`));

  if (matchedPreset) {
    const IconComp = lookupLucideIcon(matchedPreset.iconName) ?? Activity;
    return <IconComp className={`${extraClass} ${matchedPreset.iconColor}`} />;
  }

  const normCat = (category || '').toLowerCase();
  if (normCat === 'diagnostic' || normId.includes('telemetry') || normId.includes('performance')) {
    return <Activity className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
  }

  return <Activity className={`${extraClass} text-sky-500 dark:text-sky-400`} />;
};

export const FloatingWindowIcon: React.FC<FloatingWindowIconProps> = ({ category, id, className }) => {
  return <>{getFloatingWindowIcon(category, id, className)}</>;
};
