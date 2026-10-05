import { describe, it, expect } from 'vitest';
import { classifyOrphan, OrphanEvidence } from '../scripts/forensics/orphan-classify';

const ev = (over: Partial<OrphanEvidence> = {}): OrphanEvidence => ({
  sub: { id: 'sub_o', status: 'trialing', created: 1, trial_end: 99999, cancel_at_period_end: false, cancel_at: null, customer: 'cus_o', clerk_user_id: 'user_dev_x', tier: 'team' },
  customer: { id: 'cus_o', created: 1, email: 'Owner@x.com', clerk_user_id: 'user_dev_x' },
  sessions: [{ id: 'cs_1', created: 1, client_reference_id: 'user_dev_x', meta_clerk_user_id: 'user_dev_x', email: 'owner@x.com' }],
  prodUsers: [{ id: 'user_p1', created_at: 1, emails: ['a@x.com'], tier: 'pro', billing: 'active', bound_sub: 'sub_1', bound_customer: 'cus_1' }],
  otherCustomersSameEmail: [], otherSubsOnCustomer: [], ...over,
});

describe('orphan subscription classifier', () => {
  it('NO_PRODUCTION_ACCOUNT when carried ids and email match nothing (un-migrated dev user)', () => {
    const f = classifyOrphan(ev()); expect(f.classification).toBe('NO_PRODUCTION_ACCOUNT'); expect(f.candidate_prod_user_id).toBeNull();
    expect(f.next_steps.join(' ')).toMatch(/DEV instance/);
  });
  it('IDENTIFIED_PROD_USER_UNBOUND: checkout client_reference_id is an existing prod user lacking the binding (proof by id)', () => {
    const f = classifyOrphan(ev({ sessions: [{ id: 'cs_1', created: 1, client_reference_id: 'user_p2', meta_clerk_user_id: null, email: null }],
      prodUsers: [{ id: 'user_p2', created_at: 1, emails: ['o@x.com'], tier: null, billing: null, bound_sub: null, bound_customer: null }] }));
    expect(f).toMatchObject({ classification: 'IDENTIFIED_PROD_USER_UNBOUND', strength: 'PROVEN_BY_ID', candidate_prod_user_id: 'user_p2' });
  });
  it('IDENTIFIED_PROD_USER_BOUND_ELSEWHERE when that user is bound to another subscription', () => {
    const f = classifyOrphan(ev({ sub: { ...ev().sub, clerk_user_id: 'user_p1' } }));
    expect(f.classification).toBe('IDENTIFIED_PROD_USER_BOUND_ELSEWHERE'); expect(f.next_steps[0]).toMatch(/do NOT overwrite/i);
  });
  it('email-only single match is CORRELATED, never PROVEN', () => {
    const f = classifyOrphan(ev({ prodUsers: [{ id: 'user_p3', created_at: 1, emails: ['OWNER@x.com'], tier: null, billing: null, bound_sub: null, bound_customer: null }] }));
    expect(f).toMatchObject({ classification: 'EMAIL_ONLY_SINGLE_PROD_MATCH', strength: 'CORRELATED_BY_EMAIL' });
  });
  it('ambiguous email and disagreeing ids never name a candidate', () => {
    const two = ['user_a', 'user_b'].map(id => ({ id, created_at: 1, emails: ['owner@x.com'], tier: null, billing: null, bound_sub: null, bound_customer: null }));
    expect(classifyOrphan(ev({ prodUsers: two }))).toMatchObject({ classification: 'EMAIL_AMBIGUOUS', candidate_prod_user_id: null });
    const f = classifyOrphan(ev({ sub: { ...ev().sub, clerk_user_id: 'user_a' }, customer: { ...ev().customer, clerk_user_id: 'user_b' }, prodUsers: two }));
    expect(f).toMatchObject({ classification: 'EMAIL_AMBIGUOUS', candidate_prod_user_id: null });
  });
  it('records scheduled-cancel and duplicate-customer context', () => {
    const f = classifyOrphan(ev({ sub: { ...ev().sub, cancel_at_period_end: true }, otherCustomersSameEmail: ['cus_dup'], otherSubsOnCustomer: [{ id: 'sub_z', status: 'canceled' }] }));
    expect(f.notes.join('|')).toMatch(/scheduled to cancel/); expect(f.notes.join('|')).toMatch(/cus_dup/); expect(f.notes.join('|')).toMatch(/sub_z:canceled/);
  });
});
