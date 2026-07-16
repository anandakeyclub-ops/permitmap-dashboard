# Provisioning Telemetry Plan (design — NOT implemented)

**Date:** 2026-07-16 · Phase 6. Design only; do not implement until approved.

## Does a durable provisioning event log already exist?
**No.** Today:
- The webhook emits **funnel** events (`trial_started`, `paid_subscription_started`) to `permitmap-api /analytics/event` → Supabase `analytics_events`. These are conversion signals, **not** a provisioning-attempt lifecycle log.
- Provisioning failures surface only as **`[PROVISIONING_ALERT]` console lines** (ephemeral; lost after the function invocation).
- The nightly **Revenue Integrity** sweep (permit_bot) is the durable *detection + exactly-once alert* layer, but it reconstructs state after the fact — it is not a per-attempt provisioning record.

So there is no durable record of PROVISION_STARTED/SUCCEEDED/FAILED/RETRIED with timings/errors.

## Required fields / states (target)
Fields: `event_id`, `source_event`, `stripe_customer_id`, `stripe_subscription_id`, `clerk_user_id`, `email`, `tier`, `status`, `attempt`, `started_at`, `completed_at`, `duration_ms`, `error_type`, `error_message`, `recovered`.
States: `PROVISION_STARTED` · `PROVISION_SUCCEEDED` · `PROVISION_FAILED` · `PROVISION_RETRIED`.

## Minimum additive design (prefer existing infra — no second logging system)
**Option A (recommended): extend the existing `analytics_events` (Supabase).** No new datastore.
- Add a provisioning event family to the API allowlist (`permitmap_api/main.py FUNNEL_EVENTS`): `provision_started`, `provision_succeeded`, `provision_failed`, `provision_retried`.
- Carry the structured fields in the existing `properties jsonb` column; reuse `stripe_subscription_id`, `stripe_session_id`, `email`, `tier` columns; use `client_reference_id`/a new `event_id` (Stripe event id) for correlation.
- The webhook wraps `handleStripeEvent` with timing + try/catch and emits `provision_started` before and `provision_succeeded`/`provision_failed` after (with `duration_ms`, `error_type`, `error_message`); a later successful retry of the same Stripe `event_id`/subscription emits `provision_retried` + `recovered=true`.
- Idempotency/dedupe: the existing `uq_ae_event_sub (event_name, stripe_subscription_id)` unique index already dedupes lifecycle rows per subscription; provisioning events can key on the Stripe `event_id` to keep retries distinct-but-correlated.
- Cost: ~1 allowlist edit in permitmap_api + emit calls in the webhook. Small, additive.

**Option B (only if strict columns/SQL analytics are required): a dedicated `provisioning_events` table** with the exact columns above + indexes on `stripe_subscription_id`, `clerk_user_id`, `status`. Cleaner queries, but a second table to maintain. Justify only if Option A's `properties` jsonb proves insufficient for the required reporting.

## Recommendation
Start with **Option A** (extend `analytics_events`) — it reuses the deployed Supabase infra, the webhook's existing `emitEvent`, and the existing dedupe index; it feeds the nightly Revenue Integrity sweep with per-attempt lifecycle detail. Implement only after approval; **out of scope for PR #11.**
