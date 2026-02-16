-- BinanceXI watermark
-- BinanceXI POS baseline schema (reconstructed)
-- TODO: export real schema via `supabase db dump` from the target project and replace/merge as needed.
-- This migration is based on app code + `supabase/snippets/*` and may be missing RLS policies, grants,
-- storage buckets, and other production-only objects.

-- Required for gen_random_uuid()
create extension if not exists pgcrypto;

/* -------------------------------------------------------------------------- */
/* updated_at trigger helper (idempotent)                                     */
/* -------------------------------------------------------------------------- */

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

/* -------------------------------------------------------------------------- */
/* profiles + profile_secrets (offline password auth)                         */
/* -------------------------------------------------------------------------- */

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  full_name text,
  role text not null default 'cashier',
  permissions jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists username text,
  add column if not exists full_name text,
  add column if not exists role text,
  add column if not exists permissions jsonb not null default '{}'::jsonb,
  add column if not exists active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles
      add constraint profiles_role_check check (role in ('admin','cashier'));
  end if;
end $$;

drop trigger if exists set_updated_at_profiles on public.profiles;
create trigger set_updated_at_profiles
before update on public.profiles
for each row execute function public.set_updated_at();

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
-- service_role (Edge Functions) bypasses RLS and can read/write.

alter table public.profile_secrets
  add column if not exists password_salt text,
  add column if not exists password_hash text,
  add column if not exists password_iter integer,
  add column if not exists password_kdf text default 'pbkdf2_sha256',
  add column if not exists pin_salt text,
  add column if not exists pin_hash text,
  add column if not exists pin_iter integer,
  add column if not exists pin_kdf text default 'pbkdf2_sha256',
  add column if not exists updated_at timestamptz not null default now();

-- Legacy pin_code: keep it unreadable from the client, or drop it once all devices are migrated.
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

/* -------------------------------------------------------------------------- */
/* products + stock RPCs                                                      */
/* -------------------------------------------------------------------------- */

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  type text not null default 'good',

  sku text,
  barcode text,
  shortcut_code text,

  price numeric not null default 0,
  cost_price numeric not null default 0,
  stock_quantity integer not null default 0,
  low_stock_threshold integer not null default 5,

  image_url text,
  is_variable_price boolean not null default false,
  requires_note boolean not null default false,
  is_archived boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products
  add column if not exists name text,
  add column if not exists category text,
  add column if not exists type text,
  add column if not exists sku text,
  add column if not exists barcode text,
  add column if not exists shortcut_code text,
  add column if not exists price numeric not null default 0,
  add column if not exists cost_price numeric not null default 0,
  add column if not exists stock_quantity integer not null default 0,
  add column if not exists low_stock_threshold integer not null default 5,
  add column if not exists image_url text,
  add column if not exists is_variable_price boolean not null default false,
  add column if not exists requires_note boolean not null default false,
  add column if not exists is_archived boolean not null default false,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_type_check') then
    alter table public.products
      add constraint products_type_check check (type in ('good','service','physical'));
  end if;
end $$;

create index if not exists products_name_idx on public.products (name);
create index if not exists products_category_idx on public.products (category);
create index if not exists products_shortcut_code_idx on public.products (shortcut_code);
create index if not exists products_barcode_idx on public.products (barcode);
create index if not exists products_is_archived_idx on public.products (is_archived);

drop trigger if exists set_updated_at_products on public.products;
create trigger set_updated_at_products
before update on public.products
for each row execute function public.set_updated_at();

-- RPCs used by the client app to adjust stock. Make them SECURITY DEFINER so sales can decrement
-- stock even when product write access is restricted by RLS.
create or replace function public.decrement_stock(p_product_id uuid, p_qty integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_qty is null or p_qty <= 0 then
    return;
  end if;

  if not exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
  ) then
    raise exception 'Not authorized';
  end if;

  update public.products
    set stock_quantity = greatest(0, stock_quantity - p_qty),
        updated_at = now()
    where id = p_product_id;
end;
$$;

create or replace function public.increment_stock(p_product_id uuid, p_qty integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_qty is null or p_qty <= 0 then
    return;
  end if;

  if not exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
      and (
        me.role = 'admin'
        or coalesce((me.permissions ->> 'allowVoid')::boolean, false) = true
        or coalesce((me.permissions ->> 'allowRefunds')::boolean, false) = true
      )
  ) then
    raise exception 'Not authorized';
  end if;

  update public.products
    set stock_quantity = stock_quantity + p_qty,
        updated_at = now()
    where id = p_product_id;
end;
$$;

revoke all on function public.decrement_stock(uuid, integer) from public;
revoke all on function public.increment_stock(uuid, integer) from public;
grant execute on function public.decrement_stock(uuid, integer) to authenticated;
grant execute on function public.increment_stock(uuid, integer) to authenticated;

/* -------------------------------------------------------------------------- */
/* orders + order_items (receipts)                                            */
/* -------------------------------------------------------------------------- */

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),

  cashier_id uuid null references public.profiles (id),
  customer_name text null,
  customer_contact text null,

  total_amount numeric not null default 0,
  payment_method text null,
  status text not null default 'completed',

  receipt_id text null unique,
  receipt_number text null,

  subtotal_amount numeric null,
  discount_amount numeric null,
  tax_amount numeric null,

  voided_at timestamptz null,
  void_reason text null,
  voided_by uuid null,

  -- P3: services revenue separation
  sale_type text not null default 'product',
  booking_id uuid null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders
  add column if not exists cashier_id uuid,
  add column if not exists customer_name text,
  add column if not exists customer_contact text,
  add column if not exists total_amount numeric not null default 0,
  add column if not exists payment_method text,
  add column if not exists status text not null default 'completed',
  add column if not exists receipt_id text,
  add column if not exists receipt_number text,
  add column if not exists subtotal_amount numeric,
  add column if not exists discount_amount numeric,
  add column if not exists tax_amount numeric,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists voided_by uuid,
  add column if not exists sale_type text not null default 'product',
  add column if not exists booking_id uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check') then
    alter table public.orders
      add constraint orders_status_check
      check (status in ('completed','voided','refunded','held'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'orders_sale_type_check') then
    alter table public.orders
      add constraint orders_sale_type_check
      check (sale_type in ('product','service'));
  end if;
end $$;

create index if not exists orders_created_at_idx on public.orders (created_at);
create index if not exists orders_cashier_id_idx on public.orders (cashier_id);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_sale_type_idx on public.orders (sale_type);
create index if not exists orders_booking_id_idx on public.orders (booking_id);

drop trigger if exists set_updated_at_orders on public.orders;
create trigger set_updated_at_orders
before update on public.orders
for each row execute function public.set_updated_at();

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,

  product_id uuid null,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  price_at_sale numeric not null,
  cost_at_sale numeric null,
  service_note text null,

  created_at timestamptz not null default now()
);

alter table public.order_items
  add column if not exists order_id uuid,
  add column if not exists product_id uuid,
  add column if not exists product_name text,
  add column if not exists quantity integer,
  add column if not exists price_at_sale numeric,
  add column if not exists cost_at_sale numeric,
  add column if not exists service_note text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists order_items_order_id_idx on public.order_items (order_id);
create index if not exists order_items_product_id_idx on public.order_items (product_id);

/* -------------------------------------------------------------------------- */
/* store_settings (receipt header/footer/QR)                                  */
/* -------------------------------------------------------------------------- */

-- Use a constant default id so "upsert without id" stays single-row.
create table if not exists public.store_settings (
  id text primary key default 'default',
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
  updated_at timestamptz not null default now()
);

alter table public.store_settings
  add column if not exists business_name text,
  add column if not exists tax_id text,
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists address text,
  add column if not exists currency text,
  add column if not exists tax_rate numeric,
  add column if not exists tax_included boolean,
  add column if not exists footer_message text,
  add column if not exists show_qr_code boolean,
  add column if not exists qr_code_data text,
  add column if not exists require_manager_void boolean,
  add column if not exists require_manager_refund boolean,
  add column if not exists auto_logout_minutes integer,
  add column if not exists low_stock_alerts boolean,
  add column if not exists daily_sales_summary boolean,
  add column if not exists sound_effects boolean,
  add column if not exists low_stock_threshold integer,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_updated_at_store_settings on public.store_settings;
create trigger set_updated_at_store_settings
before update on public.store_settings
for each row execute function public.set_updated_at();

/* -------------------------------------------------------------------------- */
/* service_bookings (P3)                                                      */
/* -------------------------------------------------------------------------- */

create table if not exists public.service_bookings (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null,
  service_name text not null,
  customer_name text,
  booking_date_time timestamptz not null,
  deposit_amount numeric not null default 0,
  total_price numeric not null,
  status text not null default 'booked' check (status in ('booked','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- If the table already existed with a different column name, make this snippet safe to rerun.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'service_bookings'
      and column_name = 'booking_datetime'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'service_bookings'
      and column_name = 'booking_date_time'
  ) then
    alter table public.service_bookings rename column booking_datetime to booking_date_time;
  end if;
end;
$$;

drop trigger if exists set_updated_at_service_bookings on public.service_bookings;
create trigger set_updated_at_service_bookings
before update on public.service_bookings
for each row execute function public.set_updated_at();

create index if not exists service_bookings_status_datetime_idx
  on public.service_bookings (status, booking_date_time);

/* -------------------------------------------------------------------------- */
/* expenses + owner drawings (P4)                                             */
/* -------------------------------------------------------------------------- */

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  business_id uuid null,
  user_id uuid null default auth.uid(),
  created_by uuid null default auth.uid(),
  source text not null default 'pos',

  occurred_at timestamptz not null default now(),
  category text not null,
  notes text null,
  amount numeric not null check (amount > 0),
  payment_method text null,
  expense_type text not null check (expense_type in ('expense','owner_draw','owner_drawing')),

  synced_at timestamptz null
);

alter table public.expenses
  add column if not exists user_id uuid null,
  add column if not exists created_by uuid null,
  add column if not exists source text not null default 'pos',
  add column if not exists occurred_at timestamptz not null default now(),
  add column if not exists category text,
  add column if not exists notes text,
  add column if not exists amount numeric,
  add column if not exists payment_method text,
  add column if not exists expense_type text,
  add column if not exists synced_at timestamptz;

update public.expenses
  set user_id = created_by
  where user_id is null and created_by is not null;

create index if not exists expenses_occurred_at_idx on public.expenses (occurred_at);
create index if not exists expenses_expense_type_idx on public.expenses (expense_type);
create index if not exists expenses_category_idx on public.expenses (category);

alter table public.expenses enable row level security;

drop policy if exists expenses_read_authenticated on public.expenses;
create policy expenses_read_authenticated
on public.expenses
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
  )
);

drop policy if exists expenses_insert_authenticated on public.expenses;
create policy expenses_insert_authenticated
on public.expenses
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

drop policy if exists expenses_update_authenticated on public.expenses;
create policy expenses_update_authenticated
on public.expenses
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

drop policy if exists expenses_delete_authenticated on public.expenses;
create policy expenses_delete_authenticated
on public.expenses
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

-- Optional convenience view (owner drawings are represented via expenses.expense_type in the app today)
create or replace view public.owner_drawings as
select *
from public.expenses
where expense_type in ('owner_draw','owner_drawing');

/* -------------------------------------------------------------------------- */
/* RLS baseline policies (from snippets)                                      */
/* -------------------------------------------------------------------------- */

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
