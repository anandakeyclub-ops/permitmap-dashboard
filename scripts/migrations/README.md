# Clerk Dev → Production Migration Tooling (dry-run by default)

> **STATUS (verified against live Stripe + production Clerk, Oct 2026):** the Clerk dev → production migration has been
> performed. app.permitmap.org authenticates against the **production** Clerk instance (the 11 imported users were created
> Sep 25; the production instance now has more). Stripe `clerk_user_id` metadata already points at production users, so
> **no relink is pending**. This document is retained as the historical contract; do not treat the cutover steps below as a
> to-do. Any tool that reads Clerk must be run with an `sk_live_` key (the tools refuse `sk_test_` unless `--allow-dev-clerk`).

Originally, app.permitmap.org authenticated against a Clerk **development** instance
(`pk_test_…`, `*.clerk.accounts.dev`). Moving to a Clerk **production** instance is not a key swap:
existing users (and their Stripe linkage + entitlement) lived on the dev instance and had to be migrated.
This directory holds the machinery + validated contract for a **safe, reversible** cutover. **Nothing
here mutates Clerk, Stripe, or Vercel; every executor defaults to dry-run and fails closed without
explicit `apply` + real credentials.**

## Modules
- `manifest.ts` — the migration manifest contract: `parseManifest`, `validateForApply` (gate: blocks
  apply until every row has a `new_prod_user_id` and every billing row has both Stripe ids), `isBillingRow`.
- `preserve.ts` — `deepEqualStrict` / `checkMetadataPreserved`: metadata carried **verbatim** (no dropped
  keys; arrays stay arrays, booleans stay booleans — the app reads `onboarding_complete` (bool) and the
  county-key variants `counties_allowed` / `allowed_counties` / `selected_counties` (arrays) directly).
- `stripe-relink.ts` — `planStripeRelink` / `runStripeRelink` (DI Stripe client; **dry-run default,
  zero writes**): re-points `customer.metadata.clerk_user_id` + `subscription.metadata.clerk_user_id`
  from the old dev id to the new prod id.
- `clerk-import.ts` — `planClerkImport` / `runClerkImport` (DI Clerk client; **dry-run default,
  fail-closed** without prod creds): creates each prod user preserving verified email + public_metadata.
  **Fail-safe:** if a user is created but its metadata fails verification, that row is a HARD FAIL —
  it is **not** mapped/accepted (`CREATED_IN_PROD`); its prod id is returned in `cleanup_required` and
  the run **stops** (remaining users are not created). The orphan is **never auto-deleted** (deletion
  is a separate explicit step). Re-apply is **blocked** while any row is `CREATED_UNVERIFIED`, so a
  failed user can't be silently re-created as a duplicate.
- `rollback.ts` — `buildRollbackManifest`: reverse Stripe relink (restore dev id) + operational steps.
- `export-dev-users.mjs` — READ-ONLY exporter (`CLERK_SECRET_KEY` from env) → manifest (PII; gitignored).

## Auth migratability (from the real dev instance: 10 users, 9 billing)
| mechanism | status |
|---|---|
| primary email + verification state | **MIGRATABLE_DIRECTLY** (createUser with verified email) |
| public_metadata (tier/billing/counties/onboarding) | **MIGRATABLE_DIRECTLY** (verbatim) |
| password (4 users) | **REQUIRES_PASSWORD_RESET** — Clerk does not expose source hashes |
| OAuth / Google (2 users) | **REQUIRES_OAUTH_RECONNECT** — identities/tokens not transferable |
| passwordless / email-code (remainder) | works on prod with the imported verified email |
| MFA | none enabled → N/A |

## Cutover order (do NOT run without prod creds + Vercel access + explicit approval)
A. Back up / export dev users (`export-dev-users.mjs`) → manifest.
B. Create/import prod users (`runClerkImport --apply`, prod creds) preserving metadata. If any row
   returns in `cleanup_required` (created but unverified), the run halts — record it as
   `CREATED_UNVERIFIED`, resolve the orphan (delete the prod user or fix its metadata + re-verify)
   BEFORE re-running apply.
C. Record old→new user ids into the manifest (`new_prod_user_id`, status `CREATED_IN_PROD`).
D. Configure Clerk **production** domain/origins/redirect + after-sign-in/up URLs + OAuth callbacks.
E. Configure the **production** Clerk webhook (endpoint + signing secret).
F. **Relink Stripe** (`runStripeRelink --apply`) → `customer/subscription.metadata.clerk_user_id` old→new; status `STRIPE_RELINKED`.
G. Set Vercel **Production** env together: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (pk_live), `CLERK_SECRET_KEY` (sk_live), `CLERK_WEBHOOK_SECRET` (prod). Never split frontend/backend across instances.
H. Redeploy app.permitmap.org.
I–M. Verify (see checklist): existing login, new signup, entitlement, checkout, webhook provisioning.
N. Roll back if any gate fails.

**Ordering note:** perform Stripe relink (F) **after** import (B–C) but only once the prod instance is
validated in staging; keep it as late as safely possible so most rollbacks need no Stripe restore.

## Rollback
- **Never** revert Vercel to the development Clerk keys: production Clerk is live and users/checkouts now exist only there.
- To undo a Stripe relink: run `buildRollbackManifest(...).stripe_restore` with a live Stripe key (restores the recorded old
  `clerk_user_id`), then re-verify with `scripts/prod-entitlement-reconcile.ts`.
- To undo a deployment: Vercel rollback of the recorded prior deployment (`DEPLOYED_COMMIT_BEFORE`); do not edit Clerk keys.

## Validation checklist (pass/fail)
`EXISTING_PAYING_USER_LOGIN`, `EXISTING_TRIAL_USER_LOGIN`, `ENTITLEMENT_VISIBLE`, `COUNTY_ACCESS_CORRECT`,
`NEW_SIGNUP`, `CHECKOUT_SESSION_CREATION`, `STRIPE_METADATA_CORRECT`, `CLERK_WEBHOOK_SUCCESS`,
`NO_DEV_CLERK_HOST_ON_LIVE_SITE` (live sign-up serves `pk_live_`, no `clerk.accounts.dev`). No live card charge.

## Prerequisites still missing (blockers)
- Clerk **production** instance + `pk_live_`/`sk_live_` + prod webhook secret (not available locally).
- Vercel Production deployment access.
Until both are provided, only the READ-ONLY export + dry-run planning run here.
