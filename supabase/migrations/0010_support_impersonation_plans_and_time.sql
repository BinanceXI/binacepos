-- BinanceXI POS (by Binance Labs)
-- P10: Support impersonation + plan types + server time + device typing.

begin;

/* -------------------------------------------------------------------------- */
/* businesses: plan_type                                                      */
/* -------------------------------------------------------------------------- */

alter table if exists public.businesses
  add column if not exists plan_type text not null default 'business_system';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_plan_type_check') then
    alter table public.businesses
      add constraint businesses_plan_type_check
      check (plan_type in ('business_system','app_only'));
  end if;
end $$;

update public.businesses
  set plan_type = 'business_system'
  where plan_type is null or trim(plan_type) = '';

/* -------------------------------------------------------------------------- */
/* business_billing defaults (plan-aware)                                     */
/* -------------------------------------------------------------------------- */

alter table if exists public.business_billing
  add column if not exists max_devices integer not null default 2;

-- Replace the trigger function so new businesses get plan-specific defaults.
create or replace function public.businesses_create_billing_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan text := coalesce(nullif(trim(new.plan_type), ''), 'business_system');
  v_grace integer := case when v_plan = 'app_only' then 5 else 7 end;
  v_max integer := case when v_plan = 'app_only' then 1 else 2 end;
  -- Trial: app_only starts with 30 days paid-through; business_system starts at "now" (grace applies).
  v_paid timestamptz := case when v_plan = 'app_only' then (now() + interval '30 days') else now() end;
begin
  insert into public.business_billing (business_id, grace_days, max_devices, paid_through)
  values (new.id, v_grace, v_max, v_paid)
  on conflict (business_id) do nothing;
  return new;
end;
$$;

drop trigger if exists businesses_create_billing_row on public.businesses;
create trigger businesses_create_billing_row
after insert on public.businesses
for each row execute function public.businesses_create_billing_row();

/* -------------------------------------------------------------------------- */
/* profiles: is_support                                                       */
/* -------------------------------------------------------------------------- */

alter table if exists public.profiles
  add column if not exists is_support boolean not null default false;

/* -------------------------------------------------------------------------- */
/* profiles RLS: prevent tenant admins modifying support users                 */
/* -------------------------------------------------------------------------- */

alter table if exists public.profiles enable row level security;

drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_select_manage_business on public.profiles;
drop policy if exists profiles_insert_manage_business on public.profiles;
drop policy if exists profiles_update_manage_business on public.profiles;
drop policy if exists profiles_delete_manage_business on public.profiles;

create policy profiles_select_self
on public.profiles
for select
to authenticated
using (auth.uid() = id);

create policy profiles_select_manage_business
on public.profiles
for select
to authenticated
using (public.can_manage_business(business_id));

create policy profiles_insert_manage_business
on public.profiles
for insert
to authenticated
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_admin_user()
    and role in ('admin','cashier')
    and coalesce(is_support, false) = false
  )
);

create policy profiles_update_manage_business
on public.profiles
for update
to authenticated
using (
  public.is_platform_admin()
  or (
    public.can_manage_business(business_id)
    and coalesce(is_support, false) = false
  )
)
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_admin_user()
    and role in ('admin','cashier')
    and coalesce(is_support, false) = false
  )
);

create policy profiles_delete_manage_business
on public.profiles
for delete
to authenticated
using (
  public.is_platform_admin()
  or (
    public.can_manage_business(business_id)
    and coalesce(is_support, false) = false
  )
);

/* -------------------------------------------------------------------------- */
/* impersonation_audit                                                        */
/* -------------------------------------------------------------------------- */

create table if not exists public.impersonation_audit (
  id uuid primary key default gen_random_uuid(),
  platform_admin_id uuid not null references public.profiles (id) on delete restrict,
  business_id uuid not null references public.businesses (id) on delete cascade,
  support_user_id uuid not null references public.profiles (id) on delete restrict,
  reason text not null,
  created_at timestamptz not null default now(),
  ended_at timestamptz null
);

create index if not exists impersonation_audit_business_idx
  on public.impersonation_audit (business_id, created_at desc);
create index if not exists impersonation_audit_admin_idx
  on public.impersonation_audit (platform_admin_id, created_at desc);

alter table public.impersonation_audit enable row level security;

drop policy if exists impersonation_audit_platform on public.impersonation_audit;
create policy impersonation_audit_platform
on public.impersonation_audit
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

/* -------------------------------------------------------------------------- */
/* business_devices: device_type                                              */
/* -------------------------------------------------------------------------- */

alter table if exists public.business_devices
  add column if not exists device_type text not null default 'unknown';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_devices_device_type_check') then
    alter table public.business_devices
      add constraint business_devices_device_type_check
      check (device_type in ('pc','phone','unknown'));
  end if;
end $$;

/* -------------------------------------------------------------------------- */
/* server_time RPC (callable by anon)                                         */
/* -------------------------------------------------------------------------- */

create or replace function public.server_time()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'unix_ms', (extract(epoch from now()) * 1000)::bigint,
    'iso_utc', (now() at time zone 'utc')::text
  )
$$;

revoke all on function public.server_time() from public;
grant execute on function public.server_time() to anon, authenticated;

commit;

