// Route-level certification for app/api/stripe-webhook/route.ts (the real POST handler).
// Real: the Next route module, NextRequest, Stripe's real HMAC signature verification
// (webhooks.constructEvent / generateTestHeaderString), handleWebhook, provisioning logic.
// Faked (in-memory, NO network): Stripe resource reads and Clerk, via the entitlement harness.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { makeWorld, ev, PRICE, clerkEntitlement, truthEntitlement, core } from './_entitlement-harness';

const holder = vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_route_certification_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_route_certification';
  delete process.env.ANALYTICS_INGEST_KEY; // first-party emit becomes a no-op warning
  return { world: null as any };
});

vi.mock('stripe', async () => {
  const actual: any = await vi.importActual('stripe');
  const Real = actual.default;
  const realWebhooks = new Real('sk_test_route_certification_dummy').webhooks; // real signature crypto
  class FakeStripe {
    webhooks = realWebhooks;
    get subscriptions() { return holder.world.stripe.subscriptions; }
    get customers() { return holder.world.stripe.customers; }
  }
  return { default: FakeStripe };
});
vi.mock('@clerk/nextjs/server', () => ({ clerkClient: async () => holder.world.clerk }));
vi.mock('../lib/ga4-server', () => ({ sendGa4ServerEvent: async () => undefined }));

const SECRET = 'whsec_route_certification';
const U = 'user_1';
let POST: (req: NextRequest) => Promise<Response>;
let signer: any;

beforeAll(async () => {
  ({ POST } = await import('../app/api/stripe-webhook/route'));
  const actual: any = await vi.importActual('stripe');
  signer = new actual.default('sk_test_route_certification_dummy').webhooks;
});
beforeEach(() => { holder.world = makeWorld(); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const sign = (payload: string, opts: { secret?: string; timestamp?: number } = {}) =>
  signer.generateTestHeaderString({ payload, secret: opts.secret ?? SECRET, ...(opts.timestamp ? { timestamp: opts.timestamp } : {}) });

function request(body: string, sig: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sig !== null) headers['stripe-signature'] = sig;
  return new NextRequest('http://localhost/api/stripe-webhook', { method: 'POST', body, headers });
}
const eventBody = (type: string, sub: any, created: number) => JSON.stringify(ev(type, sub, created));
const w = () => holder.world as ReturnType<typeof makeWorld>;

describe('stripe-webhook route: signature handling and route → handler wiring', () => {
  it('valid signature: 200 {received:true}, Clerk entitlement matches Stripe truth', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    const res = await POST(request(body, sign(body)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(clerkEntitlement(w(), U)).toMatchObject({ tier: 'pro', billing: 'active' });
    expect(core(clerkEntitlement(w(), U))).toEqual(truthEntitlement(w(), U));
    expect(w().forbiddenStripeCalls).toEqual([]);
  });

  it('missing stripe-signature header: 400, zero Clerk writes', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    const res = await POST(request(body, null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expect(w().clerkWrites()).toBe(0);
  });

  it('garbage signature header: 400, zero writes', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    const res = await POST(request(body, 't=123,v1=deadbeef'));
    expect(res.status).toBe(400);
    expect(w().clerkWrites()).toBe(0);
  });

  it('signed with the WRONG secret: 400, zero writes', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    const res = await POST(request(body, sign(body, { secret: 'whsec_attacker' })));
    expect(res.status).toBe(400);
    expect(w().clerkWrites()).toBe(0);
    expect(clerkEntitlement(w(), U).tier).toBeUndefined();
  });

  it('body tampered after signing (tier upgrade attempt): 400, zero writes', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.starter });
    const signedBody = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    const tampered = signedBody.replace(PRICE.starter, PRICE.team);
    expect(tampered).not.toBe(signedBody);
    const res = await POST(request(tampered, sign(signedBody)));
    expect(res.status).toBe(400);
    expect(w().clerkWrites()).toBe(0);
  });

  it('replayed old signature (timestamp outside 300s tolerance): 400, zero writes', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await POST(request(body, sign(body, { timestamp: old })));
    expect(res.status).toBe(400);
    expect(w().clerkWrites()).toBe(0);
  });

  it('raw-body fidelity: pretty-printed JSON with unicode verifies (route signs over exact bytes, not re-serialised JSON)', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const e: any = ev('customer.subscription.created', w().sub('sub_A'), 10);
    e.data.object.metadata.note = 'Wellington, FL — José “quote” ☃';
    const body = JSON.stringify(e, null, 4) + '\n';
    const res = await POST(request(body, sign(body)));
    expect(res.status).toBe(200);
    expect(clerkEntitlement(w(), U)).toMatchObject({ tier: 'pro', billing: 'active' });
  });

  it('STRIPE_WEBHOOK_SECRET unset in the environment: fails closed (400), zero writes', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      w().setSub('sub_A', { status: 'active', price: PRICE.pro });
      const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
      const res = await POST(request(body, sign(body)));
      expect(res.status).toBe(400);
      expect(w().clerkWrites()).toBe(0);
    } finally { process.env.STRIPE_WEBHOOK_SECRET = saved; }
  });

  it('Stripe read failure after a valid signature: 500 (so Stripe retries), zero writes', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    w().failRetrieve = true;
    const res = await POST(request(body, sign(body)));
    expect(res.status).toBe(500);
    expect(w().clerkWrites()).toBe(0);
    // retry after Stripe recovers succeeds and converges
    w().failRetrieve = false;
    const retry = await POST(request(body, sign(body)));
    expect(retry.status).toBe(200);
    expect(clerkEntitlement(w(), U)).toMatchObject({ tier: 'pro', billing: 'active' });
  });

  it('unknown price through the route: never grants a tier', async () => {
    w().setSub('sub_A', { status: 'active', price: 'price_unknown_999' });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    const res = await POST(request(body, sign(body)));
    expect([200, 500]).toContain(res.status);
    expect(['pro', 'team', 'starter']).not.toContain(clerkEntitlement(w(), U).tier);
    expect(clerkEntitlement(w(), U).billing).not.toBe('active');
  });

  it('duplicate delivery ×3 through the route: all 200, state identical, no extra Clerk writes after the first', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const body = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    expect((await POST(request(body, sign(body)))).status).toBe(200);
    const afterFirst = JSON.stringify(w().users.get(U).publicMetadata);
    const writes = w().clerkWrites();
    expect((await POST(request(body, sign(body)))).status).toBe(200);
    expect((await POST(request(body, sign(body)))).status).toBe(200);
    expect(JSON.stringify(w().users.get(U).publicMetadata)).toBe(afterFirst);
    expect(w().clerkWrites()).toBe(writes);
  });

  it('out-of-order stale event through the route does not regress entitlement', async () => {
    w().setSub('sub_A', { status: 'active', price: PRICE.pro });
    const created = eventBody('customer.subscription.created', w().sub('sub_A'), 10);
    expect((await POST(request(created, sign(created)))).status).toBe(200);
    w().setSub('sub_A', { status: 'canceled' });
    const canceled = eventBody('customer.subscription.deleted', w().sub('sub_A'), 30);
    expect((await POST(request(canceled, sign(canceled)))).status).toBe(200);
    expect(clerkEntitlement(w(), U)).toMatchObject({ tier: 'cancelled', billing: 'cancelled' });
    const stale = eventBody('customer.subscription.updated', { ...w().sub('sub_A'), status: 'active' }, 20);
    expect((await POST(request(stale, sign(stale)))).status).toBe(200);
    expect(clerkEntitlement(w(), U)).toMatchObject({ tier: 'cancelled', billing: 'cancelled' });
    expect(core(clerkEntitlement(w(), U))).toEqual(truthEntitlement(w(), U));
  });
});
