# Authenticated Checkout & Durable Provisioning — Audit

**Date:** 2026-07-16 · Branch `feat/authenticated-checkout-provisioning`.
Eliminates the anonymous subscription-checkout path that let a paying customer exist with no Clerk account / no dashboard access (see the golden-customer incident).

## Files changed (only)
| File | Change |
|---|---|
| `app/api/checkout/route.ts` | **new** — thin route: `auth()` → Clerk email → `handleCheckout()` |
| `app/api/stripe-webhook/route.ts` | **rewritten** — thin route: verify signature + dispatch via `handleWebhook()` |
| `lib/checkout-session.ts` | **new (required helper)** — pure, injectable checkout logic (`buildCheckoutParams`, `handleCheckout`) |
| `lib/provisioning.ts` | **new (required helper)** — pure, injectable webhook logic (`resolveClerkUserId`, `provision`, `handleStripeEvent`, `handleWebhook`) |
| `tests/provisioning.test.ts` | **new** — 14 tests (below) |
| `vitest.config.ts`, `package.json` | **new/modified** — `vitest` devDep + `test` script (required to run the tests) |

The core logic lives in the two `lib/` helpers so it is unit-testable without Next request/response machinery; the routes are thin wrappers that inject the real Stripe + Clerk clients.

## Checkout (`POST /api/checkout`)
- **Requires an authenticated Clerk user** (`auth()`); unauthenticated → **401, no Stripe session created**.
- Server-created Stripe **Checkout Session** (no anonymous `buy.stripe.com`), 14-day trial preserved.
- Binds identity three ways: **`client_reference_id = clerk_user_id`**, session `metadata.clerk_user_id`+`plan`, **`subscription_data.metadata.clerk_user_id`**. Uses the verified Clerk email; reuses an existing `stripe_customer_id` (no duplicate customer).

## Webhook (`POST /api/stripe-webhook`)
- Verifies signature (missing/invalid → **400 + `[PROVISIONING_ALERT] signature_verification_failed`**).
- **Provisions by Clerk `user_id`** (durable) from `client_reference_id`/metadata; **back-stamps `clerk_user_id`** onto the Stripe customer + subscription (so verification never again needs a live Clerk lookup).
- **Idempotent** (get-by-id/email → update; safe under Stripe retries); **re-asserts entitlement on `invoice.payment_succeeded`** (paid conversion).
- **Legacy events without an id but with an email** → safe email-fallback provision + `identity_missing_at_checkout` alert → 200.
- **Truly unidentifiable** (no id AND no email) → **non-2xx (500)** so Stripe retries + `no_email_no_identity` alert. Never silent.
- Note: the **authoritative exactly-once owner alert** is the nightly Revenue Integrity sweep (permit_bot) — out of scope for this PR; the webhook emits immediate `[PROVISIONING_ALERT]` breadcrumbs.

## Validation
- **Tests: 14 passed** (`npx vitest run`): checkout 401-no-session, unknown-plan 400, client_reference_id/metadata/subscription-metadata/email bindings, existing-customer reuse; `resolveClerkUserId` (metadata/raw/legacy-token/null); webhook bad-signature→400, provision-by-user_id + Stripe metadata back-stamp, legacy email fallback, idempotent (no duplicate user), missing-identity→non-2xx+alert, webhook never calls Stripe create endpoints (no duplicate charge/subscription).
- **Next production build: `✓ Compiled successfully`** (SWC compiled all files including the two routes + lib).
- **tsconfig gap (pre-existing, documented):** the repo `tsconfig.json` has `include:["src/**/*"]` / `rootDir:"src"`, but the app lives at the repo root. `next build`'s type-check therefore fails with `TS6059: File is not under rootDir 'src'` for **every** `app/api/*` route (health, stripe-webhook, checkout) — this is a **repo-wide config defect, not a defect in this change**. Validation is **not** called complete on that config.
- **App-inclusive type-check (authoritative for this change):** ran `tsc --noEmit` with a corrected, app-inclusive config (temp, not committed) → **0 errors** across `app/`, `lib/`, `tests/`. The four source files type-check clean.

## Files changed (git)
`app/api/checkout/route.ts`, `app/api/stripe-webhook/route.ts`, `lib/checkout-session.ts`, `lib/provisioning.ts`, `tests/provisioning.test.ts`, `vitest.config.ts`, `package.json`, `AUTHENTICATED_CHECKOUT_PROVISIONING_AUDIT.md`. (No lockfile committed — repo has no tracked lockfile; regenerate on install. `.gitignore` is absent in this repo — staged strictly by path.)

## Operator prerequisites before merge/deploy
- Vercel Production env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (for the exact production endpoint), `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (+ `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `ANALYTICS_INGEST_KEY`).
- Stripe endpoint subscribes to: `checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.updated` (and `.created`/`.deleted`).
- Update **all** subscription CTAs to `POST /api/checkout` **before** retiring Payment Links. **Do not merge** if any active subscription CTA still points at `buy.stripe.com`.
- **Fix the repo tsconfig** (`rootDir`/`include`) so `next build` type-checks the app (separate small change).
- **Rotate the GitHub PAT embedded in this repo's git remote URL** (leaks easily; use a credential helper/SSH).

## Explicitly out of scope
Revenue Integrity scheduler · weekly permit-email delivery · `notify()` service · Clerk dev→prod migration · SEO/content · pricing/UI changes.
