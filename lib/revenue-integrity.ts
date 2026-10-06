// Revenue-integrity classification: the SINGLE source of truth for "do Stripe and Clerk agree about who has paid access?".
// Pure functions (no network, no SDK imports) shared by:
//   - scripts/prod-entitlement-reconcile.ts   (manual verifier, prints the full report)
//   - app/api/internal/revenue-integrity      (authenticated read-only monitor endpoint polled by permit-bot)
// The reconciliation + webhook-registration logic below was extracted VERBATIM from the verifier so the two cannot drift
// (tests/revenue-integrity.test.ts keeps a frozen copy of the original as a parity oracle). Entitlement decisions come from the
// production functions (entitlementForStatus / tierForSubscription), never from a second implementation.
//
// On top of that raw classification sits a severity layer (assessIntegrity) that decides what is ACTIONABLE (turns the monitor RED)
// versus INFORMATIONAL (reported, never alerts), and a deterministic fingerprint so a poller can deduplicate incidents.
import { createHash } from 'node:crypto';
import { entitlementForStatus, tierForSubscription } from './provisioning';

export const EXPECTED_API_VERSION = '2023-10-16';
export const WEBHOOK_PATH = '/api/stripe-webhook';
const REQUIRED_EVENTS = [
  'checkout.session.completed', 'invoice.payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
];
const PAID_EVENT_ANY_OF = ['invoice.payment_succeeded', 'invoice.paid'];
const RANK: Record<string, number> = { starter: 1, pro: 2, team: 3 };
const PAID_TIERS = new Set(Object.keys(RANK));

// ───────────────────────── A. webhook registration (verbatim from the verifier) ─────────────────────────
export function webhookFindings(eps: any[]): string[] {
  const prod = eps.filter(e => String(e.url).includes('permitmap.org') && String(e.url).includes(WEBHOOK_PATH));
  const F: string[] = [];
  if (prod.length === 0) F.push('CRITICAL: no endpoint registered for permitmap.org' + WEBHOOK_PATH);
  if (prod.length > 1) F.push(`WARN: ${prod.length} endpoints target the production route (duplicate delivery; idempotency covers it, but verify intent)`);
  for (const e of prod) {
    if (e.status !== 'enabled') F.push(`CRITICAL: ${e.id} status=${e.status}`);
    if (!e.livemode) F.push(`CRITICAL: ${e.id} is a test-mode endpoint`);
    if (e.api_version !== EXPECTED_API_VERSION) F.push(`WARN: ${e.id} api_version=${e.api_version ?? 'account default'} (route client pins ${EXPECTED_API_VERSION}; event payload shape follows the ENDPOINT version)`);
    const ev: string[] = e.enabled_events || [];
    const all = ev.includes('*');
    const missing = all ? [] : REQUIRED_EVENTS.filter(r => !ev.includes(r));
    if (!all && !PAID_EVENT_ANY_OF.some(r => ev.includes(r))) missing.push('invoice.payment_succeeded|invoice.paid');
    if (missing.length) F.push(`CRITICAL: ${e.id} missing events: ${missing.join(', ')}`);
  }
  if (!F.length) F.push('OK: production endpoint enabled, livemode, required events registered, API version matches');
  return F;
}

// ───────────────────────── B. Stripe ↔ Clerk reconciliation (verbatim from the verifier) ─────────────────────────
export interface ReconcileSection {
  stripe_subscriptions_total: number; clerk_users_total: number; users_examined: number;
  unmapped_stripe_subscriptions: { id: string; status: string; tier: string }[];
  unknown_price_subscriptions: string[];
  counts: Record<string, number>;
  discrepancies: any[];
}

export function reconcileEntitlements(subs: any[], users: any[]): ReconcileSection {
  const byUser = new Map<string, any[]>(); const unmapped: any[] = [];
  for (const s of subs) { const u = s.metadata?.clerk_user_id; if (u) { (byUser.get(u) || byUser.set(u, []).get(u)!).push(s); } else unmapped.push(s); }
  const clerkById = new Map(users.map(u => [u.id, u]));
  const rows: any[] = []; const bucket: Record<string, number> = {};
  const mark = (cls: string, row: any) => { bucket[cls] = (bucket[cls] || 0) + 1; rows.push({ class: cls, ...row }); };

  const expectedFor = (mine: any[]) => {
    const entitled = mine.filter(s => entitlementForStatus(s.status, !!s.pause_collection).action === 'grant' && tierForSubscription(s));
    if (entitled.length) {
      entitled.sort((a, b) => RANK[tierForSubscription(b)!] - RANK[tierForSubscription(a)!]);
      const top = entitled[0];
      return { tier: tierForSubscription(top)!, billing: (entitlementForStatus(top.status, !!top.pause_collection) as any).billingStatus, subs: entitled.map(s => s.id) };
    }
    return { tier: null as string | null, billing: null as string | null, subs: [] as string[] };
  };

  const ids = new Set<string>([...byUser.keys(), ...users.filter(u => PAID_TIERS.has(u.publicMetadata?.tier) || u.publicMetadata?.stripe_subscription_id).map(u => u.id)]);
  for (const id of ids) {
    const u = clerkById.get(id); const pm = u?.publicMetadata || {}; const mine = byUser.get(id) || [];
    const exp = expectedFor(mine); const ctier = pm.tier as string | undefined; const cbill = pm.billing_status as string | undefined;
    const base = { clerk_user_id: id, clerk_tier: ctier ?? null, clerk_billing: cbill ?? null, clerk_bound_sub: pm.stripe_subscription_id ?? null, stripe_subs: mine.map(s => `${s.id}:${s.status}:${tierForSubscription(s) ?? 'UNKNOWN_PRICE'}`), expected_tier: exp.tier, expected_billing: exp.billing };
    if (!u) { mark('STRIPE_MAPS_TO_MISSING_CLERK_USER', base); continue; }
    const clerkPaid = PAID_TIERS.has(ctier || '');
    if (exp.tier) {
      if (!clerkPaid) mark('PAYING_CUSTOMER_WITHOUT_ACCESS', base);
      else if (ctier !== exp.tier) mark('TIER_MISMATCH', base);
      else if (cbill !== exp.billing) mark('BILLING_STATUS_MISMATCH', base);
      else if (pm.stripe_subscription_id && !exp.subs.includes(pm.stripe_subscription_id)) mark('BOUND_SUB_NOT_ENTITLED_BUT_ANOTHER_IS', base);
      else mark('OK', base);
    } else {
      if (clerkPaid && !pm.stripe_subscription_id && !mine.length) mark('PAID_TIER_NO_STRIPE_BINDING (comp/manual/legacy?)', base);
      else if (clerkPaid) mark('ACCESS_WITHOUT_ENTITLED_SUBSCRIPTION', base);
      else mark('OK', base);
    }
  }
  return {
    stripe_subscriptions_total: subs.length, clerk_users_total: users.length, users_examined: ids.size,
    unmapped_stripe_subscriptions: unmapped.map(s => ({ id: s.id, status: s.status, tier: tierForSubscription(s) ?? 'UNKNOWN_PRICE' })),
    unknown_price_subscriptions: subs.filter(s => ['active', 'trialing', 'past_due'].includes(s.status) && !tierForSubscription(s)).map(s => s.id),
    counts: bucket, discrepancies: rows.filter(r => r.class !== 'OK'),
  };
}

// ───────────────────────── C. severity layer (new) ─────────────────────────
export type IntegrityStatus = 'GREEN' | 'RED' | 'UNAVAILABLE';
export interface Finding { key: string; class: string; clerk_user_id: string | null; stripe_subscription_ids: string[]; detail: Record<string, any> }
export type CheckResult = { status: 'COMPLETE' } | { status: 'UNAVAILABLE'; reason: string };
export interface IntegrityReport {
  schema: 1;
  status: IntegrityStatus;
  generated_at: string;
  instances: { stripe: string; clerk: string } | null;
  checks: { reconciliation: CheckResult; webhook_registration: CheckResult };
  degraded_checks: string[];
  // sha256 over the sorted keys of ACTIONABLE findings; identical findings => identical fingerprint regardless of time/order. null when UNAVAILABLE and no finding was established.
  fingerprint: string | null;
  counts: { actionable_total: number; informational_total: number; actionable_by_class: Record<string, number>; informational_by_class: Record<string, number>; stripe_subscriptions: number | null; clerk_users: number | null; users_examined: number | null };
  findings: Finding[];        // actionable: these make the status RED
  informational: Finding[];   // reported, never alerts
  unavailable_reason: string | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isEntitled = (s: any) => entitlementForStatus(s.status, !!s.pause_collection).action === 'grant' && !!tierForSubscription(s);
const mkFinding = (cls: string, clerkUserId: string | null, subIds: string[], detail: Record<string, any>): Finding => {
  const ids = [...subIds].sort();
  const identity = [cls, clerkUserId ?? '', ids.join(','), detail.expected_tier ?? '', detail.clerk_tier ?? '', detail.expected_billing ?? '', detail.clerk_billing ?? '', detail.clerk_bound_sub ?? '', detail.message ?? ''].join('|');
  return { key: sha(identity).slice(0, 16), class: cls, clerk_user_id: clerkUserId, stripe_subscription_ids: ids, detail };
};
const subIdsOf = (row: any): string[] => (row.stripe_subs || []).map((x: string) => String(x).split(':')[0]);

// Classes that are ALWAYS actionable when the verifier reports them.
const ACTIONABLE_CLASSES = new Set([
  'ACCESS_WITHOUT_ENTITLED_SUBSCRIPTION',   // stale access: Clerk grants paid access, Stripe has no entitled subscription
  'PAYING_CUSTOMER_WITHOUT_ACCESS',         // Stripe entitled, Clerk not paid
  'TIER_MISMATCH', 'BILLING_STATUS_MISMATCH',
  'BOUND_SUB_NOT_ENTITLED_BUT_ANOTHER_IS',  // conflicting binding
]);

export function assessIntegrity(opts: { subs: any[]; users: any[]; reconcile: ReconcileSection; webhook: string[] | null }): { actionable: Finding[]; informational: Finding[] } {
  const actionable: Finding[] = []; const informational: Finding[] = [];
  const { subs, reconcile } = opts;

  for (const r of reconcile.discrepancies) {
    const detail = { clerk_tier: r.clerk_tier, clerk_billing: r.clerk_billing, clerk_bound_sub: r.clerk_bound_sub, expected_tier: r.expected_tier, expected_billing: r.expected_billing, stripe_subs: r.stripe_subs };
    const f = mkFinding(r.class, r.clerk_user_id, subIdsOf(r), detail);
    if (ACTIONABLE_CLASSES.has(r.class)) actionable.push(f);
    // A paying (entitled) subscription whose Clerk user is gone is a real orphan mapping; a canceled one pointing at a deleted user is just debris.
    else if (r.class === 'STRIPE_MAPS_TO_MISSING_CLERK_USER') (r.expected_tier ? actionable : informational).push(f);
    // Paid tier with no Stripe binding at all = manual/legacy grant. Intentionally NOT alerting (known open business question); still reported.
    else informational.push(f);
  }

  // Unknown price on a subscription that should be live: customer pays and gets nothing (production fails closed on these).
  for (const id of reconcile.unknown_price_subscriptions) {
    const s = subs.find(x => x.id === id);
    actionable.push(mkFinding('UNKNOWN_PRICE', s?.metadata?.clerk_user_id ?? null, [id], { status: s?.status ?? null, message: 'live subscription has a price that maps to no tier' }));
  }

  // Orphan mappings: Stripe subscription with no clerk_user_id. Entitled-looking ones are defects; ended ones are history.
  for (const u of reconcile.unmapped_stripe_subscriptions) {
    const live = ['active', 'trialing', 'past_due'].includes(u.status);
    (live ? actionable : informational).push(mkFinding(live ? 'UNMAPPED_LIVE_SUBSCRIPTION' : 'UNMAPPED_ENDED_SUBSCRIPTION', null, [u.id], { status: u.status, tier: u.tier, message: live ? 'live Stripe subscription carries no clerk_user_id' : 'ended subscription without clerk mapping' }));
  }

  // Duplicates: ONLY the anomalous shape production itself alerts on (duplicate_subscription): one Clerk user with two or more
  // simultaneously ENTITLED subscriptions. A user who merely has several subscriptions in history (resubscribe, plan-change trail,
  // promotion after a cancel) is normal and never alerts. The "bound sub not entitled but another is" conflict is already classified above.
  const byUser = new Map<string, any[]>();
  for (const s of subs) { const u = s.metadata?.clerk_user_id; if (u && isEntitled(s)) (byUser.get(u) || byUser.set(u, []).get(u)!).push(s); }
  for (const [uid, entitled] of byUser) {
    if (entitled.length > 1) actionable.push(mkFinding('FOREIGN_ACTIVE_DUPLICATE', uid, entitled.map(s => s.id), { message: `${entitled.length} simultaneously entitled subscriptions for one Clerk user`, stripe_subs: entitled.map(s => `${s.id}:${s.status}:${tierForSubscription(s)}`) }));
  }

  if (opts.webhook) {
    for (const line of opts.webhook) {
      if (line.startsWith('CRITICAL:')) actionable.push(mkFinding('WEBHOOK_REGISTRATION_CRITICAL', null, [], { message: line }));
      else if (line.startsWith('WARN:')) informational.push(mkFinding('WEBHOOK_REGISTRATION_WARN', null, [], { message: line }));
    }
  }
  const order = (a: Finding, b: Finding) => (a.class + a.key).localeCompare(b.class + b.key);
  return { actionable: actionable.sort(order), informational: informational.sort(order) };
}

export const fingerprintOf = (findings: Finding[]): string => 'sha256:' + sha(findings.map(f => f.key).sort().join('\n'));
const tally = (fs: Finding[]) => fs.reduce<Record<string, number>>((m, f) => { m[f.class] = (m[f.class] || 0) + 1; return m; }, {});

export interface IntegrityInputs {
  now: Date;
  instances: { stripe: string; clerk: string } | null;
  reconciliation: { ok: true; subs: any[]; users: any[] } | { ok: false; reason: string };
  webhook: { ok: true; endpoints: any[] } | { ok: false; reason: string };
}

/**
 * GREEN       = every required check completed and found no actionable defect.
 * RED         = reconciliation completed and found at least one actionable defect (even if another check was unavailable).
 * UNAVAILABLE = truth could not be established (a required check could not complete, or the instances are wrong) and no defect was proven.
 * HTTP success is never evidence of health: only status === 'GREEN' is.
 */
export function buildIntegrityReport(i: IntegrityInputs): IntegrityReport {
  const generated_at = i.now.toISOString();
  const recon: CheckResult = i.reconciliation.ok === true ? { status: 'COMPLETE' } : { status: 'UNAVAILABLE', reason: (i.reconciliation as { reason: string }).reason };
  const hook: CheckResult = i.webhook.ok === true ? { status: 'COMPLETE' } : { status: 'UNAVAILABLE', reason: (i.webhook as { reason: string }).reason };
  const degraded = [...(recon.status === 'UNAVAILABLE' ? ['reconciliation'] : []), ...(hook.status === 'UNAVAILABLE' ? ['webhook_registration'] : [])];

  let actionable: Finding[] = []; let informational: Finding[] = [];
  let section: ReconcileSection | null = null;
  if (i.reconciliation.ok) {
    section = reconcileEntitlements(i.reconciliation.subs, i.reconciliation.users);
    ({ actionable, informational } = assessIntegrity({ subs: i.reconciliation.subs, users: i.reconciliation.users, reconcile: section, webhook: i.webhook.ok ? webhookFindings(i.webhook.endpoints) : null }));
  } else if (i.webhook.ok) {
    // Reconciliation unavailable but the webhook check ran: keep its findings, but the overall verdict cannot be GREEN/RED on reconciliation.
    const w = assessIntegrity({ subs: [], users: [], reconcile: { stripe_subscriptions_total: 0, clerk_users_total: 0, users_examined: 0, unmapped_stripe_subscriptions: [], unknown_price_subscriptions: [], counts: {}, discrepancies: [] }, webhook: webhookFindings(i.webhook.endpoints) });
    informational = [...w.informational]; actionable = [];
  }

  let status: IntegrityStatus;
  if (recon.status === 'COMPLETE' && actionable.length) status = 'RED';
  else if (degraded.length) status = 'UNAVAILABLE';
  else status = 'GREEN';

  return {
    schema: 1, status, generated_at, instances: i.instances,
    checks: { reconciliation: recon, webhook_registration: hook },
    degraded_checks: degraded,
    fingerprint: recon.status === 'COMPLETE' ? fingerprintOf(actionable) : null,
    counts: {
      actionable_total: actionable.length, informational_total: informational.length,
      actionable_by_class: tally(actionable), informational_by_class: tally(informational),
      stripe_subscriptions: section?.stripe_subscriptions_total ?? null, clerk_users: section?.clerk_users_total ?? null, users_examined: section?.users_examined ?? null,
    },
    findings: actionable, informational,
    unavailable_reason: degraded.length ? degraded.map(d => `${d}: ${(d === 'reconciliation' ? (recon as any) : (hook as any)).reason}`).join('; ') : null,
  };
}

/** Failure reasons are fixed codes: never raw SDK messages, which can echo key fragments. */
export function safeReason(prefix: string, e: any): string {
  const part = (v: any) => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(v) ? v : null);
  const bits = [part(e?.type), part(e?.code), typeof e?.statusCode === 'number' ? String(e.statusCode) : (typeof e?.status === 'number' ? String(e.status) : null)].filter(Boolean);
  return bits.length ? `${prefix}:${bits.join(':')}` : `${prefix}:unexpected_error`;
}
