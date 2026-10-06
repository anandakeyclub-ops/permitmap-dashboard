// Dry-run "Stripe-truth" entitlement reconciliation that drives the REAL production code path (reconcileSubscription) against an
// in-memory OVERLAY: reads pass through to the real clients, every write is captured and applied only to the overlay.
// Output = exactly what the webhook handler would change (or fail on) if it replayed each user's subscriptions, with ZERO writes.
import { reconcileSubscription, entitlementForStatus, tierForSubscription } from '../lib/provisioning';
import { wrapStripeWithIdempotentMapping } from '../lib/webhook-clients';

const RANK: Record<string, number> = { starter: 1, pro: 2, team: 3 };
const PAID = new Set(Object.keys(RANK));
const KEYS = ['tier', 'billing_status', 'stripe_subscription_id', 'stripe_customer_id'] as const;
const INFO_KEYS = ['stripe_subscription_status'] as const; // informational field the hardened code adds; not an entitlement change
const pick = (m: Record<string, any> | undefined) => Object.fromEntries(KEYS.map(k => [k, m?.[k] ?? null]));
const pickInfo = (m: Record<string, any> | undefined) => Object.fromEntries(INFO_KEYS.map(k => [k, m?.[k] ?? null]));

export interface DryRow {
  clerk_user_id: string; before: Record<string, any>; after: Record<string, any>; changed: boolean;
  expected: { tier: string | null; billing: string | null }; converges: boolean; info_fields_would_change: boolean;
  would_error: string[]; alerts: { kind: string; detail: any }[]; planned_stripe_writes: { fn: string; id: string; params: any }[]; subs_replayed: string[];
}
export interface DryReport { rows: DryRow[]; manual_or_legacy: string[]; orphan_stripe_subs: { sub: string; status: string; metadata_clerk_user_id: string | null }[]; summary: Record<string, number> }

export function truthFor(subs: any[]): { tier: string | null; billing: string | null } {
  const entitled = subs.filter(s => entitlementForStatus(s.status, !!s.pause_collection).action === 'grant' && tierForSubscription(s));
  if (entitled.length) {
    entitled.sort((a, b) => RANK[tierForSubscription(b)!] - RANK[tierForSubscription(a)!]);
    const top = entitled[0]; return { tier: tierForSubscription(top)!, billing: (entitlementForStatus(top.status, !!top.pause_collection) as any).billingStatus };
  }
  const ended = subs.filter(s => entitlementForStatus(s.status, false).action === 'revoke').sort((a, b) => (b.created || 0) - (a.created || 0));
  return ended.length ? { tier: 'cancelled', billing: (entitlementForStatus(ended[0].status, false) as any).billingStatus } : { tier: null, billing: null };
}

export async function runDryReconcile(deps: { stripe: any; clerkUsers: { id: string; publicMetadata: Record<string, any> }[]; stripeSubs: any[]; clerkGetUserList?: (p: any) => Promise<any> }): Promise<DryReport> {
  const overlay = new Map(deps.clerkUsers.map(u => [u.id, JSON.parse(JSON.stringify(u.publicMetadata || {}))]));
  let current: { alerts: DryRow['alerts']; writes: DryRow['planned_stripe_writes'] } = { alerts: [], writes: [] };
  let fake = 0;
  const clerkDry: any = { users: {
    getUserList: deps.clerkGetUserList ?? (async () => ({ totalCount: 0, data: [] })),
    getUser: async (id: string) => { if (!overlay.has(id)) throw Object.assign(new Error('Not Found (clerk 404): user does not exist'), { status: 404 }); return { publicMetadata: JSON.parse(JSON.stringify(overlay.get(id))) }; },
    updateUserMetadata: async (id: string, p: { publicMetadata: Record<string, any> }) => {
      if (!overlay.has(id)) throw Object.assign(new Error(`Not Found (clerk 404): cannot update ${id}`), { status: 404 });
      overlay.set(id, { ...overlay.get(id), ...JSON.parse(JSON.stringify(p.publicMetadata)) }); return {};
    },
    createUser: async (_p: any) => { const id = `user_DRYRUN_${++fake}`; overlay.set(id, {}); return { id }; },
  } };
  const stripeDry = wrapStripeWithIdempotentMapping({
    webhooks: deps.stripe.webhooks,
    subscriptions: { retrieve: (id: string) => deps.stripe.subscriptions.retrieve(id), list: (p: any) => deps.stripe.subscriptions.list(p), search: (p: any) => deps.stripe.subscriptions.search(p),
      update: async (id: string, params: any) => { current.writes.push({ fn: 'subscriptions.update', id, params }); return {}; } },
    customers: { retrieve: (id: string) => deps.stripe.customers.retrieve(id), update: async (id: string, params: any) => { current.writes.push({ fn: 'customers.update', id, params }); return {}; } },
  });

  const userIds = new Set(deps.clerkUsers.map(u => u.id));
  const subsByUser = new Map<string, any[]>(); const orphan: DryReport['orphan_stripe_subs'] = [];
  const boundBy = new Map<string, string>(); for (const u of deps.clerkUsers) if (u.publicMetadata?.stripe_subscription_id) boundBy.set(u.publicMetadata.stripe_subscription_id, u.id);
  for (const s of deps.stripeSubs) {
    const uid = boundBy.get(s.id) ?? s.metadata?.clerk_user_id;
    if (uid && userIds.has(uid)) (subsByUser.get(uid) || subsByUser.set(uid, []).get(uid)!).push(s);
    else orphan.push({ sub: s.id, status: s.status, metadata_clerk_user_id: s.metadata?.clerk_user_id ?? null });
  }
  const rows: DryRow[] = []; const manual: string[] = [];
  for (const u of deps.clerkUsers) {
    const mine = (subsByUser.get(u.id) || []).sort((a, b) => (a.created || 0) - (b.created || 0));
    if (!mine.length) { if (PAID.has(u.publicMetadata?.tier) || u.publicMetadata?.stripe_subscription_id) manual.push(u.id); continue; }
    current = { alerts: [], writes: [] }; const errors: string[] = []; const before = pick(overlay.get(u.id)); const beforeInfo = pickInfo(overlay.get(u.id));
    for (const s of mine) {
      try { await reconcileSubscription(stripeDry as any, clerkDry, (kind, detail) => current.alerts.push({ kind, detail }), s, {}); }
      catch (e: any) { errors.push(`${s.id}: ${String(e?.message || e).slice(0, 160)}`); }
    }
    const after = pick(overlay.get(u.id)); const exp = truthFor(mine);
    const converges = exp.tier ? after.tier === exp.tier && after.billing_status === exp.billing : !PAID.has(String(after.tier));
    rows.push({ clerk_user_id: u.id, before, after, changed: JSON.stringify(before) !== JSON.stringify(after), expected: exp, converges, info_fields_would_change: JSON.stringify(beforeInfo) !== JSON.stringify(pickInfo(overlay.get(u.id))), would_error: errors, alerts: current.alerts, planned_stripe_writes: current.writes, subs_replayed: mine.map(s => `${s.id}:${s.status}`) });
  }
  const summary = { users_replayed: rows.length, would_change: rows.filter(r => r.changed).length, would_error: rows.filter(r => r.would_error.length).length, not_converging: rows.filter(r => !r.converges).length, manual_or_legacy: manual.length, orphan_stripe_subs: orphan.length };
  return { rows, manual_or_legacy: manual, orphan_stripe_subs: orphan, summary };
}
