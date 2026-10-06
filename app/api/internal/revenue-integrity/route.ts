// Authenticated, READ-ONLY revenue-integrity monitor. Polled by permit-bot (scripts/revenue_integrity_watch.py).
//
// Contract (see lib/revenue-integrity.ts):
//   GREEN       200  reconciliation completed, no actionable defects
//   RED         200  reconciliation completed, >=1 actionable defect (sanitized findings + fingerprint in body)
//   UNAVAILABLE 503  truth could not be established (instance mismatch, Stripe/Clerk failure). NOT a billing finding.
//   401 bad/missing bearer token, 503 {status:'UNAVAILABLE', reason:'not_configured'} when REVENUE_INTEGRITY_TOKEN is unset/weak.
// A caller must read body.status; HTTP 200 alone is never evidence of health.
//
// Safety: bearer token only (never query string), timing-safe compare, fails closed; production instances enforced
// (live Stripe + production Clerk) BEFORE any upstream call; both SDK clients wrapped read-only; no emails/names are
// ever read into the response; failure reasons are fixed codes, never raw SDK messages.
import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { clerkClient } from '@clerk/nextjs/server';
import { readOnly } from '../../../../scripts/readonly-guard';
import { assertProductionInstances } from '../../../../scripts/instance-guard';
import { buildIntegrityReport, safeReason, EXPECTED_API_VERSION, type IntegrityInputs } from '../../../../lib/revenue-integrity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const MIN_TOKEN_LENGTH = 32;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: HEADERS });
const digest = (s: string) => createHash('sha256').update(s).digest();

function authorized(req: NextRequest, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(token)); // equal-length digests: no length oracle
}

export async function GET(req: NextRequest) {
  const token = process.env.REVENUE_INTEGRITY_TOKEN || '';
  if (token.length < MIN_TOKEN_LENGTH) return json({ schema: 1, status: 'UNAVAILABLE', reason: 'not_configured' }, 503);
  if (!authorized(req, token)) return json({ error: 'unauthorized' }, 401);

  const now = new Date();
  const sk = process.env.STRIPE_SECRET_KEY || '', ck = process.env.CLERK_SECRET_KEY || '';
  let instances: { stripe: string; clerk: string };
  try {
    const inst = assertProductionInstances(sk, ck, []); // no --allow-dev-clerk escape on a network route
    instances = { stripe: inst.stripe, clerk: inst.clerk };
  } catch {
    const report = buildIntegrityReport({ now, instances: null, reconciliation: { ok: false, reason: 'instance_mismatch' }, webhook: { ok: false, reason: 'instance_mismatch' } });
    return json(report, 503);
  }

  const stripe: any = readOnly('stripe', new Stripe(sk, { apiVersion: EXPECTED_API_VERSION as any, maxNetworkRetries: 1 }));

  let webhook: IntegrityInputs['webhook'];
  try {
    const endpoints: any[] = [];
    for await (const e of stripe.webhookEndpoints.list({ limit: 100 })) endpoints.push(e);
    webhook = { ok: true, endpoints };
  } catch (e) { webhook = { ok: false, reason: safeReason('stripe_webhook_endpoints', e) }; }

  let reconciliation: IntegrityInputs['reconciliation'];
  try {
    const subs: any[] = [];
    for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) subs.push(s);
    const clerk: any = readOnly('clerk', await clerkClient());
    const users: any[] = [];
    for (let offset = 0; ; offset += 500) {
      const page: any = await clerk.users.getUserList({ limit: 500, offset });
      const rows = Array.isArray(page) ? page : page.data;
      users.push(...rows); if (rows.length < 500) break;
    }
    reconciliation = { ok: true, subs, users };
  } catch (e) { reconciliation = { ok: false, reason: safeReason('reconciliation_fetch', e) }; }

  const report = buildIntegrityReport({ now, instances, reconciliation, webhook });
  return json(report, report.status === 'UNAVAILABLE' ? 503 : 200);
}
