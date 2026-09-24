import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { clerkClient } from '@clerk/nextjs/server';
import { handleWebhook } from '../../../lib/provisioning';
import { wrapClerkWithRateLimitRetry, wrapStripeWithIdempotentMapping } from '../../../lib/webhook-clients';
import { sendGa4ServerEvent } from '../../../lib/ga4-server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

// First-party funnel emit (best-effort; must never fail the webhook).
async function emitEvent(event_name: string, props: Record<string, any>) {
  const key = process.env.ANALYTICS_INGEST_KEY;
  if (!key) {
    console.warn('ANALYTICS_INGEST_KEY unset — skipping first-party analytics emit');
  } else {
    try {
      await fetch(`${API_BASE}/analytics/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Analytics-Key': key },
        body: JSON.stringify({ event_name, ...props }),
      });
    } catch (e) { console.error('analytics emit failed:', e); }
  }

  // GA4 receives only verified, server-originated commercial outcomes. Keep the payload
  // PII-free and use stable Stripe object IDs for deduplication/client identity.
  try {
    if (event_name === 'trial_started' && props.stripe_session_id) {
      await sendGa4ServerEvent({
        name: 'trial_started',
        clientId: `stripe.${props.stripe_session_id}`,
        params: { transaction_id: props.stripe_session_id, plan: props.plan },
      });
    } else if (event_name === 'paid_subscription_started' && props.properties?.invoice_id) {
      const amount = Number(props.properties.amount_paid || 0);
      await sendGa4ServerEvent({
        name: 'purchase',
        clientId: `stripe.${props.stripe_subscription_id || props.properties.invoice_id}`,
        params: {
          transaction_id: props.properties.invoice_id,
          value: amount / 100,
          currency: 'USD',
          plan: props.plan,
        },
      });
    }
  } catch (e) { console.error('GA4 server conversion emit failed:', e); }
}

// Loud, unmissable diagnostic. The AUTHORITATIVE exactly-once owner alert is the nightly
// Revenue Integrity sweep (permit_bot); this is the immediate breadcrumb.
function alertProvisioning(kind: string, detail: Record<string, any>) {
  console.error(`[PROVISIONING_ALERT] ${kind} ${JSON.stringify(detail)}`);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') || '';
  const clerk = wrapClerkWithRateLimitRetry(await clerkClient());
  const safeStripe = wrapStripeWithIdempotentMapping(stripe);
  const { status, body: resBody } = await handleWebhook({
    stripe: safeStripe as any,
    clerk: clerk as any,
    body,
    sig,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
    emit: emitEvent,
    alert: alertProvisioning,
  });
  return NextResponse.json(resBody, { status });
}
