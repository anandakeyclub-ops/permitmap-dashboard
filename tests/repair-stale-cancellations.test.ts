import { describe, it, expect } from 'vitest';
import { runRepair, validateAllowlist } from '../scripts/repair-stale-cancellations-core';
import { makeWorld, PRICE } from './_entitlement-harness';

const IDS = ['sub_CANARY0001', 'sub_STALE00002', 'sub_STALE00003', 'sub_STALE00004', 'sub_STALE00005'];
const PAID_MD = (sub: string, tier = 'starter') => ({ tier, billing_status: 'active', stripe_subscription_id: sub, stripe_customer_id: `cus_${sub}`, county: 'palm-beach' });

function world(over: Record<string, any> = {}) {
  const w = makeWorld(); w.users.clear();
  IDS.forEach((sid, i) => {
    const uid = `user_${i + 1}`;
    w.setSub(sid, { status: 'canceled', price: PRICE.starter, customer: `cus_${sid}`, metadata: { clerk_user_id: uid } });
    w.users.set(uid, { id: uid, email: `u${i}@x.com`, publicMetadata: PAID_MD(sid) });
  });
  // by-customer list in the harness returns subs matching customer: fine.
  w.users.set('user_manual', { id: 'user_manual', email: 'm@x.com', publicMetadata: { tier: 'starter', billing_status: 'active' } });
  w.setSub('sub_ORPHAN0099', { status: 'canceled', customer: 'cus_orphan', metadata: { clerk_user_id: 'user_gone' } });
  Object.assign(w, over);
  return w;
}
// Adapter: harness Clerk lacks paged getUserList(all); everything else delegates. Tracks writes by user.
function clerkFor(w: any) {
  const writes: string[] = [];
  return { writes, clerk: { users: {
    getUserList: async (p: any) => p?.emailAddress ? w.clerk.users.getUserList(p) : [...w.users.values()].map((u: any) => ({ id: u.id, publicMetadata: JSON.parse(JSON.stringify(u.publicMetadata)) })),
    getUser: (id: string) => w.clerk.users.getUser(id),
    updateUserMetadata: async (id: string, p: any) => { writes.push(id); return w.clerk.users.updateUserMetadata(id, p); },
  } } };
}
const base = (w: any, c: any, o: any = {}) => ({ stripe: w.stripe, clerk: c.clerk, allowlist: IDS, canary: IDS[0], apply: false, ...o });
const md = (w: any, u: string) => w.users.get(u).publicMetadata;

describe('validateAllowlist', () => {
  it('rejects truncated ids, duplicates, wrong count, and a canary outside the list', () => {
    expect(() => validateAllowlist(['sub_1TN2nr...', ...IDS.slice(1)], IDS[1])).toThrow(/malformed/);
    expect(() => validateAllowlist([IDS[0], IDS[0], ...IDS.slice(2)], IDS[0])).toThrow(/duplicates/);
    expect(() => validateAllowlist(IDS.slice(0, 4), IDS[0])).toThrow(/exactly 5/);
    expect(() => validateAllowlist(IDS, 'sub_NOTINLIST01')).toThrow(/canary/);
  });
  it('puts the canary first', () => expect(validateAllowlist(IDS, IDS[3])[0]).toBe(IDS[3]));
});

describe('runRepair', () => {
  it('DRY RUN (default): plans all five, writes nothing anywhere', async () => {
    const w = world(); const c = clerkFor(w); const before = JSON.stringify([...w.users.values()]);
    const rc = await runRepair(base(w, c));
    expect(rc.status).toBe('DRY_RUN_COMPLETE'); expect(rc.results.every(r => r.outcome === 'PLANNED')).toBe(true);
    expect(c.writes).toEqual([]); expect(w.clerkWrites()).toBe(0); expect(JSON.stringify([...w.users.values()])).toBe(before); expect(w.stripeUpdates).toEqual([]);
  });
  it('APPLY: repairs canary first then the other four; each proven cancelled/cancelled; manual user and orphan untouched; zero Stripe writes', async () => {
    const w = world(); const c = clerkFor(w); const manual = JSON.stringify(md(w, 'user_manual'));
    const rc = await runRepair(base(w, c, { apply: true }));
    expect(rc.status).toBe('COMPLETE'); expect(c.writes).toEqual(['user_1', 'user_2', 'user_3', 'user_4', 'user_5']);
    for (let i = 1; i <= 5; i++) expect(md(w, `user_${i}`)).toMatchObject({ tier: 'cancelled', billing_status: 'cancelled', stripe_subscription_id: IDS[i - 1], county: 'palm-beach' });
    expect(JSON.stringify(md(w, 'user_manual'))).toBe(manual); expect(rc.stripe_write_attempts).toEqual([]); expect(w.stripeUpdates).toEqual([]);
    expect(rc.results.every(r => r.outcome === 'REPAIRED' && r.changed_keys!.every(k => ['tier', 'billing_status', 'stripe_subscription_status', 'stripe_event_created', 'stripe_event_ids', 'stripe_subscription_id'].includes(k)))).toBe(true);
  });
  it('canary-only: repairs just the canary and stops; second run skips it and processes the rest', async () => {
    const w = world(); const c = clerkFor(w);
    const a = await runRepair(base(w, c, { apply: true, canaryOnly: true }));
    expect(a.status).toBe('CANARY_ONLY_COMPLETE'); expect(c.writes).toEqual(['user_1']); expect(md(w, 'user_2').tier).toBe('starter');
    const b = await runRepair(base(w, c, { apply: true }));
    expect(b.status).toBe('COMPLETE'); expect(b.results[0].outcome).toBe('ALREADY_CORRECT'); expect(c.writes).toEqual(['user_1', 'user_2', 'user_3', 'user_4', 'user_5']);
  });
  it('PREFLIGHT refusal of ANY sub aborts the whole run with ZERO writes (sub that is not canceled)', async () => {
    const w = world(); w.setSub(IDS[3], { status: 'active' }); const c = clerkFor(w);
    const rc = await runRepair(base(w, c, { apply: true }));
    expect(rc.status).toBe('ABORTED_PREFLIGHT'); expect(c.writes).toEqual([]); expect(rc.results.find(r => r.sub === IDS[3])!.outcome).toBe('REFUSED');
    expect(md(w, 'user_1').tier).toBe('starter');
  });
  it.each([
    ['identity mismatch (sub metadata names another user)', (w: any) => { w.subs.get(IDS[2]).metadata.clerk_user_id = 'user_5'; }, /identity mismatch/],
    ['no Clerk user bound', (w: any) => { w.users.get('user_2').publicMetadata.stripe_subscription_id = 'sub_OTHER00000'; }, /exactly 1 Clerk user/],
    ['customer has another entitled subscription', (w: any) => w.setSub('sub_LIVE000001', { status: 'active', customer: `cus_${IDS[1]}`, metadata: { clerk_user_id: 'user_2' } }), /another entitled/],
    ['Clerk tier is not a stale paid tier', (w: any) => { w.users.get('user_4').publicMetadata.tier = 'free'; }, /not a stale paid tier/],
    ['Clerk customer mismatch', (w: any) => { w.users.get('user_3').publicMetadata.stripe_customer_id = 'cus_someone_else'; }, /stripe_customer_id does not match/],
  ])('refuses: %s', async (_n, mutate, re) => {
    const w = world(); mutate(w); const c = clerkFor(w);
    const rc = await runRepair(base(w, c, { apply: true }));
    expect(rc.status).toBe('ABORTED_PREFLIGHT'); expect(rc.results.some(r => r.outcome === 'REFUSED' && re.test(r.reason!))).toBe(true); expect(c.writes).toEqual([]);
  });
  it('a non-allowlisted subscription (the already-correct two, the orphan) can never be touched — they are simply not processed', async () => {
    const w = world(); const c = clerkFor(w);
    w.users.set('user_ok', { id: 'user_ok', email: 'o@x.com', publicMetadata: { tier: 'cancelled', billing_status: 'cancelled', stripe_subscription_id: 'sub_DONE000001' } });
    w.setSub('sub_DONE000001', { status: 'canceled', metadata: { clerk_user_id: 'user_ok' } });
    await runRepair(base(w, c, { apply: true })); expect(c.writes).not.toContain('user_ok'); expect(w.users.has('user_gone')).toBe(false);
  });
  it('STOPS on first failure: canary failing means NOTHING else is attempted', async () => {
    const w = world(); const c = clerkFor(w); const orig = c.clerk.users.updateUserMetadata;
    c.clerk.users.updateUserMetadata = async (id: string, p: any) => { if (id === 'user_1') throw new Error('clerk 500'); return orig(id, p); };
    const rc = await runRepair(base(w, c, { apply: true }));
    expect(rc.status).toBe('ABORTED_ON_FAILURE'); expect(rc.results[0].outcome).toBe('FAILED'); expect(rc.results.slice(1).every(r => r.outcome === 'NOT_ATTEMPTED')).toBe(true);
    for (let i = 2; i <= 5; i++) expect(md(w, `user_${i}`).tier).toBe('starter');
  });
  it('STOPS on non-convergence mid-run (a later user does not end cancelled/cancelled) and leaves the rest untouched', async () => {
    const w = world(); const c = clerkFor(w); const orig = c.clerk.users.updateUserMetadata;
    c.clerk.users.updateUserMetadata = async (id: string, p: any) => orig(id, id === 'user_3' ? { publicMetadata: { ...p.publicMetadata, tier: 'pro' } } : p);
    const rc = await runRepair(base(w, c, { apply: true }));
    expect(rc.status).toBe('ABORTED_ON_FAILURE'); expect(rc.results.map(r => r.outcome)).toEqual(['REPAIRED', 'REPAIRED', 'FAILED', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED']);
    expect(md(w, 'user_4').tier).toBe('starter');
  });
  it('aborts if Stripe state changes between preflight and mutation (re-read before write)', async () => {
    const w = world(); const c = clerkFor(w); let n = 0; const orig = w.stripe.subscriptions.retrieve;
    w.stripe.subscriptions.retrieve = async (id: string) => { const s = await orig(id); if (id === IDS[0] && ++n >= 2) s.status = 'active'; return s; };
    const rc = await runRepair(base(w, c, { apply: true }));
    expect(rc.status).toBe('ABORTED_ON_FAILURE'); expect(rc.results[0].reason).toMatch(/Stripe state changed/); expect(c.writes).toEqual([]);
  });
  it('invariant: a full APPLY never writes Stripe (no updates, no forbidden calls)', async () => {
    const w = world(); const c = clerkFor(w); const rc = await runRepair(base(w, c, { apply: true }));
    expect(w.stripeUpdates).toEqual([]); expect(w.forbiddenStripeCalls).toEqual([]); expect(rc.stripe_write_attempts).toEqual([]);
  });
  it('writes only to the user under repair: a Clerk write to anyone else is blocked', async () => {
    const w = world(); const c = clerkFor(w);
    // Clerk binds IDS[0] to user_1 but Stripe metadata points at user_2 → refused at preflight; the write guard would also block it.
    w.subs.get(IDS[0]).metadata.clerk_user_id = 'user_2';
    const rc = await runRepair(base(w, c, { apply: true })); expect(rc.status).toBe('ABORTED_PREFLIGHT'); expect(c.writes).toEqual([]);
  });
  it('apply writes an immutable snapshot BEFORE the first mutation, then a receipt', async () => {
    const w = world(); const c = clerkFor(w); const log: string[] = [];
    const sink = { write: (n: string) => log.push(`${n}@writes=${c.writes.length}`) };
    await runRepair(base(w, c, { apply: true, sink }));
    expect(log).toEqual(['snapshot-before@writes=0', 'receipt-apply@writes=5']);
  });
  it('dry run writes no snapshot, only a dry-run receipt; preflight abort writes receipt but no snapshot', async () => {
    const w = world(); const c = clerkFor(w); const log: string[] = []; const sink = { write: (n: string) => log.push(n) };
    await runRepair(base(w, c, { sink })); expect(log).toEqual(['receipt-dry-run']);
    w.setSub(IDS[1], { status: 'active' }); log.length = 0; await runRepair(base(w, c, { apply: true, sink })); expect(log).toEqual(['receipt-apply']);
  });
});
