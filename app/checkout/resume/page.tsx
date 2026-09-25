'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';
import { startCheckout } from '../../../lib/start-checkout';
import { track } from '../../../lib/analytics';
import { checkoutOutcomeEvent } from '../../../lib/funnel-events';
import {
  readIntent, buildAuthUrl, DASHBOARD_PATH,
} from '../../../lib/checkout-intent';

// Observability-only: emit the canonical checkout-funnel event for a startCheckout outcome
// (stripe_checkout_created on success, checkout_creation_failed on failure) IN ADDITION to the
// existing stripe_checkout_started / checkout_resume_failed. Best-effort; never alters flow.
function emitOutcome(
  getToken: ReturnType<typeof useAuth>['getToken'],
  action: 'checkout' | 'signin' | 'active_subscription' | 'error',
  plan: string,
  source: string,
) {
  const d = checkoutOutcomeEvent(action);
  if (d) track(getToken, d.event, { plan, source, properties: d.reason ? { reason: d.reason } : undefined });
}

// Controlled post-auth route that resumes a paid-plan checkout exactly once.
//
// Guarantees:
//  - runs only for an authenticated Clerk user (else bounce to sign-in, intent preserved);
//  - validates the plan (invalid/absent → /dashboard, never a silent Starter/Preview
//    downgrade of a paid intent — a missing plan means there was no paid intent);
//  - POSTs /api/checkout AT MOST ONCE per intent (in-flight ref guards Strict Mode /
//    double render; the server's deterministic idempotency key covers refresh /
//    back-forward / double submit by reusing the same Checkout Session);
//  - redirects to the Stripe-hosted Checkout URL on success;
//  - on failure shows a real error with retry and logs checkout_resume_failed — it never
//    dumps the visitor silently into the dashboard.
function ResumeCheckout() {
  const { isLoaded, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();
  const sp = useSearchParams();
  const inFlight = useRef(false);
  const [status, setStatus] = useState<'working' | 'error'>('working');

  useEffect(() => {
    if (!isLoaded || inFlight.current) return;
    const { plan, params } = readIntent(sp);

    // Not authenticated → send to sign-in, preserving the full intent so checkout resumes
    // after login. (Middleware also protects this route; this is a graceful fallback.)
    if (!isSignedIn) {
      inFlight.current = true;
      router.replace(plan ? buildAuthUrl('/sign-in', plan, params) : '/sign-in');
      return;
    }

    // No valid paid plan → this was not a paid intent; go to the Preview dashboard.
    if (!plan) {
      inFlight.current = true;
      router.replace(DASHBOARD_PATH);
      return;
    }

    inFlight.current = true;
    setStatus('working');
    // Real resume boundary: Clerk has definitively authenticated this paid-intent visitor.
    // This is the durable post-auth truth signal; unlike signup_completed it cannot be lost merely
    // because Clerk redirects away from /sign-up before that component observes the auth transition.
    track(getToken, 'checkout_resume_started', { plan, source: 'checkout_resume' });
    startCheckout(plan, { attribution: params, currentPath: '/checkout/resume' })
      .then((res) => {
        emitOutcome(getToken, res.action, plan, 'checkout_resume');   // stripe_checkout_created | checkout_creation_failed
        if (res.action === 'checkout') {
          track(getToken, 'stripe_checkout_started', { plan, source: 'checkout_resume' });
          // startCheckout has already navigated to the Stripe-hosted Checkout URL.
          return;
        }
        if (res.action === 'signin') {
          // 401 despite an apparent session — let startCheckout's sign-in redirect stand.
          return;
        }
        throw new Error('checkout did not return a url');
      })
      .catch(() => {
        track(getToken, 'checkout_resume_failed', { plan, source: 'checkout_resume' });
        inFlight.current = false; // allow retry
        setStatus('error');
      });
  }, [isLoaded, isSignedIn, sp, getToken, router]);

  const retry = () => {
    inFlight.current = false;
    setStatus('working');
    // Re-run the effect logic by forcing a fresh attempt.
    const { plan, params } = readIntent(sp);
    if (!plan) { router.replace(DASHBOARD_PATH); return; }
    inFlight.current = true;
    track(getToken, 'checkout_resume_started', { plan, source: 'checkout_resume_retry' });
    startCheckout(plan, { attribution: params, currentPath: '/checkout/resume' })
      .then((res) => {
        emitOutcome(getToken, res.action, plan, 'checkout_resume_retry');
        if (res.action === 'checkout') { track(getToken, 'stripe_checkout_started', { plan, source: 'checkout_resume_retry' }); return; }
        if (res.action === 'signin') return;
        throw new Error('checkout did not return a url');
      })
      .catch(() => {
        track(getToken, 'checkout_resume_failed', { plan, source: 'checkout_resume_retry' });
        inFlight.current = false;
        setStatus('error');
      });
  };

  return (
    <div style={{
      minHeight: '100vh', background: '#0a0f1e', color: '#e2e8f0',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'DM Sans', sans-serif", padding: 24,
    }}>
      {status === 'working' ? (
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: 40, height: 40, margin: '0 auto 16px',
            border: '3px solid #1e293b', borderTop: '3px solid #3b82f6',
            borderRadius: '50%', animation: 'spin 1s linear infinite',
          }} />
          <p style={{ color: '#94a3b8', fontSize: 14 }}>Taking you to secure checkout…</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : (
        <div style={{
          textAlign: 'center', maxWidth: 420, background: '#111827',
          border: '1px solid #1e293b', borderRadius: 12, padding: '32px 28px',
        }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>
            We couldn&apos;t start checkout
          </h2>
          <p style={{ margin: '0 0 20px', fontSize: 14, color: '#94a3b8', lineHeight: 1.6 }}>
            Something went wrong reaching Stripe. Your account is safe and no charge was made.
            You can try again.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button onClick={retry} style={{
              background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700,
              padding: '10px 22px', borderRadius: 8, border: 'none', cursor: 'pointer',
            }}>Try again</button>
            <a href="/pricing" style={{
              background: 'transparent', color: '#93c5fd', fontSize: 13, fontWeight: 600,
              padding: '10px 18px', borderRadius: 8, textDecoration: 'none',
              border: '1px solid #2563eb60',
            }}>Back to pricing</a>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CheckoutResumePage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#0a0f1e' }} />}>
      <ResumeCheckout />
    </Suspense>
  );
}
