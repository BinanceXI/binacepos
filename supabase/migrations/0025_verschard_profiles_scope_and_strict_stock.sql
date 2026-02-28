begin;

-- ---------------------------------------------------------------------------
-- Profiles hardening: platform-like roles must be business-null.
-- ---------------------------------------------------------------------------
update public.profiles
set business_id = null
where role in ('platform_admin', 'master_admin', 'super_admin')
  and business_id is not null;

alter table public.profiles
  drop constraint if exists profiles_role_business_scope_check;

alter table public.profiles
  add constraint profiles_role_business_scope_check
  check (
    (role in ('platform_admin', 'master_admin', 'super_admin') and business_id is null)
    or (role in ('admin', 'cashier') and business_id is not null)
  ) not valid;

-- ---------------------------------------------------------------------------
-- RLS hardening: non-platform admins can only manage tenant admin/cashier rows.
-- ---------------------------------------------------------------------------
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
using (
  public.is_platform_admin()
  or (
    public.is_business_admin_user()
    and business_id = public.current_business_id()
    and role in ('admin', 'cashier')
    and coalesce(is_support, false) = false
  )
);

create policy profiles_insert_manage_business
on public.profiles
for insert
to authenticated
with check (
  public.is_platform_admin()
  or (
    public.is_business_admin_user()
    and business_id = public.current_business_id()
    and role in ('admin', 'cashier')
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
    public.is_business_admin_user()
    and business_id = public.current_business_id()
    and role in ('admin', 'cashier')
    and coalesce(is_support, false) = false
  )
)
with check (
  public.is_platform_admin()
  or (
    public.is_business_admin_user()
    and business_id = public.current_business_id()
    and role in ('admin', 'cashier')
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
    public.is_business_admin_user()
    and business_id = public.current_business_id()
    and role in ('admin', 'cashier')
    and coalesce(is_support, false) = false
  )
);

-- ---------------------------------------------------------------------------
-- Strict stock decrement: fail instead of silently clamping on oversell.
-- ---------------------------------------------------------------------------
create or replace function public.decrement_stock(p_product_id uuid, p_qty integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_stock integer;
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

  v_business_id := public.current_business_id();
  if v_business_id is null then
    raise exception 'Missing business context';
  end if;

  select p.stock_quantity
    into v_stock
    from public.products p
    where p.id = p_product_id
      and p.business_id = v_business_id
    for update;

  if not found then
    raise exception 'Product not found in this tenant';
  end if;

  v_stock := coalesce(v_stock, 0);
  if v_stock < p_qty then
    raise exception 'Insufficient stock (available %, requested %)', v_stock, p_qty;
  end if;

  update public.products
    set stock_quantity = v_stock - p_qty,
        updated_at = now()
    where id = p_product_id
      and business_id = v_business_id;
end;
$$;

revoke all on function public.decrement_stock(uuid, integer) from public;
grant execute on function public.decrement_stock(uuid, integer) to authenticated;

commit;
