import { redirect } from 'next/navigation';

// The app root canonicalizes to the Preview-gated dashboard.
//
// The previous `/` route was a legacy dashboard that fetched permit data WITHOUT the
// Clerk JWT and defaulted a no-tier user to "starter" limits — effectively granting
// free Starter-level access on sign-up (proven defect C). The authoritative experience
// is `/dashboard` (server-side preview_locked gating; Stripe success_url already targets
// it). Redirecting here closes the free-access surface without changing the Preview
// entitlement rules, which live in `/dashboard` + the API.
export default function Home() {
  redirect('/dashboard');
}
