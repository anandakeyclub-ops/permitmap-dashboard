# PR #11 Production Readiness Audit

**Date:** 2026-07-16 · Branch `feat/authenticated-checkout-provisioning` · Repo `anandakeyclub-ops/permitmap-dashboard`.
Goal: prove authenticated checkout + durable provisioning fully replace the anonymous Payment-Link path. **Not merged, not deployed.**
Invariants preserved (verified): 14-day trial, Price IDs `…SH/…St/…Th`, monthly cadence, $79/$149/$299, tier limits 1/5/99, "$0 due today", features/entitlements/copy unchanged.

## 1. Exact files changed (branch vs main)
- `app/api/checkout/route.ts` *(new)* — thin auth'd route → `handleCheckout`
- `app/api/stripe-webhook/route.ts` *(rewritten)* — thin route → `handleWebhook`
- `lib/checkout-session.ts` *(new)* — `buildCheckoutParams` / `handleCheckout` (pure)
- `lib/provisioning.ts` *(new)* — `resolveClerkUserId` / `provision` / `handleStripeEvent` / `handleWebhook` (pure)
- `lib/start-checkout.ts` *(new)* — single client CTA entry point (POST /api/checkout; sign-in gate on 401)
- `lib/checkout.ts` *(reduced)* — removed `TRIAL_LINKS` + `checkoutUrl` (dead buy.stripe.com helpers); keeps only `type Plan`
- `app/dashboard/_components/UpgradeModal.tsx`, `app/dashboard/page.tsx`, `app/pricing/page.tsx` *(CTA migration)* — anonymous links → `startCheckout()`
- `tests/provisioning.test.ts` *(new, 22 tests)*, `vitest.config.ts` *(new)*, `package.json` *(+vitest devDep, +test script)*
- Docs: `AUTHENTICATED_CHECKOUT_PROVISIONING_AUDIT.md`, `IDENTITY_METADATA_AUDIT.md`, `PROVISIONING_TELEMETRY_PLAN.md`, this file.

## 2. Exact active checkout path(s)
**One:** subscription CTA → `startCheckout(plan)` → `POST /api/checkout` → `handleCheckout` → **`stripe.checkout.sessions.create`** (only occurrence). Server-side, auth-required, `trial_period_days: 14`, `client_reference_id`/session+subscription `metadata.clerk_user_id`.

## 3. Remaining buy.stripe.com references
**Zero real links in source.** `git grep 'https://buy.stripe.com'` → none in `*.ts/*.tsx` (only doc/comment text). `TRIAL_LINKS`/`checkoutUrl` removed. ✅

## 4. CTA migration status (dashboard repo)
| CTA | File | Now uses |
|---|---|---|
| Upgrade modal "Start 14-Day Trial" | `UpgradeModal.tsx` | ✅ `startCheckout` |
| Preview-lock plan buttons (Starter/Pro/Team) | `dashboard/page.tsx` | ✅ `startCheckout` |
| Pricing cards (Get Started / Go Pro / Start Team) | `pricing/page.tsx` | ✅ `startCheckout` (auth gate → sign-in) |
| Internal `/pricing` links | dashboard | unchanged (navigation, not checkout) |

**External (separate repo, NOT in this PR):** the marketing site `v0-permitmap-landing-page` (permitmap.org) still has anonymous `buy.stripe.com` subscription CTAs (`app/pricing`, `app/intake`, `app/free-trial`, `ClickTracker`) + `permitmap_api` sample-optin email links. These must be migrated (or the Payment Links disabled) before the anonymous path is closed **system-wide**.

## 5. Canonical clerk_user_id status
Consistent in-repo (Stripe metadata key is always `clerk_user_id`; see `IDENTITY_METADATA_AUDIT.md`). One external note: permitmap_api reads Clerk publicMetadata `allowed_counties` vs written `counties_allowed` (different repo, out of scope).

## 6. Test results
**22 passed** (`npx vitest run`). Covers all requested cases incl. the six invariants (trial=14/plan, canonical Price ID/plan, no immediate charge, trialing provisioned immediately, trial→active preserves tier, idempotent) + unauthenticated-no-session, signature-reject, provision-by-user_id, email fallback, missing-identity→non-2xx, no duplicate charge/subscription, CTA helper signed-in/401.

## 7. Build result
- **`✓ Compiled successfully`** (SWC, all files).
- **`next build` type-check FAILS** on `TS6059: not under rootDir 'src'` — a **pre-existing repo tsconfig defect** (`include:["src/**/*"]`) affecting **every** `app/api/*` route (health, stripe-webhook, checkout), not this change.
- **App-inclusive `tsc --noEmit` (corrected config): 0 errors** — this change is type-clean.

## 8. Known risks
- **UI changes are not browser-QA'd** (validated by types + unit tests only; headless env). Requires a preview deploy walkthrough.
- **Public pricing CTA now gates on sign-in** (401 → `/sign-in`). This is the intended anti-anonymous behavior but is a funnel change for logged-out visitors — confirm acceptable.
- **tsconfig fix may surface pre-existing app type errors** to triage (the app has never type-checked via `next build`).
- **Landing-repo CTAs remain anonymous** (separate deploy).

## 9. Vercel environment prerequisites (Production)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (exact prod endpoint), `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `ANALYTICS_INGEST_KEY`.

## 10. Stripe webhook event prerequisites
Endpoint subscribes to: `checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. (Also: fix the current failed delivery / verify `STRIPE_WEBHOOK_SECRET` matches the exact endpoint.)

## 11. Production smoke-test steps (post-deploy, preview)
1. Logged-out → `/pricing` → click a plan → redirected to `/sign-in` (no Stripe session). 
2. Signed-in → click a plan → Stripe Checkout shows **$0 due today, 14-day trial**, correct price. 
3. Complete trial checkout → Clerk user gets `tier`/`counties_allowed`; Stripe customer+subscription metadata get `clerk_user_id`; `verify_customer.py` → Clerk/Dashboard/Saved-Leads PASS. 
4. Force a duplicate webhook delivery → no duplicate Clerk user, metadata unchanged. 
5. Trial→paid conversion → tier/access unchanged.

## 12. Rollback command
`git -C permitmap-dashboard revert <merge_sha>` (or revert the branch), then redeploy — restores prior behavior. No schema/data changes. (Note: reverting re-introduces the anonymous Payment-Link CTAs.)

## 13. Final verdict

### NOT READY TO MERGE

The code is correct and all **code-level** gates pass, but two hard gates are not yet green:

| Hard gate | Status |
|---|---|
| Zero active anonymous subscription CTAs | ✅ in this repo (❌ system-wide — landing repo pending) |
| One checkout-session creation path | ✅ |
| Canonical `clerk_user_id` everywhere | ✅ (in-repo) |
| Full tests pass | ✅ (22) |
| **Production build passes** | ❌ **`next build` type-check blocked by pre-existing tsconfig `rootDir:'src'` defect** |
| Webhook idempotent + retry-safe | ✅ |

**Blockers to clear before merge:**
1. **Fix the repo `tsconfig`** (`include`/`rootDir`) so `next build` type-checks the app; triage any pre-existing app type errors it surfaces. *(This change intentionally left out of PR #11 to avoid scope-explosion; it is the top merge prerequisite.)*
2. **Browser-QA** the three migrated CTAs on a preview deploy (smoke steps §11).
3. Confirm **Vercel env** (§9) + **Stripe endpoint events + webhook secret** (§10).
4. **Migrate the landing-repo CTAs** (or disable the Payment Links) so anonymous checkout is closed system-wide.

Once 1–4 are satisfied, this PR is READY. **Do not merge or deploy until then.**
