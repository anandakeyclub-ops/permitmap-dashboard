// Controlled, allowlisted repair of stale paid access on CANCELED Stripe subscriptions.
// It drives the REAL production path (reconcileSubscription) — never hand-edits tier/billing metadata — behind hard guards:
//   * explicit allowlist of full subscription ids (exact count enforced); canary must be a member and always goes first
//   * ALL preflight checks run for ALL subs before the first write; any REFUSE aborts the run with zero writes
//   * Stripe is READ-ONLY for the whole run (any Stripe write attempt throws); Clerk may be written only for the one bound user under repair
//   * Stripe is re-read immediately before each mutation; Clerk is re-read afterwards and must equal cancelled/cancelled
//   * first error / non-convergence / unexpected alert / unexpected side-effect stops the run; remaining subs are NOT_ATTEMPTED
//   * apply=false (default) computes the same plan against an in-memory overlay and writes nothing
import { reconcileSubscription, entitlementForStatus } from '../lib/provisioning';

const PAID = new Set(['starter', 'pro', 'team']);
const SUB_ID = /^sub_[A-Za-z0-9]{8,}$/;
// Keys the revoke path may legitimately change. Anything else changing on the user is an unexpected side effect.
const EXPECTED_CHANGED = new Set(['tier', 'billing_status', 'stripe_subscription_id', 'stripe_subscription_status', 'stripe_event_created', 'stripe_event_ids']);
const ENTITLEMENT_KEYS = ['tier', 'billing_status', 'stripe_subscription_id', 'stripe_customer_id', 'stripe_subscription_status'] as const;

export type SubOutcome = 'REPAIRED' | 'ALREADY_CORRECT' | 'PLANNED' | 'REFUSED' | 'FAILED' | 'NOT_ATTEMPTED';
export interface RepairOptions {
  stripe: any; clerk: any; allowlist: string[]; canary: string; apply: boolean; canaryOnly?: boolean; expectedCount?: number;
  now?: () => Date; sink?: { write: (name: string, body: unknown) => void };
}
export interface SubReceipt {
  sub: string; clerk_user_id: string | null; outcome: SubOutcome; reason?: string; is_canary: boolean;
  stripe_before?: { status: string; customer: string; canceled_at: number | null; price_ids: string[] };
  stripe_recheck?: { status: string; customer: string };
  before?: Record<string, any>; after?: Record<string, any>; changed_keys?: string[]; alerts?: { kind: string; detail: any }[]; reconcile_outcome?: string;
}
export interface RepairReceipt {
  kind: 'stale-cancellation-repair'; mode: 'APPLY' | 'DRY_RUN'; canary_only: boolean; started_at: string; finished_at: string;
  status: 'COMPLETE' | 'ABORTED_PREFLIGHT' | 'ABORTED_ON_FAILURE' | 'CANARY_ONLY_COMPLETE' | 'DRY_RUN_COMPLETE';
  allowlist: string[]; canary: string; results: SubReceipt[]; stripe_write_attempts: string[]; clerk_writes: { user: string; keys: string[] }[];
  next_step: string;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x ?? null));
const pickEnt = (m: Record<string, any> | undefined) => Object.fromEntries(ENTITLEMENT_KEYS.map(k => [k, m?.[k] ?? null]));

/** Validates the allowlist shape only (pure). Throws with the exact reason. */
export function validateAllowlist(allowlist: string[], canary: string, expectedCount = 5): string[] {
  if (!Array.isArray(allowlist) || allowlist.some(s => typeof s !== 'string')) throw new Error('allowlist must be an array of subscription ids');
  const bad = allowlist.filter(s => !SUB_ID.test(s));
  if (bad.length) throw new Error(`allowlist contains malformed ids (truncated "sub_1abc..." forms are refused; full ids required): ${bad.join(', ')}`);
  if (new Set(allowlist).size !== allowlist.length) throw new Error('allowlist contains duplicates');
  if (allowlist.length !== expectedCount) throw new Error(`allowlist has ${allowlist.length} ids; this run is certified for exactly ${expectedCount}`);
  if (!allowlist.includes(canary)) throw new Error('canary must be a member of the allowlist');
  return [canary, ...allowlist.filter(s => s !== canary)];
}

export async function runRepair(o: RepairOptions): Promise<RepairReceipt> {
  const now = o.now ?? (() => new Date());
  const started = now().toISOString();
  const order = validateAllowlist(o.allowlist, o.canary, o.expectedCount ?? 5);
  const stripeWriteAttempts: string[] = []; const clerkWrites: RepairReceipt['clerk_writes'] = [];

  // Stripe: reads pass through, every write throws (and is recorded).
  const blocked = (name: string) => async () => { stripeWriteAttempts.push(name); throw new Error(`STRIPE WRITE BLOCKED: ${name} (repair is Clerk-only)`); };
  const stripeRO = {
    webhooks: o.stripe.webhooks,
    subscriptions: { retrieve: (id: string) => o.stripe.subscriptions.retrieve(id), list: (p: any) => o.stripe.subscriptions.list(p), search: (p: any) => o.stripe.subscriptions.search(p), update: blocked('subscriptions.update'), cancel: blocked('subscriptions.cancel') },
    customers: { retrieve: (id: string) => o.stripe.customers.retrieve(id), update: blocked('customers.update') },
  };

  // Load all Clerk users once (read-only) to resolve the bound user for each sub.
  const users: { id: string; publicMetadata: Record<string, any> }[] = [];
  for (let off = 0; ; off += 500) {
    const p: any = await o.clerk.users.getUserList({ limit: 500, offset: off }); const r = Array.isArray(p) ? p : p.data;
    users.push(...r.map((u: any) => ({ id: u.id, publicMetadata: clone(u.publicMetadata || {}) }))); if (r.length < 500) break;
  }

  // ---------- PREFLIGHT (read-only, all subs, before any write) ----------
  const results = new Map<string, SubReceipt>(); const targets = new Map<string, string>(); let refused = false;
  for (const sid of order) {
    const r: SubReceipt = { sub: sid, clerk_user_id: null, outcome: 'NOT_ATTEMPTED', is_canary: sid === o.canary }; results.set(sid, r);
    const refuse = (why: string) => { r.outcome = 'REFUSED'; r.reason = why; refused = true; };
    let sub: any;
    try { sub = await o.stripe.subscriptions.retrieve(sid); } catch (e: any) { refuse(`cannot read subscription from Stripe: ${String(e?.message || e).slice(0, 120)}`); continue; }
    if (!sub || sub.id !== sid) { refuse('Stripe returned a different/empty subscription'); continue; }
    r.stripe_before = { status: sub.status, customer: String(sub.customer), canceled_at: sub.canceled_at ?? null, price_ids: (sub.items?.data || []).map((i: any) => i?.price?.id) };
    if (entitlementForStatus(sub.status, !!sub.pause_collection).action !== 'revoke') { refuse(`Stripe status is "${sub.status}", not an ended subscription`); continue; }
    const bound = users.filter(u => u.publicMetadata?.stripe_subscription_id === sid);
    if (bound.length !== 1) { refuse(`expected exactly 1 Clerk user bound to this subscription, found ${bound.length}`); continue; }
    const u = bound[0]; r.clerk_user_id = u.id; r.before = pickEnt(u.publicMetadata);
    const metaUser = sub.metadata?.clerk_user_id;
    if (metaUser && metaUser !== u.id) { refuse('subscription metadata.clerk_user_id does not match the bound Clerk user (identity mismatch)'); continue; }
    if (u.publicMetadata.stripe_customer_id && u.publicMetadata.stripe_customer_id !== String(sub.customer)) { refuse('Clerk stripe_customer_id does not match the subscription customer'); continue; }
    if (targets.has(u.id)) { refuse('two allowlisted subscriptions map to the same Clerk user'); continue; }
    // Another entitled subscription for this customer → human review (the webhook would promote it, not revoke).
    try {
      const l: any = await o.stripe.subscriptions.list({ customer: sub.customer, status: 'all', limit: 100 });
      const others = (l.data || []).filter((s: any) => s.id !== sid && entitlementForStatus(s.status, !!s.pause_collection).action === 'grant');
      if (others.length) { refuse(`customer has another entitled subscription (${others.map((s: any) => s.id).join(',')}); needs human review`); continue; }
    } catch (e: any) { refuse(`cannot list customer subscriptions: ${String(e?.message || e).slice(0, 120)}`); continue; }
    targets.set(u.id, sid);
    const t = u.publicMetadata.tier, b = u.publicMetadata.billing_status;
    if (t === 'cancelled' && b === 'cancelled') { r.outcome = 'ALREADY_CORRECT'; r.reason = 'already cancelled/cancelled'; }
    else if (!PAID.has(t)) { refuse(`Clerk tier is "${t}", not a stale paid tier; nothing certified to repair`); }
  }

  const snapshot = { taken_at: now().toISOString(), allowlist: order, canary: o.canary, users: order.map(s => ({ sub: s, clerk_user_id: results.get(s)!.clerk_user_id, before_publicMetadata: users.find(u => u.id === results.get(s)!.clerk_user_id)?.publicMetadata ?? null })) };
  const mkReceipt = (status: RepairReceipt['status'], next: string): RepairReceipt => ({
    kind: 'stale-cancellation-repair', mode: o.apply ? 'APPLY' : 'DRY_RUN', canary_only: !!o.canaryOnly, started_at: started, finished_at: now().toISOString(), status,
    allowlist: order, canary: o.canary, results: order.map(s => results.get(s)!), stripe_write_attempts: stripeWriteAttempts, clerk_writes: clerkWrites, next_step: next,
  });
  const finish = (rc: RepairReceipt) => { o.sink?.write(o.apply ? 'receipt-apply' : 'receipt-dry-run', rc); return rc; };

  if (refused) return finish(mkReceipt('ABORTED_PREFLIGHT', 'Nothing was written. Resolve every REFUSED entry (or remove it from the certified allowlist after re-certification) and re-run.'));
  if (o.apply) o.sink?.write('snapshot-before', snapshot); // immutable BEFORE any mutation

  // ---------- EXECUTE (canary first, strictly sequential, stop on first problem) ----------
  const overlay = new Map(users.map(u => [u.id, clone(u.publicMetadata)]));
  const dryOverlay = new Map(users.map(u => [u.id, clone(u.publicMetadata)]));
  let stop = false;
  for (let i = 0; i < order.length; i++) {
    const sid = order[i]; const r = results.get(sid)!;
    if (stop) { r.outcome = 'NOT_ATTEMPTED'; r.reason = r.reason ?? 'earlier failure'; continue; }
    if (o.canaryOnly && sid !== o.canary) { r.outcome = r.outcome === 'ALREADY_CORRECT' ? 'ALREADY_CORRECT' : 'NOT_ATTEMPTED'; r.reason = r.reason ?? 'canary-only run'; continue; }
    if (r.outcome === 'ALREADY_CORRECT') continue;
    const uid = r.clerk_user_id!; const alerts: { kind: string; detail: any }[] = [];
    const fail = (why: string) => { r.outcome = 'FAILED'; r.reason = why; r.alerts = alerts; stop = true; };
    try {
      // Re-read Stripe immediately before mutation.
      const fresh = await o.stripe.subscriptions.retrieve(sid);
      r.stripe_recheck = { status: fresh.status, customer: String(fresh.customer) };
      if (fresh.status !== r.stripe_before!.status || String(fresh.customer) !== r.stripe_before!.customer || entitlementForStatus(fresh.status, !!fresh.pause_collection).action !== 'revoke') { fail('Stripe state changed between preflight and mutation'); continue; }
      // Re-read Clerk immediately before mutation; must still be the snapshotted paid state.
      const cur = clone((await o.clerk.users.getUser(uid)).publicMetadata || {});
      if (JSON.stringify(pickEnt(cur)) !== JSON.stringify(r.before)) { fail('Clerk entitlement changed since snapshot'); continue; }
      overlay.set(uid, clone(cur));
      const clerkGuard = {
        users: {
          getUserList: (p: any) => o.clerk.users.getUserList(p),
          getUser: async (id: string) => o.apply ? o.clerk.users.getUser(id) : { publicMetadata: clone(dryOverlay.get(id) ?? cur) },
          updateUserMetadata: async (id: string, p: { publicMetadata: Record<string, any> }) => {
            if (id !== uid) throw new Error(`CLERK WRITE BLOCKED: ${id} is not the user under repair (${uid})`);
            clerkWrites.push({ user: id, keys: Object.keys(p.publicMetadata) });
            if (!o.apply) { dryOverlay.set(id, { ...(dryOverlay.get(id) ?? cur), ...clone(p.publicMetadata) }); return {}; }
            return o.clerk.users.updateUserMetadata(id, p);
          },
        },
      };
      if (!o.apply) dryOverlay.set(uid, clone(cur));
      const res = await reconcileSubscription(stripeRO as any, clerkGuard as any, (kind: string, detail: any) => alerts.push({ kind, detail }), fresh, {});
      r.reconcile_outcome = res.outcome; r.alerts = alerts;
      if (res.outcome !== 'revoked') { fail(`unexpected reconcile outcome "${res.outcome}" (expected "revoked")`); continue; }
      if (alerts.length) { fail(`unexpected alerts: ${alerts.map(a => a.kind).join(',')}`); continue; }
      // Re-read Clerk and PROVE convergence.
      const after = o.apply ? clone((await o.clerk.users.getUser(uid)).publicMetadata || {}) : clone(dryOverlay.get(uid));
      r.after = pickEnt(after);
      const changed = [...new Set([...Object.keys(cur), ...Object.keys(after)])].filter(k => JSON.stringify(cur[k] ?? null) !== JSON.stringify(after[k] ?? null));
      r.changed_keys = changed;
      if (after.tier !== 'cancelled' || after.billing_status !== 'cancelled') { fail(`did not converge: ${after.tier}/${after.billing_status}`); continue; }
      if (after.stripe_subscription_id !== sid) { fail('binding changed unexpectedly'); continue; }
      const surprise = changed.filter(k => !EXPECTED_CHANGED.has(k));
      if (surprise.length) { fail(`unexpected keys changed: ${surprise.join(',')}`); continue; }
      r.outcome = o.apply ? 'REPAIRED' : 'PLANNED';
    } catch (e: any) { fail(`error: ${String(e?.message || e).slice(0, 200)}`); }
  }
  if (stripeWriteAttempts.length) { results.forEach(r => { if (r.outcome === 'REPAIRED') r.reason = r.reason ?? 'note: a Stripe write was attempted and blocked'; }); }

  const anyFailed = [...results.values()].some(r => r.outcome === 'FAILED');
  if (anyFailed) return finish(mkReceipt('ABORTED_ON_FAILURE', 'STOPPED. Remaining subscriptions were not attempted. Review the receipt; Clerk changes already made are listed in clerk_writes and snapshot-before holds the prior state.'));
  if (!o.apply) return finish(mkReceipt('DRY_RUN_COMPLETE', 'Dry run only — nothing written. Re-run with --apply --canary-only and the typed confirmation to repair the canary.'));
  if (o.canaryOnly) return finish(mkReceipt('CANARY_ONLY_COMPLETE', 'Canary repaired and proven. Verify, then re-run with --apply (without --canary-only) to process the remaining subscriptions sequentially. Afterwards run scripts/prod-entitlement-reconcile.ts (expect stale-access count 0).'));
  return finish(mkReceipt('COMPLETE', 'Run scripts/prod-entitlement-reconcile.ts now (expect stale-access count 0; manual/legacy and missing-user cases remain separately classified).'));
}
