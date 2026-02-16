-- Phase 2 (P2) offline password auth
-- Apply in Supabase SQL editor (or via migrations).
--
-- Goal:
-- - Store PBKDF2 password hashes out of the readable profiles table
-- - Keep secrets unreadable from the client (RLS deny by default)
-- - Deprecate legacy PIN fields safely

-- 1) Ensure profile_secrets exists (created in P0) and add password columns
create table if not exists public.profile_secrets (
  id uuid primary key references public.profiles (id) on delete cascade,

  -- Password (PBKDF2) for offline-first username/password login
  password_salt text,
  password_hash text,
  password_iter integer,
  password_kdf text default 'pbkdf2_sha256',

  -- Legacy PIN fields (safe to keep during migration)
  pin_salt text,
  pin_hash text,
  pin_iter integer,
  pin_kdf text default 'pbkdf2_sha256',

  updated_at timestamptz not null default now()
);

alter table public.profile_secrets enable row level security;
-- No SELECT/UPDATE/INSERT policies: deny by default.
-- Service role (Edge Functions) bypasses RLS and can read/write.

alter table public.profile_secrets
  add column if not exists password_salt text,
  add column if not exists password_hash text,
  add column if not exists password_iter integer,
  add column if not exists password_kdf text default 'pbkdf2_sha256';

-- 2) Legacy pin_code: keep it unreadable from the client, or drop it once all devices are migrated.
-- Option A (recommended during migration): keep column but revoke client access.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'pin_code'
  ) then
    revoke select (pin_code) on public.profiles from anon, authenticated;
    revoke insert (pin_code) on public.profiles from anon, authenticated;
    revoke update (pin_code) on public.profiles from anon, authenticated;
    grant select (pin_code) on public.profiles to service_role;
    grant insert (pin_code) on public.profiles to service_role;
    grant update (pin_code) on public.profiles to service_role;
  end if;
end $$;

-- Option B (after migration): drop the column completely.
-- alter table public.profiles drop column if exists pin_code;

