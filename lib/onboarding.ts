// Onboarding Completion Contract (P4) — pure, server-authoritative logic (no I/O).
//
// The incident: a Pro customer had tier=pro (allowance 5) but NEVER selected a county, so they
// silently received no permits — yet were treated as onboarded. This eliminates the conflation of
// "the plan ALLOWS N counties" (a number, derived from tier) with "the customer SELECTED these
// counties" (a list).
//
//   county_limit       = TIER_COUNTY_LIMIT[tier]                 ← a number, never a selection
//   selected_counties  = publicMetadata.selected_counties        ← canonical slug list (new field)
//   selected_trades    = publicMetadata.selected_trades          ← canonical trade list (new field)
//   onboarding_state   = evaluateOnboarding(...).state           ← not_started|incomplete|needs_review|complete
//
// Legacy: an older field `publicMetadata.allowed_counties` held the selection as a slug LIST. We
// migrate it as the selection ONLY when it is a real list of slugs — a numeric allowance like "5"
// is NEVER interpreted as a selection. New writes use `selected_counties`.

// Canonical trade taxonomy (7 slugs). Confirmed 2026-08-08 as the committed platform-wide set
// (matches permitmap-api main.py TRADES + permit_bot trades.py). generator/foundation are county
// SOURCE-coverage concerns, NOT selectable trades. Keep in sync across repos (no shared module).
export const TRADE_TAXONOMY_VERSION = 1;   // must match permit_bot trades.py + permitmap-api
export const SUPPORTED_TRADES = [
  'roofing', 'hvac', 'plumbing', 'electrical', 'pool', 'solar', 'general_contractor',
] as const;
export type Trade = typeof SUPPORTED_TRADES[number];
const TRADE_ALIASES: Record<string, string> = { general_contractors: 'general_contractor', gc: 'general_contractor' };

export const TIER_COUNTY_LIMIT: Record<string, number> = { starter: 1, pro: 5, team: 99 };
export const ALL_COUNTY_TIERS = new Set<string>(['team']);
export const PAID_TIERS = new Set<string>(['starter', 'pro', 'team']);

// Onboarding states (richer than a boolean so the lifecycle monitor can alert on the real failure).
export const ONBOARDING_STATES = { NOT_STARTED: 'not_started', INCOMPLETE: 'incomplete', NEEDS_REVIEW: 'needs_review', COMPLETE: 'complete' } as const;
export type OnboardingStateName = typeof ONBOARDING_STATES[keyof typeof ONBOARDING_STATES];
// Canonical reason codes (stable; consumed by alerts/monitor).
export const REASONS = {
  MISSING_COUNTY: 'missing_county', MISSING_TRADE: 'missing_trade', OVER_LIMIT: 'over_county_limit',
  INVALID_COUNTY: 'invalid_county', INVALID_TRADE: 'invalid_trade', MISSING_EMAIL: 'missing_delivery_email',
} as const;

export function entitlementCountyLimit(tier?: string): number {
  return TIER_COUNTY_LIMIT[tier || ''] ?? 0;
}

export function normalizeCountySlug(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/[.\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
export function normalizeTradeSlug(s: string): string {
  const n = String(s || '').trim().toLowerCase().replace(/[.\s-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return TRADE_ALIASES[n] || n;
}

// Read the customer's SELECTED counties from Clerk publicMetadata, honoring the legacy field.
// Canonical `selected_counties` wins; else legacy `allowed_counties` ONLY if it's a real slug list.
// A numeric/string/absent value (e.g. the "5" allowance) is NEVER a selection.
export function migrateLegacySelectedCounties(pm: Record<string, any> | null | undefined): string[] {
  if (!pm) return [];
  if (Array.isArray(pm.selected_counties)) return pm.selected_counties.filter((c: any) => typeof c === 'string' && c.trim());
  if (Array.isArray(pm.allowed_counties)) return pm.allowed_counties.filter((c: any) => typeof c === 'string' && c.trim());
  return [];
}

export interface Validation { ok: boolean; cleaned: string[]; errors: string[] }

export function validateSelectedCounties(raw: string[] | undefined, tier: string, supportedSlugs: string[] = []): Validation {
  const errors: string[] = [];
  const limit = entitlementCountyLimit(tier);
  const supported = new Set(supportedSlugs.map(normalizeCountySlug).filter(Boolean));
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const c of raw || []) {
    const s = normalizeCountySlug(c);
    if (!s || seen.has(s)) continue;
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
  selected_counties?: string[] | null;   // the customer's chosen counties (NOT the numeric allowance)
  selected_trades?: string[] | null;
  email?: string | null;
}
export interface OnboardingResult { state: OnboardingStateName; complete: boolean; reasons: string[]; needs_review: boolean }

// complete ONLY when a real, valid, in-limit config + a trade + a delivery email exist. reasons use
// canonical codes for the lifecycle monitor.
export function evaluateOnboarding(s: OnboardingState, supportedSlugs: string[] = []): OnboardingResult {
  const tier = s.tier || '';
  if (!PAID_TIERS.has(tier)) return { state: ONBOARDING_STATES.NOT_STARTED, complete: false, reasons: ['no_paid_tier'], needs_review: false };

  const reasons: string[] = [];
  let needs_review = false;
  if (!s.email) reasons.push(REASONS.MISSING_EMAIL);

  const counties = s.selected_counties || [];
  if (!ALL_COUNTY_TIERS.has(tier)) {
    if (counties.length === 0) {
      reasons.push(REASONS.MISSING_COUNTY);
    } else {
      const cv = validateSelectedCounties(counties, tier, supportedSlugs);
      if (cv.errors.some((e) => e.startsWith('unsupported_county'))) { reasons.push(REASONS.INVALID_COUNTY); needs_review = true; }
      if (cv.cleaned.length > entitlementCountyLimit(tier)) { reasons.push(REASONS.OVER_LIMIT); needs_review = true; }
    }
  }

  // Trade required for county-limited delivery; team delivers via an all-trades fallback → optional.
  const trades = s.selected_trades || [];
  if (!ALL_COUNTY_TIERS.has(tier) && trades.length === 0) reasons.push(REASONS.MISSING_TRADE);
  else if (trades.length && validateSelectedTrades(trades).errors.some((e) => e.startsWith('unsupported_trade'))) { reasons.push(REASONS.INVALID_TRADE); needs_review = true; }

  const state = reasons.length === 0 ? ONBOARDING_STATES.COMPLETE
    : needs_review ? ONBOARDING_STATES.NEEDS_REVIEW : ONBOARDING_STATES.INCOMPLETE;
  return { state, complete: state === ONBOARDING_STATES.COMPLETE, reasons, needs_review };
}

export type OnboardingClass = 'onboarding_complete' | 'onboarding_incomplete' | 'invalid_configuration';
export function classifyOnboarding(s: OnboardingState, supportedSlugs: string[] = []): OnboardingClass {
  const st = evaluateOnboarding(s, supportedSlugs).state;
  if (st === ONBOARDING_STATES.COMPLETE) return 'onboarding_complete';
  if (st === ONBOARDING_STATES.NEEDS_REVIEW) return 'invalid_configuration';
  return 'onboarding_incomplete';
}

// Recompute onboarding after a plan change WITHOUT deleting selections (Phase 9).
export function recomputeOnboardingOnTierChange(s: OnboardingState, supportedSlugs: string[] = []): { onboarding_complete: boolean; onboarding_state: OnboardingStateName; needs_review: boolean } {
  const r = evaluateOnboarding(s, supportedSlugs);
  return { onboarding_complete: r.complete, onboarding_state: r.state, needs_review: r.needs_review };
}
