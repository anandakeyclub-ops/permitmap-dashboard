import { describe, it, expect } from 'vitest';
import { runDryReconcile } from '../scripts/reconcile-dry-run-core';
import { makeWorld, PRICE } from './_entitlement-harness';

const asUsers = (w: any) => [...w.users.values()].map((u: any) => ({ id: u.id, publicMetadata: u.publicMetadata }));
const run = (w: any) => runDryReconcile({ stripe: w.stripe, stripeSubs: [...w.subs.values()], clerkUsers: asUsers(w), clerkGetUserList: (p: any) => w.clerk.users.getUserList(p) });

describe('dry-run Stripe-truth reconciliation (real code path, zero writes)', () => {
  it('stale paid access on a canceled sub: plans the revocation, converges to truth, writes NOTHING', async () => {
    const w = makeWorld(); w.setSub('sub_A', { status: 'canceled', price: PRICE.pro });
    w.users.get('user_1').publicMetadata = { tier: 'pro', billing_status: 'active', stripe_subscription_id: 'sub_A', stripe_customer_id: 'cus_1' };
    const r = await run(w); const row = r.rows[0];
    expect(row).toMatchObject({ changed: true, converges: true, expected: { tier: 'cancelled', billing: 'cancelled' } });
    expect(row.after).toMatchObject({ tier: 'cancelled', billing_status: 'cancelled' });
    expect(w.clerkWrites()).toBe(0); expect(w.users.get('user_1').publicMetadata.tier).toBe('pro'); // real Clerk untouched
    expect(w.stripeUpdates).toEqual([]);
  });
  it('already-correct users produce no change', async () => {
    const w = makeWorld(); w.setSub('sub_A', { status: 'active', price: PRICE.team });
    w.users.get('user_1').publicMetadata = { tier: 'team', billing_status: 'active', stripe_subscription_id: 'sub_A', stripe_customer_id: 'cus_1' };
    const r = await run(w); expect(r.rows[0]).toMatchObject({ changed: false, converges: true }); expect(r.summary.would_change).toBe(0);
  });
  it('Stripe sub pointing at a MISSING Clerk user is reported as an orphan (and never invents a user)', async () => {
    const w = makeWorld(); w.setSub('sub_X', { status: 'canceled', metadata: { clerk_user_id: 'user_gone' } });
    w.users.get('user_1').publicMetadata = {};
    const r = await run(w); expect(r.orphan_stripe_subs).toEqual([{ sub: 'sub_X', status: 'canceled', metadata_clerk_user_id: 'user_gone' }]); expect(w.users.has('user_gone')).toBe(false);
  });
  it('a bound user whose Stripe metadata points at a deleted Clerk user: replay WOULD ERROR (webhook would 500 and retry forever)', async () => {
    const w = makeWorld(); w.setSub('sub_B', { status: 'canceled', metadata: { clerk_user_id: 'user_gone' } });
    w.users.get('user_1').publicMetadata = { tier: 'pro', billing_status: 'active', stripe_subscription_id: 'sub_B' };
    const r = await run(w); const row = r.rows[0];
    // bound by Clerk binding → replay targets user_gone via sub metadata → 404 captured
    expect(row.would_error.join(' ')).toMatch(/404|Not Found/); expect(w.clerkWrites()).toBe(0);
  });
  it('comp/manual users (paid tier, no Stripe subscription at all) are listed and never touched', async () => {
    const w = makeWorld(); w.users.set('user_comp', { id: 'user_comp', email: 'c@x.com', publicMetadata: { tier: 'starter', billing_status: 'active' } });
    const r = await run(w); expect(r.manual_or_legacy).toContain('user_comp'); expect(r.rows.find(x => x.clerk_user_id === 'user_comp')).toBeUndefined();
  });
  it('duplicate valid subscription is promoted instead of revoking a paying customer', async () => {
    const w = makeWorld(); w.setSub('sub_old', { status: 'canceled', price: PRICE.pro }); w.setSub('sub_new', { status: 'active', price: PRICE.pro });
    w.users.get('user_1').publicMetadata = { tier: 'pro', billing_status: 'active', stripe_subscription_id: 'sub_old', stripe_customer_id: 'cus_1' };
    const r = await run(w); expect(r.rows[0].after).toMatchObject({ tier: 'pro', billing_status: 'active' }); expect(r.rows[0].converges).toBe(true);
  });
});
