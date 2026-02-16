-- Fix recursive RLS checks caused by profiles policies querying profiles again.

begin;

create or replace function public.is_admin_user(p_uid uuid default auth.uid())
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
  );
$$;

create or replace function public.can_manage_inventory(p_uid uuid default auth.uid())
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
      and (
        p.role = 'admin'
        or coalesce((p.permissions ->> 'allowInventory')::boolean, false) = true
      )
  );
$$;

revoke all on function public.is_admin_user(uuid) from public;
revoke all on function public.can_manage_inventory(uuid) from public;
grant execute on function public.is_admin_user(uuid) to authenticated;
grant execute on function public.can_manage_inventory(uuid) to authenticated;

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

create policy profiles_select_admin_all
on public.profiles
for select
to authenticated
using (public.is_admin_user());

create policy profiles_admin_insert
on public.profiles
for insert
to authenticated
with check (public.is_admin_user());

create policy profiles_admin_update
on public.profiles
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

create policy profiles_admin_delete
on public.profiles
for delete
to authenticated
using (public.is_admin_user());

alter table if exists public.products enable row level security;

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
with check (public.can_manage_inventory());

create policy products_inventory_update_authenticated
on public.products
for update
to authenticated
using (public.can_manage_inventory())
with check (public.can_manage_inventory());

create policy products_inventory_delete_authenticated
on public.products
for delete
to authenticated
using (public.can_manage_inventory());

commit;
