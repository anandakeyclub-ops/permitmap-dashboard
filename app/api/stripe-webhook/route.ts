import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { clerkClient } from '@clerk/nextjs/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16',
});

const PRICE_TO_TIER: Record<string, string> = {
  'price_1TMtSHIgaDPbFgUVPElPgL8V': 'starter',
  'price_1TMtStIgaDPbFgUVPFOUjBMW': 'pro',
  'price_1TMtThIgaDPbFgUVoxIWlvf3': 'team',
};

const TIER_COUNTIES: Record<string, number> = {
  starter: 1, pro: 5, team: 99,
};

async function getEmailFromCustomer(customerId: string): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    return (customer as Stripe.Customer).email;
  } catch {
    return null;
  }
}

async function upsertClerkUser(email: string, tier: string, customerId: string, subscriptionId: string) {
  const clerk = await clerkClient();
  const metadata = {
    tier,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    counties_allowed: TIER_COUNTIES[tier] || 1,
    billing_status: 'active',
  };

  const existing = await clerk.users.getUserList({ emailAddress: [email] });
  if (existing.totalCount > 0) {
    await clerk.users.updateUserMetadata(existing.data[0].id, { publicMetadata: metadata });
    console.log(`Updated Clerk user ${email} → tier: ${tier}`);
  } else {
    await clerk.users.createUser({ emailAddress: [email], publicMetadata: metadata });
    console.log(`Created Clerk user ${email} → tier: ${tier}`);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig  = req.headers.get('stripe-signature')!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    console.error('Webhook signature failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  console.log(`Webhook received: ${event.type}`);

  try {
    // Handle checkout session completed (payment link flow)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const email   = session.customer_email || session.customer_details?.email;
      const subId   = session.subscription as string;
      const custId  = session.customer as string;

      if (email && subId) {
        const sub   = await stripe.subscriptions.retrieve(subId);
        const price = sub.items.data[0]?.price?.id;
        const tier  = PRICE_TO_TIER[price] || 'starter';
        await upsertClerkUser(email, tier, custId, subId);
      }
    }

    // Handle subscription created/updated
    if (event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated') {
      const sub    = event.data.object as Stripe.Subscription;
      const price  = sub.items.data[0]?.price?.id;
      const tier   = PRICE_TO_TIER[price] || 'starter';
      const custId = sub.customer as string;
      const email  = await getEmailFromCustomer(custId);

      if (email) {
        await upsertClerkUser(email, tier, custId, sub.id);
      } else {
        console.error(`No email found for customer ${custId}`);
      }
    }

    // Handle cancellation
    if (event.type === 'customer.subscription.deleted') {
      const sub    = event.data.object as Stripe.Subscription;
      const custId = sub.customer as string;
      const email  = await getEmailFromCustomer(custId);

      if (email) {
        const clerk    = await clerkClient();
        const existing = await clerk.users.getUserList({ emailAddress: [email] });
        if (existing.totalCount > 0) {
          await clerk.users.updateUserMetadata(existing.data[0].id, {
            publicMetadata: { tier: 'cancelled', billing_status: 'cancelled' },
          });
          console.log(`Cancelled subscription for ${email}`);
        }
      }
    }
  } catch (err: any) {
    console.error('Webhook processing error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
