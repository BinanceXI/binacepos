-- Phase 4 (P4) expenses + owner drawings (offline-first) + reporting support
-- Apply in Supabase SQL editor (or via migrations).

-- Required for gen_random_uuid()
create extension if not exists pgcrypto;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  business_id uuid null,
  -- user_id is the authenticated user id (when online)
  user_id uuid null default auth.uid(),
  -- legacy name kept for compatibility
  created_by uuid null default auth.uid(),
  source text not null default 'pos',

  occurred_at timestamptz not null default now(),
  category text not null,
  notes text null,
  amount numeric not null check (amount > 0),
  payment_method text null,
  -- 'owner_draw' is the canonical value; 'owner_drawing' accepted for backward compatibility
  expense_type text not null check (expense_type in ('expense','owner_draw','owner_drawing')),

  synced_at timestamptz null
);

-- Ensure columns exist on older installs (idempotent)
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

-- Backfill user_id from created_by if needed
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

-- Postgres policy syntax doesn't allow "for insert, update, delete" in one statement,
-- so we create separate policies for each operation.
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
