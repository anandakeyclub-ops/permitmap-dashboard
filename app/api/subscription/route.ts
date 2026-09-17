import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { PRICE_TO_TIER } from '../../../lib/provisioning';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const subId = user.publicMetadata?.stripe_subscription_id as string | undefined;
  const expectedCustomer = user.publicMetadata?.stripe_customer_id as string | undefined;
  if (!subId) return NextResponse.json({ error: 'subscription not found' }, { status: 404 });

  try {
    const sub = await stripe.subscriptions.retrieve(subId);
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    if (expectedCustomer && customerId !== expectedCustomer) {
      console.error('[SUBSCRIPTION_ALERT] customer binding mismatch', { userId, subId });
      return NextResponse.json({ error: 'subscription binding mismatch' }, { status: 409 });
    }
    const price = sub.items.data[0]?.price;
    const priceId = price?.id || '';
    return NextResponse.json({
      status: sub.status,
      plan: PRICE_TO_TIER[priceId] || String(sub.metadata?.plan || user.publicMetadata?.tier || 'plan'),
      amount: price?.unit_amount ?? null,
      currency: price?.currency || sub.currency || 'usd',
      trial_end: sub.trial_end,
      current_period_end: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end,
    });
  } catch (error: any) {
    console.error('[SUBSCRIPTION_ALERT] read failed', { userId, subId, message: error?.message });
    return NextResponse.json({ error: 'subscription temporarily unavailable' }, { status: 503 });
  }
}
