-- Align product/table RLS policies with current app auth expectations.

begin;

alter table if exists public.products enable row level security;

-- Drop known legacy names first so policy behavior is deterministic.
drop policy if exists products_read on public.products;
drop policy if exists "products: select for authenticated" on public.products;
drop policy if exists products_inventory_insert on public.products;
drop policy if exists "products: insert for authenticated" on public.products;
drop policy if exists products_inventory_update on public.products;
drop policy if exists "products: update for authenticated" on public.products;
drop policy if exists products_inventory_delete on public.products;

-- Drop current policy names too (so this migration is safe to re-run).
drop policy if exists products_read_authenticated on public.products;
drop policy if exists products_inventory_insert_authenticated on public.products;
drop policy if exists products_inventory_update_authenticated on public.products;
drop policy if exists products_inventory_delete_authenticated on public.products;

create policy products_read_authenticated
on public.products
for select
to authenticated
using (true);

create policy products_inventory_insert_authenticated
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

create policy products_inventory_update_authenticated
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

create policy products_inventory_delete_authenticated
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

-- Keep secrets unreadable from browser clients.
alter table if exists public.profile_secrets enable row level security;
drop policy if exists profile_secrets_select_self on public.profile_secrets;
drop policy if exists profile_secrets_read_authenticated on public.profile_secrets;
drop policy if exists profile_secrets_insert_authenticated on public.profile_secrets;
drop policy if exists profile_secrets_update_authenticated on public.profile_secrets;
drop policy if exists profile_secrets_delete_authenticated on public.profile_secrets;

commit;
