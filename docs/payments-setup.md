# Inkwave — paid cadence tier: accounts & keys setup

Work through these in order. The first two (Supabase + Clerk) unblock **login + entitlement**;
Stripe and PayPal add the actual checkout. Use **test / sandbox** modes throughout — we switch to
live later. Put every key in `.env` (local, repo root) AND in Vercel → Project → Settings →
Environment Variables (Production + Preview). `VITE_*` vars are client-visible (publishable keys
only); everything else is a server-only secret.

When you've got the keys, paste me the **non-secret** ones (publishable keys, price/plan IDs, env
flags) here, and add the **secrets** (anything `sk_…`, `whsec_…`, service-role, client secrets) to
`.env`/Vercel yourself — I never need to see those.

---

## 1. Supabase  (→ stores the subscription flag)

1. Create a project at supabase.com.
2. SQL Editor → run (creates the `profiles` table the API expects):
   ```sql
   create table if not exists public.profiles (
     clerk_user_id text primary key,
     email text,
     subscription_active boolean not null default false,
     subscription_provider text,
     subscription_id text,
     stripe_customer_id text,
     current_period_end timestamptz,
     updated_at timestamptz not null default now()
   );
   alter table public.profiles enable row level security;
   ```
3. Project Settings → API → copy:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = the **service_role** secret (NOT anon)

## 2. Clerk  (→ login / identity for billing)

1. Create an application (Development instance) at clerk.com.
2. API Keys → copy:
   - `VITE_CLERK_PUBLISHABLE_KEY` = `pk_test_…`
   - `CLERK_SECRET_KEY` = `sk_test_…`
3. (Optional now) Webhooks → add `https://<your-domain>/api/clerk-webhook`, events
   `user.created/updated/deleted` → `CLERK_WEBHOOK_SECRET` = `whsec_…`. Not required for testing —
   the payment webhooks create the profile row themselves.
4. `pk_test_` works on localhost + Vercel previews. Production (`pk_live_`) needs the Clerk DNS
   records on inkwave.studio — separate task, do later.

## 3. Stripe  (fresh signup → card subscriptions)

1. Sign up at stripe.com. Stay in **Test mode** (toggle, top right).
2. Product catalog → add a product, e.g. "Inkwave Cadence", with a **recurring Price** (pick the
   amount + interval, e.g. monthly). Copy the **Price ID** (`price_…`) → `STRIPE_PRICE_ID`.
3. Developers → API keys → copy **Secret key** (`sk_test_…`) → `STRIPE_SECRET_KEY`.
   (No publishable key needed — we use hosted Stripe Checkout, server-created.)
4. Webhook (two options):
   - **Local testing:** install the Stripe CLI, run
     `stripe listen --forward-to localhost:5173/api/stripe-webhook` — it prints a `whsec_…` →
     `STRIPE_WEBHOOK_SECRET`.
   - **Production:** Developers → Webhooks → add endpoint `https://<domain>/api/stripe-webhook`,
     events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`. Copy its signing secret → `STRIPE_WEBHOOK_SECRET`.

## 4. PayPal  (sandbox → PayPal subscriptions)

1. developer.paypal.com → log in → **Apps & Credentials** → **Sandbox** → create an app.
   Copy **Client ID** → `PAYPAL_CLIENT_ID`, **Secret** → `PAYPAL_SECRET`. Set `PAYPAL_ENV=sandbox`.
2. Create a subscription **Plan**: easiest via the dashboard (Pay & get paid → Subscriptions →
   create a product + plan), or I can add a one-off script to create it via API once your client
   keys are in. Copy the **Plan ID** (`P-…`) → `PAYPAL_PLAN_ID`.
3. Webhooks (in the app settings): add `https://<domain>/api/paypal-webhook`, events:
   `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`,
   `BILLING.SUBSCRIPTION.EXPIRED`. Copy the **Webhook ID** → `PAYPAL_WEBHOOK_ID`.
   (PayPal webhooks need a public URL — for local testing we forward via a tunnel; details when we
   get there.)

---

## Env var summary

```
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
# Clerk
VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
CLERK_SECRET_KEY=sk_test_…
CLERK_WEBHOOK_SECRET=whsec_…        # optional for testing
# Stripe (test)
STRIPE_SECRET_KEY=sk_test_…
STRIPE_PRICE_ID=price_…
STRIPE_WEBHOOK_SECRET=whsec_…
# PayPal (sandbox)
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_SECRET=
PAYPAL_PLAN_ID=P-…
PAYPAL_WEBHOOK_ID=
```

Already set (don't change): `INKWAVE_SIGNING_SK`, `INKWAVE_MASTER_SECRET`, `VITE_SIGNING_PK`,
`VITE_MS_CLIENT_ID` (OneDrive).
