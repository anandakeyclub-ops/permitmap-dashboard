// Pure helpers for the signup → Stripe checkout observability funnel.
//
// OBSERVABILITY ONLY. These decide WHICH funnel event corresponds to a real state
// transition — they never perform checkout, auth, or navigation, and never throw. Keeping
// the decision logic pure makes each "one event == one real transition" rule unit-testable
// in the repo's node test environment (React components/pages can't be rendered there).
//
// Events (persisted via lib/analytics.track → permitmap-api /analytics/event, first-party
// Supabase; the API attaches identity from the Clerk JWT — the client sends NO PII):
//   signup_page_view        — /sign-up genuinely rendered (pre-auth; anonymous-allowed by the API)
//   signup_completed        — Clerk auth transitioned signed-OUT → signed-IN on the signup surface
//   checkout_resume_started — authenticated user entered the real /checkout/resume boundary
//   stripe_checkout_created — backend confirmed a Stripe Checkout Session (API returned a url)
//   checkout_creation_failed— Stripe session creation failed before a url was returned

import type { FunnelEvent } from './analytics';

export const CHECKOUT_FUNNEL_EVENTS: readonly FunnelEvent[] = [
  'signup_page_view',
  'signup_completed',
  'checkout_resume_started',
  'stripe_checkout_created',
  'checkout_creation_failed',
] as const;

// Bounded, categorical, non-PII failure reasons (NEVER raw exception strings).
export type CheckoutFailReason =
  | 'unauthenticated'
  | 'stripe_create_failed'
  | 'server_error';

export type StartCheckoutAction = 'checkout' | 'signin' | 'active_subscription' | 'error';

export interface FunnelDecision {
  event: FunnelEvent;
  reason?: CheckoutFailReason;
}

/**
 * Map the result of lib/start-checkout.startCheckout() to the funnel event that reflects the
 * REAL outcome — or null when no funnel event should fire.
 *
 *   'checkout'            → stripe_checkout_created  (API returned a url = session created)
 *   'error'              → checkout_creation_failed (reason: stripe_create_failed)
 *   'signin'             → checkout_creation_failed (reason: unauthenticated — session lost mid-flow)
 *   'active_subscription' → null (a duplicate-sub redirect is a valid business outcome, NOT a
 *                                  creation failure — never emit success OR failure)
 *
 * stripe_checkout_created can ONLY be returned for 'checkout' — so it can never fire before the
 * backend has actually created the session. Success and failure are mutually exclusive.
 */
export function checkoutOutcomeEvent(action: StartCheckoutAction): FunnelDecision | null {
  switch (action) {
    case 'checkout':
      return { event: 'stripe_checkout_created' };
    case 'signin':
      return { event: 'checkout_creation_failed', reason: 'unauthenticated' };
    case 'active_subscription':
      return null;
    case 'error':
    default:
      return { event: 'checkout_creation_failed', reason: 'stripe_create_failed' };
  }
}

/**
 * signup_completed fires ONLY on a signed-OUT → signed-IN transition observed on the signup
 * surface — never merely because the page mounted while already authenticated (that visitor did
 * not just complete a signup here), and never on a click.
 */
export function shouldFireSignupCompleted(prevSignedIn: boolean, nowSignedIn: boolean): boolean {
  return prevSignedIn === false && nowSignedIn === true;
}
