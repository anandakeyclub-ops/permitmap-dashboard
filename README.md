# permitmap-dashboard

Next.js dashboard for PermitMap.org — `app.permitmap.org`

## Setup

1. Create GitHub repo: `permitmap-dashboard`
2. Push this folder
3. Deploy to Vercel:
   - Framework: Next.js
   - Root directory: ./
   - Domain: app.permitmap.org

## Environment Variables (set in Vercel)

```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard
NEXT_PUBLIC_API_URL=https://permitmap-api.onrender.com
```

## Auth setup (Clerk.dev)

1. Go to clerk.com → Create application
2. Name: PermitMap
3. Copy publishable key + secret key to Vercel env vars
4. In Clerk dashboard → Users → set publicMetadata.tier for each user:
   - `{"tier": "starter"}` — $79/month
   - `{"tier": "pro"}` — $149/month  
   - `{"tier": "team"}` — $299/month

## Tier gating

Tiers are set via Clerk user metadata (publicMetadata.tier).
Update via Clerk dashboard or Stripe webhook (Step 6 of build plan).