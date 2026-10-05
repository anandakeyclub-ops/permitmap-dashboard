import { describe, it, expect } from 'vitest';
import { buildRelinkPlan, StripeSubIn, StripeCustomerIn, ClerkUserIn } from '../scripts/migrations/relink-manifest';
import { runStripeRelink } from '../scripts/migrations/stripe-relink';
import { validateForApply } from '../scripts/migrations/manifest';

const sub = (id: string, customer: string, old: string | null, status = 'active'): StripeSubIn => ({ id, status, customer, clerk_user_id: old, tier: 'pro' });
const cust = (id: string, old: string | null, email: string | null): StripeCustomerIn => ({ id, clerk_user_id: old, email });
const user = (id: string, subId: string | null, email: string | null, extra: Record<string, any> = {}): ClerkUserIn =>
  ({ id, email, publicMetadata: { ...(subId ? { stripe_subscription_id: subId } : {}), tier: 'pro', billing_status: 'active', ...extra } });

const base = () => ({
  subs: [sub('sub_1', 'cus_1', 'user_dev_1'), sub('sub_2', 'cus_2', 'user_dev_2')],
  customers: [cust('cus_1', 'user_dev_1', 'a@x.com'), cust('cus_2', 'user_dev_2', 'b@x.com')],
  clerkUsers: [user('user_prod_1', 'sub_1', 'A@x.com'), user('user_prod_2', 'sub_2', 'b@x.com'), user('user_free', null, 'f@x.com', { tier: undefined })],
});

describe('relink manifest planner', () => {
  it('proves old→new by immutable sub id; READY; emits rows only for proven mappings', () => {
    const p = buildRelinkPlan(base());
    expect(p.verdict).toBe('READY'); expect(p.counts).toEqual({ PROVEN: 2, ALREADY_LINKED: 0, CONFLICT: 0, REVIEW: 0 });
    expect(p.rows.map(r => [r.old_dev_user_id, r.new_prod_user_id, r.stripe_subscription_id])).toEqual([['user_dev_1', 'user_prod_1', 'sub_1'], ['user_dev_2', 'user_prod_2', 'sub_2']]);
    expect(p.rows.every(r => r.primary_email.startsWith('redacted:'))).toBe(true); // no PII in manifest
    expect(validateForApply(p.rows).ok).toBe(true);
  });
  it('feeds the repo relink machinery: dry-run plan has 2 writes per row, zero applied', async () => {
    const r = await runStripeRelink(buildRelinkPlan(base()).rows);
    expect(r.dryRun).toBe(true); expect(r.applied).toBe(0); expect(r.planned).toHaveLength(4);
    expect(r.planned.filter(m => m.target === 'subscription.metadata.clerk_user_id').map(m => m.new_value)).toEqual(['user_prod_1', 'user_prod_2']);
  });
  it('already-linked rows are not rewritten', () => {
    const b = base(); b.subs[0] = sub('sub_1', 'cus_1', 'user_prod_1'); b.customers[0] = cust('cus_1', 'user_prod_1', 'a@x.com');
    const p = buildRelinkPlan(b);
    expect(p.counts.ALREADY_LINKED).toBe(1); expect(p.rows.map(r => r.stripe_subscription_id)).toEqual(['sub_2']);
  });
  it('CONFLICT: Stripe points at a DIFFERENT live production user (never overwrite)', () => {
    const b = base(); b.subs[0] = sub('sub_1', 'cus_1', 'user_prod_2');
    const p = buildRelinkPlan(b);
    expect(p.decisions.find(d => d.stripe_subscription_id === 'sub_1')!.decision).toBe('CONFLICT');
    expect(p.verdict).toBe('BLOCKED'); expect(p.rows.map(r => r.stripe_subscription_id)).not.toContain('sub_1');
  });
  it('CONFLICT: two Clerk users claim the same subscription — neither is relinked', () => {
    const b = base(); b.clerkUsers.push(user('user_prod_dup', 'sub_1', 'a@x.com'));
    const p = buildRelinkPlan(b);
    expect(p.decisions.filter(d => d.stripe_subscription_id === 'sub_1').every(d => d.decision === 'CONFLICT')).toBe(true);
    expect(p.rows.map(r => r.stripe_subscription_id)).toEqual(['sub_2']);
  });
  it('CONFLICT: Clerk claims a subscription that does not exist in Stripe', () => {
    const b = base(); b.clerkUsers.push(user('user_prod_9', 'sub_ghost', 'z@x.com'));
    expect(buildRelinkPlan(b).decisions.find(d => d.stripe_subscription_id === 'sub_ghost')!.decision).toBe('CONFLICT');
  });
  it('CONFLICT: Clerk stripe_customer_id disagrees with the subscription customer', () => {
    const b = base(); b.clerkUsers[0] = user('user_prod_1', 'sub_1', 'a@x.com', { stripe_customer_id: 'cus_2' });
    expect(buildRelinkPlan(b).decisions[0].decision).toBe('CONFLICT');
  });
  it('CONFLICT: customer metadata matches neither old nor new id', () => {
    const b = base(); b.customers[0] = cust('cus_1', 'user_somebody_else', 'a@x.com');
    expect(buildRelinkPlan(b).decisions[0].decision).toBe('CONFLICT');
  });
  it('CONFLICT: two subs on one customer claimed by different production users', () => {
    const b = base(); b.subs.push(sub('sub_3', 'cus_1', 'user_dev_1')); b.clerkUsers.push(user('user_prod_3', 'sub_3', 'a@x.com'));
    const p = buildRelinkPlan(b);
    expect(p.decisions.filter(d => d.stripe_customer_id === 'cus_1').every(d => d.decision === 'CONFLICT')).toBe(true);
  });
  it('CONFLICT: one old id fans in to two production users', () => {
    const b = base(); b.subs[1] = sub('sub_2', 'cus_2', 'user_dev_1'); b.customers[1] = cust('cus_2', 'user_dev_1', 'b@x.com');
    const p = buildRelinkPlan(b);
    expect(p.counts.CONFLICT).toBe(2); expect(p.rows).toHaveLength(0);
  });
  it('REVIEW (not auto-proven) on email mismatch; only explicit acceptance lifts it, and never lifts a CONFLICT', () => {
    const b = base(); b.clerkUsers[0] = user('user_prod_1', 'sub_1', 'different@x.com');
    const p = buildRelinkPlan(b);
    expect(p.decisions[0].decision).toBe('REVIEW'); expect(p.verdict).toBe('BLOCKED'); expect(p.rows.map(r => r.stripe_subscription_id)).toEqual(['sub_2']);
    const acc = buildRelinkPlan({ ...b, acceptReview: ['sub_1'] });
    expect(acc.decisions[0]).toMatchObject({ decision: 'PROVEN', accepted_by_operator: true }); expect(acc.verdict).toBe('READY');
    b.subs[0] = sub('sub_1', 'cus_1', 'user_prod_2');
    expect(buildRelinkPlan({ ...b, acceptReview: ['sub_1'] }).decisions[0].decision).toBe('CONFLICT');
  });
  it('REVIEW when the Stripe subscription has no prior clerk_user_id; unavailable email is also REVIEW', () => {
    const b = base(); b.subs[0] = sub('sub_1', 'cus_1', null); b.customers[0] = cust('cus_1', null, 'a@x.com'); b.customers[1] = cust('cus_2', 'user_dev_2', null);
    const p = buildRelinkPlan(b);
    expect(p.decisions.map(d => d.decision)).toEqual(['REVIEW', 'REVIEW']);
  });
  it('BLOCKED when a live Stripe subscription is claimed by no Clerk user (paying customer would stay without access)', () => {
    const b = base(); b.subs.push(sub('sub_orphan', 'cus_9', 'user_dev_9')); b.customers.push(cust('cus_9', 'user_dev_9', 'o@x.com'));
    const p = buildRelinkPlan(b);
    expect(p.unclaimed_live_stripe_subs).toEqual(['sub_orphan']); expect(p.verdict).toBe('BLOCKED');
  });
  it('canceled unclaimed subscriptions do not block', () => {
    const b = base(); b.subs.push(sub('sub_old', 'cus_9', 'user_dev_9', 'canceled'));
    expect(buildRelinkPlan(b).verdict).toBe('READY');
  });
});
