import React from 'react';
import {
  useReferenceOverlayStore,
  DEFAULT_REFERENCE_RESOLUTION,
  createDefaultResolutionProfile,
} from '../../ui-core/stores/referenceOverlayStore';

/**
 * HitboxReferenceOverlayLayer
 * Fullscreen non-interactive reference image overlay positioned strictly:
 * - Above the 3D WebGL game canvas & HUD (z-[4])
 * - Below the FloatingWindowManager (z-[5])
 * - pointer-events-none so it never intercepts mouse clicks, drags, or keyboard controls
 * - Uses standard normal alpha compositing.
 */
export const HitboxReferenceOverlayLayer: React.FC = () => {
  const enabled = useReferenceOverlayStore((s) => s.enabled);
  const images = useReferenceOverlayStore((s) => s.images);
  const activeIndex = useReferenceOverlayStore((s) => s.activeIndex);
  const activeResolutionKey = useReferenceOverlayStore((s) => s.activeResolutionKey);
  const profiles = useReferenceOverlayStore((s) => s.profiles);

  const activeImage = images[activeIndex] || null;
  const effectiveResKey =
    activeResolutionKey !== 'ALL'
      ? activeResolutionKey
      : activeImage
      ? `${activeImage.width}x${activeImage.height}`
      : DEFAULT_REFERENCE_RESOLUTION;

  const profile =
    profiles[effectiveResKey] || createDefaultResolutionProfile(effectiveResKey);

  if (!enabled || !activeImage) {
    return null;
  }

  const transformStyle = `translate3d(calc(-50% + ${profile.offsetX}px), calc(-50% + ${profile.offsetY}px), 0) scale(${profile.scaleX}, ${profile.scaleY})`;

  return (
    <div
      data-ui-element="hitbox-reference-overlay"
      className="fixed inset-0 pointer-events-none select-none overflow-hidden z-[4]"
    >
      <img
        src={activeImage.url}
        alt={activeImage.name}
        draggable={false}
        className="absolute left-1/2 top-1/2 max-w-none max-h-none pointer-events-none select-none"
        style={{
          width: `${activeImage.width}px`,
          height: `${activeImage.height}px`,
          opacity: profile.opacity,
          transform: transformStyle,
          transformOrigin: 'center center',
          filter: profile.invertImage ? 'invert(1)' : undefined,
        }}
      />
    </div>
  );
};
