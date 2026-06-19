'use server';

// Server-side Clerk metadata mutations. publicMetadata is server-write-only, so
// these run with the Clerk secret key on the server (never exposed to the client).
import { auth, clerkClient } from '@clerk/nextjs/server';

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
