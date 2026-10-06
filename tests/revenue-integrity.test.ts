import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { oracle } from './_revenue-integrity-oracle';
import { PRICE } from './_entitlement-harness';
import { reconcileEntitlements, webhookFindings, buildIntegrityReport, fingerprintOf, safeReason } from '../lib/revenue-integrity';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const sub = (id: string, uid: string | null, status = 'active', price = PRICE.pro, extra: any = {}) => ({
  id, status, items: { data: [{ price: { id: price } }] }, metadata: uid ? { clerk_user_id: uid } : {}, pause_collection: null, ...extra,
});
const user = (id: string, pm: any = {}) => ({ id, publicMetadata: pm, emailAddresses: [{ emailAddress: `${id}@secret.example` }], firstName: 'Secret', lastName: 'Name' });
const okEp = (o: any = {}) => ({ id: 'we_1', url: 'https://www.permitmap.org/api/stripe-webhook', status: 'enabled', livemode: true, api_version: '2023-10-16',
  enabled_events: ['checkout.session.completed', 'invoice.payment_failed', 'invoice.paid', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'], ...o });
const build = (subs: any[], users: any[], endpoints: any[] = [okEp()]) =>
  buildIntegrityReport({ now: NOW, instances: { stripe: 'live', clerk: 'production' }, reconciliation: { ok: true, subs, users }, webhook: { ok: true, endpoints } });

describe('classifier parity with the original verifier (frozen oracle)', () => {
  const fixtures: [string, any[], any[], any[]][] = [
    ['healthy', [sub('s1', 'u1')], [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' })], [okEp()]],
    ['stale access', [sub('s1', 'u1', 'canceled')], [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' })], [okEp({ status: 'disabled' })]],
    ['paying without access', [sub('s1', 'u1')], [user('u1', {})], []],
    ['tier mismatch', [sub('s1', 'u1', 'active', PRICE.team)], [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' })], [okEp({ livemode: false, api_version: '2020-01-01' }), okEp({ id: 'we_2' })]],
    ['billing mismatch', [sub('s1', 'u1', 'past_due')], [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' })], [okEp({ enabled_events: ['*'] })]],
    ['conflicting binding', [sub('s1', 'u1', 'canceled'), sub('s2', 'u1')], [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' })], [okEp({ enabled_events: ['checkout.session.completed'] })]],
    ['missing clerk user', [sub('s1', 'ghost')], [], [{ id: 'we_x', url: 'https://other.example/hook', status: 'enabled', livemode: true }]],
    ['manual legacy', [], [user('u1', { tier: 'starter' })], [okEp()]],
    ['unmapped + unknown price', [sub('s1', null), sub('s2', 'u1', 'active', 'price_unknown'), sub('s3', null, 'canceled')], [user('u1', {})], [okEp()]],
  ];
  for (const [name, subs, users, eps] of fixtures) {
    it(`identical output: ${name}`, () => {
      const o = oracle(eps, JSON.parse(JSON.stringify(subs)), JSON.parse(JSON.stringify(users)));
      expect(webhookFindings(eps)).toEqual(o.A_webhooks.findings);
      expect(reconcileEntitlements(JSON.parse(JSON.stringify(subs)), JSON.parse(JSON.stringify(users)))).toEqual(o.B_reconcile);
    });
  }
  it('identical output over 400 seeded random worlds', () => {
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    for (let n = 0; n < 400; n++) {
      const uids = ['u1', 'u2', 'u3', 'u4'];
      const subs = Array.from({ length: Math.floor(rnd() * 7) }, (_, i) => sub(`s${i}`, pick([...uids, 'ghost', null]), pick(['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete']), pick([PRICE.starter, PRICE.pro, PRICE.team, 'price_x']), { pause_collection: rnd() < 0.15 ? { behavior: 'void' } : null }));
      const users = uids.filter(() => rnd() < 0.8).map(id => user(id, rnd() < 0.2 ? {} : { tier: pick(['starter', 'pro', 'team', 'free']), billing_status: pick(['active', 'past_due', 'canceled']), ...(rnd() < 0.7 ? { stripe_subscription_id: pick(['s0', 's1', 's2', 's9']) } : {}) }));
      const o = oracle([], JSON.parse(JSON.stringify(subs)), JSON.parse(JSON.stringify(users)));
      expect(reconcileEntitlements(JSON.parse(JSON.stringify(subs)), JSON.parse(JSON.stringify(users)))).toEqual(o.B_reconcile);
    }
  });
  it('the manual verifier no longer defines its own classification', () => {
    const src = readFileSync('scripts/prod-entitlement-reconcile.ts', 'utf8');
    expect(src).toContain("from '../lib/revenue-integrity'");
    expect(src).not.toMatch(/BILLING_STATUS_MISMATCH|const expectedFor|REQUIRED_EVENTS/);
  });
});

describe('status semantics', () => {
  const good = [sub('s1', 'u1')], goodUsers = [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' })];
  it('GREEN: complete and clean', () => {
    const r = build(good, goodUsers);
    expect(r).toMatchObject({ status: 'GREEN', degraded_checks: [], unavailable_reason: null });
    expect(r.counts.actionable_total).toBe(0);
    expect(r.generated_at).toBe(NOW.toISOString());
  });
  it('RED: stale access', () => {
    const r = build([sub('s1', 'u1', 'canceled')], goodUsers);
    expect(r.status).toBe('RED');
    expect(r.counts.actionable_by_class).toEqual({ ACCESS_WITHOUT_ENTITLED_SUBSCRIPTION: 1 });
    expect(r.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('RED: paying customer without access, tier/billing mismatch, conflicting binding, unknown price, live orphan, webhook CRITICAL', () => {
    expect(build(good, [user('u1', {})]).counts.actionable_by_class).toEqual({ PAYING_CUSTOMER_WITHOUT_ACCESS: 1 });
    expect(build([sub('s1', 'u1', 'active', PRICE.team)], goodUsers).counts.actionable_by_class).toEqual({ TIER_MISMATCH: 1 });
    expect(build([sub('s1', 'u1', 'past_due')], goodUsers).counts.actionable_by_class).toEqual({ BILLING_STATUS_MISMATCH: 1 });
    expect(build([sub('s1', 'u1', 'canceled'), sub('s2', 'u1')], goodUsers).counts.actionable_by_class).toEqual({ BOUND_SUB_NOT_ENTITLED_BUT_ANOTHER_IS: 1 });
    expect(build([sub('s9', 'u9', 'active', 'price_unknown')], [user('u9', {})]).counts.actionable_by_class.UNKNOWN_PRICE).toBe(1);
    expect(build([...good, sub('o1', null, 'active')], goodUsers).counts.actionable_by_class).toEqual({ UNMAPPED_LIVE_SUBSCRIPTION: 1 });
    expect(build(good, goodUsers, [okEp({ status: 'disabled' })]).counts.actionable_by_class).toEqual({ WEBHOOK_REGISTRATION_CRITICAL: 1 });
    expect(build(good, goodUsers, []).status).toBe('RED');
  });
  it('informational findings never turn it RED (manual/legacy Starter, ended orphan, deleted-user debris, webhook WARN)', () => {
    const r = build([...good, sub('o1', null, 'canceled'), sub('d1', 'ghost', 'canceled')], [...goodUsers, user('legacy', { tier: 'starter' })], [okEp({ api_version: '2020-01-01' })]);
    expect(r.status).toBe('GREEN');
    expect(r.counts.informational_by_class).toMatchObject({ 'PAID_TIER_NO_STRIPE_BINDING (comp/manual/legacy?)': 1, UNMAPPED_ENDED_SUBSCRIPTION: 1, STRIPE_MAPS_TO_MISSING_CLERK_USER: 1, WEBHOOK_REGISTRATION_WARN: 1 });
  });
  it('duplicates: history-only subscriptions are GREEN; two simultaneously entitled subscriptions are RED', () => {
    const hist = build([sub('s0', 'u1', 'canceled'), sub('s1', 'u1'), sub('s_old', 'u1', 'incomplete_expired')], goodUsers);
    expect(hist.status).toBe('GREEN');
    const dup = build([sub('s1', 'u1'), sub('s2', 'u1', 'active', PRICE.starter)], goodUsers);
    expect(dup.status).toBe('RED');
    expect(dup.counts.actionable_by_class.FOREIGN_ACTIVE_DUPLICATE).toBe(1);
  });
  it('UNAVAILABLE: no check can establish truth; never GREEN, never a billing finding', () => {
    const r = buildIntegrityReport({ now: NOW, instances: null, reconciliation: { ok: false, reason: 'instance_mismatch' }, webhook: { ok: false, reason: 'instance_mismatch' } });
    expect(r.status).toBe('UNAVAILABLE');
    expect(r.fingerprint).toBeNull();
    expect(r.findings).toEqual([]);
    expect(r.degraded_checks).toEqual(['reconciliation', 'webhook_registration']);
    expect(r.unavailable_reason).toContain('instance_mismatch');
  });
  it('UNAVAILABLE: reconciliation failed even though the webhook check passed (no false GREEN)', () => {
    const r = buildIntegrityReport({ now: NOW, instances: { stripe: 'live', clerk: 'production' }, reconciliation: { ok: false, reason: 'x' }, webhook: { ok: true, endpoints: [okEp()] } });
    expect(r.status).toBe('UNAVAILABLE');
    expect(r.counts.stripe_subscriptions).toBeNull(); // missing telemetry is null, never 0
  });
  it('UNAVAILABLE: webhook check failed while reconciliation is clean', () => {
    const r = buildIntegrityReport({ now: NOW, instances: { stripe: 'live', clerk: 'production' }, reconciliation: { ok: true, subs: good, users: goodUsers }, webhook: { ok: false, reason: 'stripe_webhook_endpoints:403' } });
    expect(r.status).toBe('UNAVAILABLE');
    expect(r.degraded_checks).toEqual(['webhook_registration']);
  });
  it('RED outranks a degraded secondary check (a proven defect is still reported)', () => {
    const r = buildIntegrityReport({ now: NOW, instances: { stripe: 'live', clerk: 'production' }, reconciliation: { ok: true, subs: [sub('s1', 'u1', 'canceled')], users: goodUsers }, webhook: { ok: false, reason: 'x' } });
    expect(r.status).toBe('RED');
    expect(r.degraded_checks).toEqual(['webhook_registration']);
  });
});

describe('fingerprint', () => {
  const users = [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' }), user('u2', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's2' })];
  const subs = [sub('s1', 'u1', 'canceled'), sub('s2', 'u2', 'canceled')];
  it('is deterministic: independent of input order, generated_at and informational noise', () => {
    const a = build(subs, users);
    const b = buildIntegrityReport({ now: new Date('2030-01-01T00:00:00Z'), instances: { stripe: 'live', clerk: 'production' }, reconciliation: { ok: true, subs: [...subs].reverse(), users: [...users].reverse() }, webhook: { ok: true, endpoints: [okEp({ api_version: '2020-01-01' })] } });
    expect(a.status).toBe('RED');
    expect(b.fingerprint).toBe(a.fingerprint);
  });
  it('changes when the set of findings changes, and equals the same value for GREEN runs', () => {
    expect(build([subs[0]], [users[0]]).fingerprint).not.toBe(build(subs, users).fingerprint);
    expect(build([sub('s1', 'u1')], [users[0]]).fingerprint).toBe(build([sub('s9', 'u9')], [user('u9', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's9' })]).fingerprint);
    expect(fingerprintOf([])).toMatch(/^sha256:/);
    const f = build(subs, users).findings;
    expect(f.length).toBe(2);
    expect(fingerprintOf([...f].reverse())).toBe(fingerprintOf(f));
  });
});

describe('masking', () => {
  it('serialized report contains no emails or names, only ids/tiers/statuses', () => {
    const r = build([sub('s1', 'u1', 'canceled')], [user('u1', { tier: 'pro', billing_status: 'active', stripe_subscription_id: 's1' })]);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/secret\.example|Secret|Name|@/);
    expect(text).toContain('u1');
  });
  it('safeReason emits fixed codes and never echoes SDK message text', () => {
    const e: any = Object.assign(new Error('Invalid API Key provided: sk_live_abc123SECRET'), { type: 'StripeAuthenticationError', statusCode: 401 });
    const reason = safeReason('x', e);
    expect(reason).toBe('x:StripeAuthenticationError:401');
    expect(reason).not.toMatch(/sk_live|SECRET/);
    expect(safeReason('x', new Error('boom sk_live_zzz'))).toBe('x:unexpected_error');
  });
});
