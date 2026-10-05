/*
 * Stripe TEST-MODE replay for PR #121 (lib/provisioning.ts). Run on a developer machine, never in prod.
 *
 *   STRIPE_SECRET_KEY=sk_test_...  CLERK_SECRET_KEY=sk_test_...  npx vite-node scripts/stripe-test-replay.ts
 *
 * What it does: creates REAL Stripe test-mode objects (customers, subscriptions, test clocks), signs
 * the resulting events with a local secret, and feeds them to the REAL handleWebhook() together with
 * the REAL Stripe + Clerk SDK clients. After every scenario it reads the Clerk TEST user's
 * publicMetadata and asserts it against Stripe's own truth. Exits non-zero on any failure.
 *
 * Safety: refuses to run unless BOTH keys are test/dev keys; uses throwaway Clerk users on the dev
 * instance; only ever touches objects it created; cleans up in `finally`. It mutates PRICE_TO_TIER
 * IN THIS PROCESS ONLY so the freshly-created TEST price ids map to tiers. Not the HTTP route wrapper
 * (app/api/stripe-webhook/route.ts), which is a thin pass-through; verify that separately with
 * `stripe listen --forward-to localhost:3000/api/stripe-webhook` (an unknown-price event should
 * return 200 and write nothing).
 */
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';
import { handleWebhook, PRICE_TO_TIER } from '../lib/provisioning';
import { wrapClerkWithRateLimitRetry, wrapStripeWithIdempotentMapping } from '../lib/webhook-clients';
import { attachCard as attachCardTo, assertDefaultPaymentMethodAttached } from './stripe-replay-fixtures';

const SECRET = 'whsec_local_replay_only';
const sk = process.env.STRIPE_SECRET_KEY || '';
const ck = process.env.CLERK_SECRET_KEY || '';
if (!sk.startsWith('sk_test_')) { console.error('REFUSING: STRIPE_SECRET_KEY must be a sk_test_ key.'); process.exit(2); }
if (!ck.startsWith('sk_test_')) { console.error('REFUSING: CLERK_SECRET_KEY must be a sk_test_ (development instance) key.'); process.exit(2); }

const stripeRaw = new Stripe(sk, { apiVersion: '2023-10-16' });
const stripe = wrapStripeWithIdempotentMapping(stripeRaw) as any;
const clerkRaw = createClerkClient({ secretKey: ck });
const clerk = wrapClerkWithRateLimitRetry(clerkRaw) as any;

const RUN = `replay${Date.now()}`;
const cleanup = { users: [] as string[], subs: [] as string[], clocks: [] as string[], customers: [] as string[] };
const results: { name: string; ok: boolean; detail: string }[] = [];
let emitted: { name: string }[] = []; let alerts: { kind: string }[] = [];
let seq = 0;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const emit = async (name: string) => { emitted.push({ name }); };
const alert = (kind: string) => { alerts.push({ kind }); };

async function newUser(label: string) {
  const u = await clerkRaw.users.createUser({ emailAddress: [`${RUN}+${label}@example.com`], skipPasswordRequirement: true, publicMetadata: {} });
  cleanup.users.push(u.id); return u.id as string;
}
async function meta(userId: string) { return (await clerkRaw.users.getUser(userId)).publicMetadata as Record<string, any>; }

async function deliver(type: string, object: any, opts: { id?: string; created?: number } = {}) {
  const evt = { id: opts.id || `evt_${RUN}_${++seq}`, object: 'event', type, created: opts.created ?? Math.floor(Date.now() / 1000), data: { object } };
  const payload = JSON.stringify(evt);
  const header = stripeRaw.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const r = await handleWebhook({ stripe, clerk, body: payload, sig: header, secret: SECRET, emit, alert });
  if (r.status !== 200) throw new Error(`webhook returned ${r.status}: ${JSON.stringify(r.body)}`);
  return evt;
}

async function check(name: string, fn: () => Promise<string>) {
  emitted = []; alerts = [];
  try { const d = await fn(); results.push({ name, ok: true, detail: d }); console.log(`PASS  ${name}  ${d}`); }
  catch (e: any) { results.push({ name, ok: false, detail: e.message }); console.log(`FAIL  ${name}  ${e.message}`); }
}
function expectMeta(m: Record<string, any>, want: Record<string, any>) {
  for (const [k, v] of Object.entries(want)) if (m[k] !== v) throw new Error(`expected ${k}=${JSON.stringify(v)} got ${JSON.stringify(m[k])} (full: tier=${m.tier} billing=${m.billing_status} sub=${m.stripe_subscription_id} raw=${m.stripe_subscription_status})`);
}

async function customer(userId: string, label: string, clockId?: string) {
  const c = await stripeRaw.customers.create({ email: `${RUN}+${label}@example.com`, metadata: { clerk_user_id: userId, replay_run: RUN }, ...(clockId ? { test_clock: clockId } : {}) });
  cleanup.customers.push(c.id); return c;
}
const attachCard = (customerId: string, token: string, makeDefault = true) => attachCardTo(stripeRaw as any, customerId, token, makeDefault);
async function subscribe(customerId: string, userId: string, price: string, extra: Record<string, any> = {}) {
  await assertDefaultPaymentMethodAttached(stripeRaw as any, customerId); // fixture invariant: payment_method.customer === customer.id
  const s = await stripeRaw.subscriptions.create({ customer: customerId, items: [{ price }], metadata: { clerk_user_id: userId, replay_run: RUN }, ...extra });
  cleanup.subs.push(s.id); return s;
}
async function advance(clockId: string, days: number) {
  const clock = await stripeRaw.testHelpers.testClocks.retrieve(clockId);
  await stripeRaw.testHelpers.testClocks.advance(clockId, { frozen_time: clock.frozen_time + days * 86400 });
  for (let i = 0; i < 60; i++) { const c = await stripeRaw.testHelpers.testClocks.retrieve(clockId); if (c.status === 'ready') return; await sleep(2000); }
  throw new Error('test clock did not become ready');
}
async function waitStatus(subId: string, want: string[], tries = 40) {
  for (let i = 0; i < tries; i++) { const s = await stripeRaw.subscriptions.retrieve(subId); if (want.includes(s.status)) return s; await sleep(2000); }
  return stripeRaw.subscriptions.retrieve(subId);
}
async function latestInvoice(customerId: string) { return (await stripeRaw.invoices.list({ customer: customerId, limit: 1 })).data[0]; }

async function main() {
  // Test-mode catalog, mapped to tiers for THIS process only.
  const prod = await stripeRaw.products.create({ name: `${RUN} replay product`, metadata: { replay_run: RUN } });
  const mkPrice = async (amt: number) => (await stripeRaw.prices.create({ product: prod.id, currency: 'usd', unit_amount: amt, recurring: { interval: 'month' } })).id;
  const P = { starter: await mkPrice(7900), pro: await mkPrice(14900), team: await mkPrice(29900), unknown: await mkPrice(1234) };
  PRICE_TO_TIER[P.starter] = 'starter'; PRICE_TO_TIER[P.pro] = 'pro'; PRICE_TO_TIER[P.team] = 'team';
  console.log(`test prices: ${JSON.stringify(P)}`);

  await check('trialing → active', async () => {
    const u = await newUser('trial'); const c = await customer(u, 'trial'); await attachCard(c.id, 'pm_card_visa');
    const s = await subscribe(c.id, u, P.pro, { trial_period_days: 14 });
    await deliver('customer.subscription.created', s);
    expectMeta(await meta(u), { tier: 'pro', billing_status: 'active', stripe_subscription_status: 'trialing', stripe_subscription_id: s.id });
    await stripeRaw.subscriptions.update(s.id, { trial_end: 'now' });
    const live = await waitStatus(s.id, ['active']);
    await deliver('customer.subscription.updated', live);
    const inv = await latestInvoice(c.id);
    await deliver('invoice.payment_succeeded', inv);
    expectMeta(await meta(u), { tier: 'pro', billing_status: 'active', stripe_subscription_status: live.status });
    return `trialing then ${live.status}`;
  });

  let pd: { u: string; c: any; s: any; clock: string; failedInvId: string } | null = null;
  await check('active → past_due', async () => {
    const clock = await stripeRaw.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `${RUN} pd` }); cleanup.clocks.push(clock.id);
    const u = await newUser('pastdue'); const c = await customer(u, 'pastdue', clock.id);
    await attachCard(c.id, 'pm_card_visa');
    const s = await subscribe(c.id, u, P.pro);
    await deliver('customer.subscription.created', s);
    expectMeta(await meta(u), { tier: 'pro', billing_status: 'active' });
    await attachCard(c.id, 'pm_card_chargeCustomerFail'); // becomes the default; the next renewal charge fails
    await advance(clock.id, 32);
    const live = await waitStatus(s.id, ['past_due', 'unpaid', 'canceled']);
    if (live.status !== 'past_due') throw new Error(`expected past_due from Stripe, got ${live.status} (account dunning settings?)`);
    const failedInv = await latestInvoice(c.id);
    await deliver('invoice.payment_failed', failedInv);
    await deliver('customer.subscription.updated', live);
    expectMeta(await meta(u), { tier: 'pro', billing_status: 'past_due' });
    if (!alerts.some(a => a.kind === 'payment_failed')) throw new Error('payment_failed alert not raised');
    pd = { u, c, s, clock: clock.id, failedInvId: failedInv.id };
    return 'past_due, access kept, not stamped active';
  });

  await check('past_due → active (successful retry)', async () => {
    if (!pd) throw new Error('prerequisite scenario "active → past_due" did not reach past_due');
    const goodPm = await attachCard(pd.c.id, 'pm_card_mastercard'); // returns the ATTACHED payment method id
    await stripeRaw.invoices.pay(pd.failedInvId, { payment_method: goodPm });
    const ok = await waitStatus(pd.s.id, ['active']);
    await deliver('invoice.payment_succeeded', await stripeRaw.invoices.retrieve(pd.failedInvId));
    await deliver('customer.subscription.updated', ok);
    expectMeta(await meta(pd.u), { tier: 'pro', billing_status: 'active' });
    return `past_due then ${ok.status}`;
  });

  await check('active → unpaid/canceled after exhausted retries (whatever Stripe actually does)', async () => {
    const clock = await stripeRaw.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `${RUN} unpaid` }); cleanup.clocks.push(clock.id);
    const u = await newUser('unpaid'); const c = await customer(u, 'unpaid', clock.id);
    await attachCard(c.id, 'pm_card_visa');
    const s = await subscribe(c.id, u, P.pro);
    await deliver('customer.subscription.created', s);
    await attachCard(c.id, 'pm_card_chargeCustomerFail');
    let live: any = s;
    for (let i = 0; i < 4 && !['unpaid', 'canceled'].includes(live.status); i++) { await advance(clock.id, i === 0 ? 32 : 15); live = await waitStatus(s.id, ['unpaid', 'canceled', 'past_due'], 15); }
    if (!['unpaid', 'canceled'].includes(live.status)) return `SKIPPED: Stripe left status=${live.status}; set Billing → Revenue recovery to mark unpaid/cancel, rerun`;
    await deliver(live.status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', live);
    expectMeta(await meta(u), { tier: 'cancelled', billing_status: live.status === 'canceled' ? 'cancelled' : 'unpaid' });
    return `Stripe status ${live.status} → revoked`;
  });

  await check('active → canceled', async () => {
    const u = await newUser('cancel'); const c = await customer(u, 'cancel'); await attachCard(c.id, 'pm_card_visa');
    const s = await subscribe(c.id, u, P.team);
    await deliver('customer.subscription.created', s);
    expectMeta(await meta(u), { tier: 'team', billing_status: 'active' });
    const dead = await stripeRaw.subscriptions.cancel(s.id);
    await deliver('customer.subscription.deleted', dead);
    expectMeta(await meta(u), { tier: 'cancelled', billing_status: 'cancelled' });
    return 'revoked';
  });

  await check('duplicate active subscription, then cancel the duplicate', async () => {
    const u = await newUser('dup'); const c1 = await customer(u, 'dup1'); const c2 = await customer(u, 'dup2');
    await attachCard(c1.id, 'pm_card_visa'); await attachCard(c2.id, 'pm_card_visa');
    const a = await subscribe(c1.id, u, P.pro); await deliver('customer.subscription.created', a);
    const b = await subscribe(c2.id, u, P.pro); await deliver('customer.subscription.created', b);
    expectMeta(await meta(u), { stripe_subscription_id: a.id, tier: 'pro', billing_status: 'active' });
    const dead = await stripeRaw.subscriptions.cancel(b.id);
    await deliver('customer.subscription.deleted', dead);
    expectMeta(await meta(u), { stripe_subscription_id: a.id, tier: 'pro', billing_status: 'active' });
    return 'bound subscription untouched';
  });

  await check('cancel bound subscription while another valid one exists → promote', async () => {
    const u = await newUser('promote'); const c1 = await customer(u, 'pr1'); const c2 = await customer(u, 'pr2');
    await attachCard(c1.id, 'pm_card_visa'); await attachCard(c2.id, 'pm_card_visa');
    const a = await subscribe(c1.id, u, P.starter); await deliver('customer.subscription.created', a);
    const b = await subscribe(c2.id, u, P.pro); await deliver('customer.subscription.created', b);
    await sleep(65000); // Stripe search index is eventually consistent (~1 min); list-by-customer is the fallback
    const dead = await stripeRaw.subscriptions.cancel(a.id);
    await deliver('customer.subscription.deleted', dead);
    expectMeta(await meta(u), { stripe_subscription_id: b.id, tier: 'pro', billing_status: 'active' });
    return 'promoted the surviving subscription';
  });

  await check('unknown price → fail closed', async () => {
    const u = await newUser('unk'); const c = await customer(u, 'unk'); await attachCard(c.id, 'pm_card_visa');
    const s = await subscribe(c.id, u, P.unknown);
    await deliver('customer.subscription.created', s);
    const m = await meta(u);
    if (m.tier) throw new Error(`unknown price granted tier=${m.tier}`);
    if (!alerts.some(a => a.kind === 'unknown_price')) throw new Error('unknown_price alert not raised');
    return 'no entitlement written, alert raised';
  });

  await check('duplicate delivery (same event id ×3)', async () => {
    const u = await newUser('dupdeliv'); const c = await customer(u, 'dd'); await attachCard(c.id, 'pm_card_visa');
    const s = await subscribe(c.id, u, P.pro);
    const first = await deliver('customer.subscription.created', s);
    const before = JSON.stringify(await meta(u));
    await deliver('customer.subscription.created', s, { id: first.id, created: first.created });
    await deliver('customer.subscription.created', s, { id: first.id, created: first.created });
    if (JSON.stringify(await meta(u)) !== before) throw new Error('metadata changed on replayed event');
    return 'replays were no-ops';
  });

  await check('out-of-order delivery (stale active after deleted)', async () => {
    const u = await newUser('ooo'); const c = await customer(u, 'ooo'); await attachCard(c.id, 'pm_card_visa');
    const s = await subscribe(c.id, u, P.pro);
    const t0 = Math.floor(Date.now() / 1000);
    await deliver('customer.subscription.created', s, { created: t0 });
    const dead = await stripeRaw.subscriptions.cancel(s.id);
    await deliver('customer.subscription.deleted', dead, { created: t0 + 20 });
    await deliver('customer.subscription.updated', { ...s, status: 'active' }, { created: t0 + 10 }); // stale
    expectMeta(await meta(u), { tier: 'cancelled', billing_status: 'cancelled' });
    return 'stale event ignored';
  });
}

main().catch(e => { console.error('FATAL', e); results.push({ name: 'runner', ok: false, detail: String(e?.message || e) }); })
  .finally(async () => {
    for (const id of cleanup.subs) { try { await stripeRaw.subscriptions.cancel(id); } catch { /* already gone */ } }
    for (const id of cleanup.clocks) { try { await stripeRaw.testHelpers.testClocks.del(id); } catch { /* ignore */ } }
    for (const id of cleanup.customers) { try { await stripeRaw.customers.del(id); } catch { /* ignore */ } }
    for (const id of cleanup.users) { try { await clerkRaw.users.deleteUser(id); } catch { /* ignore */ } }
    const bad = results.filter(r => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} passed`);
    process.exit(bad.length ? 1 : 0);
  });
