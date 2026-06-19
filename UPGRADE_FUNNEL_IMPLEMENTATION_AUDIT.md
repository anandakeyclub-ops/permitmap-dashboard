# Upgrade Funnel — Implementation Audit

**Date:** 2026-06-18 · **Sink:** first-party Supabase (per decision). **Attribution:** `client_reference_id`.
**Status:** built + validated (build/test). **Not deployed.** Companion: `UPGRADE_FUNNEL_TRACKING_AUDIT.md`.

---

## Architecture

```
Locked county click (dashboard)
  → track locked_county_view ─┐
  → open UpgradeModal          │  client events → permitmap-api POST /analytics/event
     → upgrade_modal_open      │  (Clerk JWT; API derives user_id/email/tier from token)
     → upgrade_plan_selected   │
     → upgrade_cta_click       │
     → stripe_checkout_started ┘  (keepalive: survives redirect; carries client_reference_id)
        → redirect to Stripe trial link (lib/checkout.ts, ?client_reference_id=…)
           → Stripe → webhook (dashboard /api/stripe-webhook)
               checkout.session.completed → emit trial_started (X-Analytics-Key)
               invoice.payment_succeeded(amount>0) → emit paid_subscription_started
                  → API backfills county/user: trial ← checkout_started (by cref),
                                                paid  ← trial (by subscription)
analytics_events (Supabase) ← GET /admin/upgrade-funnel + scripts/funnel_report.py
```
Two trust paths into `/analytics/event`: **client** (Clerk JWT, identity from token, Stripe ids ignored) and **server** (`X-Analytics-Key`, trusts provided attribution). Writes never hard-fail the caller.

## Files modified / added

**permitmap-api** (branch `feat-upgrade-funnel`, based on `phase-c-saved-leads` — reuses `db.py`):
- `migrations/002_analytics_events.sql` (new) — table + indexes + per-subscription dedupe index. **Applied to Supabase.**
- `main.py` — `POST /analytics/event`, `GET /admin/upgrade-funnel`, backfill helper, `FUNNEL_EVENTS`, admin gate.
- `scripts/funnel_report.py` (new) — CLI funnel report (first-party, no GA4).

**permitmap-dashboard** (branch `feat-upgrade-funnel`, based on `main` — independent):
- `lib/checkout.ts` (new) — **single source of truth** for trial links + `client_reference_id`.
- `lib/analytics.ts` (new) — `track()` (fire-and-forget, `keepalive`, never throws).
- `app/dashboard/_components/UpgradeModal.tsx` (new) — the modal.
- `app/dashboard/page.tsx` — locked-county click opens modal (+ `locked_county_view`); `CHECKOUT` now imports `TRIAL_LINKS`.
- `app/api/stripe-webhook/route.ts` — emit `trial_started` / `paid_subscription_started`.
- `app/pricing/page.tsx` — links now import `TRIAL_LINKS` (same URLs; consolidated).

## Funnel event map

| # | Event | Where | Key props | Notes |
|---|---|---|---|---|
| 1 | `locked_county_view` | client (sidebar) | county, source=`county_sidebar` | user/tier from token |
| 2 | `upgrade_modal_open` | client (modal mount) | county, source, properties.variant | A/B headline id |
| 3 | `upgrade_plan_selected` | client | plan, county, variant | on plan change |
| 4 | `upgrade_cta_click` | client | plan, county, client_reference_id, variant | fired even if cref null |
| 5 | `stripe_checkout_started` | client (pre-redirect) | plan, county, client_reference_id, variant | keepalive |
| 6 | `trial_started` | **server** (checkout.session.completed) | client_reference_id, session, subscription, email, plan | county/user backfilled from #5 via cref; deduped per sub |
| 7 | `paid_subscription_started` | **server** (invoice.payment_succeeded, amount>0) | subscription, email, plan | backfilled from #6 via sub; deduped per sub |

Conversion rates (`/admin/upgrade-funnel` + CLI): Lock→Modal, Modal→Click, Click→Checkout, Checkout→Trial, Trial→Paid, plus Lock→Trial.

## Tests / validation (run; no deploy, no emails)

- **Migration 002** applied to Supabase — columns + 5 indexes confirmed.
- **API** `py_compile` OK. TestClient end-to-end: client-no-auth→401, bad event→422, server ingest OK, **trial dedup→1 row**, **paid backfill inherits county/plan/cref**, admin funnel returns counts+conversions, admin-no-key→403. Attribution chain `stripe_checkout_started→trial_started→paid` all carry county/user. `test_auth.py` ALL PASS (no regressions). `funnel_report.py` runs.
- **Dashboard** `tsc` clean; `next build` green (all routes). `lib/checkout.ts` unit-checked: pro URL includes `client_reference_id` (spec format), snake-case county (`city_port_saint_lucie`) preserved, length ≤190, no-user → static link + null cref.
- **Webhook→API path** exercised via the server-ingest TestClient (same `X-Analytics-Key` path the webhook uses).
- **Not validatable headlessly:** the modal opening in a real browser + a real authenticated client-JWT write (covered structurally + by the 401 gate). Requires `/dashboard` reachable (blocked by the separate Clerk-env 404 — Path A).

## Env vars required

| Var | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | API (Render) | Supabase (already set) |
| `ANALYTICS_INGEST_KEY` | API **and** dashboard (server) | shared secret; webhook → `/analytics/event` server path. **Must match.** Dashboard side is server-only (not `NEXT_PUBLIC`). |
| `ADMIN_EMAILS` (csv) or `ADMIN_API_KEY` | API | gate `GET /admin/upgrade-funnel` |
| `NEXT_PUBLIC_API_URL` | dashboard | already set |

If `ANALYTICS_INGEST_KEY` is unset, the webhook **skips** emitting (logged) — no failure. Client events still record.

## Rollback plan

- **Dashboard:** revert the `feat-upgrade-funnel` commit (or don't merge). Only existing-flow change is the locked-county `onClick` (was a no-op) and links importing `lib/checkout.ts` (identical URLs). Reverting restores the no-op + inline links. No data migration to undo.
- **API:** endpoints + table are **additive** — safe to leave. To stop server events without revert: unset `ANALYTICS_INGEST_KEY`. The `analytics_events` table is independent of `saved_leads`.
- **Kill switch (optional, not built):** could gate the modal behind `NEXT_PUBLIC_UPGRADE_MODAL` if you want a runtime off-switch beyond revert.

## Deployment checklist (do not deploy until reviewed)

1. **API:** merge order — `saved_leads` (PR #1) **then** `feat-upgrade-funnel` (it's stacked on it for `db.py`). Set `ANALYTICS_INGEST_KEY` + `ADMIN_EMAILS` on Render. Migration 002 already applied (idempotent).
2. **Dashboard:** set `ANALYTICS_INGEST_KEY` (server scope, = API's) on Vercel. Merge `feat-upgrade-funnel` (independent of `main`).
3. Add a Stripe webhook subscription for `invoice.payment_succeeded` (for event 7) if not already enabled.
4. **Blocker:** the modal lives on `/dashboard`, currently 404 in prod (Clerk env — Path A). Resolve that first or the modal is unreachable.
5. Verify post-deploy: click a locked county → modal opens; `funnel_report.py` / `/admin/upgrade-funnel` show counts climbing; a test trial shows `trial_started` with county attributed.

## Constraints honored
No fake metrics/urgency/testimonials (modal renders only real `/summary` values, omits missing). Reused entitlement logic + Stripe links (consolidated). Analytics failure never blocks checkout; modal failure can't crash the dashboard (best-effort fetch, isolated component). No auth/Stripe/pricing/middleware/API_AUTH_MODE behavior changes beyond the additive funnel.
