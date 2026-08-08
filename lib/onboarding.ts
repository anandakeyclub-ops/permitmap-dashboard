// Onboarding Completion Contract (P4) — pure, server-authoritative logic (no I/O).
//
// The incident: a Pro customer had tier=pro (allowance 5) but NEVER selected a county, so
// allowed_counties was null and they silently received no permits — yet were treated as onboarded.
// This module eliminates the conflation of "the plan ALLOWS N counties" with "the customer SELECTED
// these counties". onboarding_complete is true ONLY when a real, valid configuration exists.
//
// Field semantics (see the P4 storage decision):
//   entitlement_county_limit = number the plan allows (derived from tier)   ← a limit, never a list
//   selected_counties        = concrete canonical county slugs the customer chose (allowed_counties)
//   selected_trades          = concrete canonical trade slugs the customer chose
//   onboarding_complete      = evaluateOnboarding(...).complete

// Canonical trade taxonomy for the dashboard. Mirrors permit_bot team_report.SUPPORTED_TRADES —
// keep these in sync (there is no cross-repo shared source today).
export const SUPPORTED_TRADES = [
  'roofing', 'hvac', 'plumbing', 'electrical', 'pool', 'solar', 'general_contractor',
] as const;
export type Trade = typeof SUPPORTED_TRADES[number];
const TRADE_ALIASES: Record<string, string> = { general_contractors: 'general_contractor', gc: 'general_contractor' };

// Numeric county ALLOWANCE per tier (mirrors provisioning.TIER_COUNTIES). This is a limit only.
export const TIER_COUNTY_LIMIT: Record<string, number> = { starter: 1, pro: 5, team: 99 };
// Tiers that grant ALL counties → no per-county selection required (mirrors provisioning.ALL_COUNTY_TIERS).
export const ALL_COUNTY_TIERS = new Set<string>(['team']);
export const PAID_TIERS = new Set<string>(['starter', 'pro', 'team']);

export function entitlementCountyLimit(tier?: string): number {
  return TIER_COUNTY_LIMIT[tier || ''] ?? 0;
}

// Canonical slug normalizers (match lib/entitlement.normalizeCounty + provisioning.resolveSelectedCounty).
export function normalizeCountySlug(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/[.\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
export function normalizeTradeSlug(s: string): string {
  const n = String(s || '').trim().toLowerCase().replace(/[.\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return TRADE_ALIASES[n] || n;
}

export interface Validation { ok: boolean; cleaned: string[]; errors: string[] }

// Validate + canonicalize + dedup selected counties, enforcing the tier limit SERVER-SIDE.
// `supportedSlugs` is the authoritative county list (from the API /counties); when empty the
// supported-membership check is skipped (caller could not load it) but limit/count still apply.
export function validateSelectedCounties(raw: string[] | undefined, tier: string, supportedSlugs: string[] = []): Validation {
  const errors: string[] = [];
  const limit = entitlementCountyLimit(tier);
  const supported = new Set(supportedSlugs.map(normalizeCountySlug).filter(Boolean));
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const c of raw || []) {
    const s = normalizeCountySlug(c);
    if (!s || seen.has(s)) continue;         // drop blanks + duplicates deterministically
    seen.add(s);
    if (supported.size && !supported.has(s)) { errors.push(`unsupported_county:${s}`); continue; }
    cleaned.push(s);
  }
  if (!ALL_COUNTY_TIERS.has(tier)) {
    if (cleaned.length < 1) errors.push('no_county_selected');
    if (limit > 0 && cleaned.length > limit) errors.push(`exceeds_county_limit:${cleaned.length}>${limit}`);
  }
  return { ok: errors.length === 0, cleaned, errors };
}

// Validate + canonicalize + dedup selected trades against the canonical taxonomy.
export function validateSelectedTrades(raw: string[] | undefined): Validation {
  const errors: string[] = [];
  const supported = new Set<string>(SUPPORTED_TRADES as readonly string[]);
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const t of raw || []) {
    const s = normalizeTradeSlug(t);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (!supported.has(s)) { errors.push(`unsupported_trade:${s}`); continue; }
    cleaned.push(s);
  }
  if (cleaned.length < 1) errors.push('no_trade_selected');
  return { ok: errors.length === 0, cleaned, errors };
}

export interface OnboardingState {
  tier?: string | null;
  allowed_counties?: string[] | null;   // selected counties (NOT the numeric allowance)
  selected_trades?: string[] | null;
  email?: string | null;
}
export interface OnboardingResult { complete: boolean; reasons: string[]; needs_review: boolean }

// The completion predicate. complete=true ONLY when a real, valid, in-limit configuration exists.
// needs_review=true flags a config that became invalid without the customer's action (e.g. a
// downgrade left more selected counties than the new tier allows) — we never silently delete.
export function evaluateOnboarding(s: OnboardingState, supportedSlugs: string[] = []): OnboardingResult {
  const reasons: string[] = [];
  let needs_review = false;
  const tier = s.tier || '';
  if (!PAID_TIERS.has(tier)) return { complete: false, reasons: ['no_paid_tier'], needs_review: false };
  if (!s.email) reasons.push('no_delivery_email');

  const counties = s.allowed_counties || [];
  const limit = entitlementCountyLimit(tier);
  if (!ALL_COUNTY_TIERS.has(tier)) {
    if (counties.length === 0) {
      reasons.push('no_county_selected');
    } else {
      const cv = validateSelectedCounties(counties, tier, supportedSlugs);
      if (cv.errors.some((e) => e.startsWith('unsupported_county'))) reasons.push('invalid_county');
      if (cv.cleaned.length > limit) { reasons.push('over_county_limit'); needs_review = true; }
    }
  }

  const trades = s.selected_trades || [];
  if (trades.length === 0) reasons.push('no_trade_selected');
  else if (validateSelectedTrades(trades).errors.some((e) => e.startsWith('unsupported_trade'))) reasons.push('invalid_trade');

  return { complete: reasons.length === 0, reasons, needs_review };
}

export type OnboardingClass = 'onboarding_complete' | 'onboarding_incomplete' | 'invalid_configuration';

// Classify an existing customer WITHOUT mutating or fabricating selections (P4 Phase 7).
export function classifyOnboarding(s: OnboardingState, supportedSlugs: string[] = []): OnboardingClass {
  const r = evaluateOnboarding(s, supportedSlugs);
  if (r.complete) return 'onboarding_complete';
  if (r.needs_review || r.reasons.some((x) => x.startsWith('invalid_'))) return 'invalid_configuration';
  return 'onboarding_incomplete';
}

// Recompute onboarding_complete after a plan change WITHOUT deleting selections (P4 Phase 9).
// Upgrade → limit grows, selections preserved, may now be complete. Downgrade over the new limit →
// complete=false + needs_review (selections kept for the customer to trim). Returns the metadata
// patch to persist (only onboarding_complete; selections are never auto-removed here).
export function recomputeOnboardingOnTierChange(s: OnboardingState, supportedSlugs: string[] = []): { onboarding_complete: boolean; needs_review: boolean } {
  const r = evaluateOnboarding(s, supportedSlugs);
  return { onboarding_complete: r.complete, needs_review: r.needs_review };
}
