import { redirect } from 'next/navigation';

// Single source of truth: the modern, JWT-/preview-gated dashboard lives at
// /dashboard. The root path no longer renders the legacy dashboard — it redirects
// so there is exactly one dashboard implementation in the app. (Public marketing /
// landing is served by the separate permitmap.org site, not this route.)
//
// Flow: anonymous visitors to / are sent to /dashboard, which middleware protects
// → Clerk sign-in (with redirect_url=/dashboard) → back to /dashboard after login.
// This also fixes the post-login landing regardless of Clerk's afterSignInUrl,
// since anyone returned to "/" is forwarded on to /dashboard.
//
// The previous legacy dashboard implementation remains recoverable in git history.
export default function Home() {
  redirect('/dashboard');
}
