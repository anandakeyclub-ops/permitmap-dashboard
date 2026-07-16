# Checkout-Intent Persistence Audit (Defects A + B + paid side of C)

**Date:** 2026-07-16
**Dashboard branch:** `feat/authenticated-checkout-provisioning`
**Landing branch:** `feat/landing-authenticated-cta` (no code change needed — see §6)
**Scope:** preserve the selected plan + attribution through Clerk auth and resume checkout
exactly once. Not merged, not deployed.

Fixes the QA-proven defects:
- **A** — plan dropped during Clerk sign-up.
- **B** — attribution parameters dropped.
- **C (paid side)** — paid-plan intent became optional after account creation.

---

## 1. The durable intent contract (Phase 1)

`lib/checkout-intent.ts` — single, validated definition of what survives auth.

- `Plan = starter | pro | team`; `isPlan()` rejects anything else (`'enterprise'`, `''`,
  `'STARTER'`, non-strings → not a plan).
- Allowlist `INTENT_FIELDS` (15): `county, trade, state, campaign, source, name, email,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, ref, gclid, fbclid`.
  Anything off-list is dropped (no arbitrary passthrough; no prototype pollution).
- `readIntent(src)` accepts URLSearchParams / ReadonlyURLSearchParams / Next `searchParams`
  records; returns `{ plan: Plan|null, params }` with only allowlisted, non-empty values.
- `serializeIntent` / `buildResumeUrl` / `buildAuthUrl` build **relative first-party
  paths only** (`/checkout/resume?…`, `/sign-in?…`). We never accept or echo a
  caller-supplied redirect URL → **no open-redirect surface**.
- `pickMetadata()` → Stripe-safe attribution: allowlisted, **PII excluded** (`name`,
  `email` never sent to Stripe), values capped at 500 chars (Stripe per-value limit),
  ≤13 keys (well under the 50-key limit).
- `checkoutIdempotencyKey(userId, plan, attribution)` → deterministic
  `co_<userId>_<plan>_<djb2(canonical attribution)>` (no `Math.random`/`Date`), so the
  same intent re-run reuses the key.

## 2. Preserving intent through Clerk (Phase 2)

- `app/sign-up/[[...sign-up]]/page.tsx` and `app/sign-in/[[...sign-in]]/page.tsx` now
  `readIntent(searchParams)` and:
  - **valid plan** → `forceRedirectUrl = buildResumeUrl(plan, params)` (forces the resume
    route after auth, overriding any default — the plan/attribution are NOT dropped);
  - **no/invalid plan** → `fallbackRedirectUrl = /dashboard` (still honors a Clerk
    `redirect_url` deep-link; generic signups land in Preview);
  - `signInUrl`/`signUpUrl` carry the intent so the Clerk sign-in↔sign-up toggle preserves it.
- `?county=` is still stored as `unsafeMetadata` (promoted server-side on first load) —
  existing behavior preserved.
- Middleware: `/checkout/resume` is **not** in `isPublicRoute` → protected; a
  just-authenticated user passes `auth().protect()`.

## 3. Resume checkout exactly once (Phase 3)

`app/checkout/resume/page.tsx` (client, Suspense-wrapped for `useSearchParams`):
1. waits for `useUser().isLoaded`; unauthenticated → bounce to `/sign-in` preserving intent;
2. `readIntent` → invalid/absent plan → `/dashboard` (never a silent paid→free downgrade);
3. valid plan → `startCheckout(plan, { attribution })` **once**, guarded by an in-flight
   `useRef` (kills React Strict Mode double-invoke and double-clicks);
4. success → `startCheckout` navigates to the Stripe-hosted URL;
5. failure → real error UI with **Try again** + Back to pricing, logs
   `checkout_resume_failed`; never dumps the user silently into the dashboard.

**Duplicate-submission safety:** the in-flight ref covers same-mount double runs; refresh /
back-forward re-POST is deduped server-side by the deterministic idempotency key — Stripe
returns the **same** Checkout Session, so no duplicate session/subscription.

## 4. Attribution continuity end-to-end (Phase 4)

Landing CTA → `/sign-up?plan&county&trade&source&campaign&utm_*&ref&gclid&fbclid`
→ Clerk (`forceRedirectUrl`) → `/checkout/resume?<intent>`
→ `startCheckout(plan, { attribution })` → `POST /api/checkout` `{ plan, attribution }`
→ route re-validates via `readIntent` (allowlist re-applied server-side; never trusts the
body shape) → `handleCheckout` → `buildCheckoutParams`:
- `client_reference_id = clerk_user_id` (unchanged);
- `metadata` and `subscription_data.metadata` both carry
  `clerk_user_id, plan, county, trade, state, campaign, source, utm_*, ref, gclid, fbclid`
  (the required minimum, PII-free);
- webhook `emit('trial_started', …)` already forwards session metadata to first-party
  analytics; resume also fires `stripe_checkout_started`.

## 5. Source-level flow trace — Landing **Team** CTA → Stripe Team Session

| Step | File | What happens |
|---|---|---|
| 1 | landing `app/page.tsx` / `app/pricing/pricing-interactive.tsx` → `lib/signup.ts` | `signupUrl('team', params)` → `https://app.permitmap.org/sign-up?plan=team&county=…&utm_*=…`; `ClickTracker` fires `checkout_started` |
| 2 | `app/sign-up/[[...sign-up]]/page.tsx` | `readIntent` → `plan='team'`; `forceRedirectUrl=/checkout/resume?plan=team&…`; county→unsafeMetadata |
| 3 | Clerk | after account creation → redirect to `/checkout/resume?plan=team&…` |
| 4 | `app/checkout/resume/page.tsx` | authed + `plan='team'` → `startCheckout('team',{attribution})` once |
| 5 | `lib/start-checkout.ts` | `POST /api/checkout` `{ plan:'team', attribution }` |
| 6 | `app/api/checkout/route.ts` | `auth()`→userId; `readIntent` re-allowlists attribution → `handleCheckout` |
| 7 | `lib/checkout-session.ts` | `isPlan('team')` ✓; price `price_1TMtThIgaDPbFgUVoxIWlvf3`; `mode:subscription`; `trial_period_days:14`; no `payment_intent_data` (**$0 due today**); `client_reference_id=userId`; metadata (id+plan+attribution) on session & subscription; `idempotencyKey=co_<userId>_team_<hash>` → `sessions.create(params,{idempotencyKey})` |
| 8 | resume | redirect to the returned Stripe-hosted Checkout URL |
| 9 | `app/api/stripe-webhook` → `lib/provisioning.ts` | on `checkout.session.completed` → `provision(tier='team')` (unchanged webhook architecture) |

## 6. Cross-repo contract alignment

Landing `FORWARDED_PARAMS` (`lib/signup.ts`) === dashboard `INTENT_FIELDS`
(`lib/checkout-intent.ts`) — identical 15-field allowlist. The landing already forwards
exactly this set with `plan`, so **no landing code change was required**; the contract is
consistent by construction across both repos.

## 7. Validation

- `npx tsc --noEmit` → **0 errors**.
- `npm test` (`vitest run`) → **46 passed** (22 existing + 24 new intent/attribution tests).
- `npm run build` → **green**; new routes `/checkout/resume` and `/sign-up`/`/sign-in`
  build; types checked; no `ignoreBuildErrors`.
- `git grep buy.stripe.com` (both repos, `*.ts/*.tsx`) → comments only, **zero active CTAs**.
- `sessions.create` → exactly one occurrence (`lib/checkout-session.ts`).
