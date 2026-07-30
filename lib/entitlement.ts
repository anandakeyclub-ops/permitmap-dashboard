// Pure, testable county-entitlement logic for the dashboard selector + upgrade messaging.
//
// County access is ENTITLEMENT-based (the user's allowed_counties), NOT list position ×
// tier county-count. The previous selector locked `countyIndex >= limits.counties`, which
// made entitled counties beyond that index (e.g. Marion for a Marion-only Pro trial) render
// locked, and made the first N counties render available regardless of entitlement.
//
// Data access remains server-authoritative (the API returns preview_locked + zero rows for
// non-entitled counties); this module governs UI display/selection only.

export const ALL_COUNTY_TIERS = new Set<string>(['team']);

export function normalizeCounty(k?: string | null): string {
  return (k || '').trim().toLowerCase().replace(/[.\s-]+/g, '_');
}

/**
 * A county is locked (→ shows the upgrade path) iff, for a county-limited tier, it is NOT in
 * the user's allowed_counties. Team grants all counties (never locked). Preview / no
 * allowed_counties → locked (upgrade).
 */
export function isCountyLocked(countyKey: string, tier: string, allowedCounties?: string[]): boolean {
  if (ALL_COUNTY_TIERS.has(tier)) return false;
  const allowed = (allowedCounties || []).map(normalizeCounty).filter(Boolean);
  if (allowed.length === 0) return true; // preview / unprovisioned → all locked
  return !allowed.includes(normalizeCounty(countyKey));
}

/** County keys the user is entitled to, preserving the input list order. */
export function entitledCountyKeys(
  counties: { key: string }[], tier: string, allowedCounties?: string[],
): string[] {
  return counties.filter(c => !isCountyLocked(c.key, tier, allowedCounties)).map(c => c.key);
}

/** First entitled county key — used to default the selection to an entitled (not locked) county. */
export function defaultEntitledCounty(
  counties: { key: string }[], tier: string, allowedCounties?: string[],
): string {
  if (ALL_COUNTY_TIERS.has(tier)) return counties[0]?.key || '';
  return entitledCountyKeys(counties, tier, allowedCounties)[0] || '';
}

/**
 * D — explain what the trial/plan currently includes instead of a bare "Upgrade".
 * e.g. "This trial currently includes Marion County. Upgrade to add Duval County."
 */
export function upgradeMessageForCounty(countyLabel: string | undefined, allowedCountyLabels: string[]): string {
  const target = countyLabel || 'this county';
  if (allowedCountyLabels.length === 1) {
    return `This trial currently includes ${allowedCountyLabels[0]} County. Upgrade to add ${target} County.`;
  }
  if (allowedCountyLabels.length > 1) {
    return `Your plan currently includes ${allowedCountyLabels.join(', ')}. Upgrade to add ${target} County.`;
  }
  return `Start your trial to unlock ${target} County.`;
}
