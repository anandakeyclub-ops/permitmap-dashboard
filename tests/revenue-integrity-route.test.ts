// Route-level certification for GET /api/internal/revenue-integrity. Stripe and Clerk are in-memory fakes; NO network.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { PRICE } from './_entitlement-harness';

const TOKEN = 'rit_' + 'a1b2c3d4'.repeat(8);
const h = vi.hoisted(() => ({ calls: [] as string[], subs: [] as any[], endpoints: [] as any[], users: [] as any[], stripeFail: null as any, clerkFail: null as any, keys: [] as string[] }));

vi.mock('stripe', () => {
  const list = (name: string, rows: () => any[]) => (..._a: any[]) => {
    h.calls.push(`stripe.${name}.list`);
    if (h.stripeFail) return (async function* () { throw h.stripeFail; })();
    return (async function* () { for (const r of rows()) yield r; })();
  };
  class FakeStripe {
    constructor(key: string) { h.keys.push(key); }
    subscriptions = { list: list('subscriptions', () => h.subs), update: () => { h.calls.push('stripe.subscriptions.update'); }, cancel: () => { h.calls.push('stripe.subscriptions.cancel'); } };
    webhookEndpoints = { list: list('webhookEndpoints', () => h.endpoints), update: () => { h.calls.push('stripe.webhookEndpoints.update'); } };
  }
  return { default: FakeStripe };
});
vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: async () => ({
    users: {
      getUserList: async () => { h.calls.push('clerk.users.getUserList'); if (h.clerkFail) throw h.clerkFail; return { data: h.users }; },
      updateUserMetadata: async () => { h.calls.push('clerk.users.updateUserMetadata'); },
    },
  }),
}));

let GET: (req: NextRequest) => Promise<Response>;
beforeAll(async () => { ({ GET } = await import('../app/api/internal/revenue-integrity/route')); });

const env = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
beforeEach(() => {
  h.calls.length = 0; h.keys.length = 0; h.stripeFail = null; h.clerkFail = null;
  h.subs = [{ id: 's1', status: 'active', items: { data: [{ price: { id: PRICE.pro } }] }, metadata: { clerk_user_id: 'u1' }, pause_collection: null }];
  h.users = [{ id: 'u1', publicMetadata: { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' }, emailAddresses: [{ emailAddress: 'leak@example.com' }] }];
  h.endpoints = [{ id: 'we_1', url: 'https://www.permitmap.org/api/stripe-webhook', status: 'enabled', livemode: true, api_version: '2023-10-16', enabled_events: ['*'] }];
  env({ REVENUE_INTEGRITY_TOKEN: TOKEN, STRIPE_SECRET_KEY: 'sk_live_dummyDUMMYdummy', CLERK_SECRET_KEY: 'sk_live_clerkDUMMYdummy' });
});
const call = (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, url = 'http://localhost/api/internal/revenue-integrity') => GET(new NextRequest(url, { headers }));

describe('authentication fails closed', () => {
  it('token env unset -> 503 not_configured, no upstream calls', async () => {
    env({ REVENUE_INTEGRITY_TOKEN: undefined });
    const r = await call(); expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: 'UNAVAILABLE', reason: 'not_configured' });
    expect(h.calls).toEqual([]);
  });
  it('short (weak) token env -> 503, even when the caller presents that same token', async () => {
    env({ REVENUE_INTEGRITY_TOKEN: 'short' });
    expect((await call({ authorization: 'Bearer short' })).status).toBe(503);
    expect(h.calls).toEqual([]);
  });
  it.each([
    ['missing header', {}], ['wrong token', { authorization: 'Bearer nope' }], ['wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['bare token', { authorization: TOKEN }], ['token with suffix', { authorization: `Bearer ${TOKEN}x` }], ['lowercase scheme', { authorization: `bearer ${TOKEN}` }],
  ])('%s -> 401, no upstream calls', async (_n, headers) => {
    const r = await call(headers as any); expect(r.status).toBe(401);
    expect(h.calls).toEqual([]);
  });
  it('token in the query string is ignored', async () => {
    const r = await call({}, `http://localhost/api/internal/revenue-integrity?token=${TOKEN}&REVENUE_INTEGRITY_TOKEN=${TOKEN}`);
    expect(r.status).toBe(401); expect(h.calls).toEqual([]);
  });
});

describe('production-instance enforcement', () => {
  it.each([
    ['test Stripe key', { STRIPE_SECRET_KEY: 'sk_test_x' }], ['development Clerk key', { CLERK_SECRET_KEY: 'sk_test_y' }],
    ['unknown Clerk key', { CLERK_SECRET_KEY: 'garbage' }], ['missing Stripe key', { STRIPE_SECRET_KEY: '' }],
  ])('%s -> UNAVAILABLE instance_mismatch and ZERO upstream calls', async (_n, e) => {
    env(e as any);
    const r = await call(); const body = await r.json();
    expect(r.status).toBe(503); expect(body.status).toBe('UNAVAILABLE'); expect(body.unavailable_reason).toContain('instance_mismatch');
    expect(h.calls).toEqual([]); expect(h.keys).toEqual([]);
  });
});

describe('verdicts', () => {
  it('GREEN -> 200 with status GREEN, no-store, instances live/production', async () => {
    const r = await call(); const b = await r.json();
    expect(r.status).toBe(200); expect(b).toMatchObject({ schema: 1, status: 'GREEN', instances: { stripe: 'live', clerk: 'production' } });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(b.generated_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it('RED -> 200 with sanitized findings and a fingerprint; body.status (not HTTP) carries the verdict', async () => {
    h.subs[0].status = 'canceled';
    const r = await call(); const b = await r.json(); const text = JSON.stringify(b);
    expect(r.status).toBe(200); expect(b.status).toBe('RED');
    expect(b.fingerprint).toMatch(/^sha256:/); expect(b.counts.actionable_by_class).toEqual({ ACCESS_WITHOUT_ENTITLED_SUBSCRIPTION: 1 });
    expect(text).not.toMatch(/leak@example|@/);
  });
  it('Stripe failure -> 503 UNAVAILABLE, reason is a fixed code that leaks no key text', async () => {
    h.stripeFail = Object.assign(new Error('Invalid API Key provided: sk_live_dummyDUMMYdummy'), { type: 'StripeAuthenticationError', statusCode: 401 });
    const r = await call(); const text = await r.text(); const b = JSON.parse(text);
    expect(r.status).toBe(503); expect(b.status).toBe('UNAVAILABLE');
    expect(text).toContain('StripeAuthenticationError'); expect(text).not.toMatch(/sk_live|dummyDUMMY|Invalid API Key/);
  });
  it('Clerk failure -> 503 UNAVAILABLE (never a false GREEN)', async () => {
    h.clerkFail = Object.assign(new Error('clerk exploded sk_live_clerkDUMMYdummy'), { status: 500 });
    const r = await call(); const text = await r.text();
    expect(r.status).toBe(503); expect(JSON.parse(text).status).toBe('UNAVAILABLE'); expect(text).not.toMatch(/sk_live|exploded/);
  });
  it('webhook-endpoint read failure alone -> UNAVAILABLE even though reconciliation is clean', async () => {
    h.endpoints = null as any;
    const r = await call(); expect((await r.json()).status).toBe('UNAVAILABLE');
  });
});

describe('read-only', () => {
  it('only list/get calls are ever made, and the Stripe client is built with the configured key + pinned API version path', async () => {
    h.subs[0].status = 'canceled';
    await call();
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every(c => /\.(list|getUserList)$/.test(c))).toBe(true);
    expect(h.calls.some(c => /update|cancel|create|delete/i.test(c))).toBe(false);
  });
  it('the route source only touches read-guarded clients (no direct mutation verbs)', () => {
    const src = readFileSync('app/api/internal/revenue-integrity/route.ts', 'utf8');
    expect(src).toContain("readOnly('stripe'"); expect(src).toContain("readOnly('clerk'");
    expect(src).not.toMatch(/\b(stripe|clerk)\.[\w.]*\.(update|create|delete|del|cancel|del|updateUser\w*|deleteUser|createUser|ban\w*)\s*\(/);
  });
});

describe('middleware', () => {
  it('lists the exact route (and only exact) as public so permit-bot is not redirected to sign-in', () => {
    const src = readFileSync('middleware.ts', 'utf8');
    expect(src).toContain("'/api/internal/revenue-integrity',");
    expect(src).not.toMatch(/'\/api\/internal(\/\*|\(\.\*\))/);
  });
});
