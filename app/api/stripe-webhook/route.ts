import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { clerkClient } from '@clerk/nextjs/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-04-10',
});

const PRICE_TO_TIER: Record<string, string> = {
  'price_1TMtSHIgaDPbFgUVPElPgL8V': 'starter',  // $79
  'price_1TMtStIgaDPbFgUVPFOUjBMW': 'pro',       // $149
  'price_1TMtThIgaDPbFgUVoxIWlvf3': 'team',      // $299
};

const TIER_COUNTIES: Record<string, number> = {
  starter: 1,
  pro: 5,
  team: 99,
};

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig  = req.headers.get('stripe-signature')!;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    console.error('Webhook signature failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // Handle successful payment
  if (event.type === 'checkout.session.completed' ||
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated') {

    const subscription = event.data.object as Stripe.Subscription;

    // Get price ID from subscription
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const tier    = PRICE_TO_TIER[priceId] || 'starter';
    const email   = subscription.metadata?.email ||
                    (await stripe.customers.retrieve(subscription.customer as string) as Stripe.Customer).email;

    if (!email) {
      console.error('No email found on subscription');
      return NextResponse.json({ error: 'No email' }, { status: 400 });
    }

    const clerk = await clerkClient();

    // Check if user already exists
    const existing = await clerk.users.getUserList({ emailAddress: [email] });

    if (existing.totalCount > 0) {
      // Update existing user tier
      const userId = existing.data[0].id;
      await clerk.users.updateUserMetadata(userId, {
        publicMetadata: {
          tier,
          stripe_customer_id: subscription.customer,
          stripe_subscription_id: subscription.id,
          counties_allowed: TIER_COUNTIES[tier],
          billing_status: 'active',
        },
      });
      console.log(`Updated user ${email} to tier: ${tier}`);
    } else {
      // Create new Clerk user
      const newUser = await clerk.users.createUser({
        emailAddress: [email],
        publicMetadata: {
          tier,
          stripe_customer_id: subscription.customer,
          stripe_subscription_id: subscription.id,
          counties_allowed: TIER_COUNTIES[tier],
          billing_status: 'active',
        },
      });
      console.log(`Created user ${email} with tier: ${tier}`);
    }
  }

  // Handle cancellation
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;
    const email = (await stripe.customers.retrieve(subscription.customer as string) as Stripe.Customer).email;

    if (email) {
      const clerk = await clerkClient();
      const existing = await clerk.users.getUserList({ emailAddress: [email] });
      if (existing.totalCount > 0) {
        await clerk.users.updateUserMetadata(existing.data[0].id, {
          publicMetadata: {
            tier: 'cancelled',
            billing_status: 'cancelled',
          },
        });
        console.log(`Cancelled subscription for ${email}`);
      }
    }
  }

  return NextResponse.json({ received: true });
}

// Required to disable body parsing for Stripe webhooks
export const config = {
  api: { bodyParser: false },
};
