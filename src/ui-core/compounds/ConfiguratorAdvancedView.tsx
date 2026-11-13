import React from 'react';
import { ArrowLeft, Cpu } from 'lucide-react';
import { Button } from '../primitives/Button';
import { DisplayRefreshRateCard } from './DisplayRefreshRateCard';

export interface ConfiguratorAdvancedViewProps {
  isLight: boolean;
  onBack: () => void;
  onHover: (desc: string | null) => void;
}

export const ConfiguratorAdvancedView: React.FC<ConfiguratorAdvancedViewProps> = ({
  isLight,
  onBack,
  onHover,
}) => {
  return (
    <div className="flex flex-col gap-3.5 w-full">
      <div className="flex items-center justify-between pb-1 border-b border-white/5">
        <div
          onMouseEnter={() => onHover('Return to the main Configurator settings screen.')}
          onMouseLeave={() => onHover(null)}
        >
          <Button
            variant="ghost"
            size="sm"
            isLight={isLight}
            icon={<ArrowLeft className="w-4 h-4" />}
            onClick={onBack}
          >
            Back
          </Button>
        </div>

        <div className="flex items-center gap-1.5 text-xs font-mono text-neutral-400">
          <Cpu className="w-3.5 h-3.5 text-sky-400" />
          <span>Advanced Telemetry & Diagnostics</span>
        </div>
      </div>

      <div
        onMouseEnter={() =>
          onHover(
            'Live requestAnimationFrame FPS sampling, display monitor query, and performance diagnostics.'
          )
        }
        onMouseLeave={() => onHover(null)}
      >
        <DisplayRefreshRateCard isLight={isLight} defaultExpanded={true} />
      </div>
    </div>
  );
};
