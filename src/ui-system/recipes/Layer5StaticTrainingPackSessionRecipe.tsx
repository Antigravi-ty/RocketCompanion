import React from 'react';
import {
  Layer5StaticTrainingPackEditRecipe,
  promptExitStaticTrainingEditSession,
} from './Layer5StaticTrainingPackEditRecipe';

export { Layer5StaticTrainingPackEditRecipe, promptExitStaticTrainingEditSession };

export interface Layer5StaticTrainingPackSessionRecipeProps {
  isLight?: boolean;
  transparent?: boolean;
  onBack?: () => void;
  onCollapsePreview?: () => void;
}

/**
 * [Recipe] Layer 5 Static Training Pack Edit Session Wrapper
 * Delegates directly to Layer5StaticTrainingPackEditRecipe (Six Echo / 6E).
 */
export const Layer5StaticTrainingPackSessionRecipe: React.FC<
  Layer5StaticTrainingPackSessionRecipeProps
> = ({ isLight = false, transparent = true, onBack, onCollapsePreview }) => {
  return (
    <Layer5StaticTrainingPackEditRecipe
      isLight={isLight}
      transparent={transparent}
      onCollapseDrawer={onCollapsePreview}
      onExitSession={() => {
        onBack?.();
      }}
    />
  );
};
