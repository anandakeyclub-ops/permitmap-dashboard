// PURE classifier: why does a production Clerk user still hold paid access although the bound Stripe subscription ended?
// Evidence in (Stripe sub + 30-day event history + Clerk metadata), a ranked cause out. Never proposes a write.
export interface CancelEvidence {
  sub: { id: string; status: string; tier: string | null; ended_at: number | null; canceled_at: number | null; metadata_clerk_user_id: string | null; cancellation_reason: string | null };
  events: { id: string; type: string; created: number; pending_webhooks: number; api_version: string | null; object_status: string | null }[]; // already filtered to this subscription
  clerk: null | { id: string; tier: string | null; billing: string | null; bound_sub: string | null; sub_status: string | null; event_ids: string[]; updated_at: number | null; other_entitled_sub: boolean };
  now: number; retentionDays?: number;
}
export type CancelCause =
  | 'ALREADY_REVOKED'                 // Clerk correctly shows cancelled
  | 'CLERK_USER_MISSING'              // lifecycle debris: Stripe ended, no such Clerk user (no access issue)
  | 'NOT_BOUND_TO_THIS_SUB'           // Clerk access derives from a different (live) subscription — not stale
  | 'IDENTITY_MISMATCH'               // Stripe metadata id differs from the Clerk user bound to this sub
  | 'DELETE_EVENT_UNDELIVERED'        // deleted event exists with pending/failed webhook deliveries
  | 'LATE_EVENT_OVERWROTE_REVOCATION' // an updated/created/invoice event created AFTER the end re-stamped paid access (pre-#121 handler)
  | 'DELETE_PROCESSED_NOT_APPLIED'    // deleted event delivered, nothing later, yet Clerk still paid
  | 'EVENTS_EXPIRED_UNDETERMINED'     // ended before the 30-day event window: cause cannot be proven
  | 'NO_DELETE_EVENT_IN_WINDOW';      // ended inside the window but no deleted event found
export interface CancelFinding { cause: CancelCause; stale_access: boolean; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; reasons: string[]; safe_repair: string }

const PAID = new Set(['starter', 'pro', 'team']);
const GRANTS = new Set(['active', 'past_due', 'paused', 'trialing']);

export function classifyCancel(e: CancelEvidence): CancelFinding {
  const reasons: string[] = []; const win = (e.retentionDays ?? 30) * 86400;
  if (!e.clerk) return { cause: 'CLERK_USER_MISSING', stale_access: false, confidence: 'HIGH', reasons: ['no Clerk user resolves for this subscription'], safe_repair: 'None for access. Classify as lifecycle debris; optionally clear Stripe metadata pointer in a separate reviewed step.' };
  const c = e.clerk;
  const paid = PAID.has(c.tier || '') && GRANTS.has(c.billing || '');
  if (!paid) return { cause: 'ALREADY_REVOKED', stale_access: false, confidence: 'HIGH', reasons: [`clerk=${c.tier}/${c.billing}`], safe_repair: 'None.' };
  if (c.bound_sub && c.bound_sub !== e.sub.id) {
    return { cause: 'NOT_BOUND_TO_THIS_SUB', stale_access: false, confidence: 'MEDIUM', reasons: [`Clerk is bound to ${c.bound_sub}, not ${e.sub.id}`], safe_repair: 'None for this subscription; verify the bound subscription separately.' };
  }
  if (e.sub.metadata_clerk_user_id && e.sub.metadata_clerk_user_id !== c.id) {
    reasons.push(`Stripe metadata points at ${e.sub.metadata_clerk_user_id}; Clerk user bound to the sub is ${c.id}`);
    return { cause: 'IDENTITY_MISMATCH', stale_access: true, confidence: 'HIGH', reasons, safe_repair: 'Resolve identity first; then replay Stripe truth for the correct user.' };
  }
  const repair = 'Replay Stripe truth (reconcileSubscription on the current Stripe state) for this user; never hand-edit tier/billing. If another subscription is entitled it will be promoted.';
  const evs = [...e.events].sort((a, b) => a.created - b.created);
  const del = evs.find(x => x.type === 'customer.subscription.deleted');
  const endTs = e.sub.ended_at ?? e.sub.canceled_at;
  if (del) {
    if (del.pending_webhooks > 0) return { cause: 'DELETE_EVENT_UNDELIVERED', stale_access: true, confidence: 'HIGH', reasons: [`${del.id} has pending_webhooks=${del.pending_webhooks}`], safe_repair: repair };
    const later = evs.filter(x => x.created > del.created && ['customer.subscription.updated', 'customer.subscription.created', 'invoice.payment_succeeded', 'invoice.paid', 'checkout.session.completed'].includes(x.type));
    if (later.length) return { cause: 'LATE_EVENT_OVERWROTE_REVOCATION', stale_access: true, confidence: 'HIGH', reasons: later.map(x => `${x.type} ${x.id} created ${new Date(x.created * 1000).toISOString()} after deleted ${new Date(del.created * 1000).toISOString()}`), safe_repair: repair };
    const seen = c.event_ids.includes(del.id);
    reasons.push(`deleted event ${del.id} delivered (pending=0)`, seen ? 'its id is in Clerk event ring (processed)' : 'its id is NOT in Clerk event ring (never applied or pre-ring handler)');
    return { cause: 'DELETE_PROCESSED_NOT_APPLIED', stale_access: true, confidence: seen ? 'LOW' : 'MEDIUM', reasons, safe_repair: repair };
  }
  if (endTs && e.now - endTs > win) return { cause: 'EVENTS_EXPIRED_UNDETERMINED', stale_access: true, confidence: 'LOW', reasons: [`ended ${new Date(endTs * 1000).toISOString()}, beyond the ${e.retentionDays ?? 30}-day event window; cause cannot be proven`], safe_repair: repair };
  return { cause: 'NO_DELETE_EVENT_IN_WINDOW', stale_access: true, confidence: 'MEDIUM', reasons: ['subscription ended inside the event window but no customer.subscription.deleted event was found'], safe_repair: repair };
}
