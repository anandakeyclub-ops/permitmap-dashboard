// PURE classifier for a live Stripe subscription that no production Clerk user claims. Evidence in, classification out.
// Never proposes a write; it names what is proven, what is only correlated, and what to check next.
export interface OrphanEvidence {
  sub: { id: string; status: string; created: number; trial_end: number | null; cancel_at_period_end: boolean; cancel_at: number | null; customer: string; clerk_user_id: string | null; tier: string | null };
  customer: { id: string; created: number; email: string | null; clerk_user_id: string | null };
  sessions: { id: string; created: number; client_reference_id: string | null; meta_clerk_user_id: string | null; email: string | null }[];
  prodUsers: { id: string; created_at: number; emails: string[]; tier: string | null; billing: string | null; bound_sub: string | null; bound_customer: string | null }[];
  otherCustomersSameEmail: string[];
  otherSubsOnCustomer: { id: string; status: string }[];
}
export type OrphanClass =
  | 'IDENTIFIED_PROD_USER_UNBOUND'      // an id carried by Stripe (sub/customer/checkout) IS an existing prod user that simply lacks the binding
  | 'IDENTIFIED_PROD_USER_BOUND_ELSEWHERE' // same, but that user is bound to a different subscription (duplicate/replacement)
  | 'EMAIL_ONLY_SINGLE_PROD_MATCH'       // no id match; exactly one prod user shares the email (correlation, not proof)
  | 'EMAIL_AMBIGUOUS'                    // several prod users share the email
  | 'NO_PRODUCTION_ACCOUNT';             // ids point at no prod user and no email match: likely an un-migrated dev user or a checkout without a surviving account
export interface OrphanFinding {
  classification: OrphanClass; strength: 'PROVEN_BY_ID' | 'CORRELATED_BY_EMAIL' | 'NONE';
  candidate_prod_user_id: string | null; id_evidence: { source: string; value: string }[]; notes: string[]; next_steps: string[];
}

export function classifyOrphan(e: OrphanEvidence): OrphanFinding {
  const norm = (s: string | null) => (s || '').trim().toLowerCase();
  const byId = new Map(e.prodUsers.map(u => [u.id, u]));
  const carried: { source: string; value: string }[] = [];
  if (e.sub.clerk_user_id) carried.push({ source: 'subscription.metadata.clerk_user_id', value: e.sub.clerk_user_id });
  if (e.customer.clerk_user_id) carried.push({ source: 'customer.metadata.clerk_user_id', value: e.customer.clerk_user_id });
  for (const s of e.sessions) {
    if (s.client_reference_id) carried.push({ source: `checkout ${s.id} client_reference_id`, value: s.client_reference_id });
    if (s.meta_clerk_user_id) carried.push({ source: `checkout ${s.id} metadata.clerk_user_id`, value: s.meta_clerk_user_id });
  }
  const hits = carried.filter(c => byId.has(c.value));
  const hitIds = [...new Set(hits.map(h => h.value))];
  const notes: string[] = [];
  if (e.sub.cancel_at_period_end) notes.push('scheduled to cancel at period end');
  if (e.sub.status === 'trialing' && e.sub.trial_end) notes.push(`trialing until ${new Date(e.sub.trial_end * 1000).toISOString()}`);
  if (e.otherCustomersSameEmail.length) notes.push(`${e.otherCustomersSameEmail.length} other Stripe customer(s) share this email: ${e.otherCustomersSameEmail.join(', ')}`);
  if (e.otherSubsOnCustomer.length) notes.push(`customer also has: ${e.otherSubsOnCustomer.map(s => `${s.id}:${s.status}`).join(', ')}`);

  if (hitIds.length === 1) {
    const u = byId.get(hitIds[0])!;
    if (u.bound_sub && u.bound_sub !== e.sub.id) {
      notes.push(`prod user is bound to ${u.bound_sub}, not ${e.sub.id}`);
      return { classification: 'IDENTIFIED_PROD_USER_BOUND_ELSEWHERE', strength: 'PROVEN_BY_ID', candidate_prod_user_id: u.id, id_evidence: hits, notes,
        next_steps: ['Compare the two subscriptions (customer, created, status); decide which is the intended binding; do NOT overwrite automatically.'] };
    }
    return { classification: 'IDENTIFIED_PROD_USER_UNBOUND', strength: 'PROVEN_BY_ID', candidate_prod_user_id: u.id, id_evidence: hits, notes,
      next_steps: ['Binding is missing on an identified account: re-derive entitlement from Stripe truth for this user (provisioning path), not a manual metadata edit.'] };
  }
  if (hitIds.length > 1) {
    notes.push(`carried ids resolve to ${hitIds.length} different prod users`);
    return { classification: 'EMAIL_AMBIGUOUS', strength: 'NONE', candidate_prod_user_id: null, id_evidence: hits, notes, next_steps: ['Manual review: Stripe artefacts disagree about the owner.'] };
  }
  const em = norm(e.customer.email) || norm(e.sessions.find(s => s.email)?.email ?? null);
  const emailHits = em ? e.prodUsers.filter(u => u.emails.map(norm).includes(em)) : [];
  if (emailHits.length === 1) {
    notes.push('no Stripe-carried id resolves to a production user; email is the only link');
    return { classification: 'EMAIL_ONLY_SINGLE_PROD_MATCH', strength: 'CORRELATED_BY_EMAIL', candidate_prod_user_id: emailHits[0].id, id_evidence: carried, notes,
      next_steps: ['Email correlation is not proof of ownership; confirm with the customer/checkout provenance before any binding.', 'Check whether carried id is an un-migrated dev user (dev export, read-only).'] };
  }
  if (emailHits.length > 1) return { classification: 'EMAIL_AMBIGUOUS', strength: 'NONE', candidate_prod_user_id: null, id_evidence: carried, notes: [...notes, `${emailHits.length} prod users share the email`], next_steps: ['Manual review.'] };
  return { classification: 'NO_PRODUCTION_ACCOUNT', strength: 'NONE', candidate_prod_user_id: null, id_evidence: carried, notes,
    next_steps: ['Look up the carried id in the Clerk DEV instance (read-only export-dev-users.mjs): an un-migrated dev user would explain this.', 'If none exists, this is a paying/trialing customer with no account: contact path + entitlement plan needed (product decision).'] };
}
