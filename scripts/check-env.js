// Build-time env guard (runs via the "prebuild" npm script). Fails the build
// loudly when a required env var is missing OR malformed — so a misconfigured
// deploy errors out at build time instead of silently serving 404s in prod.
//
// Why format validation matters: a *malformed* Clerk publishable key throws
// `InvalidCharacterError` when Clerk base64-decodes it at build/render time,
// which surfaces in production as 404s on Clerk-wrapped routes. A plain presence
// check would not catch that — so we validate the key shape too.

const required = [
  'CLERK_SECRET_KEY',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_API_URL',
]

const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.error('MISSING ENV VARS:', missing.join(', '))
  process.exit(1)
}

// ── Format validation ──────────────────────────────────────────────────────
const errors = []

const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
const pkMatch = /^pk_(test|live)_(.+)$/.exec(pk)
if (!pkMatch) {
  errors.push('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must start with pk_test_ or pk_live_')
} else {
  // Clerk encodes "<frontend-api-host>$" as base64 after the prefix; a malformed
  // value decodes to something without the trailing "$" (the dummy-key failure).
  const decoded = Buffer.from(pkMatch[2], 'base64').toString('utf8')
  if (!decoded.endsWith('$')) {
    errors.push('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is malformed (base64 payload does not decode to a valid Clerk host)')
  }
}

const sk = process.env.CLERK_SECRET_KEY
if (!/^sk_(test|live)_/.test(sk)) {
  errors.push('CLERK_SECRET_KEY must start with sk_test_ or sk_live_')
}

if (errors.length) {
  console.error('MALFORMED ENV VARS:\n  - ' + errors.join('\n  - '))
  process.exit(1)
}

console.log('ENV CHECK PASSED')
