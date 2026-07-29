# PR #11 — Final Merge Readiness

**Date:** 2026-07-16
**Dashboard branch:** `feat/authenticated-checkout-provisioning` (`permitmap-dashboard`)
**Landing branch:** `feat/landing-authenticated-cta` (`v0-permitmap-landing-page`)
**Status:** Not merged, not deployed.

Supersedes the prior readiness doc + `FINAL_CHECKOUT_PREVIEW_QA.md`. It records the state
after fixing the three QA-proven defects (A, B, C).

---

## 1. Defects — before → after

| # | Proven defect | Fix | Verified |
|---|---|---|---|
| **A** | Plan dropped during Clerk sign-up | `readIntent` + `forceRedirectUrl=/checkout/resume?plan=…` on sign-up/sign-in; resume POSTs the plan to `/api/checkout` | tests + trace |
| **B** | Attribution parameters dropped | 15-field allowlisted intent carried CTA→auth→resume→`/api/checkout`→Stripe session+subscription metadata (PII-free) | tests + trace |
| **C** | Paid intent became optional after account creation | Paid CTA now auto-resumes checkout after auth; generic signup lands in Preview; legacy free-Starter `/` redirects to Preview-gated `/dashboard`; no tier granted on signup | tests + entitlement audit |

Details: `CHECKOUT_INTENT_PERSISTENCE_AUDIT.md`, `PREVIEW_VS_PAID_ENTITLEMENT_AUDIT.md`.

## 2. Approved-behavior conformance

- **Generic signup, no plan** → Clerk auth → `/dashboard` Preview; no paid tier; no
  Checkout Session. ✅
- **Signup from a paid CTA** → plan preserved through Clerk → resume → `POST /api/checkout`
  **once** → redirect to Stripe-hosted Checkout; 14-day trial; $0 due today; canonical
  Starter/Pro/Team Price IDs; `client_reference_id = clerk_user_id`; never silently
  downgraded to Preview/Starter. ✅
- **Starter is paid $79; Preview is the only free state**; signup never assigns Starter
  metadata (webhook-only provisioning). ✅

Unchanged (as required): prices, Price IDs, trial duration, tier limits, billing cadence,
pricing copy, webhook architecture, preview entitlement rules.

## 3. Files changed this turn (dashboard only; landing unchanged)

New: `lib/checkout-intent.ts`, `app/checkout/resume/page.tsx`, `tests/checkout-intent.test.ts`,
+ 3 audit docs.
Modified: `lib/checkout-session.ts` (attribution metadata + idempotency key),
`lib/start-checkout.ts` (attribution), `lib/analytics.ts` (`checkout_resume_failed`),
`app/api/checkout/route.ts` (accept+re-allowlist attribution),
`app/sign-up/[[...sign-up]]/page.tsx`, `app/sign-in/[[...sign-in]]/page.tsx` (intent redirect),
`app/dashboard/page.tsx` (no-tier→Preview), `app/page.tsx` (`/`→`/dashboard` redirect).

## 4. Headless verification (this environment)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npm test` (`vitest run`) | ✅ **46 passed** (22 + 24 new) |
| `npm run build` | ✅ green; `/checkout/resume`, `/sign-in`, `/sign-up` build; types checked; no `ignoreBuildErrors` |
| `git grep buy.stripe.com` (both repos, ts/tsx) | ✅ comments only — zero active CTAs |
| single `sessions.create` | ✅ one (`lib/checkout-session.ts`) |
| Real-HMAC signed webhook → 2xx (prior run; handler unchanged) | ✅ 200 / tamper→400 |

### Required-test coverage (Phase 6)
1 generic signup → dashboard/Preview, no session ✅ · 2 Starter CTA plan survives + correct
price + 14d + $0 ✅ · 3 Pro price ✅ · 4 Team price ✅ · 5 attribution survives full path ✅
· 6 invalid plan rejected, no session ✅ · 7 cancellation → Preview (`cancel_url`, no tier
write) ✅ · 8 duplicate execution → one Session (deterministic idempotency key) ✅ · 9 paid
entitlement webhook-only / trialing / trial→active ✅ · 10 no active CTA → buy.stripe.com ✅.

## 5. Still PREVIEW-ONLY (cannot pass headless — mandatory before merge)

The code defects are resolved and unit/build-verified, but these require a live preview and
**cannot be executed in this environment**:

1. Browser walkthrough: landing Starter/Pro/Team CTA → Clerk sign-up → auto-resume →
   Stripe Checkout shows **$0 due today + 14-day trial + correct price**; generic signup
   lands in `/dashboard` Preview.
2. Real Clerk `forceRedirectUrl` redirect to `/checkout/resume` after sign-up **and**
   sign-in (incl. the sign-in↔sign-up toggle preserving intent).
3. Live Stripe idempotency: refresh/back-forward on `/checkout/resume` yields **one**
   Session/subscription end-to-end.
4. Live webhook endpoint delivery + `STRIPE_WEBHOOK_SECRET` matches the exact prod endpoint;
   subscribed events fire; forced duplicate delivery → no duplicate user/charge.
5. Vercel Production env present (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_URL`,
   `NEXT_PUBLIC_API_URL`, `ANALYTICS_INGEST_KEY`).

---

## 6. Final verdict

### NOT READY TO MERGE

All three QA-proven code defects (A, B, C) are **fixed and verified** to the fullest extent
possible headless: plan + attribution now persist through Clerk, paid intent auto-resumes
checkout exactly once, and Preview is the only free state (no signup-time Starter). `tsc`,
46 tests, and `build` are green in both repos; zero active `buy.stripe.com` CTAs.

**No code-level blocker remains.** The verdict stays NOT READY solely because the mandatory
browser + live-webhook checks (§5) cannot be executed in this environment, and the standing
instruction is not to merge until they pass. Run §5 on a preview deploy; if green, this PR
is READY.

**Do not merge. Do not deploy.**
