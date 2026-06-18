# Dashboard Route — Reconciliation Audit

**Date:** 2026-06-17
**Repo:** `permitmap-dashboard-real` → GitHub `anandakeyclub-ops/permitmap-dashboard`
**Goal:** Make the modern, JWT-ready `/dashboard` the single production dashboard; end the two-dashboard divergence. **Phase C (Saved Leads) remains paused** until this is deployed and verified.
**Companion doc:** `DASHBOARD_ROUTE_SOURCE_OF_TRUTH_AUDIT.md` (the investigation that established the problem).

---

## 1. Deployment state — confirmed

| Question | Finding |
|---|---|
| Which commit is live on Vercel? | **Not externally exposed.** Vercel response headers (`x-vercel-id`, `x-matched-path: /`) carry no commit SHA. The **bundle fingerprint** (see source-of-truth audit §3) proves the live code is **older than Phase 1.5** (#2) — i.e. an April-era build (~`f3e52142`/`10956d77`). Exact SHA must be read from the **Vercel dashboard → Deployments** (requires your access). |
| Is `main` deployed? | **No / stale.** `origin/main` tip is `e84d73ef` (Phase A) and contains `app/dashboard/`, yet the live build has **no `app/dashboard` chunk** and `/dashboard` → **404**. The live deployment is behind `main`. |
| Why does `/` still show the legacy dashboard? | **Two compounding reasons.** (a) The deployed build is stale (pre-1.5). (b) **More fundamentally: `app/page.tsx` *is* the legacy dashboard in `main` itself.** So even a fresh deploy of current `main` would *still* render the legacy UI at `/`, while the modern UI sat unreachable-by-default at `/dashboard`. Staleness alone was not the whole story — the root route was legacy *by design*. |
| Does `/dashboard` render the modern Phase A/B dashboard when signed in? | **In source, yes** — `app/dashboard/page.tsx` is the Phase 1.5 + A + B dashboard (Opportunities, `DigestCard`, `PreviewLock`, JWT `apiFetch`). **In the live deployment, no** — the route isn't deployed (404). Confirmed renderable via local production build (§4). Authenticated render requires Clerk keys + a session → deploy-time manual check. |

---

## 2. Route strategy — decided

Adopted the recommended strategy:

- **Keep `/dashboard` as the protected app** (unchanged; `middleware.ts` already protects it).
- **Redirect `/` → `/dashboard`** so the root no longer serves a competing dashboard.
- **Marketing/landing stays elsewhere.** The public marketing site is a **separate application at `permitmap.org`** (distinct codebase/bundle, own `/dashboard`). This repo's `/` was *not* a marketing page — it was the legacy dashboard — so no public landing is lost by redirecting it.
- **One dashboard implementation only.** The legacy `app/page.tsx` UI is removed from the route tree (preserved in git history).

Rejected alternatives:
- *Retrofit JWT/saved-leads into legacy `/`* — would rebuild plumbing that already exists in `/dashboard` and fight its file-based save UI. Explicitly out of scope.
- *Copy Phase A/B code into `app/page.tsx`* — duplicates the divergence. Not done.

---

## 3. Implemented change

**One file changed:** `app/page.tsx` → replaced the legacy dashboard with a server-side redirect:

```tsx
import { redirect } from 'next/navigation';
export default function Home() {
  redirect('/dashboard');
}
```

- Server component (no `'use client'`) → emits a 307 to `/dashboard` before any client JS.
- **No changes to** `middleware.ts`, Clerk config, `app/dashboard/**`, `lib/api.ts` auth, Stripe, or `API_AUTH_MODE`. Constraints honored.
- `/` remains in `isPublicRoute`, so the redirect runs without forcing auth on the root itself; the *destination* `/dashboard` is what enforces auth.
- Robust to Clerk's `afterSignInUrl`: even if login returns a user to `/`, they're forwarded to `/dashboard`.

**Not changed (deliberately):** legacy `app/page.tsx` code is not deleted from history; the old file-based `/saved/{user_id}` API endpoints are left intact (they backed the legacy UI and harm nothing once the UI is unreachable).

---

## 4. Validation

| Check | Method | Result |
|---|---|---|
| Type-check | `npx tsc --noEmit` | ✅ exit 0 |
| Production build | `npx next build` | ✅ compiled successfully, 7/7 pages |
| `/` is now a redirect | build route table | ✅ `/` = **138 B** (was the full legacy bundle); dynamic (`ƒ`) |
| `/dashboard` exists | build route table | ✅ `/dashboard` = **105 kB**, dynamic (`ƒ`) — modern dashboard present |
| `/dashboard` unchanged | only `app/page.tsx` edited | ✅ Phase A/B/1.5 code untouched |
| Anonymous flow | static reasoning (middleware + redirect) | `/` → 307 `/dashboard` → `protect()` → `/sign-in?redirect_url=/dashboard` → back to `/dashboard`. **Sound; not runtime-verified** (no Clerk keys locally). |
| Signed-in flow | — | **Deploy-time manual check** (needs Clerk session). |
| JWT `apiFetch` still works | — | Unchanged code; **verify post-deploy** on `/dashboard`. |
| Preview users see `PreviewLock` | — | Unchanged gate (`summary.preview_locked`); **verify post-deploy** with a free-tier account. |

> Local runtime validation of authenticated flows was **not possible**: `.env.example` is empty and there is no `.env.local`, so Clerk publishable/secret keys are absent and `clerkMiddleware` cannot run locally. Build-time + static verification is complete; the auth-dependent checks must be done on a deployed preview.

---

## 5. Required deploy steps (owner action — not performed here)

This audit changed code only. To make `/dashboard` the live production dashboard:

1. **Bring Phase B + this redirect onto `main`.** Phase B (`d0a7b1f5`) currently lives only on `phase-b-digest-card`; the redirect was made on that branch too. Merge `phase-b-digest-card` → `main` (PR), so `main` has Phase A + B + the `/`→`/dashboard` redirect.
2. **Confirm the Vercel project wiring.** In the Vercel dashboard, verify the project for `permitmap-dashboard.vercel.app` is connected to `anandakeyclub-ops/permitmap-dashboard` with **Production Branch = `main`**, and that the required env vars are set (`NEXT_PUBLIC_API_URL`, Clerk keys).
3. **Deploy `main`** (push/merge triggers it, or redeploy manually).
4. **Verify on the deployed URL:**
   - `/` → 307 → `/dashboard`.
   - Anonymous `/dashboard` → Clerk sign-in.
   - Signed-in paid user → modern dashboard (Opportunities default, Digest card, KPIs).
   - Free/preview user → `PreviewLock`.
   - Network tab: `apiFetch` calls carry `Authorization: Bearer …`.
5. **Only after the above is green:** resume **Phase C (Saved Leads)** on `/dashboard` (Step 3 onward). The Step 1–2 work is ready: Supabase `saved_leads` table + 5 `/saved-leads` API endpoints (deployed/migrated) and the dashboard `lib/types.ts` + `lib/api.ts` helpers (committed-pending).

### Optional follow-ups (not required for this fix)
- Delete the legacy `app/page.tsx` source body once `/dashboard` is confirmed live (it's already unreachable; this is just housekeeping — git history retains it).
- **🔴 Rotate the GitHub PAT** embedded in this repo's git remote URL (flagged in the source-of-truth audit).

---

## Summary

The root cause was **two-fold**: a stale Vercel deployment *and* a repo where the root route `/` was the legacy dashboard by design. The fix redirects `/ → /dashboard` (one file, no auth/infra changes), validated by a clean production build showing `/` reduced to a 138 B redirect and `/dashboard` present. Making it live is now a **deploy/merge action** you own; once verified, Phase C resumes on `/dashboard`.
