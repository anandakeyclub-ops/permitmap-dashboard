import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { handleCheckout } from '../../../lib/checkout-session';

// Server-side subscription checkout. Requires an authenticated Clerk user and binds the
// Clerk user id into the Checkout Session so provisioning can never lose the identity.
// No anonymous buy.stripe.com Payment Links for subscriptions.

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.permitmap.org';

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  const { plan } = await req.json().catch(() => ({} as { plan?: string }));

  let email: string | null = null;
  let existingCustomer: string | undefined;
  if (userId) {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    email = user.primaryEmailAddress?.emailAddress || user.emailAddresses[0]?.emailAddress || null;
    existingCustomer = (user.publicMetadata?.stripe_customer_id as string) || undefined;
  }

  const { status, body } = await handleCheckout({
    userId, email, plan, existingCustomer, appUrl: APP_URL, stripe,
  });
  return NextResponse.json(body, { status });
}
