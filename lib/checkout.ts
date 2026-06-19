// Single source of truth for Stripe trial checkout links + funnel attribution.
// Do NOT hardcode buy.stripe.com links anywhere else — import from here.

export type Plan = 'starter' | 'pro' | 'team';

// Trial-enabled payment links ($0 due today, 14-day trial). UY04/UY05/UY06.
export const TRIAL_LINKS: Record<Plan, string> = {
  starter: 'https://buy.stripe.com/14AeVddOnbPx1g23VIdUY04',
  pro:     'https://buy.stripe.com/3cI7sLfWv2eXaQC9g2dUY05',
  team:    'https://buy.stripe.com/aFa00jeSraLtgaW4ZMdUY06',
};

const snake = (s: string) =>
  String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function yyyymmdd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// v1_dashboard_upgrade_{userId}_{county}_{plan}_{yyyymmdd}
// userId kept as-is (Clerk ids are URL-safe); county/plan normalized to snake_case.
// Returns null when there is no userId (caller then uses the static link).
export function buildClientReferenceId(
  plan: Plan, userId?: string | null, county?: string | null, now: Date = new Date(),
): string | null {
  if (!userId) return null;
  const token = `v1_dashboard_upgrade_${userId}_${snake(county ?? '') || 'na'}_${snake(plan)}_${yyyymmdd(now)}`;
  return token.slice(0, 190); // well under Stripe's client_reference_id limit (200)
}

// Build the trial URL with attribution. Falls back to the static link if no userId.
export function checkoutUrl(
  plan: Plan, opts?: { userId?: string | null; county?: string | null },
): { url: string; clientReferenceId: string | null } {
  const base = TRIAL_LINKS[plan];
  const cref = buildClientReferenceId(plan, opts?.userId, opts?.county);
  if (!cref) return { url: base, clientReferenceId: null };
  const sep = base.includes('?') ? '&' : '?';
  return { url: `${base}${sep}client_reference_id=${encodeURIComponent(cref)}`, clientReferenceId: cref };
}
