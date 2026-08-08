'use server';

// Server-side Clerk metadata mutations. publicMetadata is server-write-only, so
// these run with the Clerk secret key on the server (never exposed to the client).
import { auth, clerkClient } from '@clerk/nextjs/server';
import {
  PAID_TIERS, validateSelectedCounties, validateSelectedTrades, evaluateOnboarding,
} from '../lib/onboarding';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

export interface SaveOnboardingResult { ok: boolean; complete: boolean; errors: string[] }

/**
 * P4 Onboarding Completion Contract — persist a paying customer's EXPLICIT county + trade
 * selections and (re)compute onboarding_complete. This is the ONLY place a customer's
 * selected_counties are written outside the Stripe webhook, and it enforces the tier limit
 * SERVER-SIDE (client validation is never sufficient). It writes only the keys it owns
 * (allowed_counties, selected_trades, onboarding_complete) — never clobbering tier/billing_status.
 */
export async function saveOnboardingSelections(input: { counties: string[]; trades: string[] }): Promise<SaveOnboardingResult> {
  const { userId, getToken } = await auth();
  if (!userId) return { ok: false, complete: false, errors: ['unauthenticated'] };
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const tier = (user.publicMetadata?.tier as string) || 'preview';
  if (!PAID_TIERS.has(tier)) return { ok: false, complete: false, errors: ['not_a_paid_plan'] };

  // Authoritative supported-county list from the API (server-side — the client cannot be trusted
  // to send a valid taxonomy). Best-effort: if it can't load, county membership is not enforced
  // here but the tier LIMIT + non-empty checks still apply.
  let supported: string[] = [];
  try {
    const token = await getToken();
    const res = await fetch(`${API_URL}/counties`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json();
    supported = (data?.counties || []).map((c: any) => c.key).filter(Boolean);
  } catch { /* leave supported empty → membership check skipped, limit/count still enforced */ }

  const cv = validateSelectedCounties(input.counties, tier, supported);
  const tv = validateSelectedTrades(input.trades);
  const errors = [...cv.errors, ...tv.errors];
  if (errors.length) return { ok: false, complete: false, errors };

  const email = user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || null;
  const result = evaluateOnboarding(
    { tier, allowed_counties: cv.cleaned, selected_trades: tv.cleaned, email }, supported);
  await client.users.updateUserMetadata(userId, {
    publicMetadata: { allowed_counties: cv.cleaned, selected_trades: tv.cleaned, onboarding_complete: result.complete },
  });
  return { ok: true, complete: result.complete, errors: [] };
}

/**
 * Promote the signup county into publicMetadata (PART A).
 *
 * The marketing funnel lands users at /sign-up?county=<slug>; the <SignUp>
 * component stores that as unsafeMetadata.county (client-settable). On first
 * authenticated load we promote it to publicMetadata.county (trusted, server-
 * only) so the dashboard can auto-select it. Returns the county slug or null.
 */
export async function promoteSignupCounty(): Promise<string | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const client = await clerkClient();
  const user = await client.users.getUser(userId);

  const pub = (user.publicMetadata?.county as string) || '';
  if (pub) return pub; // already promoted (returning user)

  const unsafe = (user.unsafeMetadata?.county as string) || '';
  if (!unsafe) return null; // nothing to promote

  await client.users.updateUserMetadata(userId, { publicMetadata: { county: unsafe } });
  return unsafe;
}

/** Mark onboarding as seen (PART C) — sets publicMetadata.firstLogin = false. */
export async function dismissFirstLogin(): Promise<void> {
  const { userId } = await auth();
  if (!userId) return;
  const client = await clerkClient();
  await client.users.updateUserMetadata(userId, { publicMetadata: { firstLogin: false } });
}
