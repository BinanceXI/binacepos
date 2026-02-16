-- BinanceXI POS (by Binance Labs) — multi-business + manual billing
-- This migration introduces tenant isolation (business_id) and a simple billing model:
-- paid_through (30 days subscription) + grace_days (default 7) + optional reactivation codes.

begin;

/* -------------------------------------------------------------------------- */
/* Businesses + Billing                                                       */
/* -------------------------------------------------------------------------- */

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_status_check') then
    alter table public.businesses
      add constraint businesses_status_check
      check (status in ('active','suspended'));
  end if;
end $$;

drop trigger if exists set_updated_at_businesses on public.businesses;
create trigger set_updated_at_businesses
before update on public.businesses
for each row execute function public.set_updated_at();

create table if not exists public.business_billing (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  currency text not null default 'USD',
  grace_days integer not null default 7 check (grace_days >= 0 and grace_days <= 60),
  paid_through timestamptz not null default (now() + interval '30 days'),
  locked_override boolean not null default false,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at_business_billing on public.business_billing;
create trigger set_updated_at_business_billing
before update on public.business_billing
for each row execute function public.set_updated_at();

create index if not exists business_billing_paid_through_idx on public.business_billing (paid_through);

-- Auto-create a billing row for each new business (manual billing can update it later).
create or replace function public.businesses_create_billing_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.business_billing (business_id)
  values (new.id)
  on conflict (business_id) do nothing;
  return new;
end;
$$;

drop trigger if exists businesses_create_billing_row on public.businesses;
create trigger businesses_create_billing_row
after insert on public.businesses
for each row execute function public.businesses_create_billing_row();

create table if not exists public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  amount numeric not null check (amount > 0),
  currency text not null default 'USD',
  kind text not null default 'manual',
  notes text null,
  created_by uuid null default auth.uid(),
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_payments_kind_check') then
    alter table public.billing_payments
      add constraint billing_payments_kind_check
      check (kind in ('setup','subscription','reactivation','manual'));
  end if;
end $$;

create index if not exists billing_payments_business_idx on public.billing_payments (business_id, created_at);

create table if not exists public.reactivation_codes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  code_hash text not null,
  code_prefix text null,
  months integer not null default 1 check (months >= 1 and months <= 24),
  issued_by uuid null default auth.uid(),
  issued_at timestamptz not null default now(),
  redeemed_by uuid null,
  redeemed_at timestamptz null,
  active boolean not null default true
);

create index if not exists reactivation_codes_business_idx on public.reactivation_codes (business_id, issued_at);
create index if not exists reactivation_codes_redeemed_idx on public.reactivation_codes (redeemed_at);

/* -------------------------------------------------------------------------- */
/* Profiles: add business_id + role expansion (must exist before helper fns)   */
/* -------------------------------------------------------------------------- */

alter table if exists public.profiles
  add column if not exists business_id uuid null references public.businesses (id);

-- Expand role set to include platform_admin
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles drop constraint profiles_role_check;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles
      add constraint profiles_role_check check (role in ('platform_admin','admin','cashier'));
  end if;
end $$;

create index if not exists profiles_business_id_idx on public.profiles (business_id);

/* -------------------------------------------------------------------------- */
/* Helper Functions (SECURITY DEFINER to avoid RLS recursion)                  */
/* -------------------------------------------------------------------------- */

create or replace function public.current_business_id(p_uid uuid default auth.uid())
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.business_id
  from public.profiles p
  where p.id = coalesce(p_uid, auth.uid())
    and p.active is distinct from false
  limit 1
$$;

create or replace function public.is_platform_admin(p_uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = coalesce(p_uid, auth.uid())
      and p.active is distinct from false
      and p.role = 'platform_admin'
  )
$$;

create or replace function public.is_business_admin_user(p_uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = coalesce(p_uid, auth.uid())
      and p.active is distinct from false
      and p.role = 'admin'
  )
$$;

create or replace function public.is_business_in_good_standing(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_business_id is null then false
    when exists (select 1 from public.businesses b where b.id = p_business_id and b.status = 'suspended') then false
    when exists (select 1 from public.business_billing bb where bb.business_id = p_business_id and bb.locked_override = true) then false
    else exists (
      select 1
      from public.business_billing bb
      where bb.business_id = p_business_id
        and now() <= (bb.paid_through + make_interval(days => bb.grace_days))
    )
  end
$$;

create or replace function public.can_manage_business(p_business_id uuid, p_uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_platform_admin(p_uid)
    or (
      p_business_id is not null
      and p_business_id = public.current_business_id(p_uid)
      and public.is_business_admin_user(p_uid)
    )
$$;

revoke all on function public.current_business_id(uuid) from public;
revoke all on function public.is_platform_admin(uuid) from public;
revoke all on function public.is_business_admin_user(uuid) from public;
revoke all on function public.is_business_in_good_standing(uuid) from public;
revoke all on function public.can_manage_business(uuid, uuid) from public;

grant execute on function public.current_business_id(uuid) to authenticated;
grant execute on function public.is_platform_admin(uuid) to authenticated;
grant execute on function public.is_business_admin_user(uuid) to authenticated;
grant execute on function public.is_business_in_good_standing(uuid) to authenticated;
grant execute on function public.can_manage_business(uuid, uuid) to authenticated;

/* -------------------------------------------------------------------------- */
/* Add business_id Columns (tenant tables)                                    */
/* -------------------------------------------------------------------------- */

alter table if exists public.products
  add column if not exists business_id uuid not null default public.current_business_id() references public.businesses (id);
create index if not exists products_business_id_idx on public.products (business_id);

alter table if exists public.orders
  add column if not exists business_id uuid not null default public.current_business_id() references public.businesses (id);
create index if not exists orders_business_id_idx on public.orders (business_id);

alter table if exists public.order_items
  add column if not exists business_id uuid not null default public.current_business_id() references public.businesses (id);
create index if not exists order_items_business_id_idx on public.order_items (business_id);

alter table if exists public.service_bookings
  add column if not exists business_id uuid not null default public.current_business_id() references public.businesses (id);
create index if not exists service_bookings_business_id_idx on public.service_bookings (business_id);

-- expenses already has business_id in most schemas (uuid). Some legacy builds used text.
-- If a view depends on the column (eg owner_drawings), drop/recreate around a type change.
drop view if exists public.owner_drawings;

alter table if exists public.expenses
  alter column business_id drop default;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'expenses'
      and column_name = 'business_id'
      and data_type <> 'uuid'
  ) then
    alter table public.expenses
      alter column business_id type uuid using nullif(business_id::text, '')::uuid;
  end if;
end $$;

alter table if exists public.expenses
  alter column business_id set default public.current_business_id();

create or replace view public.owner_drawings as
select *
from public.expenses
where expense_type in ('owner_draw','owner_drawing');

/* -------------------------------------------------------------------------- */
/* store_settings: move from single-row to per-business (business_id PK)       */
/* -------------------------------------------------------------------------- */

do $$
begin
  if to_regclass('public.store_settings') is not null and to_regclass('public.store_settings_v2') is null then
    create table public.store_settings_v2 (
      business_id uuid not null default public.current_business_id() references public.businesses (id) on delete cascade,
      id text not null default 'default',
      business_name text,
      tax_id text,
      phone text,
      email text,
      address text,
      currency text,
      tax_rate numeric,
      tax_included boolean,
      footer_message text,
      show_qr_code boolean,
      qr_code_data text,
      require_manager_void boolean,
      require_manager_refund boolean,
      auto_logout_minutes integer,
      low_stock_alerts boolean,
      daily_sales_summary boolean,
      sound_effects boolean,
      low_stock_threshold integer,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (business_id, id)
    );

    drop trigger if exists set_updated_at_store_settings_v2 on public.store_settings_v2;
    create trigger set_updated_at_store_settings_v2
    before update on public.store_settings_v2
    for each row execute function public.set_updated_at();
  end if;
end $$;

/* -------------------------------------------------------------------------- */
/* Seed a default business for legacy single-tenant projects                   */
/* -------------------------------------------------------------------------- */

do $$
declare
  v_default_business uuid;
  v_has_legacy boolean := false;
begin
  select id into v_default_business from public.businesses order by created_at asc limit 1;

  if v_default_business is null then
    -- Only create a default business if we are migrating an existing single-tenant DB.
    v_has_legacy := (
      exists (select 1 from public.profiles limit 1)
      or exists (select 1 from public.products limit 1)
      or exists (select 1 from public.orders limit 1)
      or exists (select 1 from public.order_items limit 1)
      or exists (select 1 from public.service_bookings limit 1)
      or exists (select 1 from public.expenses limit 1)
      or exists (select 1 from public.store_settings limit 1)
    );

    if v_has_legacy then
      insert into public.businesses (name, status) values ('Default Business', 'active') returning id into v_default_business;
      insert into public.business_billing (business_id, currency, grace_days, paid_through, locked_override)
        values (v_default_business, 'USD', 7, (now() + interval '30 days'), false);
    end if;
  end if;

  -- New empty projects should not get a synthetic default business.
  if v_default_business is null then
    return;
  end if;

  -- Attach legacy users/data to the first business (platform_admin stays null).
  if to_regclass('public.profiles') is not null then
    update public.profiles
      set business_id = v_default_business
      where business_id is null
        and coalesce(role, '') <> 'platform_admin';
  end if;

  if to_regclass('public.products') is not null then
    update public.products set business_id = v_default_business where business_id is null;
  end if;

  if to_regclass('public.orders') is not null then
    update public.orders set business_id = v_default_business where business_id is null;
  end if;

  if to_regclass('public.order_items') is not null then
    update public.order_items set business_id = v_default_business where business_id is null;
  end if;

  if to_regclass('public.service_bookings') is not null then
    update public.service_bookings set business_id = v_default_business where business_id is null;
  end if;

  if to_regclass('public.expenses') is not null then
    update public.expenses set business_id = v_default_business where business_id is null;
  end if;

  -- Migrate single-row store_settings into per-business store_settings_v2
  if to_regclass('public.store_settings') is not null and to_regclass('public.store_settings_v2') is not null then
    insert into public.store_settings_v2 (
      business_id,
      id,
      business_name,
      tax_id,
      phone,
      email,
      address,
      currency,
      tax_rate,
      tax_included,
      footer_message,
      show_qr_code,
      qr_code_data,
      require_manager_void,
      require_manager_refund,
      auto_logout_minutes,
      low_stock_alerts,
      daily_sales_summary,
      sound_effects,
      low_stock_threshold,
      created_at,
      updated_at
    )
    select
      v_default_business,
      coalesce(nullif(s.id, ''), 'default'),
      s.business_name,
      s.tax_id,
      s.phone,
      s.email,
      s.address,
      s.currency,
      s.tax_rate,
      s.tax_included,
      s.footer_message,
      s.show_qr_code,
      s.qr_code_data,
      s.require_manager_void,
      s.require_manager_refund,
      s.auto_logout_minutes,
      s.low_stock_alerts,
      s.daily_sales_summary,
      s.sound_effects,
      s.low_stock_threshold,
      s.created_at,
      s.updated_at
    from public.store_settings s
    where not exists (
      select 1
      from public.store_settings_v2 v
      where v.business_id = v_default_business
        and v.id = coalesce(nullif(s.id, ''), 'default')
    )
    limit 1;
  end if;
end $$;

-- Swap store_settings tables when v2 exists.
do $$
begin
  if to_regclass('public.store_settings_v2') is not null then
    drop table if exists public.store_settings cascade;
    alter table public.store_settings_v2 rename to store_settings;
    drop trigger if exists set_updated_at_store_settings on public.store_settings;
    create trigger set_updated_at_store_settings
    before update on public.store_settings
    for each row execute function public.set_updated_at();
  end if;
end $$;

/* -------------------------------------------------------------------------- */
/* RLS: billing tables (platform admin only; tenant read billing for self)     */
/* -------------------------------------------------------------------------- */

alter table public.businesses enable row level security;
alter table public.business_billing enable row level security;
alter table public.billing_payments enable row level security;
alter table public.reactivation_codes enable row level security;

-- businesses: platform admin sees all; tenant can read their own business row
drop policy if exists businesses_select_platform on public.businesses;
create policy businesses_select_platform
on public.businesses
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists businesses_select_self on public.businesses;
create policy businesses_select_self
on public.businesses
for select
to authenticated
using (id = public.current_business_id());

drop policy if exists businesses_write_platform on public.businesses;
create policy businesses_write_platform
on public.businesses
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

-- business_billing: tenant can read own; only platform admin can write
drop policy if exists business_billing_select_platform on public.business_billing;
create policy business_billing_select_platform
on public.business_billing
for select
to authenticated
using (public.is_platform_admin());

drop policy if exists business_billing_select_self on public.business_billing;
create policy business_billing_select_self
on public.business_billing
for select
to authenticated
using (business_id = public.current_business_id());

drop policy if exists business_billing_write_platform on public.business_billing;
create policy business_billing_write_platform
on public.business_billing
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

-- payments + reactivation codes: platform admin only
drop policy if exists billing_payments_platform on public.billing_payments;
create policy billing_payments_platform
on public.billing_payments
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

drop policy if exists reactivation_codes_platform on public.reactivation_codes;
create policy reactivation_codes_platform
on public.reactivation_codes
for all
to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

/* -------------------------------------------------------------------------- */
/* RLS: profiles/products/expenses updated for business isolation + billing    */
/* -------------------------------------------------------------------------- */

alter table if exists public.profiles enable row level security;

drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_select_admin_all on public.profiles;
drop policy if exists profiles_admin_insert on public.profiles;
drop policy if exists profiles_admin_update on public.profiles;
drop policy if exists profiles_admin_delete on public.profiles;

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
  )
);

create policy profiles_update_manage_business
on public.profiles
for update
to authenticated
using (public.is_platform_admin() or public.can_manage_business(business_id))
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_admin_user()
    and role in ('admin','cashier')
  )
);

create policy profiles_delete_manage_business
on public.profiles
for delete
to authenticated
using (public.is_platform_admin() or public.can_manage_business(business_id));

-- products: allow if business matches + in good standing; platform admin bypass
alter table if exists public.products enable row level security;

drop policy if exists products_read_authenticated on public.products;
drop policy if exists products_inventory_insert_authenticated on public.products;
drop policy if exists products_inventory_update_authenticated on public.products;
drop policy if exists products_inventory_delete_authenticated on public.products;

create policy products_read_authenticated
on public.products
for select
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
);

create policy products_inventory_insert_authenticated
on public.products
for insert
to authenticated
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.can_manage_inventory()
  )
);

create policy products_inventory_update_authenticated
on public.products
for update
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.can_manage_inventory()
  )
)
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.can_manage_inventory()
  )
);

create policy products_inventory_delete_authenticated
on public.products
for delete
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.can_manage_inventory()
  )
);

-- expenses: allow if business matches + in good standing; platform admin bypass
alter table if exists public.expenses enable row level security;

drop policy if exists expenses_read_authenticated on public.expenses;
drop policy if exists expenses_insert_authenticated on public.expenses;
drop policy if exists expenses_update_authenticated on public.expenses;
drop policy if exists expenses_delete_authenticated on public.expenses;

create policy expenses_read_authenticated
on public.expenses
for select
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
  )
);

create policy expenses_write_admin_only
on public.expenses
for all
to authenticated
using (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.is_business_admin_user()
  )
)
with check (
  public.is_platform_admin()
  or (
    business_id = public.current_business_id()
    and public.is_business_in_good_standing(business_id)
    and public.is_business_admin_user()
  )
);

commit;
