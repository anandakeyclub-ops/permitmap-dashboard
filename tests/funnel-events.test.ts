import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { track } from '../lib/analytics';
import {
  checkoutOutcomeEvent, shouldFireSignupCompleted, CHECKOUT_FUNNEL_EVENTS,
} from '../lib/funnel-events';

const flush = () => new Promise((r) => setTimeout(r, 0));
let realFetch: typeof globalThis.fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

// ── D/E/F/G: stripe_checkout_created ⇔ real success; failure is exclusive ──────────
describe('checkoutOutcomeEvent — one event per real outcome', () => {
  it('D: stripe_checkout_created fires ONLY for a confirmed session (action=checkout), no reason', () => {
    expect(checkoutOutcomeEvent('checkout')).toEqual({ event: 'stripe_checkout_created' });
  });
  it('E: checkout_creation_failed fires on error, with a bounded categorical reason', () => {
    expect(checkoutOutcomeEvent('error')).toEqual({
      event: 'checkout_creation_failed', reason: 'stripe_create_failed',
    });
    expect(checkoutOutcomeEvent('signin')).toEqual({
      event: 'checkout_creation_failed', reason: 'unauthenticated',
    });
  });
  it('F/G: created is never emitted on failure and failed is never emitted on success', () => {
    const outcomes = (['checkout', 'error', 'signin', 'active_subscription'] as const).map(checkoutOutcomeEvent);
    const created = outcomes.filter((o) => o?.event === 'stripe_checkout_created');
    const failed = outcomes.filter((o) => o?.event === 'checkout_creation_failed');
    expect(created).toHaveLength(1);                       // only 'checkout'
    expect(failed.every((o) => o!.event !== 'stripe_checkout_created')).toBe(true);
    // active_subscription (duplicate-sub redirect) emits NEITHER success nor failure.
    expect(checkoutOutcomeEvent('active_subscription')).toBeNull();
  });
});

// ── B: signup_completed only on signed-OUT → signed-IN ─────────────────────────────
describe('shouldFireSignupCompleted — real auth transition only', () => {
  it('fires exactly on false → true, never otherwise', () => {
    expect(shouldFireSignupCompleted(false, true)).toBe(true);
    expect(shouldFireSignupCompleted(true, true)).toBe(false);   // already authed on mount → not a signup
    expect(shouldFireSignupCompleted(false, false)).toBe(false);
    expect(shouldFireSignupCompleted(true, false)).toBe(false);
  });
  it('N: across a render sequence, a once-guard yields a single completion', () => {
    let fired = 0; let done = false; let prev = false;
    for (const now of [false, false, true, true, true]) {   // simulates re-renders incl. StrictMode
      if (!done && shouldFireSignupCompleted(prev, now)) { fired++; done = true; }
      prev = now;
    }
    expect(fired).toBe(1);
  });
});

// ── I/J/K/L: no PII to analytics; utm survives; existing events preserved ──────────
describe('track() with the new funnel events', () => {
  const PII = ['email', 'name', 'company', 'phone', 'user_id', 'userId',
    'stripe_customer_id', 'stripe_subscription_id', 'stripe_session_id', 'token'];

  it('I/J: sends only safe funnel context; no PII; utm_content (client_reference_id) preserved', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as any);
    globalThis.fetch = fetchMock as any;
    track(async () => 'tkn', 'stripe_checkout_created', {
      plan: 'pro', source: 'checkout_resume',
      client_reference_id: 'ctr_2bce01c6c872_signup_travis_',   // utm_content attribution token
      properties: { reason: undefined },
    });
    await flush();
    const init = (fetchMock.mock.calls[0] as unknown as [string, any])[1];
    const body = JSON.parse(init.body);
    for (const k of PII) expect(body[k]).toBeUndefined();
    expect(body.client_reference_id).toBe('ctr_2bce01c6c872_signup_travis_');  // unchanged
    expect(body.event_name).toBe('stripe_checkout_created');
  });

  it('H: never throws even if fetch rejects (analytics cannot block checkout)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); }) as any;
    expect(() => track(async () => 'tkn', 'checkout_resume_started', { plan: 'team' })).not.toThrow();
    await flush();
  });

  it('K/L: the new events are separate from the preserved historical events', () => {
    expect(CHECKOUT_FUNNEL_EVENTS).toEqual([
      'signup_page_view', 'signup_completed', 'checkout_resume_started',
      'stripe_checkout_created', 'checkout_creation_failed',
    ]);
    expect(CHECKOUT_FUNNEL_EVENTS).not.toContain('stripe_checkout_started');   // preserved separately
    expect(CHECKOUT_FUNNEL_EVENTS).not.toContain('checkout_resume_failed');    // preserved separately
  });
});
