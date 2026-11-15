const warnedFloatingKeys = new Set<string>();

/**
 * Outputs a prominent yellow console warning/error banner (modeled on `notificationScheduler.ts`)
 * and dispatches a `rc-ui:floating-schema-warning` DOM event when a Floating Window surface or
 * spawn configuration omits the mandatory boolean `hideFooter` property.
 */
export function triggerFloatingSchemaWarning(message: string, dedupeKey?: string): void {
  if (dedupeKey && warnedFloatingKeys.has(dedupeKey)) {
    return;
  }
  if (dedupeKey) {
    warnedFloatingKeys.add(dedupeKey);
  }

  const banner = `[FLOATING WINDOW SCHEMA ERROR] ${message}`;
  const bannerStyle =
    'background: #eab308; color: #09090b; font-weight: bold; padding: 6px 12px; border-radius: 4px; font-size: 13px;';

  console.warn(`%c${banner}`, bannerStyle);
  console.error(`%c${banner}`, bannerStyle);

  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('rc-ui:floating-schema-warning', { detail: { message } })
      );
    }
  } catch {
    // Fallback if window is unavailable
  }
}

/**
 * Validates that a Floating Window declaration or spawn item explicitly specifies `hideFooter: boolean`.
 * Returns the resolved boolean `hideFooter` value (`false` when missing, after emitting the yellow error banner).
 */
export function validateFloatingWindowHideFooter(
  config: { id?: string; title?: string; hideFooter?: unknown },
  contextLabel = 'FloatingWindow'
): boolean {
  if (typeof config.hideFooter !== 'boolean') {
    const winId = config.id || config.title || 'anonymous';
    triggerFloatingSchemaWarning(
      `Missing required boolean property 'hideFooter' in ${contextLabel} '${winId}'. ` +
        `Must be explicitly set to 'hideFooter: true' or 'hideFooter: false'. Silent fallback is disabled.`,
      `${contextLabel}:${winId}`
    );
    return false;
  }
  return config.hideFooter;
}

const VALID_PROFILE_TIER_POLICIES = new Set([
  'tier-invariant',
  'user-dev-split',
  'auth-triad',
]);

/**
 * Validates that a Menu Recipe `SURFACE_META` explicitly declares `profileTierPolicy`
 * (`'tier-invariant' | 'user-dev-split' | 'auth-triad'`), and that `'auth-triad'` surfaces
 * declare `variants` with `storeOverrides`.
 */
export function validateRecipeProfileTierPolicy(
  meta: {
    id?: string;
    title?: string;
    profileTierPolicy?: unknown;
    variants?: Array<{ profileTier?: string; storeOverrides?: unknown }>;
  },
  contextLabel = 'Recipe'
): void {
  const surfaceId = meta.id || meta.title || 'anonymous';
  if (
    typeof meta.profileTierPolicy !== 'string' ||
    !VALID_PROFILE_TIER_POLICIES.has(meta.profileTierPolicy)
  ) {
    triggerFloatingSchemaWarning(
      `Missing or invalid required 'profileTierPolicy' in ${contextLabel} '${surfaceId}'. ` +
        `Must be 'tier-invariant', 'user-dev-split', or 'auth-triad'.`,
      `recipe-tier-policy:${contextLabel}:${surfaceId}`
    );
    return;
  }

  if (meta.profileTierPolicy === 'auth-triad') {
    const hasScopedVariant = (meta.variants ?? []).some(
      (v) => Boolean(v.profileTier) && Boolean(v.storeOverrides)
    );
    if (!hasScopedVariant) {
      triggerFloatingSchemaWarning(
        `Recipe '${surfaceId}' declares profileTierPolicy='auth-triad' in ${contextLabel} ` +
          `but has no variants with 'profileTier' and 'storeOverrides'.`,
        `recipe-tier-variants:${contextLabel}:${surfaceId}`
      );
    }
  }
}
