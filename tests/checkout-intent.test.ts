import { describe, it, expect, vi } from 'vitest';
import {
  isPlan, readIntent, serializeIntent, buildResumeUrl, buildAuthUrl,
  pickMetadata, checkoutIdempotencyKey, INTENT_FIELDS, METADATA_FIELDS, RESUME_PATH,
} from '../lib/checkout-intent';
import { buildCheckoutParams, handleCheckout, PRICE_BY_PLAN } from '../lib/checkout-session';
import { startCheckout } from '../lib/start-checkout';

const APP = 'https://app.permitmap.org';

// A representative landing → sign-up query (what signupUrl on the marketing site emits).
const LANDING_QS =
  'plan=team&county=palm-beach&trade=roofing&state=fl&source=pricing&campaign=spring' +
  '&name=Jane%20Doe&email=jane%40x.com' +
  '&utm_source=google&utm_medium=cpc&utm_campaign=fl-roofers&utm_content=ad1&utm_term=roof' +
  '&ref=partner7&gclid=GCLID123&fbclid=FBCLID456';

function fakeStripeCheckout() {
  const create = vi.fn(async (params: any, options?: any) => ({ url: 'https://checkout.stripe.test/x', _params: params, _options: options }));
  return { create, stripe: { checkout: { sessions: { create } } } };
}

// ── Intent contract: plan validation ──────────────────────────────────────────
describe('checkout-intent: plan validation', () => {
  it('accepts only starter|pro|team', () => {
    expect(isPlan('starter')).toBe(true);
    expect(isPlan('pro')).toBe(true);
    expect(isPlan('team')).toBe(true);
  });
  it('rejects invalid / empty / non-string plans', () => {
    for (const v of ['enterprise', 'STARTER', '', 'free', 'preview', null, undefined, 1, {}]) {
      expect(isPlan(v as unknown)).toBe(false);
    }
  });
  it('readIntent returns null plan for an invalid plan (never forwarded)', () => {
    expect(readIntent({ plan: 'enterprise' }).plan).toBeNull();
    expect(readIntent(new URLSearchParams('plan=hacker')).plan).toBeNull();
  });
});

// ── Intent contract: allowlist + round-trip (attribution survives) ─────────────
describe('checkout-intent: allowlist & round-trip', () => {
  it('parses a real landing query: plan + all allowlisted fields, drops nothing allowlisted', () => {
    const { plan, params } = readIntent(new URLSearchParams(LANDING_QS));
    expect(plan).toBe('team');
    for (const f of INTENT_FIELDS) expect(params[f]).toBeTruthy();
    expect(params.county).toBe('palm-beach');
    expect(params.gclid).toBe('GCLID123');
  });

  it('drops non-allowlisted params (no arbitrary passthrough / no prototype pollution)', () => {
    const { params } = readIntent(new URLSearchParams('plan=pro&evil=1&redirect=http://x&__proto__=y'));
    // Only allowlisted keys may appear as OWN keys; junk keys are never carried.
    const ownKeys = Object.keys(params);
    for (const k of ownKeys) expect((INTENT_FIELDS as readonly string[]).includes(k)).toBe(true);
    expect(ownKeys).not.toContain('evil');
    expect(ownKeys).not.toContain('redirect');
    expect(ownKeys).not.toContain('__proto__');
    // prototype was not polluted
    expect(({} as any).y).toBeUndefined();
  });

  it('serialize → readIntent round-trips identically (survives the full path)', () => {
    const parsed = readIntent(new URLSearchParams(LANDING_QS));
    const round = readIntent(new URLSearchParams(serializeIntent(parsed.plan!, parsed.params)));
    expect(round.plan).toBe('team');
    expect(round.params).toEqual(parsed.params);
  });

  it('Next-style record source (string | string[]) is normalized', () => {
    const { plan, params } = readIntent({ plan: 'pro', county: ['broward', 'x'], trade: undefined });
    expect(plan).toBe('pro');
    expect(params.county).toBe('broward');
    expect(params.trade).toBeUndefined();
  });
});

// ── Intent contract: safe first-party redirect (no open redirect) ──────────────
describe('checkout-intent: safe redirect', () => {
  it('buildResumeUrl is always a relative first-party path', () => {
    const { plan, params } = readIntent(new URLSearchParams(LANDING_QS));
    const url = buildResumeUrl(plan!, params);
    expect(url.startsWith(`${RESUME_PATH}?`)).toBe(true);
    expect(url).not.toMatch(/^https?:\/\//);
    expect(url).not.toMatch(/^\/\//); // no protocol-relative host
  });
  it('cannot be coerced into an external host via params', () => {
    const url = buildResumeUrl('team', readIntent(new URLSearchParams('plan=team&source=//evil.com')).params);
    // source is allowlisted but only rides as a query VALUE, never as the path/host.
    expect(url.startsWith(`${RESUME_PATH}?`)).toBe(true);
    expect(new URL(url, APP).origin).toBe(APP);
  });
  it('buildAuthUrl preserves intent, or bare path when no plan', () => {
    expect(buildAuthUrl('/sign-in', null, {})).toBe('/sign-in');
    expect(buildAuthUrl('/sign-in', 'team', { county: 'lee' })).toBe('/sign-in?plan=team&county=lee');
  });
});

// ── Metadata: allowlisted, PII-free, Stripe-limit-safe ─────────────────────────
describe('checkout-intent: metadata pick', () => {
  it('includes attribution but EXCLUDES PII (name/email)', () => {
    const meta = pickMetadata(readIntent(new URLSearchParams(LANDING_QS)).params);
    expect(meta.county).toBe('palm-beach');
    expect(meta.gclid).toBe('GCLID123');
    expect(meta.fbclid).toBe('FBCLID456');
    expect((meta as any).name).toBeUndefined();
    expect((meta as any).email).toBeUndefined();
    expect(Object.keys(meta).length).toBeLessThanOrEqual(METADATA_FIELDS.length);
  });
  it('caps values to the Stripe 500-char limit', () => {
    const meta = pickMetadata({ campaign: 'x'.repeat(1000) });
    expect(meta.campaign.length).toBe(500);
  });
});

// ── Idempotency key: deterministic per intent ──────────────────────────────────
describe('checkout-intent: idempotency key', () => {
  it('is stable for the same user + plan + attribution (dedupes refresh/double-submit)', () => {
    const attr = readIntent(new URLSearchParams(LANDING_QS)).params;
    const a = checkoutIdempotencyKey('user_1', 'team', attr);
    const b = checkoutIdempotencyKey('user_1', 'team', { ...attr });
    expect(a).toBe(b);
  });
  it('differs by user, by plan, and by attribution', () => {
    const attr = readIntent(new URLSearchParams(LANDING_QS)).params;
    const base = checkoutIdempotencyKey('user_1', 'team', attr);
    expect(checkoutIdempotencyKey('user_2', 'team', attr)).not.toBe(base);
    expect(checkoutIdempotencyKey('user_1', 'pro', attr)).not.toBe(base);
    expect(checkoutIdempotencyKey('user_1', 'team', { ...attr, campaign: 'other' })).not.toBe(base);
  });
});

// ── Checkout params: attribution → Stripe metadata; invariants preserved ───────
describe('handleCheckout: attribution + invariants', () => {
  it('stamps allowlisted attribution on BOTH session and subscription metadata (+ clerk_user_id/plan)', () => {
    const attribution = readIntent(new URLSearchParams(LANDING_QS)).params;
    const p = buildCheckoutParams({ userId: 'user_1', email: 'jane@x.com', plan: 'team', appUrl: APP, attribution });
    // required minimum metadata
    for (const key of ['clerk_user_id', 'plan', 'county', 'trade', 'source', 'campaign', 'utm_source', 'utm_campaign', 'ref', 'gclid', 'fbclid']) {
      expect(p.metadata[key]).toBeTruthy();
      expect(p.subscription_data.metadata[key]).toBeTruthy();
    }
    expect(p.metadata.clerk_user_id).toBe('user_1');
    expect(p.metadata.plan).toBe('team');
    // client_reference_id stays the raw Clerk id
    expect(p.client_reference_id).toBe('user_1');
    // PII not in metadata
    expect(p.metadata.email).toBeUndefined();
    expect(p.metadata.name).toBeUndefined();
    // invariants unchanged
    expect(p.mode).toBe('subscription');
    expect(p.subscription_data.trial_period_days).toBe(14);
    expect(p.line_items[0].price).toBe(PRICE_BY_PLAN.team);
    expect((p as any).payment_intent_data).toBeUndefined(); // $0 due today (no immediate charge)
    expect(p.cancel_url).toContain('/pricing?checkout=cancelled');
    expect(p.success_url).toContain('/dashboard?checkout=success');
  });

  it('passes a deterministic idempotencyKey to sessions.create', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const attribution = readIntent(new URLSearchParams('plan=pro&source=pricing')).params;
    await handleCheckout({ userId: 'user_9', email: 'a@x.com', plan: 'pro', appUrl: APP, attribution, stripe });
    const opts = create.mock.calls[0][1];
    expect(opts.idempotencyKey).toBe(checkoutIdempotencyKey('user_9', 'pro', attribution));
  });

  it('duplicate execution of the same intent → identical idempotencyKey (Stripe reuses one Session)', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const attribution = readIntent(new URLSearchParams('plan=team&county=lee')).params;
    await handleCheckout({ userId: 'user_x', email: 'a@x.com', plan: 'team', appUrl: APP, attribution, stripe });
    await handleCheckout({ userId: 'user_x', email: 'a@x.com', plan: 'team', appUrl: APP, attribution, stripe });
    expect(create.mock.calls[0][1].idempotencyKey).toBe(create.mock.calls[1][1].idempotencyKey);
  });

  it('correct Price ID per plan (Starter/Pro/Team) with 14-day trial + $0 due today', () => {
    const CANON = { starter: PRICE_BY_PLAN.starter, pro: PRICE_BY_PLAN.pro, team: PRICE_BY_PLAN.team };
    for (const plan of ['starter', 'pro', 'team'] as const) {
      const p = buildCheckoutParams({ userId: 'u', email: 'a@x.com', plan, appUrl: APP });
      expect(p.line_items[0].price).toBe(CANON[plan]);
      expect(p.subscription_data.trial_period_days).toBe(14);
      expect((p as any).payment_intent_data).toBeUndefined();
    }
  });

  it('invalid plan → 400 and NO Stripe session created', async () => {
    const { create, stripe } = fakeStripeCheckout();
    const r = await handleCheckout({ userId: 'user_1', email: 'a@x.com', plan: 'enterprise', appUrl: APP, stripe });
    expect(r.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});

// ── startCheckout: forwards attribution to POST /api/checkout ───────────────────
describe('startCheckout: attribution forwarding', () => {
  it('POSTs plan + attribution to /api/checkout and navigates to the Stripe url', async () => {
    let posted: any = null; let navigatedTo = '';
    const attribution = { county: 'palm-beach', trade: 'roofing', utm_source: 'google' };
    const fetchFn = (async (_u: string, opts: any) => { posted = JSON.parse(opts.body); return { status: 200, json: async () => ({ url: 'https://checkout.stripe/x' }) }; }) as any;
    const r = await startCheckout('team', { fetchFn, navigate: (u) => { navigatedTo = u; }, currentPath: '/checkout/resume', attribution });
    expect(posted).toEqual({ plan: 'team', attribution });
    expect(r.action).toBe('checkout');
    expect(navigatedTo).toBe('https://checkout.stripe/x');
  });

  it('omits the attribution key entirely when there is none (in-app upgrade CTA)', async () => {
    let posted: any = null;
    const fetchFn = (async (_u: string, opts: any) => { posted = JSON.parse(opts.body); return { status: 200, json: async () => ({ url: 'u' }) }; }) as any;
    await startCheckout('starter', { fetchFn, navigate: () => {}, currentPath: '/pricing' });
    expect(posted).toEqual({ plan: 'starter' });
  });
});

// ── Generic signup (no plan): no checkout, dashboard destination ────────────────
describe('generic signup (no plan)', () => {
  // Mirrors the redirect decision the sign-up/sign-in pages make.
  const destination = (src: any) => {
    const { plan, params } = readIntent(src);
    return plan ? { force: buildResumeUrl(plan, params) } : { fallback: '/dashboard' };
  };

  it('no plan → falls back to /dashboard (Preview), never the resume/checkout path', () => {
    const d = destination(new URLSearchParams(''));
    expect(d).toEqual({ fallback: '/dashboard' });
  });

  it('invalid plan → also /dashboard (no Checkout Session)', () => {
    expect(destination(new URLSearchParams('plan=enterprise'))).toEqual({ fallback: '/dashboard' });
  });

  it('valid paid plan → forces the resume route', () => {
    const d = destination(new URLSearchParams('plan=team&source=pricing'));
    expect('force' in d && d.force.startsWith(`${RESUME_PATH}?plan=team`)).toBe(true);
  });
});
