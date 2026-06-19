# Upgrade Modal — Deployment Readiness Checklist

**Date:** 2026-06-18 · **Verdict:** **API: GO (once envs set). Dashboard modal: NO-GO — blocked by live `/dashboard` 404.**

Legend: ✅ verified · ⚠️ owner action (I can't access) · ❌ blocker

| # | Item | Status | Evidence / action |
|---|---|---|---|
| 1 | `/dashboard` live for signed-in users | ❌ **BLOCKER** | `GET /dashboard` → **404** (`/_not-found`), fresh, repeated. The modal lives here; it is unreachable until fixed. Root cause = Clerk-env runtime issue (see `ROOT_REDIRECT_REVERT_AUDIT.md` / Path A: confirm `CLERK_SECRET_KEY` etc. in Vercel **Production**). |
| 2 | `/` behavior | ✅ | `/` → **200** legacy dashboard (redirect reverted earlier). `/sign-in` → 200. Leave root legacy until `/dashboard` is unquestionably stable, then re-apply the `/`→`/dashboard` redirect. |
| 3 | Env vars | ⚠️ **owner** | Code reads: API `ANALYTICS_INGEST_KEY`, `ADMIN_EMAILS`, `ADMIN_API_KEY` (main.py); dashboard webhook `ANALYTICS_INGEST_KEY` (server scope). I can't read Render/Vercel — **you must set + confirm**. `ANALYTICS_INGEST_KEY` must be **identical** on Render and Vercel. `DATABASE_URL` already set (CRUD works). |
| 4 | Stripe webhook events | ✅ code / ⚠️ Stripe dashboard | Webhook handles `checkout.session.completed` (line 82) and `invoice.payment_succeeded` (line 111). **Confirm both are enabled on the Stripe webhook endpoint** (`invoice.payment_succeeded` likely needs adding — required for `paid_subscription_started`). |
| 5 | PR merge order | ✅ defined | (a) saved-leads API **PR #1** → main; (b) analytics API **PR #2** (retarget base→main after #1) → main; (c) dashboard modal **PR #6** → main **last** (after `/dashboard` is live). |
| 6 | Supabase migration 002 | ✅ | `migrations/002_analytics_events.sql` committed (API branch); `analytics_events` table **exists in Supabase** (verified) + dedupe index. Idempotent. |
| 7 | Live-safe dry test (no purchase) | ✅ | Wrote `locked_county_view`/`upgrade_modal_open`/`upgrade_cta_click` via the API → **rows persisted**, `/admin/upgrade-funnel` returned the counts, then cleaned up. Checkout URL includes `client_reference_id` (spec format). Modal-opens-in-browser: **build-verified only** — needs live `/dashboard` + a signed-in session (blocked by #1). |

## Go / No-Go

- **API (analytics + saved-leads):** GO to merge + deploy. Fully functional once `ANALYTICS_INGEST_KEY` + `ADMIN_*` are set on Render (client events work without them; server/admin paths need them).
- **Dashboard upgrade modal:** **NO-GO** until `/dashboard` returns non-404 for anonymous (redirect to sign-in) and signed-in users. Merging PR #6 now would ship the modal behind a 404.

## Sequence to ship (with owners)

1. **Merge API PR #1 → main** (saved-leads). _[can be done now]_
2. **Retarget API PR #2 base→main, merge** (analytics). _[can be done now]_
3. **Render deploy** — auto on merge if Render tracks `main`; **confirm Render is connected + deployed** (⚠️ owner).
4. **Set envs on Render** — `ANALYTICS_INGEST_KEY`, `ADMIN_EMAILS` (and/or `ADMIN_API_KEY`). (⚠️ owner)
5. **Verify admin funnel** — `GET /admin/upgrade-funnel` with the admin key returns counts (after 3–4). (⚠️ owner; I can assist once envs set)
6. **Fix `/dashboard` 404** — set Clerk env vars in Vercel Production + redeploy. (⚠️ owner — the gating blocker)
7. **Set `ANALYTICS_INGEST_KEY` on Vercel** (= Render's). (⚠️ owner)
8. **Merge dashboard PR #6 → main**, deploy. _[hold until #6 fixed]_
9. **Verify modal** — click a locked county on live `/dashboard`: modal opens, `upgrade_cta_click` recorded, Stripe URL has `client_reference_id`. (needs live `/dashboard`)

## Rollback
Dashboard: revert PR #6 commit (only existing-flow change = locked-county click + link consolidation). API: additive — unset `ANALYTICS_INGEST_KEY` to stop server emits; `analytics_events` independent of `saved_leads`.
