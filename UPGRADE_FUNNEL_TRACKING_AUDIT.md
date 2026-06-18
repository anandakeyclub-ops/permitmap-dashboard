# Upgrade Funnel — Tracking & Reuse Audit

**Date:** 2026-06-18
**Scope:** locked-county upgrade modal + funnel analytics (lock click → paid sub).
**Rule honored:** audit before code. This documents what exists, what's duplicated, what's missing, and what to reuse, so we add **no duplicate instrumentation**.

---

## Headline finding

**There is no analytics layer anywhere in the product.** A full search of `app/` (and the API) found **zero** `gtag` / `dataLayer` / GA4 / PostHog / Segment / Mixpanel / Plausible / `track()` calls and no analytics helper. The `permitmap_api` repo has no `/events` or tracking endpoint either.

Consequence: the constraint *"reuse existing analytics"* **cannot be satisfied literally — none exists.** Choosing an analytics sink is the central architecture decision and is required before Parts 2–3 can be built. (See "Decision required" below.)

---

## What already exists (and can be reused)

| Asset | Location | Reuse |
|---|---|---|
| **Entitlement logic** | `app/dashboard/page.tsx`: `TIER_LIMITS`, `isLocked(i)=i>=limits.counties`, `tier = user.publicMetadata.tier` | ✅ Reuse as-is to detect locked clicks + current plan/access. **No new gating.** |
| **Locked-county UI** | `app/dashboard/page.tsx` sidebar: `onClick={() => !locked && setCounty(c.key)}` (locked click = **no-op today**) | ✅ This is the exact hook point for the modal. |
| **Per-county KPIs** | API `/summary?county=…` → `kpis.total_permits`, `high_value_count`, `avg_value`, `top_trade`; `/counties` → `count`, `trades` | ✅ Reuse for "what you're missing" (fetch `/summary` for the locked county on modal open; fall back to `/counties.count`). Real data only. |
| **Stripe trial links** | `app/dashboard/page.tsx` `CHECKOUT` const **and** `app/pricing/page.tsx` (same 3 `buy.stripe.com` URLs) | ✅ Reuse the URLs — but consolidate (see duplication). |
| **Stripe → tier webhook** | `app/api/stripe-webhook/route.ts`: `checkout.session.completed` + `subscription.*` → Clerk metadata; `PRICE_TO_TIER` (3 price IDs) | ✅ The correct **server-side** emit point for `trial_started` (event 6) and `paid_subscription_started` (event 7). |
| **Preview/upgrade surfaces** | `PreviewLock` component; `<a href="/pricing">Upgrade →</a>` in header/sidebar/permits | Reuse the same Stripe source-of-truth + analytics helper when added. |

## What is duplicated (consolidate, don't add a 4th copy)

1. **Stripe trial links** — hardcoded in **two** client places (`app/dashboard/page.tsx` `CHECKOUT`, `app/pricing/page.tsx`). There is **no single source of truth**. → Create one (`lib/checkout.ts`) exporting the trial links keyed by plan, and have the modal + `PreviewLock` + pricing page import it. (The webhook's `PRICE_TO_TIER` price IDs are the server-side counterpart — keep, document the mapping.)
2. **tier → counties/limits maps** appear 3×: dashboard `TIER_LIMITS`, webhook `TIER_COUNTIES`, API `auth.py` caps. Out of scope to refactor here, but the modal must read the **dashboard `TIER_LIMITS`** (existing) — not introduce a 4th.

## What is missing (everything Parts 2–3 ask for)

- **Analytics helper** — none. Needs creating (`lib/analytics.ts` with a `track(event, props)` and a sink).
- **Events 1–5** (client): `locked_county_view`, `upgrade_modal_open`, `upgrade_plan_selected`, `upgrade_cta_click`, `stripe_checkout_started` — none exist.
- **Events 6–7** (server): `trial_started`, `paid_subscription_started` — **not emitted**. The webhook sets tier but fires no event. Note trial-link checkouts fire `checkout.session.completed` at **trial start** (subscription in `trialing`); the true **paid** conversion is a later `invoice.payment_succeeded`/`subscription.updated → active`, which the webhook does **not** currently distinguish.
- **County attribution through Stripe** — the `buy.stripe.com` links are static; no `client_reference_id`/metadata carries the county or user, so `trial_started` can't currently be attributed to the locked county that drove it. (Legacy `permit_bot` did `?client_reference_id=` tagging; the dashboard does not.)
- **Admin funnel reporting** (Part 3) — no admin/reporting surface exists in the dashboard at all.
- **The modal itself** (Part 1).

## What to reuse vs build (summary)

- **Reuse:** entitlement logic, locked-click hook, `/summary` + `/counties` data, Stripe trial URLs (consolidated), the webhook as server emit point.
- **Build:** one analytics helper + sink; events 1–5 (client) and 6–7 (server, in webhook); `lib/checkout.ts` source of truth; the modal; admin funnel view; optional `client_reference_id` tagging for county attribution.

---

## Decision required before code (Parts 2–3 depend on it)

Since no analytics exists, where do events go? Three viable sinks:

| Option | What it is | Part 3 (in-dashboard funnel) | Effort | Notes |
|---|---|---|---|---|
| **A. First-party → Supabase** | `lib/analytics.ts` → `POST permitmap-api /events` → `funnel_events` table; admin reads aggregates from a new API endpoint | ✅ Native, full control, reuses the Supabase we already provisioned | Highest (API endpoint + table + admin view) | Server events 6/7 emit from the webhook directly to the same table. Cleanest funnel ownership; no 3rd party. |
| **B. GA4 (gtag)** | Add `gtag.js` with the org GA4 id (org already uses GA4 in `permit_bot`) | ⚠️ Part 3 funnel lives in GA4 UI, or needs the GA4 Data API to surface in-dashboard | Lowest client effort | Server events 6/7 need GA4 Measurement Protocol. Funnel attribution by county works via event params. |
| **C. PostHog** | Add PostHog SDK | ✅ Built-in funnels (external UI) | Low | New 3rd-party dependency + data egress. |

**Recommendation: Option A (first-party → Supabase).** It directly delivers Part 3's in-dashboard funnel + conversion rates, keeps data first-party, reuses existing infra, and lets the webhook emit server-truth events 6/7 into the same store. It's the most code but the only option that fully satisfies Parts 2 **and** 3 without an external dependency.

I will not write Parts 2–5 until the sink is chosen, because the analytics helper, the server events, and the admin reporting all change shape per option.

---

## Constraints check (pre-commitment)
- No fake metrics / urgency / testimonials — the modal will render **only** real `/summary` values and omit any field that isn't present.
- Reuse existing Stripe links — yes, via a single consolidated `lib/checkout.ts` (the current duplication is itself a risk this fixes).
- Reuse existing entitlement logic — yes (`TIER_LIMITS`/`isLocked`/`publicMetadata.tier`), no new gating.
- Isolated & production-safe — modal + analytics helper are additive; the only edit to existing flow is the locked-county `onClick` (today a no-op) and consolidating duplicated links.
