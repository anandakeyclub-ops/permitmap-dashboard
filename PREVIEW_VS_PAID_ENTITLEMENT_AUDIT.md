# Preview vs Paid Entitlement Audit (Defect C — entitlement side)

**Date:** 2026-07-16
**Dashboard branch:** `feat/authenticated-checkout-provisioning`
**Scope:** guarantee Preview is the only free/unpaid state and that signing up never grants
a paid tier. Not merged, not deployed.

## 1. Rule → enforcement matrix

| Required rule | Enforcement | Evidence |
|---|---|---|
| No tier / null tier = Preview | `/dashboard` defaults `tier = publicMetadata.tier \|\| 'preview'`; `TIER_LIMITS.preview` added (label **Preview**) | `app/dashboard/page.tsx` |
| Signup alone never assigns Starter | **No** code writes `tier` on signup. `updateUserMetadata`/`createUser` appear only in `app/actions.ts` (writes `county`, `firstLogin` — never tier) and `lib/provisioning.ts` (webhook only) | grep audit §2 |
| Paid Starter only after Stripe sub trialing/active | `provision()` writes tier solely from Stripe events (`checkout.session.completed`, `invoice.payment_succeeded`, `customer.subscription.*`), tier from `PRICE_TO_TIER` | `lib/provisioning.ts` |
| Pro / Team only after matching Stripe sub | same — `PRICE_TO_TIER[price_id]` (`…PElPgL8V`→starter, `…PFOUjBMW`→pro, `…oxIWlvf3`→team) | `lib/provisioning.ts` |
| Checkout cancellation → Preview | abandoning Stripe Checkout emits **no provisioning event**; `cancel_url=/pricing?checkout=cancelled`; no tier is ever written → user stays Preview | `lib/checkout-session.ts`; provisioning has no cancel-session handler |
| Failed checkout → Preview | resume failure writes nothing to Clerk; logs `checkout_resume_failed`; user stays Preview | `app/checkout/resume/page.tsx` |
| Completed trial checkout provisions immediately | `checkout.session.completed` → `provision(billing_status:'active')` even while `status:'trialing'` | existing test "(4) trialing provisioned immediately" |
| Trial→active preserves tier | `invoice.payment_succeeded` re-derives the SAME tier from the same price | existing test "(5) trial→active preserves tier" |

## 2. Every tier-assignment path (audited)

`git grep` for `updateUserMetadata` / `createUser` / `tier:` across `app/**` + `lib/**`:

- `app/actions.ts` — `promoteSignupCounty` (writes `{ county }`), `dismissFirstLogin`
  (writes `{ firstLogin:false }`). **Never writes `tier`.**
- `lib/provisioning.ts` — the **only** tier writer; runs exclusively inside the Stripe
  webhook handler. Paid tiers from `PRICE_TO_TIER`; `customer.subscription.deleted` →
  `tier:'cancelled'` (unchanged; a cancelled sub falls through `TIER_LIMITS` to the
  `preview` fallback, so it renders as Preview).
- Dashboards **read** tier only; they never write it.

Conclusion: **no signup-time or client-side tier assignment exists.** Paid entitlement is
exclusively webhook-provisioned after a verified Stripe subscription event.

## 3. Closing the legacy free-access surface

- `app/page.tsx` (`/`) was a legacy dashboard that fetched permit data **without** the
  Clerk JWT and defaulted a no-tier user to `starter` limits — effectively free
  Starter-level access. It is now a server redirect to `/dashboard` (the authoritative,
  server-`preview_locked`-gated experience; Stripe `success_url` already targets it).
- `/dashboard` gating is unchanged and server-authoritative: `isPreview =
  summary?.preview_locked === true` (the API decides from the caller's JWT/tier). The
  client `tier` default was the only place that said "starter" for an unpaid user; it now
  says "preview". **Preview entitlement rules themselves were not changed.**

## 4. What was intentionally NOT changed

Prices, Price IDs, trial duration (14d), tier limits (1/5/99), billing cadence, pricing
copy, the webhook architecture, and the API-side preview_locked rules — all untouched.

## 5. Tests

New `tests/checkout-intent.test.ts` (24) proves plan validation, allowlist, no-open-redirect,
PII-free metadata, deterministic idempotency, attribution→metadata, invalid-plan rejection,
and the generic-signup→/dashboard (no checkout) decision. Existing `tests/provisioning.test.ts`
(22) proves paid provisioning is webhook-only, trialing-immediate, trial→active tier
preservation, idempotency, and no-duplicate-charge. **46 total, all green.**
