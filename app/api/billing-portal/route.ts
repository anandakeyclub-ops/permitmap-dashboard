import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { auth, clerkClient } from '@clerk/nextjs/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.permitmap.org';

export async function POST(_req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'authentication required' }, { status: 401 });

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const customer = user.publicMetadata?.stripe_customer_id as string | undefined;
  if (!customer) return NextResponse.json({ error: 'billing account not found' }, { status: 404 });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: `${APP_URL}/dashboard`,
    });
    return NextResponse.json({ url: session.url });
  } catch (error: any) {
    console.error('[BILLING_PORTAL_ALERT] create failed', { userId, message: error?.message });
    return NextResponse.json({ error: 'billing portal temporarily unavailable' }, { status: 503 });
  }
}
