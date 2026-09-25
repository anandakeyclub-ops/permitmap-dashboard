import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { handleCheckout } from '../../../lib/checkout-session';
import { readIntent } from '../../../lib/checkout-intent';

// Server-side subscription checkout. Requires an authenticated Clerk user and binds the
// Clerk user id into the Checkout Session so provisioning can never lose the identity.
// No anonymous buy.stripe.com Payment Links for subscriptions.

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.permitmap.org';
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

// Server-side observability at the authoritative Clerk-authenticated checkout boundary.
// Best-effort only: analytics must never change checkout behavior or latency materially.
async function emitCheckoutBoundary(event_name: string, props: Record<string, unknown>) {
  const key = process.env.ANALYTICS_INGEST_KEY;
  if (!key) return;
  try {
    await fetch(`${API_BASE}/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Analytics-Key': key },
      body: JSON.stringify({ event_name, ...props }),
    });
  } catch { /* observability only */ }
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  const raw = await req.json().catch(() => ({} as { plan?: string; attribution?: unknown }));
  const plan: string | undefined = typeof raw.plan === 'string' ? raw.plan : undefined;
  // Re-validate/allowlist the attribution server-side; never trust the client body shape.
  const { params: attribution } = readIntent((raw.attribution ?? {}) as Record<string, unknown> as any);

  let email: string | null = null;
  let existingCustomer: string | undefined;
  let existingSubscriptionId: string | undefined;
  let billingStatus: string | undefined;
  if (userId) {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    email = user.primaryEmailAddress?.emailAddress || user.emailAddresses[0]?.emailAddress || null;
    existingCustomer = (user.publicMetadata?.stripe_customer_id as string) || undefined;
    // Duplicate-subscription guard inputs: current entitlement snapshot from Clerk publicMetadata.
    existingSubscriptionId = (user.publicMetadata?.stripe_subscription_id as string) || undefined;
    billingStatus = (user.publicMetadata?.billing_status as string) || undefined;
  }

  // Definitive server-side signal: auth() has resolved a Clerk identity and the request reached
  // the checkout boundary. Reuse checkout_resume_started so reporting remains additive and the API
  // allowlist/schema do not change. Source distinguishes this authoritative server observation.
  if (userId && plan) {
    await emitCheckoutBoundary('checkout_resume_started', {
      user_id: userId, email, plan, source: 'checkout_api_authenticated',
    });
  }

  const { status, body } = await handleCheckout({
    userId, email, plan, existingCustomer, existingSubscriptionId, billingStatus,
    appUrl: APP_URL, attribution, stripe,
  });
  return NextResponse.json(body, { status });
}
