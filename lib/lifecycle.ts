// Canonical PermitMap customer lifecycle state machine (P4 seams 1-3).
//
// ONE source of lifecycle truth. It does NOT re-implement billing or onboarding rules — it composes
// the authoritative Stripe subscription.status with the canonical onboarding contract
// (evaluateOnboarding from ./onboarding, driven by Clerk `selected_counties`/`selected_trades`).
//
// Critical correctness rule proven by the Nicholas case: onboarding readiness MUST come from Clerk
// canonical selections via evaluateOnboarding — NEVER from the API digest's analytics-county
// enrichment (which can show a county for a preview user who never selected one). A preview/engaged
// user can therefore never be mistaken for paid or onboarded.
import { evaluateOnboarding, PAID_TIERS, type OnboardingState } from './onboarding';

export type LifecycleState =
  | 'PREVIEW'                          // authenticated, no paid tier / no live subscription
  | 'CHECKOUT_STARTED'                 // Stripe subscription incomplete (checkout begun, not trialing yet)
  | 'TRIALING_ONBOARDING_INCOMPLETE'   // trialing but county/trade/email not canonically complete
  | 'TRIALING_PRODUCT_READY'           // trialing AND onboarding complete → safe to convert
  | 'ACTIVE_PAID'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'DISPUTED'
  | 'INTERNAL_TEST';

// Authoritative source per state (documentation, not executed):
//   PREVIEW / CHECKOUT_STARTED / TRIALING_* / ACTIVE_PAID / PAST_DUE / CANCELED → Stripe subscription.status (+ tier)
//   TRIALING_ONBOARDING_INCOMPLETE vs _PRODUCT_READY                            → evaluateOnboarding (Clerk canonical)
//   DISPUTED                                                                    → Stripe dispute present
//   INTERNAL_TEST                                                               → explicit operator/test marker

export interface LifecycleInputs {
  tier?: string | null;                // Clerk publicMetadata.tier
  subStatus?: string | null;           // Stripe subscription.status
  hasDispute?: boolean;                // any Stripe dispute on the customer
  internalTest?: boolean;              // explicit test/operator marker (never inferred)
  // onboarding is evaluated from CANONICAL Clerk selections only:
  selected_counties?: string[] | null;
  selected_trades?: string[] | null;
  email?: string | null;
  onboarding?: OnboardingState;        // optional pre-evaluated (else built from the fields above)
  paused?: boolean;                    // Stripe subscription.pause_collection set (interlock active)
}

function onboardingComplete(i: LifecycleInputs, supported: string[] = []): boolean {
  const s: OnboardingState = i.onboarding ?? {
    tier: i.tier, selected_counties: i.selected_counties, selected_trades: i.selected_trades,
    email: i.email,
  } as OnboardingState;
  return evaluateOnboarding(s, supported).complete;
}

export function lifecycleState(i: LifecycleInputs, supported: string[] = []): LifecycleState {
  if (i.internalTest) return 'INTERNAL_TEST';
  if (i.hasDispute) return 'DISPUTED';
  const s = (i.subStatus || '').toLowerCase().trim();
  const paid = PAID_TIERS.has((i.tier || '').toLowerCase());

  if (s === 'trialing') {
    return onboardingComplete(i, supported) ? 'TRIALING_PRODUCT_READY' : 'TRIALING_ONBOARDING_INCOMPLETE';
  }
  if (s === 'active') return 'ACTIVE_PAID';
  if (s === 'past_due' || s === 'unpaid') return 'PAST_DUE';
  if (s === 'canceled' || s === 'incomplete_expired') return 'CANCELED';
  if (s === 'incomplete') return 'CHECKOUT_STARTED';
  // no live subscription (or unknown status) + not a paid tier → preview. A paid tier with no
  // subscription status falls back to PREVIEW too (nothing to bill).
  return paid && s ? 'PREVIEW' : 'PREVIEW';
}

// Documented allowed transitions (a lint/monitor may assert against these; not enforced at runtime).
export const ALLOWED_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  PREVIEW: ['CHECKOUT_STARTED', 'INTERNAL_TEST'],
  CHECKOUT_STARTED: ['TRIALING_ONBOARDING_INCOMPLETE', 'TRIALING_PRODUCT_READY', 'CANCELED', 'PREVIEW'],
  TRIALING_ONBOARDING_INCOMPLETE: ['TRIALING_PRODUCT_READY', 'CANCELED', 'PAST_DUE'],
  TRIALING_PRODUCT_READY: ['ACTIVE_PAID', 'TRIALING_ONBOARDING_INCOMPLETE', 'CANCELED'],
  ACTIVE_PAID: ['PAST_DUE', 'CANCELED', 'DISPUTED'],
  PAST_DUE: ['ACTIVE_PAID', 'CANCELED', 'DISPUTED'],
  CANCELED: ['CHECKOUT_STARTED'],           // a canceled customer may re-subscribe
  DISPUTED: ['CANCELED'],
  INTERNAL_TEST: [],
};

// ── Seam 3: trial → first-charge interlock ────────────────────────────────────
// At `customer.subscription.trial_will_end`, decide whether the first paid charge may proceed.
// Chosen mechanism = PAUSE COLLECTION (behavior 'void'), NOT cancel/extend, because it:
//   • withholds the first charge (no charge attempt → no dispute risk, the Freitas failure mode)
//   • preserves the subscription + trial + customer data intact
//   • is fully REVERSIBLE — clearing pause_collection resumes normal billing once product-ready
//   • needs no re-checkout and loses no continuity (cancel would; extend only defers the problem)
export type InterlockAction = 'allow' | 'pause';
export interface InterlockResult { action: InterlockAction; reason: string; state: LifecycleState }

export function interlockDecision(i: LifecycleInputs, supported: string[] = []): InterlockResult {
  const state = lifecycleState(i, supported);
  if (state === 'TRIALING_PRODUCT_READY') {
    return { action: 'allow', reason: 'onboarding complete at trial end — normal conversion allowed', state };
  }
  if (state === 'TRIALING_ONBOARDING_INCOMPLETE') {
    return {
      action: 'pause',
      reason: 'onboarding incomplete at trial end — first charge withheld (pause_collection) until product-ready',
      state,
    };
  }
  // Any non-trialing state (already active/canceled/disputed/etc.) has no first-charge interlock.
  return { action: 'allow', reason: `no interlock applicable in state ${state}`, state };
}

// Stripe params for the pause (interlock) and the resume (after onboarding completes).
export const PAUSE_PARAMS = { pause_collection: { behavior: 'void' as const } };
export const RESUME_PARAMS = { pause_collection: '' as const };   // '' clears pause_collection in Stripe

// Resume decision: clear the interlock only when the sub is paused AND onboarding is now complete.
export function shouldResume(i: LifecycleInputs, supported: string[] = []): boolean {
  return !!i.paused && onboardingComplete(i, supported);
}
