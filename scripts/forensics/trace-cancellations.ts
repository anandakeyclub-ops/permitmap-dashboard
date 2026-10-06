/**
 * READ-ONLY. For every ended Stripe subscription (canceled/unpaid/incomplete_expired) it finds the bound production Clerk user, pulls the
 * subscription's 30-day Stripe event history (incl. pending_webhooks = undelivered/failed deliveries) and classifies why access is stale.
 *   STRIPE_SECRET_KEY=rk_live_… CLERK_SECRET_KEY=sk_live_… npx vite-node scripts/forensics/trace-cancellations.ts [--subs sub_a,sub_b] [--out cancel-trace.json]
 * Needs a Stripe key that can read events (restricted keys need "Events: Read"). Emails never printed. No write path.
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { writeFileSync } from 'node:fs';
import { readOnly } from '../readonly-guard';
import { assertProductionInstances } from '../instance-guard';
import { tierForSubscription } from '../../lib/provisioning';
import { classifyCancel } from './stale-cancel-classify';

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const iso = (t?: number | null) => (t ? new Date(t * 1000).toISOString() : null);
const EVENT_TYPES = ['customer.subscription.deleted', 'customer.subscription.updated', 'customer.subscription.created', 'invoice.payment_succeeded', 'invoice.paid', 'invoice.payment_failed', 'checkout.session.completed'];

async function main() {
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  if (!sk || !ck) { console.error('Set STRIPE_SECRET_KEY and CLERK_SECRET_KEY'); process.exit(2); }
  let inst; try { inst = assertProductionInstances(sk, ck); } catch (e: any) { console.error(e.message); process.exit(2); }
  console.log(inst.banner);
  const stripe: any = readOnly('stripe', new Stripe(sk, { apiVersion: '2023-10-16' as any }));
  const clerk: any = readOnly('clerk', createClerkClient({ secretKey: ck }));
  const now = Math.floor(Date.now() / 1000);

  const only = (arg('--subs') || '').split(',').filter(Boolean);
  const subs: any[] = [];
  for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) if (['canceled', 'unpaid', 'incomplete_expired'].includes(s.status) && (!only.length || only.includes(s.id))) subs.push(s);
  const users: any[] = [];
  for (let o = 0; ; o += 500) { const p: any = await clerk.users.getUserList({ limit: 500, offset: o }); const r = Array.isArray(p) ? p : p.data; users.push(...r); if (r.length < 500) break; }
  const byId = new Map(users.map(u => [u.id, u]));
  const entitledSubIds = new Set<string>(); for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) if (['active', 'trialing', 'past_due'].includes(s.status)) entitledSubIds.add(s.id);

  // 30-day event index keyed by subscription id.
  const bySub = new Map<string, any[]>(); let eventReadError: string | null = null;
  try {
    for (const type of EVENT_TYPES) for await (const ev of stripe.events.list({ type, limit: 100 })) {
      const o = ev.data?.object; const sid = o?.object === 'subscription' ? o.id : (o?.subscription as string | undefined);
      if (!sid) continue;
      (bySub.get(sid) || bySub.set(sid, []).get(sid)!).push({ id: ev.id, type: ev.type, created: ev.created, pending_webhooks: ev.pending_webhooks, api_version: ev.api_version ?? null, object_status: o?.status ?? null });
    }
  } catch (e: any) { eventReadError = String(e?.message || e).slice(0, 200); console.error('WARN: could not read Stripe events (' + eventReadError + '). Classification will say EVENTS_EXPIRED/NO_DELETE_EVENT; widen the key.'); }

  const results: any[] = [];
  for (const s of subs) {
    const bound = users.find(u => u.publicMetadata?.stripe_subscription_id === s.id) || byId.get(s.metadata?.clerk_user_id) || null;
    const pm = bound?.publicMetadata || {};
    const finding = classifyCancel({
      sub: { id: s.id, status: s.status, tier: tierForSubscription(s), ended_at: s.ended_at ?? null, canceled_at: s.canceled_at ?? null, metadata_clerk_user_id: s.metadata?.clerk_user_id ?? null, cancellation_reason: s.cancellation_details?.reason ?? null },
      events: bySub.get(s.id) || [],
      clerk: bound ? { id: bound.id, tier: pm.tier ?? null, billing: pm.billing_status ?? null, bound_sub: pm.stripe_subscription_id ?? null, sub_status: pm.stripe_subscription_status ?? null, event_ids: pm.stripe_event_ids || [], updated_at: bound.updatedAt ?? null, other_entitled_sub: false } : null,
      now,
    });
    results.push({ sub: s.id, tier: tierForSubscription(s), stripe_status: s.status, created: iso(s.created), canceled_at: iso(s.canceled_at), ended_at: iso(s.ended_at), reason: s.cancellation_details?.reason ?? null,
      sub_metadata_clerk_user_id: s.metadata?.clerk_user_id ?? null, clerk_user: bound ? { id: bound.id, tier: pm.tier ?? null, billing: pm.billing_status ?? null, bound_sub: pm.stripe_subscription_id ?? null, updated_at: bound.updatedAt ? new Date(bound.updatedAt).toISOString() : null, last_sign_in_at: bound.lastSignInAt ? new Date(bound.lastSignInAt).toISOString() : null } : null,
      events: (bySub.get(s.id) || []).sort((a, b) => a.created - b.created).map(x => ({ ...x, created: iso(x.created) })), finding });
  }
  writeFileSync(arg('--out') || 'cancel-trace.json', JSON.stringify({ instances: { stripe: inst.stripe, clerk: inst.clerk }, generated_at: new Date().toISOString(), event_read_error: eventReadError, results }, null, 2));
  for (const r of results) console.log(`${r.finding.stale_access ? 'STALE ' : 'ok    '} ${r.sub} ${r.stripe_status} ended=${r.ended_at} clerk=${r.clerk_user?.tier}/${r.clerk_user?.billing} → ${r.finding.cause} [${r.finding.confidence}] events=${r.events.map((e: any) => e.type.replace('customer.subscription.', 's.').replace('invoice.', 'i.') + '@' + e.created + (e.pending_webhooks ? ' PENDING' : '')).join(',') || 'none'}`);
  console.log('READ-ONLY run. No Stripe/Clerk writes possible from this tool.');
}
main().catch(e => { console.error(e); process.exit(1); });
