import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { track } from '../lib/analytics';
import { checkoutOutcomeEvent, shouldFireSignupCompleted } from '../lib/funnel-events';

// Synthetic end-to-end of the funnel EVENT CONTRACT using the real primitives the components
// call (track + checkoutOutcomeEvent + shouldFireSignupCompleted) with a mocked transport.
// No real Stripe Checkout Session, no real Clerk user, no real GA4 — mocks/fakes only.

const flush = () => new Promise((r) => setTimeout(r, 0));
let realFetch: typeof globalThis.fetch;
let posted: string[];

beforeEach(() => {
  realFetch = globalThis.fetch;
  posted = [];
  globalThis.fetch = vi.fn(async (_url: string, init: any) => {
    posted.push(JSON.parse(init.body).event_name);
    return { ok: true } as any;
  }) as any;
});
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

const getToken = async () => 'tkn';

// Mirrors the SignupFunnelTracker + ResumeCheckout emission order for a given startCheckout action.
async function runFunnel(action: 'checkout' | 'error') {
  // 1. /sign-up reached (pre-auth; anonymous-allowed by the API)
  track(getToken, 'signup_page_view', { plan: 'pro', source: 'marketing' });
  // 2. Clerk auth transitions signed-out → signed-in on the signup surface
  if (shouldFireSignupCompleted(false, true)) track(getToken, 'signup_completed', { plan: 'pro' });
  // 3. authenticated user enters the real resume boundary
  track(getToken, 'checkout_resume_started', { plan: 'pro', source: 'checkout_resume' });
  // 4. backend outcome → exactly one of created / failed (mirrors resume page emitOutcome)
  const d = checkoutOutcomeEvent(action);
  if (d) track(getToken, d.event, { plan: 'pro', source: 'checkout_resume',
    properties: d.reason ? { reason: d.reason } : undefined });
  await flush();
}

describe('synthetic E2E — signup → Stripe checkout funnel', () => {
  it('SUCCESS: intent → signup_page_view → signup_completed → checkout_resume_started → stripe_checkout_created', async () => {
    await runFunnel('checkout');
    expect(posted).toEqual([
      'signup_page_view', 'signup_completed', 'checkout_resume_started', 'stripe_checkout_created',
    ]);
    expect(posted).not.toContain('checkout_creation_failed');   // success never emits failure
  });

  it('FAILURE: … → checkout_resume_started → checkout_creation_failed (no stripe_checkout_created)', async () => {
    await runFunnel('error');
    expect(posted).toEqual([
      'signup_page_view', 'signup_completed', 'checkout_resume_started', 'checkout_creation_failed',
    ]);
    expect(posted).not.toContain('stripe_checkout_created');    // failure never emits success
  });
});
