-- Phase 1 (P1) stock adjustments RPCs (decrement_stock / increment_stock)
-- Apply in Supabase SQL editor (or via migrations).
--
-- Why:
-- - POS sync calls `supabase.rpc("decrement_stock", { p_product_id, p_qty })`
-- - Voiding receipts optionally calls `supabase.rpc("increment_stock", ...)`
-- - If these RPCs are missing or not executable, sync may appear to "fail" even when orders are saved.

create or replace function public.decrement_stock(p_product_id uuid, p_qty integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Require an authenticated, active profile (but do NOT require inventory permission, since cashiers need to sell).
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
  ) then
    raise exception 'User inactive or missing profile';
  end if;

  if p_qty is null or p_qty <= 0 then
    return;
  end if;

  update public.products
    set stock_quantity = greatest(coalesce(stock_quantity, 0) - p_qty, 0)
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
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.profiles me
    where me.id = auth.uid()
      and me.active is distinct from false
  ) then
    raise exception 'User inactive or missing profile';
  end if;

  if p_qty is null or p_qty <= 0 then
    return;
  end if;

  update public.products
    set stock_quantity = greatest(coalesce(stock_quantity, 0) + p_qty, 0)
    where id = p_product_id;
end;
$$;

revoke all on function public.decrement_stock(uuid, integer) from public;
grant execute on function public.decrement_stock(uuid, integer) to authenticated;

revoke all on function public.increment_stock(uuid, integer) from public;
grant execute on function public.increment_stock(uuid, integer) to authenticated;

