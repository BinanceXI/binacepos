# create_demo_session (Live Demo, Same Supabase Project)

This Edge Function provisions a **per-visitor demo tenant** (business + admin user + seeded data).

## Required Env (Supabase Edge Function)
- `DEMO_ALLOWED_ORIGINS` (comma-separated origins/hosts)
- `DEMO_IP_HASH_SALT` (required secret)
- `DEMO_RATE_LIMIT_MAX` (default `3`)
- `DEMO_RATE_LIMIT_MAX_TURNSTILE` (default `10`, only when Turnstile is enabled)
- `DEMO_RATE_LIMIT_WINDOW_MINUTES` (default `60`)
- Optional Turnstile hardening:
  - `TURNSTILE_SECRET_KEY` (if set, captcha is required)

## DB
Apply migrations:
- `supabase/migrations/0013_demo_sessions.sql`
- `supabase/migrations/0014_stock_rpc_tenant_guard.sql`

## Notes
- `verify_jwt=false` by design (public provisioning endpoint). Guard rails are origin allowlist + rate limiting.
- Demo TTL is hard-coded to **1 hour**.
- Demo cleanup runs opportunistically when new demos are created and via the scheduled `cleanup_demo_sessions` function.
