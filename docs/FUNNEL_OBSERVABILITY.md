# Signup → Stripe Checkout Funnel Observability

Observability-only instrumentation of the previously-invisible high-intent seam between the
marketing CTA and Stripe Checkout Session creation. **No conversion behavior changed.**

## The funnel (event → source of truth)

```
Website session                         GA4 (marketing, permitmap.org)      — traffic
  ↓
checkout_started                        GA4 (marketing)                     — CTA/"/sign-up" CLICK intent
  [HISTORICAL NAME — this is intent, NOT a Stripe session. Kept for reporting continuity.]
  ↓
signup_page_view                        first-party (app, Supabase)         — /sign-up rendered  [pre-auth, anon-allowed]
  ↓
signup_completed                        first-party (app)                   — Clerk signed-out → signed-in on /sign-up
  ↓
checkout_resume_started                 first-party (app)                   — authed user entered /checkout/resume
  ↓
stripe_checkout_created                 first-party (app)                   — backend returned a Checkout Session url
  │  (or) checkout_creation_failed      first-party (app)                   — creation failed (bounded reason)
  ↓
Stripe Checkout completed               STRIPE  ← AUTHORITATIVE             — payment/session completed
  ↓
trial_started / paid_subscription_started  STRIPE webhook  ← AUTHORITATIVE  — subscription state
```

## Authority

- **Stripe is the ONLY authoritative source for billing state** (sessions completed, trials,
  paid). GA4 and the first-party funnel events are engagement/observability signals and **must
  never be treated as authoritative for revenue, MRR, trial, or paid counts.**
- The five new events answer *where* users drop between CTA click and Stripe session creation —
  they do not (and must not) drive billing decisions.

## Transport & privacy

- App events use the existing first-party abstraction `lib/analytics.track()` →
  `permitmap-api POST /analytics/event` (Supabase). **The app has no GA4**; we deliberately did
  NOT add a second (GA4) pipeline. Unifying with the marketing GA4 funnel happens at the
  **reporting layer** (marketing GA4 + first-party funnel + authoritative Stripe).
- **No PII is sent by the client.** The API derives identity from the Clerk JWT; the client
  sends only `plan`/`source`/`client_reference_id` (the non-PII `utm_content` attribution token)
  and bounded categorical `properties.reason`. `signup_page_view` is accepted anonymously with
  **NULL identity** (it precedes account creation).
- `checkout_creation_failed.reason` is a bounded enum (`unauthenticated`, `stripe_create_failed`,
  `server_error`) — never a raw exception string.

## Preserved (unchanged)

`checkout_started` and `trial_signup` (marketing GA4) and `stripe_checkout_started` /
`checkout_resume_failed` (app) are **kept as-is** — historical reporting depends on them. The new
events are additive and live in a separate `CHECKOUT_FUNNEL_EVENTS` allowlist, kept out of the
API's `FUNNEL_EVENTS`/`FUNNEL_STEPS` so the existing upgrade-funnel report is byte-for-byte
unchanged.

## Not done (reported, not implemented)

- **No GA4 on app.permitmap.org / no GA4 cross-domain config.** Adding GA4 to the app would be a
  second competing pipeline, and a true server-side GA4 event would require GA4 Measurement
  Protocol credentials (`api_secret`) that are not present. Per the mission, that portion is
  stopped and reported rather than faked.
