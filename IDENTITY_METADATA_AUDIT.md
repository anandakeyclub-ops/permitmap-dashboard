# Identity Metadata Audit — canonical `clerk_user_id`

**Date:** 2026-07-16 · scope: permitmap-dashboard (PR #11 branch).
Canonical key: **`clerk_user_id`**. Result: **consistent — no inconsistent variants in this repo.**

## Writes (Stripe metadata / session)
| Location | Key written | Value |
|---|---|---|
| `lib/checkout-session.ts` `buildCheckoutParams` | `client_reference_id` | Clerk user id |
| `lib/checkout-session.ts` `buildCheckoutParams` | session `metadata.clerk_user_id` | Clerk user id |
| `lib/checkout-session.ts` `buildCheckoutParams` | `subscription_data.metadata.clerk_user_id` | Clerk user id |
| `lib/provisioning.ts` `persistMapping` | Stripe customer `metadata.clerk_user_id` | Clerk user id |
| `lib/provisioning.ts` `persistMapping` | Stripe subscription `metadata.clerk_user_id` | Clerk user id |

## Reads
| Location | Key read |
|---|---|
| `lib/provisioning.ts` `resolveClerkUserId` | `metadata.clerk_user_id` (session + subscription) |
| `lib/provisioning.ts` `resolveClerkUserId` | `client_reference_id` (raw id, or legacy `v1_dashboard_upgrade_{userId}_…` token) |

## Clerk publicMetadata (entitlement, written by `provision`)
Keys: `tier`, `counties_allowed`, `stripe_customer_id`, `stripe_subscription_id`, `billing_status`. Consistent within this repo.

## Inconsistent variants (clerkId / userId / userid / clerk-id / clerkUserId)
- **None in Stripe metadata.** The Stripe metadata key is **always `clerk_user_id`**. Local TypeScript variable/param names (`userId`, `clerkUserId`) differ but never leak into the persisted key — the key is a literal `clerk_user_id` at every write/read.
- **External (out of PR #11 scope, flagged):** `permitmap_api/verify_admin.py::_clerk_lookup` reads Clerk **publicMetadata** `allowed_counties`, while provisioning writes **`counties_allowed`**. This is a **Clerk publicMetadata** key (not Stripe metadata) in a **different repo**. It does not affect `clerk_user_id` and does not gate `verify_customer` (which reads billing tier), but it is a real cross-repo naming mismatch.

## Exact minimum fix
- **In this repo (dashboard): none required** — `clerk_user_id` is canonical and consistent.
- **External follow-up (permitmap_api):** align the counties key — either have the webhook also write `allowed_counties`, or have `verify_admin._clerk_lookup` read `counties_allowed`. One-line change in permitmap_api; not part of PR #11.
