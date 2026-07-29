// Durable checkout-intent contract (shared, validated).
//
// The marketing site (v0-permitmap-landing-page) forwards a paid-plan CTA to
// `app.permitmap.org/sign-up?plan=team&source=pricing&county=…`. This module is the
// single, allowlisted definition of what survives Clerk authentication and how it is
// carried to the post-auth checkout resume. It NEVER trusts an arbitrary redirect URL:
// callers pass allowlisted fields and we build a first-party relative path ourselves,
// so there is no open-redirect surface. No secrets are read or emitted here.

export type Plan = 'starter' | 'pro' | 'team';
export const PLANS: readonly Plan[] = ['starter', 'pro', 'team'] as const;

export function isPlan(v: unknown): v is Plan {
  return typeof v === 'string' && (PLANS as readonly string[]).includes(v);
}

// Controlled first-party post-auth destinations. Relative paths only — never a host.
export const RESUME_PATH = '/checkout/resume';
export const DASHBOARD_PATH = '/dashboard';

// Every non-plan field that may ride through sign-up/sign-in → resume. Anything not
// on this list is dropped (prevents forwarding unbounded/arbitrary params).
export const INTENT_FIELDS = [
  'county', 'trade', 'state', 'campaign', 'source', 'name', 'email',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'ref', 'gclid', 'fbclid',
] as const;

// Subset attached to Stripe metadata: attribution/context only — NO PII (name/email
// are intentionally excluded; email already lives on the Stripe customer).
export const METADATA_FIELDS = [
  'county', 'trade', 'state', 'campaign', 'source',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'ref', 'gclid', 'fbclid',
] as const;

export type IntentParams = Partial<Record<(typeof INTENT_FIELDS)[number], string>>;

// Accepts URLSearchParams / ReadonlyURLSearchParams (`.get`) or a Next `searchParams`
// record (`string | string[] | undefined`). Anything else reads as empty.
type ParamSource =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>
  | null
  | undefined;

function readOne(src: ParamSource, key: string): string | null {
  if (!src) return null;
  const getter = (src as { get?: unknown }).get;
  if (typeof getter === 'function') return (src as { get(n: string): string | null }).get(key);
  const v = (src as Record<string, string | string[] | undefined>)[key];
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  return v == null ? null : String(v);
}

/**
 * Parse a validated checkout intent from any param source. `plan` is null unless it is
 * exactly starter|pro|team (invalid plans are rejected, never forwarded). Only
 * allowlisted, non-empty params are kept.
 */
export function readIntent(src: ParamSource): { plan: Plan | null; params: IntentParams } {
  const rawPlan = readOne(src, 'plan');
  const plan = isPlan(rawPlan) ? rawPlan : null;
  const params: IntentParams = {};
  for (const f of INTENT_FIELDS) {
    const v = readOne(src, f);
    if (v != null && v !== '') params[f] = v;
  }
  return { plan, params };
}

/** Serialize plan + allowlisted params to a URL-encoded query string (stable order). */
export function serializeIntent(plan: Plan, params: IntentParams): string {
  const sp = new URLSearchParams();
  sp.set('plan', plan);
  for (const f of INTENT_FIELDS) {
    const v = params[f];
    if (v != null && v !== '') sp.set(f, v);
  }
  return sp.toString();
}

/** Build the controlled, first-party resume URL. Relative path → no open redirect. */
export function buildResumeUrl(plan: Plan, params: IntentParams): string {
  return `${RESUME_PATH}?${serializeIntent(plan, params)}`;
}

/** Build a sign-in/sign-up URL that preserves the intent (used for the Clerk toggle links). */
export function buildAuthUrl(path: string, plan: Plan | null, params: IntentParams): string {
  if (!plan) return path;
  return `${path}?${serializeIntent(plan, params)}`;
}

/**
 * Allowlisted, PII-free, Stripe-limit-safe metadata (values capped at 500 chars, the
 * Stripe per-value limit; ≤13 keys, well under the 50-key limit).
 */
export function pickMetadata(attribution?: IntentParams | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attribution) return out;
  for (const f of METADATA_FIELDS) {
    const v = attribution[f];
    if (v != null && v !== '') out[f] = String(v).slice(0, 500);
  }
  return out;
}

// Deterministic string hash (djb2) — no Math.random / Date, so the idempotency key is
// stable across refresh / back-forward / StrictMode re-runs of the same intent.
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Deterministic Stripe idempotency key = Clerk user + plan + intent nonce (a stable hash
 * of the canonical attribution). The SAME intent re-executed (refresh, double click,
 * back/forward, React Strict Mode) reuses the key, so Stripe returns the SAME Checkout
 * Session instead of creating a duplicate. A genuinely different intent → different key.
 */
export function checkoutIdempotencyKey(userId: string, plan: Plan, attribution?: IntentParams | null): string {
  const meta = pickMetadata(attribution);
  const canonical = Object.keys(meta).sort().map((k) => `${k}=${meta[k]}`).join('&');
  return `co_${userId}_${plan}_${djb2(canonical)}`;
}
