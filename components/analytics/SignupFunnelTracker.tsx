'use client';

// Observability-only. Renders nothing; emits two signup-funnel events at real transitions:
//   • signup_page_view  — once, when the /sign-up page mounts (the page was genuinely reached).
//   • signup_completed  — once, when Clerk auth transitions signed-OUT → signed-IN on this page
//                         (a real account/auth completion here — NOT a mere Sign-Up button click,
//                         and NOT an already-authenticated visitor who just navigated in).
//
// It never blocks or alters the Clerk <SignUp> flow (analytics is best-effort). No PII is sent:
// track() posts only funnel context; the API derives identity from the Clerk JWT (and accepts the
// pre-auth signup_page_view anonymously with NULL identity).

import { useEffect, useRef } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { track } from '../../lib/analytics';
import { shouldFireSignupCompleted } from '../../lib/funnel-events';

export default function SignupFunnelTracker({ plan, source }: { plan?: string; source?: string }) {
  const { isLoaded, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const viewFired = useRef(false);
  const completedFired = useRef(false);
  const prevSignedIn = useRef<boolean | null>(null);

  // signup_page_view — exactly once per mount (StrictMode double-invoke guarded by the ref).
  useEffect(() => {
    if (viewFired.current) return;
    viewFired.current = true;
    // Pre-auth: getToken returns null; the API accepts signup_page_view anonymously.
    track(getToken, 'signup_page_view', { plan, source });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // signup_completed — only on a signed-OUT → signed-IN transition observed here.
  useEffect(() => {
    if (!isLoaded) return;
    const prev = prevSignedIn.current;
    if (prev !== null && !completedFired.current && shouldFireSignupCompleted(prev, !!isSignedIn)) {
      completedFired.current = true;
      track(getToken, 'signup_completed', { plan, source });
    }
    prevSignedIn.current = !!isSignedIn;
  }, [isLoaded, isSignedIn, getToken, plan, source]);

  return null;
}
