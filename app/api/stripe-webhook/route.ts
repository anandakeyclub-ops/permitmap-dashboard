import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { clerkClient } from '@clerk/nextjs/server';
import { handleWebhook } from '../../../lib/provisioning';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2023-10-16' });
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://permitmap-api.onrender.com';

// First-party funnel emit (best-effort; must never fail the webhook).
async function emitEvent(event_name: string, props: Record<string, any>) {
  const key = process.env.ANALYTICS_INGEST_KEY;
  if (!key) { console.warn('ANALYTICS_INGEST_KEY unset — skipping analytics emit'); return; }
  try {
    await fetch(`${API_BASE}/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Analytics-Key': key },
      body: JSON.stringify({ event_name, ...props }),
    });
  } catch (e) { console.error('analytics emit failed:', e); }
}

// Loud, unmissable diagnostic. The AUTHORITATIVE exactly-once owner alert is the nightly
// Revenue Integrity sweep (permit_bot); this is the immediate breadcrumb.
function alertProvisioning(kind: string, detail: Record<string, any>) {
  console.error(`[PROVISIONING_ALERT] ${kind} ${JSON.stringify(detail)}`);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') || '';
  const clerk = await clerkClient();
  const { status, body: resBody } = await handleWebhook({
    stripe: stripe as any,
    clerk: clerk as any,
    body,
    sig,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
    emit: emitEvent,
    alert: alertProvisioning,
  });
  return NextResponse.json(resBody, { status });
}
