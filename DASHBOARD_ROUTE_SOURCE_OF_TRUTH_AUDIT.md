# Dashboard Route — Source-of-Truth Audit

**Date:** 2026-06-17
**Repo audited:** `permitmap-dashboard-real` → GitHub `anandakeyclub-ops/permitmap-dashboard`
**Purpose:** Determine which dashboard route is production-active and should receive Phase C (Saved Leads) work, before any UI is written.
**Method:** Read-only. No code modified, no endpoints wired, no deploy.

---

## TL;DR

- The live site **`permitmap-dashboard.vercel.app`** currently serves the **legacy `app/page.tsx`** (route `/`). Its JS bundle contains legacy-only strings and **none** of the Phase 1.5 / A / B work. `/dashboard` returns **404** there — that build has no `app/dashboard` chunk at all.
- The repo's `origin/main` **does** contain the modern `app/dashboard/page.tsx` (Phase A, commit `e84d73ef`), but it is **not reflected in the live deployment** → the production build is **stale** (≈ April, pre–Phase 1.5).
- `permitmap.org` is a **different application** (marketing/landing, unrelated bundle) with its own `/dashboard`. Not this repo.
- `app.permitmap.org` does **not resolve** (no DNS / not deployed).

**Recommendation:** Phase C should target **`app/dashboard/page.tsx`** (route `/dashboard`) — the only JWT-/preview-ready surface and the active development line. But a **deployment gap must be closed first**: `/dashboard` is not actually live. See §5.

---

## 1. Production route behavior

| URL | HTTP | Notes |
|---|---|---|
| `https://permitmap-dashboard.vercel.app/` | **200** | Serves a dashboard (legacy — see §3) |
| `https://permitmap-dashboard.vercel.app/dashboard` | **404** | Route absent from this deployment |
| `https://app.permitmap.org/` | **000** | DNS/connection failure — not live |
| `https://app.permitmap.org/dashboard` | **000** | not live |
| `https://permitmap.org/` | **200** | Separate marketing app — `<title>Construction Intelligence for Contractors \| PermitMap</title>` |
| `https://permitmap.org/dashboard` | **200** | Separate app's dashboard — `<title>Dashboard \| PermitMap</title>`, **different bundle scheme** (not Next.js hashed chunks → not this repo) |

- **No redirect** from `/` → `/dashboard` (or vice-versa) on the Vercel deployment; `/` returns 200 directly with no `Location` header.
- The two reachable dashboards (`permitmap-dashboard.vercel.app/` and `permitmap.org/dashboard`) are **separate deployments of separate codebases**, not two routes of one app.

---

## 2. Source mapping (this repo)

Two dashboard implementations coexist in the repo:

| | `app/page.tsx` (route `/`) | `app/dashboard/page.tsx` (route `/dashboard`) |
|---|---|---|
| Last commit touching it | **2026-04-18** ("Update page.tsx") | **2026-06-17** (Phase B, `d0a7b1f5`) |
| On `origin/main`? | Yes | Yes (since Phase A `e84d73ef`) |
| Middleware (`middleware.ts`) | `/` is in `isPublicRoute` → **public** | not public → `auth().protect()` → **protected** (redirects unauthenticated users to sign-in; would **not** 404) |
| Tabs | `permits · trends · insights · saved · digest` | `opportunities · permits · trends · insights` |
| Save UI | **Has** a `Save` column with ★/🔥/↩ tag buttons + a `saved` tab (empty state: "Click ★ on any permit…") | None |
| Components | self-contained | `CallList` (Opportunities), `DigestCard` (Phase B), `PreviewLock` (Phase 1.5) |

- **Navigation:** there is **no in-app link or redirect** to `/dashboard` anywhere in `app/**` (only the word "dashboard" in `app/pricing/page.tsx` marketing copy). Entry to `/dashboard` would rely on Clerk's `afterSignInUrl` (configured in the Clerk dashboard, not in this repo) — which cannot be confirmed from source.
- **Clerk `protect()` behavior:** a protected route that *exists* returns a redirect to sign-in for anonymous users, **not** a 404. The observed `/dashboard` → 404 therefore means the route is **not present in the deployed build**, independent of auth.

> Note: the Phase C prompt's Part 3 (tabs `Permits·Trends·Insights·Saved·Digest`; "★ already exists in the SAVE column") describes the **legacy `app/page.tsx`**, not the Phase A/B `/dashboard`. This is the source of the targeting ambiguity.

---

## 3. Bundle / content fingerprint (what is actually shipped)

Fetched the live HTML at `permitmap-dashboard.vercel.app/`, then downloaded and concatenated all referenced `/_next/static` chunks (~903 KB) and grep'd for unique markers:

| Fingerprint string | Origin | Count in live bundle |
|---|---|---|
| `follow-up` (tag) | legacy `app/page.tsx` | **1** ✅ |
| `Click ★ on any permit` | legacy saved-tab empty state | **1** ✅ |
| `Best Opportunities This Week` | Phase A (`CallList`) | 0 ❌ |
| `Pursue first` | Phase A | 0 ❌ |
| `60-second` | Phase B (`DigestCard`) | 0 ❌ |
| `opportunities-anchor` | Phase B CTA scroll target | 0 ❌ |
| `PreviewLock` / `Preview mode` | Phase 1.5 | 0 ❌ |

- Chunks present include `app/page-*.js` but **no `app/dashboard/page-*.js`**.
- **Conclusion:** the live deployment is the **legacy `app/page.tsx`**, at a revision **older than Phase 1.5** (#2). The brief's statement that Phase A/B is "deployed to production" is **not reflected** at this URL.

---

## 4. Auth / JWT readiness per route

| Capability | `/` — `app/page.tsx` (legacy) | `/dashboard` — `app/dashboard/page.tsx` (Phase A/B) |
|---|---|---|
| Uses `lib/api.ts` `apiFetch`? | ❌ raw `fetch(\`${API}…\`)` | ✅ all calls via `apiFetch` |
| Sends Clerk JWT? | ❌ never attaches `Authorization` | ✅ `apiFetch` attaches `Bearer` (template `api`) |
| Handles `PreviewLock`? | ❌ no preview concept | ✅ renders `PreviewLock`, gates on `summary.preview_locked` |
| Calls saved endpoints with auth? | ❌ old file-based `/saved/{userId}`, unauthenticated, `userId` from `user.id` in path | n/a yet — but ready: Step 1/2 added `/saved-leads` + `apiFetch` helpers |
| Compatible with `API_AUTH_MODE=required` later? | ❌ **would break** — no token sent → 401 on every call | ✅ designed for it (JWT forwarded; anonymous-safe in `off`/`optional`) |

**Critical implication for Phase C:** the new `/saved-leads` endpoints (Step 1) **require a Clerk JWT** (`require_contractor` → 401 if anonymous). The legacy `/` sends **no** JWT, so wiring Phase C there would 401 unless `apiFetch`+token forwarding is first retrofitted into `app/page.tsx` — effectively rebuilding the plumbing that already exists in `/dashboard`.

---

## 5. Recommendation

### Which route is the *real* dashboard?
- **Currently live (stale):** legacy `app/page.tsx` at `/` on `permitmap-dashboard.vercel.app`.
- **Intended / active development line:** `app/dashboard/page.tsx` at `/dashboard` (Phase 1.5 + A + B, JWT, preview gating). It is on `origin/main` but **not actually deployed**.

### Which route should Phase C target?
**`app/dashboard/page.tsx` (`/dashboard`).** Reasons:
1. Only surface wired for Clerk JWT via `apiFetch` — a hard requirement for the new auth-gated `/saved-leads` endpoints.
2. Already has the paid/preview gate (`PreviewLock`) the Phase C "paid/trial only" constraint depends on.
3. It is the live development line (Phase A/B landed today) and already on `main`.
4. Steps 1–2 (types + `apiFetch` saved-leads helpers) were built against this surface.

Targeting the legacy `/` would mean retrofitting JWT/preview plumbing and fighting an existing, conflicting file-based save system — net negative.

### What about the other route?
The legacy `app/page.tsx` should be **retired**, but **not in the Phase C change**. Safest sequence (separate, user-owned deploy work — not part of Saved Leads coding):
1. **Close the deploy gap first.** Confirm the Vercel project for `permitmap-dashboard.vercel.app` is connected to `anandakeyclub-ops/permitmap-dashboard` with production branch = `main`, then trigger a deploy so `/dashboard` (and Phase 1.5/A/B) actually ship. Right now they do not.
2. **Decide the entry route.** Either (a) make `/dashboard` the canonical app and add a redirect `/ → /dashboard` (or set Clerk `afterSignInUrl=/dashboard`), or (b) promote `app/dashboard/page.tsx` to the root by replacing `app/page.tsx`. Option (a) is lower-risk and reversible.
3. **Then delete `app/page.tsx`** (and its legacy file-based save UI) once `/dashboard` is confirmed live and reachable, to remove the divergence permanently.

### Safest migration path if both remain reachable
- Build Phase C **only** in `app/dashboard/page.tsx`. Do not touch `app/page.tsx`.
- Keep the legacy `/saved/{user_id}` file endpoints untouched (they back the legacy UI); Phase C uses the new Postgres `/saved-leads` exclusively. The two stores do not collide.
- Coordinate the deploy/redirect/delete steps above as a **separate** task after Phase C UI is built and reviewed.

---

## Out-of-scope issues surfaced during the audit (flagged, not acted on)

1. **🔴 Leaked credential:** the git remote URL for `permitmap-dashboard-real` embeds a GitHub Personal Access Token (`ghp_…`, redacted here) in plaintext. **Rotate this token** and re-set the remote without the secret (e.g. use a credential helper or SSH). It is exposed to anyone who can read the repo's git config.
2. **Deployment drift:** `origin/main` is ahead of what's live; Phase 1.5/A/B are unshipped on the Vercel URL. Worth reconciling regardless of Phase C.
3. **Phase B not on `main`:** the Weekly Digest Card (`d0a7b1f5`) lives only on `phase-b-digest-card`; it is not merged to `main` and thus not even in the "intended" deployment yet.
