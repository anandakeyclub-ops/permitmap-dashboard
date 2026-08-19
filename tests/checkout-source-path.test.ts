// source_path conversion-attribution transport (dashboard-only). Proves the optional source_path
// field is accepted, sanitized, survives sign-up→resume→/api/checkout, and is stamped onto BOTH the
// Checkout Session and subscription_data metadata — without touching plan/trial/identity/existing UTMs.
import { describe, it, expect } from 'vitest';
import {
  readIntent, serializeIntent, buildResumeUrl, RESUME_PATH,
  sanitizeSourcePath, MAX_SOURCE_PATH,
} from '../lib/checkout-intent';
import { buildCheckoutParams } from '../lib/checkout-session';
import { startCheckout } from '../lib/start-checkout';

const APP = 'https://app.permitmap.org';
const LANDING_QS =
  'plan=team&county=palm-beach&trade=roofing&state=fl&source=pricing&campaign=spring' +
  '&utm_source=google&utm_medium=cpc&utm_campaign=fl-roofers&utm_content=ad1&utm_term=roof' +
  '&ref=partner7&gclid=GCLID123&fbclid=FBCLID456';

// ── A. allowlist & parsing ─────────────────────────────────────────────────────
describe('source_path: allowlist & parsing', () => {
  it('accepts a valid source_path in the intent', () => {
    const { params } = readIntent(new URLSearchParams('plan=team&source_path=/texas/harris-county'));
    expect(params.source_path).toBe('/texas/harris-county');
  });
  it('missing source_path is allowed (optional; never blocks)', () => {
    const { plan, params } = readIntent(new URLSearchParams('plan=team&county=lee'));
    expect(plan).toBe('team');
    expect(params.source_path).toBeUndefined();
  });
  it('survives serialize → readIntent round-trip; existing fields unchanged', () => {
    const parsed = readIntent(new URLSearchParams(LANDING_QS + '&source_path=/reports/florida-construction-trends'));
    const round = readIntent(new URLSearchParams(serializeIntent(parsed.plan!, parsed.params)));
    expect(round.params.source_path).toBe('/reports/florida-construction-trends');
    expect(round.params).toEqual(parsed.params);   // full allowlist round-trips identically
  });
});

// ── B. sanitization ─────────────────────────────────────────────────────────────
describe('source_path: sanitization', () => {
  it('strips query string', () => {
    expect(sanitizeSourcePath('/texas/harris-county?utm_source=google')).toBe('/texas/harris-county');
  });
  it('strips fragment', () => {
    expect(sanitizeSourcePath('/pricing#team')).toBe('/pricing');
  });
  it('collapses duplicate + trailing slashes (root preserved)', () => {
    expect(sanitizeSourcePath('/florida//marion-county/')).toBe('/florida/marion-county');
    expect(sanitizeSourcePath('/')).toBe('/');
  });
  it('rejects external / protocol-relative URLs', () => {
    expect(sanitizeSourcePath('https://evil.example/foo')).toBeNull();
    expect(sanitizeSourcePath('//evil.example')).toBeNull();
  });
  it('rejects javascript:/data: scheme inputs', () => {
    expect(sanitizeSourcePath('javascript:alert(1)')).toBeNull();
    expect(sanitizeSourcePath('data:text/html,x')).toBeNull();
  });
  it('rejects blank / whitespace / backslash / control chars', () => {
    expect(sanitizeSourcePath('')).toBeNull();
    expect(sanitizeSourcePath('   ')).toBeNull();
    expect(sanitizeSourcePath('/a b')).toBeNull();            // whitespace
    expect(sanitizeSourcePath('/a\\b')).toBeNull();           // backslash
    expect(sanitizeSourcePath('/a\u0001b')).toBeNull();           // control char
  });
  it('rejects non-string / oversized values (bounded)', () => {
    expect(sanitizeSourcePath(undefined)).toBeNull();
    expect(sanitizeSourcePath(123 as unknown)).toBeNull();
    expect(sanitizeSourcePath('/' + 'a'.repeat(MAX_SOURCE_PATH + 5))).toBeNull();
  });
  it('readIntent drops an invalid source_path but keeps valid neighbors', () => {
    const { plan, params } = readIntent(new URLSearchParams('plan=team&county=lee&source_path=https://evil.example'));
    expect(plan).toBe('team');
    expect(params.source_path).toBeUndefined();
    expect(params.county).toBe('lee');
  });
});

// ── C. resume preservation (signup/login → resume → payload) ──────────────────────
describe('source_path: resume preservation', () => {
  it('carries source_path through sign-up redirect → resume → checkout payload', async () => {
    // landing CTA (query encoded on source_path is stripped by the sanitizer)
    const landing = new URLSearchParams('plan=team&county=palm-beach&source_path=/texas/harris-county%3Futm_source%3Dg');
    // sign-up page: readIntent → buildResumeUrl (first-party relative, serialized)
    const signup = readIntent(landing);
    const resumeUrl = buildResumeUrl(signup.plan!, signup.params);
    expect(resumeUrl.startsWith(`${RESUME_PATH}?plan=team`)).toBe(true);
    // resume page: re-parse + readIntent
    const resumed = readIntent(new URLSearchParams(resumeUrl.split('?')[1]));
    expect(resumed.params.source_path).toBe('/texas/harris-county');
    // startCheckout forwards attribution to POST /api/checkout
    let posted: any = null;
    const fetchFn = (async (_u: string, opts: any) => {
      posted = JSON.parse(opts.body);
      return { status: 200, json: async () => ({ url: 'https://checkout.stripe/x' }) };
    }) as any;
    await startCheckout(resumed.plan!, { fetchFn, navigate: () => {}, currentPath: '/checkout/resume', attribution: resumed.params });
    expect(posted.attribution.source_path).toBe('/texas/harris-county');
  });
});

// ── D. Stripe metadata propagation (session + subscription) ───────────────────────
describe('source_path: Stripe metadata propagation', () => {
  it('stamps sanitized source_path on BOTH session and subscription_data metadata', () => {
    const attribution = readIntent(new URLSearchParams('plan=team&county=lee&source_path=/texas/harris-county%3Fx%3D1')).params;
    const p = buildCheckoutParams({ userId: 'user_1', email: 'jane@x.com', plan: 'team', appUrl: APP, attribution });
    expect(p.metadata.source_path).toBe('/texas/harris-county');
    expect(p.subscription_data.metadata.source_path).toBe('/texas/harris-county');
    // existing invariants intact
    expect(p.metadata.clerk_user_id).toBe('user_1');
    expect(p.metadata.plan).toBe('team');
    expect(p.metadata.county).toBe('lee');
    expect(p.subscription_data.trial_period_days).toBe(14);
    expect(p.client_reference_id).toBe('user_1');
  });
  it('omits source_path from metadata when absent or invalid (fail-closed)', () => {
    const none = buildCheckoutParams({ userId: 'u', email: 'a@x.com', plan: 'pro', appUrl: APP,
      attribution: readIntent(new URLSearchParams('plan=pro&county=lee')).params });
    expect(none.metadata.source_path).toBeUndefined();
    const bad = buildCheckoutParams({ userId: 'u', email: 'a@x.com', plan: 'pro', appUrl: APP,
      attribution: { source_path: 'https://evil.example/x' } as any });   // defense in depth
    expect(bad.metadata.source_path).toBeUndefined();
    expect(bad.metadata.clerk_user_id).toBe('u');
  });
});

// ── E. regression + security ──────────────────────────────────────────────────────
describe('source_path: regression + security', () => {
  it('does NOT introduce asset_id / content_id / PII into metadata', () => {
    const attribution = readIntent(new URLSearchParams(LANDING_QS + '&source_path=/texas/harris-county')).params;
    const p = buildCheckoutParams({ userId: 'u', email: 'jane@x.com', plan: 'team', appUrl: APP, attribution });
    for (const k of ['asset_id', 'content_id', 'email', 'name', 'token', 'authorization']) {
      expect(p.metadata[k]).toBeUndefined();
    }
    // existing attribution + UTMs still flow to both metadatas
    expect(p.metadata.utm_source).toBe('google');
    expect(p.subscription_data.metadata.utm_campaign).toBe('fl-roofers');
  });
  it('a client-supplied asset_id in the query is NOT forwarded (allowlist)', () => {
    const { params } = readIntent(new URLSearchParams('plan=team&asset_id=county:FORGED&content_id=x&source_path=/x/y'));
    expect((params as any).asset_id).toBeUndefined();
    expect((params as any).content_id).toBeUndefined();
    expect(params.source_path).toBe('/x/y');
  });
});
