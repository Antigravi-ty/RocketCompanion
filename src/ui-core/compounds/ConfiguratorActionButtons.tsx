import React from 'react';
import { FolderOpen, Lock, SlidersHorizontal } from 'lucide-react';
import { Button } from '../primitives/Button';

export interface ConfiguratorActionButtonsProps {
  isLight: boolean;
  isPrivateVaultUnlocked: boolean;
  workspaceDir?: string;
  vaultDir?: string;
  onOpenWorkspace: () => void;
  onOpenPrivateVault: () => void;
  onOpenAdvanced: () => void;
  onHover: (desc: string | null) => void;
}

export const ConfiguratorActionButtons: React.FC<ConfiguratorActionButtonsProps> = ({
  isLight,
  isPrivateVaultUnlocked,
  workspaceDir,
  vaultDir,
  onOpenWorkspace,
  onOpenPrivateVault,
  onOpenAdvanced,
  onHover,
}) => {
  return (
    <div
      className={`grid gap-2.5 ${
        isPrivateVaultUnlocked ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'
      }`}
    >
      <div
        onMouseEnter={() =>
          onHover(`Open public user workspace directory (${workspaceDir || 'workspace'}).`)
        }
        onMouseLeave={() => onHover(null)}
      >
        <Button
          variant="secondary"
          size="md"
          className="w-full"
          isLight={isLight}
          icon={<FolderOpen className="w-4 h-4" />}
          onClick={onOpenWorkspace}
        >
          Open Workspace Folder
        </Button>
      </div>

      {isPrivateVaultUnlocked && (
        <div
          onMouseEnter={() =>
            onHover(`Open isolated private vault directory (${vaultDir || '.vault'}).`)
          }
          onMouseLeave={() => onHover(null)}
        >
          <Button
            variant="secondary"
            size="md"
            className="w-full"
            isLight={isLight}
            icon={<Lock className="w-4 h-4" />}
            onClick={onOpenPrivateVault}
          >
            Open Private Vault Folder
          </Button>
        </div>
      )}

      <div
        onMouseEnter={() =>
          onHover('Open Advanced diagnostics, display telemetry and refresh rate verification.')
        }
        onMouseLeave={() => onHover(null)}
      >
        <Button
          variant="secondary"
          size="md"
          className="w-full"
          isLight={isLight}
          icon={<SlidersHorizontal className="w-4 h-4" />}
          onClick={onOpenAdvanced}
        >
          Advanced
        </Button>
      </div>
    </div>
  );
};
