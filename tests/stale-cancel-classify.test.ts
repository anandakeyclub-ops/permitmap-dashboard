import { describe, it, expect } from 'vitest';
import { classifyCancel, CancelEvidence } from '../scripts/forensics/stale-cancel-classify';

const NOW = 2_000_000_000; const DAY = 86400;
const ev = (over: Partial<CancelEvidence> = {}): CancelEvidence => ({
  sub: { id: 'sub_1', status: 'canceled', tier: 'pro', ended_at: NOW - 5 * DAY, canceled_at: NOW - 5 * DAY, metadata_clerk_user_id: 'user_a', cancellation_reason: 'cancellation_requested' },
  events: [], clerk: { id: 'user_a', tier: 'pro', billing: 'active', bound_sub: 'sub_1', sub_status: 'active', event_ids: [], updated_at: null, other_entitled_sub: false }, now: NOW, ...over,
});
const e = (id: string, type: string, created: number, pending = 0) => ({ id, type, created, pending_webhooks: pending, api_version: null, object_status: null });

describe('stale cancellation classifier', () => {
  it('missing Clerk user → debris, not an access problem', () => { expect(classifyCancel(ev({ clerk: null }))).toMatchObject({ cause: 'CLERK_USER_MISSING', stale_access: false }); });
  it('already revoked', () => { const f = classifyCancel(ev({ clerk: { ...ev().clerk!, tier: 'cancelled', billing: 'cancelled' } })); expect(f).toMatchObject({ cause: 'ALREADY_REVOKED', stale_access: false }); });
  it('bound to a different live sub → not stale for this one', () => {
    expect(classifyCancel(ev({ clerk: { ...ev().clerk!, bound_sub: 'sub_2' } }))).toMatchObject({ cause: 'NOT_BOUND_TO_THIS_SUB', stale_access: false });
  });
  it('identity mismatch is flagged and never auto-repaired', () => {
    const f = classifyCancel(ev({ sub: { ...ev().sub, metadata_clerk_user_id: 'user_other' } }));
    expect(f).toMatchObject({ cause: 'IDENTITY_MISMATCH', stale_access: true }); expect(f.safe_repair).toMatch(/Resolve identity first/);
  });
  it('deleted event with pending webhooks → undelivered', () => {
    expect(classifyCancel(ev({ events: [e('evt_d', 'customer.subscription.deleted', NOW - 5 * DAY, 1)] })).cause).toBe('DELETE_EVENT_UNDELIVERED');
  });
  it('an updated/invoice event AFTER deleted → late event overwrote revocation (the pre-#121 order bug)', () => {
    const f = classifyCancel(ev({ events: [e('evt_d', 'customer.subscription.deleted', NOW - 5 * DAY), e('evt_u', 'customer.subscription.updated', NOW - 5 * DAY + 30)] }));
    expect(f).toMatchObject({ cause: 'LATE_EVENT_OVERWROTE_REVOCATION', confidence: 'HIGH' }); expect(f.reasons[0]).toMatch(/evt_u/);
  });
  it('an updated event BEFORE deleted is normal ordering → falls through to processed-not-applied', () => {
    const f = classifyCancel(ev({ events: [e('evt_u', 'customer.subscription.updated', NOW - 6 * DAY), e('evt_d', 'customer.subscription.deleted', NOW - 5 * DAY)] }));
    expect(f.cause).toBe('DELETE_PROCESSED_NOT_APPLIED');
  });
  it('ended beyond the 30-day window with no events → undetermined, low confidence (never invents a cause)', () => {
    const f = classifyCancel(ev({ sub: { ...ev().sub, ended_at: NOW - 90 * DAY } }));
    expect(f).toMatchObject({ cause: 'EVENTS_EXPIRED_UNDETERMINED', confidence: 'LOW' });
  });
  it('ended recently but no deleted event found', () => { expect(classifyCancel(ev()).cause).toBe('NO_DELETE_EVENT_IN_WINDOW'); });
  it('every stale finding prescribes Stripe-truth replay, never a manual metadata edit', () => {
    for (const f of [classifyCancel(ev()), classifyCancel(ev({ sub: { ...ev().sub, ended_at: NOW - 90 * DAY } }))]) expect(f.safe_repair).toMatch(/never hand-edit/);
  });
});
