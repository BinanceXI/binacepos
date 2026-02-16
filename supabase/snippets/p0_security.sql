-- Phase 0 (P0) security hardening
-- Apply in Supabase SQL editor (or via migrations).

-- 1) Store hashed PINs out of the readable profiles table
create table if not exists public.profile_secrets (
  id uuid primary key references public.profiles (id) on delete cascade,
  pin_salt text not null,
  pin_hash text not null,
  pin_iter integer not null default 120000,
  pin_kdf text not null default 'pbkdf2_sha256',
  updated_at timestamptz not null default now()
);

alter table public.profile_secrets enable row level security;
-- No SELECT/UPDATE/INSERT policies: deny by default.
-- Service role (Edge Functions) bypasses RLS and can read/write.

-- 2) Legacy pin_code: make it unreadable from the client (even for admins in the browser).
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

-- 3) Minimal RLS: profiles + products
-- NOTE: enabling RLS will affect any unauthenticated (anon) reads.
-- This policy set assumes your app signs in users (authenticated) before accessing these tables.

alter table public.profiles enable row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
on public.profiles
for select
to authenticated
using (auth.uid() = id);

drop policy if exists profiles_select_admin_all on public.profiles;
create policy profiles_select_admin_all
on public.profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.role = 'admin'
      and me.active is distinct from false
  )
);

drop policy if exists profiles_admin_write on public.profiles;
-- Postgres policy syntax doesn't allow "for insert, update, delete" in one statement,
-- so we create separate policies for each operation.
drop policy if exists profiles_admin_insert on public.profiles;
create policy profiles_admin_insert
on public.profiles
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.role = 'admin'
      and me.active is distinct from false
  )
);

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update
on public.profiles
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.role = 'admin'
      and me.active is distinct from false
  )
)
with check (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.role = 'admin'
      and me.active is distinct from false
  )
);

drop policy if exists profiles_admin_delete on public.profiles;
create policy profiles_admin_delete
on public.profiles
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.role = 'admin'
      and me.active is distinct from false
  )
);

alter table public.products enable row level security;

drop policy if exists products_read on public.products;
create policy products_read
on public.products
for select
to authenticated
using (true);

drop policy if exists products_inventory_write on public.products;
drop policy if exists products_inventory_insert on public.products;
create policy products_inventory_insert
on public.products
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
      and (
        me.role = 'admin'
        or coalesce((me.permissions ->> 'allowInventory')::boolean, false) = true
      )
  )
);

drop policy if exists products_inventory_update on public.products;
create policy products_inventory_update
on public.products
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
      and (
        me.role = 'admin'
        or coalesce((me.permissions ->> 'allowInventory')::boolean, false) = true
      )
  )
)
with check (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
      and (
        me.role = 'admin'
        or coalesce((me.permissions ->> 'allowInventory')::boolean, false) = true
      )
  )
);

drop policy if exists products_inventory_delete on public.products;
create policy products_inventory_delete
on public.products
for delete
to authenticated
using (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
      and (
        me.role = 'admin'
        or coalesce((me.permissions ->> 'allowInventory')::boolean, false) = true
      )
  )
);
