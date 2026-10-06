// FROZEN ORACLE: verbatim copy of the inline classification that lived in scripts/prod-entitlement-reconcile.ts at 49d6817
// (before it was extracted into lib/revenue-integrity.ts). Used ONLY by tests as a parity oracle. Do not "improve" it.
import { entitlementForStatus, tierForSubscription } from '../lib/provisioning';
const REQUIRED_EVENTS = [
  'checkout.session.completed', 'invoice.payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
];
const PAID_EVENT_ANY_OF = ['invoice.payment_succeeded', 'invoice.paid'];
const EXPECTED_API_VERSION = '2023-10-16';
const WEBHOOK_PATH = '/api/stripe-webhook';
const RANK: Record<string, number> = { starter: 1, pro: 2, team: 3 };
const PAID_TIERS = new Set(Object.keys(RANK));

export function oracle(eps: any[], subs: any[], users: any[]) {
  const report: any = { A_webhooks: {}, B_reconcile: {} };
  const prod = eps.filter(e => String(e.url).includes('permitmap.org') && String(e.url).includes(WEBHOOK_PATH));
  const A_webhooks: any = {
    total_endpoints: eps.length,
    endpoints: eps.map(e => ({ id: e.id, url: e.url, status: e.status, api_version: e.api_version, livemode: e.livemode, enabled_events: e.enabled_events })),
    findings: [] as string[],
  };
  const F: string[] = A_webhooks.findings;
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
  const B_reconcile: any = {
    stripe_subscriptions_total: subs.length, clerk_users_total: users.length, users_examined: ids.size,
    unmapped_stripe_subscriptions: unmapped.map(s => ({ id: s.id, status: s.status, tier: tierForSubscription(s) ?? 'UNKNOWN_PRICE' })),
    unknown_price_subscriptions: subs.filter(s => ['active', 'trialing', 'past_due'].includes(s.status) && !tierForSubscription(s)).map(s => s.id),
    counts: bucket, discrepancies: rows.filter(r => r.class !== 'OK'),
  };

  return { A_webhooks, B_reconcile };
}
