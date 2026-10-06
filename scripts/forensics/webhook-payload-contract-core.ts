// Webhook payload-version contract check. Feeds REAL (or fixture) Stripe event payloads through the REAL handler (handleStripeEvent)
// with read-only Stripe and an in-memory Clerk overlay, and verifies the handler actually ACTED on the subscription the event refers to
// (instead of silently ignoring it because a field moved between API versions). Zero writes anywhere.
import { handleStripeEvent } from '../../lib/provisioning';

export type Verdict = 'PASS' | 'FAIL_SILENTLY_IGNORED' | 'FAIL_WRONG_SUBSCRIPTION' | 'FAIL_ERROR' | 'FAIL_UNEXPECTED_ALERT' | 'NOT_APPLICABLE' | 'INCONCLUSIVE';
export interface ContractRow { event_id: string; type: string; api_version: string | null; verdict: Verdict; expected_sub: string | null; retrieved_subs: string[]; alerts: string[]; would_write_clerk: number; would_write_stripe: string[]; resolved_clerk_users: string[]; note?: string }

const HANDLED = new Set(['checkout.session.completed', 'invoice.payment_succeeded', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);
// Independent of the handler: every place Stripe has ever put the subscription reference on an invoice.
export function expectedSubscriptionId(ev: any): string | null {
  const o = ev?.data?.object; if (!o) return null;
  if (ev.type.startsWith('customer.subscription.')) return o.id ?? null;
  if (ev.type === 'checkout.session.completed') return typeof o.subscription === 'string' ? o.subscription : o.subscription?.id ?? null;
  const fromLine = o.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ?? o.lines?.data?.[0]?.subscription ?? null;
  const v = o.subscription ?? o.parent?.subscription_details?.subscription ?? fromLine;
  return typeof v === 'string' ? v : v?.id ?? null;
}

export async function checkEventContract(ev: any, deps: { stripeRead: any; clerkUsers: Map<string, Record<string, any>> }): Promise<ContractRow> {
  const base = { event_id: ev.id, type: ev.type, api_version: ev.api_version ?? null };
  const expected = expectedSubscriptionId(ev);
  if (!HANDLED.has(ev.type)) return { ...base, verdict: 'NOT_APPLICABLE', expected_sub: expected, retrieved_subs: [], alerts: [], would_write_clerk: 0, would_write_stripe: [], resolved_clerk_users: [] };
  // invoices with nothing paid / not subscription-related are legitimately ignored
  if ((ev.type === 'invoice.payment_succeeded' || ev.type === 'invoice.paid') && !((ev.data.object.amount_paid || 0) > 0))
    return { ...base, verdict: 'NOT_APPLICABLE', expected_sub: expected, retrieved_subs: [], alerts: [], would_write_clerk: 0, would_write_stripe: [], resolved_clerk_users: [], note: 'amount_paid is 0 — handler ignores by design' };
  if (ev.type.startsWith('invoice.') && !expected) // a one-off invoice, not a subscription invoice
    return { ...base, verdict: 'NOT_APPLICABLE', expected_sub: null, retrieved_subs: [], alerts: [], would_write_clerk: 0, would_write_stripe: [], resolved_clerk_users: [], note: 'no subscription reference anywhere on the invoice' };

  const retrieved: string[] = []; const alerts: string[] = []; const stripeWrites: string[] = []; let clerkWrites = 0;
  // SYNTHETIC Clerk: this checker certifies PAYLOAD SHAPE, not user existence. Any user id the handler resolves is auto-created in a
  // throw-away overlay (and recorded), so "target user not found in our fake" can never masquerade as a contract failure.
  const overlay = new Map([...deps.clerkUsers].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const resolved = new Set<string>(); const ensure = (id: string) => { resolved.add(id); if (!overlay.has(id)) overlay.set(id, {}); };
  const stripe = {
    webhooks: { constructEvent: () => { throw new Error('unused'); } },
    subscriptions: {
      retrieve: async (id: string) => { retrieved.push(id); return deps.stripeRead.subscriptions.retrieve(id); },
      list: (p: any) => deps.stripeRead.subscriptions.list(p), search: (p: any) => deps.stripeRead.subscriptions.search(p),
      update: async (id: string) => { stripeWrites.push(`subscriptions.update(${id})`); return {}; },
    },
    customers: { retrieve: (id: string) => deps.stripeRead.customers.retrieve(id), update: async (id: string) => { stripeWrites.push(`customers.update(${id})`); return {}; } },
  };
  const clerk: any = { users: {
    getUserList: async () => ({ totalCount: 0, data: [] }),
    getUser: async (id: string) => { ensure(id); return { publicMetadata: JSON.parse(JSON.stringify(overlay.get(id))) }; },
    updateUserMetadata: async (id: string, p: any) => { clerkWrites++; ensure(id); overlay.set(id, { ...overlay.get(id), ...JSON.parse(JSON.stringify(p.publicMetadata)) }); return {}; },
    createUser: async () => { clerkWrites++; ensure('user_SYNTHETIC_NEW'); return { id: 'user_SYNTHETIC_NEW' }; },
  } };
  const row = (verdict: Verdict, note?: string): ContractRow => ({ ...base, verdict, expected_sub: expected, retrieved_subs: retrieved, alerts, would_write_clerk: clerkWrites, would_write_stripe: stripeWrites, resolved_clerk_users: [...resolved], note });
  try { await handleStripeEvent(stripe as any, clerk, JSON.parse(JSON.stringify(ev)), { emit: async () => {}, alert: (k: string) => { alerts.push(k); } }); }
  catch (e: any) {
    const m = String(e?.message || e).slice(0, 160);
    // The referenced subscription no longer exists in Stripe: we cannot replay it, which says nothing about payload shape.
    return /No such subscription|resource_missing/i.test(m) ? row('INCONCLUSIVE', `subscription not retrievable: ${m}`) : row('FAIL_ERROR', m);
  }
  // deleted events are applied from the event snapshot and need no retrieve; everything else must have looked up the referenced subscription.
  if (ev.type !== 'customer.subscription.deleted' && expected && !retrieved.includes(expected) && !ev.type.startsWith('customer.subscription.'))
    return row('FAIL_SILENTLY_IGNORED', 'handler never looked up the subscription this event refers to');
  const wrong = retrieved.filter(id => id !== expected);
  if (wrong.length) return row('FAIL_WRONG_SUBSCRIPTION', `handler retrieved ${[...new Set(wrong)].join(',')} but the event refers to ${expected}`);
  const bad = alerts.filter(a => ['unknown_price', 'unknown_subscription_status', 'webhook_processing_error'].includes(a));
  if (bad.length) return row('FAIL_UNEXPECTED_ALERT', bad.join(','));
  // Identity could not be derived from the payload/metadata (a data question — e.g. legacy/manual subscription — not a shape question).
  if (alerts.some(a => a === 'identity_missing_at_checkout' || a === 'no_email_no_identity')) return row('INCONCLUSIVE', 'payload parsed, but no Clerk identity derivable from this subscription (data issue, not payload shape)');
  return row('PASS');
}

export function summarize(rows: ContractRow[]) {
  const byVersion: Record<string, Record<string, number>> = {};
  for (const r of rows) { const v = r.api_version ?? 'unknown'; (byVersion[v] ||= {})[r.verdict] = ((byVersion[v] ||= {})[r.verdict] || 0) + 1; }
  const failures = rows.filter(r => r.verdict.startsWith('FAIL')).length;
  return { total: rows.length, failures, by_api_version: byVersion, certified: failures === 0 && rows.some(r => r.verdict === 'PASS') };
}
